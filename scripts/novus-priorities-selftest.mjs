#!/usr/bin/env node
// scripts/novus-priorities-selftest.mjs — Your Priorities (lib/priorities.mjs)
// plus the write paths that feed it, hermetic: in-memory Sheets, in-memory KV,
// fixed clock, no network, synthetic agencies only.
//
//   §1 pure ranking + wording: callbacks vs retries vs cold calls, interested
//      replies, meetings (today / passed / done), exceptions (stranded
//      opportunities), one card per agency, FIRST cap, test records, unknown
//      contact never invented, someone-on-a-call signal.
//   §2 London time: BST/GMT day boundaries and the 25 Oct 2026 clock change.
//   §3 reconciler keeps a human reschedule (it used to undo every snooze).
//   §4 real router, real logins: setter can read priorities and work actions
//      but not admin operations; a callback outcome creates exactly one
//      callback assigned to the caller (retry-safe); a booked meeting hands the
//      prep task to Joe with the caller's notes; a meeting outcome with no date
//      still gets a follow-up; operator-call-outcome never completes a call
//      whose follow-up failed to write.
//
// Run:  npm run novus:priorities-selftest

import assert from 'node:assert/strict';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { CALLS_HEADER, rowFor } from '../lib/calling-store.mjs';
import { ACTIONS_HEADER } from '../lib/actions-store.mjs';
import { createMemoryKv, __setKvForTests } from '../lib/kv.mjs';
import { LEAD_OWNERSHIP_HEADER } from '../lib/lead-ownership.mjs';
import { DISCOVERY_SESSIONS_HEADER } from '../lib/discovery-store.mjs';
import { buildPriorities, londonWeekStart, _internal } from '../lib/priorities.mjs';
import { reconcileActions } from '../lib/acquisition-actions.mjs';

let passed = 0;
const ok = (msg) => { passed += 1; console.log(`  ✓ ${msg}`); };
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const T = (o) => ({ header: [...o.header], rows: o.rows.map((r) => (Array.isArray(r) ? r : o.header.map((k) => r[k] ?? ''))) });

// Monday 19 Oct 2026, 10:00 London (BST, = 09:00Z).
const NOW = Date.parse('2026-10-19T09:00:00.000Z');

// ── §1 pure ────────────────────────────────────────────────────────────────
console.log('§1 ranking and wording');
const AG_H = ['agency_id', 'clean_agency_name', 'main_phone', 'outreach_contact_name', 'outreach_contact_email', 'owner_md', 'location', 'current_pipeline_status', 'suppression_status'];
const ag = (id, name, extra = {}) => ({ agency_id: id, clean_agency_name: name, main_phone: '01277 700000', location: 'Essex', ...extra });
const act = (id, agencyId, type, due, meta = {}, extra = {}) => ({
  action_id: id, agency_id: agencyId, action_type: type, action_owner: 'JOE', action_status: 'PENDING', due_at: due === '' ? '' : iso(due),
  reason: extra.reason || 'seed', source_stage: extra.source_stage || 'CALLING', dedupe_key: `${agencyId}:${type}:${id}`, created_at: iso(NOW - 5 * DAY), updated_at: iso(NOW - 5 * DAY),
  metadata_json: JSON.stringify(meta), ...extra,
});
const call = (id, agencyId, outcome, at, extra = {}) => ({ call_id: id, agency_id: agencyId, outcome, started_at: iso(at), call_status: 'manual', connected: 'TRUE', metadata_json: JSON.stringify({ user_id: extra.user_id || 'usr_louis', followups: extra.followups || 'COMPLETE' }), ...extra, user_id: undefined, followups: undefined });
const THU = NOW - 4 * DAY; // Thursday 15 Oct

const tables = {
  AGENCIES: T({ header: AG_H, rows: [
    ag('ag_cb', 'ABC Estate Agents'), ag('ag_retry', 'Retry Homes'), ag('ag_cold', 'Cold Lettings'), ag('ag_int', 'Keen Sales'),
    ag('ag_future', 'Later & Co'), ag('ag_mtg_past', 'Missed Outcome Ltd', { current_pipeline_status: 'MEETING_BOOKED' }),
    ag('ag_mtg_today', 'Today Meeting Ltd', { current_pipeline_status: 'MEETING_BOOKED' }), ag('ag_exc_int', 'Quiet Interest'),
    ag('ag_prop', 'Proposal Pending'), ag('ag_pend', 'Pending Followups'), ag('ag_test', 'TEST - Louis'), ag('ag_two', 'Two Tasks'),
    ag('ag_noname', 'No Name Agency'), ag('ag_busy', 'Busy Line Ltd'), ag('ag_dead', 'Closed Lead', { current_pipeline_status: 'NOT_INTERESTED' }),
  ] }),
  CONTACTS: T({ header: ['contact_id', 'agency_id', 'contact_name', 'contact_role', 'email', 'phone'], rows: [
    { contact_id: 'c1', agency_id: 'ag_cb', contact_name: 'John Smith', contact_role: 'Managing Director', email: 'john@abc.test', phone: '07700 900001' },
  ] }),
  CALLS: T({ header: CALLS_HEADER, rows: [
    call('cal_cb', 'ag_cb', 'CALLBACK_REQUESTED', THU + 5.5 * 3600e3, { contact_name: 'John Smith', contact_role: 'Managing Director', owner_reached: 'TRUE', pitched: 'TRUE', callback_note: 'Heading into a meeting; call Monday', callback_at: iso(NOW + 3600e3), useful_note: 'Interested in valuation opportunities from existing enquiries' }),
    call('cal_retry', 'ag_retry', 'NO_ANSWER', NOW - 3 * DAY, { connected: 'FALSE' }),
    call('cal_pend', 'ag_pend', 'CALLBACK_REQUESTED', NOW - DAY, { followups: 'PENDING' }),
    call('cal_mtg', 'ag_mtg_today', 'BOOKED_MEETING', NOW - 7 * DAY, { meeting_at: iso(NOW + 4 * 3600e3), meeting_note: 'Wants to see the probe result', owner_reached: 'TRUE', pitched: 'TRUE' }),
    { call_id: 'cal_live', agency_id: 'ag_busy', outcome: '', started_at: iso(NOW - 5 * 60e3), call_status: 'in-progress', metadata_json: JSON.stringify({ user_id: 'admin' }) },
    call('cal_dead', 'ag_dead', 'NOT_INTERESTED', NOW - 2 * DAY, { not_interested_reason: 'TIMING' }),
  ] }),
  REPLY_EVENTS: T({ header: ['reply_event_id', 'agency_id', 'received_at', 'classification', 'cleaned_reply_text', 'body_text', 'is_auto_reply'], rows: [
    { reply_event_id: 'rpl_int', agency_id: 'ag_int', received_at: iso(NOW - 3 * DAY), classification: 'POSITIVE_INTEREST', cleaned_reply_text: 'Yes, this sounds interesting — tell me more.' },
    { reply_event_id: 'rpl_quiet', agency_id: 'ag_exc_int', received_at: iso(NOW - 2 * DAY), classification: 'POSITIVE_INTEREST', cleaned_reply_text: 'Happy to chat next week.' },
    { reply_event_id: 'rpl_orphan', agency_id: '', received_at: iso(NOW - DAY), classification: 'QUESTION', cleaned_reply_text: 'Who is this?' },
  ] }),
  DISCOVERY_SESSIONS: T({ header: DISCOVERY_SESSIONS_HEADER, rows: [
    { session_id: 'ses_prop', agency_id: 'ag_prop', status: 'COMPLETED', outcome: 'PROPOSAL_REQUESTED', meeting_at: iso(NOW - 3 * DAY), completed_at: iso(NOW - 3 * DAY) },
  ] }),
  ACTIONS: T({ header: ACTIONS_HEADER, rows: [
    act('a_cb', 'ag_cb', 'CALL_PROSPECT', NOW + 3600e3, { manual: true, call_action: true, call_id: 'cal_cb', callback_reason: 'Callback requested', callback_note: 'Heading into a meeting; call Monday', assigned_user_id: 'usr_louis' }),
    act('a_retry', 'ag_retry', 'RETRY_CALL', NOW - 2 * DAY, { manual: true, call_action: true, call_id: 'cal_retry', previous_outcome: 'NO_ANSWER', callback_reason: 'No answer retry', assigned_user_id: 'usr_louis' }),
    act('a_cold', 'ag_cold', 'CALL', NOW - 3600e3, { manual: true, priority: 'NORMAL', title: '' }, { source_stage: 'MANUAL' }),
    act('a_int', 'ag_int', 'HUMAN_REPLY', NOW - 3 * DAY, { interested: true, reply_event_id: 'rpl_int', reply_text: 'Yes, this sounds interesting — tell me more.' }, { reply_event_id: 'rpl_int', source_stage: 'REPLIED_NEEDS_HUMAN' }),
    act('a_future', 'ag_future', 'CALL_PROSPECT', NOW + 3 * DAY, { manual: true, call_action: true, callback_reason: 'Callback requested', assigned_user_id: 'usr_louis' }),
    act('a_mtg_past', 'ag_mtg_past', 'PREPARE_MEETING', NOW - 6 * DAY, { manual: true, meeting_at: iso(NOW - 5 * DAY), assigned_user_id: 'admin' }, { source_stage: 'CALLING' }),
    act('a_mtg_today', 'ag_mtg_today', 'PREPARE_MEETING', NOW - 3600e3, { manual: true, meeting_at: iso(NOW + 4 * 3600e3), assigned_user_id: 'admin', handover: { meeting_note: 'Wants to see the probe result', booked_by: 'usr_louis' } }),
    act('a_test', 'ag_test', 'CALL_PROSPECT', NOW - DAY, { manual: true, call_action: true, callback_reason: 'Callback requested' }),
    act('a_two1', 'ag_two', 'SEND_INFORMATION', NOW - 3600e3, { manual: true, more_info_type: 'PRICING' }),
    act('a_two2', 'ag_two', 'CALL_PROSPECT', NOW + 2 * DAY, { manual: true, call_action: true, callback_reason: 'Information follow-up', more_info_type: 'PRICING' }),
    act('a_noname', 'ag_noname', 'RETRY_CALL', NOW, { manual: true, call_action: true, callback_reason: 'Gatekept', previous_outcome: 'GATEKEPT' }),
    act('a_busy', 'ag_busy', 'RETRY_CALL', NOW, { manual: true, call_action: true, callback_reason: 'No answer retry' }),
    act('a_probe', 'ag_cold', 'PROBE_AGENCY', NOW, {}, { source_stage: 'READY_TO_PROBE' }),
    act('a_done', 'ag_dead', 'CALL_PROSPECT', NOW - DAY, { manual: true, call_action: true }, { action_status: 'COMPLETED', completed_at: iso(NOW - DAY) }),
  ] }),
  LEAD_OWNERSHIP: T({ header: LEAD_OWNERSHIP_HEADER, rows: [
    { event_id: 'own1', at: iso(NOW - 9 * DAY), agency_id: 'ag_int', event_type: 'CLAIM', to_user_id: 'admin' },
    { event_id: 'own2', at: iso(NOW - 9 * DAY), agency_id: 'ag_exc_int', event_type: 'CLAIM', to_user_id: 'admin' },
  ] }),
  SALES_MESSAGES: T({ header: ['sales_message_id', 'agency_id', 'send_outcome', 'sent_at', 'sent_by'], rows: [] }),
};
const roster = [{ user_id: 'admin', display_name: 'Joe Carter' }, { user_id: 'usr_louis', display_name: 'Louis Greenwood' }];
const out = buildPriorities(tables, { now: iso(NOW), roster });
const card = (agencyId) => out.items.find((c) => c.agency_id === agencyId);

const cb = card('ag_cb');
assert.equal(cb.headline, 'HUGE PRIORITY TODAY — NEEDS A CALLBACK');
assert.equal(cb.tier, 'FIRST');
assert.equal(cb.contact.name, 'John Smith'); assert.equal(cb.contact.role, 'Managing Director'); assert.ok(cb.contact.decision_maker);
assert.ok(cb.facts.some((f) => /Heading into a meeting/.test(f.text)), 'the recorded callback note is a fact');
assert.ok(cb.facts.some((f) => /valuation opportunities/.test(f.text)));
assert.equal(cb.assignee_id, 'usr_louis');
assert.match(cb.next_step, /Call John Smith \(Managing Director\), refer to Thursday's conversation/);
assert.equal(cb.primary.kind, 'call');
ok('a director-requested callback due today leads, worded from the real call (name, role, note, Thursday)');

const retry = card('ag_retry');
assert.equal(retry.headline, 'TRY AGAIN — NO ANSWER LAST TIME');
assert.equal(retry.tier, 'TODAY'); assert.ok(retry.overdue);
assert.ok(cb.score > retry.score, 'callback outranks a no-answer retry');
const cold = card('ag_cold');
assert.equal(cold.headline, 'CALL THIS AGENCY'); assert.notEqual(cold.tier, 'FIRST');
assert.ok(!/URGENT|PRIORITY/.test(cold.headline), 'a plain call is never labelled urgent');
assert.ok(!out.items.some((c) => c.action_type === 'PROBE_AGENCY'), 'probe queue work stays in the Prober');
ok('retries and plain calls are TODAY work, below the callback; probe work excluded');

const int = card('ag_int');
assert.equal(int.headline, 'INTERESTED REPLY — STILL UNANSWERED'); assert.equal(int.tier, 'FIRST');
assert.ok(int.score_reasons.some((r) => /promise overdue/.test(r.label)));
ok('an overdue interested reply is FIRST and its score explains why');

assert.equal(card('ag_future').tier, 'COMING_UP'); assert.match(card('ag_future').headline, /^CALLBACK BOOKED — THURSDAY$/);
ok('a future callback is Coming up, worded with its day');

assert.equal(card('ag_mtg_past').headline, 'MEETING HAPPENED? RECORD THE OUTCOME'); assert.equal(card('ag_mtg_past').tier, 'FIRST');
const today = card('ag_mtg_today');
assert.equal(today.headline, 'MEETING TODAY — PREPARE NOW'); assert.match(today.summary, /Wants to see the probe result/);
assert.equal(today.meeting.booked_by, 'usr_louis');
ok('meeting prep: today = PREPARE NOW with the handover; passed = record the outcome');

assert.equal(card('ag_exc_int').situation, 'INTEREST_NO_NEXT_STEP'); assert.equal(card('ag_exc_int').kind, 'exception'); assert.equal(card('ag_exc_int').assignee_id, 'admin');
assert.equal(card('ag_prop').situation, 'MEETING_OUTCOME_NO_NEXT_STEP');
assert.equal(card('ag_pend').situation, 'CALL_FOLLOWUPS_PENDING');
assert.ok(out.items.some((c) => c.situation === 'UNMATCHED_REPLIES' && /1 REPLY NOT MATCHED/.test(c.headline)));
assert.ok(!card('ag_dead'), 'a terminal (not interested) lead raises nothing');
ok('stranded opportunities surface: interest with nothing scheduled, proposal with no follow-up, unsaved call follow-ups, unmatched replies');

const two = out.items.filter((c) => c.agency_id === 'ag_two');
assert.equal(two.length, 1); assert.equal(two[0].action_type, 'SEND_INFORMATION'); assert.equal(two[0].also_open.length, 1);
assert.equal(two[0].headline, 'THEY ASKED FOR PRICING — SEND IT TODAY');
ok('one card per agency: due work leads, the rest is "also open"');

assert.notEqual(card('ag_test').tier, 'FIRST'); assert.ok(card('ag_test').is_test);
assert.equal(card('ag_noname').contact.name, ''); assert.equal(card('ag_noname').headline, 'TRY AGAIN — GATEKEEPER LAST TIME');
assert.deepEqual(card('ag_busy').in_progress, { user_id: 'admin', since: iso(NOW - 5 * 60e3) });
assert.ok(out.items.filter((c) => c.tier === 'FIRST').length <= 6);
assert.ok(out.items.every((c) => c.debug), 'technical detail is kept, behind the toggle');
ok('test records never lead; unknown names stay unknown; a live call is shown; FIRST is capped');

assert.equal(out.scoreboard.this_week.meetings_booked, 0);
assert.ok(out.scoreboard.funnel.find((f) => f.label === 'Proposal').count === 1);
assert.ok(out.scoreboard.lost_reasons.some((r) => r.reason === 'TIMING'));
ok('scoreboard: funnel by agency, lost reasons from real outcomes');

// ── §2 London time ────────────────────────────────────────────────────────
console.log('§2 London day boundaries');
const { dueBucket } = _internal;
// 23:30Z on 19 Oct is 00:30 on 20 Oct in London (BST): 09:00 BST on the 20th is TODAY.
assert.equal(dueBucket(Date.parse('2026-10-20T08:00:00Z'), Date.parse('2026-10-19T23:30:00Z')).day, 'today');
// After the clock change (Sun 25 Oct 2026): 23:30Z on the 25th is 23:30 GMT the 25th → the 26th is tomorrow.
assert.equal(dueBucket(Date.parse('2026-10-26T09:00:00Z'), Date.parse('2026-10-25T23:30:00Z')).day, 'tomorrow');
assert.equal(dueBucket(Date.parse('2026-10-26T09:00:00Z'), Date.parse('2026-10-26T00:10:00Z')).day, 'today');
assert.equal(dueBucket(Date.parse('2026-10-24T22:30:00Z'), Date.parse('2026-10-25T12:00:00Z')).day, 'overdue');
assert.equal(new Date(londonWeekStart(Date.parse('2026-10-25T22:00:00Z')) * DAY).toISOString().slice(0, 10), '2026-10-19', 'Sunday night still belongs to the Monday-19 week');
ok('due-day and week boundaries follow the London calendar across BST→GMT');

// ── §3 reschedule survives reconciliation ────────────────────────────────
console.log('§3 reconciler keeps a human reschedule');
const stored = { action_id: 'a1', dedupe_key: 'ag:HUMAN_REPLY:r1', action_type: 'HUMAN_REPLY', action_owner: 'JOE', action_status: 'SNOOZED', due_at: iso(NOW + 2 * DAY), reason: 'q', created_at: iso(NOW - DAY), metadata_json: JSON.stringify({ rescheduled: { due_at: iso(NOW + 2 * DAY), by: 'usr_louis' }, assigned_user_id: 'usr_louis' }) };
const derived = { dedupe_key: 'ag:HUMAN_REPLY:r1', action_type: 'HUMAN_REPLY', action_owner: 'JOE', action_status: 'DUE', due_at: iso(NOW - DAY), reason: 'q', metadata_json: '{}' };
let plan = reconcileActions([stored], [derived], iso(NOW));
const patch = plan.update[0]?.patch;
assert.ok(!patch || (patch.due_at === stored.due_at && patch.action_status === 'SNOOZED'), 'the rescheduled date and status are kept');
if (patch) assert.equal(JSON.parse(patch.metadata_json).rescheduled.by, 'usr_louis');
plan = reconcileActions([{ ...stored, metadata_json: '{}' }], [derived], iso(NOW));
assert.equal(plan.update[0].patch.due_at, derived.due_at, 'without a recorded reschedule the derived date still applies');
ok('a snoozed derived action keeps its new date; un-annotated rows behave as before');

// ── §4 through the real router ────────────────────────────────────────────
console.log('§4 handlers, permissions and outcome automation');
let CLOCK = NOW;
const RealDate = Date;
globalThis.Date = class FixedDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [CLOCK])); }
  static now() { return CLOCK; }
};
function makeStore(initial) {
  const store = structuredClone(initial);
  let failAppendOnce = null;
  const api = {
    async get(range) { const tab = String(range).split('!')[0]; if (!(tab in store)) throw new Error(`Unable to parse range: ${tab}`); return store[tab].map((r) => r.slice()); },
    async append(range, rows) {
      const tab = String(range).split('!')[0];
      if (failAppendOnce === tab) { failAppendOnce = null; throw new Error('simulated Sheets failure'); }
      if (!(tab in store)) throw new Error(`no tab ${tab}`); store[tab].push(...rows.map((r) => r.slice()));
    },
    async update(range, rows) {
      const [tab, a1] = String(range).split('!'); const m = a1.match(/^([A-Z]+)(\d+)/);
      const c0 = m[1].split('').reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1; const r0 = Number(m[2]) - 1;
      rows.forEach((row, i) => { while (store[tab].length <= r0 + i) store[tab].push([]); const t = store[tab][r0 + i]; row.forEach((v, j) => { while (t.length <= c0 + j) t.push(''); t[c0 + j] = v; }); });
    },
    async batchUpdate(data) { for (const { range, values } of data) await api.update(range, values); },
    async listTabs() { return Object.keys(store); },
    async addTab(tab) { store[tab] = []; },
    async deleteRows(tab, ns) { for (const n of [...new Set(ns)].sort((a, b) => b - a)) store[tab].splice(n - 1, 1); },
  };
  return { store, repo: createRepo(api), failNextAppend: (tab) => { failAppendOnce = tab; } };
}
const { store, repo, failNextAppend } = makeStore({
  AGENCIES: [['agency_id', 'clean_agency_name', 'main_phone', 'outreach_contact_name', 'outreach_contact_email', 'current_pipeline_status', 'updated_at'],
    ['ag_a', 'Alpha Estates', '01277 710001', 'Amy Alpha', 'amy@alpha.test', '', ''],
    ['ag_b', 'Beta Homes', '01277 710002', 'Ben Beta', 'ben@beta.test', '', ''],
    ['ag_c', 'Gamma Sales', '01277 710003', 'Cat Gamma', 'cat@gamma.test', '', '']],
  PROBES: [['probe_id', 'agency_id', 'probe_status', 'probe_timestamp'], ['pr_a', 'ag_a', 'CLOSED', iso(NOW - 9 * DAY)], ['pr_b', 'ag_b', 'CLOSED', iso(NOW - 9 * DAY)], ['pr_c', 'ag_c', 'CLOSED', iso(NOW - 9 * DAY)]],
  REPLY_EVENTS: [['reply_event_id', 'agency_id', 'classification', 'received_at', 'suppression_type']],
  INTELLIGENCE: [['intelligence_id', 'agency_id']], PERSONALISATION: [['probe_id', 'agency_id']], DEMOS: [['demo_id', 'agency_id']], OUTBOUND: [['outbound_id', 'agency_id']],
  ACTIONS: [[...ACTIONS_HEADER], rowFor(ACTIONS_HEADER, act('a_legacy', 'ag_c', 'CALL_PROSPECT', NOW - DAY, {}, { source_stage: 'CALL_DUE' }))],
});
__setRepoForTests(repo);
__setKvForTests(createMemoryKv({ now: () => CLOCK }));
Object.assign(process.env, { NOVUS_BASIC_AUTH_USER: 'novus', NOVUS_BASIC_AUTH_PASS: 'admin-env-pass', NOVUS_SESSION_SECRET: 'test-session-secret-0123456789-abcdefghij', NOVUS_ADMIN_DISPLAY_NAME: 'Joe' });
const { default: handler } = await import('../api/novus/personalisation.js');
const HOST = 'novus.test';
const response = () => ({ statusCode: 200, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; }, end() { return this; }, setHeader(k, v) { this.headers[k] = v; } });
async function request(method, operation, { body, query = {}, cookie = '' } = {}) {
  const headers = { host: HOST, 'sec-fetch-mode': 'cors' };
  if (cookie) headers.cookie = cookie; else headers.authorization = `Basic ${Buffer.from('novus:admin-env-pass').toString('base64')}`;
  if (method !== 'GET') headers.origin = `https://${HOST}`;
  const res = response();
  await handler({ method, query: { novus_operation: operation, ...query }, headers, body }, res);
  return res;
}
const rows = (tab) => (store[tab] || []).slice(1).filter((r) => r[0] && r[0] !== 'SCHEMA NOTE').map((r) => Object.fromEntries(store[tab][0].map((k, i) => [k, r[i] ?? ''])));
const metaOf = (r) => JSON.parse(r.metadata_json || '{}');

assert.equal((await request('POST', 'calling-setup', { body: { confirm: 'SETUP_CALLING_TABS' } })).statusCode, 200);
assert.equal((await request('POST', 'discovery-setup', { body: { confirm: 'SETUP_DISCOVERY' } })).statusCode, 200);
const created = await request('POST', 'team-user-create', { body: { confirm: 'CREATE_USER', display_name: 'Louis Greenwood', username: 'louis.g' } });
assert.equal(created.statusCode, 201);
const louisId = created.body.user.user_id;
const login = await request('POST', 'auth-login', { body: { username: 'louis.g', password: created.body.one_time_password } });
let louis = String(login.headers['Set-Cookie'] || '').split(';')[0];
const relogin = async () => { louis = String((await request('POST', 'auth-login', { body: { username: 'louis.g', password: created.body.one_time_password } })).headers['Set-Cookie'] || '').split(';')[0]; assert.ok(louis, 'setter can sign in again'); };
assert.ok(louis);
assert.equal(login.body.redirect, '/novus/priorities.html');
ok('a setter signs in and lands on Your Priorities');

assert.equal((await request('GET', 'priorities', { cookie: louis })).statusCode, 200);
for (const op of ['campaigns-list', 'team-users', 'lead-timeline']) assert.equal((await request('GET', op, { cookie: louis })).statusCode, 403, `${op} stays admin-only`);
for (const op of ['team-user-create', 'operator-manual-reply', 'campaign-launch', 'team-user-delete']) assert.equal((await request('POST', op, { cookie: louis, body: {} })).statusCode, 403, `${op} stays admin-only`);
ok('setter: priorities allowed; team, campaigns, sends and deletes still refused');

// Callback requested → one callback, assigned to the caller, retry-safe.
const nextThu = Date.parse('2026-10-22T13:00:00.000Z'); // Thu 14:00 London
const saveBody = { confirm: 'SAVE_CALL', agency_id: 'ag_a', client_key: 'ck-cb-1', outcome: 'CALLBACK_REQUESTED', callback_at: iso(nextThu), callback_note: 'Asked to call next Thursday', contact_name: 'Amy Alpha', contact_role: 'Director', owner_reached: true, started_at: iso(NOW - 600e3) };
const s1 = await request('POST', 'calling-save', { cookie: louis, body: saveBody });
assert.ok([200, 201].includes(s1.statusCode), JSON.stringify(s1.body));
const s2 = await request('POST', 'calling-save', { cookie: louis, body: saveBody });
assert.equal(s2.body.reused, true);
const callbacks = rows('ACTIONS').filter((a) => a.agency_id === 'ag_a' && ['PENDING', 'DUE'].includes(a.action_status));
assert.equal(callbacks.length, 1, 'exactly one active callback after a retried save');
assert.equal(callbacks[0].due_at, iso(nextThu)); assert.equal(metaOf(callbacks[0]).assigned_user_id, louisId);
let pr = (await request('GET', 'priorities', { cookie: louis, query: { refresh: '1' } })).body;
let c = pr.items.find((x) => x.agency_id === 'ag_a');
assert.equal(c.tier, 'COMING_UP'); assert.equal(c.headline, 'CALLBACK BOOKED — THURSDAY'); assert.equal(c.assignee_id, louisId);
ok('callback outcome → one callback at the requested time, assigned to Louis, shown in Coming up');

// On Thursday morning the same callback is today's top priority.
CLOCK = Date.parse('2026-10-22T08:00:00.000Z');
await relogin(); // a new working day = a new session
pr = (await request('GET', 'priorities', { cookie: louis, query: { refresh: '1' } })).body;
c = pr.items.find((x) => x.agency_id === 'ag_a');
assert.equal(c.tier, 'FIRST'); assert.equal(c.headline, 'HUGE PRIORITY TODAY — NEEDS A CALLBACK');
ok('…and on the day it becomes HUGE PRIORITY TODAY without anyone touching it');

// Meeting booked on the call → callback completed, prep to Joe with handover.
const meetAt = Date.parse('2026-10-27T10:00:00.000Z');
const s3 = await request('POST', 'calling-save', { cookie: louis, body: { confirm: 'SAVE_CALL', agency_id: 'ag_a', client_key: 'ck-mtg-1', outcome: 'BOOKED_MEETING', meeting_at: iso(meetAt), meeting_note: 'Owner wants to see the probe', contact_name: 'Amy Alpha', contact_role: 'Director', useful_note: 'Loses track of old valuations', source_action_id: callbacks[0].action_id, started_at: iso(CLOCK - 300e3) } });
assert.ok([200, 201].includes(s3.statusCode), JSON.stringify(s3.body));
const after = rows('ACTIONS').filter((a) => a.agency_id === 'ag_a');
assert.equal(after.find((a) => a.action_id === callbacks[0].action_id).action_status, 'COMPLETED');
const prep = after.find((a) => a.action_type === 'PREPARE_MEETING');
assert.equal(metaOf(prep).assigned_user_id, 'admin');
assert.equal(metaOf(prep).handover.booked_by, louisId); assert.equal(metaOf(prep).handover.useful_note, 'Loses track of old valuations');
assert.equal(rows('AGENCIES').find((a) => a.agency_id === 'ag_a').current_pipeline_status, 'MEETING_BOOKED');
assert.ok((await request('GET', 'calling-workspace', { cookie: louis })).body.queue.every((l) => l.agency_id !== 'ag_a'), 'a booked agency leaves the cold-call queue');
ok('meeting booked → callback resolved, stage MEETING_BOOKED, prep assigned to Joe with Louis\'s handover, calling suppressed');

// Pick up, reschedule, complete from the shared list (setter).
const legacy = 'a_legacy';
assert.equal((await request('POST', 'action-assign', { cookie: louis, body: { confirm: 'ASSIGN_ACTION', action_id: legacy, user_id: louisId } })).statusCode, 200);
const due2 = iso(CLOCK + 2 * DAY);
assert.equal((await request('POST', 'operator-action-snooze', { cookie: louis, body: { confirm: 'SNOOZE_ACTION', action_id: legacy, due_at: due2, note: 'on holiday' } })).statusCode, 200);
const snoozed = rows('ACTIONS').find((a) => a.action_id === legacy);
assert.equal(snoozed.action_status, 'SNOOZED'); assert.equal(metaOf(snoozed).rescheduled.by, louisId); assert.equal(metaOf(snoozed).assigned_user_id, louisId);
assert.equal((await request('POST', 'operator-action-complete', { cookie: louis, body: { confirm: 'COMPLETE_ACTION', action_id: legacy, completion_note: 'Spoke on mobile' } })).statusCode, 200);
assert.equal(rows('ACTIONS').find((a) => a.action_id === legacy).action_status, 'COMPLETED');
ok('setter can pick up, reschedule (attributed) and complete a shared action');

// No-show: create the rebook flagged against the meeting.
const ns = await request('POST', 'operator-action-create', { cookie: louis, body: { confirm: 'CREATE_ACTION', agency_id: 'ag_b', action_type: 'FOLLOW_UP', priority: 'HIGH', title: 'Missed meeting — rebook it', due_at: iso(CLOCK + 3600e3), no_show: true, meeting_at: iso(CLOCK - DAY), assigned_user_id: louisId } });
assert.equal(ns.statusCode, 201);
assert.equal(metaOf(ns.body.action).no_show, true);
pr = (await request('GET', 'priorities', { query: { refresh: '1' } })).body;
assert.equal(pr.items.find((x) => x.agency_id === 'ag_b').headline, 'MISSED MEETING — REBOOK IT');
ok('no-show rebook is recorded against the meeting and worded as such');

// Meeting outcome with no date → a follow-up anyway, London 09:00, 2 working days.
const st = await request('POST', 'discovery-start', { body: { agency_id: 'ag_c' } });
assert.ok([200, 201].includes(st.statusCode), JSON.stringify(st.body));
const oc = await request('POST', 'discovery-outcome', { body: { confirm: 'RECORD_OUTCOME', session_id: st.body.session_id, outcome: 'PROPOSAL_REQUESTED' } });
assert.equal(oc.statusCode, 200, JSON.stringify(oc.body));
assert.equal(oc.body.follow_up_defaulted, true);
assert.equal(oc.body.follow_up_at, '2026-10-26T09:00:00.000Z', 'Thu → Mon (2 working days), 09:00 London = 09:00Z after the clock change');
assert.ok(rows('ACTIONS').some((a) => a.agency_id === 'ag_c' && a.action_type === 'MEETING_FOLLOW_UP' && a.action_status === 'PENDING'));
ok('PROPOSAL_REQUESTED with no date still schedules the follow-up (DST-correct)');

// operator-call-outcome: a failed follow-up write leaves the call action open.
const legacyCall = rowFor(ACTIONS_HEADER, act('a_lc', 'ag_b', 'CALL_PROSPECT', CLOCK - DAY, {}, { source_stage: 'CALL_DUE' }));
store.ACTIONS.push(legacyCall);
failNextAppend('ACTIONS');
const bad = await request('POST', 'operator-call-outcome', { body: { confirm: 'RECORD_CALL_OUTCOME', action_id: 'a_lc', outcome: 'CALL_LATER', due_at: iso(CLOCK + DAY) } });
assert.equal(bad.statusCode, 500);
assert.notEqual(rows('ACTIONS').find((a) => a.action_id === 'a_lc').action_status, 'COMPLETED', 'not completed when its follow-up failed');
const good = await request('POST', 'operator-call-outcome', { body: { confirm: 'RECORD_CALL_OUTCOME', action_id: 'a_lc', outcome: 'CALL_LATER', due_at: iso(CLOCK + DAY) } });
assert.equal(good.statusCode, 200, JSON.stringify(good.body));
assert.equal(rows('ACTIONS').find((a) => a.action_id === 'a_lc').action_status, 'COMPLETED');
assert.equal(rows('ACTIONS').filter((a) => a.agency_id === 'ag_b' && a.action_type === 'CALL_PROSPECT' && a.action_status === 'PENDING').length, 1);
ok('operator-call-outcome writes the next step first; a failed write never completes the call');

console.log(`\n${passed} checks passed`);
