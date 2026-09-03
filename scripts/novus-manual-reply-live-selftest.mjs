// Phase 3B hermetic live-manual-reply tests. No real network, Sheets or email.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { executeManualReply, MANUAL_REPLY_LIVE_CONFIRMATION } from '../lib/manual-reply-execution.mjs';
import { createMemoryClaimStore, __setClaimStoreForTests } from '../lib/reply-claim.mjs';
import { SALES_MESSAGES_HEADER } from '../lib/sales-messages.mjs';
import { REPLY_EVENTS_HEADER } from '../lib/reply-router.mjs';
import { OUTBOUND_HEADER } from '../lib/outbound.mjs';
import { __setRepoForTests } from '../lib/sheets.mjs';
import handler from '../api/novus/personalisation.js';

const LEAD = 'sam@ashtonwhite.co.uk';
const EACCOUNT = 'joe@novushq.co.uk';
const THREAD = 'thread-1';
const EMAIL_ID = 'email-in-1';
const BODY = 'Hi Sam,\n\nHappy to help.\n\nJoe';
const NOW = '2026-09-02T12:00:00.000Z';

const REPLY = {
  reply_event_id: 'rpl_1', instantly_email_id: EMAIL_ID, agency_id: 'ag_1',
  outreach_id: 'out_1', lead_email: LEAD, campaign_id: 'camp_1', thread_id: THREAD,
  received_at: '2026-09-02T10:00:00.000Z', subject: 'Re: Enquiry', body_text: 'Tell me more',
  cleaned_reply_text: 'Tell me more', classification: 'QUESTION', confidence: '0.2',
  suppression_type: 'NONE', next_action: 'HUMAN_REPLY', action_status: 'PENDING', notes: '', error: '',
};
const OUTBOUND = {
  outbound_id: 'out_1', agency_id: 'ag_1', outreach_contact_email: LEAD,
  outbound_status: 'SENT',
};
const RAW_INBOUND = {
  id: EMAIL_ID, timestamp_email: REPLY.received_at, subject: REPLY.subject,
  from_address_email: LEAD, to_address_email_list: EACCOUNT, lead: LEAD,
  campaign_id: 'camp_1', thread_id: THREAD, eaccount: EACCOUNT, ue_type: 2,
  content_preview: REPLY.body_text,
};

function rows(header, objects) {
  return [header.slice(), ...objects.map((obj) => header.map((column) => obj[column] ?? ''))];
}

function makeRepo({ replies = [REPLY], outbound = [OUTBOUND], failAppend = false, failUpdate = false } = {}) {
  const store = {
    REPLY_EVENTS: rows(REPLY_EVENTS_HEADER, replies),
    OUTBOUND: rows(OUTBOUND_HEADER, outbound),
    SALES_MESSAGES: [SALES_MESSAGES_HEADER.slice(), SALES_MESSAGES_HEADER.map((_, i) => (i === 0 ? 'SCHEMA NOTE' : ''))],
  };
  const calls = { appends: 0, updates: 0 };
  const repo = {
    store, calls,
    async getTable(tab) {
      if (!store[tab]) throw new Error(`missing ${tab}`);
      return { header: store[tab][0], rows: store[tab].slice(1), allValues: store[tab] };
    },
    async getRecords(tab, idColumn) {
      const { header, rows: data } = await this.getTable(tab);
      const idIndex = header.indexOf(idColumn);
      return data.flatMap((row, index) => {
        if (!row[idIndex] || row[idIndex] === 'SCHEMA NOTE') return [];
        const obj = {};
        header.forEach((column, i) => { obj[column] = row[i] ?? ''; });
        return [{ index, rowNumber: index + 2, obj }];
      });
    },
    async findById(tab, idColumn, id) {
      return (await this.getRecords(tab, idColumn)).find((record) => record.obj[idColumn] === id) || null;
    },
    async appendRowsBatch(tab, newRows) {
      calls.appends += 1;
      if (failAppend) throw new Error('sales append offline');
      store[tab].push(...newRows.map((row) => row.slice()));
    },
    async writeCellsBatch(writes) {
      calls.updates += 1;
      if (failUpdate) throw new Error('reply update offline');
      for (const write of writes) {
        store[write.tab][write.rowNumber - 1][write.columnNumber - 1] = write.value;
      }
    },
  };
  const replyObject = () => {
    const header = store.REPLY_EVENTS[0];
    const row = store.REPLY_EVENTS[1];
    return Object.fromEntries(header.map((column, i) => [column, row[i] ?? '']));
  };
  const salesObjects = () => store.SALES_MESSAGES.slice(1)
    .filter((row) => row[0] && row[0] !== 'SCHEMA NOTE')
    .map((row) => Object.fromEntries(SALES_MESSAGES_HEADER.map((column, i) => [column, row[i] ?? ''])));
  return { repo, calls, replyObject, salesObjects };
}

function makeFetch({ sendStatus = 200, sendBody = { id: 'email-out-1', thread_id: THREAD, message_id: 'msg-1' }, inbound = [RAW_INBOUND] } = {}) {
  const log = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    log.push({ url: String(url), method, body: init.body ? JSON.parse(init.body) : null });
    if (method === 'GET') {
      return { ok: true, status: 200, async text() { return JSON.stringify({ items: inbound }); } };
    }
    return {
      ok: sendStatus >= 200 && sendStatus < 300,
      status: sendStatus,
      async text() { return JSON.stringify(sendStatus >= 400 ? { error: 'provider refused' } : sendBody); },
    };
  };
  return { fetchImpl, log };
}

async function execute(options = {}) {
  const fixture = options.fixture || makeRepo(options.repoOptions);
  const transport = options.transport || makeFetch(options.fetchOptions);
  const result = await executeManualReply({
    repo: fixture.repo,
    replyEventId: options.replyEventId || 'rpl_1',
    body: options.body ?? BODY,
    expectedReceivedAt: options.expectedReceivedAt ?? REPLY.received_at,
    apiKey: 'test-key',
    fetchImpl: transport.fetchImpl,
    claimStore: options.claimStore || createMemoryClaimStore(),
    now: NOW,
    mailboxes: [EACCOUNT],
    ...(options.execution || {}),
  });
  return { result, fixture, transport };
}

let passed = 0;
function ok(label) { passed += 1; console.log(`  ok  ${label}`); }

console.log('\nA. successful send, persistence and completion');
{
  const { result, fixture, transport } = await execute();
  assert.equal(result.sent, true);
  assert.equal(result.send_outcome, 'SENT');
  assert.equal(transport.log.filter((call) => call.method === 'POST').length, 1);
  const payload = transport.log.find((call) => call.method === 'POST').body;
  assert.deepEqual(Object.keys(payload), ['reply_to_uuid', 'eaccount', 'subject', 'body']);
  assert.equal(payload.reply_to_uuid, EMAIL_ID);
  assert.equal(payload.eaccount, EACCOUNT);
  assert.equal(payload.body.text, BODY);
  assert.equal(fixture.calls.appends, 1);
  const sales = fixture.salesObjects()[0];
  assert.equal(Object.keys(sales).length, 20);
  assert.equal(sales.send_outcome, 'SENT');
  assert.equal(sales.message_type, 'MANUAL_REPLY');
  assert.equal(sales.sent_by, 'joe');
  assert.equal(sales.thread_continuity, 'CONFIRMED');
  assert.equal(fixture.replyObject().action_status, 'COMPLETED');
  assert.equal(fixture.replyObject().action_completed_at, NOW);
  assert.match(fixture.replyObject().notes, /MANUAL_REPLY sent/);
  ok('2xx sends once, appends the exact audit row, then completes HUMAN_REPLY');
}

console.log('\nB. idempotency and claim failure');
{
  const fixture = makeRepo();
  const transport = makeFetch();
  const claimStore = createMemoryClaimStore();
  const first = await execute({ fixture, transport, claimStore });
  const second = await execute({ fixture, transport, claimStore });
  assert.equal(first.result.sent, true);
  assert.equal(second.result.blocked_reason, 'DUPLICATE_MANUAL_REPLY');
  assert.equal(transport.log.filter((call) => call.method === 'POST').length, 1);
  const third = await execute({ fixture, transport, claimStore, body: `${BODY}\nOne more detail.` });
  assert.equal(third.result.sent, true);
  assert.equal(transport.log.filter((call) => call.method === 'POST').length, 2);
  ok('same target/body double-submit sends once; a different body has a different claim');

  const unavailable = await execute({ claimStore: createMemoryClaimStore({ failWith: 'kv offline' }) });
  assert.equal(unavailable.result.blocked_reason, 'CLAIM_STORE_UNAVAILABLE');
  assert.equal(unavailable.transport.log.filter((call) => call.method === 'POST').length, 0);
  assert.equal(unavailable.fixture.calls.appends, 0);
  ok('claim-store failure closes the path before send or write');
}

console.log('\nC. gate blocks');
{
  for (const scenario of [
    { label: 'opted out', repoOptions: { replies: [{ ...REPLY, suppression_type: 'PERMANENT' }] }, reason: 'PROSPECT_OPTED_OUT' },
    { label: 'unknown sender', fetchOptions: { inbound: [{ ...RAW_INBOUND, eaccount: '' }] }, reason: 'MISSING_EACCOUNT' },
    { label: 'sender not allowlisted', fetchOptions: { inbound: [{ ...RAW_INBOUND, eaccount: 'x@elsewhere.test', to_address_email_list: 'x@elsewhere.test' }] }, reason: ['EACCOUNT_NOT_ALLOWLISTED', 'REPLY_NOT_CONFIRMED_INBOUND'] },
    { label: 'wrong thread', fetchOptions: { inbound: [{ ...RAW_INBOUND, thread_id: 'wrong' }] }, reason: 'THREAD_ID_MISMATCH' },
    { label: 'outbound mismatch', repoOptions: { outbound: [{ ...OUTBOUND, agency_id: 'ag_2' }] }, reason: 'AGENCY_ID_MISMATCH' },
    { label: 'empty body', body: '   ', reason: 'BODY_EMPTY' },
    { label: 'oversized body', body: 'x'.repeat(5001), reason: 'BODY_TOO_LONG' },
  ]) {
    const run = await execute(scenario);
    const reasons = Array.isArray(scenario.reason) ? scenario.reason : [scenario.reason];
    assert.ok(reasons.includes(run.result.blocked_reason), `${scenario.label}: ${run.result.blocked_reason}`);
    assert.equal(run.transport.log.filter((call) => call.method === 'POST').length, 0, scenario.label);
  }
  ok('opt-out, sender, thread, outbound and body failures all block before POST');

  const newer = { ...REPLY, reply_event_id: 'rpl_2', instantly_email_id: 'email-in-2', received_at: '2026-09-02T11:00:00.000Z' };
  const stale = await execute({ repoOptions: { replies: [REPLY, newer] } });
  assert.equal(stale.result.blocked_reason, 'STALE_REPLY_EVENT');
  assert.equal(stale.result.newest_reply_event_id, 'rpl_2');
  assert.equal(stale.transport.log.filter((call) => call.method === 'POST').length, 0);
  const unknown = await execute({ replyEventId: 'rpl_missing' });
  assert.equal(unknown.result.blocked_reason, 'REPLY_EVENT_NOT_FOUND');
  ok('stale and unknown reply ids are refused without retargeting');
}

console.log('\nD. classified transport outcomes');
{
  const rejectedFixture = makeRepo();
  const rejectedTransport = makeFetch({ sendStatus: 422 });
  const claimStore = createMemoryClaimStore();
  const rejected = await execute({ fixture: rejectedFixture, transport: rejectedTransport, claimStore });
  assert.equal(rejected.result.send_outcome, 'REJECTED');
  assert.equal(rejected.result.claim_released, true);
  assert.equal(rejectedFixture.calls.appends, 0);
  assert.equal(rejectedFixture.replyObject().action_status, 'PENDING');
  await execute({ fixture: rejectedFixture, transport: rejectedTransport, claimStore });
  assert.equal(rejectedTransport.log.filter((call) => call.method === 'POST').length, 2);
  ok('4xx is REJECTED, writes no audit row, stays PENDING and releases for corrected retry');

  const ambiguousFixture = makeRepo();
  const ambiguousTransport = makeFetch({ sendStatus: 503 });
  const ambiguousStore = createMemoryClaimStore();
  const ambiguous = await execute({ fixture: ambiguousFixture, transport: ambiguousTransport, claimStore: ambiguousStore });
  assert.equal(ambiguous.result.send_outcome, 'AMBIGUOUS');
  assert.equal(ambiguous.result.sent, false);
  assert.equal(ambiguous.result.claim_released, false);
  assert.equal(ambiguousFixture.salesObjects()[0].send_outcome, 'AMBIGUOUS');
  assert.match(ambiguousFixture.salesObjects()[0].error, /^AMBIGUOUS_SEND_RESULT/);
  assert.equal(ambiguousFixture.replyObject().action_status, 'PENDING');
  const browserRetry = await execute({ fixture: ambiguousFixture, transport: ambiguousTransport, claimStore: ambiguousStore });
  assert.equal(browserRetry.result.blocked_reason, 'DUPLICATE_MANUAL_REPLY');
  assert.equal(ambiguousTransport.log.filter((call) => call.method === 'POST').length, 1);
  ok('5xx is durably AMBIGUOUS, holds the claim, stays PENDING and blocks browser retry');

  const timeout = await execute({
    execution: { sendImpl: async () => ({ outcome: 'AMBIGUOUS', status: null, response: null, error: 'AMBIGUOUS_SEND_RESULT: transport timeout after 5ms' }) },
  });
  assert.equal(timeout.result.send_outcome, 'AMBIGUOUS');
  assert.equal(timeout.fixture.salesObjects()[0].send_outcome, 'AMBIGUOUS');
  ok('timeout/transport uncertainty follows the same AMBIGUOUS path');
}

console.log('\nE. partial persistence and thread continuity');
{
  const appendFailure = await execute({ repoOptions: { failAppend: true } });
  assert.equal(appendFailure.result.sent, true);
  assert.match(appendFailure.result.persistence_error, /sales append offline/);
  assert.equal(appendFailure.fixture.calls.updates, 0);
  assert.equal(appendFailure.result.claim_released, false);
  ok('a SENT email plus failed SALES_MESSAGES append is reported and never retried or completed');

  const updateFailure = await execute({ repoOptions: { failUpdate: true } });
  assert.equal(updateFailure.result.sent, true);
  assert.equal(updateFailure.fixture.salesObjects().length, 1);
  assert.match(updateFailure.result.action_update_error, /reply update offline/);
  assert.equal(updateFailure.result.action_status, 'PENDING');
  ok('a completion failure leaves the durable SENT row and returns a warning');

  for (const [returned, expected] of [[THREAD, 'CONFIRMED'], ['thread-2', 'DIFFERENT'], ['', 'UNKNOWN']]) {
    const run = await execute({ fetchOptions: { sendBody: { id: 'out', thread_id: returned, message_id: 'm' } } });
    assert.equal(run.result.thread_continuity, expected);
    assert.equal(run.fixture.salesObjects()[0].thread_continuity, expected);
  }
  ok('CONFIRMED, DIFFERENT and UNKNOWN continuity are returned and persisted');
}

console.log('\nF. HTTP and browser contracts');
{
  function fakeRes() {
    const res = { statusCode: 0, body: null, headers: {} };
    res.setHeader = (key, value) => { res.headers[key.toLowerCase()] = value; };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    res.end = () => res;
    return res;
  }
  const fixture = makeRepo();
  const transport = makeFetch();
  __setRepoForTests(fixture.repo);
  __setClaimStoreForTests(createMemoryClaimStore());
  const realFetch = globalThis.fetch;
  globalThis.fetch = transport.fetchImpl;
  process.env.NOVUS_BASIC_AUTH_USER = 'joe';
  process.env.NOVUS_BASIC_AUTH_PASS = 'secret';
  process.env.INSTANTLY_REPLY_API_KEY = 'test-key';
  process.env.NOVUS_SENDING_MAILBOXES = EACCOUNT;
  // The machine secret is configured, but the human manual route deliberately
  // does not receive it. SEND_DEMO below proves its own route still does.
  process.env.NOVUS_REPLY_POLLER_SECRET = 'action-secret';
  const auth = `Basic ${Buffer.from('joe:secret').toString('base64')}`;
  const authorisedHeaders = { authorization: auth };
  const call = async ({ method = 'POST', headers = authorisedHeaders, body = {} } = {}) => {
    const req = { method, query: { novus_operation: 'operator-manual-reply' }, headers, body };
    const res = fakeRes();
    await handler(req, res);
    return res;
  };

  let response = await call({ headers: {}, body: {} });
  assert.equal(response.statusCode, 401);
  assert.equal(transport.log.length, 0);
  response = await call({ method: 'GET', body: {} });
  assert.equal(response.statusCode, 405);
  response = await call({ body: { reply_event_id: 'rpl_1', body: BODY, confirm: 'wrong' } });
  assert.equal(response.statusCode, 400);
  assert.equal(transport.log.length, 0);
  ok('live operation is POST-only and requires Basic Auth plus exact confirmation, without a poller-secret header');

  response = await call({ body: {
    reply_event_id: 'rpl_1', body: BODY, expected_received_at: REPLY.received_at,
    confirm: MANUAL_REPLY_LIVE_CONFIRMATION,
    eaccount: 'attacker@evil.test', recipient: 'victim@evil.test', thread_id: 'evil-thread',
    reply_to_uuid: 'evil-parent', subject: 'evil subject', agency_id: 'evil-agency', outbound_id: 'evil-out',
  } });
  assert.equal(response.body.sent, true, JSON.stringify(response.body));
  const post = transport.log.find((call) => call.method === 'POST');
  assert.equal(post.body.eaccount, EACCOUNT);
  assert.equal(post.body.reply_to_uuid, EMAIL_ID);
  assert.equal(post.body.subject, 'Re: Enquiry');
  assert.ok(response.body.ignored_request_fields.includes('eaccount'));
  assert.ok(!JSON.stringify(post.body).includes('evil'));
  ok('spoofed browser identity fields are ignored; sender, parent and subject are server-resolved');

  const sendDemoReq = {
    method: 'POST', query: { novus_operation: 'send-demo' }, headers: { authorization: auth },
    body: { reply_event_id: 'rpl_1', confirm: 'SEND_ONE_DEMO_REPLY' },
  };
  const sendDemoRes = fakeRes();
  await handler(sendDemoReq, sendDemoRes);
  assert.equal(sendDemoRes.statusCode, 403);
  assert.equal(transport.log.filter((call) => call.method === 'POST').length, 1);
  ok('SEND_DEMO still requires the reply-poller secret');

  const html = readFileSync('novus/operator.html', 'utf8');
  assert.match(html, /<textarea id="reply-body" maxlength="5000"/);
  assert.match(html, /window\.confirm\(/);
  assert.match(html, /SEND_ONE_MANUAL_REPLY/);
  assert.match(html, /SEND_IN_FLIGHT/);
  assert.match(html, /textarea\.value\.trim\(\)\.length > 0/);
  assert.match(html, /STALE_REPLY_EVENT/);
  assert.match(html, /This may have sent\./);
  assert.match(html, /Do not resend yet\. Refresh\/check the conversation first\./);
  assert.match(html, /Reply sent\./);
  assert.ok(!/<select[^>]*(sender|eaccount|reply)/i.test(html));
  assert.ok(!/NOVUS_REPLY_POLLER_SECRET|X-NOVUS-REPLY-POLLER-SECRET|action secret/i.test(html));
  assert.ok(!/Generate Response/i.test(html));
  assert.ok(!/callAi|model invocation|openai/i.test(html));
  ok('composer is bounded, confirmed, single-flight, outcome-aware, sender-read-only and has no AI control');

  const executionCode = readFileSync('lib/manual-reply-execution.mjs', 'utf8');
  assert.ok(!/classifyReply|callAi|ai-client|openai/i.test(executionCode));
  ok('no classifier or AI is reachable from the manual execution module');

  globalThis.fetch = realFetch;
  __setRepoForTests(null);
  __setClaimStoreForTests(null);
}

console.log(`\nNOVUS manual-reply live self-test passed (${passed} focused groups).`);
