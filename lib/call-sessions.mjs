// lib/call-sessions.mjs — calling WORK SESSIONS (the Start / Pause / Resume /
// End timer in Calling Mode) and the Twilio timing evidence used for talk
// time. Tab schemas, pure timing rules, and the performance read model.
//
// WHAT A SESSION IS. One CALL_SESSIONS row per session, per user, written
// only with SERVER timestamps. The browser never supplies a time; it only
// asks to start/pause/resume/end and renders what the server returns, so a
// refresh, a closed tab or a second device all see the same session.
//
//   elapsed = (ended_at or now) − started_at
//   paused  = paused_seconds (completed pauses) + (now − paused_at, while paused)
//   active  = elapsed − paused
//
// "Active" means the timer was running — NOT proof of continuous calling.
// Work evidence is the CALLS rows linked to the session (metadata_json
// .session_id) and last_activity_at (a call, or real keyboard/mouse input on
// the Calling page reported by the heartbeat).
//
// ABANDONED / IDLE SESSIONS (settleSession, applied lazily on every read):
//   · ACTIVE with no activity for IDLE_PAUSE_MS (20 min) → paused
//     automatically, effective IDLE_GRACE_MS (2 min, the heartbeat
//     granularity) after the last activity — the idle stretch is NOT active.
//   · PAUSED for ABANDON_AFTER_MS (8 h) → ended automatically at the moment
//     the pause began, and flagged needs_review for the admin.
//   A page refresh or browser close never ends a session by itself.
//
// Corrections and timesheet approvals are admin-only, appended to audit_json
// (who, when, why, from → to). Recorded time and approved time are separate
// columns; nothing here calculates or sends pay.

import { londonTimeOn, londonWeekday } from './london-time.mjs';

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();
const ts = (value) => { const n = Date.parse(text(value)); return Number.isFinite(n) ? n : null; };
const json = (value, fallback) => { try { return JSON.parse(text(value)) ?? fallback; } catch { return fallback; } };

export const CALL_SESSIONS_TAB = 'CALL_SESSIONS';
export const CALL_SESSIONS_HEADER = Object.freeze([
  'session_id', 'user_id', 'user_name', 'status', 'started_at', 'ended_at', 'paused_at', 'paused_seconds',
  'last_activity_at', 'end_reason', 'needs_review', 'events_json', 'totals_json',
  'approval_status', 'approved_minutes', 'approved_by', 'approved_at', 'approval_note', 'audit_json',
  'created_at', 'updated_at',
]);
export const CALL_SESSIONS_SCHEMA_NOTE = 'One row per calling work session. All times are server timestamps. active = elapsed − paused. Calls link here through CALLS.metadata_json.session_id. approved_minutes is the admin-approved time and is separate from the recorded time; audit_json records every correction and approval.';

// Append-only Twilio timing evidence, one row per status callback that
// matters. Joined to CALLS on call_id; never edited.
export const CALL_TIMINGS_TAB = 'CALL_TIMINGS';
export const CALL_TIMINGS_HEADER = Object.freeze([
  'timing_id', 'call_id', 'parent_call_sid', 'leg_call_sid', 'source', 'status',
  'twilio_timestamp', 'received_at', 'call_duration_seconds', 'dial_call_duration_seconds',
]);
export const CALL_TIMINGS_SCHEMA_NOTE = 'Append-only Twilio status evidence per call leg. Talk time = dialled leg completed − dialled leg answered (Twilio event times), so ringing is excluded. Answered includes voicemail/switchboard pickups; Twilio does not distinguish a person here.';

export const SESSION_STATUSES = Object.freeze(['ACTIVE', 'PAUSED', 'ENDED']);
export const IDLE_PAUSE_MS = 20 * 60_000;
export const IDLE_GRACE_MS = 2 * 60_000;
export const ABANDON_AFTER_MS = 8 * 3600_000;
export const HEARTBEAT_MS = 2 * 60_000;

export function newSessionId() { return `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
export function newTimingId() { return `tim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }

export function records(table, idColumn) {
  const header = table?.header || [];
  const at = header.indexOf(idColumn);
  if (at < 0) return [];
  return (table.rows || []).flatMap((row, index) => {
    const id = text(row[at]);
    if (!id || id === 'SCHEMA NOTE') return [];
    return [{ rowNumber: index + 2, obj: Object.fromEntries(header.map((key, i) => [key, row[i] ?? ''])) }];
  });
}

export function sessionTimes(row, nowMs = Date.now()) {
  const start = ts(row.started_at);
  if (start === null) return { elapsed_seconds: 0, paused_seconds: 0, active_seconds: 0 };
  const status = upper(row.status);
  const end = status === 'ENDED' ? (ts(row.ended_at) ?? start) : nowMs;
  const pausedAt = ts(row.paused_at);
  const openPause = status === 'PAUSED' && pausedAt !== null ? Math.max(0, nowMs - pausedAt) : 0;
  const elapsed = Math.max(0, Math.round((end - start) / 1000));
  const paused = Math.min(elapsed, Math.max(0, Math.round(Number(row.paused_seconds || 0) + openPause / 1000)));
  return { elapsed_seconds: elapsed, paused_seconds: paused, active_seconds: Math.max(0, elapsed - paused) };
}

export function pushEvent(row, event) {
  const events = json(row.events_json, []);
  events.push(event);
  return JSON.stringify(events.slice(-400));
}

// Returns { patch, events } to bring an open session up to date, or null.
export function settleSession(row, nowMs = Date.now()) {
  const status = upper(row.status);
  if (status === 'ENDED') return null;
  const lastActivity = ts(row.last_activity_at) ?? ts(row.started_at) ?? nowMs;
  const patch = {};
  let working = { ...row };
  const events = [];
  if (status === 'ACTIVE' && nowMs - lastActivity > IDLE_PAUSE_MS) {
    const pausedAt = new Date(Math.min(nowMs, lastActivity + IDLE_GRACE_MS)).toISOString();
    Object.assign(patch, { status: 'PAUSED', paused_at: pausedAt });
    events.push({ type: 'AUTO_PAUSE_IDLE', at: pausedAt, note: `No calls or activity for ${Math.round(IDLE_PAUSE_MS / 60000)} minutes` });
    working = { ...working, ...patch };
  }
  if (upper(working.status) === 'PAUSED') {
    const pausedAt = ts(working.paused_at) ?? lastActivity;
    if (nowMs - pausedAt > ABANDON_AFTER_MS) {
      // Ended where work stopped: the long pause is not part of the session.
      Object.assign(patch, { status: 'ENDED', ended_at: new Date(pausedAt).toISOString(), paused_at: '', end_reason: 'AUTO_ABANDONED', needs_review: 'TRUE' });
      events.push({ type: 'AUTO_END_ABANDONED', at: new Date(nowMs).toISOString(), note: `Paused for over ${ABANDON_AFTER_MS / 3600_000} hours; ended at the start of that pause` });
    }
  }
  if (!Object.keys(patch).length) return null;
  let eventsJson = row.events_json;
  for (const e of events) eventsJson = pushEvent({ events_json: eventsJson }, e);
  return { patch: { ...patch, events_json: eventsJson, updated_at: new Date(nowMs).toISOString() }, events };
}

// ── Twilio talk time ───────────────────────────────────────────────────────
// Per call_id, from CALL_TIMINGS only (never the browser clock):
//   talk_seconds  = dialled-leg COMPLETED − dialled-leg ANSWERED
//   dial_seconds  = dialled-leg COMPLETED − dialled-leg INITIATED (incl. ringing)
// Either is null when the evidence for it is missing.
export function talkTimeByCall(timingsTable) {
  const byCall = new Map();
  for (const { obj } of records(timingsTable, 'timing_id')) {
    const id = text(obj.call_id);
    if (!id) continue;
    const at = ts(obj.twilio_timestamp) ?? ts(obj.received_at);
    const entry = byCall.get(id) || { initiated: null, answered: null, completed: null, twilio_leg_duration: null };
    const status = text(obj.status).toLowerCase();
    if (upper(obj.source) === 'CHILD_STATUS' && at !== null) {
      if (status === 'initiated' && (entry.initiated === null || at < entry.initiated)) entry.initiated = at;
      if ((status === 'answered' || status === 'in-progress') && (entry.answered === null || at < entry.answered)) entry.answered = at;
      if (['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(status) && (entry.completed === null || at > entry.completed)) entry.completed = at;
      if (status === 'completed' && Number.isFinite(Number(obj.call_duration_seconds)) && text(obj.call_duration_seconds) !== '') entry.twilio_leg_duration = Number(obj.call_duration_seconds);
    }
    byCall.set(id, entry);
  }
  const out = new Map();
  for (const [id, e] of byCall) {
    const talk = e.answered !== null && e.completed !== null && e.completed >= e.answered ? Math.round((e.completed - e.answered) / 1000) : null;
    const dial = e.initiated !== null && e.completed !== null && e.completed >= e.initiated ? Math.round((e.completed - e.initiated) / 1000) : null;
    out.set(id, { talk_seconds: talk, dial_seconds: dial, answered_at: e.answered === null ? '' : new Date(e.answered).toISOString(), twilio_leg_duration: e.twilio_leg_duration });
  }
  return out;
}

// ── ranges (London calendar) ───────────────────────────────────────────────
export const PERFORMANCE_RANGES = Object.freeze(['today', 'this_week', 'last_week', 'custom']);
function londonMidnightOfDate(yyyyMmDd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(yyyyMmDd));
  if (!m) return null;
  return londonTimeOn(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12), { hour: 0 });
}
export function performanceRange({ range = 'this_week', from = '', to = '' } = {}, nowMs = Date.now()) {
  const key = PERFORMANCE_RANGES.includes(text(range)) ? text(range) : 'this_week';
  const sinceMonday = (londonWeekday(nowMs) + 6) % 7;
  const weekStart = londonTimeOn(nowMs, { hour: 0, addDays: -sinceMonday });
  let fromMs; let toMs;
  if (key === 'today') { fromMs = londonTimeOn(nowMs, { hour: 0 }); toMs = londonTimeOn(nowMs, { hour: 0, addDays: 1 }); }
  else if (key === 'this_week') { fromMs = weekStart; toMs = londonTimeOn(weekStart, { hour: 0, addDays: 7 }); }
  else if (key === 'last_week') { fromMs = londonTimeOn(weekStart, { hour: 0, addDays: -7 }); toMs = weekStart; }
  else {
    fromMs = londonMidnightOfDate(from);
    const t = londonMidnightOfDate(to);
    toMs = t === null ? null : londonTimeOn(t, { hour: 0, addDays: 1 });
    if (fromMs === null || toMs === null || toMs <= fromMs) return { key, error: 'custom range needs from and to as YYYY-MM-DD, from before to' };
  }
  return { key, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), from_ms: fromMs, to_ms: toMs };
}

// ── per-call facts ─────────────────────────────────────────────────────────
const CALLBACK_TYPES = new Set(['CALL_PROSPECT', 'RETRY_CALL', 'CALL']);

export function callFacts(row, { talk = null, actionsById = new Map(), attendedCallIds = new Set() } = {}) {
  const meta = json(row.metadata_json, {});
  const inbound = upper(meta.direction) === 'INBOUND';
  const actionIds = text(row.action_ids).split(',').map(text).filter(Boolean);
  const created = actionIds.map((id) => actionsById.get(id)).filter(Boolean);
  const ownerReached = upper(row.owner_reached) === 'TRUE' || Boolean(text(row.owner_reached_at));
  const outcome = upper(row.outcome);
  return {
    call_id: text(row.call_id), agency_id: text(row.agency_id), user_id: text(meta.user_id) || 'admin', session_id: text(meta.session_id),
    started_at: text(row.started_at), outcome, call_mode: upper(row.call_mode), direction: inbound ? 'INBOUND' : 'OUTBOUND',
    twilio_call_sid: text(row.twilio_call_sid), contact_name: text(row.contact_name),
    connected: upper(row.connected) === 'TRUE',
    gatekeeper_reached: upper(row.gatekeeper_reached) === 'TRUE',
    owner_reached: ownerReached,
    owner_conversation: ownerReached && upper(row.pitched) === 'TRUE',
    meeting_booked: outcome === 'BOOKED_MEETING', meeting_at: text(row.meeting_at),
    meeting_attended: outcome === 'BOOKED_MEETING' && attendedCallIds.has(text(row.call_id)),
    callbacks_created: created.filter((a) => CALLBACK_TYPES.has(upper(a.action_type))).length,
    followups_created: created.filter((a) => !CALLBACK_TYPES.has(upper(a.action_type))).length,
    callback_at: text(row.callback_at),
    // Measured only from Twilio evidence. null = not measurable (manual call,
    // no answered/completed events, or a call placed outside NOVUS).
    talk_seconds: talk?.talk_seconds ?? null,
    dial_seconds: talk?.dial_seconds ?? null,
    recording: Boolean(text(row.recording_sid) || text(row.recording_url)),
    note: text(row.useful_note || row.callback_note || row.meeting_note || row.more_info_note),
  };
}

// A booked meeting counts as ATTENDED only when the Meetings workspace has a
// COMPLETED discovery session for it: linked by source_call_id, or for the
// same agency and created after the booking call.
export function attendedMeetingCallIds(callRows, discoveryTable) {
  const done = records(discoveryTable, 'session_id').map((r) => r.obj).filter((d) => upper(d.status) === 'COMPLETED');
  const out = new Set();
  for (const row of callRows) {
    if (upper(row.outcome) !== 'BOOKED_MEETING') continue;
    const started = ts(row.started_at) ?? 0;
    if (done.some((d) => text(d.source_call_id) === text(row.call_id)
      || (text(d.agency_id) === text(row.agency_id) && !text(d.source_call_id) && (ts(d.created_at) ?? 0) >= started))) out.add(text(row.call_id));
  }
  return out;
}

export const MIN_ACTIVE_FOR_RATES_SECONDS = 15 * 60;
const ratio = (n, d, digits = 2) => (d > 0 ? Number((n / d).toFixed(digits)) : null);

// Aggregates for one set of calls + sessions. Every figure is a count or sum
// over stored rows; rates are null when the denominator is zero.
export function summarise(calls, sessions, nowMs = Date.now()) {
  const outbound = calls.filter((c) => c.direction === 'OUTBOUND');
  const times = sessions.map((s) => sessionTimes(s, nowMs));
  const activeSeconds = times.reduce((n, t) => n + t.active_seconds, 0);
  const pausedSeconds = times.reduce((n, t) => n + t.paused_seconds, 0);
  // Per-hour rates need enough time to mean something: below 15 active
  // minutes they are withheld (null) rather than extrapolated.
  const activeHours = activeSeconds >= MIN_ACTIVE_FOR_RATES_SECONDS ? activeSeconds / 3600 : 0;
  const sessionIds = new Set(sessions.map((s) => text(s.session_id)));
  const inSession = calls.filter((c) => c.session_id && sessionIds.has(c.session_id));
  const connected = outbound.filter((c) => c.connected);
  const measured = calls.filter((c) => c.talk_seconds !== null);
  const connectedTwilio = calls.filter((c) => c.connected && c.call_mode === 'TWILIO');
  const talk = measured.reduce((n, c) => n + c.talk_seconds, 0);
  const inSessionTalk = inSession.filter((c) => c.talk_seconds !== null).reduce((n, c) => n + c.talk_seconds, 0);
  const owners = calls.filter((c) => c.owner_conversation).length;
  const meetings = calls.filter((c) => c.meeting_booked).length;
  const measuredConnected = measured.filter((c) => c.connected);
  return {
    sessions: sessions.length,
    sessions_needing_review: sessions.filter((s) => upper(s.needs_review) === 'TRUE').length,
    active_seconds: activeSeconds, paused_seconds: pausedSeconds,
    approved_minutes: sessions.filter((s) => upper(s.approval_status) === 'APPROVED').reduce((n, s) => n + (Number(s.approved_minutes) || 0), 0),
    sessions_approved: sessions.filter((s) => upper(s.approval_status) === 'APPROVED').length,
    dials: outbound.length,
    dials_in_session: inSession.filter((c) => c.direction === 'OUTBOUND').length,
    dials_outside_session: outbound.filter((c) => !c.session_id || !sessionIds.has(c.session_id)).length,
    inbound_calls: calls.length - outbound.length,
    dials_per_active_hour: ratio(inSession.filter((c) => c.direction === 'OUTBOUND').length, activeHours, 1),
    connected: connected.length,
    connection_rate: ratio(connected.length, outbound.length, 3),
    talk_seconds: talk,
    talk_measured_calls: measured.length,
    talk_unmeasured_connected: calls.filter((c) => c.connected && c.talk_seconds === null).length,
    connected_twilio_calls: connectedTwilio.length,
    talk_seconds_per_active_hour: activeHours > 0 ? Math.round(inSessionTalk / activeHours) : null,
    average_connected_talk_seconds: measuredConnected.length ? Math.round(measuredConnected.reduce((n, c) => n + c.talk_seconds, 0) / measuredConnected.length) : null,
    gatekeepers_reached: calls.filter((c) => c.gatekeeper_reached).length,
    owners_reached: calls.filter((c) => c.owner_reached).length,
    owner_conversations: owners,
    meetings_booked: meetings,
    meetings_attended: calls.filter((c) => c.meeting_attended).length,
    meetings_per_active_hour: ratio(inSession.filter((c) => c.meeting_booked).length, activeHours, 2),
    meetings_per_owner_conversation: ratio(meetings, owners, 2),
    callbacks_created: calls.reduce((n, c) => n + c.callbacks_created, 0),
    followups_created: calls.reduce((n, c) => n + c.followups_created, 0),
    outcomes: calls.reduce((m, c) => { m[c.outcome] = (m[c.outcome] || 0) + 1; return m; }, {}),
  };
}

export const METRIC_DEFINITIONS = Object.freeze({
  sessions: 'Calling sessions started in the range.',
  active_time: 'Session time with the timer running (elapsed − paused). A running timer is not proof of continuous calling; see dials and talk time.',
  paused_time: 'Session time paused by the setter or automatically after 20 minutes without activity.',
  dials: 'Outbound calls with a saved outcome (technical discards excluded). Inbound callbacks are counted separately.',
  dials_per_active_hour: 'Outbound calls made inside a session ÷ active session hours. All per-hour rates are shown only once there are at least 15 minutes of active time.',
  connected: 'Calls where someone answered (outcome is not no-answer / wrong number).',
  connection_rate: 'Connected ÷ dials.',
  talk_time: 'Measured only from Twilio: dialled leg answered → completed, so ringing is excluded. Includes voicemail and switchboard pickups (Twilio does not distinguish them). Manual calls and calls without Twilio events are not measured and are counted as unmeasured, never estimated.',
  talk_per_active_hour: 'Measured talk time on in-session calls ÷ active session hours.',
  gatekeepers_reached: 'Calls marked on the answer screen as reaching a gatekeeper.',
  owners_reached: 'Calls where the owner / decision-maker came on the line (answer screen or outcome).',
  owner_conversations: 'Owner reached AND the pitch was delivered.',
  meetings_booked: 'Calls saved with the Booked meeting outcome.',
  meetings_attended: 'Booked meetings with a COMPLETED session in the Meetings workspace (linked to the booking call, or the same agency after it). A booking alone never counts as attended.',
  meetings_per_active_hour: 'Meetings booked inside a session ÷ active session hours.',
  meetings_per_owner_conversation: 'Meetings booked ÷ owner conversations.',
  callbacks_created: 'Callback and retry call actions created by the calls.',
  followups_created: 'Other follow-up actions created by the calls (e.g. send information).',
  approved_time: 'Minutes the admin approved on reviewed sessions. Separate from recorded time; not a pay calculation.',
});
