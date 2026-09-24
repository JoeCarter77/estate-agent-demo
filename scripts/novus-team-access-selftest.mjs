#!/usr/bin/env node
// scripts/novus-team-access-selftest.mjs — hermetic test of NOVUS sign-in and
// individual accounts: the login page's server side (lib/auth-session.mjs),
// the admin machine credential, SETTER confinement on the server (direct API
// requests included), logout, idle and absolute expiry, revocation on
// disable/reset, login rate limiting, CSRF, and the Edge middleware.
// No network, no real credentials, no Twilio.
//
// Run:  npm run novus:team-access-selftest

import assert from 'node:assert/strict';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { ACTIONS_HEADER } from '../lib/actions-store.mjs';
import { CALLS_HEADER, rowFor } from '../lib/calling-store.mjs';
import { hashPassword, verifyPassword, SETTER_OPERATIONS, USERS_HEADER, metaOf, invalidateUsersCache } from '../lib/novus-users.mjs';
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

// One controllable clock for Date, the session store and the tokens.
const T0 = Date.parse('2026-09-14T10:00:00.000Z');
let NOW = T0;
const RealDate = Date;
globalThis.Date = class FixedDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
};
const iso = (ms) => new Date(ms).toISOString();
const DAY = 86_400_000;
const HOST = 'novus.test';

// ── 1. hashing ─────────────────────────────────────────────────────────────
{
  const h = hashPassword('correct horse');
  assert.match(h, /^scrypt\$16384\$8\$1\$/);
  assert.ok(!h.includes('correct horse'));
  assert.equal(verifyPassword('correct horse', h), true);
  assert.equal(verifyPassword('wrong', h), false);
  assert.notEqual(hashPassword('correct horse'), h, 'salted');
  ok('passwords are stored only as salted scrypt hashes');
}

// ── fixture ────────────────────────────────────────────────────────────────
const actionRow = (o) => rowFor(ACTIONS_HEADER, { action_owner: 'JOE', action_status: 'DUE', reason: 'x', source_stage: 'CALL', dedupe_key: `k:${o.action_id}`, created_at: iso(T0 - DAY), updated_at: iso(T0 - DAY), ...o });
const AG = ['agency_id', 'clean_agency_name', 'main_phone', 'outreach_contact_name', 'current_pipeline_status', 'updated_at'];
const { store, repo } = makeStore({
  AGENCIES: [AG,
    ['ag_cold', 'Cold One', '01277 781030', 'Ann Cold', '', ''],
    ['ag_cold2', 'Cold Two', '01277 781031', 'Bob Cold', '', ''],
    ['ag_joe', 'Joe Callback Co', '01277 781032', 'Cat Joe', '', ''],
    ['ag_email', 'Email Reply Co', '01277 781033', 'Dan Email', '', '']],
  ACTIONS: [ACTIONS_HEADER.slice(), ACTIONS_HEADER.map((_, i) => (i === 0 ? 'SCHEMA NOTE' : '')),
    actionRow({ action_id: 'act_joe', agency_id: 'ag_joe', action_type: 'CALL_PROSPECT', due_at: iso(T0 - 60_000), metadata_json: JSON.stringify({ call_action: true, callback_reason: 'Joe promised a callback' }) }),
    actionRow({ action_id: 'act_email', agency_id: 'ag_email', action_type: 'CALL_PROSPECT', reply_event_id: 're_1', due_at: iso(T0 - 60_000), metadata_json: JSON.stringify({ source: 'EMAIL_REPLY', call_action: true, phone: { normalised: '+441277781033' } }) })],
  REPLY_EVENTS: [['reply_event_id', 'agency_id', 'classification', 'received_at', 'suppression_type']],
  PROBES: [['probe_id', 'agency_id', 'probe_status', 'probe_timestamp'],
    ['pr_1', 'ag_cold', 'CLOSED', iso(T0 - 10 * DAY)], ['pr_2', 'ag_cold2', 'CLOSED', iso(T0 - 9 * DAY)],
    ['pr_3', 'ag_joe', 'CLOSED', iso(T0 - 9 * DAY)], ['pr_4', 'ag_email', 'CLOSED', iso(T0 - 9 * DAY)]],
});
__setRepoForTests(repo);
const kv = createMemoryKv({ now: () => NOW });
__setKvForTests(kv);
process.env.NOVUS_BASIC_AUTH_USER = 'joe';
process.env.NOVUS_BASIC_AUTH_PASS = 'admin-env-pass';
process.env.NOVUS_SESSION_SECRET = 'test-session-secret-0123456789-abcdefghij';
const { default: handler } = await import('../api/novus/personalisation.js');
const { default: probeHandler } = await import('../api/novus/probe.js');
const { default: rebuildHandler } = await import('../api/novus/intelligence/rebuild-all.js');

const basicOf = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const ADMIN_BASIC = basicOf('joe', 'admin-env-pass');
const response = () => ({ statusCode: 200, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; }, end() { return this; }, setHeader(k, v) { this.headers[k] = v; } });
// A browser-like request: cookie, host, and Origin on writes.
async function request(method, operation, { body, query = {}, cookie = '', auth = '', origin = `https://${HOST}`, browser = true } = {}) {
  const headers = { host: HOST };
  if (cookie) headers.cookie = cookie;
  if (auth) headers.authorization = auth;
  if (browser) { headers['sec-fetch-mode'] = 'cors'; if (method !== 'GET' && origin) headers.origin = origin; }
  const res = response();
  await handler({ method, query: { novus_operation: operation, ...query }, headers, body }, res);
  return res;
}
const cookieOf = (res) => String(res.headers['Set-Cookie'] || '').split(';')[0];
async function login(username, password, next = '') {
  const res = await request('POST', 'auth-login', { body: { username, password, next } });
  return { res, cookie: cookieOf(res) };
}

// ── 2. the admin: machine credential unchanged, login page works ───────────
let res = await request('POST', 'calling-setup', { body: { confirm: 'SETUP_CALLING_TABS' }, auth: ADMIN_BASIC, browser: false });
assert.equal(res.statusCode, 200, 'the admin Basic machine credential still works (GitHub poller, worker)');
const legacyCall = rowFor(CALLS_HEADER, { call_id: 'cal_legacy', agency_id: 'ag_joe', attempt_number: 1, call_mode: 'MANUAL', started_at: iso(T0 - 2 * DAY), call_status: 'manual', outcome: 'NO_ANSWER', connected: 'FALSE', owner_reached: 'FALSE', pitched: 'FALSE', metadata_json: JSON.stringify({ followups: 'COMPLETE' }), created_at: iso(T0 - 2 * DAY), updated_at: iso(T0 - 2 * DAY) });
store.CALLS.push(legacyCall.slice());
const legacyActions = structuredClone(store.ACTIONS.slice(2));

res = await request('GET', 'whoami', { browser: false });
assert.equal(res.statusCode, 401); assert.match(res.headers['WWW-Authenticate'], /Basic/, 'a non-browser client still gets the challenge');
res = await request('GET', 'whoami');
assert.equal(res.statusCode, 401); assert.equal(res.headers['WWW-Authenticate'], undefined, 'a browser never gets the native password prompt');
assert.equal(res.body.login, '/novus/login.html');

let r = await login('joe', 'wrong');
assert.equal(r.res.statusCode, 401); assert.equal(r.res.body.error, 'Incorrect username or password.'); assert.ok(!r.res.headers['Set-Cookie']);
r = await login('nobody', 'wrong');
assert.equal(r.res.body.error, 'Incorrect username or password.', 'unknown users get the identical message');
r = await login('JOE', 'admin-env-pass', '/novus/campaigns.html#new');
assert.equal(r.res.statusCode, 200, JSON.stringify(r.res.body));
assert.equal(r.res.body.user.role, 'ADMIN'); assert.equal(r.res.body.redirect, '/novus/campaigns.html#new');
const setCookie = String(r.res.headers['Set-Cookie']);
for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=43200']) assert.ok(setCookie.includes(attr), attr);
assert.ok(!setCookie.includes('admin-env-pass'));
assert.equal((await login('joe', 'admin-env-pass', '//evil.example/x')).res.body.redirect, '/novus/operator.html', 'no open redirect');
res = await request('POST', 'auth-login', { body: { username: 'joe', password: 'admin-env-pass' }, origin: 'https://evil.example' });
assert.equal(res.statusCode, 403, 'cross-origin sign-in refused');
const ADMIN = (await login('joe', 'admin-env-pass')).cookie;
res = await request('GET', 'whoami', { cookie: ADMIN });
assert.equal(res.body.user.role, 'ADMIN');
ok('Joe signs in on the login page: HttpOnly/Secure/SameSite=Lax 12h cookie, no password in it, generic error on bad credentials, safe redirect; the admin Basic credential still serves machine clients; browsers never get the native prompt');

// ── 3. create Louis (admin, via the session) ───────────────────────────────
res = await request('POST', 'team-user-create', { cookie: ADMIN, body: { confirm: 'CREATE_USER', display_name: 'Louis', username: 'louis' }, origin: 'https://evil.example' });
assert.equal(res.statusCode, 403, 'CSRF: a cross-origin write with the admin cookie is refused');
assert.ok(!('USERS' in store));
res = await request('POST', 'team-user-create', { cookie: ADMIN, body: { confirm: 'CREATE_USER', display_name: 'Louis', username: 'louis' } });
assert.equal(res.statusCode, 201, JSON.stringify(res.body));
const louisPass = res.body.one_time_password; const louisId = res.body.user.user_id;
assert.ok(!JSON.stringify(store).includes(louisPass));
assert.deepEqual(store.USERS[0], USERS_HEADER.slice());
ok('the admin creates Louis from a signed-in session; a cross-origin forged request with the admin cookie writes nothing');

NOW += 400; // still the same wall-clock second as the account's creation
r = await login('louis', louisPass, '/novus/operator.html');
assert.equal(r.res.statusCode, 200);
assert.equal(r.res.body.redirect, '/novus/calling.html', 'a setter always lands in Calling Mode');
let LOUIS = r.cookie;
res = await request('GET', 'whoami', { cookie: LOUIS });
assert.equal(res.statusCode, 200, 'a sign-in in the same second as account creation is valid'); assert.equal(res.body.user.role, 'SETTER'); assert.equal(res.body.user.user_id, louisId);
res = await request('GET', 'whoami', { auth: basicOf('louis', louisPass), browser: false });
assert.equal(res.statusCode, 401, 'setter accounts have no Basic Auth path');
// A browser still caching the admin's Basic login must not turn Louis into the admin.
res = await request('GET', 'whoami', { cookie: LOUIS, auth: ADMIN_BASIC });
assert.equal(res.body.user.role, 'SETTER');
ok('Louis signs in independently and lands in Calling Mode; his session wins over any cached admin Basic credential');

// ── 4. his queue and his calls ─────────────────────────────────────────────
res = await request('GET', 'calling-workspace', { cookie: LOUIS, query: { refresh: '1' } });
assert.deepEqual(res.body.queue.map((l) => l.agency_id).sort(), ['ag_cold', 'ag_cold2']);
assert.deepEqual(res.body.call_actions, []);
res = await request('POST', 'calling-save', { cookie: LOUIS, body: { confirm: 'SAVE_CALL', client_key: 'lk-2', agency_id: 'ag_cold2', call_mode: 'MANUAL', outcome: 'BOOKED_MEETING', meeting_at: iso(T0 + 3 * DAY) } });
assert.equal(res.statusCode, 201, JSON.stringify(res.body));
assert.equal(metaOf(res.body.call).user_id, louisId);
ok('Louis sees his queue and his saved calls are attributed to him');

// ── 5. restricted functionality by direct request ──────────────────────────
const snapshot = JSON.stringify(store);
const FORBIDDEN = [
  ['POST', 'campaign-create'], ['POST', 'campaign-update'], ['POST', 'campaign-push'], ['POST', 'campaign-launch'], ['POST', 'campaign-delete'],
  ['GET', 'campaigns-list'], ['POST', 'script-save'], ['POST', 'script-status'], ['POST', 'objection-save'], ['POST', 'calling-setup'],
  ['POST', 'calling-repair'], ['GET', 'team-users'], ['POST', 'team-user-create'], ['POST', 'team-user-status'], ['POST', 'team-user-reset'],
  ['GET', 'operator-leads'], ['GET', 'operator-dashboard'], ['POST', 'operator-action-complete'], ['POST', 'operator-manual-reply'],
  ['GET', 'discovery-meetings'], ['POST', 'discovery-outcome'], ['POST', 'send-demo'], ['POST', 'verify-contact'],
  ['GET', 'instantly-replies-test'], ['GET', 'lead-timeline'], ['POST', 'call-session-correct'], ['POST', 'call-session-approve'], ['GET', ''],
];
for (const [method, op] of FORBIDDEN) {
  res = await request(method, op, { cookie: LOUIS, body: { confirm: 'x' }, query: { agency_id: 'ag_cold' } });
  assert.equal(res.statusCode, 403, `${method} ${op} → ${res.statusCode}`);
  assert.ok(!SETTER_OPERATIONS.has(op));
}
for (const h of [probeHandler, rebuildHandler]) {
  const rr = response();
  await h({ method: 'POST', query: {}, headers: { host: HOST, cookie: LOUIS, 'sec-fetch-mode': 'cors', origin: `https://${HOST}` }, body: {} }, rr);
  assert.equal(rr.statusCode, 401, 'other NOVUS functions are admin-only');
}
assert.equal(JSON.stringify(store), snapshot, 'no refused request wrote anything');
res = await request('POST', 'calling-save', { cookie: LOUIS, body: { confirm: 'SAVE_CALL', call_id: 'cal_legacy', agency_id: 'ag_joe', outcome: 'NO_ANSWER' } });
assert.equal(res.statusCode, 403);
assert.deepEqual(store.CALLS.find((row) => row[0] === 'cal_legacy'), legacyCall);
assert.deepEqual(store.ACTIONS.slice(2, 4), legacyActions);
ok(`Louis is refused ${FORBIDDEN.length} admin operations and the other NOVUS functions server-side, writes nothing, and cannot touch Joe's history`);

// ── 5b. endpoints outside middleware.js (/api/lead, /api/demo) ─────────────
{
  const { default: leadHandler } = await import('../api/lead.js');
  const { default: demoHandler } = await import('../api/demo.js');
  const hit = async (h, method, query, cookie, extra = {}) => { const rr = response(); await h({ method, query, headers: { host: HOST, 'sec-fetch-mode': 'cors', ...(cookie ? { cookie } : {}), ...extra }, body: method === 'POST' ? { action: 'build' } : undefined }, rr); return rr; };
  let rr = await hit(leadHandler, 'GET', { call_context: '1', agency_id: 'ag_cold' }, LOUIS);
  assert.notEqual(rr.statusCode, 401, 'Calling Mode\'s context panel works for Louis');
  rr = await hit(leadHandler, 'GET', { call_context: '1', agency_id: 'ag_cold' }, '');
  assert.equal(rr.statusCode, 401);
  rr = await hit(demoHandler, 'POST', {}, LOUIS, { origin: `https://${HOST}` });
  assert.equal(rr.statusCode, 403, 'demo build is admin-only');
  rr = await hit(demoHandler, 'POST', {}, '', { authorization: ADMIN_BASIC });
  assert.notEqual(rr.statusCode, 401, 'demo build scripts keep the admin machine credential');
  ok('/api/lead call context (admin + setter) and /api/demo build (admin) resolve the caller in full');
}

// ── 6. logout ──────────────────────────────────────────────────────────────
r = await login('louis', louisPass);
const SECOND = r.cookie;
res = await request('POST', 'auth-logout', { cookie: SECOND });
assert.equal(res.statusCode, 200); assert.match(String(res.headers['Set-Cookie']), /novus_session=;.*Max-Age=0/);
res = await request('GET', 'whoami', { cookie: SECOND });
assert.equal(res.statusCode, 401, 'the old cookie value cannot be replayed after sign-out');
res = await request('GET', 'whoami', { cookie: LOUIS });
assert.equal(res.statusCode, 200, 'signing out one device leaves the other signed in');
{
  const { default: leadHandler } = await import('../api/lead.js');
  const rr = response(); await leadHandler({ method: 'GET', query: { call_context: '1', agency_id: 'ag_cold' }, headers: { host: HOST, 'sec-fetch-mode': 'cors', cookie: SECOND } }, rr);
  assert.equal(rr.statusCode, 401, 'a signed-out cookie is refused outside middleware too');
}
ok('sign-out deletes the server-side session: replaying the cookie fails');

// ── 7. expiry ──────────────────────────────────────────────────────────────
NOW = T0 + 2 * 3600_000 + 60_000;
res = await request('GET', 'whoami', { cookie: LOUIS });
assert.equal(res.statusCode, 401, 'idle for over 2 hours → signed out');
r = await login('louis', louisPass); LOUIS = r.cookie;
for (let i = 1; i <= 11; i += 1) { NOW += 3600_000 - 60_000; res = await request('GET', 'whoami', { cookie: LOUIS }); }
assert.equal(res.statusCode, 200, 'in use for 11 hours: still signed in (idle timer slides)');
NOW += 2 * 3600_000;
res = await request('GET', 'whoami', { cookie: LOUIS });
assert.equal(res.statusCode, 401, 'absolute 12-hour limit reached even though it was in use');
ok('sessions expire after 2 hours idle and at 12 hours absolute');

// ── 8. disable / reset revoke existing sessions ────────────────────────────
r = await login('louis', louisPass); LOUIS = r.cookie;
r = await login('joe', 'admin-env-pass'); const ADMIN2 = r.cookie;
res = await request('POST', 'team-user-status', { cookie: ADMIN2, body: { confirm: 'SET_USER_STATUS', user_id: louisId, status: 'DISABLED' } });
assert.equal(res.statusCode, 200); assert.equal(res.body.sessions_revoked, 1);
res = await request('GET', 'calling-workspace', { cookie: LOUIS });
assert.equal(res.statusCode, 401, 'his open session stops working on the next request');
assert.equal((await login('louis', louisPass)).res.statusCode, 401, 'and he cannot sign in');
await request('POST', 'team-user-status', { cookie: ADMIN2, body: { confirm: 'SET_USER_STATUS', user_id: louisId, status: 'ACTIVE' } });
r = await login('louis', louisPass); LOUIS = r.cookie;
// Backstop: even if the session store had not been reached, the USERS re-check refuses him.
const usersStatusCol = USERS_HEADER.indexOf('status');
store.USERS[2][usersStatusCol] = 'DISABLED'; invalidateUsersCache();
assert.equal((await request('GET', 'whoami', { cookie: LOUIS })).statusCode, 401, 'USERS status is re-checked on every request');
store.USERS[2][usersStatusCol] = 'ACTIVE'; invalidateUsersCache();
res = await request('POST', 'team-user-reset', { cookie: ADMIN2, body: { confirm: 'RESET_USER_PASSWORD', user_id: louisId } });
const newPass = res.body.one_time_password;
assert.equal((await request('GET', 'whoami', { cookie: LOUIS })).statusCode, 401, 'reset ends existing sessions');
assert.equal((await login('louis', louisPass)).res.statusCode, 401, 'old password refused');
r = await login('louis', newPass); LOUIS = r.cookie;
assert.equal((await request('GET', 'whoami', { cookie: LOUIS })).statusCode, 200);
assert.equal((await request('GET', 'whoami', { cookie: ADMIN2 })).statusCode, 200, 'the admin is unaffected');
ok('disabling or resetting Louis ends his signed-in sessions immediately; USERS is re-checked as a backstop');

// ── 9. rate limiting / fail closed ─────────────────────────────────────────
for (let i = 0; i < 5; i += 1) assert.equal((await login('louis', `nope-${i}`)).res.statusCode, 401);
res = (await login('louis', newPass)).res;
assert.equal(res.statusCode, 429, 'the right password is refused while locked out'); assert.equal(res.headers['Retry-After'], '900');
NOW += 16 * 60_000;
r = await login('louis', newPass); LOUIS = r.cookie;
assert.equal(r.res.statusCode, 200, 'the lockout lapses after 15 minutes');
const secret = process.env.NOVUS_SESSION_SECRET;
process.env.NOVUS_SESSION_SECRET = 'short';
assert.equal((await login('joe', 'admin-env-pass')).res.statusCode, 503, 'no session secret → sign-in disabled, never a weak default');
process.env.NOVUS_SESSION_SECRET = secret;
__setKvForTests({ command: async () => { throw new Error('down'); } });
assert.equal((await login('joe', 'admin-env-pass')).res.statusCode, 503, 'session store down → sign-in refuses');
assert.equal((await request('GET', 'whoami', { cookie: LOUIS })).statusCode, 401, 'and existing sessions cannot be validated, so they are refused');
assert.equal((await request('GET', 'whoami', { auth: ADMIN_BASIC, browser: false })).statusCode, 200, 'machine credential unaffected');
__setKvForTests(kv);
ok('5 failed sign-ins lock the username for 15 minutes; a missing secret or session store fails closed');

// ── 10. Edge middleware ────────────────────────────────────────────────────
{
  process.env.KV_REST_API_URL = 'https://kv.test'; process.env.KV_REST_API_TOKEN = 'kvtok';
  const { default: middleware } = await import('../middleware.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://kv.test');
    return new Response(JSON.stringify({ result: await kv.command(JSON.parse(init.body)) }), { status: 200 });
  };
  const mw = (path, headers = {}) => middleware({ url: `https://${HOST}${path}`, headers: new Headers(headers) });
  const loc = (resp) => resp.headers.get('location');
  try {
    assert.equal(await mw('/novus/login.html'), undefined);
    assert.equal(await mw('/api/novus/auth/login'), undefined);
    assert.equal(await mw('/novus/novus-ui.css'), undefined);
    let out = await mw('/novus/operator.html');
    assert.equal(out.status, 302); assert.equal(loc(out), `https://${HOST}/novus/login.html?next=%2Fnovus%2Foperator.html`);
    out = await mw('/api/novus/personalisation', { 'sec-fetch-mode': 'cors' });
    assert.equal(out.status, 401); assert.equal(out.headers.get('www-authenticate'), null);
    assert.equal(await mw('/novus/operator.html', { cookie: ADMIN2 }), undefined);
    assert.equal(await mw('/api/novus/probe', { cookie: ADMIN2 }), undefined);
    assert.equal(await mw('/novus/calling.html', { cookie: LOUIS }), undefined);
    for (const page of ['/novus/operator.html', '/novus/campaigns.html', '/novus/meetings.html', '/novus/probe.html', '/novus']) {
      out = await mw(page, { cookie: LOUIS });
      assert.equal(out.status, 302, page); assert.equal(loc(out), `https://${HOST}/novus/calling.html`);
    }
    assert.equal((await mw('/api/novus/probe', { cookie: LOUIS })).status, 403);
    assert.equal(await mw('/api/novus/personalisation', { cookie: LOUIS }), undefined, 'the function enforces the allowlist');
    // Machine credential: APIs as before; pages only with the worker marker.
    assert.equal(await mw('/api/novus/probe', { authorization: ADMIN_BASIC }), undefined);
    assert.equal((await mw('/novus/probe.html', { authorization: ADMIN_BASIC })).status, 302, 'a browser caching the old Basic login still meets the login page');
    assert.equal(await mw('/novus/probe.html', { authorization: ADMIN_BASIC, 'x-novus-client': 'worker' }), undefined);
    // Revoked / forged cookies.
    await request('POST', 'auth-logout', { cookie: LOUIS });
    assert.equal((await mw('/novus/calling.html', { cookie: LOUIS })).status, 302, 'signed-out cookie → login');
    const [body, sig] = ADMIN2.split('=')[1].split('.');
    const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), uid: louisId })).toString('base64url');
    assert.equal((await mw('/novus/operator.html', { cookie: `novus_session=${forgedBody}.${sig}` })).status, 302, 'forged token rejected');
    assert.equal(await mw('/api/novus/webhooks/voice-outbound'), undefined, 'webhooks unchanged');
  } finally { globalThis.fetch = realFetch; }
  ok('middleware: login page public; pages redirect to it when signed out; Louis confined to Calling Mode; revoked and forged cookies refused; machine clients unchanged');
}

__setRepoForTests(null);
__setKvForTests(null);
console.log(`\nNOVUS team access self-test passed (${passed} checks).`);
