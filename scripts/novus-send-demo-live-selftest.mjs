// Hermetic NOVUS POSITIVE_SEND_DEMO LIVE execution tests.
// Run: npm run novus:send-demo-live-selftest
//
// Fully offline. globalThis.fetch THROWS, so any unstubbed network access fails
// the suite. Instantly is mocked at the fetch boundary and EVERY request it
// receives is recorded, so "exactly one POST" is proved, not assumed.
//
// The fake repo records every read and write. Writing to any tab other than
// REPLY_EVENTS, or to any REPLY_EVENTS column outside the execution whitelist,
// THROWS — so an OUTBOUND write or a clobbered evidence column fails the suite
// rather than passing quietly.

import assert from 'node:assert/strict';
import {
  executeSendDemo,
  sendDemoReply,
  buildInstantlyReplyPayload,
  hasSendDemoMarker,
  INSTANTLY_REPLY_URL,
  AMBIGUOUS_ERROR,
  SEND_DEMO_LIVE_CONFIRMATION,
} from '../lib/reply-send-demo.mjs';
import handler from '../api/novus/personalisation.js';
import { REPLY_POLLER_SECRET_HEADER } from '../api/novus/_auth.mjs';
import { __setRepoForTests } from '../lib/sheets.mjs';
import {
  REPLY_EVENTS_HEADER,
  RAW_EVIDENCE_FIELDS,
  EXECUTION_FIELDS,
} from '../lib/reply-router.mjs';
import { OUTBOUND_HEADER } from '../lib/outbound.mjs';

const originalFetch = globalThis.fetch;
globalThis.fetch = (...args) => { throw new Error(`FORBIDDEN network access: ${args[0]}`); };

let assertions = 0;
function check(fn) { fn(); assertions += 1; }

// --- Fixtures (the real observed reply shape) -------------------------------
const LEAD = 'joedcarter1@gmail.com';
const EACCOUNT = 'joe@novushq.co.uk';
const THREAD = 'ba-AayEOdow6Hjmghl06cSGgbe';
const REPLY_ID = '01a0596e-d338-72e6-a586-98eac9e4ba20';
const DEMO_URL = 'https://demo.getnovus.co.uk/test-1';
const NOW = '2026-09-01T10:00:00.000Z';

const EXPECTED_BODY = [
  'Absolutely — here it is:',
  '',
  DEMO_URL,
  '',
  'I’ve based it on what happened after the enquiry we sent through.',
  '',
  'Joe',
].join('\n');

const RAW_REPLY = {
  id: REPLY_ID,
  timestamp_email: '2026-08-31T20:07:11.000Z',
  subject: 'Re: TEST',
  from_address_email: LEAD,
  to_address_email_list: EACCOUNT,
  lead: LEAD,
  thread_id: THREAD,
  eaccount: EACCOUNT,
  ue_type: 2,
  content_preview: 'Yes send',
};

const RAW_NOVUS_OUTBOUND = {
  id: 'novus-outbound-1',
  timestamp_email: '2026-08-31T20:01:00.000Z',
  subject: 'TEST',
  from_address_email: EACCOUNT,
  to_address_email_list: LEAD,
  lead: LEAD,
  thread_id: THREAD,
  eaccount: EACCOUNT,
  ue_type: 1,
  content_preview: 'We sent an enquiry through last week. Want the breakdown?',
};

// Our OWN successfully-sent demo reply, as the next sweep would see it.
const RAW_NOVUS_DEMO_SENT = {
  ...RAW_NOVUS_OUTBOUND,
  id: 'novus-outbound-demo',
  timestamp_email: '2026-09-01T10:00:01.000Z',
  content_preview: `Absolutely — here it is: ${DEMO_URL} I’ve based it on what happened after the enquiry we sent through. Joe`,
};

function replyRow(overrides = {}) {
  const row = Object.fromEntries(REPLY_EVENTS_HEADER.map((k) => [k, '']));
  return {
    ...row,
    reply_event_id: 'rev_test_1',
    instantly_email_id: REPLY_ID,
    agency_id: 'ag_test_replyrouter',
    outreach_id: 'obd_test_replyrouter',
    lead_email: LEAD,
    thread_id: THREAD,
    received_at: RAW_REPLY.timestamp_email,
    subject: 'Re: TEST',
    body_text: 'Yes send',
    cleaned_reply_text: 'Yes send',
    is_auto_reply: 'FALSE',
    classification: 'POSITIVE_SEND_DEMO',
    confidence: '0.95',
    suppression_type: 'NONE',
    next_action: 'SEND_DEMO',
    priority: 'HIGH',
    processed_at: '2026-08-31T20:08:00.000Z',
    action_status: 'PENDING',
    classifier_reason: 'explicitly asks for the material to be sent',
    ...overrides,
  };
}

function outboundRecord(overrides = {}) {
  const obj = Object.fromEntries(OUTBOUND_HEADER.map((k) => [k, '']));
  return {
    rowNumber: 2,
    obj: {
      ...obj,
      outbound_id: 'obd_test_replyrouter',
      agency_id: 'ag_test_replyrouter',
      outreach_contact_email: LEAD,
      outbound_status: 'SENT',
      demo_slug: 'test-1',
      demo_url: DEMO_URL,
      ...overrides,
    },
  };
}

// --- The fake sheet ---------------------------------------------------------
// One REPLY_EVENTS row, held as a live array so cell writes are observable.
function makeRepo({ row = replyRow(), outbound = [outboundRecord()] } = {}) {
  const header = [...REPLY_EVENTS_HEADER];
  const data = [header.map((c) => String(row[c] ?? ''))];
  const writes = [];
  const reads = [];

  const rowObject = () => Object.fromEntries(header.map((c, i) => [c, data[0][i]]));

  return {
    writes,
    reads,
    rowObject,
    repo: {
      async findById(tab, column, id) {
        reads.push(`findById:${tab}`);
        if (tab !== 'REPLY_EVENTS') throw new Error(`unexpected findById on ${tab}`);
        const obj = rowObject();
        return String(obj[column]) === String(id) ? { rowNumber: 2, obj } : null;
      },
      async getRecords(tab) {
        reads.push(`getRecords:${tab}`);
        if (tab !== 'OUTBOUND') throw new Error(`unexpected getRecords on ${tab}`);
        return outbound;
      },
      async getTable(tab) {
        reads.push(`getTable:${tab}`);
        if (tab !== 'REPLY_EVENTS') throw new Error(`unexpected getTable on ${tab}`);
        return { header, rows: data };
      },
      async writeCellsBatch(cells) {
        for (const cell of cells) {
          if (cell.tab !== 'REPLY_EVENTS') throw new Error(`FORBIDDEN write to ${cell.tab}`);
          const column = header[cell.columnNumber - 1];
          if (!EXECUTION_FIELDS.includes(column)) {
            throw new Error(`FORBIDDEN write to non-execution column ${column}`);
          }
          writes.push({ column, value: cell.value, rowNumber: cell.rowNumber });
          data[cell.rowNumber - 2][cell.columnNumber - 1] = String(cell.value);
        }
      },
      appendRecord() { throw new Error('FORBIDDEN appendRecord'); },
      writeCell() { throw new Error('FORBIDDEN writeCell'); },
      updateRecord() { throw new Error('FORBIDDEN updateRecord'); },
    },
  };
}

// --- The mocked Instantly ---------------------------------------------------
// Records every request. The sweep (GET) is served from `sweep`; the reply
// (POST) is served from `reply`, which may be a response or a thrown error.
function makeInstantly({ sweep = [RAW_REPLY, RAW_NOVUS_OUTBOUND], reply } = {}) {
  const requests = [];
  const impl = async (url, options = {}) => {
    const method = options.method || 'GET';
    requests.push({
      url: String(url),
      method,
      headers: options.headers || {},
      body: options.body ? JSON.parse(options.body) : null,
    });
    if (method === 'GET') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ items: sweep }) };
    }
    if (String(url) !== INSTANTLY_REPLY_URL) throw new Error(`unexpected POST to ${url}`);
    if (typeof reply === 'function') return reply();
    return reply;
  };
  return {
    requests,
    impl,
    posts: () => requests.filter((r) => r.method === 'POST'),
  };
}

const OK_RESPONSE = {
  ok: true,
  status: 200,
  text: async () => JSON.stringify({
    id: 'sent-email-uuid-1',
    thread_id: THREAD,
    message_id: '<abc@novushq.co.uk>',
    eaccount: EACCOUNT,
  }),
};

// ===========================================================================
console.log('--- 1-5. eligible event: exactly one POST, correct payload, COMPLETED ---');
{
  const { repo, writes, reads, rowObject } = makeRepo();
  const instantly = makeInstantly({ reply: OK_RESPONSE });
  const before = rowObject();

  const result = await executeSendDemo({
    repo, replyEventId: 'rev_test_1', apiKey: 'SECRET', fetchImpl: instantly.impl, now: NOW,
  });

  // 1. exactly one POST to the reply endpoint
  check(() => assert.equal(instantly.posts().length, 1));
  const post = instantly.posts()[0];
  check(() => assert.equal(post.url, 'https://api.instantly.ai/api/v2/emails/reply'));
  check(() => assert.equal(post.method, 'POST'));
  check(() => assert.equal(post.headers.Authorization, 'Bearer SECRET'));
  check(() => assert.equal(post.headers['Content-Type'], 'application/json'));
  // and exactly one GET sweep — no per-message fan-out
  check(() => assert.equal(instantly.requests.filter((r) => r.method === 'GET').length, 1));

  // 2. reply_to_uuid is the received email's id
  check(() => assert.equal(post.body.reply_to_uuid, REPLY_ID));
  // 3. eaccount is the received email's real eaccount
  check(() => assert.equal(post.body.eaccount, EACCOUNT));
  check(() => assert.equal(post.body.subject, 'Re: TEST'));
  // thread_id is NOT a request field
  check(() => assert.equal('thread_id' in post.body, false));
  check(() => assert.deepEqual(Object.keys(post.body).sort(), ['body', 'eaccount', 'reply_to_uuid', 'subject']));

  // 4. exact demo_url and exact fixed copy
  check(() => assert.equal(post.body.body.text, EXPECTED_BODY));
  check(() => assert.equal(post.body.body.html, EXPECTED_BODY.split('\n').join('<br/>')));
  check(() => assert.equal(post.body.body.text.includes(DEMO_URL), true));
  check(() => assert.equal(/call|meeting|book a|pricing|let me know if/i.test(post.body.body.text), false));

  // 5. success -> COMPLETED
  check(() => assert.equal(result.sent, true));
  check(() => assert.equal(result.send_outcome, 'SENT'));
  check(() => assert.equal(result.action_status, 'COMPLETED'));
  const after = rowObject();
  check(() => assert.equal(after.action_status, 'COMPLETED'));
  check(() => assert.equal(after.action_completed_at, NOW));
  check(() => assert.equal(after.error, ''));
  check(() => assert.equal(hasSendDemoMarker(after.notes), true));
  // the returned Instantly identifiers are recorded
  check(() => assert.match(after.notes, /instantly_email_id=sent-email-uuid-1/));
  check(() => assert.match(after.notes, new RegExp(`thread_id=${THREAD}`)));
  // next_action is untouched: executing an action does not reclassify it
  check(() => assert.equal(after.next_action, 'SEND_DEMO'));

  // 12. raw evidence unchanged
  for (const field of RAW_EVIDENCE_FIELDS) {
    check(() => assert.equal(after[field], before[field], `${field} must be unchanged`));
  }
  check(() => assert.equal(writes.every((w) => EXECUTION_FIELDS.includes(w.column)), true));
  // 13. no OUTBOUND write (the fake repo throws on one; assert reads only)
  check(() => assert.deepEqual(
    reads.filter((r) => r.includes('OUTBOUND')), ['getRecords:OUTBOUND'],
  ));
  // the API key never reaches the result
  check(() => assert.equal(JSON.stringify(result).includes('SECRET'), false));
  console.log(`  sent=${result.sent} status=${result.instantly_status} notes="${after.notes}"`);
}

// ===========================================================================
console.log('--- 6. second execution of the same event: zero sends, ALREADY_EXECUTED ---');
{
  const { repo, rowObject } = makeRepo();
  const first = makeInstantly({ reply: OK_RESPONSE });
  await executeSendDemo({ repo, replyEventId: 'rev_test_1', apiKey: 'SECRET', fetchImpl: first.impl, now: NOW });
  check(() => assert.equal(first.posts().length, 1));

  // The sweep now also contains our own sent demo reply, exactly as Instantly
  // would report it on the next pass.
  const second = makeInstantly({ sweep: [RAW_REPLY, RAW_NOVUS_OUTBOUND, RAW_NOVUS_DEMO_SENT], reply: OK_RESPONSE });
  const again = await executeSendDemo({
    repo, replyEventId: 'rev_test_1', apiKey: 'SECRET', fetchImpl: second.impl, now: '2026-09-01T11:00:00.000Z',
  });
  check(() => assert.equal(second.posts().length, 0));
  check(() => assert.equal(again.sent, false));
  check(() => assert.equal(again.eligible, false));
  check(() => assert.equal(again.blocked_reasons.includes('ALREADY_EXECUTED'), true));
  check(() => assert.equal(again.blocked_reasons.includes('DEMO_ALREADY_SENT'), true));
  // The completed row is not rewritten by the blocked attempt.
  check(() => assert.equal(rowObject().action_completed_at, NOW));
  console.log(`  second call -> ${again.blocked_reason}, posts=${second.posts().length}`);
}

// ===========================================================================
console.log('--- 7. definite 4xx rejection -> FAILED, not completed ---');
for (const status of [400, 401, 402, 404, 429]) {
  const { repo, rowObject } = makeRepo();
  const instantly = makeInstantly({
    reply: { ok: false, status, text: async () => JSON.stringify({ error: 'nope' }) },
  });
  const result = await executeSendDemo({
    repo, replyEventId: 'rev_test_1', apiKey: 'SECRET', fetchImpl: instantly.impl, now: NOW,
  });
  check(() => assert.equal(instantly.posts().length, 1));
  check(() => assert.equal(result.sent, false));
  check(() => assert.equal(result.send_outcome, 'REJECTED'));
  const after = rowObject();
  check(() => assert.equal(after.action_status, 'FAILED'));
  check(() => assert.equal(after.action_completed_at, ''));
  check(() => assert.equal(hasSendDemoMarker(after.notes), false));
  check(() => assert.equal(after.error.startsWith(`INSTANTLY_${status}:`), true));
  check(() => assert.equal(after.error.includes('SECRET'), false));
  console.log(`  ${status} -> ${after.action_status} error="${after.error}"`);
}

// ===========================================================================
console.log('--- 8. ambiguous outcomes -> AMBIGUOUS_SEND_RESULT, never completed ---');
{
  const cases = [
    ['500', { ok: false, status: 500, text: async () => 'upstream failure' }],
    ['502', { ok: false, status: 502, text: async () => 'bad gateway' }],
    ['transport', () => { throw new Error('socket hang up'); }],
    ['timeout', () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }],
  ];
  for (const [name, reply] of cases) {
    const { repo, rowObject } = makeRepo();
    const instantly = makeInstantly({ reply });
    const result = await executeSendDemo({
      repo, replyEventId: 'rev_test_1', apiKey: 'SECRET', fetchImpl: instantly.impl, now: NOW,
    });
    check(() => assert.equal(instantly.posts().length, 1));
    check(() => assert.equal(result.send_outcome, 'AMBIGUOUS'));
    check(() => assert.equal(result.sent, false));
    const after = rowObject();
    check(() => assert.equal(after.action_status, 'FAILED'));
    check(() => assert.equal(after.action_completed_at, ''));
    check(() => assert.equal(hasSendDemoMarker(after.notes), false));
    check(() => assert.equal(after.error.startsWith(AMBIGUOUS_ERROR), true));
    console.log(`  ${name} -> ${after.action_status} error="${after.error}"`);
  }
}

// ===========================================================================
console.log('--- 9. retry after an ambiguous result whose send ACTUALLY landed ---');
{
  const { repo, rowObject } = makeRepo();
  // Attempt 1: the send lands, but Instantly's response never arrives.
  const attempt1 = makeInstantly({ reply: () => { throw new Error('socket hang up'); } });
  await executeSendDemo({ repo, replyEventId: 'rev_test_1', apiKey: 'SECRET', fetchImpl: attempt1.impl, now: NOW });
  check(() => assert.equal(attempt1.posts().length, 1));
  check(() => assert.equal(rowObject().action_status, 'FAILED'));
  check(() => assert.equal(rowObject().error.startsWith(AMBIGUOUS_ERROR), true));

  // Attempt 2: the row still says FAILED (retryable) and carries no marker —
  // the ONLY thing that stops a second send is the FRESH thread evidence.
  const attempt2 = makeInstantly({
    sweep: [RAW_REPLY, RAW_NOVUS_OUTBOUND, RAW_NOVUS_DEMO_SENT],
    reply: OK_RESPONSE,
  });
  const retry = await executeSendDemo({
    repo, replyEventId: 'rev_test_1', apiKey: 'SECRET', fetchImpl: attempt2.impl, now: NOW,
  });
  check(() => assert.equal(attempt2.posts().length, 0, 'no second send'));
  check(() => assert.equal(retry.sent, false));
  check(() => assert.equal(retry.blocked_reason, 'DEMO_ALREADY_SENT'));
  check(() => assert.equal(retry.demo_sent_evidence, 'SENT'));

  // And the contrast: an ambiguous result whose send did NOT land is retryable
  // and succeeds, proving the block above is evidence-driven, not a blanket
  // freeze on FAILED rows.
  const { repo: repo2, rowObject: row2 } = makeRepo({ row: replyRow({ action_status: 'FAILED', error: `${AMBIGUOUS_ERROR}: transport socket hang up` }) });
  const attempt3 = makeInstantly({ reply: OK_RESPONSE });
  const redriven = await executeSendDemo({
    repo: repo2, replyEventId: 'rev_test_1', apiKey: 'SECRET', fetchImpl: attempt3.impl, now: NOW,
  });
  check(() => assert.equal(attempt3.posts().length, 1));
  check(() => assert.equal(redriven.sent, true));
  check(() => assert.equal(row2().action_status, 'COMPLETED'));
  check(() => assert.equal(row2().error, '', 'the stale ambiguous error is cleared'));
  console.log(`  landed -> ${retry.blocked_reason} (0 posts); not landed -> redriven and COMPLETED`);
}

// ===========================================================================
console.log('--- 10 & 14. every blocked gate case: zero POSTs, zero writes ---');
const BLOCKED_LIVE = [
  ['confidence 0.89', { row: { confidence: '0.89' } }, {}],
  ['QUESTION', { row: { classification: 'QUESTION', next_action: 'HUMAN_REPLY' } }, {}],
  ['POSITIVE_MEETING', { row: { classification: 'POSITIVE_MEETING', next_action: 'HUMAN_REPLY' } }, {}],
  ['NOT_NOW', { row: { classification: 'NOT_NOW', next_action: 'CREATE_NURTURE' } }, {}],
  ['NOT_INTERESTED', { row: { classification: 'NOT_INTERESTED', next_action: 'CLOSE' } }, {}],
  ['OPT_OUT', { row: { classification: 'OPT_OUT', next_action: 'NONE', suppression_type: 'PERMANENT' } }, {}],
  ['OOO_AUTOMATED', { row: { classification: 'OOO_AUTOMATED', next_action: 'NONE', is_auto_reply: 'TRUE', action_status: 'NO_ACTION' } }, {}],
  ['OTHER_UNCLEAR', { row: { classification: 'OTHER_UNCLEAR', next_action: 'MANUAL_REVIEW', action_status: 'REVIEW' } }, {}],
  ['classifier error', { row: { error: 'ai transport failure' } }, {}],
  ['missing thread_id', { row: { thread_id: '' } }, {}],
  ['missing demo_url', { outbound: [outboundRecord({ demo_url: '', demo_slug: '' })] }, {}],
  ['ambiguous OUTBOUND', { outbound: [outboundRecord(), outboundRecord({ rowNumber: 3 })] }, {}],
  ['already COMPLETED', { row: { action_status: 'COMPLETED', action_completed_at: NOW } }, {}],
  ['demo already in thread', {}, { sweep: [RAW_REPLY, RAW_NOVUS_OUTBOUND, RAW_NOVUS_DEMO_SENT] }],
  ['reply not in sweep', {}, { sweep: [RAW_NOVUS_OUTBOUND] }],
  ['thread evidence unavailable', {}, { sweep: [RAW_REPLY] }],
];

for (const [name, repoOpts, netOpts] of BLOCKED_LIVE) {
  const { repo, writes, rowObject } = makeRepo({
    row: replyRow(repoOpts.row || {}),
    outbound: repoOpts.outbound,
  });
  const before = rowObject();
  const instantly = makeInstantly({ ...netOpts, reply: OK_RESPONSE });
  const result = await executeSendDemo({
    repo, replyEventId: 'rev_test_1', apiKey: 'SECRET', fetchImpl: instantly.impl, now: NOW,
  });
  check(() => assert.equal(instantly.posts().length, 0, `${name}: must not POST`));
  check(() => assert.equal(result.sent, false));
  check(() => assert.equal(result.eligible, false));
  check(() => assert.equal(writes.length, 0, `${name}: a blocked event must not be written`));
  check(() => assert.deepEqual(rowObject(), before, `${name}: row untouched`));
  console.log(`  blocked: ${name} -> ${result.blocked_reason} (0 posts, 0 writes)`);
}

// An unknown reply_event_id sends nothing and reads no Instantly at all.
{
  const { repo } = makeRepo();
  const instantly = makeInstantly({ reply: OK_RESPONSE });
  const result = await executeSendDemo({
    repo, replyEventId: 'rev_does_not_exist', apiKey: 'SECRET', fetchImpl: instantly.impl, now: NOW,
  });
  check(() => assert.equal(result.blocked_reason, 'REPLY_EVENT_NOT_FOUND'));
  check(() => assert.equal(instantly.requests.length, 0));
}

// ===========================================================================
console.log('--- 11. auth failure: zero Instantly calls, zero Sheets access ---');
{
  const SECRET = 'poller-secret-value-do-not-echo';
  process.env.NOVUS_BASIC_AUTH_USER = 'novus';
  process.env.NOVUS_BASIC_AUTH_PASS = 'basic-pass';
  process.env.NOVUS_REPLY_POLLER_SECRET = SECRET;
  process.env.INSTANTLY_REPLY_API_KEY = 'instantly-key';
  const BASIC = `Basic ${Buffer.from('novus:basic-pass').toString('base64')}`;

  let repoCalls = 0;
  __setRepoForTests(new Proxy({}, {
    get(_t, prop) {
      return (...args) => {
        repoCalls += 1;
        throw new Error(`FORBIDDEN Google Sheets access: ${String(prop)}(${args[0] ?? ''})`);
      };
    },
  }));

  let netCalls = 0;
  globalThis.fetch = (...args) => { netCalls += 1; throw new Error(`FORBIDDEN network: ${args[0]}`); };

  function fakeRes() {
    return {
      statusCode: null, body: null, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.statusCode = c; return this; },
      json(p) { this.body = p; return this; },
      end() { return this; },
    };
  }
  const liveQuery = { novus_operation: 'send-demo', reply_event_id: 'rev_test_1', confirm: SEND_DEMO_LIVE_CONFIRMATION };

  const cases = [
    ['no auth at all', { method: 'POST', query: liveQuery, headers: {} }, 401],
    ['bad basic auth', { method: 'POST', query: liveQuery, headers: { authorization: `Basic ${Buffer.from('novus:wrong').toString('base64')}` } }, 401],
    ['basic auth, no poller secret', { method: 'POST', query: liveQuery, headers: { authorization: BASIC } }, 403],
    ['basic auth, wrong poller secret', { method: 'POST', query: liveQuery, headers: { authorization: BASIC, [REPLY_POLLER_SECRET_HEADER]: 'wrong' } }, 403],
    ['GET cannot trigger a send', { method: 'GET', query: liveQuery, headers: { authorization: BASIC, [REPLY_POLLER_SECRET_HEADER]: SECRET } }, 400],
  ];

  for (const [name, req, expected] of cases) {
    const res = fakeRes();
    await handler(req, res);
    check(() => assert.equal(res.statusCode, expected, `${name}: expected ${expected}, got ${res.statusCode}`));
    check(() => assert.equal(JSON.stringify(res.body).includes(SECRET), false, `${name}: secret must never be echoed`));
    console.log(`  ${name} -> ${res.statusCode}`);
  }
  // A GET with the same query falls through to the ordinary personalisation
  // lookup (400 missing probe_id) — it can never reach the send handler.

  // Fully authorised but WITHOUT the deliberate-action confirmation.
  const resNoConfirm = fakeRes();
  await handler({
    method: 'POST',
    query: { novus_operation: 'send-demo', reply_event_id: 'rev_test_1' },
    headers: { authorization: BASIC, [REPLY_POLLER_SECRET_HEADER]: SECRET },
  }, resNoConfirm);
  check(() => assert.equal(resNoConfirm.statusCode, 400));
  check(() => assert.match(resNoConfirm.body.error, /SEND_ONE_DEMO_REPLY/));
  console.log(`  authorised but unconfirmed -> ${resNoConfirm.statusCode}`);

  check(() => assert.equal(netCalls, 0, 'a blocked request must make zero Instantly calls'));
  check(() => assert.equal(repoCalls, 0, 'a blocked request must make zero Sheets calls'));
  console.log(`  instantly calls=${netCalls} sheets calls=${repoCalls}`);
}

// ===========================================================================
console.log('--- transport-level outcome classification ---');
{
  const seen = [];
  const impl = async (url, options) => { seen.push({ url, options }); return OK_RESPONSE; };
  const payload = buildInstantlyReplyPayload({
    replyToUuid: REPLY_ID, eaccount: EACCOUNT, subject: 'Re: TEST',
    body: { text: EXPECTED_BODY, html: EXPECTED_BODY.split('\n').join('<br/>') },
  });
  const r = await sendDemoReply({ apiKey: 'SECRET', payload, fetchImpl: impl });
  check(() => assert.equal(r.outcome, 'SENT'));
  check(() => assert.equal(r.response.id, 'sent-email-uuid-1'));
  check(() => assert.equal(seen[0].url, INSTANTLY_REPLY_URL));
  // A 2xx with an unparseable body is still a send.
  const odd = await sendDemoReply({
    apiKey: 'SECRET', payload,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'not json' }),
  });
  check(() => assert.equal(odd.outcome, 'SENT'));
  check(() => assert.equal(odd.response.id, ''));
  check(() => assert.rejects(() => sendDemoReply({ apiKey: '', payload })));
}

globalThis.fetch = originalFetch;
console.log(`\nSEND_DEMO LIVE selftest passed. ${assertions} assertions.`);
