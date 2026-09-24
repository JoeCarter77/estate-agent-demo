#!/usr/bin/env node
// scripts/novus-setter-lead-profile-selftest.mjs — hermetic test of what a
// SETTER account can reach after the navigation cleanup, exercised through
// the REAL handler (api/novus/personalisation.js) with a REAL setter login
// (auth-login → session cookie → resolveCaller → SETTER_OPERATIONS). No admin
// credential is used for any setter assertion.
//
//   · every setter destination loads: Calling, My Actions, Leads (whole-
//     database search), a lead profile OUTSIDE his queue, Meetings, My
//     Performance
//   · calling-lead-profile returns the complete calling profile for any
//     agency, narrowed: no discovery notes, agreed scope or diagnosis
//   · opt-out, do-not-call, live-campaign and other-owner protections are
//     surfaced, and calling-start refuses a dial outside his calling scope
//   · administrator operations still answer 403 and write nothing
//
// No network, no real credentials, no Twilio, no Instantly.
//
// Run:  npm run novus:setter-lead-profile-selftest

import assert from 'node:assert/strict';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { ACTIONS_HEADER } from '../lib/actions-store.mjs';
import { CALLS_HEADER, rowFor } from '../lib/calling-store.mjs';
import { SETTER_OPERATIONS } from '../lib/novus-users.mjs';
import { createMemoryKv, __setKvForTests } from '../lib/kv.mjs';

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

const T0 = Date.parse('2026-09-24T10:00:00.000Z');
const NOW = T0;
const RealDate = Date;
globalThis.Date = class FixedDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
};
const iso = (ms) => new Date(ms).toISOString();
const DAY = 86_400_000;
const HOST = 'novus.test';

// ── fixture ────────────────────────────────────────────────────────────────
// ag_cold  — in the cold pool (Louis's queue).
// ag_out   — NOT in his queue: a do-not-call outcome, an email opt-out, a live
//            campaign, an open callback assigned to the admin, a probe and a
//            completed discovery meeting with commercial notes.
const COMMERCIAL_NOTE = 'Agreed the founding pilot at £2,500 with the refund term';
const AG = ['agency_id', 'clean_agency_name', 'main_phone', 'outreach_contact_name', 'outreach_contact_email', 'location', 'owner_md', 'crm_name', 'current_pipeline_status', 'suppression_status', 'updated_at'];
const actionRow = (o) => rowFor(ACTIONS_HEADER, { action_owner: 'JOE', action_status: 'DUE', reason: 'x', source_stage: 'CALL', dedupe_key: `k:${o.action_id}`, created_at: iso(T0 - DAY), updated_at: iso(T0 - DAY), ...o });
const { store, repo } = makeStore({
  AGENCIES: [AG,
    ['ag_cold', 'Cold Harbour Homes', '01277 781030', 'Ann Cold', 'ann@cold.test', 'Brentwood', '', '', '', '', ''],
    ['ag_out', 'Outside Queue Estates', '01277 781099', 'Olly Outside', 'olly@outside.test', 'Chelmsford', 'Olly Outside', 'Reapit', '', '', '']],
  CONTACTS: [['contact_id', 'agency_id', 'contact_name', 'contact_role', 'email', 'phone', 'verification_status'],
    ['ct_1', 'ag_out', 'Olly Outside', 'Owner', 'olly@outside.test', '01277 781099', 'VALID']],
  ACTIONS: [ACTIONS_HEADER.slice(), ACTIONS_HEADER.map((_, i) => (i === 0 ? 'SCHEMA NOTE' : '')),
    actionRow({ action_id: 'act_admin_cb', agency_id: 'ag_out', action_type: 'CALL_PROSPECT', due_at: iso(T0 + DAY), reason: 'Admin promised a callback',
      metadata_json: JSON.stringify({ call_action: true, assigned_user_id: 'admin', callback_reason: 'Admin promised a callback' }) })],
  REPLY_EVENTS: [['reply_event_id', 'agency_id', 'classification', 'received_at', 'suppression_type', 'cleaned_reply_text', 'lead_email'],
    ['re_1', 'ag_out', 'OPT_OUT', iso(T0 - 3 * DAY), 'PERMANENT', 'Please remove us from your list', 'olly@outside.test']],
  PROBES: [['probe_id', 'agency_id', 'probe_status', 'probe_timestamp', 'property_street', 'portal'],
    ['pr_cold', 'ag_cold', 'CLOSED', iso(T0 - 10 * DAY), '1 Cold Street', 'rightmove'],
    ['pr_out', 'ag_out', 'CLOSED', iso(T0 - 9 * DAY), '12 Outside Road', 'rightmove']],
  INTELLIGENCE: [['intelligence_id', 'probe_id', 'agency_id', 'human_contact', 'response_hours', 'seller_recognition', 'grade'],
    ['in_1', 'pr_out', 'ag_out', 'YES', '26', 'none', 'C']],
  OUTBOUND: [['outbound_id', 'agency_id', 'outreach_contact_email']],
  SALES_MESSAGES: [['sales_message_id', 'agency_id', 'send_outcome']],
  CAMPAIGNS: [['campaign_id', 'name', 'status'], ['cmp_a1', 'NOVUS — Founding Pilot · A1', 'ACTIVE']],
  CAMPAIGN_MEMBERS: [['member_id', 'campaign_id', 'agency_id', 'member_status', 'emails_sent_count', 'added_at'],
    ['mem_1', 'cmp_a1', 'ag_out', 'PUSHED', '2', iso(T0 - 5 * DAY)]],
  CAMPAIGN_EVENTS: [['event_id', 'campaign_id', 'agency_id', 'event_type', 'occurred_at', 'lead_email', 'step'],
    ['ev_1', 'cmp_a1', 'ag_out', 'EMAIL_SENT', iso(T0 - 5 * DAY), 'olly@outside.test', '1']],
  DISCOVERY_SESSIONS: [['session_id', 'agency_id', 'status', 'meeting_at', 'contact_name', 'outcome', 'outcome_notes', 'completed_at', 'conclusion_json', 'agreed_scope_json', 'pitch_count', 'created_at'],
    ['ds_1', 'ag_out', 'COMPLETED', iso(T0 - 2 * DAY), 'Olly Outside', 'FOLLOW_UP', COMMERCIAL_NOTE, iso(T0 - 2 * DAY),
      JSON.stringify({ agreement: { F1: { status: 'AGREED' } } }), JSON.stringify({ rules: ['I2'] }), '1', iso(T0 - 3 * DAY)]],
});
__setRepoForTests(repo);
const kv = createMemoryKv({ now: () => NOW });
__setKvForTests(kv);
process.env.NOVUS_BASIC_AUTH_USER = 'joe';
process.env.NOVUS_BASIC_AUTH_PASS = 'admin-env-pass';
process.env.NOVUS_SESSION_SECRET = 'test-session-secret-0123456789-abcdefghij';
const { default: handler } = await import('../api/novus/personalisation.js');

const ADMIN_BASIC = 'Basic ' + Buffer.from('joe:admin-env-pass').toString('base64');
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

// Setup is the only admin step: the calling tabs, a do-not-call history row
// on ag_out, and Louis's account. Everything asserted about Louis afterwards
// runs on his own session cookie.
let res = await request('POST', 'calling-setup', { body: { confirm: 'SETUP_CALLING_TABS' }, auth: ADMIN_BASIC });
assert.equal(res.statusCode, 200);
store.CALLS.push(rowFor(CALLS_HEADER, { call_id: 'cal_dnc', agency_id: 'ag_out', attempt_number: 1, call_mode: 'MANUAL', started_at: iso(T0 - 4 * DAY), call_status: 'manual',
  outcome: 'DO_NOT_CALL', contact_name: 'Olly Outside', connected: 'TRUE', owner_reached: 'TRUE', pitched: 'FALSE', useful_note: 'Asked not to be called',
  metadata_json: JSON.stringify({ followups: 'COMPLETE' }), created_at: iso(T0 - 4 * DAY), updated_at: iso(T0 - 4 * DAY) }));
res = await request('POST', 'team-user-create', { auth: ADMIN_BASIC, body: { confirm: 'CREATE_USER', display_name: 'Louis', username: 'louis' } });
assert.equal(res.statusCode, 201, JSON.stringify(res.body));
const louisPass = res.body.one_time_password; const louisId = res.body.user.user_id;
res = await request('POST', 'auth-login', { body: { username: 'louis', password: louisPass } });
assert.equal(res.statusCode, 200);
const LOUIS = String(res.headers['Set-Cookie']).split(';')[0];
res = await request('GET', 'whoami', { cookie: LOUIS });
assert.equal(res.body.user.role, 'SETTER'); assert.equal(res.body.user.user_id, louisId);
ok('Louis signs in with his own setter account (real auth-login, real session cookie)');

// ── every setter destination, on his own session ───────────────────────────
res = await request('GET', 'calling-workspace', { cookie: LOUIS, query: { refresh: '1' } });
assert.equal(res.statusCode, 200, JSON.stringify(res.body));
assert.ok(res.body.leads.ag_cold, 'the cold pool is his queue');
assert.ok(!res.body.leads.ag_out, 'ag_out is outside his queue (do-not-call, and its callback belongs to the admin)');
assert.ok(!res.body.call_actions.some((a) => a.agency_id === 'ag_out'), 'My Actions does not include another person\'s callback');
ok('Calling and My Actions load (calling-workspace, scoped to him); the out-of-queue agency is genuinely outside his scope');

res = await request('GET', 'lead-search', { cookie: LOUIS, query: { q: 'Outside' } });
assert.equal(res.statusCode, 200);
assert.ok(res.body.results.some((r) => r.agency_id === 'ag_out'), 'search covers the whole database, not just the queue');
ok('Leads: the whole-database search finds an agency outside his queue');

const before = JSON.stringify(store);
res = await request('GET', 'calling-lead-profile', { cookie: LOUIS, query: { agency_id: 'ag_out' } });
assert.equal(res.statusCode, 200, JSON.stringify(res.body));
const L = res.body.lead;
assert.equal(JSON.stringify(store), before, 'reading a profile writes nothing');
assert.equal(L.agency_name, 'Outside Queue Estates');
assert.equal(L.identity.main_phone, '01277 781099'); assert.equal(L.identity.owner_md, 'Olly Outside'); assert.equal(L.identity.crm_name, 'Reapit');
assert.equal(L.contacts[0].contact_name, 'Olly Outside'); assert.equal(L.contacts[0].email, 'olly@outside.test');
assert.equal(L.calls.attempts, 1); assert.equal(L.calls.recent[0].outcome, 'DO_NOT_CALL');
assert.equal(L.probes[0].property_street, '12 Outside Road'); assert.equal(L.probes[0].assessment.response_hours, '26');
assert.equal(L.email.emails_sent, 1); assert.equal(L.email.replies_received, 1); assert.match(L.email.latest_reply.cleaned_reply_text, /remove us/);
assert.equal(L.work.open[0].action_id, 'act_admin_cb'); assert.equal(L.work.open[0].assigned_user_id, 'admin');
assert.equal(L.meetings.length, 1); assert.equal(L.meetings[0].outcome, 'FOLLOW_UP'); assert.ok(L.meetings[0].meeting_at);
assert.equal(L.campaigns[0].name, 'NOVUS — Founding Pilot · A1');
assert.ok(L.timeline.some((e) => e.kind === 'call') && L.timeline.some((e) => e.kind === 'probe') && L.timeline.some((e) => e.kind === 'meeting'));
ok('a lead OUTSIDE his queue opens its complete calling profile: agency, contacts, calls and outcomes, probe, email, open actions, meetings, campaigns, history');

const raw = JSON.stringify(res.body);
assert.ok(!raw.includes(COMMERCIAL_NOTE), 'discovery outcome notes are not exposed');
for (const key of ['outcome_notes', 'agreed_scope', 'findings_agreed', 'findings_corrected', 'pitch_count', 'conclusion_json', 'agreed_scope_json']) {
  assert.ok(!raw.includes(`"${key}"`), `${key} is not exposed to a setter`);
}
ok('restricted commercial administration stays out: no discovery notes, diagnosis agreement, agreed scope or pitch detail');

assert.equal(L.protections.do_not_call, true);
assert.equal(L.protections.email_opted_out, true);
assert.deepEqual(L.protections.live_campaigns, [{ name: 'NOVUS — Founding Pilot · A1', status: 'ACTIVE' }]);
ok('protections are surfaced: do-not-call, email opt-out, live campaign membership, and the open callback shows it is assigned to someone else');

res = await request('POST', 'calling-start', { cookie: LOUIS, body: { confirm: 'START_CALL', agency_id: 'ag_out', client_key: 'k_out', call_mode: 'TWILIO', phone: '01277 781099' } });
assert.equal(res.statusCode, 403, 'a dial outside his calling scope is refused');
assert.ok(!store.CALLS.some((row) => row.includes('k_out')), 'no CALLS row written');
res = await request('POST', 'calling-start', { cookie: LOUIS, body: { confirm: 'START_CALL', agency_id: 'ag_cold', client_key: 'k_cold', call_mode: 'TWILIO', phone: '01277 781030' } });
assert.equal(res.statusCode, 201, 'a dial inside his queue still works');
res = await request('POST', 'calling-start', { auth: ADMIN_BASIC, body: { confirm: 'START_CALL', agency_id: 'ag_out', client_key: 'k_admin', call_mode: 'TWILIO', phone: '01277 781099' } });
assert.equal(res.statusCode, 201, 'the admin is not restricted by the setter scope rule');
ok('viewing is not calling: calling-start refuses a setter dial outside his scope (do-not-call, another person\'s callback), still allows his own queue, and never restricts the admin');

res = await request('GET', 'operator-conversation', { cookie: LOUIS, query: { agency_id: 'ag_out' } });
assert.equal(res.statusCode, 200, JSON.stringify(res.body));
ok('the email conversation read (operator-conversation) is permitted, read-only');

res = await request('GET', 'calling-analytics', { cookie: LOUIS, query: { range: 'all', refresh: '1' } });
assert.equal(res.statusCode, 200, JSON.stringify(res.body));
assert.ok(Array.isArray(res.body.explorer.rows), 'Meetings reads booked meetings from his own call explorer');
ok('Meetings loads (his own calling-analytics explorer)');

res = await request('GET', 'call-performance', { cookie: LOUIS, query: { range: 'this_week' } });
assert.equal(res.statusCode, 200, JSON.stringify(res.body));
assert.ok(res.body.users.every((u) => u.user.user_id === louisId), 'only his own performance');
res = await request('GET', 'call-session-current', { cookie: LOUIS });
assert.equal(res.statusCode, 200);
ok('My Performance loads (call-performance + call-session-current), scoped to him only');

res = await request('GET', 'calling-lead-profile', { cookie: LOUIS, query: { agency_id: 'ag_missing' } });
assert.equal(res.statusCode, 404);
res = await request('GET', 'calling-lead-profile', { cookie: LOUIS });
assert.equal(res.statusCode, 400);
res = await request('POST', 'calling-lead-profile', { cookie: LOUIS, body: {} });
assert.notEqual(res.statusCode, 200, 'GET only');
ok('calling-lead-profile: unknown agency 404, missing id 400, GET only');

// ── administrator operations still 403 for him, and write nothing ──────────
const snapshot = JSON.stringify(store);
const ADMIN_ONLY = [
  ['GET', 'operator-dashboard'], ['GET', 'lead-timeline', { agency_id: 'ag_out' }], ['GET', 'team-users'],
  ['GET', 'discovery-meetings'], ['GET', 'discovery-session', { session_id: 'ds_1' }],
  ['GET', 'campaigns-list'], ['GET', 'campaign-detail', { campaign_id: 'cmp_a1' }],
  ['POST', 'campaign-create'], ['POST', 'campaign-push'], ['POST', 'campaign-launch'], ['POST', 'campaign-pause'], ['POST', 'campaign-delete'],
  ['POST', 'operator-manual-reply'], ['POST', 'send-demo'], ['POST', 'operator-action-complete'], ['POST', 'operator-action-create'],
  ['POST', 'team-user-create'], ['POST', 'team-user-status'], ['POST', 'team-user-reset'],
  ['POST', 'call-session-approve'], ['POST', 'call-session-correct'],
  ['POST', 'script-save'], ['POST', 'objection-save'], ['POST', 'calling-setup'], ['POST', 'calling-repair'],
  ['POST', 'discovery-start'], ['POST', 'discovery-pitch'], ['POST', 'discovery-outcome'],
];
for (const [method, op, query] of ADMIN_ONLY) {
  assert.ok(!SETTER_OPERATIONS.has(op), `${op} must not be on the setter allowlist`);
  const r = await request(method, op, { cookie: LOUIS, query: query || {}, body: { confirm: 'X' } });
  assert.equal(r.statusCode, 403, `${method} ${op} → ${r.statusCode}`);
}
assert.equal(JSON.stringify(store), snapshot, 'no refused request wrote anything');
ok(`${ADMIN_ONLY.length} administrator operations (dashboard, admin timeline, team, discovery/proposals, campaigns, email sending, action edits, timesheet approval, scripts, setup) answer 403 to him and write nothing`);

assert.ok(SETTER_OPERATIONS.has('calling-lead-profile'));
assert.ok(!SETTER_OPERATIONS.has('lead-timeline'), 'the unrestricted admin profile is not on the setter list');
ok('the only new setter permission is the read-only calling-lead-profile');

__setRepoForTests(null);
console.log(`\n✅ Setter lead-profile self-test passed (${passed} checks).\n`);
