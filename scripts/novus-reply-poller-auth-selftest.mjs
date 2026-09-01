// Hermetic NOVUS live reply-poller auth-guard tests.
// Run: npm run novus:reply-poller-auth-selftest
//
// Drives the REAL HTTP handler (api/novus/personalisation.js) with fake req/res.
// globalThis.fetch THROWS and the repo override THROWS on every method, so any
// blocked request that still reached Instantly or Google Sheets fails the suite
// rather than passing quietly.

import assert from 'node:assert/strict';
import handler from '../api/novus/personalisation.js';
import { requireReplyPollerSecret, REPLY_POLLER_SECRET_HEADER } from '../api/novus/_auth.mjs';
import { __setRepoForTests } from '../lib/sheets.mjs';
import { createMemoryClaimStore, __setClaimStoreForTests } from '../lib/reply-claim.mjs';


// The live poll and live SEND_DEMO now REQUIRE a cross-instance claim store and
// fail closed without one (lib/reply-claim.mjs). This file tests other
// behaviour, so it injects the offline in-memory store to satisfy that
// dependency; contention itself is proven in
// scripts/novus-reply-concurrency-selftest.mjs. A fresh store per scenario
// keeps each case independent — a claim held from an earlier scenario in this
// same file is not the race under test here.
function freshClaims() {
  const store = createMemoryClaimStore();
  __setClaimStoreForTests(store);
  return store;
}
freshClaims();

const SECRET = 'poller-secret-value-do-not-echo';
const BASIC = `Basic ${Buffer.from('novus:basic-pass').toString('base64')}`;

process.env.NOVUS_BASIC_AUTH_USER = 'novus';
process.env.NOVUS_BASIC_AUTH_PASS = 'basic-pass';
process.env.INSTANTLY_REPLY_API_KEY = 'instantly-key';

let assertions = 0;
function check(fn) { fn(); assertions += 1; }

// Any network access at all is a failure in this suite.
let fetchCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (...args) => { fetchCalls += 1; throw new Error(`FORBIDDEN network access: ${args[0]}`); };

// Any repo access at all is a failure in this suite.
let repoCalls = 0;
const throwingRepo = new Proxy({}, {
  get(_t, prop) {
    return (...args) => {
      repoCalls += 1;
      throw new Error(`FORBIDDEN Google Sheets access: ${String(prop)}(${args[0] ?? ''})`);
    };
  },
});
__setRepoForTests(throwingRepo);

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
}

function livePollReq(headers = {}) {
  return {
    method: 'POST',
    query: { novus_operation: 'instantly-reply-poll' },
    headers: { authorization: BASIC, ...headers },
  };
}

// Asserts the guard blocked BEFORE touching anything external, and leaked nothing.
function assertBlockedCleanly(res, label) {
  const serialised = JSON.stringify(res.body ?? {});
  check(() => assert.equal(fetchCalls, 0, `${label}: zero Instantly reads`));
  check(() => assert.equal(repoCalls, 0, `${label}: zero Google Sheets reads/writes`));
  check(() => assert.ok(!serialised.includes(SECRET), `${label}: secret not echoed`));
  check(() => assert.ok(!serialised.includes('basic-pass'), `${label}: basic pass not echoed`));
  check(() => assert.ok(!serialised.includes('instantly-key'), `${label}: Instantly key not echoed`));
}

// The handler legitimately console.errors when the deliberately-throwing fetch
// blows up on the pass-through case. Capture it instead of printing it, and
// assert the secret never reaches a log line either.
const logged = [];
const originalConsoleError = console.error;
console.error = (...args) => { logged.push(args.map((a) => String(a)).join(' ')); };

function reset() { fetchCalls = 0; repoCalls = 0; }

// --- 1. Env secret missing -> fails closed, 500 config error -----------------
delete process.env.NOVUS_REPLY_POLLER_SECRET;
reset();
let res = fakeRes();
await handler(livePollReq({ [REPLY_POLLER_SECRET_HEADER]: SECRET }), res);

check(() => assert.equal(res.statusCode, 500, 'missing env secret is a config error'));
check(() => assert.equal(res.body.success, false));
check(() => assert.ok(/NOVUS_REPLY_POLLER_SECRET/.test(res.body.error)));
// Even a CORRECT-looking header cannot get in when the env var is absent.
assertBlockedCleanly(res, 'env secret missing');

// --- 2. Header missing entirely ---------------------------------------------
process.env.NOVUS_REPLY_POLLER_SECRET = SECRET;
reset();
res = fakeRes();
await handler(livePollReq(), res);

check(() => assert.equal(res.statusCode, 403, 'missing header is refused'));
check(() => assert.equal(res.body.success, false));
check(() => assert.equal(res.body.error, 'Reply poller secret missing or invalid'));
assertBlockedCleanly(res, 'header missing');

// --- 3. Header wrong --------------------------------------------------------
reset();
const wrongRes = fakeRes();
await handler(livePollReq({ [REPLY_POLLER_SECRET_HEADER]: 'not-the-secret' }), wrongRes);

check(() => assert.equal(wrongRes.statusCode, 403, 'wrong header is refused'));
assertBlockedCleanly(wrongRes, 'header wrong');
// Absent and wrong are indistinguishable: a caller learns nothing from the diff.
check(() => assert.deepEqual(wrongRes.body, res.body, 'missing and wrong are identical responses'));

// An empty-string header, and a right-length-but-wrong value, are both refused.
for (const value of ['', SECRET.slice(0, -1) + 'X', SECRET.toUpperCase()]) {
  reset();
  const r = fakeRes();
  await handler(livePollReq({ [REPLY_POLLER_SECRET_HEADER]: value }), r);
  check(() => assert.equal(r.statusCode, 403, `refused: ${JSON.stringify(value)}`));
  assertBlockedCleanly(r, `variant ${JSON.stringify(value)}`);
}

// --- 4. Basic Auth remains an ADDITIONAL layer -------------------------------
// A correct poller secret with NO Basic Auth is still refused, and is refused
// by the Basic layer first — so the poller secret never stands alone.
reset();
res = fakeRes();
await handler({
  method: 'POST',
  query: { novus_operation: 'instantly-reply-poll' },
  headers: { [REPLY_POLLER_SECRET_HEADER]: SECRET },
}, res);

check(() => assert.equal(res.statusCode, 401, 'Basic Auth still enforced'));
check(() => assert.equal(res.headers['WWW-Authenticate'], 'Basic realm="NOVUS", charset="UTF-8"'));
assertBlockedCleanly(res, 'basic auth missing');

// --- 5. Header correct -> the guard passes and the live poll logic runs ------
// The throwing fetch proves we got PAST both guards: the request reached the
// existing live poll logic and attempted its one Instantly GET. Nothing about
// that logic changed, so this suite only asserts the guard let it through.
reset();
res = fakeRes();
await handler(livePollReq({ [REPLY_POLLER_SECRET_HEADER]: SECRET }), res);

check(() => assert.equal(fetchCalls, 1, 'correct secret reaches the Instantly read'));
check(() => assert.notEqual(res.statusCode, 401, 'not an auth failure'));
check(() => assert.notEqual(res.statusCode, 403, 'not a secret failure'));
// The Instantly stub threw, so the handler reports a generic failure — and even
// that error path must not leak any secret.
const serialised = JSON.stringify(res.body ?? {});
check(() => assert.ok(!serialised.includes(SECRET), 'secret absent from the error path'));
check(() => assert.ok(!serialised.includes('instantly-key')));
check(() => assert.ok(!serialised.includes('basic-pass')));

// --- 6. The dry-run operation does NOT require the poller secret -------------
delete process.env.NOVUS_REPLY_POLLER_SECRET;
reset();
res = fakeRes();
await handler({
  method: 'GET',
  query: { novus_operation: 'instantly-reply-poll-dry-run' },
  headers: { authorization: BASIC },
}, res);

check(() => assert.notEqual(res.statusCode, 403, 'dry-run is not gated by the poller secret'));
check(() => assert.equal(fetchCalls, 1, 'dry-run proceeded to its read-only Instantly GET'));
check(() => assert.ok(!/NOVUS_REPLY_POLLER_SECRET/.test(JSON.stringify(res.body ?? {}))));

// --- 7. Unit-level guard behaviour, independent of the router ---------------
process.env.NOVUS_REPLY_POLLER_SECRET = SECRET;
let r = fakeRes();
check(() => assert.equal(requireReplyPollerSecret({ headers: { [REPLY_POLLER_SECRET_HEADER]: SECRET } }, r), true));
check(() => assert.equal(r.statusCode, null, 'a pass writes no response'));

r = fakeRes();
check(() => assert.equal(requireReplyPollerSecret({ headers: {} }, r), false));
check(() => assert.equal(r.statusCode, 403));

// An unnormalised header bag (raw casing) is still accepted.
r = fakeRes();
check(() => assert.equal(requireReplyPollerSecret({ headers: { 'X-NOVUS-REPLY-POLLER-SECRET': SECRET } }, r), true));

// No headers object at all does not throw.
r = fakeRes();
check(() => assert.equal(requireReplyPollerSecret({}, r), false));
check(() => assert.equal(r.statusCode, 403));

delete process.env.NOVUS_REPLY_POLLER_SECRET;
r = fakeRes();
check(() => assert.equal(requireReplyPollerSecret({ headers: { [REPLY_POLLER_SECRET_HEADER]: SECRET } }, r), false));
check(() => assert.equal(r.statusCode, 500));

// Nothing that was logged may contain any secret.
for (const line of logged) {
  check(() => assert.ok(!line.includes(SECRET), 'secret never logged'));
  check(() => assert.ok(!line.includes('basic-pass'), 'basic pass never logged'));
  check(() => assert.ok(!line.includes('instantly-key'), 'Instantly key never logged'));
}

globalThis.fetch = originalFetch;
console.error = originalConsoleError;
__setRepoForTests(null);
console.log(`\n✅ NOVUS live reply-poller auth self-test passed (${assertions} focused assertions).`);
