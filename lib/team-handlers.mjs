// lib/team-handlers.mjs — account management for individual NOVUS logins
// (lib/novus-users.mjs). Mounted as ?novus_operation= branches on
// api/novus/personalisation.js (12-function ceiling).
//
//   GET  whoami            any signed-in caller — who am I, what role
//   GET  team-users        ADMIN — accounts + each caller's calling activity
//   POST team-user-create  ADMIN — new SETTER; returns a one-time password
//   POST team-user-status  ADMIN — ACTIVE / DISABLED
//   POST team-user-reset   ADMIN — new one-time password (old one stops working)
//
// A generated password appears in exactly one place: the JSON body of the
// create/reset response to the admin's browser. It is never logged, never
// stored (only its scrypt hash is), and never returned again.

import { getRepo } from './sheets.mjs';
import { rowFor, liveCallRecords, CALLS_TAB } from './calling-store.mjs';
import {
  ADMIN_USER_ID, USERS_HEADER, USERS_SCHEMA_NOTE, USERS_TAB, adminCaller, callUserId, generatePassword,
  hashPassword, invalidateUsersCache, newUserId, normaliseUsername, publicUser, userRecords, validateUsername,
} from './novus-users.mjs';
import { revokeUserSessions } from './auth-session.mjs';

// Signed-in sessions of a disabled or reset account are deleted at once, so
// they stop working on the next request. If the session store cannot be
// reached, the USERS re-check in lib/auth-session.mjs still refuses them
// within USERS_CACHE_TTL_MS (30s) — reported back as sessions_revoked:null.
async function revokeQuietly(userId) {
  try { return await revokeUserSessions(userId); } catch { return null; }
}

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();
const noStore = (res) => res.setHeader('Cache-Control', 'private, no-store, max-age=0');
const DAY = 86_400_000;

export function handleWhoami(req, res) {
  noStore(res);
  const u = req.novusUser;
  return res.status(200).json({ success: true, user: { user_id: u.user_id, username: u.username, display_name: u.display_name, role: u.role } });
}

// Per-caller activity from CALLS alone: the same immutable rows Calling
// analytics counts, grouped by metadata_json.user_id (unattributed = admin).
export function teamActivity(calls, nowMs = Date.now()) {
  const out = {};
  for (const row of calls) {
    if (!text(row.outcome)) continue;
    const id = callUserId(row);
    const a = out[id] || (out[id] = { calls_today: 0, calls_7d: 0, calls_total: 0, owner_reached_7d: 0, meetings_7d: 0, meetings_total: 0, last_call_at: '' });
    const at = Date.parse(text(row.started_at));
    a.calls_total += 1;
    if (upper(row.outcome) === 'BOOKED_MEETING') a.meetings_total += 1;
    if (Number.isFinite(at)) {
      if (text(row.started_at).slice(0, 10) === new Date(nowMs).toISOString().slice(0, 10)) a.calls_today += 1;
      if (nowMs - at < 7 * DAY) {
        a.calls_7d += 1;
        if (upper(row.owner_reached) === 'TRUE') a.owner_reached_7d += 1;
        if (upper(row.outcome) === 'BOOKED_MEETING') a.meetings_7d += 1;
      }
      if (!a.last_call_at || at > Date.parse(a.last_call_at)) a.last_call_at = new Date(at).toISOString();
    }
  }
  return out;
}

async function readUsers(repo) {
  try { return userRecords(await repo.getTable(USERS_TAB)); } catch { return []; }
}

export async function handleTeamUsers(req, res) {
  noStore(res);
  try {
    const repo = getRepo();
    const [users, callsTable] = await Promise.all([readUsers(repo), repo.getTable(CALLS_TAB).catch(() => ({ header: [], rows: [] }))]);
    const activity = teamActivity(liveCallRecords(callsTable));
    const admin = adminCaller();
    return res.status(200).json({
      success: true,
      users: [
        { user_id: ADMIN_USER_ID, username: admin.username, display_name: admin.display_name, role: 'ADMIN', status: 'ACTIVE', managed_by: 'env', activity: activity[ADMIN_USER_ID] || null },
        ...users.map((r) => ({ ...publicUser(r.obj), activity: activity[text(r.obj.user_id)] || null })),
      ],
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || 'Could not read team' });
  }
}

export async function handleTeamUserCreate(req, res) {
  noStore(res);
  if (text(req.body?.confirm) !== 'CREATE_USER') return res.status(400).json({ success: false, error: 'Missing confirm=CREATE_USER' });
  const username = normaliseUsername(req.body?.username);
  const displayName = text(req.body?.display_name).slice(0, 60);
  const role = upper(req.body?.role) || 'SETTER';
  const invalid = validateUsername(username);
  if (invalid) return res.status(400).json({ success: false, error: invalid });
  if (!displayName) return res.status(400).json({ success: false, error: 'display_name is required' });
  // Only restricted accounts are created here; the admin is the env credential.
  if (role !== 'SETTER') return res.status(400).json({ success: false, error: 'Only SETTER accounts can be created' });
  try {
    const repo = getRepo();
    await repo.ensureTab(USERS_TAB, [...USERS_HEADER], ['SCHEMA NOTE', USERS_SCHEMA_NOTE, ...USERS_HEADER.slice(2).map(() => '')]);
    const existing = await readUsers(repo);
    if (existing.some((r) => normaliseUsername(r.obj.username) === username)) return res.status(409).json({ success: false, error: 'That username already exists' });
    const password = generatePassword();
    const now = new Date().toISOString();
    const row = {
      user_id: newUserId(), username, display_name: displayName, role, status: 'ACTIVE',
      password_hash: hashPassword(password), password_set_at: now, created_at: now, updated_at: now, disabled_at: '', notes: '',
    };
    await repo.appendRowsBatch(USERS_TAB, [rowFor(USERS_HEADER, row)]);
    invalidateUsersCache();
    return res.status(201).json({ success: true, user: publicUser(row), one_time_password: password });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || 'Could not create user' });
  }
}

async function patchUser(repo, userId, patch) {
  const rec = (await readUsers(repo)).find((r) => text(r.obj.user_id) === userId);
  if (!rec) return null;
  return repo.updateById(USERS_TAB, 'user_id', userId, patch);
}

export async function handleTeamUserStatus(req, res) {
  noStore(res);
  if (text(req.body?.confirm) !== 'SET_USER_STATUS') return res.status(400).json({ success: false, error: 'Missing confirm=SET_USER_STATUS' });
  const userId = text(req.body?.user_id);
  const status = upper(req.body?.status);
  if (!userId || userId === ADMIN_USER_ID) return res.status(400).json({ success: false, error: 'Choose a setter account' });
  if (!['ACTIVE', 'DISABLED'].includes(status)) return res.status(400).json({ success: false, error: 'status must be ACTIVE or DISABLED' });
  try {
    const now = new Date().toISOString();
    const merged = await patchUser(getRepo(), userId, { status, updated_at: now, disabled_at: status === 'DISABLED' ? now : '' });
    if (!merged) return res.status(404).json({ success: false, error: 'User not found' });
    invalidateUsersCache();
    const revoked = status === 'DISABLED' ? await revokeQuietly(userId) : 0;
    return res.status(200).json({ success: true, user: publicUser(merged), sessions_revoked: revoked });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || 'Could not update user' });
  }
}

export async function handleTeamUserReset(req, res) {
  noStore(res);
  if (text(req.body?.confirm) !== 'RESET_USER_PASSWORD') return res.status(400).json({ success: false, error: 'Missing confirm=RESET_USER_PASSWORD' });
  const userId = text(req.body?.user_id);
  if (!userId || userId === ADMIN_USER_ID) return res.status(400).json({ success: false, error: 'Choose a setter account' });
  try {
    const password = generatePassword();
    const now = new Date().toISOString();
    const merged = await patchUser(getRepo(), userId, { password_hash: hashPassword(password), password_set_at: now, updated_at: now });
    if (!merged) return res.status(404).json({ success: false, error: 'User not found' });
    invalidateUsersCache();
    const revoked = await revokeQuietly(userId);
    return res.status(200).json({ success: true, user: publicUser(merged), one_time_password: password, sessions_revoked: revoked });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || 'Could not reset password' });
  }
}
