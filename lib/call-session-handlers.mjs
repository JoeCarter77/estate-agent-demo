// lib/call-session-handlers.mjs — the HTTP operations behind the Calling
// Mode session timer and Team performance (lib/call-sessions.mjs). Mounted as
// ?novus_operation= branches on api/novus/personalisation.js; every handler
// assumes the router resolved req.novusUser and applied the role allowlist.
//
//   GET  call-session-current     the caller's open session (+ live totals)
//   POST call-session-start       one open session per user (idempotent)
//   POST call-session-pause | call-session-resume | call-session-end
//   POST call-session-heartbeat   page open; records real activity only
//   GET  call-performance         range summary per user (setter: self only)
//   GET  call-session-detail      one session + its call timeline (setter: own)
//   POST call-session-correct     ADMIN — edit times, with a reason (audited)
//   POST call-session-approve     ADMIN — timesheet approval (audited)

import { getRepo } from './sheets.mjs';
import { kvStore } from './kv.mjs';
import { ACTIONS_TAB, parseActionRecords } from './actions-store.mjs';
import { CALLS_TAB, liveCallRecords, rowFor } from './calling-store.mjs';
import { USERS_TAB, adminCaller, publicUser, userRecords } from './novus-users.mjs';
import {
  CALL_SESSIONS_HEADER, CALL_SESSIONS_SCHEMA_NOTE, CALL_SESSIONS_TAB, CALL_TIMINGS_TAB, HEARTBEAT_MS, IDLE_PAUSE_MS,
  METRIC_DEFINITIONS, attendedMeetingCallIds, callFacts, newSessionId, performanceRange, pushEvent, records,
  sessionTimes, settleSession, summarise, talkTimeByCall,
} from './call-sessions.mjs';

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();
const noStore = (res) => res.setHeader('Cache-Control', 'private, no-store, max-age=0');
const iso = (ms) => new Date(ms).toISOString();
const json = (value, fallback) => { try { return JSON.parse(text(value)) ?? fallback; } catch { return fallback; } };
const isAdmin = (req) => req.novusUser?.role === 'ADMIN';
const empty = { header: [], rows: [] };

async function readTab(repo, tab) { try { return await repo.getTable(tab); } catch { return empty; } }

let sessionsTabReady = false;
async function ensureSessionsTab(repo) {
  if (sessionsTabReady) return;
  await repo.ensureTab(CALL_SESSIONS_TAB, [...CALL_SESSIONS_HEADER], ['SCHEMA NOTE', CALL_SESSIONS_SCHEMA_NOTE, ...CALL_SESSIONS_HEADER.slice(2).map(() => '')]);
  sessionsTabReady = true;
}
export function _resetForTests() { sessionsTabReady = false; }

// Cell writes (not whole-row rewrites): a heartbeat, a call and a pause can
// land together, and each must only touch its own columns.
async function patchSession(repo, header, rowNumber, patch) {
  const writes = Object.entries(patch).flatMap(([key, value]) => {
    const col = header.indexOf(key) + 1;
    return col > 0 ? [{ tab: CALL_SESSIONS_TAB, rowNumber, columnNumber: col, value: value ?? '' }] : [];
  });
  if (writes.length) await repo.writeCellsBatch(writes);
}

// Reads the caller's open sessions, applies the idle/abandon rules (and
// persists them), heals an accidental duplicate, and returns the one open
// session or null.
export async function loadOpenSession(repo, userId, nowMs = Date.now()) {
  const table = await readTab(repo, CALL_SESSIONS_TAB);
  const header = table.header || [];
  if (!header.length) return { header, open: null };
  const mine = records(table, 'session_id').filter((r) => text(r.obj.user_id) === userId && upper(r.obj.status) !== 'ENDED');
  for (const rec of mine) {
    const settled = settleSession(rec.obj, nowMs);
    if (settled) { await patchSession(repo, header, rec.rowNumber, settled.patch); Object.assign(rec.obj, settled.patch); }
  }
  const open = mine.filter((r) => upper(r.obj.status) !== 'ENDED').sort((a, b) => Date.parse(b.obj.started_at) - Date.parse(a.obj.started_at));
  for (const extra of open.slice(1)) {
    const at = text(extra.obj.paused_at) || text(extra.obj.last_activity_at) || text(extra.obj.started_at);
    const patch = { status: 'ENDED', ended_at: at, paused_at: '', end_reason: 'AUTO_DUPLICATE', needs_review: 'TRUE', updated_at: iso(nowMs) };
    patch.events_json = pushEvent(extra.obj, { type: 'AUTO_END_DUPLICATE', at: iso(nowMs), note: `A newer session (${open[0].obj.session_id}) was open for the same user` });
    await patchSession(repo, header, extra.rowNumber, patch);
  }
  return { header, open: open[0] || null };
}

// Everything the per-call facts need, read once.
async function loadFactsContext(repo) {
  const [calls, actions, timings, discovery] = await Promise.all([
    readTab(repo, CALLS_TAB), readTab(repo, ACTIONS_TAB), readTab(repo, CALL_TIMINGS_TAB), readTab(repo, 'DISCOVERY_SESSIONS'),
  ]);
  const callRows = liveCallRecords(calls).filter((row) => text(row.outcome));
  const actionsById = new Map((actions.header?.length ? parseActionRecords(actions) : []).map((r) => [text(r.obj.action_id), r.obj]));
  const talk = talkTimeByCall(timings);
  const attendedCallIds = attendedMeetingCallIds(callRows, discovery);
  const facts = callRows.map((row) => callFacts(row, { talk: talk.get(text(row.call_id)), actionsById, attendedCallIds }));
  return { facts };
}

function sessionView(obj, nowMs, facts = null) {
  const calls = facts ? facts.filter((c) => c.session_id === text(obj.session_id)) : null;
  return {
    session_id: text(obj.session_id), user_id: text(obj.user_id), user_name: text(obj.user_name),
    status: upper(obj.status), started_at: text(obj.started_at), ended_at: text(obj.ended_at), paused_at: text(obj.paused_at),
    last_activity_at: text(obj.last_activity_at), end_reason: text(obj.end_reason), needs_review: upper(obj.needs_review) === 'TRUE',
    auto_paused: upper(obj.status) === 'PAUSED' && json(obj.events_json, []).slice(-1)[0]?.type === 'AUTO_PAUSE_IDLE',
    ...sessionTimes(obj, nowMs),
    approval: { status: upper(obj.approval_status) || 'PENDING', approved_minutes: text(obj.approved_minutes) === '' ? null : Number(obj.approved_minutes), approved_by: text(obj.approved_by), approved_at: text(obj.approved_at), note: text(obj.approval_note) },
    totals: calls ? summarise(calls, [obj], nowMs) : json(obj.totals_json, null),
  };
}

function ownSession(req, obj) { return text(obj?.user_id) === req.novusUser.user_id; }

// ── current / start ─────────────────────────────────────────────────────────
export async function handleCallSessionCurrent(req, res) {
  noStore(res);
  try {
    const repo = getRepo();
    const nowMs = Date.now();
    const { open } = await loadOpenSession(repo, req.novusUser.user_id, nowMs);
    const facts = open ? (await loadFactsContext(repo)).facts : null;
    return res.status(200).json({ success: true, server_now: iso(nowMs), idle_pause_minutes: IDLE_PAUSE_MS / 60000, heartbeat_ms: HEARTBEAT_MS, session: open ? sessionView(open.obj, nowMs, facts) : null });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || 'Could not read the session' });
  }
}

export async function handleCallSessionStart(req, res) {
  noStore(res);
  if (text(req.body?.confirm) !== 'START_SESSION') return res.status(400).json({ success: false, error: 'Missing confirm=START_SESSION' });
  const user = req.novusUser;
  // Cross-instance guard against a double-click / two devices starting at the
  // same instant. The Sheets re-check below is the second line; loadOpenSession
  // heals any duplicate that slips through both.
  let lock = null;
  try {
    const kv = kvStore();
    const got = await kv.command(['SET', `novus:callsession:start:${user.user_id}`, '1', 'NX', 'EX', 15]);
    if (got !== 'OK') return res.status(409).json({ success: false, error: 'A session is already being started — refresh in a moment.' });
    lock = kv;
  } catch { lock = null; }
  try {
    const repo = getRepo();
    const nowMs = Date.now();
    await ensureSessionsTab(repo);
    const { open } = await loadOpenSession(repo, user.user_id, nowMs);
    if (open) return res.status(200).json({ success: true, reused: true, server_now: iso(nowMs), session: sessionView(open.obj, nowMs, (await loadFactsContext(repo)).facts) });
    const now = iso(nowMs);
    const row = {
      session_id: newSessionId(), user_id: user.user_id, user_name: user.display_name, status: 'ACTIVE', started_at: now,
      ended_at: '', paused_at: '', paused_seconds: 0, last_activity_at: now, end_reason: '', needs_review: 'FALSE',
      events_json: JSON.stringify([{ type: 'START', at: now, by: user.user_id }]), totals_json: '',
      approval_status: '', approved_minutes: '', approved_by: '', approved_at: '', approval_note: '', audit_json: '[]',
      created_at: now, updated_at: now,
    };
    await repo.appendRowsBatch(CALL_SESSIONS_TAB, [rowFor(CALL_SESSIONS_HEADER, row)]);
    return res.status(201).json({ success: true, reused: false, server_now: now, session: sessionView(row, nowMs, []) });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || 'Could not start the session' });
  } finally {
    if (lock) await lock.command(['DEL', `novus:callsession:start:${user.user_id}`]).catch(() => {});
  }
}

// ── pause / resume / end / heartbeat ───────────────────────────────────────
async function transition(req, res, apply) {
  noStore(res);
  const sessionId = text(req.body?.session_id);
  if (!sessionId) return res.status(400).json({ success: false, error: 'session_id is required' });
  try {
    const repo = getRepo();
    const nowMs = Date.now();
    const { header, open } = await loadOpenSession(repo, req.novusUser.user_id, nowMs);
    if (!open || text(open.obj.session_id) !== sessionId) {
      return res.status(409).json({ success: false, error: 'That session is no longer open.', session: null });
    }
    const out = apply(open.obj, nowMs);
    if (out.error) return res.status(409).json({ success: false, error: out.error });
    if (out.patch) {
      out.patch.updated_at = iso(nowMs);
      await patchSession(repo, header, open.rowNumber, out.patch);
      Object.assign(open.obj, out.patch);
    }
    const facts = (await loadFactsContext(repo)).facts;
    if (out.finalise) {
      const totals = summarise(facts.filter((c) => c.session_id === sessionId), [open.obj], nowMs);
      await patchSession(repo, header, open.rowNumber, { totals_json: JSON.stringify(totals) });
      open.obj.totals_json = JSON.stringify(totals);
    }
    return res.status(200).json({ success: true, server_now: iso(nowMs), session: sessionView(open.obj, nowMs, facts) });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || 'Session update failed' });
  }
}

export function handleCallSessionPause(req, res) {
  return transition(req, res, (row, nowMs) => {
    if (upper(row.status) !== 'ACTIVE') return { error: 'The session is not running.' };
    return { patch: { status: 'PAUSED', paused_at: iso(nowMs), events_json: pushEvent(row, { type: 'PAUSE', at: iso(nowMs), by: req.novusUser.user_id }) } };
  });
}

export function handleCallSessionResume(req, res) {
  return transition(req, res, (row, nowMs) => resumePatch(row, nowMs, 'RESUME', req.novusUser.user_id));
}

function resumePatch(row, nowMs, type, by) {
  if (upper(row.status) !== 'PAUSED') return { error: 'The session is not paused.' };
  const pausedAt = Date.parse(row.paused_at) || nowMs;
  const paused = Number(row.paused_seconds || 0) + Math.max(0, Math.round((nowMs - pausedAt) / 1000));
  return { patch: { status: 'ACTIVE', paused_at: '', paused_seconds: paused, last_activity_at: iso(nowMs), events_json: pushEvent(row, { type, at: iso(nowMs), by }) } };
}

export function handleCallSessionEnd(req, res) {
  return transition(req, res, (row, nowMs) => {
    const patch = { status: 'ENDED', ended_at: iso(nowMs), end_reason: 'USER', paused_at: '' };
    if (upper(row.status) === 'PAUSED') {
      const pausedAt = Date.parse(row.paused_at) || nowMs;
      patch.paused_seconds = Number(row.paused_seconds || 0) + Math.max(0, Math.round((nowMs - pausedAt) / 1000));
    }
    patch.events_json = pushEvent(row, { type: 'END', at: iso(nowMs), by: req.novusUser.user_id });
    return { patch, finalise: true };
  });
}

// The page reports it is open every HEARTBEAT_MS, and whether the person
// actually used it (key/mouse/touch) since the last beat. Only real input
// moves last_activity_at, so a tab left open does not keep a session "active".
export function handleCallSessionHeartbeat(req, res) {
  return transition(req, res, (row, nowMs) => {
    const interacted = req.body?.interacted === true;
    if (!interacted || upper(row.status) !== 'ACTIVE') return {};
    if (nowMs - (Date.parse(row.last_activity_at) || 0) < 60_000) return {};
    return { patch: { last_activity_at: iso(nowMs) } };
  });
}

// Called by calling-start / calling-save: links a call to the caller's open
// session and counts it as activity. A call made while paused resumes the
// session (the person is evidently working). Returns the session_id or ''.
export async function sessionForCall(repo, user, nowMs = Date.now()) {
  if (!user?.user_id) return '';
  const { header, open } = await loadOpenSession(repo, user.user_id, nowMs);
  if (!open) return '';
  let patch = { last_activity_at: iso(nowMs), updated_at: iso(nowMs) };
  if (upper(open.obj.status) === 'PAUSED') patch = { ...patch, ...resumePatch(open.obj, nowMs, 'AUTO_RESUME_ON_CALL', user.user_id).patch };
  await patchSession(repo, header, open.rowNumber, patch);
  return text(open.obj.session_id);
}

// ── performance / review ───────────────────────────────────────────────────
export async function handleCallPerformance(req, res) {
  noStore(res);
  const nowMs = Date.now();
  const range = performanceRange({ range: req.query?.range, from: req.query?.from, to: req.query?.to }, nowMs);
  if (range.error) return res.status(400).json({ success: false, error: range.error });
  // A setter only ever sees his own figures, whatever he asks for.
  const onlyUser = isAdmin(req) ? text(req.query?.user_id) : req.novusUser.user_id;
  try {
    const repo = getRepo();
    const [sessionsTable, usersTable, ctx] = await Promise.all([readTab(repo, CALL_SESSIONS_TAB), readTab(repo, USERS_TAB), loadFactsContext(repo)]);
    const inRange = (value) => { const t = Date.parse(value); return Number.isFinite(t) && t >= range.from_ms && t < range.to_ms; };
    const sessions = records(sessionsTable, 'session_id').map((r) => r.obj).filter((s) => inRange(s.started_at));
    const calls = ctx.facts.filter((c) => inRange(c.started_at));
    const admin = adminCaller();
    const people = [{ user_id: admin.user_id, display_name: admin.display_name, role: 'ADMIN' }, ...userRecords(usersTable).map((r) => publicUser(r.obj))]
      .filter((u) => !onlyUser || u.user_id === onlyUser);
    const users = people.map((u) => {
      const mySessions = sessions.filter((s) => text(s.user_id) === u.user_id);
      const myCalls = calls.filter((c) => c.user_id === u.user_id);
      return {
        user: { user_id: u.user_id, display_name: u.display_name, role: u.role, status: u.status || 'ACTIVE' },
        summary: summarise(myCalls, mySessions, nowMs),
        sessions: mySessions.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at)).map((s) => sessionView(s, nowMs, ctx.facts)),
      };
    });
    return res.status(200).json({ success: true, server_now: iso(nowMs), range, users, definitions: METRIC_DEFINITIONS });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || 'Could not build performance' });
  }
}

export async function handleCallSessionDetail(req, res) {
  noStore(res);
  const sessionId = text(req.query?.session_id);
  if (!sessionId) return res.status(400).json({ success: false, error: 'session_id is required' });
  try {
    const repo = getRepo();
    const nowMs = Date.now();
    const [sessionsTable, ctx, agencies] = await Promise.all([readTab(repo, CALL_SESSIONS_TAB), loadFactsContext(repo), readTab(repo, 'AGENCIES')]);
    const rec = records(sessionsTable, 'session_id').find((r) => text(r.obj.session_id) === sessionId);
    if (!rec) return res.status(404).json({ success: false, error: 'Session not found' });
    if (!isAdmin(req) && !ownSession(req, rec.obj)) return res.status(403).json({ success: false, error: 'Not your session' });
    const names = new Map(records(agencies, 'agency_id').map((r) => [text(r.obj.agency_id), text(r.obj.clean_agency_name || r.obj.agency_name)]));
    const calls = ctx.facts.filter((c) => c.session_id === sessionId)
      .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))
      .map((c) => ({ ...c, agency_name: names.get(c.agency_id) || c.agency_id }));
    return res.status(200).json({
      success: true, server_now: iso(nowMs),
      session: sessionView(rec.obj, nowMs, ctx.facts),
      calls,
      agencies_contacted: [...new Set(calls.map((c) => c.agency_id))].length,
      events: json(rec.obj.events_json, []),
      audit: isAdmin(req) ? json(rec.obj.audit_json, []) : undefined,
      definitions: METRIC_DEFINITIONS,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || 'Could not read the session' });
  }
}

// ── ADMIN: correct / approve (audited) ─────────────────────────────────────
async function adminPatch(req, res, build) {
  noStore(res);
  const sessionId = text(req.body?.session_id);
  const reason = text(req.body?.reason).slice(0, 500);
  if (!sessionId) return res.status(400).json({ success: false, error: 'session_id is required' });
  try {
    const repo = getRepo();
    const nowMs = Date.now();
    const table = await readTab(repo, CALL_SESSIONS_TAB);
    const rec = records(table, 'session_id').find((r) => text(r.obj.session_id) === sessionId);
    if (!rec) return res.status(404).json({ success: false, error: 'Session not found' });
    const out = build(rec.obj, nowMs, reason);
    if (out.error) return res.status(400).json({ success: false, error: out.error });
    const changes = Object.fromEntries(Object.entries(out.patch).filter(([k, v]) => String(rec.obj[k] ?? '') !== String(v ?? '')).map(([k, v]) => [k, { from: rec.obj[k] ?? '', to: v }]));
    if (!Object.keys(changes).length) {
      return res.status(200).json({ success: true, unchanged: true, session: sessionView(rec.obj, nowMs, (await loadFactsContext(repo)).facts), audit: json(rec.obj.audit_json, []) });
    }
    const audit = json(rec.obj.audit_json, []);
    audit.push({ at: iso(nowMs), by: req.novusUser.user_id, by_name: req.novusUser.display_name, action: out.action, reason, changes });
    const patch = { ...out.patch, audit_json: JSON.stringify(audit), updated_at: iso(nowMs) };
    await patchSession(repo, table.header, rec.rowNumber, patch);
    Object.assign(rec.obj, patch);
    return res.status(200).json({ success: true, session: sessionView(rec.obj, nowMs, (await loadFactsContext(repo)).facts), audit });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || 'Could not update the session' });
  }
}

export function handleCallSessionCorrect(req, res) {
  if (text(req.body?.confirm) !== 'CORRECT_SESSION') { noStore(res); return res.status(400).json({ success: false, error: 'Missing confirm=CORRECT_SESSION' }); }
  return adminPatch(req, res, (row, nowMs, reason) => {
    if (reason.length < 5) return { error: 'Give a reason for the correction (it is kept in the audit trail).' };
    const patch = {};
    const started = text(req.body?.started_at) ? Date.parse(req.body.started_at) : Date.parse(row.started_at);
    let ended = text(req.body?.ended_at) ? Date.parse(req.body.ended_at) : (upper(row.status) === 'ENDED' ? Date.parse(row.ended_at) : null);
    if (req.body?.end_now === true && upper(row.status) !== 'ENDED') ended = nowMs;
    if (!Number.isFinite(started) || (ended !== null && !Number.isFinite(ended))) return { error: 'Times must be valid dates.' };
    if (ended !== null && ended <= started) return { error: 'The end must be after the start.' };
    if (started > nowMs || (ended !== null && ended > nowMs)) return { error: 'Times cannot be in the future.' };
    patch.started_at = iso(started);
    if (ended !== null) Object.assign(patch, { ended_at: iso(ended), status: 'ENDED', paused_at: '', end_reason: upper(row.status) === 'ENDED' ? text(row.end_reason) : 'ADMIN' });
    if (text(req.body?.paused_minutes) !== '') {
      const paused = Math.round(Number(req.body.paused_minutes) * 60);
      const elapsed = Math.round(((ended ?? nowMs) - started) / 1000);
      if (!Number.isFinite(paused) || paused < 0 || paused > elapsed) return { error: 'Paused time must be between 0 and the session length.' };
      patch.paused_seconds = paused;
    }
    if (req.body?.mark_reviewed === true) patch.needs_review = 'FALSE';
    return { action: 'CORRECT', patch };
  });
}

export function handleCallSessionApprove(req, res) {
  if (text(req.body?.confirm) !== 'APPROVE_SESSION') { noStore(res); return res.status(400).json({ success: false, error: 'Missing confirm=APPROVE_SESSION' }); }
  return adminPatch(req, res, (row, nowMs, reason) => {
    const status = upper(req.body?.approval_status);
    if (!['APPROVED', 'REJECTED', 'PENDING'].includes(status)) return { error: 'approval_status must be APPROVED, REJECTED or PENDING' };
    if (status !== 'PENDING' && upper(row.status) !== 'ENDED') return { error: 'End or correct the session before approving it.' };
    let minutes = '';
    if (status === 'APPROVED') {
      minutes = text(req.body?.approved_minutes) === '' ? Math.round(sessionTimes(row, nowMs).active_seconds / 60) : Math.round(Number(req.body.approved_minutes));
      if (!Number.isFinite(minutes) || minutes < 0 || minutes > 24 * 60) return { error: 'Approved minutes must be between 0 and 1440.' };
    }
    return {
      action: `APPROVAL_${status}`,
      patch: {
        approval_status: status === 'PENDING' ? '' : status, approved_minutes: minutes,
        approved_by: status === 'PENDING' ? '' : req.novusUser.user_id, approved_at: status === 'PENDING' ? '' : iso(nowMs),
        approval_note: text(req.body?.note || reason).slice(0, 500),
      },
    };
  });
}
