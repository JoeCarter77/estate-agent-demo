#!/usr/bin/env node
// scripts/novus-team-ownership-selftest.mjs — hermetic end-to-end test of team
// ownership (lib/lead-ownership.mjs + lib/ownership-handlers.mjs) through the
// real router with real logins: migration preview/apply/idempotence, first-
// interaction claims, no overwrite by a second caller, manual transfer with
// history, action inheritance and reassignment, filters' server fields,
// member deletion with transfer, simultaneous claims, refresh persistence,
// machine clients and background reconciliation never claiming.
// No network, no real credentials.
//
// Run:  npm run novus:team-ownership-selftest

import assert from 'node:assert/strict';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { CALLS_HEADER, rowFor } from '../lib/calling-store.mjs';
import { ACTIONS_HEADER } from '../lib/actions-store.mjs';
import { SALES_MESSAGES_HEADER } from '../lib/sales-messages.mjs';
import { USERS_HEADER, metaOf, invalidateUsersCache } from '../lib/novus-users.mjs';
import { createMemoryKv, __setKvForTests } from '../lib/kv.mjs';
import { LEAD_OWNERSHIP_HEADER, claimLeadIfUnassigned, deriveLeadOwners } from '../lib/lead-ownership.mjs';

let passed = 0;
const ok = (msg) => { passed += 1; console.log(`  ✓ ${msg}`); };

function makeStore(initial) {
  const store = structuredClone(initial);
  const api = {
    async get(range) { const tab = String(range).split('!')[0]; if (!(tab in store)) throw new Error(`Unable to parse range: ${tab}`); return store[tab].map((r) => r.slice()); },
    async append(range, rows) { const tab = String(range).split('!')[0]; if (!(tab in store)) throw new Error(`no tab ${tab}`); await Promise.resolve(); store[tab].push(...rows.map((r) => r.slice())); },
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
  return { store, api, repo: createRepo(api) };
}

const T0 = Date.parse('2026-10-19T09:00:00.000Z');
let NOW = T0;
const RealDate = Date;
globalThis.Date = class FixedDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
};
const iso = (ms) => new Date(ms).toISOString();
const DAY = 86_400_000;
const HOST = 'novus.test';

const AG = ['agency_id', 'clean_agency_name', 'main_phone', 'outreach_contact_name', 'outreach_contact_email', 'current_pipeline_status', 'updated_at'];
const action = (id, agencyId, status, meta = {}, due = '') => rowFor(ACTIONS_HEADER, {
  action_id: id, agency_id: agencyId, action_type: 'FOLLOW_UP', action_owner: 'JOE', action_status: status, due_at: due,
  reason: 'seed', source_stage: 'MANUAL', dedupe_key: `${agencyId}:seed:${id}`, created_at: iso(T0 - 5 * DAY), updated_at: iso(T0 - 5 * DAY),
  completed_at: status === 'COMPLETED' ? iso(T0 - 4 * DAY) : '', metadata_json: JSON.stringify({ manual: true, ...meta }),
});
const { store, api, repo } = makeStore({
  AGENCIES: [AG,
    ['ag_old1', 'Old One Estates', '01277 700001', 'Ann Old', 'ann@old1.test', '', ''],
    ['ag_old2', 'Old Two Lettings', '01277 700002', 'Bob Old', 'bob@old2.test', '', ''],
    ['ag_old3', 'Old Three Sales', '01277 700003', 'Cy Old', 'cy@old3.test', '', ''],
    ['ag_old4', 'Old Four Homes', '01277 700004', 'Di Old', 'di@old4.test', '', ''],
    ['ag_old5', 'Old Five Estates', '01277 700005', 'Ed Old', 'ed@old5.test', '', ''],
    ['ag_old6', 'Old Six Lettings', '01277 700006', 'Flo Old', 'flo@old6.test', '', '']],
  PROBES: [['probe_id', 'agency_id', 'probe_status', 'probe_timestamp'],
    ...['1', '2', '3', '4', '5', '6'].map((n) => [`pr_o${n}`, `ag_old${n}`, 'CLOSED', iso(T0 - 20 * DAY)])],
  SALES_MESSAGES: [[...SALES_MESSAGES_HEADER],
    rowFor(SALES_MESSAGES_HEADER, { sales_message_id: 'sm_1', agency_id: 'ag_old5', direction: 'OUTBOUND', message_type: 'MANUAL_REPLY', send_outcome: 'SENT', sent_by: 'joe', sent_at: iso(T0 - 5 * DAY), created_at: iso(T0 - 5 * DAY) }),
    rowFor(SALES_MESSAGES_HEADER, { sales_message_id: 'sm_2', agency_id: 'ag_old6', direction: 'OUTBOUND', message_type: 'MANUAL_REPLY', send_outcome: 'SENT', sent_by: 'joe', sent_at: iso(T0 - 2 * DAY), created_at: iso(T0 - 2 * DAY) })],
  REPLY_EVENTS: [['reply_event_id', 'agency_id', 'classification', 'received_at', 'suppression_type']],
  // The rest of the dashboard's required tabs, empty.
  INTELLIGENCE: [['intelligence_id', 'agency_id']], PERSONALISATION: [['probe_id', 'agency_id']],
  DEMOS: [['demo_id', 'agency_id']], OUTBOUND: [['outbound_id', 'agency_id']],
  ACTIONS: [[...ACTIONS_HEADER],
    action('act_done', 'ag_old1', 'COMPLETED'),
    action('act_overdue', 'ag_old1', 'PENDING', {}, iso(T0 - DAY)),
    action('act_future', 'ag_old2', 'PENDING', {}, iso(T0 + 3 * DAY))],
});
__setRepoForTests(repo);
__setKvForTests(createMemoryKv({ now: () => NOW }));
process.env.NOVUS_BASIC_AUTH_USER = 'novus';
process.env.NOVUS_BASIC_AUTH_PASS = 'admin-env-pass';
process.env.NOVUS_SESSION_SECRET = 'test-session-secret-0123456789-abcdefghij';
process.env.NOVUS_ADMIN_DISPLAY_NAME = 'Joe';
const { default: handler } = await import('../api/novus/personalisation.js');
const { reconcileActionEngine } = await import('../lib/action-engine.mjs');

const response = () => ({ statusCode: 200, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; }, end() { return this; }, setHeader(k, v) { this.headers[k] = v; }, write() {}, writeHead(c) { this.statusCode = c; return this; } });
async function request(method, operation, { body, query = {}, cookie = '', headers: extra = {} } = {}) {
  const headers = { host: HOST, 'sec-fetch-mode': 'cors', ...extra };
  if (cookie) headers.cookie = cookie;
  if (method !== 'GET') headers.origin = `https://${HOST}`;
  const res = response();
  await handler({ method, query: { novus_operation: operation, ...query }, headers, body }, res);
  return res;
}
const login = async (username, password) => String((await request('POST', 'auth-login', { body: { username, password } })).headers['Set-Cookie'] || '').split(';')[0];
const tab = (name) => (store[name] || []).slice(1).filter((r) => r[0] && r[0] !== 'SCHEMA NOTE');
const ownersNow = (r = repo) => r.getTable('LEAD_OWNERSHIP').then((t) => deriveLeadOwners(t).owners).catch(() => new Map());
const ownerOf = async (agencyId) => (await ownersNow()).get(agencyId)?.user_id || '';
const actionRow = (id) => { const row = store.ACTIONS.find((r) => r[0] === id); return Object.fromEntries(ACTIONS_HEADER.map((k, i) => [k, row[i] ?? ''])); };
const dashboard = async (cookie) => (await request('GET', 'operator-dashboard', { cookie, query: { refresh: '1' } })).body;
const saveCall = (cookie, agencyId, key, outcome = 'NO_ANSWER') => request('POST', 'calling-save', { cookie, body: { confirm: 'SAVE_CALL', client_key: key, agency_id: agencyId, call_mode: 'MANUAL', outcome, callback_at: iso(NOW + 2 * DAY) } });

// ── setup: Joe (env admin) + Louis (setter) ────────────────────────────────
const JOE = await login('novus', 'admin-env-pass');
let res = await request('POST', 'calling-setup', { cookie: JOE, body: { confirm: 'SETUP_CALLING_TABS' } });
assert.equal(res.statusCode, 200, JSON.stringify(res.body));
res = await request('POST', 'team-user-create', { cookie: JOE, body: { confirm: 'CREATE_USER', display_name: 'Louis', username: 'louis' } });
const louisPass = res.body.one_time_password; const louisId = res.body.user.user_id;
NOW += 1000;
let LOUIS = await login('louis', louisPass);
// Pre-existing history: Louis called ag_old2 before ownership existed, and a
// call action already assigned to him.
const histCall = (id, agencyId, startedAt, meta) => store.CALLS.push(rowFor(CALLS_HEADER, { call_id: id, agency_id: agencyId, call_mode: 'MANUAL', call_status: 'completed', outcome: 'NO_ANSWER', started_at: startedAt, created_at: startedAt, updated_at: startedAt, metadata_json: JSON.stringify(meta) }));
histCall('call_joe_old', 'ag_old3', iso(T0 - 30 * DAY), {});                  // unattributed, before any other account: only Joe could have made it
histCall('call_ambiguous', 'ag_old4', iso(NOW), {});                         // unattributed, after Louis's account existed: ambiguous
histCall('call_louis_old6', 'ag_old6', iso(T0 - 8 * DAY), { user_id: louisId }); // Louis first, Joe's email later
store.CALLS.push(rowFor(CALLS_HEADER, { call_id: 'call_hist', agency_id: 'ag_old2', call_mode: 'MANUAL', call_status: 'completed', outcome: 'NO_ANSWER', started_at: iso(T0 - 10 * DAY), created_at: iso(T0 - 10 * DAY), updated_at: iso(T0 - 10 * DAY), metadata_json: JSON.stringify({ user_id: louisId, user_name: 'Louis' }) }));
store.ACTIONS.push(action('act_louis', 'ag_old2', 'PENDING', { assigned_user_id: louisId }, iso(T0 + DAY)));

// ── 10. migration: preview, apply, verify, idempotent ──────────────────────
const before = JSON.stringify(store);
res = await request('POST', 'team-ownership-migrate', { cookie: JOE, body: { mode: 'preview' } });
assert.equal(res.statusCode, 200, JSON.stringify(res.body));
assert.equal(JSON.stringify(store), before, 'preview writes nothing');
assert.deepEqual(res.body.leads.map((l) => [l.agency_id, l.to_user_id, l.basis]), [
  ['ag_old2', louisId, 'first call'], ['ag_old3', 'admin', 'first call'], ['ag_old5', 'admin', 'first email'], ['ag_old6', louisId, 'first call']]);
assert.equal(res.body.summary.leads_to_assign, 4);
assert.deepEqual(res.body.unassigned.map((u) => [u.agency_id, u.reason]), [['ag_old1', 'never contacted'], ['ag_old4', 'ambiguous: first call has no reliable author']]);
assert.equal(res.body.summary.leads_left_unassigned, 2);
assert.equal(res.body.summary.actions_to_assign, 3, 'act_done, act_overdue, act_future — not act_louis');
assert.deepEqual(res.body.summary.actions_by_status, { COMPLETED: 1, PENDING: 2 });
assert.deepEqual(res.body.backup.map((b) => b.action_id), ['act_done', 'act_overdue', 'act_future']);
assert.equal((await request('POST', 'team-ownership-migrate', { cookie: JOE, body: { mode: 'apply' } })).statusCode, 400, 'apply needs the confirm token');
assert.equal((await request('POST', 'team-ownership-migrate', { cookie: LOUIS, body: { mode: 'preview' } })).statusCode, 403, 'admin only');
const actionsBefore = store.ACTIONS.map((r) => r.slice());
res = await request('POST', 'team-ownership-migrate', { cookie: JOE, body: { mode: 'apply', confirm: 'MIGRATE_OWNERSHIP' } });
assert.equal(res.statusCode, 200, JSON.stringify(res.body));
assert.equal(res.body.verified, true); assert.deepEqual(res.body.remaining, { leads: 0, actions: 0 });
assert.equal(store.ACTIONS.length, actionsBefore.length, 'no action duplicated or removed');
for (const [i, row] of store.ACTIONS.entries()) {
  ACTIONS_HEADER.forEach((col, c) => { if (col !== 'metadata_json') assert.equal(row[c] ?? '', actionsBefore[i][c] ?? '', `${row[0]}.${col} unchanged`); });
}
for (const id of ['act_done', 'act_overdue', 'act_future']) {
  const meta = metaOf(actionRow(id));
  assert.equal(meta.assigned_user_id, 'admin'); assert.equal(meta.manual, true, 'existing metadata kept');
}
assert.equal(metaOf(actionRow('act_louis')).assigned_user_id, louisId, 'established assignment not overwritten');
assert.equal(await ownerOf('ag_old1'), '', 'never contacted: left unassigned');
assert.equal(await ownerOf('ag_old4'), '', 'ambiguous: left unassigned, not guessed');
assert.equal(await ownerOf('ag_old2'), louisId); assert.equal(await ownerOf('ag_old3'), 'admin'); assert.equal(await ownerOf('ag_old5'), 'admin'); assert.equal(await ownerOf('ag_old6'), louisId);
const ownershipRows = tab('LEAD_OWNERSHIP').length;
res = await request('POST', 'team-ownership-migrate', { cookie: JOE, body: { mode: 'apply', confirm: 'MIGRATE_OWNERSHIP' } });
assert.equal(res.body.summary.leads_to_assign, 0); assert.equal(res.body.summary.actions_to_assign, 0);
assert.equal(tab('LEAD_OWNERSHIP').length, ownershipRows, 're-running writes nothing');
ok('10. migration: preview is read-only with counts + backup; contacted leads go to their first reliable interaction (call/email), never-contacted and ambiguous leads stay unassigned; every unassigned action goes to Joe with statuses/due dates/metadata and explicit assignments kept; verified and idempotent');

// An unassigned lead whose action is Joe's is NOT Joe's lead: Louis claims it.
let dash0 = await dashboard(JOE);
const old1 = dash0.leads.find((l) => l.agency_id === 'ag_old1');
assert.equal(old1.owner_user_id, ''); assert.equal(old1.next_action.assigned_user_id, 'admin'); assert.equal(old1.next_action.assigned_explicit, true);
NOW += 60_000;
res = await request('POST', 'calling-start', { cookie: LOUIS, body: { confirm: 'START_CALL', agency_id: 'ag_old1', client_key: 'l-old1' } });
assert.equal(res.statusCode, 201, JSON.stringify(res.body));
assert.equal(await ownerOf('ag_old1'), louisId, 'Louis\'s first interaction claims it');
assert.equal(metaOf(actionRow('act_overdue')).assigned_user_id, 'admin', 'Joe\'s action stays Joe\'s');
ok('an unassigned lead with an action allocated to Joe stays unowned until someone interacts; Louis\'s first call claims it and Joe keeps the action');

// New leads arrive after the migration (an import) — eligible for claiming.
store.AGENCIES.push(['ag_n1', 'New One Homes', '01277 700011', 'Cat New', 'cat@n1.test', '', ''], ['ag_n2', 'New Two Homes', '01277 700012', 'Dan New', 'dan@n2.test', '', ''],
  ['ag_n3', 'New Three Homes', '01277 700013', 'Eve New', 'eve@n3.test', '', ''], ['ag_n4', 'New Four Homes', '01277 700014', 'Fay New', 'fay@n4.test', '', '']);
store.PROBES.push(['pr_n1', 'ag_n1', 'CLOSED', iso(T0 - 9 * DAY)], ['pr_n2', 'ag_n2', 'CLOSED', iso(T0 - 9 * DAY)], ['pr_n3', 'ag_n3', 'CLOSED', iso(T0 - 9 * DAY)], ['pr_n4', 'ag_n4', 'CLOSED', iso(T0 - 9 * DAY)]);
NOW += 60_000; // past the 30s workspace cache
for (const id of ['ag_n1', 'ag_n2', 'ag_n3', 'ag_n4']) assert.equal(await ownerOf(id), '', `${id} starts unassigned`);

// Viewing, searching and opening a lead never claims it.
await request('GET', 'lead-search', { cookie: LOUIS, query: { q: 'New One' } });
await request('GET', 'calling-lead-profile', { cookie: LOUIS, query: { agency_id: 'ag_n1' } });
await request('GET', 'calling-workspace', { cookie: LOUIS });
await request('GET', 'lead-timeline', { cookie: JOE, query: { agency_id: 'ag_n1' } });
assert.equal(await ownerOf('ag_n1'), '');
ok('viewing, searching, opening a profile or the queue never claims a lead');

// ── 1-3. claims ─────────────────────────────────────────────────────────────
res = await saveCall(JOE, 'ag_n1', 'j-1');
assert.equal(res.statusCode, 201, JSON.stringify(res.body));
assert.equal(res.body.ownership.claimed, true);
assert.equal(await ownerOf('ag_n1'), 'admin');
ok('1. Joe calls an unassigned lead → it belongs to Joe');
res = await request('POST', 'calling-start', { cookie: LOUIS, body: { confirm: 'START_CALL', agency_id: 'ag_n2', client_key: 'l-start-1' } });
assert.equal(res.statusCode, 201, JSON.stringify(res.body));
assert.equal(await ownerOf('ag_n2'), louisId, 'making the call claims');
res = await saveCall(LOUIS, 'ag_n2', 'l-start-1');
assert.equal(res.statusCode, 200, JSON.stringify(res.body));
assert.equal(res.body.ownership.claimed, false); assert.equal(res.body.ownership.owner_user_id, louisId);
ok('2. Louis calls a different unassigned lead → it belongs to Louis (claimed when he dials, kept when he logs it)');
const n1Events = tab('LEAD_OWNERSHIP').length;
res = await saveCall(LOUIS, 'ag_n1', 'l-2', 'CALLBACK_REQUESTED');
assert.equal(res.statusCode, 201, JSON.stringify(res.body));
assert.equal(await ownerOf('ag_n1'), 'admin');
assert.equal(tab('LEAD_OWNERSHIP').length, n1Events, 'no claim row appended for an owned lead');
ok('3. Louis interacts with Joe\'s lead → Joe remains the owner');

// ── 4. manual transfer + history ────────────────────────────────────────────
assert.equal((await request('POST', 'lead-owner-set', { cookie: LOUIS, body: { confirm: 'SET_LEAD_OWNER', agency_id: 'ag_n1', user_id: louisId } })).statusCode, 403, 'setters cannot reassign');
assert.equal((await request('POST', 'lead-owner-set', { cookie: JOE, body: { confirm: 'SET_LEAD_OWNER', agency_id: 'ag_n1', user_id: 'usr_ghost' } })).statusCode, 400, 'unknown member refused');
NOW += 1000;
res = await request('POST', 'lead-owner-set', { cookie: JOE, body: { confirm: 'SET_LEAD_OWNER', agency_id: 'ag_n1', user_id: louisId, reason: 'Louis is handling the callback' } });
assert.equal(res.statusCode, 200, JSON.stringify(res.body));
assert.equal(res.body.from_user_id, 'admin'); assert.equal(res.body.to_user_id, louisId);
assert.equal(await ownerOf('ag_n1'), louisId);
const timeline = (await request('GET', 'lead-timeline', { cookie: JOE, query: { agency_id: 'ag_n1' } })).body;
const ownerEntries = timeline.entries.filter((e) => e.kind === 'owner');
assert.deepEqual(ownerEntries.map((e) => [e.type, e.from_user_id, e.to_user_id]), [['OWNER_CLAIM', '', 'admin'], ['OWNER_ASSIGN', 'admin', louisId]]);
assert.equal(ownerEntries[1].title, 'Lead reassigned to Louis'); assert.match(ownerEntries[1].detail, /was Joe · Louis is handling the callback · by Joe/);
assert.equal(ownerEntries[1].at, iso(NOW));
assert.equal(timeline.owner_user_id, louisId);
ok('4. Joe transfers a lead to Louis → owner changes; history shows previous owner, new owner, reason, who and when');

// ── 5-6. action inheritance and reassignment ───────────────────────────────
res = await request('POST', 'operator-action-create', { cookie: JOE, body: { confirm: 'CREATE_ACTION', agency_id: 'ag_n1', action_type: 'FOLLOW_UP', due_at: iso(T0 - 1000), note: 'Send pricing' } });
assert.equal(res.statusCode, 201, JSON.stringify(res.body));
const newActionId = res.body.action.action_id;
assert.equal(metaOf(actionRow(newActionId)).assigned_user_id, louisId);
res = await request('POST', 'operator-action-create', { cookie: JOE, body: { confirm: 'CREATE_ACTION', agency_id: 'ag_n4', action_type: 'EMAIL', note: 'Unassigned lead, explicit assignee', assigned_user_id: 'admin' } });
assert.equal(metaOf(actionRow(res.body.action.action_id)).assigned_user_id, 'admin');
assert.equal(await ownerOf('ag_n4'), '', 'creating an action does not claim');
ok('5. an action created for Louis\'s lead defaults to Louis; an unassigned lead can still have an explicitly assigned action');
assert.equal((await request('POST', 'action-assign', { cookie: LOUIS, body: { confirm: 'ASSIGN_ACTION', action_id: newActionId, user_id: louisId } })).statusCode, 403);
const statusBefore = actionRow(newActionId).action_status; const dueBefore = actionRow(newActionId).due_at;
res = await request('POST', 'action-assign', { cookie: JOE, body: { confirm: 'ASSIGN_ACTION', action_id: newActionId, user_id: 'admin' } });
assert.equal(res.statusCode, 200, JSON.stringify(res.body));
assert.equal(metaOf(actionRow(newActionId)).assigned_user_id, 'admin');
assert.equal(metaOf(actionRow(newActionId)).note, 'Send pricing', 'metadata merged, not replaced');
assert.equal(actionRow(newActionId).action_status, statusBefore); assert.equal(actionRow(newActionId).due_at, dueBefore);
assert.equal(await ownerOf('ag_n1'), louisId);
ok('6. the action is reassigned to Joe → its status and due date are untouched and the lead still belongs to Louis');

// Changing the lead owner does not move an individually assigned action.
await request('POST', 'lead-owner-set', { cookie: JOE, body: { confirm: 'SET_LEAD_OWNER', agency_id: 'ag_n1', user_id: 'admin' } });
assert.equal(metaOf(actionRow(newActionId)).assigned_user_id, 'admin');
await request('POST', 'lead-owner-set', { cookie: JOE, body: { confirm: 'SET_LEAD_OWNER', agency_id: 'ag_n1', user_id: louisId } });
assert.equal(metaOf(actionRow(newActionId)).assigned_user_id, 'admin', 'still Joe\'s after two owner changes');
ok('changing a lead\'s owner never silently changes an individually assigned action');

// ── 7-8. what the filters read ──────────────────────────────────────────────
let dash = await dashboard(JOE);
const byId = Object.fromEntries(dash.leads.map((l) => [l.agency_id, l]));
assert.equal(byId.ag_n1.owner_user_id, louisId);
assert.equal(byId.ag_n1.next_action.id, newActionId); assert.equal(byId.ag_n1.next_action.assigned_user_id, 'admin'); assert.equal(byId.ag_n1.next_action.assigned_explicit, true);
const joeActions = dash.leads.filter((l) => l.needs_human && l.next_action.assigned_user_id === 'admin').map((l) => l.agency_id);
assert.ok(joeActions.includes('ag_n1') && joeActions.includes('ag_old1'));
assert.ok(dash.leads.filter((l) => l.needs_human && joeActions.includes(l.agency_id)).every((l) => l.next_action.assigned_user_id === 'admin'));
const louisLeads = dash.leads.filter((l) => l.owner_user_id === louisId).map((l) => l.agency_id).sort();
assert.deepEqual(louisLeads, ['ag_n1', 'ag_n2', 'ag_old1', 'ag_old2', 'ag_old6']);
assert.deepEqual(dash.leads.filter((l) => !l.owner_user_id).map((l) => l.agency_id).sort(), ['ag_n3', 'ag_n4', 'ag_old4']);
// The page's filter function itself, lifted from operator.html.
const page = (await import('node:fs')).readFileSync(new URL('../novus/operator.html', import.meta.url), 'utf8');
const teamMatchSrc = page.match(/function teamMatch\(userId, key\)\{[\s\S]*?\n\}/)[0];
const teamMatch = new Function('ROSTER', `${teamMatchSrc}; return teamMatch;`)({ me: louisId });
assert.deepEqual(dash.leads.filter((l) => teamMatch(l.owner_user_id, louisId)).map((l) => l.agency_id).sort(), louisLeads);
assert.deepEqual(dash.leads.filter((l) => teamMatch(l.owner_user_id, 'me')).map((l) => l.agency_id).sort(), louisLeads, '"My leads" for Louis');
assert.ok(dash.leads.filter((l) => teamMatch(l.next_action.assigned_user_id, 'admin')).every((l) => l.next_action.assigned_user_id === 'admin'));
// Search finds any lead whoever owns it, by name, agency, phone or email.
for (const q of ['Old Two', 'Bob Old', '01277 700002', 'bob@old2.test']) {
  res = await request('GET', 'lead-search', { cookie: JOE, query: { q } });
  const hit = (res.body.results || res.body.leads || []).find((r) => r.agency_id === 'ag_old2');
  assert.ok(hit, `search "${q}" finds Louis's lead`); assert.equal(hit.owner_user_id, louisId);
}
ok('7-8. Actions by Joe = only Joe-assigned actions; Leads by Louis = exactly his leads; "My leads" works; search ignores ownership');

// ── race: two people claim the same unassigned lead at the same moment ─────
const joeUser = { user_id: 'admin', display_name: 'Joe' };
const louisUser = { user_id: louisId, display_name: 'Louis' };
const [a, b] = await Promise.all([
  claimLeadIfUnassigned(repo, { agencyId: 'ag_n3', user: joeUser, source: 'call' }),
  claimLeadIfUnassigned(repo, { agencyId: 'ag_n3', user: louisUser, source: 'call' }),
]);
assert.equal([a.claimed, b.claimed].filter(Boolean).length, 1, 'exactly one claim wins');
assert.equal(a.owner_user_id, b.owner_user_id, 'both callers see the same winner');
assert.equal(await ownerOf('ag_n3'), a.owner_user_id);
const winner = a.owner_user_id;
await claimLeadIfUnassigned(repo, { agencyId: 'ag_n3', user: winner === 'admin' ? louisUser : joeUser, source: 'call' });
assert.equal(await ownerOf('ag_n3'), winner, 'a later claim never overwrites');
ok('simultaneous claims: both rows may land, the first in sheet order wins, nobody is overwritten');

// ── persistence, machine clients, background jobs ──────────────────────────
const freshRepo = createRepo(api); // a cold instance / new deployment
assert.deepEqual([...(await ownersNow(freshRepo)).entries()].map(([k, v]) => [k, v.user_id]).sort(), [...(await ownersNow()).entries()].map(([k, v]) => [k, v.user_id]).sort());
assert.deepEqual(LEAD_OWNERSHIP_HEADER, store.LEAD_OWNERSHIP[0]);
const ledger = JSON.stringify(store.LEAD_OWNERSHIP);
await reconcileActionEngine(repo);
res = await request('POST', 'operator-actions-reconcile', { cookie: JOE, body: { confirm: 'RECONCILE_ACTIONS' } });
assert.equal(JSON.stringify(store.LEAD_OWNERSHIP), ledger, 'reconciliation never touches ownership');
store.AGENCIES[3][1] = 'Old Three Sales Ltd'; // an import rewriting an AGENCIES row
assert.equal(await ownerOf('ag_old3'), 'admin', 'AGENCIES rewrites cannot erase ownership');
res = await request('POST', 'calling-save', { headers: { authorization: 'Basic ' + Buffer.from('novus:admin-env-pass').toString('base64'), 'x-novus-client': 'worker' }, body: { confirm: 'SAVE_CALL', client_key: 'w-1', agency_id: 'ag_n4', call_mode: 'MANUAL', outcome: 'NO_ANSWER' } });
assert.equal(res.statusCode, 201, `worker call saved: ${JSON.stringify(res.body)}`);
assert.equal(await ownerOf('ag_n4'), '', 'the Playwright worker never claims');
ok('ownership survives a cold instance; reconciliation and AGENCIES rewrites never change it; machine clients never claim');

// Calls keep who made them.
const callBy = (key) => metaOf(Object.fromEntries(CALLS_HEADER.map((k, i) => [k, store.CALLS.find((r) => r[CALLS_HEADER.indexOf('client_key')] === key)[i]]))).user_id;
assert.equal(callBy('j-1'), 'admin'); assert.equal(callBy('l-2'), louisId);

// ── 9. delete Louis ─────────────────────────────────────────────────────────
dash = await dashboard(JOE);
res = await request('GET', 'team-user-delete-preview', { cookie: JOE, query: { user_id: louisId } });
assert.equal(res.statusCode, 200, JSON.stringify(res.body));
// A legacy lead-pool SORT_LEAD row is nobody's workload.
const workloadBefore = res.body.open_actions;
store.ACTIONS.push(rowFor(ACTIONS_HEADER, { action_id: 'act_sort', agency_id: 'ag_n2', action_type: 'SORT_LEAD', action_owner: 'JOE', action_status: 'DUE', due_at: iso(T0 - DAY), reason: 'legacy', source_stage: 'LEAD_POOL', dedupe_key: 'ag_n2:SORT_LEAD:legacy', created_at: iso(T0 - DAY), updated_at: iso(T0 - DAY), metadata_json: JSON.stringify({ assigned_user_id: louisId }) }));
res = await request('GET', 'team-user-delete-preview', { cookie: JOE, query: { user_id: louisId } });
assert.equal(res.body.open_actions, workloadBefore, 'SORT_LEAD excluded from workload');
dash = await dashboard(JOE);
assert.ok(dash.leads.every((l) => l.next_action.type !== 'SORT_LEAD'), 'never an Actions-page row');
assert.ok(!/label:'Sort leads'|key:'sortleads'|needs_sort|sortLeadActions/.test(page), 'no Sort-leads tab on the Actions page');
const rowsBeforeReconcile = store.ACTIONS.length;
const rec = await request('POST', 'operator-actions-reconcile', { cookie: JOE, body: { confirm: 'RECONCILE_ACTIONS' } });
assert.equal(rec.body.cancelled_by_type?.SORT_LEAD, 1, JSON.stringify(rec.body));
assert.equal(actionRow('act_sort').action_status, 'CANCELLED'); assert.equal(store.ACTIONS.length, rowsBeforeReconcile, 'cancelled, not deleted');
assert.ok(!store.ACTIONS.slice(rowsBeforeReconcile).length && !store.ACTIONS.some((r) => r[ACTIONS_HEADER.indexOf('action_type')] === 'SORT_LEAD' && r[ACTIONS_HEADER.indexOf('action_status')] !== 'CANCELLED'), 'none recreated');
const louisOwned = [...(await ownersNow()).entries()].filter(([, o]) => o.user_id === louisId).length;
assert.equal(res.body.owned_leads, louisOwned);
assert.ok(res.body.open_actions >= 2, `open actions ${res.body.open_actions}`);
assert.ok(res.body.transfer_targets.some((u) => u.user_id === 'admin'));
assert.equal((await request('POST', 'team-user-delete', { cookie: LOUIS, body: { confirm: 'DELETE_USER', user_id: louisId } })).statusCode, 403);
assert.equal((await request('POST', 'team-user-delete', { cookie: JOE, body: { confirm: 'DELETE_USER', user_id: 'admin' } })).statusCode, 400, 'env admin cannot be deleted');
// Last-administrator guard: Louis promoted, env admin gone → he cannot delete himself.
await request('POST', 'team-user-role', { cookie: JOE, body: { confirm: 'CHANGE_USER_ROLE', user_id: louisId, role: 'ADMIN' } });
LOUIS = await login('louis', louisPass);
const pass = process.env.NOVUS_BASIC_AUTH_PASS; delete process.env.NOVUS_BASIC_AUTH_PASS; invalidateUsersCache();
res = await request('POST', 'team-user-delete', { cookie: LOUIS, body: { confirm: 'DELETE_USER', user_id: louisId } });
assert.equal(res.statusCode, 409, JSON.stringify(res.body));
process.env.NOVUS_BASIC_AUTH_PASS = pass; invalidateUsersCache();
const callsBefore = JSON.stringify(store.CALLS); const actionCount = store.ACTIONS.length;
res = await request('POST', 'team-user-delete', { cookie: JOE, body: { confirm: 'DELETE_USER', user_id: louisId, transfer_to: 'admin' } });
assert.equal(res.statusCode, 200, JSON.stringify(res.body));
assert.equal(res.body.leads_transferred, louisOwned);
assert.equal((await ownersNow()).size, [...(await ownersNow()).values()].filter((o) => o.user_id === 'admin').length, 'every owned lead is now Joe\'s');
assert.equal(metaOf(actionRow('act_louis')).assigned_user_id, 'admin', 'his explicit actions moved');
assert.equal(JSON.stringify(store.CALLS), callsBefore, 'calls untouched'); assert.equal(store.ACTIONS.length, actionCount, 'no action deleted');
assert.equal(callBy('l-2'), louisId, 'his calls still say he made them');
const louisRow = store.USERS.find((r) => r[0] === louisId);
assert.equal(louisRow[USERS_HEADER.indexOf('status')], 'DELETED', 'archived, not removed');
assert.equal((await request('GET', 'whoami', { cookie: LOUIS })).statusCode, 401, 'sessions ended');
assert.equal((await request('POST', 'auth-login', { body: { username: 'louis', password: louisPass } })).statusCode, 401, 'cannot sign in');
assert.equal((await request('POST', 'team-user-status', { cookie: JOE, body: { confirm: 'SET_USER_STATUS', user_id: louisId, status: 'ACTIVE' } })).statusCode, 409, 'cannot be quietly re-enabled');
res = await request('GET', 'team-roster', { cookie: JOE });
assert.ok(!res.body.members.some((u) => u.user_id === louisId)); assert.ok(res.body.archived.some((u) => u.user_id === louisId && u.display_name === 'Louis'));
const hist = (await request('GET', 'lead-timeline', { cookie: JOE, query: { agency_id: 'ag_n1' } })).body.entries;
assert.ok(hist.some((e) => e.kind === 'call' && /by Louis/.test(e.detail)), 'history still names Louis');
assert.ok(hist.some((e) => e.type === 'OWNER_ASSIGN' && e.from_user_id === louisId && /removed from the team/.test(e.reason)));
res = await request('POST', 'team-user-delete', { cookie: JOE, body: { confirm: 'DELETE_USER', user_id: louisId, transfer_to: 'admin' } });
assert.equal(res.statusCode, 200); assert.equal(res.body.leads_transferred, 0, 're-running is safe');
ok('9. deleting Louis: preview counts, admin-only, last-admin guard, archive not delete, every lead/open action to Joe, history keeps his name, re-runnable');

// ── migration attribution rules, pure ───────────────────────────────────────
{
  const { planOwnershipMigration } = await import('../lib/ownership-handlers.mjs');
  const A = (id) => ({ agency_id: id });
  const plan = planOwnershipMigration({
    agencies: ['a_tie', 'a_undated', 'a_email_late', 'a_email_early', 'a_meet', 'a_unknown', 'a_inbound_only_ambig'].map(A),
    ownershipTable: { header: [], rows: [] }, actionsTable: { header: [...ACTIONS_HEADER], rows: [] },
    roster: [{ user_id: 'admin' }, { user_id: 'usr_l' }, { user_id: 'usr_p' }],
    users: [{ user_id: 'usr_l', role: 'SETTER', created_at: iso(T0 - 20 * DAY) }, { user_id: 'usr_p', role: 'ADMIN', created_at: iso(T0 - 20 * DAY) }],
    audit: [{ audit_id: 'a1', to_role: 'ADMIN', target_user_id: 'usr_p', at: iso(T0 - 10 * DAY) }],
    calls: [
      { call_id: 'c1', agency_id: 'a_tie', outcome: 'NO_ANSWER', started_at: iso(T0 - DAY), metadata_json: JSON.stringify({ user_id: 'admin' }) },
      { call_id: 'c2', agency_id: 'a_tie', outcome: 'NO_ANSWER', started_at: iso(T0 - DAY), metadata_json: JSON.stringify({ user_id: 'usr_l' }) },
      { call_id: 'c3', agency_id: 'a_undated', outcome: 'NO_ANSWER', started_at: '', metadata_json: JSON.stringify({ user_id: 'usr_l' }) },
      { call_id: 'c4', agency_id: 'a_unknown', outcome: 'NO_ANSWER', started_at: iso(T0 - DAY), metadata_json: JSON.stringify({ user_id: 'usr_gone' }) },
      { call_id: 'c5', agency_id: 'a_email_early', outcome: '', started_at: iso(T0 - 30 * DAY), metadata_json: '{}' }, // never logged: not an interaction
    ],
    salesMessages: [
      { sales_message_id: 's1', agency_id: 'a_email_late', message_type: 'MANUAL_REPLY', send_outcome: 'SENT', sent_by: 'joe', sent_at: iso(T0 - 5 * DAY) },
      { sales_message_id: 's2', agency_id: 'a_email_early', message_type: 'MANUAL_REPLY', send_outcome: 'SENT', sent_by: 'joe', sent_at: iso(T0 - 15 * DAY) },
      { sales_message_id: 's3', agency_id: 'a_meet', message_type: 'MANUAL_REPLY', send_outcome: 'FAILED', sent_by: 'joe', sent_at: iso(T0 - 25 * DAY) },
    ],
    discoverySessions: [{ session_id: 'd1', agency_id: 'a_meet', completed_at: iso(T0 - 12 * DAY) }],
  });
  assert.deepEqual(plan.leads.map((l) => [l.agency_id, l.to_user_id, l.basis]), [['a_email_early', 'admin', 'first email'], ['a_meet', 'admin', 'first meeting']]);
  assert.deepEqual(Object.fromEntries(plan.unassigned.map((u) => [u.agency_id, u.reason])), {
    a_tie: 'ambiguous: two people at the same moment', a_undated: 'ambiguous: undated interaction',
    a_email_late: 'ambiguous: first email has no reliable author', a_unknown: 'ambiguous: first call has no reliable author',
    a_inbound_only_ambig: 'never contacted',
  });
}
ok('migration attribution: legacy "joe" email is Joe\'s only before another admin existed; ties, undated or unknown authors stay unassigned; failed sends and unlogged dials are not interactions');

console.log(`\nNOVUS team ownership self-test passed (${passed} checks).`);
process.exit(0);
