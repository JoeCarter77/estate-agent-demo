#!/usr/bin/env node
// scripts/novus-call-sessions-selftest.mjs — hermetic test of calling work
// sessions (lib/call-sessions.mjs, lib/call-session-handlers.mjs): one
// persistent server-side session per user, pause/resume arithmetic, idle and
// abandoned handling, calls linked to the session, Twilio-measured talk time
// (ringing excluded, never estimated), performance metrics, and the admin's
// review / correction / approval with an audit trail. No network, no Twilio.
//
// Run:  npm run novus:call-sessions-selftest

import assert from 'node:assert/strict';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { ACTIONS_HEADER } from '../lib/actions-store.mjs';
import { CALLS_HEADER, rowFor } from '../lib/calling-store.mjs';
import { metaOf } from '../lib/novus-users.mjs';
import { createMemoryKv, __setKvForTests } from '../lib/kv.mjs';
import { CALL_SESSIONS_HEADER, sessionTimes, settleSession, talkTimeByCall, performanceRange } from '../lib/call-sessions.mjs';
import { computeTwilioSignature } from '../lib/twilio-signature.mjs';

let passed = 0;
const ok = (msg) => { passed += 1; console.log(`  ✓ ${msg}`); };

function makeStore(initial) {
  const store = structuredClone(initial);
  const api = {
    async get(range) { const tab = String(range).split('!')[0]; if (!(tab in store)) throw new Error(`Unable to parse range: ${tab}`); return store[tab].map((r) => r.slice()); },
    async append(range, rows) { const tab = String(range).split('!')[0]; if (!(tab in store)) throw new Error(`no tab ${tab}`); store[tab].push(...rows.map((r) => r.slice())); },
    async update(range, rows) {
      const [tab, a1] = String(range).split('!');
      const m = a1.match(/^([A-Z]+)(\d+)/);
      const colIdx = m[1].split('').reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;
      const rowIdx = Number(m[2]) - 1;
      rows.forEach((row, i) => {
        while (store[tab].length <= rowIdx + i) store[tab].push([]);
        const target = store[tab][rowIdx + i];
        row.forEach((v, j) => { while (target.length <= colIdx + j) target.push(''); target[colIdx + j] = v; });
      });
    },
    async batchUpdate(data) { for (const { range, values } of data) await api.update(range, values); },
    async listTabs() { return Object.keys(store); },
    async addTab(tab) { store[tab] = []; },
    async deleteRows(tab, rowNumbers) { for (const n of [...new Set(rowNumbers)].sort((a, b) => b - a)) store[tab].splice(n - 1, 1); },
  };
  return { store, repo: createRepo(api) };
}

// Wednesday 16 Sep 2026, 09:00 London (08:00Z, BST).
const T0 = Date.parse('2026-09-16T08:00:00.000Z');
let NOW = T0;
const RealDate = Date;
globalThis.Date = class FixedDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
};
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000; const DAY = 86_400_000;
const at = (m) => { NOW = T0 + m * MIN; };

// ── 1. pure rules ──────────────────────────────────────────────────────────
{
  const row = { status: 'PAUSED', started_at: iso(T0), paused_at: iso(T0 + 50 * MIN), paused_seconds: 600, last_activity_at: iso(T0 + 49 * MIN) };
  const t = sessionTimes(row, T0 + 60 * MIN);
  assert.deepEqual(t, { elapsed_seconds: 3600, paused_seconds: 1200, active_seconds: 2400 });
  const idle = settleSession({ status: 'ACTIVE', started_at: iso(T0), last_activity_at: iso(T0 + 10 * MIN), paused_seconds: 0, events_json: '[]' }, T0 + 45 * MIN);
  assert.equal(idle.patch.status, 'PAUSED'); assert.equal(idle.patch.paused_at, iso(T0 + 12 * MIN), 'idle pause starts 2 min after the last activity');
  assert.equal(settleSession({ status: 'ACTIVE', started_at: iso(T0), last_activity_at: iso(T0 + 10 * MIN) }, T0 + 25 * MIN), null, 'under 20 min idle: untouched');
  const gone = settleSession({ status: 'PAUSED', started_at: iso(T0), paused_at: iso(T0 + 60 * MIN), last_activity_at: iso(T0 + 58 * MIN), events_json: '[]' }, T0 + 60 * MIN + 9 * 3600_000);
  assert.equal(gone.patch.status, 'ENDED'); assert.equal(gone.patch.ended_at, iso(T0 + 60 * MIN)); assert.equal(gone.patch.needs_review, 'TRUE');
  const tl = talkTimeByCall({ header: ['timing_id', 'call_id', 'source', 'status', 'twilio_timestamp', 'received_at', 'call_duration_seconds'], rows: [
    ['t1', 'c1', 'CHILD_STATUS', 'initiated', iso(T0), '', ''], ['t2', 'c1', 'CHILD_STATUS', 'ringing', iso(T0 + 3000), '', ''],
    ['t3', 'c1', 'CHILD_STATUS', 'answered', iso(T0 + 12_000), '', ''], ['t4', 'c1', 'CHILD_STATUS', 'completed', iso(T0 + 72_000), '', '60'],
    ['t5', 'c2', 'CHILD_STATUS', 'initiated', iso(T0), '', ''], ['t6', 'c2', 'CHILD_STATUS', 'no-answer', iso(T0 + 35_000), '', ''],
  ] });
  assert.equal(tl.get('c1').talk_seconds, 60); assert.equal(tl.get('c1').dial_seconds, 72);
  assert.equal(tl.get('c2').talk_seconds, null, 'never answered: no talk time, not zero-filled');
  const week = performanceRange({ range: 'this_week' }, T0);
  assert.equal(week.from, '2026-09-13T23:00:00.000Z', 'this week starts Monday 00:00 London');
  assert.equal(performanceRange({ range: 'last_week' }, T0).to, week.from);
  ok('timing rules: active = elapsed − paused; idle auto-pause at last activity + 2 min; 8 h pause → ended at the pause; talk = answered→completed (ringing excluded); London weeks');
}

// ── fixture ────────────────────────────────────────────────────────────────
const AG = ['agency_id', 'clean_agency_name', 'main_phone', 'outreach_contact_name', 'current_pipeline_status', 'updated_at'];
const { store, repo } = makeStore({
  AGENCIES: [AG, ['ag_1', 'Harbour Homes', '01277 781030', 'Ann Harbour', '', ''], ['ag_2', 'Kestrel Estates', '01277 781031', 'Bob Kestrel', '', ''], ['ag_3', 'Otter Lettings', '01277 781032', 'Cat Otter', '', '']],
  ACTIONS: [ACTIONS_HEADER.slice(), ACTIONS_HEADER.map((_, i) => (i === 0 ? 'SCHEMA NOTE' : ''))],
  REPLY_EVENTS: [['reply_event_id', 'agency_id', 'classification', 'received_at']],
  PROBES: [['probe_id', 'agency_id', 'probe_status', 'probe_timestamp'], ['p1', 'ag_1', 'CLOSED', iso(T0 - 9 * DAY)], ['p2', 'ag_2', 'CLOSED', iso(T0 - 9 * DAY)], ['p3', 'ag_3', 'CLOSED', iso(T0 - 9 * DAY)]],
  DISCOVERY_SESSIONS: [['session_id', 'agency_id', 'source_call_id', 'status', 'created_at']],
});
__setRepoForTests(repo);
const kv = createMemoryKv({ now: () => NOW });
__setKvForTests(kv);
Object.assign(process.env, {
  NOVUS_BASIC_AUTH_USER: 'joe', NOVUS_BASIC_AUTH_PASS: 'admin-env-pass', NOVUS_SESSION_SECRET: 'test-session-secret-0123456789-abcdefghij',
  TWILIO_AUTH_TOKEN: 'authtok', NOVUS_PUBLIC_BASE_URL: 'https://novus.test',
});
const { default: handler } = await import('../api/novus/personalisation.js');
const HOST = 'novus.test';
const response = () => ({ statusCode: 200, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; }, end() { return this; }, setHeader(k, v) { this.headers[k] = v; } });
async function request(method, operation, { body, query = {}, cookie = '', auth = '' } = {}) {
  const headers = { host: HOST, 'sec-fetch-mode': 'cors' };
  if (cookie) headers.cookie = cookie;
  if (auth) headers.authorization = auth;
  if (method !== 'GET') headers.origin = `https://${HOST}`;
  const res = response();
  await handler({ method, query: { novus_operation: operation, ...query }, headers, body }, res);
  return res;
}
const webhook = async (params) => {
  const path = '/api/novus/webhooks/voice-outbound-status';
  const r = response();
  await handler({ method: 'POST', query: { novus_operation: 'twilio-voice-status' }, headers: { host: HOST, 'x-twilio-signature': computeTwilioSignature('authtok', `https://novus.test${path}`, params) }, body: params }, r);
  return r;
};
const ADMIN_BASIC = 'Basic ' + Buffer.from('joe:admin-env-pass').toString('base64');
await request('POST', 'calling-setup', { body: { confirm: 'SETUP_CALLING_TABS' }, auth: ADMIN_BASIC });
let res = await request('POST', 'team-user-create', { auth: ADMIN_BASIC, body: { confirm: 'CREATE_USER', display_name: 'Louis', username: 'louis' } });
const louisId = res.body.user.user_id;
const signIn = async (u, p) => String((await request('POST', 'auth-login', { body: { username: u, password: p } })).headers['Set-Cookie']).split(';')[0];
const louisPass = res.body.one_time_password;
let LOUIS = await signIn('louis', louisPass);
let ADMIN = await signIn('joe', 'admin-env-pass');
const L = (method, op, body, query) => request(method, op, { cookie: LOUIS, body, query });
const A = (method, op, body, query) => request(method, op, { cookie: ADMIN, body, query });

// ── 2. start: one persistent record, no duplicates ─────────────────────────
res = await L('GET', 'call-session-current');
assert.equal(res.body.session, null);
at(0);
const [s1, s2] = await Promise.all([L('POST', 'call-session-start', { confirm: 'START_SESSION' }), L('POST', 'call-session-start', { confirm: 'START_SESSION' })]);
const started = [s1, s2].find((x) => x.statusCode === 201);
assert.ok(started, JSON.stringify([s1.body, s2.body]));
assert.ok([s1, s2].some((x) => x.statusCode === 409 || x.body.reused), 'the simultaneous second start is refused or reuses');
const sid = started.body.session.session_id;
res = await L('POST', 'call-session-start', { confirm: 'START_SESSION' });
assert.equal(res.body.reused, true); assert.equal(res.body.session.session_id, sid);
const sessionRows = () => store.CALL_SESSIONS.slice(2).filter((r) => r[0]);
assert.equal(sessionRows().length, 1);
const col = (k) => CALL_SESSIONS_HEADER.indexOf(k);
assert.equal(sessionRows()[0][col('user_id')], louisId); assert.equal(sessionRows()[0][col('started_at')], iso(T0));
ok('Start Session creates exactly one server-side CALL_SESSIONS row for Louis (double-click / two devices included), stamped with server time');

// ── 3. calls in the session; Twilio talk time ──────────────────────────────
at(2);
res = await L('POST', 'calling-start', { confirm: 'START_CALL', agency_id: 'ag_1', client_key: 'k1', call_mode: 'TWILIO', phone: '01277 781030' });
const call1 = res.body.call.call_id;
assert.equal(metaOf(res.body.call).session_id, sid);
const callsCol = (k) => CALLS_HEADER.indexOf(k);
store.CALLS.find((r) => r[0] === call1)[callsCol('twilio_call_sid')] = 'CApar1';
const tsAt = (sec) => new Date(T0 + 2 * MIN + sec * 1000).toUTCString();
await webhook({ CallSid: 'CAch1', ParentCallSid: 'CApar1', CallStatus: 'initiated', Timestamp: tsAt(0) });
await webhook({ CallSid: 'CAch1', ParentCallSid: 'CApar1', CallStatus: 'ringing', Timestamp: tsAt(2) });
await webhook({ CallSid: 'CAch1', ParentCallSid: 'CApar1', CallStatus: 'answered', Timestamp: tsAt(14) });
await webhook({ CallSid: 'CAch1', ParentCallSid: 'CApar1', CallStatus: 'completed', CallDuration: '200', Timestamp: tsAt(194) });
assert.deepEqual(store.CALL_TIMINGS.slice(2).map((r) => r[5]), ['initiated', 'answered', 'completed'], 'timing evidence recorded (ringing is not needed)');
at(6);
res = await L('POST', 'calling-save', { confirm: 'SAVE_CALL', call_id: call1, client_key: 'k1', agency_id: 'ag_1', call_mode: 'TWILIO', outcome: 'BOOKED_MEETING', meeting_at: iso(T0 + 2 * DAY), gatekeeper_reached: true, owner_reached_at: iso(T0 + 3 * MIN), owner_reach_source: 'VIA_GATEKEEPER', duration_seconds: 999 });
assert.equal(res.statusCode, 200, JSON.stringify(res.body));
assert.equal(metaOf(res.body.call).session_id, sid); assert.equal(metaOf(res.body.call).user_id, louisId);
at(8);
res = await L('POST', 'calling-save', { confirm: 'SAVE_CALL', client_key: 'k2', agency_id: 'ag_2', call_mode: 'MANUAL', outcome: 'CALLBACK_REQUESTED', callback_at: iso(T0 + DAY), owner_reached: false });
assert.equal(res.statusCode, 201, JSON.stringify(res.body));
assert.equal(metaOf(res.body.call).session_id, sid);
const callbackActions = res.body.actions_created.length;
assert.ok(callbackActions >= 1);
ok('calls made while the session runs are linked to it (user, session, agency, attempt, outcome, Twilio SID); Twilio status callbacks are kept as timing evidence');

// ── 4. pause / resume / refresh ────────────────────────────────────────────
at(10);
res = await L('POST', 'call-session-pause', { session_id: sid });
assert.equal(res.body.session.status, 'PAUSED');
at(25);
res = await L('GET', 'call-session-current');
assert.equal(res.body.session.status, 'PAUSED'); assert.equal(res.body.session.paused_seconds, 15 * 60, 'refresh mid-pause: the same session, the pause still counting');
assert.equal(res.body.session.active_seconds, 10 * 60);
res = await L('POST', 'call-session-resume', { session_id: sid });
assert.equal(res.body.session.status, 'ACTIVE');
at(40);
res = await L('POST', 'call-session-heartbeat', { session_id: sid, interacted: true });
res = await L('GET', 'call-session-current');
assert.equal(res.body.session.session_id, sid);
assert.equal(res.body.session.elapsed_seconds, 40 * 60); assert.equal(res.body.session.paused_seconds, 15 * 60); assert.equal(res.body.session.active_seconds, 25 * 60);
res = await L('POST', 'call-session-pause', { session_id: 'ses_other' });
assert.equal(res.statusCode, 409, 'only his own open session can be changed');
ok('pause and resume: 40 min elapsed with a 15 min pause = 25 min active; a refresh (a fresh GET) returns the same running session');

// ── 5. idle auto-pause; a call resumes it ──────────────────────────────────
at(70); // last activity at 40 → paused automatically at 42
res = await L('GET', 'call-session-current');
assert.equal(res.body.session.status, 'PAUSED'); assert.equal(res.body.session.auto_paused, true);
assert.equal(res.body.session.active_seconds, (25 + 2) * 60, 'the idle stretch is not counted as active');
at(75);
res = await L('POST', 'calling-save', { confirm: 'SAVE_CALL', client_key: 'k3', agency_id: 'ag_3', call_mode: 'MANUAL', outcome: 'NO_ANSWER' });
assert.equal(metaOf(res.body.call).session_id, sid);
res = await L('GET', 'call-session-current');
assert.equal(res.body.session.status, 'ACTIVE', 'a call made while paused resumes the session');
assert.equal(res.body.session.paused_seconds, 15 * 60 + 33 * 60);
ok('20 minutes without activity pauses the session automatically (effective 2 min after the last activity); a call resumes it');

// ── 6. end: accurate stored totals ─────────────────────────────────────────
at(90);
res = await L('POST', 'call-session-end', { session_id: sid });
assert.equal(res.statusCode, 200);
const s = res.body.session;
assert.equal(s.status, 'ENDED'); assert.equal(s.elapsed_seconds, 90 * 60); assert.equal(s.paused_seconds, 48 * 60); assert.equal(s.active_seconds, 42 * 60);
const totals = JSON.parse(sessionRows()[0][col('totals_json')]);
assert.equal(totals.dials, 3); assert.equal(totals.connected, 2); assert.equal(totals.meetings_booked, 1);
assert.equal(totals.talk_seconds, 180, 'answered 14s → completed 194s; ringing and the browser\'s 999s are ignored');
assert.equal(totals.talk_measured_calls, 1); assert.equal(totals.talk_unmeasured_connected, 1, 'the manual connected call is reported as unmeasured, not estimated');
assert.equal(totals.gatekeepers_reached, 1); assert.equal(totals.owners_reached, 1); assert.equal(totals.owner_conversations, 1);
assert.equal(totals.callbacks_created, callbackActions + 1, 'the requested callback plus the automatic no-answer retry');
assert.deepEqual(totals.outcomes, { BOOKED_MEETING: 1, CALLBACK_REQUESTED: 1, NO_ANSWER: 1 });
res = await L('GET', 'call-session-current');
assert.equal(res.body.session, null);
ok('End Session stores accurate totals: 3 dials, 2 connected, 180 s measured talk (ringing excluded), 1 unmeasured, gatekeeper/owner/pitched counts, meeting, callbacks');

// ── 7. abandoned session ───────────────────────────────────────────────────
at(120);
res = await L('POST', 'call-session-start', { confirm: 'START_SESSION' });
const sid2 = res.body.session.session_id;
at(125);
await L('POST', 'call-session-heartbeat', { session_id: sid2, interacted: true });
at(125 + 10 * 60); // browser closed; 10 hours later
// (his login expired meanwhile — 12 h absolute — so he signs in again)
assert.equal((await L('GET', 'call-session-current')).statusCode, 401);
LOUIS = await signIn('louis', louisPass); ADMIN = await signIn('joe', 'admin-env-pass');
res = await L('GET', 'call-session-current');
assert.equal(res.body.session, null, 'the forgotten session was closed');
const row2 = sessionRows().find((r) => r[0] === sid2);
assert.equal(row2[col('end_reason')], 'AUTO_ABANDONED'); assert.equal(row2[col('needs_review')], 'TRUE');
assert.equal(row2[col('ended_at')], iso(T0 + 127 * MIN), 'ended where work stopped, not "worked all night"');
ok('a forgotten session is auto-paused, then ended at the point work stopped and flagged for review — never counted as indefinite work');

// ── 8. performance: setter vs admin ────────────────────────────────────────
store.DISCOVERY_SESSIONS.push(['dsc_1', 'ag_1', call1, 'COMPLETED', iso(T0 + 2 * DAY)]);
res = await L('GET', 'call-performance', null, { range: 'this_week', user_id: 'admin' });
assert.equal(res.statusCode, 200);
assert.deepEqual(res.body.users.map((u) => u.user.user_id), [louisId], 'a setter only ever sees himself');
const sum = res.body.users[0].summary;
assert.equal(sum.sessions, 2); assert.equal(sum.dials, 3); assert.equal(sum.dials_in_session, 3);
assert.equal(sum.meetings_booked, 1); assert.equal(sum.meetings_attended, 1, 'attended only via a COMPLETED Meetings session');
assert.equal(sum.connection_rate, 0.667);
assert.ok(res.body.definitions.talk_time && res.body.definitions.meetings_attended);
res = await L('GET', 'call-performance', null, { range: 'last_week' });
assert.equal(res.body.users[0].summary.dials, 0);
res = await A('GET', 'call-performance', null, { range: 'custom', from: '2026-09-16', to: '2026-09-16' });
assert.ok(res.body.users.some((u) => u.user.user_id === louisId && u.summary.dials === 3));
res = await A('GET', 'call-performance', null, { range: 'custom', from: '2026-09-17', to: '2026-09-16' });
assert.equal(res.statusCode, 400);
ok('performance: Louis sees only his own figures (today / this week / last week / custom); the admin sees the team; attended ≠ booked');

// ── 9. session review, correction, approval ────────────────────────────────
res = await A('GET', 'call-session-detail', null, { session_id: sid });
assert.equal(res.statusCode, 200);
assert.deepEqual(res.body.calls.map((c) => c.agency_id), ['ag_1', 'ag_2', 'ag_3']);
assert.equal(res.body.calls[0].talk_seconds, 180); assert.equal(res.body.calls[0].dial_seconds, 194); assert.equal(res.body.calls[1].talk_seconds, null);
assert.equal(res.body.agencies_contacted, 3);
assert.ok(res.body.events.some((e) => e.type === 'AUTO_PAUSE_IDLE') && res.body.events.some((e) => e.type === 'AUTO_RESUME_ON_CALL'));
res = await L('GET', 'call-session-detail', null, { session_id: sid });
assert.equal(res.statusCode, 200); assert.equal(res.body.audit, undefined, 'Louis sees his own session but not the admin audit trail');
await A('POST', 'call-session-start', { confirm: 'START_SESSION' });
const adminSid = sessionRows().find((r) => r[col('user_id')] === 'admin')[0];
res = await L('GET', 'call-session-detail', null, { session_id: adminSid });
assert.equal(res.statusCode, 403, 'Louis cannot open someone else\'s session');
res = await A('POST', 'call-session-correct', { confirm: 'CORRECT_SESSION', session_id: sid2, ended_at: iso(T0 + 126 * MIN) });
assert.equal(res.statusCode, 400, 'a correction needs a reason');
res = await A('POST', 'call-session-correct', { confirm: 'CORRECT_SESSION', session_id: sid2, ended_at: iso(T0 + 126 * MIN), reason: 'Left at 11:06 per Louis', mark_reviewed: true });
assert.equal(res.statusCode, 200);
assert.equal(res.body.session.needs_review, false);
assert.deepEqual(res.body.audit[0].changes.ended_at, { from: iso(T0 + 127 * MIN), to: iso(T0 + 126 * MIN) });
assert.equal(res.body.audit[0].by, 'admin');
res = await A('POST', 'call-session-approve', { confirm: 'APPROVE_SESSION', session_id: sid2, approval_status: 'PENDING' });
assert.equal(res.body.unchanged, true); assert.equal(res.body.audit.length, 1, 'a no-op writes no audit entry');
res = await A('POST', 'call-session-approve', { confirm: 'APPROVE_SESSION', session_id: sid, approval_status: 'APPROVED', approved_minutes: 45, note: 'OK' });
assert.equal(res.statusCode, 200); assert.equal(res.body.session.approval.approved_minutes, 45);
assert.equal(res.body.session.active_seconds, 42 * 60, 'approval never changes recorded time');
res = await A('GET', 'call-performance', null, { range: 'this_week', user_id: louisId });
assert.equal(res.body.users[0].summary.approved_minutes, 45); assert.equal(res.body.users[0].summary.active_seconds, (42 + 6) * 60);
ok('the admin reviews a session\'s call timeline, corrects an abandoned one (reason required, audited) and approves time separately from recorded time; Louis cannot see others\' sessions or the audit trail');

__setRepoForTests(null);
__setKvForTests(null);
console.log(`\nNOVUS call sessions self-test passed (${passed} checks).`);
