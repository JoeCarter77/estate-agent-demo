#!/usr/bin/env node
// scripts/novus-role-change-selftest.mjs — hermetic test of Team → Change role
// (team-user-role, lib/team-handlers.mjs): promotion SETTER → ADMIN and
// demotion ADMIN → SETTER, server-side authorisation, the last-admin guard,
// the USERS_AUDIT record, session revocation, preserved history — and the
// PERMISSION PARITY MATRIX: a promoted admin must get exactly the env admin's
// response from every router operation, every other NOVUS function and every
// /novus page. No network (fetch is stubbed to fail), no real credentials.
//
// Run:  npm run novus:role-change-selftest

import assert from 'node:assert/strict';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { CALLS_HEADER, rowFor } from '../lib/calling-store.mjs';
import { USERS_HEADER, USERS_AUDIT_HEADER, SETTER_OPERATIONS, metaOf, invalidateUsersCache } from '../lib/novus-users.mjs';
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

const T0 = Date.parse('2026-10-15T10:00:00.000Z');
let NOW = T0;
const RealDate = Date;
globalThis.Date = class FixedDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
};
const iso = (ms) => new Date(ms).toISOString();
const DAY = 86_400_000;
const HOST = 'novus.test';

const AG = ['agency_id', 'clean_agency_name', 'main_phone', 'outreach_contact_name', 'current_pipeline_status', 'updated_at'];
const { store, repo } = makeStore({
  AGENCIES: [AG, ['ag_cold', 'Cold One', '01277 781030', 'Ann Cold', '', ''], ['ag_cold2', 'Cold Two', '01277 781031', 'Bob Cold', '', '']],
  PROBES: [['probe_id', 'agency_id', 'probe_status', 'probe_timestamp'], ['pr_1', 'ag_cold', 'CLOSED', iso(T0 - 10 * DAY)], ['pr_2', 'ag_cold2', 'CLOSED', iso(T0 - 9 * DAY)]],
  REPLY_EVENTS: [['reply_event_id', 'agency_id', 'classification', 'received_at', 'suppression_type']],
});
__setRepoForTests(repo);
const kv = createMemoryKv({ now: () => NOW });
__setKvForTests(kv);
process.env.NOVUS_BASIC_AUTH_USER = 'novus';
process.env.NOVUS_BASIC_AUTH_PASS = 'admin-env-pass';
process.env.NOVUS_SESSION_SECRET = 'test-session-secret-0123456789-abcdefghij';
process.env.NOVUS_ADMIN_DISPLAY_NAME = 'Joe';
const { default: handler } = await import('../api/novus/personalisation.js');
const { default: probeHandler } = await import('../api/novus/probe.js');
const { default: rebuildHandler } = await import('../api/novus/intelligence/rebuild-all.js');
const { default: leadHandler } = await import('../api/lead.js');
const { default: demoHandler } = await import('../api/demo.js');

const basicOf = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const ADMIN_BASIC = basicOf('novus', 'admin-env-pass');
const response = () => ({ statusCode: 200, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; }, end() { return this; }, setHeader(k, v) { this.headers[k] = v; }, write() {}, writeHead(c) { this.statusCode = c; return this; } });
async function request(method, operation, { body, query = {}, cookie = '', auth = '', origin = `https://${HOST}` } = {}) {
  const headers = { host: HOST, 'sec-fetch-mode': 'cors' };
  if (cookie) headers.cookie = cookie;
  if (auth) headers.authorization = auth;
  if (method !== 'GET' && origin) headers.origin = origin;
  const res = response();
  await handler({ method, query: { novus_operation: operation, ...query }, headers, body }, res);
  return res;
}
const cookieOf = (res) => String(res.headers['Set-Cookie'] || '').split(';')[0];
async function login(username, password) {
  const res = await request('POST', 'auth-login', { body: { username, password } });
  return { res, cookie: cookieOf(res) };
}
const callMeta = (callId) => metaOf({ metadata_json: store.CALLS.find((row) => row[0] === callId)[CALLS_HEADER.indexOf('metadata_json')] });
const roleOf = (userId) => store.USERS.find((row) => row[0] === userId)?.[USERS_HEADER.indexOf('role')];
const changeRole = (cookie, user_id, role, confirm = 'CHANGE_USER_ROLE') => request('POST', 'team-user-role', { cookie, body: { confirm, user_id, role } });

// ── 1. the existing setup: Joe (env admin, username novus) + Louis (SETTER) ─
const JOE = (await login('novus', 'admin-env-pass')).cookie;
let res = await request('POST', 'calling-setup', { cookie: JOE, body: { confirm: 'SETUP_CALLING_TABS' } });
assert.equal(res.statusCode, 200, JSON.stringify(res.body));
res = await request('POST', 'team-user-create', { cookie: JOE, body: { confirm: 'CREATE_USER', display_name: 'Louis Greenwood', username: 'louis.g' } });
assert.equal(res.statusCode, 201);
const louisPass = res.body.one_time_password; const louisId = res.body.user.user_id;
NOW += 1000;
let LOUIS = (await login('louis.g', louisPass)).cookie;
res = await request('POST', 'calling-save', { cookie: LOUIS, body: { confirm: 'SAVE_CALL', client_key: 'lk-1', agency_id: 'ag_cold2', call_mode: 'MANUAL', outcome: 'BOOKED_MEETING', meeting_at: iso(T0 + 3 * DAY) } });
assert.equal(res.statusCode, 201, JSON.stringify(res.body));
const louisCallId = res.body.call.call_id;
const callsBefore = JSON.stringify(store.CALLS);
const louisRowBefore = store.USERS.find((row) => row[0] === louisId).slice();
const activityBefore = (await request('GET', 'team-users', { cookie: JOE })).body.users.find((u) => u.user_id === louisId).activity;
assert.equal(activityBefore.meetings_total, 1);

// ── 2. authorisation: only an admin may change a role, server-side ──────────
const usersSnapshot = JSON.stringify(store.USERS);
assert.equal((await changeRole(LOUIS, louisId, 'ADMIN')).statusCode, 403, 'a setter cannot promote himself');
assert.ok(!SETTER_OPERATIONS.has('team-user-role'));
assert.equal((await changeRole('', louisId, 'ADMIN')).statusCode, 401, 'signed out → 401');
res = await request('POST', 'team-user-role', { cookie: JOE, body: { confirm: 'CHANGE_USER_ROLE', user_id: louisId, role: 'ADMIN' }, origin: 'https://evil.example' });
assert.equal(res.statusCode, 403, 'CSRF: cross-origin write with the admin cookie refused');
assert.equal((await changeRole(JOE, louisId, 'ADMIN', 'x')).statusCode, 400, 'explicit confirm token required');
assert.equal((await changeRole(JOE, louisId, 'OWNER')).statusCode, 400, 'unknown role refused');
assert.equal((await changeRole(JOE, 'admin', 'SETTER')).statusCode, 400, 'the env admin is not managed here');
assert.equal((await changeRole(JOE, 'usr_nope', 'ADMIN')).statusCode, 404);
assert.equal((await changeRole(JOE, louisId, 'SETTER')).statusCode, 409, 'no-op change refused');
assert.equal(JSON.stringify(store.USERS), usersSnapshot, 'no refused request wrote anything');
assert.ok(!('USERS_AUDIT' in store));
// Session store down → nothing changes (an old session must never outlive a role change).
__setKvForTests({ command: async () => { throw new Error('down'); } });
assert.equal((await request('POST', 'team-user-role', { auth: ADMIN_BASIC, body: { confirm: 'CHANGE_USER_ROLE', user_id: louisId, role: 'ADMIN' } })).statusCode, 503);
__setKvForTests(kv);
assert.equal(roleOf(louisId), 'SETTER');
ok('role changes are admin-only on the server: setter 403, signed-out 401, CSRF 403, confirm token, env admin immutable; session store down → no change');

// ── 3. promote Louis ────────────────────────────────────────────────────────
const LOUIS_PHONE = (await login('louis.g', louisPass)).cookie; // a second device
NOW += 1000;
res = await changeRole(JOE, louisId, 'ADMIN');
assert.equal(res.statusCode, 200, JSON.stringify(res.body));
assert.equal(res.body.user.role, 'ADMIN'); assert.equal(res.body.from_role, 'SETTER'); assert.equal(res.body.sessions_revoked, 2);
assert.equal(roleOf(louisId), 'ADMIN');
// Only role + updated_at changed on his row; nothing else anywhere.
const louisRowAfter = store.USERS.find((row) => row[0] === louisId);
USERS_HEADER.forEach((col, i) => { if (!['role', 'updated_at'].includes(col)) assert.equal(louisRowAfter[i], louisRowBefore[i], col); });
assert.equal(store.USERS.filter((row) => row[1] === 'louis.g').length, 1, 'no duplicate account');
assert.equal(JSON.stringify(store.CALLS), callsBefore, 'calls untouched');
// Audit.
assert.deepEqual(store.USERS_AUDIT[0], USERS_AUDIT_HEADER.slice());
const audit = Object.fromEntries(USERS_AUDIT_HEADER.map((k, i) => [k, store.USERS_AUDIT[2][i]]));
assert.equal(audit.action, 'ROLE_CHANGE'); assert.equal(audit.actor_user_id, 'admin'); assert.equal(audit.actor_username, 'novus');
assert.equal(audit.target_user_id, louisId); assert.equal(audit.target_username, 'louis.g');
assert.equal(audit.from_role, 'SETTER'); assert.equal(audit.to_role, 'ADMIN'); assert.equal(audit.at, iso(NOW));
// His setter sessions are ended; he signs in again and is an admin.
assert.equal((await request('GET', 'whoami', { cookie: LOUIS })).statusCode, 401, 'old setter session ended');
assert.equal((await request('GET', 'whoami', { cookie: LOUIS_PHONE })).statusCode, 401, 'on every device');
let r = await login('louis.g', louisPass);
assert.equal(r.res.statusCode, 200, JSON.stringify(r.res.body));
assert.equal(r.res.body.user.role, 'ADMIN'); assert.equal(r.res.body.redirect, '/novus/priorities.html', 'lands where Joe lands');
LOUIS = r.cookie;
res = await request('GET', 'whoami', { cookie: LOUIS });
assert.equal(res.body.user.role, 'ADMIN'); assert.equal(res.body.user.user_id, louisId, 'he acts as himself, not as Joe');
assert.equal(res.body.user.username, 'louis.g');
assert.equal((await request('GET', 'whoami', { cookie: JOE })).statusCode, 200, 'Joe unaffected');
// History stays his.
const team = (await request('GET', 'team-users', { cookie: LOUIS })).body.users;
assert.deepEqual(team.find((u) => u.user_id === louisId).activity, activityBefore, 'performance statistics preserved');
assert.equal(callMeta(louisCallId).user_id, louisId);
ok('Joe promotes louis.g: one row, role + updated_at only, audited (who/whom/from/to/when), every setter session ended, he signs in as ADMIN as himself with his history intact');

// ── 4. PERMISSION PARITY: Joe vs promoted Louis, every operation ────────────
// Each operation runs for Joe and for Louis from the SAME store state (reset
// between calls) with the network stubbed to fail fast. The response status
// and error must be identical, and neither may be refused for its account.
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('network disabled in selftest'); };
const source = (await import('node:fs')).readFileSync(new URL('../api/novus/personalisation.js', import.meta.url), 'utf8');
const ops = [...new Set([...source.matchAll(/novus_operation === '([a-z0-9-]+)'|'([a-z0-9-]+)': handle[A-Za-z]+/g)].map((m) => m[1] || m[2]))]
  .filter((op) => !['auth-login', 'auth-logout', 'instantly-webhook', 'team-user-role'].includes(op) && !op.startsWith('twilio-voice'));
assert.ok(ops.length > 80, `found ${ops.length} operations`);
const SECRET_GUARDED = /poller secret/i;
const snapshotStore = () => structuredClone(store);
const restoreStore = (snap) => { for (const k of Object.keys(store)) if (!(k in snap)) delete store[k]; Object.assign(store, structuredClone(snap)); };
res = await request('POST', 'team-user-create', { cookie: JOE, body: { confirm: 'CREATE_USER', display_name: 'Control Setter', username: 'ctrl' } });
const CTRL = (await login('ctrl', res.body.one_time_password)).cookie;
let refusedForSetter = 0;
let compared = 0;
const statuses = {};
for (const op of ['', ...ops]) {
  for (const method of ['GET', 'POST']) {
    const snap = snapshotStore();
    const body = { confirm: 'x', agency_id: 'ag_cold', user_id: 'usr_none' };
    const query = { agency_id: 'ag_cold' };
    invalidateUsersCache();
    const a = await request(method, op, { cookie: JOE, body: structuredClone(body), query });
    restoreStore(snap); invalidateUsersCache();
    const b = await request(method, op, { cookie: LOUIS, body: structuredClone(body), query });
    restoreStore(snap); invalidateUsersCache();
    const c = await request(method, op, { cookie: CTRL, body: structuredClone(body), query });
    restoreStore(snap);
    if (!SETTER_OPERATIONS.has(op)) { assert.equal(c.statusCode, 403, `${method} ${op}: setter control got ${c.statusCode}`); refusedForSetter += 1; }
    const label = `${method} ${op || '(none)'}`;
    assert.equal(b.statusCode, a.statusCode, `${label}: Joe ${a.statusCode} vs Louis ${b.statusCode} ${JSON.stringify(b.body)?.slice(0, 200)}`);
    assert.equal(b.body?.error, a.body?.error, `${label}: different error`);
    if (!SECRET_GUARDED.test(String(a.body?.error || ''))) {
      assert.ok(![401, 403].includes(b.statusCode), `${label}: promoted admin refused (${b.statusCode} ${b.body?.error})`);
    }
    compared += 1;
    statuses[a.statusCode] = (statuses[a.statusCode] || 0) + 1;
  }
}
// Negative control: the same matrix must refuse a SETTER everywhere outside
// SETTER_OPERATIONS — so it does discriminate, and both admins passed the gate.
assert.ok(refusedForSetter > 100, `setter refused on ${refusedForSetter} pairs`);
// The other NOVUS functions.
const fn = async (h, method, cookie, { query = {}, body = {} } = {}) => { const rr = response(); await h({ method, query, headers: { host: HOST, cookie, 'sec-fetch-mode': 'cors', origin: `https://${HOST}` }, body }, rr); return rr; };
for (const [name, h, calls] of [
  ['probe', probeHandler, [['GET', {}], ['POST', { body: { action: 'none' } }]]],
  ['rebuild-all', rebuildHandler, [['GET', {}], ['POST', {}]]],
  ['lead', leadHandler, [['GET', { query: { call_context: '1', agency_id: 'ag_cold' } }]]],
  ['demo', demoHandler, [['POST', { body: { action: 'build' } }]]],
]) {
  for (const [method, opts] of calls) {
    const snap = snapshotStore();
    const a = await fn(h, method, JOE, opts); restoreStore(snap);
    const b = await fn(h, method, LOUIS, opts); restoreStore(snap);
    assert.equal(b.statusCode, a.statusCode, `${name} ${method}`);
    assert.ok(![401, 403].includes(b.statusCode), `${name} ${method}: ${b.statusCode}`);
    compared += 1;
  }
}
globalThis.fetch = realFetch;
ok(`permission parity: Joe and promoted Louis get identical responses from ${compared} operation/method pairs (post-gate statuses ${JSON.stringify(statuses)}); a setter control is refused on ${refusedForSetter} of the same calls (every router operation plus probe, rebuild-all, lead, demo); neither refused`);

// ── 5. pages and the Edge middleware ────────────────────────────────────────
process.env.KV_REST_API_URL = 'https://kv.test'; process.env.KV_REST_API_TOKEN = 'kvtok';
const { default: middleware } = await import('../middleware.js');
globalThis.fetch = async (url, init) => new Response(JSON.stringify({ result: await kv.command(JSON.parse(init.body)) }), { status: 200 });
const mw = (path, cookie) => middleware({ url: `https://${HOST}${path}`, method: 'GET', headers: new Headers(cookie ? { cookie } : {}) });
const PAGES = ['/novus', '/novus/operator.html', '/novus/campaigns.html', '/novus/calling.html', '/novus/meetings.html', '/novus/probe.html', '/novus/communications.html'];
const APIS = ['/api/novus/probe', '/api/novus/intelligence/rebuild-all', '/api/novus/personalisation'];
for (const path of [...PAGES, ...APIS]) {
  assert.equal(await mw(path, JOE), undefined, `Joe ${path}`);
  assert.equal(await mw(path, LOUIS), undefined, `Louis ${path}`);
}
ok(`middleware: promoted Louis passes exactly where Joe does (${PAGES.length} pages, ${APIS.length} function paths)`);

// ── 6. a promoted admin manages the team exactly like Joe ───────────────────
res = await request('POST', 'team-user-create', { cookie: LOUIS, body: { confirm: 'CREATE_USER', display_name: 'Sam', username: 'sam' } });
assert.equal(res.statusCode, 201);
const samId = res.body.user.user_id;
res = await changeRole(LOUIS, samId, 'ADMIN');
assert.equal(res.statusCode, 200);
let last = Object.fromEntries(USERS_AUDIT_HEADER.map((k, i) => [k, store.USERS_AUDIT.at(-1)[i]]));
assert.equal(last.actor_user_id, louisId); assert.equal(last.actor_username, 'louis.g'); assert.equal(last.target_username, 'sam');
assert.equal((await changeRole(LOUIS, samId, 'SETTER')).statusCode, 200);
ok('Louis (promoted) creates an account and changes its role; the audit names him as the actor');

// ── 7. the last active administrator ────────────────────────────────────────
// With the env credential present there is always at least one admin. Without
// it, the last ADMIN row can be neither demoted nor disabled.
delete process.env.NOVUS_BASIC_AUTH_PASS;
res = await changeRole(LOUIS, louisId, 'SETTER');
assert.equal(res.statusCode, 409); assert.match(res.body.error, /last active administrator/);
res = await request('POST', 'team-user-status', { cookie: LOUIS, body: { confirm: 'SET_USER_STATUS', user_id: louisId, status: 'DISABLED' } });
assert.equal(res.statusCode, 409);
assert.equal(roleOf(louisId), 'ADMIN');
assert.equal((await changeRole(LOUIS, samId, 'ADMIN')).statusCode, 200);
assert.equal((await changeRole(LOUIS, louisId, 'SETTER')).statusCode, 200, 'with another admin, demotion is allowed');
process.env.NOVUS_BASIC_AUTH_PASS = 'admin-env-pass';
assert.equal((await changeRole(JOE, samId, 'SETTER')).statusCode, 200);
assert.equal((await changeRole(JOE, louisId, 'ADMIN')).statusCode, 200);
LOUIS = (await login('louis.g', louisPass)).cookie;
ok('the last active administrator can be neither demoted nor disabled');

// ── 8. demote Louis: no elevated privilege survives ─────────────────────────
const LOUIS_ADMIN_2 = (await login('louis.g', louisPass)).cookie;
res = await changeRole(JOE, louisId, 'SETTER');
assert.equal(res.statusCode, 200); assert.equal(res.body.sessions_revoked, 2);
last = Object.fromEntries(USERS_AUDIT_HEADER.map((k, i) => [k, store.USERS_AUDIT.at(-1)[i]]));
assert.equal(last.from_role, 'ADMIN'); assert.equal(last.to_role, 'SETTER'); assert.equal(last.actor_username, 'novus');
for (const c of [LOUIS, LOUIS_ADMIN_2]) {
  assert.equal((await request('GET', 'team-users', { cookie: c })).statusCode, 401, 'old admin session refused by the function');
  assert.equal((await mw('/api/novus/probe', c)).status, 401, 'and by the middleware for every other function');
  assert.equal((await mw('/novus/operator.html', c)).status, 302);
}
// Backstop: even if his ADMIN session record survived, the USERS re-check refuses it.
r = await login('louis.g', louisPass);
assert.equal(r.res.body.user.role, 'SETTER'); assert.equal(r.res.body.redirect, '/novus/priorities.html');
LOUIS = r.cookie;
assert.equal((await request('GET', 'team-users', { cookie: LOUIS })).statusCode, 403, 'setter restrictions back in force');
assert.equal((await mw('/novus/operator.html', LOUIS)).status, 302);
assert.equal((await mw('/api/novus/probe', LOUIS)).status, 403);
const forged = (await import('../lib/auth-session.mjs'));
{
  const [body] = LOUIS.split('=')[1].split('.');
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  const elevated = forged.signSessionToken({ ...p, role: 'ADMIN' }, process.env.NOVUS_SESSION_SECRET);
  await kv.command(['SET', `novus:auth:s:${p.sid}`, JSON.stringify({ uid: p.uid, role: 'ADMIN', last_seen: NOW }), 'EX', 3600]);
  assert.equal((await request('GET', 'team-users', { cookie: `novus_session=${elevated}` })).statusCode, 401, 'an ADMIN session for a SETTER row is refused even with a matching record');
}
assert.equal(callMeta(louisCallId).user_id, louisId, 'his calls are still his');
assert.equal(store.USERS_AUDIT.length - 2, 8, 'every role change audited');
ok('Joe demotes Louis: both admin sessions end at once (function + middleware), he signs back in as SETTER confined to Calling, his history is kept');

globalThis.fetch = realFetch;
__setRepoForTests(null);
console.log(`\nnovus role-change selftest: ${passed} checks passed`);
