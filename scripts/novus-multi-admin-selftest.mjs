#!/usr/bin/env node
// scripts/novus-multi-admin-selftest.mjs — hermetic test of the two-admin
// operating model: Joe (env admin) and Louis (a USERS-row account promoted to
// ADMIN) working side by side. Covers the root cause of Louis's sign-in
// trouble (a failed USERS read used to look like "account deleted"), password
// change/unlock, gatekeeper + main script versions with per-user selection,
// personal preferences, connected-mailbox sending through MOCKED providers,
// templates, timeline attribution, meeting handoff and team analytics.
// No network: every provider call goes to an in-process fake.
//
// Run:  npm run novus:multi-admin-selftest

import assert from 'node:assert/strict';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { USERS_HEADER, invalidateUsersCache } from '../lib/novus-users.mjs';
import { createMemoryKv, __setKvForTests } from '../lib/kv.mjs';
import { __setMailFetchForTests } from '../lib/mailbox.mjs';
import { ACTIONS_HEADER } from '../lib/actions-store.mjs';

let passed = 0;
const ok = (msg) => { passed += 1; console.log(`  ✓ ${msg}`); };
const FAIL = new Set();

function makeStore(initial) {
  const store = structuredClone(initial);
  const api = {
    async get(range) { const tab = String(range).split('!')[0]; if (FAIL.has(tab)) throw new Error(`Sheets API GET failed (429): quota exceeded`); if (!(tab in store)) throw new Error(`Unable to parse range: ${tab}`); return store[tab].map((r) => r.slice()); },
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

const T0 = Date.parse('2026-10-27T10:00:00.000Z');
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
  ACTIONS: [[...ACTIONS_HEADER]],
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

// ── 0. Joe (env admin) creates Louis and promotes him to ADMIN ─────────────
const JOE = (await login('novus', 'admin-env-pass')).cookie;
let res = await request('POST', 'calling-setup', { cookie: JOE, body: { confirm: 'SETUP_CALLING_TABS' } });
assert.equal(res.statusCode, 200, JSON.stringify(res.body));
res = await request('POST', 'team-user-create', { cookie: JOE, body: { confirm: 'CREATE_USER', display_name: 'Louis Greenwood', username: 'louis' } });
assert.equal(res.statusCode, 201);
let louisPass = res.body.one_time_password; const louisId = res.body.user.user_id;
res = await request('POST', 'team-user-role', { cookie: JOE, body: { confirm: 'CHANGE_USER_ROLE', user_id: louisId, role: 'ADMIN' } });
assert.equal(res.statusCode, 200, JSON.stringify(res.body));
NOW += 1000;
let r = await login('louis', louisPass); let LOUIS = r.cookie;
assert.equal(r.res.statusCode, 200);
assert.equal((await request('GET', 'whoami', { cookie: LOUIS })).body.user.role, 'ADMIN');
ok('Joe and Louis are both administrators with their own identities');

// ── 1. ROOT CAUSE: a USERS read failure is not "signed out" ────────────────
NOW += 31_000; // past the 30s USERS cache
FAIL.add('USERS');
res = await request('GET', 'whoami', { cookie: LOUIS });
assert.equal(res.statusCode, 200, 'a warm instance re-checks Louis against the last good USERS read');
assert.equal(res.body.user.user_id, louisId);
invalidateUsersCache(); // a cold instance: nothing to fall back on
res = await request('GET', 'whoami', { cookie: LOUIS });
assert.equal(res.statusCode, 503, 'cold instance + unreadable USERS → 503 (page stays signed in), never 401');
assert.equal(res.body.retryable, true);
assert.equal((await request('GET', 'whoami', { cookie: JOE })).statusCode, 200, 'Joe (env admin) never depended on USERS — why only Louis saw this');
for (let i = 0; i < 7; i += 1) {
  res = (await login('louis', louisPass)).res;
  assert.equal(res.statusCode, 503, 'sign-in while USERS is unreadable: 503, not "incorrect password"');
  assert.match(res.body.error, /not counted as wrong/);
}
FAIL.delete('USERS');
r = await login('louis', louisPass);
assert.equal(r.res.statusCode, 200, 'seven outage attempts did not lock the account');
LOUIS = r.cookie;
r = await login('louis', `  ${louisPass}\n`);
assert.equal(r.res.statusCode, 200, 'whitespace pasted around the password is ignored');
ok('USERS outage: warm session survives, cold → 503 (not 401); outage sign-ins are 503 and never count towards the lockout');

// Session store (Redis) outage is "unavailable", not "signed out".
__setKvForTests({ command: async () => { throw new Error('down'); } });
assert.equal((await request('GET', 'whoami', { cookie: LOUIS })).statusCode, 503);
__setKvForTests(kv);
assert.equal((await request('GET', 'whoami', { cookie: LOUIS })).statusCode, 200, 'and the same cookie works again once Redis answers');
ok('session-store outage → 503 and the session survives it');

// ── 2. lockout messages, admin unlock, self-service password change ───────
res = (await login('louis', 'wrong-1')).res; assert.equal(res.statusCode, 401); assert.equal(res.body.attempts_left, 4);
res = (await login('louis', 'wrong-2')).res; res = (await login('louis', 'wrong-3')).res;
assert.match(res.body.error, /2 attempts left/);
res = (await login('louis', 'wrong-4')).res; res = (await login('louis', 'wrong-5')).res;
assert.match(res.body.error, /locked for 15 minutes/);
res = (await login('louis', louisPass)).res;
assert.equal(res.statusCode, 429); assert.equal(res.body.locked, true); assert.match(res.body.error, /administrator to reset/);
assert.equal((await login('novus', 'admin-env-pass')).res.statusCode, 200, "Louis's lock never affects Joe");
res = await request('POST', 'team-user-reset', { cookie: JOE, body: { confirm: 'RESET_USER_PASSWORD', user_id: louisId } });
assert.equal(res.statusCode, 200); louisPass = res.body.one_time_password;
NOW += 1000;
r = await login('louis', louisPass); assert.equal(r.res.statusCode, 200, 'an admin reset unlocks the account immediately'); LOUIS = r.cookie;
const LOUIS_OTHER = (await login('louis', louisPass)).cookie; // a second device
NOW += 1000;
res = await request('POST', 'auth-change-password', { cookie: LOUIS, body: { current_password: louisPass, new_password: 'short' } });
assert.equal(res.statusCode, 400);
res = await request('POST', 'auth-change-password', { cookie: LOUIS, body: { current_password: 'nope', new_password: 'louis-own-password-2026' } });
assert.equal(res.statusCode, 400); assert.match(res.body.error, /current password/);
res = await request('POST', 'auth-change-password', { cookie: LOUIS, body: { current_password: louisPass, new_password: 'louis-own-password-2026' } });
assert.equal(res.statusCode, 200, JSON.stringify(res.body));
LOUIS = cookieOf(res);
assert.equal((await request('GET', 'whoami', { cookie: LOUIS })).statusCode, 200, 'this browser stays signed in');
assert.equal((await request('GET', 'whoami', { cookie: LOUIS_OTHER })).statusCode, 401, 'the other device is signed out');
assert.equal((await login('louis', louisPass)).res.statusCode, 401, 'old password refused');
assert.equal((await login('louis', 'louis-own-password-2026')).res.statusCode, 200);
assert.equal((await request('POST', 'auth-change-password', { cookie: JOE, body: { current_password: 'x', new_password: 'whatever-long-enough' } })).statusCode, 400, "the env admin's password is managed in Vercel");
ok('clear lockout messages with attempts left; admin reset unlocks; self-service password change keeps this browser, ends other sessions');

// ── 3. gatekeeper scripts: versions, company default, per-person selection ─
const ws = async (cookie) => (await request('GET', 'calling-workspace', { cookie, query: { refresh: '1' } })).body;
let W = await ws(JOE);
assert.equal(W.gatekeeper_scripts.length, 1, 'calling-setup seeded the previous built-in gatekeeper wording as gatekeeper v1');
const gk1 = W.gatekeeper_scripts[0];
assert.equal(gk1.status, 'CURRENT'); assert.equal(gk1.kind, 'GATEKEEPER'); assert.match(gk1.content, /is \{\{first_name\}\} around/);
assert.ok(W.scripts.every((x) => x.kind === 'MAIN') && W.scripts.length === 1, 'main and gatekeeper libraries are separate');
const main1 = W.scripts[0];
assert.equal(W.me.scripts.gatekeeper.script_id, gk1.script_id); assert.equal(W.me.scripts.gatekeeper.source, 'COMPANY_DEFAULT');
// Louis creates his own gatekeeper script (a separate script, testing).
res = await request('POST', 'script-duplicate', { cookie: LOUIS, body: { confirm: 'DUPLICATE_SCRIPT', script_id: gk1.script_id, as_new_script: true, name: 'Gatekeeper — Louis referral ask' } });
assert.equal(res.statusCode, 201, JSON.stringify(res.body)); const gkL = res.body.script;
assert.equal(gkL.kind, 'GATEKEEPER'); assert.equal(gkL.version, 1); assert.equal(gkL.status, 'TESTING'); assert.notEqual(gkL.script_key, gk1.script_key);
res = await request('POST', 'script-save', { cookie: LOUIS, body: { confirm: 'SAVE_SCRIPT', script_id: gkL.script_id, name: 'Gatekeeper — referral', content: 'Hi, could I speak to {{first_name}}? It is {{sender_first_name}} from NOVUS.', notes: 'shorter' } });
assert.equal(res.statusCode, 200); assert.equal(res.body.new_version, false, 'unused version edited (and renamed) in place');
// A main script edit never touches the gatekeeper default and vice versa.
res = await request('POST', 'script-save', { cookie: JOE, body: { confirm: 'SAVE_SCRIPT', kind: 'MAIN', name: 'Main B', content: 'Main B wording', status: 'TESTING' } });
assert.equal(res.statusCode, 200); const mainB = res.body.script; assert.equal(mainB.kind, 'MAIN');
// Louis picks his own versions; Joe keeps the company defaults.
res = await request('POST', 'my-preferences-save', { cookie: LOUIS, body: { confirm: 'SAVE_PREFERENCES', preferences: { gatekeeper_script_id: gkL.script_id, main_script_id: mainB.script_id, queue_owner_filter: 'mine' } } });
assert.equal(res.statusCode, 200, JSON.stringify(res.body));
assert.equal((await request('POST', 'my-preferences-save', { cookie: LOUIS, body: { confirm: 'SAVE_PREFERENCES', preferences: { queue_owner_filter: 'everyone!' } } })).statusCode, 400, 'preferences are validated');
const WL = await ws(LOUIS); W = await ws(JOE);
assert.equal(WL.me.scripts.gatekeeper.script_id, gkL.script_id); assert.equal(WL.me.scripts.gatekeeper.source, 'YOURS');
assert.equal(WL.me.scripts.main.script_id, mainB.script_id);
assert.equal(W.me.scripts.gatekeeper.script_id, gk1.script_id, "Louis's choice does not change Joe's");
assert.equal(W.me.scripts.main.script_id, main1.script_id);
assert.equal(W.gatekeeper_scripts.find((x) => x.script_id === gk1.script_id).status, 'CURRENT', 'and the company default is untouched');
assert.equal(WL.me.preferences.queue_owner_filter, 'mine');
assert.equal(WL.leads.ag_cold.script.inherited, false, 'a never-called lead takes the caller\'s own main script');
ok('gatekeeper library: seeded from the old built-in text, duplicate as a separate script, rename/edit, independent of the main script; Louis and Joe select different versions without affecting each other');

// Calls freeze the gatekeeper version they used; delete is only for unused versions.
res = await request('POST', 'calling-save', { cookie: LOUIS, body: { confirm: 'SAVE_CALL', client_key: 'l-gk-1', agency_id: 'ag_cold', call_mode: 'MANUAL', script_id: mainB.script_id, gatekeeper_reached: true, gatekeeper_script_id: gkL.script_id, outcome: 'GATEKEPT' } });
assert.equal(res.statusCode, 201, JSON.stringify(res.body));
assert.equal(JSON.parse(res.body.call.metadata_json).gatekeeper_script_id, gkL.script_id, 'the call records which gatekeeper version was on screen');
W = await ws(JOE);
assert.equal(W.gatekeeper_scripts.find((x) => x.script_id === gkL.script_id).call_count, 1);
res = await request('POST', 'script-save', { cookie: JOE, body: { confirm: 'SAVE_SCRIPT', script_id: gkL.script_id, name: 'Gatekeeper — referral', content: 'changed', notes: '' } });
assert.equal(res.statusCode, 409, 'a gatekeeper version used on a call is frozen');
res = await request('POST', 'script-save', { cookie: JOE, body: { confirm: 'SAVE_SCRIPT', script_id: gkL.script_id, name: 'Gatekeeper — referral', content: 'changed', notes: 'v2', as_new_version: true } });
assert.equal(res.statusCode, 200); const gkL2 = res.body.script; assert.equal(gkL2.version, 2); assert.equal(gkL2.script_key, gkL.script_key);
res = await request('POST', 'script-delete', { cookie: JOE, body: { confirm: 'DELETE_SCRIPT_VERSION', script_id: gkL.script_id } });
assert.equal(res.statusCode, 409, 'a used version cannot be deleted'); assert.match(res.body.error, /Archive it instead/);
assert.equal((await request('POST', 'script-delete', { cookie: JOE, body: { confirm: 'DELETE_SCRIPT_VERSION', script_id: gk1.script_id } })).statusCode, 409, 'the company default cannot be deleted');
res = await request('POST', 'script-status', { cookie: JOE, body: { confirm: 'SET_SCRIPT_STATUS', script_id: gkL.script_id, status: 'ARCHIVED' } });
assert.equal(res.statusCode, 200);
const WL2 = await ws(LOUIS);
assert.equal(WL2.me.scripts.gatekeeper.script_id, gkL2.script_id, 'his pick was archived → he follows the newest version of the same script');
assert.equal(WL2.me.scripts.gatekeeper.source, 'YOURS_LATEST'); assert.match(WL2.me.scripts.gatekeeper.notice, /archived/);
res = await request('POST', 'script-status', { cookie: JOE, body: { confirm: 'SET_SCRIPT_STATUS', script_id: gkL2.script_id, status: 'CURRENT' } });
W = await ws(JOE);
assert.equal(W.gatekeeper_scripts.filter((x) => x.status === 'CURRENT').length, 1, 'one company-default gatekeeper');
assert.equal(W.scripts.filter((x) => x.status === 'CURRENT').map((x) => x.script_id).join(), main1.script_id, 'making a gatekeeper current never demotes the main script');
res = await request('POST', 'script-delete', { cookie: JOE, body: { confirm: 'DELETE_SCRIPT_VERSION', script_id: gk1.script_id } });
assert.equal(res.statusCode, 200, 'an unused, non-default version can be deleted');
assert.ok(!(await ws(JOE)).gatekeeper_scripts.some((x) => x.script_id === gk1.script_id));
ok('a call freezes the gatekeeper version it used (edit → v2); used/default versions cannot be deleted; archived picks follow their family; one default per kind');

// ── 4. duplicate-call protection ──────────────────────────────────────────
res = await request('POST', 'calling-start', { cookie: JOE, body: { confirm: 'START_CALL', client_key: 'j-live', agency_id: 'ag_cold2', call_mode: 'TWILIO' } });
assert.equal(res.statusCode, 201, JSON.stringify(res.body));
assert.ok((await ws(LOUIS)).live_dials.some((d) => d.agency_id === 'ag_cold2' && d.user_id === 'admin'), 'the live dial is visible to Louis');
res = await request('POST', 'calling-start', { cookie: LOUIS, body: { confirm: 'START_CALL', client_key: 'l-live', agency_id: 'ag_cold2', call_mode: 'TWILIO' } });
assert.equal(res.statusCode, 409); assert.equal(res.body.in_progress, true); assert.match(res.body.error, /Joe started a call/);
res = await request('POST', 'calling-start', { cookie: LOUIS, body: { confirm: 'START_CALL', client_key: 'l-live', agency_id: 'ag_cold2', call_mode: 'TWILIO', allow_concurrent: true } });
assert.equal(res.statusCode, 201, 'only after he confirms');
res = await request('POST', 'calling-start', { cookie: JOE, body: { confirm: 'START_CALL', client_key: 'j-live', agency_id: 'ag_cold2', call_mode: 'TWILIO' } });
assert.equal(res.body.reused, true, "Joe's own retry of the same dial is idempotent");
ok('duplicate-call protection: a second person dialling a live agency is told who and must confirm; same-dial retries are idempotent');

// ── 5. connected inboxes (MOCKED providers — nothing real is ever called) ──
const sent = { gmail: [], graph: [] };
let googleIdentity = 'joe@getnovus.co.uk';
let msRefreshFails = false; let gmailDrops = false;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
__setMailFetchForTests(async (url, init = {}) => {
  const u = String(url);
  const form = typeof init.body === 'string' && /x-www-form-urlencoded/.test(init.headers?.['Content-Type'] || '') ? Object.fromEntries(new URLSearchParams(init.body)) : {};
  if (u === 'https://oauth2.googleapis.com/token') {
    if (form.grant_type === 'authorization_code') { assert.ok(form.code_verifier, 'PKCE verifier sent'); return json(200, { access_token: 'g-at', refresh_token: 'g-rt-SECRET', expires_in: 3600, scope: 'openid https://www.googleapis.com/auth/gmail.send email profile' }); }
    return json(200, { access_token: 'g-at2', expires_in: 3600 });
  }
  if (u.startsWith('https://login.microsoftonline.com/')) {
    if (form.grant_type === 'authorization_code') return json(200, { access_token: 'm-at', refresh_token: 'm-rt-SECRET', expires_in: 1, scope: 'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read openid' });
    if (msRefreshFails) return json(400, { error: 'invalid_grant' });
    return json(200, { access_token: 'm-at2', refresh_token: 'm-rt-ROTATED', expires_in: 3600 });
  }
  if (u === 'https://openidconnect.googleapis.com/v1/userinfo') return json(200, { email: googleIdentity, email_verified: true, name: 'Joe Carter' });
  if (u.startsWith('https://graph.microsoft.com/v1.0/me?')) return json(200, { mail: 'louis@getnovus.co.uk', displayName: 'Louis Greenwood' });
  if (u === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
    if (gmailDrops) throw new Error('socket hang up');
    sent.gmail.push({ auth: init.headers.Authorization, raw: Buffer.from(JSON.parse(init.body).raw, 'base64url').toString('utf8') });
    return json(200, { id: `gm_${sent.gmail.length}`, threadId: `th_${sent.gmail.length}` });
  }
  if (u === 'https://graph.microsoft.com/v1.0/me/sendMail') { sent.graph.push({ auth: init.headers.Authorization, body: JSON.parse(init.body) }); return new Response(null, { status: 202 }); }
  if (u.startsWith('https://oauth2.googleapis.com/revoke')) return json(200, {});
  throw new Error(`unexpected provider call in test: ${u}`);
});
const loc = (r) => String(r.headers.Location || '');
res = await request('POST', 'mail-connect-start', { cookie: JOE, body: { confirm: 'CONNECT_MAILBOX', provider: 'GOOGLE' } });
assert.equal(res.statusCode, 503, 'not configured → clear 503'); assert.equal(res.body.code, 'NOT_CONFIGURED');
Object.assign(process.env, { GOOGLE_OAUTH_CLIENT_ID: 'gid', GOOGLE_OAUTH_CLIENT_SECRET: 'gsecret', MICROSOFT_OAUTH_CLIENT_ID: 'mid', MICROSOFT_OAUTH_CLIENT_SECRET: 'msecret', NOVUS_MAIL_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'), NOVUS_MAIL_ALLOWED_DOMAINS: 'getnovus.co.uk' });
res = await request('POST', 'mail-connect-start', { cookie: JOE, body: { confirm: 'CONNECT_MAILBOX', provider: 'GOOGLE', return_to: '/novus/calling.html#calling' } });
assert.equal(res.statusCode, 200, JSON.stringify(res.body));
const joeAuth = new URL(res.body.url);
assert.equal(joeAuth.origin + joeAuth.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
assert.equal(joeAuth.searchParams.get('code_challenge_method'), 'S256');
assert.equal(joeAuth.searchParams.get('redirect_uri'), `https://${HOST}/api/novus/mail/oauth/callback`);
assert.match(joeAuth.searchParams.get('scope'), /gmail\.send/); assert.doesNotMatch(joeAuth.searchParams.get('scope'), /gmail\.readonly|mail\.google\.com/, 'send-only scope');
// Louis cannot finish Joe's connection.
res = await request('GET', 'mail-oauth-callback', { cookie: LOUIS, query: { state: joeAuth.searchParams.get('state'), code: 'c1' } });
assert.equal(res.statusCode, 302); assert.match(loc(res), /mail=error&reason=WRONG_USER/);
// The state was consumed by that attempt; Joe starts again and finishes.
res = await request('POST', 'mail-connect-start', { cookie: JOE, body: { confirm: 'CONNECT_MAILBOX', provider: 'GOOGLE', return_to: '/novus/calling.html#calling' } });
const joeState = new URL(res.body.url).searchParams.get('state');
res = await request('GET', 'mail-oauth-callback', { cookie: JOE, query: { state: joeState, code: 'c2' } });
assert.equal(loc(res), '/novus/calling.html#calling?mail=connected');
res = await request('GET', 'mail-oauth-callback', { cookie: JOE, query: { state: joeState, code: 'c2' } });
assert.match(loc(res), /reason=STATE_EXPIRED/, 'a state is single-use');
const rawJoe = await kv.command(['GET', 'novus:mail:acct:admin']);
assert.ok(rawJoe && !rawJoe.includes('g-rt-SECRET') && !rawJoe.includes('g-at'), 'tokens are stored encrypted, never in plain text');
// Louis connects Microsoft 365.
res = await request('POST', 'mail-connect-start', { cookie: LOUIS, body: { confirm: 'CONNECT_MAILBOX', provider: 'MICROSOFT' } });
assert.match(res.body.url, /^https:\/\/login\.microsoftonline\.com\/organizations\/oauth2\/v2\.0\/authorize\?/);
assert.match(new URL(res.body.url).searchParams.get('scope'), /Mail\.Send/);
res = await request('GET', 'mail-oauth-callback', { cookie: LOUIS, query: { state: new URL(res.body.url).searchParams.get('state'), code: 'm1' } });
assert.match(loc(res), /mail=connected/);
// Louis cannot take Joe's address; a non-company address is refused.
res = await request('POST', 'mail-connect-start', { cookie: LOUIS, body: { confirm: 'CONNECT_MAILBOX', provider: 'GOOGLE' } });
res = await request('GET', 'mail-oauth-callback', { cookie: LOUIS, query: { state: new URL(res.body.url).searchParams.get('state'), code: 'x' } });
assert.match(loc(res), /reason=ADDRESS_IN_USE/, "one inbox ↔ one person: Louis cannot send as Joe's address");
googleIdentity = 'louis.personal@gmail.com';
res = await request('POST', 'mail-connect-start', { cookie: LOUIS, body: { confirm: 'CONNECT_MAILBOX', provider: 'GOOGLE' } });
res = await request('GET', 'mail-oauth-callback', { cookie: LOUIS, query: { state: new URL(res.body.url).searchParams.get('state'), code: 'x' } });
assert.match(loc(res), /reason=DOMAIN_NOT_ALLOWED/);
googleIdentity = 'joe@getnovus.co.uk';
res = await request('GET', 'mail-status', { cookie: LOUIS });
assert.equal(res.body.account.email, 'louis@getnovus.co.uk'); assert.equal(res.body.account.provider, 'MICROSOFT'); assert.equal(res.body.account.status, 'CONNECTED');
assert.ok(!JSON.stringify(res.body).includes('SECRET') && !('token' in res.body.account), 'no token ever leaves the server');
assert.deepEqual(res.body.team.map((u) => [u.user_id, u.account?.email]).sort(), [['admin', 'joe@getnovus.co.uk'], [louisId, 'louis@getnovus.co.uk']].sort(), 'admins see who has connected which inbox');
ok('connect: OAuth + PKCE, send-only scopes, state bound to the person and single-use, tokens encrypted at rest, one inbox per person, company domains only');

// Templates: a shared library, seeded once, versioned when a sent email used it.
res = await request('GET', 'mail-templates', { cookie: LOUIS });
assert.equal(res.statusCode, 200); assert.equal(res.body.templates.length, 5, 'starter library seeded on first read');
assert.equal((await request('GET', 'mail-templates', { cookie: JOE })).body.templates.length, 5, 'and only once');
const moreInfo = res.body.templates.find((t) => t.purpose === 'MORE_INFO');
const moreInfoV1 = moreInfo.versions[0];

// Send from Calling Mode: Joe → his Gmail; Louis → his Outlook.
const sendBody = (key, extra = {}) => ({ confirm: 'SEND_EMAIL', idempotency_key: key, source: 'CALLING', agency_id: 'ag_cold', to: 'ann@coldone.co.uk', contact_name: 'Ann Cold',
  subject: 'Following our call — NOVUS for Cold One', body_text: 'Hi Ann,\n\nAs promised…\n\nJoe', template_id: moreInfoV1.template_id, template_version: '1', ...extra });
res = await request('POST', 'mail-send', { cookie: JOE, body: sendBody('joe-email-0001', { expected_from: 'joe@getnovus.co.uk' }) });
assert.equal(res.statusCode, 201, JSON.stringify(res.body));
assert.equal(res.body.message.provider_status, 'ACCEPTED'); assert.equal(res.body.message.from_email, 'joe@getnovus.co.uk');
assert.equal(sent.gmail.length, 1); assert.match(sent.gmail[0].raw, /^From: "Joe Carter" <joe@getnovus\.co\.uk>/m); assert.match(sent.gmail[0].raw, /^To: <ann@coldone\.co\.uk>/m);
res = await request('POST', 'mail-send', { cookie: JOE, body: sendBody('joe-email-0001') });
assert.equal(res.statusCode, 200); assert.equal(res.body.duplicate, true); assert.equal(sent.gmail.length, 1, 'the same compose (double click / retry) never sends twice');
res = await request('POST', 'mail-send', { cookie: LOUIS, body: sendBody('louis-email-0001', { body_text: 'Hi Ann,\n\nLouis here.', template_id: '' }) });
assert.equal(res.statusCode, 201, JSON.stringify(res.body)); assert.equal(res.body.message.from_email, 'louis@getnovus.co.uk');
assert.equal(sent.graph.length, 1); assert.equal(sent.gmail.length, 1, "Louis's email went through Louis's Outlook, not Joe's Gmail");
assert.equal(sent.graph[0].auth, 'Bearer m-at2', 'his expired access token was refreshed first');
assert.ok(!(await kv.command(['GET', `novus:mail:acct:${louisId}`])).includes('m-rt-ROTATED'), 'the rotated refresh token is stored encrypted too');
res = await request('POST', 'mail-send', { cookie: LOUIS, body: sendBody('louis-email-0002', { expected_from: 'joe@getnovus.co.uk' }) });
assert.equal(res.statusCode, 409); assert.equal(res.body.code, 'SENDER_CHANGED', 'a compose window showing a different sender is refused, never re-routed');
res = await request('POST', 'mail-send', { cookie: LOUIS, body: sendBody('louis-email-0003', { body_text: 'Hi {{first_name}}' }) });
assert.equal(res.statusCode, 400); assert.match(res.body.error, /Fill in \{\{first_name\}\}/);
assert.equal(sent.graph.length, 1);
const rows = store.EMAIL_MESSAGES.slice(2).map((r) => Object.fromEntries(store.EMAIL_MESSAGES[0].map((k, i) => [k, r[i]])));
assert.deepEqual(rows.map((r) => [r.sender_user_id, r.from_email, r.status, r.source]), [['admin', 'joe@getnovus.co.uk', 'SENT', 'CALLING'], [louisId, 'louis@getnovus.co.uk', 'SENT', 'CALLING']]);
let timeline = (await request('GET', 'lead-timeline', { cookie: JOE, query: { agency_id: 'ag_cold' } })).body;
const emails = timeline.entries.filter((e) => e.kind === 'email');
assert.deepEqual(emails.map((e) => e.title).sort(), ['Email sent by Joe', 'Email sent by Louis Greenwood'].sort());
assert.ok(emails.every((e) => e.manual === true));
ok('send: each person sends from their OWN inbox (Gmail / Outlook), idempotent per compose, sender re-checked, placeholders must be filled, every attempt audited and on the agency timeline with who sent it');

// Templates used by a sent email are frozen.
res = await request('POST', 'mail-template-save', { cookie: LOUIS, body: { confirm: 'SAVE_TEMPLATE', template_id: moreInfoV1.template_id, name: moreInfo.name, purpose: 'MORE_INFO', subject: moreInfoV1.subject, body: `${moreInfoV1.body}\n\nP.S. new line` } });
assert.equal(res.statusCode, 200); assert.equal(res.body.new_version, true); assert.equal(res.body.template.version, 2);
res = await request('GET', 'mail-templates', { cookie: JOE });
const mi = res.body.templates.find((t) => t.template_key === moreInfo.template_key);
assert.equal(mi.versions.length, 2); assert.equal(mi.versions.find((v) => v.version === 1).status, 'ARCHIVED'); assert.equal(mi.current_id, mi.versions.find((v) => v.version === 2).template_id);
assert.equal((await request('POST', 'mail-template-save', { cookie: LOUIS, body: { confirm: 'SAVE_TEMPLATE', name: 'Bad', purpose: 'GENERAL', subject: 'x', body: 'Hi {{nickname}}' } })).statusCode, 400, 'unknown placeholders are refused');
ok('template library: shared, editable by either admin, a version used by a sent email is frozen (edit → v2)');

// Failure modes: expired connection, opted-out agency, dropped connection.
msRefreshFails = true;
await kv.command(['SET', `novus:mail:acct:${louisId}`, JSON.stringify({ ...JSON.parse(await kv.command(['GET', `novus:mail:acct:${louisId}`])), token: (await import('../lib/mailbox.mjs')).encryptTokens({ refresh_token: 'm-rt', access_token: 'old', expires_at: 0 }, louisId) })]);
res = await request('POST', 'mail-send', { cookie: LOUIS, body: sendBody('louis-email-0004') });
assert.equal(res.statusCode, 409); assert.equal(res.body.code, 'NEEDS_RECONNECT'); assert.match(res.body.error, /Reconnect/);
assert.equal(sent.gmail.length, 1, 'NOT routed through Joe'); assert.equal(sent.graph.length, 1);
assert.equal((await request('GET', 'mail-status', { cookie: LOUIS })).body.account.status, 'NEEDS_RECONNECT');
res = await request('POST', 'mail-send', { cookie: LOUIS, body: sendBody('louis-email-0005') });
assert.equal(res.body.code, 'NEEDS_RECONNECT', 'stays refused until he reconnects');
msRefreshFails = false;
store.REPLY_EVENTS.push(['re_opt', 'ag_cold2', 'OPT_OUT', iso(NOW - DAY), 'PERMANENT']);
res = await request('POST', 'mail-send', { cookie: JOE, body: sendBody('joe-email-0002', { agency_id: 'ag_cold2' }) });
assert.equal(res.statusCode, 409); assert.equal(res.body.code, 'OPTED_OUT');
res = await request('POST', 'mail-send', { cookie: JOE, body: sendBody('joe-email-0002', { agency_id: 'ag_cold2', acknowledge_opt_out: true }) });
assert.equal(res.statusCode, 201, 'only with an explicit acknowledgement');
gmailDrops = true;
res = await request('POST', 'mail-send', { cookie: JOE, body: sendBody('joe-email-0003') });
assert.equal(res.statusCode, 504); assert.equal(res.body.code, 'UNCONFIRMED'); assert.match(res.body.error, /MAY have been sent/);
gmailDrops = false;
res = await request('POST', 'mail-send', { cookie: JOE, body: sendBody('joe-email-0003') });
assert.equal(res.body.code, 'UNCONFIRMED', 'an unconfirmed compose cannot be fired again');
timeline = (await request('GET', 'lead-timeline', { cookie: JOE, query: { agency_id: 'ag_cold' } })).body;
assert.ok(timeline.entries.some((e) => e.type === 'DIRECT_EMAIL_UNCONFIRMED') && timeline.entries.some((e) => e.type === 'DIRECT_EMAIL_FAILED' && /Louis/.test(e.title)));
ok('failures are explicit: expired connection → reconnect (never another inbox), opted-out agency needs acknowledgement, a dropped connection is "unconfirmed" and not re-sendable');

// A call outcome never sends an email.
const before = sent.gmail.length + sent.graph.length;
res = await request('POST', 'calling-save', { cookie: JOE, body: { confirm: 'SAVE_CALL', client_key: 'j-mi', agency_id: 'ag_cold', call_mode: 'MANUAL', outcome: 'MORE_INFO_REQUESTED', more_info_type: 'EMAIL_OVERVIEW', followup_at: iso(NOW + DAY) } });
assert.equal(res.statusCode, 201, JSON.stringify(res.body));
assert.equal(sent.gmail.length + sent.graph.length, before, '"more info requested" creates a follow-up action; it never sends an email');
// Test email to an explicit address; disconnect.
res = await request('POST', 'mail-send', { cookie: JOE, body: { confirm: 'SEND_EMAIL', idempotency_key: 'joe-test-0001', source: 'TEST', to: 'joe.check@getnovus.co.uk', subject: 'NOVUS test email', body_text: 'Test' } });
assert.equal(res.statusCode, 201); assert.match(sent.gmail.at(-1).raw, /^To: <joe\.check@getnovus\.co\.uk>/m);
res = await request('POST', 'mail-disconnect', { cookie: JOE, body: { confirm: 'DISCONNECT_MAILBOX' } });
assert.equal(res.body.disconnected, true);
res = await request('POST', 'mail-send', { cookie: JOE, body: sendBody('joe-email-0009') });
assert.equal(res.statusCode, 409); assert.equal(res.body.code, 'NOT_CONNECTED');
assert.equal((await request('GET', 'mail-status', { cookie: LOUIS })).body.account.email, 'louis@getnovus.co.uk', "Joe disconnecting never touches Louis's connection");
ok('no call outcome sends email; a test email goes only to the address typed; disconnect is per person');

// ── 6. meeting handoff: who booked it vs who runs it ──────────────────────
const meetingAt = iso(NOW + 3 * DAY);
res = await request('POST', 'calling-save', { cookie: LOUIS, body: { confirm: 'SAVE_CALL', client_key: 'l-live', agency_id: 'ag_cold2', call_mode: 'TWILIO', outcome: 'BOOKED_MEETING', meeting_at: meetingAt, meeting_note: 'Wants to fix valuation follow-up', main_priority: 'VALUATIONS', useful_note: 'Owner runs 2 branches', owner_reached: true } });
assert.ok([200, 201].includes(res.statusCode), JSON.stringify(res.body)); assert.equal(res.body.followups_complete, true, JSON.stringify(res.body.warnings));
const actionsTab = () => store.ACTIONS.slice(1).map((r) => Object.fromEntries(store.ACTIONS[0].map((k, i) => [k, r[i]]))).filter((a) => a.action_id && a.action_id !== 'SCHEMA NOTE');
const prep = actionsTab().find((a) => a.agency_id === 'ag_cold2' && a.action_type === 'PREPARE_MEETING');
assert.ok(prep, 'a prep action exists');
let pm = JSON.parse(prep.metadata_json);
assert.equal(pm.assigned_user_id, louisId, 'Louis is an admin, so by default he runs the meeting he booked');
assert.equal(pm.handover.booked_by, louisId); assert.equal(pm.handover.meeting_note, 'Wants to fix valuation follow-up'); assert.equal(pm.handover.main_priority, 'VALUATIONS'); assert.equal(pm.handover.meeting_at, meetingAt);
res = await request('POST', 'action-assign', { cookie: JOE, body: { confirm: 'ASSIGN_ACTION', action_id: prep.action_id, user_id: 'admin' } });
assert.equal(res.statusCode, 200, JSON.stringify(res.body));
pm = JSON.parse(actionsTab().find((a) => a.action_id === prep.action_id).metadata_json);
assert.equal(pm.assigned_user_id, 'admin', 'Joe now runs it'); assert.equal(pm.handover.booked_by, louisId, 'the booking stays attributed to Louis');
assert.equal(pm.assignment_history.at(-1).by, 'admin');
res = await request('GET', 'discovery-meetings', { cookie: LOUIS });
const mrow = (res.body.meetings || []).find((m) => m.agency_id === 'ag_cold2');
assert.ok(mrow, JSON.stringify(res.body).slice(0, 300));
assert.equal(mrow.booked_by_user_id, louisId); assert.equal(mrow.host_user_id, 'admin'); assert.equal(mrow.prepare_action_id, prep.action_id);
assert.equal(actionsTab().filter((a) => a.agency_id === 'ag_cold2' && a.action_type === 'PREPARE_MEETING').length, 1, 'one meeting, no duplicate prep task');
res = await request('GET', 'priorities', { cookie: JOE, query: { refresh: '1' } });
const card = (res.body.items || []).find((c) => c.action_id === prep.action_id);
assert.ok(card); assert.equal(card.assignee_id, 'admin'); assert.equal(card.booked_by_id, louisId);
ok('meeting handoff: the booking keeps who booked it and the call notes; an admin reassigns who runs it; it moves to that person\'s Priorities without a duplicate');

// ── 7. team analytics: individual + company, defined, no double counting ──
res = await request('GET', 'call-performance', { cookie: JOE, query: { range: 'this_week' } });
assert.equal(res.statusCode, 200, JSON.stringify(res.body));
const perf = Object.fromEntries(res.body.users.map((u) => [u.user.user_id, u.summary]));
assert.equal(perf.admin.emails_sent, 2, "Joe: 2 accepted emails (the test email and the unconfirmed one don't count)");
assert.equal(perf[louisId].emails_sent, 1, 'Louis: 1 (his refused sends do not count)');
assert.equal(perf[louisId].meetings_booked, 1); assert.ok(perf[louisId].positive_responses >= 1);
assert.equal(perf.admin.meetings_booked, 0, "Joe runs Louis's meeting but did not book it");
assert.equal(res.body.company.emails_sent, perf.admin.emails_sent + perf[louisId].emails_sent, 'company = sum of people');
assert.equal(res.body.company.dials, perf.admin.dials + perf[louisId].dials);
for (const k of ['emails_sent', 'positive_responses', 'qualified_opportunities', 'pilots_agreed', 'meetings_attended', 'company']) assert.ok(res.body.definitions[k], `definition for ${k}`);
res = await request('GET', 'call-performance', { cookie: LOUIS, query: { range: 'this_week' } });
assert.equal(res.body.users.length, 2, 'Louis is an admin: he sees the whole team, not just himself');
ok('team analytics: emails sent, positive responses, meetings booked/attended, qualified opportunities and pilots per person plus a company total, each defined');

// @@NEXT@@

console.log(`\nNOVUS multi-admin self-test passed (${passed} checks).`);
