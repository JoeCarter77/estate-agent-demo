// lib/team-handlers.mjs — account management for individual NOVUS logins
// (lib/novus-users.mjs). Mounted as ?novus_operation= branches on
// api/novus/personalisation.js (12-function ceiling).
//
//   GET  whoami            any signed-in caller — who am I, what role
//   GET  team-users        ADMIN — accounts + each caller's calling activity
//   POST team-user-create  ADMIN — new SETTER; returns a one-time password
//   POST team-user-status  ADMIN — ACTIVE / DISABLED
//   POST team-user-reset   ADMIN — new one-time password (old one stops working)
//   POST team-user-role    ADMIN — SETTER ⇄ ADMIN; audited in USERS_AUDIT, ends
//                          the account's sessions (they sign in again with the
//                          new role); never removes the last active admin
//
// A generated password appears in exactly one place: the JSON body of the
// create/reset response to the admin's browser. It is never logged, never
// stored (only its scrypt hash is), and never returned again.

import { getRepo } from './sheets.mjs';
import { rowFor, liveCallRecords, CALLS_TAB } from './calling-store.mjs';
import crypto from 'node:crypto';
import {
  ADMIN_USER_ID, ROLES, USERS_AUDIT_HEADER, USERS_AUDIT_SCHEMA_NOTE, USERS_AUDIT_TAB, USERS_HEADER, USERS_SCHEMA_NOTE, USERS_TAB,
  adminCaller, callUserId, generatePassword, hashPassword, invalidateUsersCache, newUserId, normaliseUsername, publicUser,
  userRecords, validateUsername,
} from './novus-users.mjs';
import { clearLoginFailures, revokeUserSessions } from './auth-session.mjs';

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
        ...users.map((r) => ({ ...publicUser(r.obj), managed_by: 'team', activity: activity[text(r.obj.user_id)] || null })),
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

// Active administrators after a change: the env credential (always ADMIN,
// not managed here) plus every ACTIVE ADMIN row. The Team page may never
// take this to zero.
function activeAdminsAfter(rows, userId, patch) {
  const env = text(process.env.NOVUS_BASIC_AUTH_USER) && text(process.env.NOVUS_BASIC_AUTH_PASS) ? 1 : 0;
  return env + rows.filter((r) => {
    const o = text(r.obj.user_id) === userId ? { ...r.obj, ...patch } : r.obj;
    return upper(o.role) === 'ADMIN' && upper(o.status) === 'ACTIVE';
  }).length;
}
const LAST_ADMIN_ERROR = 'This is the last active administrator; promote another account first';

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
    const repo = getRepo();
    const patch = { status, updated_at: now, disabled_at: status === 'DISABLED' ? now : '' };
    const current = (await readUsers(repo)).find((r) => text(r.obj.user_id) === userId);
    if (current && upper(current.obj.status) === 'DELETED') return res.status(409).json({ success: false, error: 'This member was deleted; create a new account instead' });
    if (status === 'DISABLED' && activeAdminsAfter(await readUsers(repo), userId, patch) < 1) return res.status(409).json({ success: false, error: LAST_ADMIN_ERROR });
    const merged = await patchUser(repo, userId, patch);
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
    // A reset also lifts a 15-minute sign-in lock, so the new password works at once.
    await clearLoginFailures(merged.username);
    return res.status(200).json({ success: true, user: publicUser(merged), one_time_password: password, sessions_revoked: revoked });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || 'Could not reset password' });
  }
}

// SETTER ⇄ ADMIN for a USERS-row account. Nothing but role/updated_at changes
// on the row; CALLS, CALL_SESSIONS, ACTIONS and meetings are keyed by user_id,
// which never changes, so history and statistics stay with the person.
//
// Sessions: the account's sessions are ended BEFORE the row changes (if the
// session store cannot be reached, nothing changes — an old ADMIN session must
// never outlive a demotion) and again after (any sign-in in between). Sign-in
// reads USERS fresh, so the next session carries the new role.
export async function handleTeamUserRole(req, res) {
  noStore(res);
  if (text(req.body?.confirm) !== 'CHANGE_USER_ROLE') return res.status(400).json({ success: false, error: 'Missing confirm=CHANGE_USER_ROLE' });
  const userId = text(req.body?.user_id);
  const role = upper(req.body?.role);
  if (!userId || userId === ADMIN_USER_ID) return res.status(400).json({ success: false, error: 'The environment administrator\'s role cannot be changed here' });
  if (!ROLES.includes(role)) return res.status(400).json({ success: false, error: 'role must be ADMIN or SETTER' });
  try {
    const repo = getRepo();
    const rows = await readUsers(repo);
    const rec = rows.find((r) => text(r.obj.user_id) === userId);
    if (!rec) return res.status(404).json({ success: false, error: 'User not found' });
    const fromRole = upper(rec.obj.role);
    if (fromRole === role) return res.status(409).json({ success: false, error: `Already ${role}` });
    const now = new Date().toISOString();
    const patch = { role, updated_at: now };
    if (activeAdminsAfter(rows, userId, patch) < 1) return res.status(409).json({ success: false, error: LAST_ADMIN_ERROR });
    let revoked;
    try { revoked = await revokeUserSessions(userId); }
    catch { return res.status(503).json({ success: false, error: 'Could not end this account\'s sessions, so the role was not changed. Try again shortly.' }); }
    const merged = await repo.updateById(USERS_TAB, 'user_id', userId, patch);
    invalidateUsersCache();
    revoked += (await revokeQuietly(userId)) || 0;
    const actor = req.novusUser || adminCaller();
    const audit = {
      audit_id: `aud_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`, at: now, action: 'ROLE_CHANGE',
      actor_user_id: actor.user_id, actor_username: actor.username, target_user_id: userId, target_username: text(merged.username),
      from_role: fromRole, to_role: role, sessions_revoked: revoked,
    };
    let audited = true;
    try {
      await repo.ensureTab(USERS_AUDIT_TAB, [...USERS_AUDIT_HEADER], ['SCHEMA NOTE', USERS_AUDIT_SCHEMA_NOTE, ...USERS_AUDIT_HEADER.slice(2).map(() => '')]);
      await repo.appendRowsBatch(USERS_AUDIT_TAB, [rowFor(USERS_AUDIT_HEADER, audit)]);
    } catch { audited = false; }
    return res.status(200).json({ success: true, user: publicUser(merged), from_role: fromRole, to_role: role, sessions_revoked: revoked, audit: audited ? audit : null });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || 'Could not change role' });
  }
}
