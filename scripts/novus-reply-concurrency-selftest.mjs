// Hermetic NOVUS reply-pipeline CONCURRENCY tests.
// Run: npm run novus:reply-concurrency-selftest
//
// WHAT THIS PROVES, AND WHY IT NEEDS ITS OWN SUITE.
//
// Every other selftest in this repo runs one caller at a time, which is exactly
// the condition under which the old guards looked correct: an execution-local
// Set, a read-then-append against Sheets, and per-ROW markers in REPLY_EVENTS
// all behave perfectly in sequence and all fail together the moment two Vercel
// instances overlap. This file runs the real functions CONCURRENTLY and asserts
// on the only things that actually matter — how many rows were appended, and
// how many POSTs reached the Instantly transport.
//
// THE RACE IS REAL, NOT SIMULATED. A two-party barrier holds both callers at
// the exact point where the old code lost: both have read REPLY_EVENTS, both
// have swept Instantly, and neither has written anything yet. Only then are
// they released. Without the claim in lib/reply-claim.mjs every one of these
// cases produces two rows or two sends; the assertions below are what that
// difference looks like.
//
// Fully offline: globalThis.fetch throws by default, the claim store is the
// in-memory one, and Google Sheets is a fake that records every operation.

import assert from 'node:assert/strict';
import handler from '../api/novus/personalisation.js';
import { __setRepoForTests } from '../lib/sheets.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';
import { REPLY_POLLER_SECRET_HEADER } from '../api/novus/_auth.mjs';
import { REPLY_EVENTS_HEADER } from '../lib/reply-router.mjs';
import { OUTBOUND_HEADER } from '../lib/outbound.mjs';
import { pollInstantlyReplies } from '../lib/instantly-reply-poll.mjs';
import {
  executeSendDemo,
  INSTANTLY_REPLY_URL,
  AMBIGUOUS_ERROR,
  SEND_DEMO_LIVE_CONFIRMATION,
} from '../lib/reply-send-demo.mjs';
import {
  createMemoryClaimStore,
  createUpstashClaimStore,
  __setClaimStoreForTests,
  replyClaimKey,
  sendClaimKey,
  claimStoreUnavailableError,
  isClaimStoreConfigured,
  REPLY_CLAIM_TTL_SECONDS,
  SEND_CLAIM_TTL_SECONDS,
  RELEASE_LUA,
} from '../lib/reply-claim.mjs';

const originalFetch = globalThis.fetch;
globalThis.fetch = (...args) => { throw new Error(`FORBIDDEN network access: ${args[0]}`); };

let assertions = 0;
let failures = 0;
function check(label, fn) {
  try { fn(); assertions += 1; } catch (err) {
    failures += 1;
    console.error(`  ✗ ${label}\n    ${err.message}`);
  }
}
function section(title) { console.log(`\n--- ${title} ---`); }

// --- Env -------------------------------------------------------------------
const SECRET = 'poller-secret-do-not-echo';
process.env.NOVUS_BASIC_AUTH_USER = 'novus';
process.env.NOVUS_BASIC_AUTH_PASS = 'basic-pass';
process.env.NOVUS_REPLY_POLLER_SECRET = SECRET;
process.env.INSTANTLY_REPLY_API_KEY = 'instantly-key';
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
const AUTH_HEADERS = {
  authorization: `Basic ${Buffer.from('novus:basic-pass').toString('base64')}`,
  [REPLY_POLLER_SECRET_HEADER]: SECRET,
};

// --- Fixtures ---------------------------------------------------------------
const LEAD = 'prospect@example.com';
const LEAD_2 = 'other@example.com';
const EACCOUNT = 'joe@novushq.co.uk';
const THREAD = 'thread-1';
const THREAD_2 = 'thread-2';
const EMAIL_ID = 'email-uuid-1';
const EMAIL_ID_2 = 'email-uuid-2';
const DEMO_URL = 'https://demo.getnovus.co.uk/test-1';
const DEMO_URL_2 = 'https://demo.getnovus.co.uk/test-2';
const NOW = '2026-09-01T10:00:00.000Z';

function rawEmail({ id, threadId, leadEmail, ueType = 2, body, timestamp = '2026-09-01T09:00:00.000Z' }) {
  const inbound = ueType === 2;
  return {
    id,
    timestamp_email: timestamp,
    subject: 'Re: TEST',
    from_address_email: inbound ? leadEmail : EACCOUNT,
    to_address_email_list: inbound ? EACCOUNT : leadEmail,
    lead: leadEmail,
    thread_id: threadId,
    eaccount: EACCOUNT,
    ue_type: ueType,
    content_preview: body,
    is_auto_reply: false,
  };
}

const REPLY_1 = rawEmail({ id: EMAIL_ID, threadId: THREAD, leadEmail: LEAD, body: 'MARKER_SEND_DEMO yes please send it' });
const REPLY_2 = rawEmail({ id: EMAIL_ID_2, threadId: THREAD_2, leadEmail: LEAD_2, body: 'MARKER_SEND_DEMO yes please send it' });
const NOVUS_OFFER_1 = rawEmail({ id: 'novus-1', threadId: THREAD, leadEmail: LEAD, ueType: 1, body: 'We sent an enquiry through. Want me to send the breakdown?', timestamp: '2026-09-01T08:00:00.000Z' });
const NOVUS_OFFER_2 = rawEmail({ id: 'novus-2', threadId: THREAD_2, leadEmail: LEAD_2, ueType: 1, body: 'We sent an enquiry through. Want me to send the breakdown?', timestamp: '2026-09-01T08:00:00.000Z' });
// Our own demo reply, as Instantly reports it on a LATER sweep.
const NOVUS_DEMO_SENT_1 = rawEmail({ id: 'novus-demo-1', threadId: THREAD, leadEmail: LEAD, ueType: 1, body: `Absolutely — here it is: ${DEMO_URL} I’ve based it on what happened after the enquiry we sent through. Joe`, timestamp: '2026-09-01T10:00:01.000Z' });

__setAiCallerForTests(async ({ prompt }) => {
  if (prompt.includes('MARKER_SEND_DEMO')) {
    return { classification: 'POSITIVE_SEND_DEMO', confidence: 0.95, reason: 'asks for the material' };
  }
  return { classification: 'OTHER_UNCLEAR', confidence: 0.5, reason: 'unhandled fixture' };
});

function outboundRecord({ id = 'obd_1', email = LEAD, demoUrl = DEMO_URL, slug = 'test-1', rowNumber = 2 } = {}) {
  const obj = Object.fromEntries(OUTBOUND_HEADER.map((k) => [k, '']));
  return {
    rowNumber,
    obj: { ...obj, outbound_id: id, agency_id: 'ag_1', outreach_contact_email: email, outbound_status: 'SENT', demo_slug: slug, demo_url: demoUrl },
  };
}

function replyEventRow(overrides = {}) {
  const row = Object.fromEntries(REPLY_EVENTS_HEADER.map((k) => [k, '']));
  return {
    ...row,
    reply_event_id: 'rev_1',
    instantly_email_id: EMAIL_ID,
    agency_id: 'ag_1',
    outreach_id: 'obd_1',
    lead_email: LEAD,
    thread_id: THREAD,
    received_at: '2026-09-01T09:00:00.000Z',
    subject: 'Re: TEST',
    body_text: 'yes please send it',
    cleaned_reply_text: 'yes please send it',
    is_auto_reply: 'FALSE',
    classification: 'POSITIVE_SEND_DEMO',
    confidence: '0.95',
    suppression_type: 'NONE',
    next_action: 'SEND_DEMO',
    priority: 'HIGH',
    processed_at: '2026-09-01T09:01:00.000Z',
    action_status: 'PENDING',
    classifier_reason: 'asks for the material',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A TWO-PARTY BARRIER. This is what makes these tests a genuine race rather
// than two calls that merely happen to be in flight: both callers are held at
// the chosen point until BOTH have arrived, so neither can have observed the
// other's write. Releasing them together reproduces exactly the interleaving
// that produced duplicate rows and duplicate sends in production.
// ---------------------------------------------------------------------------
function makeBarrier(parties) {
  let arrived = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return async function wait() {
    arrived += 1;
    if (arrived >= parties) release();
    await gate;
  };
}

// --- The fake sheet, shared by every concurrent caller ----------------------
function makeSharedRepo({ outbound = [outboundRecord()], replyEvents = [], onGetTable = null } = {}) {
  const header = [...REPLY_EVENTS_HEADER];
  const rows = replyEvents.map((r) => header.map((c) => String(r[c] ?? '')));
  const ops = [];
  const rowObject = (r) => Object.fromEntries(header.map((c, i) => [c, r[i]]));

  return {
    ops,
    rows,
    rowsAsObjects: () => rows.map(rowObject),
    repo: {
      async getRecords(tab) {
        ops.push(`getRecords:${tab}`);
        if (tab === 'OUTBOUND') return outbound;
        throw new Error(`unexpected getRecords ${tab}`);
      },
      async getTable(tab) {
        ops.push(`getTable:${tab}`);
        if (tab !== 'REPLY_EVENTS') throw new Error(`unexpected getTable ${tab}`);
        // The snapshot is taken BEFORE the barrier, so both callers hold the
        // same pre-write view of REPLY_EVENTS — the production race exactly.
        const snapshot = rows.map((r) => [...r]);
        if (onGetTable) await onGetTable();
        return { header, rows: snapshot };
      },
      async findById(tab, column, id) {
        ops.push(`findById:${tab}`);
        if (tab !== 'REPLY_EVENTS') throw new Error(`unexpected findById ${tab}`);
        const idx = header.indexOf(column);
        const i = rows.findIndex((r) => String(r[idx]) === String(id));
        return i < 0 ? null : { rowNumber: i + 2, obj: rowObject(rows[i]) };
      },
      async appendRecord(tab, row) {
        ops.push(`appendRecord:${tab}`);
        if (tab !== 'REPLY_EVENTS') throw new Error(`FORBIDDEN appendRecord ${tab}`);
        rows.push(header.map((c) => String(row[c] ?? '')));
      },
      async writeCellsBatch(cells) {
        ops.push('writeCellsBatch');
        for (const cell of cells) {
          if (cell.tab !== 'REPLY_EVENTS') throw new Error(`FORBIDDEN write ${cell.tab}`);
          rows[cell.rowNumber - 2][cell.columnNumber - 1] = String(cell.value);
        }
      },
      appendRowsBatch() { throw new Error('FORBIDDEN appendRowsBatch'); },
      updateById() { throw new Error('FORBIDDEN updateById'); },
      updateCell() { throw new Error('FORBIDDEN updateCell'); },
    },
  };
}

// --- The fake Instantly -----------------------------------------------------
function makeInstantly({ sweep = [], reply = null, onGet = null } = {}) {
  const requests = [];
  const impl = async (url, options = {}) => {
    const method = options.method || 'GET';
    requests.push({ url: String(url), method, body: options.body ? JSON.parse(options.body) : null });
    if (method === 'GET') {
      if (onGet) await onGet();
      return { ok: true, status: 200, text: async () => JSON.stringify({ items: sweep }) };
    }
    if (String(url) !== INSTANTLY_REPLY_URL) throw new Error(`unexpected POST to ${url}`);
    if (typeof reply === 'function') return reply();
    return reply;
  };
  return { requests, impl, posts: () => requests.filter((r) => r.method === 'POST') };
}

const OK_RESPONSE = {
  ok: true, status: 200,
  text: async () => JSON.stringify({ id: 'sent-uuid-1', thread_id: THREAD, message_id: '<m@novushq.co.uk>' }),
};

function freshClaims(opts) {
  const store = createMemoryClaimStore(opts);
  __setClaimStoreForTests(store);
  return store;
}

function fakeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    end() { return this; },
  };
}
function pollRequest(query = {}) {
  return { method: 'POST', query: { novus_operation: 'instantly-reply-poll', ...query }, headers: AUTH_HEADERS };
}
function sendDemoRequest(replyEventId) {
  // The manual route's fourth gate: the deliberate-action confirmation. Passed
  // here so this test exercises the real route all the way to the send, not its
  // 400.
  return {
    method: 'POST',
    query: {
      novus_operation: 'send-demo',
      reply_event_id: replyEventId,
      confirm: SEND_DEMO_LIVE_CONFIRMATION,
    },
    headers: AUTH_HEADERS,
  };
}

// ===========================================================================
section('1. Two simultaneous poll passes, same instantly_email_id -> ONE row, ONE processing path');
{
  freshClaims();
  // Both passes are held inside loadProcessedReplyEventIds, so each has read
  // REPLY_EVENTS and seen it empty before either can append. This is precisely
  // the interleaving the execution-local Set cannot see.
  const barrier = makeBarrier(2);
  const { repo, rows, ops } = makeSharedRepo({ onGetTable: barrier });
  const instantly = makeInstantly({ sweep: [REPLY_1, NOVUS_OFFER_1] });

  const opts = { repo, apiKey: 'k', dryRun: false, classify: false, fetchImpl: instantly.impl, now: NOW };
  const [a, b] = await Promise.all([pollInstantlyReplies(opts), pollInstantlyReplies(opts)]);

  check('exactly one REPLY_EVENTS row exists', () => assert.equal(rows.length, 1));
  check('exactly one appendRecord reached the sheet', () => assert.equal(ops.filter((o) => o === 'appendRecord:REPLY_EVENTS').length, 1));
  check('exactly one pass persisted', () => assert.equal(a.persisted + b.persisted, 1));
  check('the other pass recorded a claim conflict', () => assert.equal(a.claim_conflicts + b.claim_conflicts, 1));
  check('no claim-store errors', () => assert.equal(a.claim_errors + b.claim_errors, 0));
  check('no append failures', () => assert.equal(a.failed + b.failed, 0));

  const loser = a.persisted === 0 ? a : b;
  const winner = a.persisted === 1 ? a : b;
  check('the loser produced NO event object', () => assert.equal(loser.events.length, 0));
  check('the winner produced exactly one event', () => assert.equal(winner.events.length, 1));
  const skip = loser.skipped.find((s) => s.reason === 'claim_conflict');
  check('the loser skipped with reason claim_conflict', () => assert.ok(skip));
  check('the conflict names the email and is retryable', () => assert.equal(skip.instantly_email_id, EMAIL_ID) || assert.equal(skip.will_retry_next_poll, true));
  check('the conflict carries no error (it is contention, not failure)', () => assert.equal(skip.error, null));
  console.log(`  rows=${rows.length} persisted=${a.persisted + b.persisted} claim_conflicts=${a.claim_conflicts + b.claim_conflicts}`);
}

// ===========================================================================
section('2. Two simultaneous SEND_DEMO executions, same email -> exactly ONE transport send');
{
  freshClaims();
  // The duplicate-row scenario the old markers could not see: two DIFFERENT
  // reply_event_ids carrying the SAME instantly_email_id. notes,
  // action_completed_at and action_status are blank on both, so every per-row
  // guard passes on both. Only a claim keyed on the EMAIL collapses them.
  const barrier = makeBarrier(2);
  const { repo, rowsAsObjects } = makeSharedRepo({
    replyEvents: [replyEventRow({ reply_event_id: 'rev_1' }), replyEventRow({ reply_event_id: 'rev_2' })],
  });
  const instantly = makeInstantly({ sweep: [REPLY_1, NOVUS_OFFER_1], reply: OK_RESPONSE, onGet: barrier });

  const [r1, r2] = await Promise.all([
    executeSendDemo({ repo, replyEventId: 'rev_1', apiKey: 'k', fetchImpl: instantly.impl, now: NOW }),
    executeSendDemo({ repo, replyEventId: 'rev_2', apiKey: 'k', fetchImpl: instantly.impl, now: NOW }),
  ]);

  check('exactly one POST reached Instantly', () => assert.equal(instantly.posts().length, 1));
  check('exactly one call reports sent', () => assert.equal([r1, r2].filter((r) => r.sent).length, 1));
  const blocked = [r1, r2].find((r) => !r.sent);
  check('the loser is blocked as CONCURRENT_SEND_IN_PROGRESS', () => assert.equal(blocked.blocked_reason, 'CONCURRENT_SEND_IN_PROGRESS'));
  check('the loser is not marked eligible', () => assert.equal(blocked.eligible, false));
  check('the loser wrote NOTHING to the row', () => assert.equal(blocked.row_update, null));
  check('the loser is not an attempted send', () => assert.equal(blocked.send_outcome, null));
  check('the loser does not claim it would_send', () => assert.equal(blocked.would_send, false));

  // A blocked claim must not stamp FAILED over a row whose real outcome is
  // being decided by the other instance.
  const stored = rowsAsObjects();
  const completed = stored.filter((r) => r.action_status === 'COMPLETED');
  const untouched = stored.filter((r) => r.action_status === 'PENDING');
  check('exactly one row COMPLETED', () => assert.equal(completed.length, 1));
  check('the losing row is left PENDING, not FAILED', () => assert.equal(untouched.length, 1));
  console.log(`  posts=${instantly.posts().length} winner=${[r1, r2].find((r) => r.sent).reply_event_id} loser=${blocked.blocked_reason}`);
}

// ===========================================================================
section('3. Manual route + automatic execution overlapping -> exactly ONE send');
{
  freshClaims();
  // The manual side is the REAL HTTP route (POST send-demo). The automatic side
  // is executeSendDemo called exactly as runAutoSendDemo calls it — the auto
  // path has no send of its own, it delegates to this identical function, so
  // guarding inside it is what covers both callers at once.
  const barrier = makeBarrier(2);
  const { repo, rowsAsObjects } = makeSharedRepo({
    replyEvents: [replyEventRow({ reply_event_id: 'rev_manual' }), replyEventRow({ reply_event_id: 'rev_auto' })],
  });
  const instantly = makeInstantly({ sweep: [REPLY_1, NOVUS_OFFER_1], reply: OK_RESPONSE, onGet: barrier });
  __setRepoForTests(repo);
  globalThis.fetch = instantly.impl;

  const res = fakeRes();
  const [, auto] = await Promise.all([
    handler(sendDemoRequest('rev_manual'), res),
    executeSendDemo({ repo, replyEventId: 'rev_auto', apiKey: 'k', fetchImpl: instantly.impl, now: NOW }),
  ]);
  globalThis.fetch = (...args) => { throw new Error(`FORBIDDEN network access: ${args[0]}`); };

  const manual = res.body;
  check('the manual route answered 200', () => assert.equal(res.statusCode, 200));
  check('exactly one POST reached Instantly', () => assert.equal(instantly.posts().length, 1));
  check('exactly one of manual/auto sent', () => assert.equal([manual.sent, auto.sent].filter(Boolean).length, 1));
  const loser = manual.sent ? auto : manual;
  check('the loser is blocked as CONCURRENT_SEND_IN_PROGRESS', () => assert.equal(loser.blocked_reason, 'CONCURRENT_SEND_IN_PROGRESS'));
  check('exactly one row COMPLETED', () => assert.equal(rowsAsObjects().filter((r) => r.action_status === 'COMPLETED').length, 1));
  console.log(`  posts=${instantly.posts().length} manual.sent=${manual.sent} auto.sent=${auto.sent}`);
}

// ===========================================================================
section('4. Two simultaneous LIVE POLL routes end to end -> one row, one send');
{
  freshClaims();
  // Both real HTTP handlers, including classification and the automatic
  // SEND_DEMO that follows it. This is the scheduled-poll-overlaps-itself case.
  const barrier = makeBarrier(2);
  const { repo, rows } = makeSharedRepo({ onGetTable: barrier });
  const instantly = makeInstantly({ sweep: [REPLY_1, NOVUS_OFFER_1], reply: OK_RESPONSE });
  __setRepoForTests(repo);
  globalThis.fetch = instantly.impl;

  const resA = fakeRes();
  const resB = fakeRes();
  await Promise.all([handler(pollRequest(), resA), handler(pollRequest(), resB)]);
  globalThis.fetch = (...args) => { throw new Error(`FORBIDDEN network access: ${args[0]}`); };

  check('both requests answered 200', () => assert.equal(resA.statusCode + resB.statusCode, 400));
  check('exactly one REPLY_EVENTS row', () => assert.equal(rows.length, 1));
  check('exactly one persisted', () => assert.equal(resA.body.persisted + resB.body.persisted, 1));
  check('one claim conflict surfaced in the response', () => assert.equal(resA.body.claim_conflicts + resB.body.claim_conflicts, 1));
  check('claim_errors surfaced and zero', () => assert.equal(resA.body.claim_errors + resB.body.claim_errors, 0));
  check('exactly one auto-send attempt', () => assert.equal(resA.body.auto_send.length + resB.body.auto_send.length, 1));
  check('exactly one POST reached Instantly', () => assert.equal(instantly.posts().length, 1));
  console.log(`  rows=${rows.length} posts=${instantly.posts().length} conflicts=${resA.body.claim_conflicts + resB.body.claim_conflicts}`);
}

// ===========================================================================
section('5. Different instantly_email_ids never block each other');
{
  freshClaims();
  const barrier = makeBarrier(2);
  const { repo, rows } = makeSharedRepo({
    outbound: [outboundRecord(), outboundRecord({ id: 'obd_2', email: LEAD_2, demoUrl: DEMO_URL_2, slug: 'test-2', rowNumber: 3 })],
    onGetTable: barrier,
  });
  const instantly = makeInstantly({ sweep: [REPLY_1, NOVUS_OFFER_1, REPLY_2, NOVUS_OFFER_2], reply: OK_RESPONSE });
  __setRepoForTests(repo);
  globalThis.fetch = instantly.impl;

  // Two concurrent passes, each seeing BOTH replies. Distinct keys, so each
  // reply is claimed exactly once — the guard must serialise per email, never
  // per pass. A global lock would wrongly reduce this to one row.
  const resA = fakeRes();
  const resB = fakeRes();
  await Promise.all([handler(pollRequest(), resA), handler(pollRequest(), resB)]);
  globalThis.fetch = (...args) => { throw new Error(`FORBIDDEN network access: ${args[0]}`); };

  check('both replies produced a row', () => assert.equal(rows.length, 2));
  check('two persisted in total', () => assert.equal(resA.body.persisted + resB.body.persisted, 2));
  check('two claim conflicts (one per email, from the losing pass)', () => assert.equal(resA.body.claim_conflicts + resB.body.claim_conflicts, 2));
  check('two distinct sends, one per prospect', () => assert.equal(instantly.posts().length, 2));
  const urls = instantly.posts().map((p) => p.body.body.text);
  check('each prospect got their OWN demo url', () => assert.equal(
    new Set([urls.some((t) => t.includes(DEMO_URL)), urls.some((t) => t.includes(DEMO_URL_2))]).has(false), false,
  ));
  console.log(`  rows=${rows.length} posts=${instantly.posts().length}`);
}

// ===========================================================================
section('6. Claim keys are distinct per email and per purpose');
{
  check('reply key is namespaced by email', () => assert.equal(replyClaimKey(EMAIL_ID), `novus:reply:${EMAIL_ID}`));
  check('send key is namespaced by email', () => assert.equal(sendClaimKey(EMAIL_ID), `novus:send:${EMAIL_ID}`));
  check('reply and send keys never collide', () => assert.notEqual(replyClaimKey(EMAIL_ID), sendClaimKey(EMAIL_ID)));
  check('keys are trimmed', () => assert.equal(replyClaimKey(`  ${EMAIL_ID}  `), `novus:reply:${EMAIL_ID}`));
  check('a blank id is refused rather than claimed globally', () => assert.throws(() => replyClaimKey('   ')));
  check('a blank id is refused for sends too', () => assert.throws(() => sendClaimKey('')));
}

// ===========================================================================
section('7. Expired / stale claims recover safely (a crashed invocation cannot block forever)');
{
  // A claim taken by an invocation that then died. Time advances past the TTL
  // and the work must become claimable again — that is the whole reason both
  // claims carry an expiry rather than being deleted on a happy path only.
  let clock = 1_000_000;
  const store = freshClaims({ now: () => clock });

  const first = await store.acquire(replyClaimKey(EMAIL_ID), REPLY_CLAIM_TTL_SECONDS);
  check('the crashed invocation held the claim', () => assert.equal(first.acquired, true));

  const contended = await store.acquire(replyClaimKey(EMAIL_ID), REPLY_CLAIM_TTL_SECONDS);
  check('while live, the claim blocks', () => assert.equal(contended.acquired, false));

  clock += (REPLY_CLAIM_TTL_SECONDS * 1000) - 1000; // one second short of expiry
  const stillHeld = await store.acquire(replyClaimKey(EMAIL_ID), REPLY_CLAIM_TTL_SECONDS);
  check('it holds right up to the TTL', () => assert.equal(stillHeld.acquired, false));

  clock += 2000; // past expiry
  const recovered = await store.acquire(replyClaimKey(EMAIL_ID), REPLY_CLAIM_TTL_SECONDS);
  check('after the TTL the email is claimable again', () => assert.equal(recovered.acquired, true));

  // The dead invocation's token must not delete the live claim that replaced it.
  const stolen = await store.release(replyClaimKey(EMAIL_ID), first.token);
  check('a stale token cannot release a newer claim', () => assert.equal(stolen, false));
  const own = await store.release(replyClaimKey(EMAIL_ID), recovered.token);
  check('the current holder can release its own claim', () => assert.equal(own, true));

  // And end to end: a stale claim left behind does not permanently strand the
  // reply — the next pass appends it.
  const store2 = freshClaims({ now: () => clock });
  await store2.acquire(replyClaimKey(EMAIL_ID), REPLY_CLAIM_TTL_SECONDS);
  const { repo, rows } = makeSharedRepo();
  const instantly = makeInstantly({ sweep: [REPLY_1, NOVUS_OFFER_1] });
  const opts = { repo, apiKey: 'k', dryRun: false, classify: false, fetchImpl: instantly.impl, now: NOW };

  const blockedPass = await pollInstantlyReplies(opts);
  check('while the stale claim lives the reply is deferred, not dropped', () => assert.equal(blockedPass.claim_conflicts, 1));
  check('nothing was appended', () => assert.equal(rows.length, 0));

  clock += (REPLY_CLAIM_TTL_SECONDS * 1000) + 1000;
  const recoveredPass = await pollInstantlyReplies(opts);
  check('once the claim expires the reply is processed normally', () => assert.equal(recoveredPass.persisted, 1));
  check('and the row finally exists', () => assert.equal(rows.length, 1));
  console.log(`  deferred then recovered; rows=${rows.length}`);
}

// ===========================================================================
section('8. A successful send is NOT re-sendable the moment the claim lapses');
{
  // Requirement: releasing on success would reopen the window. The claim is
  // held to expiry, and by the time it lapses the Sheet markers and the
  // Instantly thread evidence have taken over. Both are proven here with the
  // claim deliberately cleared, so neither can be masked by it.
  freshClaims();
  const { repo, rowsAsObjects } = makeSharedRepo({ replyEvents: [replyEventRow({ reply_event_id: 'rev_1' })] });
  const first = makeInstantly({ sweep: [REPLY_1, NOVUS_OFFER_1], reply: OK_RESPONSE });
  const sent = await executeSendDemo({ repo, replyEventId: 'rev_1', apiKey: 'k', fetchImpl: first.impl, now: NOW });
  check('the first send lands', () => assert.equal(sent.sent, true));
  check('the claim is NOT released on success', () => assert.equal(sent.claim_released, false));
  check('the row is COMPLETED', () => assert.equal(rowsAsObjects()[0].action_status, 'COMPLETED'));

  // Claim wiped: the TTL has lapsed. Nothing from lib/reply-claim.mjs is
  // helping from this line on.
  freshClaims();
  const second = makeInstantly({ sweep: [REPLY_1, NOVUS_OFFER_1, NOVUS_DEMO_SENT_1], reply: OK_RESPONSE });
  const again = await executeSendDemo({ repo, replyEventId: 'rev_1', apiKey: 'k', fetchImpl: second.impl, now: '2026-09-01T11:00:00.000Z' });
  check('no second POST', () => assert.equal(second.posts().length, 0));
  // BOTH pre-existing layers fire on their own: the row's notes marker and
  // action_completed_at (ALREADY_EXECUTED) and the demo link now visible in the
  // thread (DEMO_ALREADY_SENT). DEMO_ALREADY_SENT simply outranks the other in
  // the BLOCKED_REASONS contract order.
  check('the sheet markers still block', () => assert.ok(again.blocked_reasons.includes('ALREADY_EXECUTED')));
  check('the thread evidence still blocks', () => assert.ok(again.blocked_reasons.includes('DEMO_ALREADY_SENT')));
  check('and the claim is NOT what blocked it', () => assert.equal(
    again.blocked_reasons.some((r) => r === 'CONCURRENT_SEND_IN_PROGRESS' || r === 'CLAIM_STORE_UNAVAILABLE'), false,
  ));
  console.log(`  after claim expiry: posts=${second.posts().length} reasons=${again.blocked_reasons.join(',')}`);
}

// ===========================================================================
section('9. Ambiguous send whose message actually landed: thread evidence still blocks the duplicate');
{
  // The AMBIGUOUS path leaves the row FAILED and retryable, with NO notes
  // marker — so the sheet cannot help. After the claim lapses the ONLY thing
  // standing between the prospect and a second demo is demoSentEvidence. That
  // layer must survive this change untouched.
  freshClaims();
  const { repo, rowsAsObjects } = makeSharedRepo({ replyEvents: [replyEventRow({ reply_event_id: 'rev_1' })] });
  const attempt1 = makeInstantly({ sweep: [REPLY_1, NOVUS_OFFER_1], reply: () => { throw new Error('socket hang up'); } });
  const ambiguous = await executeSendDemo({ repo, replyEventId: 'rev_1', apiKey: 'k', fetchImpl: attempt1.impl, now: NOW });

  check('the attempt is classified AMBIGUOUS', () => assert.equal(ambiguous.send_outcome, 'AMBIGUOUS'));
  check('an ambiguous result does NOT release the claim', () => assert.equal(ambiguous.claim_released, false));
  check('the row is FAILED and retryable', () => assert.equal(rowsAsObjects()[0].action_status, 'FAILED'));
  check('no send marker was written', () => assert.equal(rowsAsObjects()[0].notes, ''));
  check('the error is the ambiguous prefix', () => assert.equal(rowsAsObjects()[0].error.startsWith(AMBIGUOUS_ERROR), true));

  // Claim lapsed; the send had in fact landed and now appears in the sweep.
  freshClaims();
  const attempt2 = makeInstantly({ sweep: [REPLY_1, NOVUS_OFFER_1, NOVUS_DEMO_SENT_1], reply: OK_RESPONSE });
  const retry = await executeSendDemo({ repo, replyEventId: 'rev_1', apiKey: 'k', fetchImpl: attempt2.impl, now: '2026-09-01T11:00:00.000Z' });
  check('no second POST', () => assert.equal(attempt2.posts().length, 0));
  check('blocked by DEMO_ALREADY_SENT, from thread evidence alone', () => assert.equal(retry.blocked_reason, 'DEMO_ALREADY_SENT'));
  check('the evidence layer reports SENT', () => assert.equal(retry.demo_sent_evidence, 'SENT'));

  // The contrast: an ambiguous result that did NOT land is still redrivable, so
  // the claim has not made FAILED terminal.
  freshClaims();
  const { repo: repo2, rowsAsObjects: rows2 } = makeSharedRepo({
    replyEvents: [replyEventRow({ reply_event_id: 'rev_1', action_status: 'FAILED', error: `${AMBIGUOUS_ERROR}: transport socket hang up` })],
  });
  const attempt3 = makeInstantly({ sweep: [REPLY_1, NOVUS_OFFER_1], reply: OK_RESPONSE });
  const redriven = await executeSendDemo({ repo: repo2, replyEventId: 'rev_1', apiKey: 'k', fetchImpl: attempt3.impl, now: NOW });
  check('a genuinely unsent ambiguous row still redrives', () => assert.equal(redriven.sent, true));
  check('and completes', () => assert.equal(rows2()[0].action_status, 'COMPLETED'));
  console.log(`  landed -> ${retry.blocked_reason} (0 posts); not landed -> redriven`);
}

// ===========================================================================
section('10. A REJECTED (4xx) send releases its claim so a retry is not stalled');
{
  freshClaims();
  const { repo } = makeSharedRepo({ replyEvents: [replyEventRow({ reply_event_id: 'rev_1' })] });
  const rejected = makeInstantly({
    sweep: [REPLY_1, NOVUS_OFFER_1],
    reply: { ok: false, status: 404, text: async () => JSON.stringify({ error: 'unknown eaccount' }) },
  });
  const result = await executeSendDemo({ repo, replyEventId: 'rev_1', apiKey: 'k', fetchImpl: rejected.impl, now: NOW });

  check('Instantly refused before sending', () => assert.equal(result.send_outcome, 'REJECTED'));
  check('nothing was sent', () => assert.equal(result.sent, false));
  // 4xx means definitively not sent, so holding the key for 15 minutes would
  // stall a fix-and-retry for no safety benefit at all.
  check('the claim WAS released', () => assert.equal(result.claim_released, true));
  check('no release error', () => assert.equal(result.claim_release_error, null));

  // Proof it is genuinely retryable straight away, on the SAME claim store.
  const retryOk = makeInstantly({ sweep: [REPLY_1, NOVUS_OFFER_1], reply: OK_RESPONSE });
  const retry = await executeSendDemo({ repo, replyEventId: 'rev_1', apiKey: 'k', fetchImpl: retryOk.impl, now: NOW });
  check('an immediate retry is allowed and sends', () => assert.equal(retry.sent, true));
  console.log(`  rejected -> released -> retried and sent`);
}

// ===========================================================================
section('11. FAIL CLOSED: no claim store configured');
{
  __setClaimStoreForTests(null);
  const savedUrl = process.env.KV_REST_API_URL;
  const savedToken = process.env.KV_REST_API_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;

  check('isClaimStoreConfigured reports false', () => assert.equal(isClaimStoreConfigured(), false));
  check('a half-configured store is also false', () => assert.equal(isClaimStoreConfigured({ KV_REST_API_URL: 'https://x', KV_REST_API_TOKEN: '' }), false));

  // The LIVE poll throws BEFORE the Instantly GET and before any Sheets call.
  const { repo, ops, rows } = makeSharedRepo();
  const instantly = makeInstantly({ sweep: [REPLY_1, NOVUS_OFFER_1] });
  let threw = null;
  try {
    await pollInstantlyReplies({ repo, apiKey: 'k', dryRun: false, classify: false, fetchImpl: instantly.impl, now: NOW });
  } catch (err) { threw = err; }
  check('the live poll refuses to run', () => assert.ok(threw));
  check('it is flagged as a claim-store failure', () => assert.equal(threw.claim_store_unavailable, true));
  check('the message names both env vars', () => assert.match(threw.message, /KV_REST_API_URL \/ KV_REST_API_TOKEN/));
  check('ZERO Instantly requests were made', () => assert.equal(instantly.requests.length, 0));
  check('ZERO Sheets operations were made', () => assert.equal(ops.length, 0));
  check('nothing was appended', () => assert.equal(rows.length, 0));

  // The HTTP route turns that into a 500 rather than a silent unguarded pass.
  __setRepoForTests(repo);
  globalThis.fetch = instantly.impl;
  const res = fakeRes();
  await handler(pollRequest(), res);
  globalThis.fetch = (...args) => { throw new Error(`FORBIDDEN network access: ${args[0]}`); };
  check('the route answers 500', () => assert.equal(res.statusCode, 500));
  check('and says why', () => assert.match(res.body.error, /KV_REST_API_URL/));
  check('success is false', () => assert.equal(res.body.success, false));

  // The live SEND path refuses too, and sends nothing.
  const { repo: sendRepo } = makeSharedRepo({ replyEvents: [replyEventRow({ reply_event_id: 'rev_1' })] });
  const sendStub = makeInstantly({ sweep: [REPLY_1, NOVUS_OFFER_1], reply: OK_RESPONSE });
  const blocked = await executeSendDemo({ repo: sendRepo, replyEventId: 'rev_1', apiKey: 'k', fetchImpl: sendStub.impl, now: NOW });
  check('the send is blocked as CLAIM_STORE_UNAVAILABLE', () => assert.equal(blocked.blocked_reason, 'CLAIM_STORE_UNAVAILABLE'));
  check('nothing was sent', () => assert.equal(blocked.sent, false));
  check('ZERO POSTs', () => assert.equal(sendStub.posts().length, 0));
  check('the row was not written', () => assert.equal(blocked.row_update, null));

  // DRY RUN is deliberately unaffected: it appends nothing, so it must not
  // depend on KV being reachable.
  const { repo: dryRepo } = makeSharedRepo();
  const dryStub = makeInstantly({ sweep: [REPLY_1, NOVUS_OFFER_1] });
  const dry = await pollInstantlyReplies({ repo: dryRepo, apiKey: 'k', dryRun: true, classify: false, fetchImpl: dryStub.impl, now: NOW });
  check('the dry run still works with no claim store', () => assert.equal(dry.events.length, 1));
  check('and it wrote nothing', () => assert.equal(dry.persisted, 0));

  if (savedUrl !== undefined) process.env.KV_REST_API_URL = savedUrl;
  if (savedToken !== undefined) process.env.KV_REST_API_TOKEN = savedToken;
  console.log('  unconfigured KV: poll 500s, send blocked, dry run unaffected');
}

// ===========================================================================
section('12. FAIL CLOSED: the claim store is configured but unreachable');
{
  // A KV outage must look like "not claimed", never like "claimed". The work is
  // deferred and visibly counted, not processed unguarded.
  __setClaimStoreForTests(createMemoryClaimStore({ failWith: 'kv_status=503 upstream unavailable' }));
  const { repo, rows } = makeSharedRepo();
  const instantly = makeInstantly({ sweep: [REPLY_1, NOVUS_OFFER_1], reply: OK_RESPONSE });
  const summary = await pollInstantlyReplies({ repo, apiKey: 'k', dryRun: false, classify: false, fetchImpl: instantly.impl, now: NOW });

  check('nothing appended', () => assert.equal(rows.length, 0));
  check('nothing persisted', () => assert.equal(summary.persisted, 0));
  check('counted as a claim ERROR, not a conflict', () => assert.equal(summary.claim_errors, 1));
  check('and not miscounted as contention', () => assert.equal(summary.claim_conflicts, 0));
  const skip = summary.skipped.find((s) => s.reason === 'claim_store_error');
  check('the skip records the store failure', () => assert.match(skip.error, /503/));
  check('and is retryable', () => assert.equal(skip.will_retry_next_poll, true));

  const { repo: sendRepo } = makeSharedRepo({ replyEvents: [replyEventRow({ reply_event_id: 'rev_1' })] });
  const sendStub = makeInstantly({ sweep: [REPLY_1, NOVUS_OFFER_1], reply: OK_RESPONSE });
  const blocked = await executeSendDemo({ repo: sendRepo, replyEventId: 'rev_1', apiKey: 'k', fetchImpl: sendStub.impl, now: NOW });
  check('a KV outage blocks the send', () => assert.equal(blocked.blocked_reason, 'CLAIM_STORE_UNAVAILABLE'));
  check('ZERO POSTs during a KV outage', () => assert.equal(sendStub.posts().length, 0));
  console.log(`  kv outage: claim_errors=${summary.claim_errors} posts=0`);
}

// ===========================================================================
section('13. The Upstash REST contract: exactly SET NX EX, and a compare-and-delete release');
{
  const calls = [];
  const store = createUpstashClaimStore({
    url: 'https://example.upstash.io/',
    token: 'kv-token-do-not-echo',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body) });
      const cmd = JSON.parse(options.body)[0];
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ result: cmd === 'SET' ? 'OK' : 1 }),
      };
    },
  });

  const claim = await store.acquire(replyClaimKey(EMAIL_ID), REPLY_CLAIM_TTL_SECONDS);
  check('the claim is acquired on result OK', () => assert.equal(claim.acquired, true));
  check('the trailing slash is trimmed from the base url', () => assert.equal(calls[0].url, 'https://example.upstash.io'));
  check('authorised as a bearer token', () => assert.equal(calls[0].headers.Authorization, 'Bearer kv-token-do-not-echo'));
  check('the command is SET ... NX EX <ttl>', () => assert.deepEqual(
    [calls[0].body[0], calls[0].body[3], calls[0].body[4], calls[0].body[5]],
    ['SET', 'NX', 'EX', String(REPLY_CLAIM_TTL_SECONDS)],
  ));
  check('the key is the reply claim key', () => assert.equal(calls[0].body[1], `novus:reply:${EMAIL_ID}`));
  check('the value is our own token', () => assert.equal(calls[0].body[2], claim.token));

  await store.release(replyClaimKey(EMAIL_ID), claim.token);
  check('release is an EVAL, not a bare DEL', () => assert.equal(calls[1].body[0], 'EVAL'));
  check('the script is the compare-and-delete', () => assert.equal(calls[1].body[1], RELEASE_LUA));
  check('one key, and our token as the compare argument', () => assert.deepEqual(calls[1].body.slice(2), ['1', `novus:reply:${EMAIL_ID}`, claim.token]));

  // Contention: Upstash answers null when the key is already held.
  const held = createUpstashClaimStore({
    url: 'https://example.upstash.io', token: 't',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ result: null }) }),
  });
  const lost = await held.acquire(sendClaimKey(EMAIL_ID), SEND_CLAIM_TTL_SECONDS);
  check('result null means NOT acquired', () => assert.equal(lost.acquired, false));
  check('and it is contention, not an error', () => assert.equal(lost.error, null));

  // Every failure mode resolves to NOT acquired.
  for (const [name, impl] of [
    ['non-2xx', async () => ({ ok: false, status: 503, text: async () => 'upstream unavailable' })],
    ['transport', async () => { throw new Error('socket hang up'); }],
    ['error payload', async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ error: 'WRONGTYPE' }) })],
    ['garbage body', async () => ({ ok: true, status: 200, text: async () => 'not json' })],
  ]) {
    const broken = createUpstashClaimStore({ url: 'https://example.upstash.io', token: 't', fetchImpl: impl });
    const attempt = await broken.acquire(replyClaimKey(EMAIL_ID), REPLY_CLAIM_TTL_SECONDS);
    check(`${name} is never acquired`, () => assert.equal(attempt.acquired, false));
    check(`${name} never yields a token`, () => assert.equal(attempt.token, null));
  }

  // A missing url/token is a configuration failure at construction, not a
  // silent no-op store.
  check('constructing without a url throws', () => assert.throws(() => createUpstashClaimStore({ url: '', token: 't' })));
  check('constructing without a token throws', () => assert.throws(() => createUpstashClaimStore({ url: 'https://x', token: '  ' })));
  check('the flagged error type is used', () => assert.equal(claimStoreUnavailableError('x').claim_store_unavailable, true));

  // The KV token must never reach a returned value or an error string.
  const secretStore = createUpstashClaimStore({
    url: 'https://example.upstash.io', token: 'SUPER-SECRET-KV-TOKEN',
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'Bearer SUPER-SECRET-KV-TOKEN rejected' }),
  });
  const leaky = await secretStore.acquire(replyClaimKey(EMAIL_ID), 60);
  check('the KV token is never echoed into the result', () => assert.equal(JSON.stringify(leaky).includes('SUPER-SECRET-KV-TOKEN'), false));
  console.log('  SET NX EX + EVAL compare-and-delete verified; no credential echo');
}

// ===========================================================================
globalThis.fetch = originalFetch;
if (failures) {
  console.error(`\n❌ NOVUS reply concurrency selftest FAILED (${failures} failed, ${assertions} passed).`);
  process.exit(1);
}
console.log(`\n✅ NOVUS reply concurrency selftest passed (${assertions} focused assertions).`);
