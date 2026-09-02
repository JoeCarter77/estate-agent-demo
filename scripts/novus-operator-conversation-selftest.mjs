// Hermetic focused tests for the Phase 2 sales-conversation path:
//   lib/instantly-conversation.mjs  (lead-scoped fetch + pure merge)
//   lib/sales-messages.mjs          (SALES_MESSAGES schema + tolerant reader)
//   the operator-conversation API operation
//
// No network, no Google credentials, no real Instantly call, no AI call, no
// email send, no Sheets write. Every fetch is a stub, the repo is in-memory,
// and the API tests ASSERT that zero write methods were reached and that no
// send operation is reachable.
//
// Run: npm run novus:operator-conversation-selftest

import assert from 'node:assert/strict';
import {
  buildConversation,
  buildLeadConversationUrl,
  fetchLeadConversation,
  replyEventToMessage,
  resolveSenderInbox,
  salesMessageToMessage,
  toConversationMessage,
  INSTANTLY_EMAILS_URL,
} from '../lib/instantly-conversation.mjs';
import {
  SALES_MESSAGES_HEADER,
  buildSalesMessageRow,
  newSalesMessageId,
  parseSalesMessageRecords,
  readSalesMessagesForOutreach,
  validateSalesMessageRow,
} from '../lib/sales-messages.mjs';
import { __setRepoForTests } from '../lib/sheets.mjs';
import personalisationHandler from '../api/novus/personalisation.js';

let passed = 0;
function ok(label) { passed += 1; console.log(`  ok  ${label}`); }
function part(label) { console.log(`\n${label}`); }

const LEAD = 'sam@ashtonwhite.co.uk';
const NOVUS = 'joe@trynovus.co.uk';

// A live-shaped Instantly email object. Field names mirror the ones
// lib/reply-router.mjs already reads off real traffic.
function instantlyEmail(overrides = {}) {
  return {
    id: 'em_1',
    timestamp: '2026-08-28T09:12:00.000Z',
    subject: 'Your Rightmove enquiry',
    from_address_email: NOVUS,
    to_address_email_list: LEAD,
    lead: LEAD,
    eaccount: NOVUS,
    campaign_id: 'cmp_1',
    thread_id: 'thr_1',
    ue_type: 1,
    body: { text: 'We sent an enquiry on Tuesday and heard nothing back.' },
    ...overrides,
  };
}

function stubFetch(payload, { ok: okStatus = true, status = 200 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: okStatus,
      status,
      async text() { return JSON.stringify(payload); },
    };
  };
  impl.calls = calls;
  return impl;
}

// ---------------------------------------------------------------------------
part('A. the fetch is lead-scoped and never a workspace-wide sweep');
// ---------------------------------------------------------------------------

{
  const url = buildLeadConversationUrl({ leadEmail: LEAD });
  assert.ok(url.startsWith(`${INSTANTLY_EMAILS_URL}?`));
  const params = new URL(url).searchParams;
  assert.equal(params.get('lead'), LEAD);
  assert.equal(params.get('limit'), '100');
  assert.equal(params.get('sort_order'), 'desc');
  ok('the URL carries lead, limit and sort_order');

  assert.throws(() => buildLeadConversationUrl({ leadEmail: '' }), /leadEmail is required/);
  assert.throws(() => buildLeadConversationUrl({}), /leadEmail is required/);
  ok('a blank lead email throws rather than degrading into an unscoped sweep');

  // The limit is bounded to the API maximum whatever is asked for.
  assert.equal(new URL(buildLeadConversationUrl({ leadEmail: LEAD, limit: 5000 })).searchParams.get('limit'), '100');
  assert.equal(new URL(buildLeadConversationUrl({ leadEmail: LEAD, limit: 10 })).searchParams.get('limit'), '10');
  ok('limit is bounded to the API maximum of 100');
}

{
  const fetchImpl = stubFetch({ items: [instantlyEmail()] });
  await fetchLeadConversation({ apiKey: 'k', leadEmail: LEAD, fetchImpl });
  assert.equal(fetchImpl.calls.length, 1, 'exactly one Instantly call');
  const { url, init } = fetchImpl.calls[0];
  assert.ok(url.includes(`lead=${encodeURIComponent(LEAD)}`));
  assert.equal(init.method, 'GET');
  assert.equal(init.headers.Authorization, 'Bearer k');
  ok('fetchLeadConversation performs exactly one lead-scoped GET');
}

{
  // Every module export is asserted to be incapable of a non-GET Instantly call.
  // Comment lines are stripped first: this is about what the CODE can do, and
  // the module's own header discusses the endpoints it deliberately avoids.
  const raw = await (await import('node:fs/promises')).readFile('lib/instantly-conversation.mjs', 'utf8');
  const source = raw.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.ok(!/emails\/reply/.test(source), 'no reply endpoint is referenced');
  assert.ok(!/method:\s*'POST'/.test(source), 'no POST is issued');
  assert.ok(!/from '\.\/sheets\.mjs'/.test(source), 'the module does not import the Sheets repo');
  assert.ok(!/ai-client/.test(source), 'the module does not import the AI client');
  ok('the conversation module contains no write, no Sheets access and no AI');
}

// ---------------------------------------------------------------------------
part('B. inbound / outbound normalisation');
// ---------------------------------------------------------------------------

{
  const outbound = toConversationMessage(instantlyEmail(), { leadEmail: LEAD });
  assert.equal(outbound.direction, 'OUTBOUND');
  assert.equal(outbound.message_type, 'CAMPAIGN_EMAIL');
  assert.equal(outbound.eaccount, NOVUS);
  assert.equal(outbound.source, 'INSTANTLY');
  assert.equal(outbound.thread_id, 'thr_1');
  ok('a ue_type 1 message from the NOVUS account to the lead is OUTBOUND / CAMPAIGN_EMAIL');

  const manual = toConversationMessage(instantlyEmail({ id: 'em_m', ue_type: 3 }), { leadEmail: LEAD });
  assert.equal(manual.message_type, 'MANUAL_EMAIL');
  ok('ue_type 3 is MANUAL_EMAIL');

  const inbound = toConversationMessage(instantlyEmail({
    id: 'em_2', ue_type: 2, from_address_email: LEAD, to_address_email_list: NOVUS,
    body: { text: 'what does it cost and how quickly could we start?' },
  }), { leadEmail: LEAD });
  assert.equal(inbound.direction, 'INBOUND');
  assert.equal(inbound.message_type, 'PROSPECT_REPLY');
  assert.equal(inbound.body_text, 'what does it cost and how quickly could we start?');
  ok('a ue_type 2 message from the lead to the NOVUS account is INBOUND / PROSPECT_REPLY');

  // A provider claim the addresses contradict is never accepted.
  const contradiction = toConversationMessage(instantlyEmail({
    id: 'em_3', ue_type: 2, from_address_email: NOVUS, to_address_email_list: LEAD,
  }), { leadEmail: LEAD });
  assert.equal(contradiction.direction, 'UNKNOWN');
  ok('a ue_type that contradicts the addresses resolves to UNKNOWN, never INBOUND');

  // The server-known lead address is seeded when Instantly omits it, so the
  // direction check has a counterparty.
  const noLead = instantlyEmail({ id: 'em_4' });
  delete noLead.lead;
  assert.equal(toConversationMessage(noLead, { leadEmail: LEAD }).direction, 'OUTBOUND');
  assert.equal(toConversationMessage(noLead, {}).direction, 'UNKNOWN');
  ok('the server-resolved lead email is seeded when Instantly omits it');
}

{
  // A malformed row is skipped with a warning; the rest of the thread survives.
  const fetchImpl = stubFetch({ items: [instantlyEmail(), null, 42] });
  const result = await fetchLeadConversation({ apiKey: 'k', leadEmail: LEAD, fetchImpl });
  assert.equal(result.raw_count, 3);
  assert.equal(result.messages.length, 3, 'defensive normalisation keeps even empty rows readable');
  ok('malformed Instantly rows do not throw');
}

// ---------------------------------------------------------------------------
part('C. sender inbox resolution');
// ---------------------------------------------------------------------------

{
  const single = [
    toConversationMessage(instantlyEmail(), { leadEmail: LEAD }),
    toConversationMessage(instantlyEmail({ id: 'em_2', ue_type: 2, from_address_email: LEAD, to_address_email_list: NOVUS }), { leadEmail: LEAD }),
  ];
  assert.deepEqual(resolveSenderInbox(single), {
    sender_status: 'CONFIRMED', eaccount: NOVUS, candidates: [NOVUS],
  });
  ok('one consistent eaccount across the conversation is CONFIRMED');

  const many = [
    ...single,
    toConversationMessage(instantlyEmail({ id: 'em_9', eaccount: 'joe@novushq.co.uk', from_address_email: 'joe@novushq.co.uk' }), { leadEmail: LEAD }),
  ];
  const ambiguous = resolveSenderInbox(many);
  assert.equal(ambiguous.sender_status, 'AMBIGUOUS');
  assert.equal(ambiguous.eaccount, null, 'no sender is silently chosen');
  assert.deepEqual(ambiguous.candidates.sort(), [NOVUS, 'joe@novushq.co.uk'].sort());
  ok('more than one eaccount is AMBIGUOUS with every candidate listed and none chosen');

  assert.deepEqual(resolveSenderInbox([]), { sender_status: 'UNKNOWN', eaccount: null, candidates: [] });
  const noAccount = toConversationMessage(instantlyEmail({ id: 'em_x', eaccount: '' }), { leadEmail: LEAD });
  assert.equal(resolveSenderInbox([noAccount]).sender_status, 'UNKNOWN');
  ok('no eaccount anywhere is UNKNOWN, never a guess');
}

// ---------------------------------------------------------------------------
part('D. merge, dedup and ordering');
// ---------------------------------------------------------------------------

const replyRow = {
  reply_event_id: 'rpl_1',
  instantly_email_id: 'em_2',
  outreach_id: 'out_1',
  lead_email: LEAD,
  campaign_id: 'cmp_1',
  thread_id: 'thr_1',
  received_at: '2026-09-01T14:02:00.000Z',
  subject: 'Re: Your Rightmove enquiry',
  body_text: 'what does it cost and how quickly could we start? On Thu ... wrote:',
  cleaned_reply_text: 'what does it cost and how quickly could we start?',
  classification: 'QUESTION',
};

{
  const liveInbound = toConversationMessage(instantlyEmail({
    id: 'em_2', ue_type: 2, timestamp: '2026-09-01T14:02:00.000Z',
    from_address_email: LEAD, to_address_email_list: NOVUS,
    body: { text: 'LIVE COPY of the same reply' },
  }), { leadEmail: LEAD });
  const liveOutbound = toConversationMessage(instantlyEmail(), { leadEmail: LEAD });

  const built = buildConversation({
    instantlyMessages: [liveInbound, liveOutbound],
    replyEvents: [replyRow],
    outbound: { outbound_id: 'out_1', instantly_added_at: '2026-08-20T08:00:00.000Z' },
  });

  assert.equal(built.messages.length, 2, 'the reply appears once, not twice');
  const [first, second] = built.messages;
  assert.equal(first.instantly_email_id, 'em_1');
  assert.equal(second.instantly_email_id, 'em_2');
  ok('the same inbound message in Instantly and REPLY_EVENTS is emitted once');

  assert.equal(second.source, 'REPLY_EVENTS', 'the durable row is the surviving record');
  assert.equal(second.body_text, 'what does it cost and how quickly could we start?',
    'stored text was not overwritten by the live copy');
  assert.equal(second.classification, 'QUESTION');
  assert.equal(second.eaccount, NOVUS, 'the Instantly-only eaccount was folded in');
  assert.equal(second.enriched_from_instantly, true);
  ok('durable data wins on conflict while Instantly-only fields are preserved');

  assert.equal(built.original_campaign_emails_available, true);
  assert.ok(!built.messages.some((m) => m.message_type === 'CAMPAIGN_ADDED'),
    'no marker is added when the real campaign email came back');
  ok('the campaign-added marker is suppressed when Instantly returned the real outbound email');

  assert.ok(built.warnings.some((w) => w.code === 'deduplicated_messages'));
  ok('the merge reports what it de-duplicated');
}

{
  // Oldest -> newest, and an undated message sorts last rather than first.
  const built = buildConversation({
    instantlyMessages: [
      toConversationMessage(instantlyEmail({ id: 'c', timestamp: '2026-09-03T10:00:00.000Z' }), { leadEmail: LEAD }),
      toConversationMessage(instantlyEmail({ id: 'a', timestamp: '2026-08-01T10:00:00.000Z' }), { leadEmail: LEAD }),
      toConversationMessage(instantlyEmail({ id: 'b', timestamp: '2026-08-28T10:00:00.000Z' }), { leadEmail: LEAD }),
      toConversationMessage(instantlyEmail({ id: 'z', timestamp: '' }), { leadEmail: LEAD }),
    ],
  });
  assert.deepEqual(built.messages.map((m) => m.instantly_email_id), ['a', 'b', 'c', 'z']);
  assert.ok(built.warnings.some((w) => w.code === 'undated_messages'));
  ok('messages are ordered oldest -> newest with undated messages last');
}

{
  // Instantly unavailable: the durable reply still renders, and the campaign
  // handoff appears as a factual marker rather than fabricated email text.
  const built = buildConversation({
    instantlyMessages: [],
    replyEvents: [replyRow],
    outbound: { outbound_id: 'out_1', instantly_added_at: '2026-08-20T08:00:00.000Z' },
  });
  assert.equal(built.messages.length, 2);
  assert.equal(built.messages[0].message_type, 'CAMPAIGN_ADDED');
  assert.equal(built.messages[0].source, 'OUTBOUND');
  assert.equal(built.messages[0].body_text, '', 'no campaign text is invented');
  assert.equal(built.messages[1].source, 'REPLY_EVENTS');
  assert.equal(built.original_campaign_emails_available, false);
  ok('with Instantly unavailable the stored reply and a factual campaign marker still render');

  const noOutbound = buildConversation({ replyEvents: [replyRow] });
  assert.equal(noOutbound.messages.length, 1, 'no marker without a stored instantly_added_at');
  ok('the marker is omitted when OUTBOUND has no instantly_added_at');
}

{
  // SALES_MESSAGES rows join the thread and de-duplicate on the same key.
  const salesRow = {
    sales_message_id: 'smg_1', outreach_id: 'out_1', direction: 'OUTBOUND',
    message_type: 'MANUAL_REPLY', eaccount: NOVUS, instantly_email_id: 'em_5',
    instantly_thread_id: 'thr_1', subject: 'Re: Your Rightmove enquiry',
    body_text: 'Costs depend on volume — happy to walk you through it.',
    sent_at: '2026-09-01T16:30:00.000Z', created_at: '2026-09-01T16:30:00.000Z',
  };
  const live = toConversationMessage(instantlyEmail({
    id: 'em_5', ue_type: 3, timestamp: '2026-09-01T16:30:00.000Z',
    body: { text: 'LIVE COPY' },
  }), { leadEmail: LEAD });

  const built = buildConversation({ instantlyMessages: [live], salesMessages: [salesRow], replyEvents: [replyRow] });
  const sent = built.messages.find((m) => m.instantly_email_id === 'em_5');
  assert.equal(built.messages.length, 2);
  assert.equal(sent.source, 'SALES_MESSAGES');
  assert.equal(sent.sales_message_id, 'smg_1');
  assert.equal(sent.body_text, 'Costs depend on volume — happy to walk you through it.');
  assert.equal(sent.direction, 'OUTBOUND');
  ok('a SALES_MESSAGES row de-duplicates against its live Instantly copy and wins on text');
}

{
  const message = replyEventToMessage(replyRow);
  assert.equal(message.source, 'REPLY_EVENTS');
  assert.equal(message.direction, 'INBOUND');
  assert.equal(message.reply_event_id, 'rpl_1');
  const sales = salesMessageToMessage({ sales_message_id: 's', direction: 'garbage' });
  assert.equal(sales.direction, 'UNKNOWN', 'an unrecognised stored direction is not coerced');
  ok('durable rows normalise into the canonical message shape');
}

// ---------------------------------------------------------------------------
part('E. SALES_MESSAGES schema and tolerant reader');
// ---------------------------------------------------------------------------

{
  assert.equal(SALES_MESSAGES_HEADER[0], 'sales_message_id');
  assert.equal(new Set(SALES_MESSAGES_HEADER).size, SALES_MESSAGES_HEADER.length, 'no duplicate columns');
  for (const column of ['outreach_id', 'agency_id', 'reply_event_id', 'direction', 'message_type', 'eaccount',
    'in_reply_to_email_id', 'instantly_email_id', 'instantly_thread_id', 'instantly_message_id',
    'thread_continuity', 'subject', 'body_text', 'send_outcome', 'instantly_status', 'error',
    'sent_by', 'sent_at', 'created_at']) {
    assert.ok(SALES_MESSAGES_HEADER.includes(column), `${column} is in the schema`);
  }
  ok('the SALES_MESSAGES header carries every audited column exactly once');

  assert.ok(newSalesMessageId().startsWith('smg_'));
  ok('sales_message_id is minted with its own opaque prefix');

  const valid = {
    sales_message_id: 'smg_1', outreach_id: 'out_1', direction: 'OUTBOUND',
    message_type: 'MANUAL_REPLY', eaccount: NOVUS, send_outcome: 'SENT',
    created_at: '2026-09-01T16:30:00.000Z',
  };
  assert.deepEqual(validateSalesMessageRow(valid), { valid: true, errors: [] });
  assert.equal(buildSalesMessageRow(valid).length, SALES_MESSAGES_HEADER.length);
  assert.equal(buildSalesMessageRow(valid)[0], 'smg_1');
  ok('a well-formed row validates and round-trips into header order');

  assert.equal(validateSalesMessageRow({ ...valid, direction: 'INBOUND' }).valid, false);
  assert.equal(validateSalesMessageRow({ ...valid, eaccount: '' }).valid, false);
  assert.equal(validateSalesMessageRow({ ...valid, send_outcome: 'MAYBE' }).valid, false);
  assert.equal(validateSalesMessageRow({ ...valid, nonsense: 'x' }).valid, false);
  assert.equal(validateSalesMessageRow({}).valid, false);
  assert.throws(() => buildSalesMessageRow({}), /invalid SALES_MESSAGES row/);
  ok('inbound direction, a missing sender, an unknown outcome and stray columns are all rejected');

  const table = {
    header: SALES_MESSAGES_HEADER.slice(),
    rows: [
      SALES_MESSAGES_HEADER.map((c) => (c === 'sales_message_id' ? 'SCHEMA NOTE' : '')),
      SALES_MESSAGES_HEADER.map((c) => (valid[c] ?? '')),
      SALES_MESSAGES_HEADER.map(() => ''),
    ],
  };
  const records = parseSalesMessageRecords(table);
  assert.equal(records.length, 1, 'the SCHEMA NOTE row and blank rows are skipped');
  assert.equal(records[0].obj.sales_message_id, 'smg_1');
  assert.deepEqual(parseSalesMessageRecords(null), []);
  assert.deepEqual(parseSalesMessageRecords({ header: [], rows: [] }), []);
  ok('the records parser skips the schema note and tolerates a missing table');
}

{
  // THE TAB DOES NOT EXIST YET. A read of a missing tab must degrade, not throw.
  const missing = await readSalesMessagesForOutreach({
    async getTable() { throw new Error('Unable to parse range: SALES_MESSAGES'); },
  }, 'out_1');
  assert.deepEqual({ available: missing.available, rows: missing.rows }, { available: false, rows: [] });
  assert.ok(missing.error.includes('SALES_MESSAGES'));
  ok('a missing SALES_MESSAGES tab reads as unavailable rather than throwing');

  const present = await readSalesMessagesForOutreach({
    async getTable() {
      return {
        header: SALES_MESSAGES_HEADER.slice(),
        rows: [
          SALES_MESSAGES_HEADER.map((c) => ({ sales_message_id: 'smg_1', outreach_id: 'out_1' }[c] ?? '')),
          SALES_MESSAGES_HEADER.map((c) => ({ sales_message_id: 'smg_2', outreach_id: 'out_OTHER' }[c] ?? '')),
        ],
      };
    },
  }, 'out_1');
  assert.equal(present.available, true);
  assert.equal(present.rows.length, 1, 'only this outreach_id is returned');
  assert.equal(present.rows[0].sales_message_id, 'smg_1');
  ok('an existing tab is read and filtered to the one outreach');
}

// ---------------------------------------------------------------------------
part('F. the API operation is read-only, GET-only and lead-scoped');
// ---------------------------------------------------------------------------

const OUTBOUND_HEADER = [
  'outbound_id', 'agency_id', 'probe_id', 'clean_agency_name', 'outreach_contact_name',
  'outreach_contact_email', 'demo_slug', 'demo_url', 'outbound_status', 'instantly_lead_id',
  'instantly_added_at', 'last_error', 'created_at', 'updated_at',
];
const REPLY_EVENTS_HEADER = [
  'reply_event_id', 'instantly_email_id', 'agency_id', 'outreach_id', 'lead_email',
  'campaign_id', 'thread_id', 'received_at', 'subject', 'body_text', 'cleaned_reply_text',
  'is_auto_reply', 'classification', 'confidence', 'suppression_type', 'next_action',
  'priority', 'processed_at', 'action_status', 'action_completed_at', 'classifier_reason',
  'error', 'notes',
];

const OUTBOUND_ROW = {
  outbound_id: 'out_1', agency_id: 'ag_1', probe_id: 'prb_1',
  clean_agency_name: 'Ashton White', outreach_contact_email: LEAD,
  outbound_status: 'SENT', instantly_lead_id: 'ilead_1',
  instantly_added_at: '2026-08-20T08:00:00.000Z',
};

function fakeRes() {
  const res = { statusCode: 0, body: null, headers: {} };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.end = () => res;
  return res;
}

function installRepo({ outbound = [OUTBOUND_ROW], replies = [], salesTab = null } = {}) {
  const store = {
    OUTBOUND: [OUTBOUND_HEADER.slice(), ...outbound.map((o) => OUTBOUND_HEADER.map((c) => o[c] ?? ''))],
    REPLY_EVENTS: [REPLY_EVENTS_HEADER.slice(), ...replies.map((o) => REPLY_EVENTS_HEADER.map((c) => o[c] ?? ''))],
  };
  if (salesTab) store.SALES_MESSAGES = salesTab;
  const calls = { get: 0, tabs: [], append: 0, update: 0, batchUpdate: 0 };
  const repo = {
    async getTable(tab) {
      calls.get += 1;
      calls.tabs.push(tab);
      if (!store[tab]) throw new Error(`Unable to parse range: ${tab}`);
      const values = store[tab];
      return { header: values[0] || [], rows: values.slice(1), allValues: values };
    },
    async getRecords(tab, idColumn) {
      const { header, rows } = await this.getTable(tab);
      const idIdx = header.indexOf(idColumn);
      const out = [];
      rows.forEach((row, i) => {
        const idVal = idIdx >= 0 ? (row[idIdx] ?? '') : '';
        if (!idVal || idVal === 'SCHEMA NOTE') return;
        const obj = {};
        header.forEach((key, c) => { obj[key] = row[c] ?? ''; });
        out.push({ index: i, rowNumber: i + 2, obj });
      });
      return out;
    },
    async findById(tab, idColumn, idValue) {
      const records = await this.getRecords(tab, idColumn);
      return records.find((r) => r.obj[idColumn] === idValue) || null;
    },
    async appendRecord() { calls.append += 1; throw new Error('WRITE ATTEMPTED'); },
    async appendRowsBatch() { calls.append += 1; throw new Error('WRITE ATTEMPTED'); },
    async updateCell() { calls.update += 1; throw new Error('WRITE ATTEMPTED'); },
    async updateById() { calls.update += 1; throw new Error('WRITE ATTEMPTED'); },
    async writeRowsBatch() { calls.batchUpdate += 1; throw new Error('WRITE ATTEMPTED'); },
    async writeCellsBatch() { calls.batchUpdate += 1; throw new Error('WRITE ATTEMPTED'); },
  };
  __setRepoForTests(repo);
  return calls;
}

// The API branch reads process.env.INSTANTLY_REPLY_API_KEY and calls the real
// global fetch, so the global is stubbed for the duration of these tests. No
// network call is ever made.
const realFetch = globalThis.fetch;
const fetchLog = [];
function installFetch(handler) {
  globalThis.fetch = async (url, init) => {
    fetchLog.push({ url: String(url), method: init?.method });
    return handler(String(url), init);
  };
}

process.env.NOVUS_BASIC_AUTH_USER = 'test-user';
process.env.NOVUS_BASIC_AUTH_PASS = 'test-pass';
const authHeader = `Basic ${Buffer.from('test-user:test-pass').toString('base64')}`;
const AUTHED = { method: 'GET', headers: { authorization: authHeader } };

{
  const calls = installRepo();
  const res = fakeRes();
  await personalisationHandler({ ...AUTHED, headers: {}, query: { novus_operation: 'operator-conversation', outbound_id: 'out_1' } }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(calls.get, 0, 'no tab was read before auth');
  ok('operator-conversation requires Basic Auth before any Sheets read');
}

{
  installRepo();
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = fakeRes();
    await personalisationHandler(
      { method, query: { novus_operation: 'operator-conversation', outbound_id: 'out_1' }, headers: { authorization: authHeader }, body: {} },
      res,
    );
    assert.equal(res.statusCode, 405, `${method} is rejected`);
  }
  ok('operator-conversation is unreachable on any method other than GET');
}

{
  installRepo();
  const res = fakeRes();
  await personalisationHandler({ ...AUTHED, query: { novus_operation: 'operator-conversation' } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Missing outbound_id/);
  ok('a missing outbound_id is a 400');

  const res2 = fakeRes();
  await personalisationHandler({ ...AUTHED, query: { novus_operation: 'operator-conversation', outbound_id: 'nope' } }, res2);
  assert.equal(res2.statusCode, 404);
  ok('an unknown outbound_id is a 404');
}

{
  process.env.INSTANTLY_REPLY_API_KEY = 'test-key';
  const calls = installRepo({ replies: [{ ...replyRow, outreach_id: 'out_1' }] });
  fetchLog.length = 0;
  installFetch(async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        items: [
          instantlyEmail(),
          instantlyEmail({
            id: 'em_2', ue_type: 2, timestamp: '2026-09-01T14:02:00.000Z',
            from_address_email: LEAD, to_address_email_list: NOVUS, body: { text: 'live copy' },
          }),
        ],
      });
    },
  }));

  const res = fakeRes();
  await personalisationHandler({ ...AUTHED, query: { novus_operation: 'operator-conversation', outbound_id: 'out_1' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.headers['cache-control'], 'private, no-store, max-age=0');
  ok('a good request returns 200 and is never proxy-cacheable');

  assert.equal(fetchLog.length, 1, 'exactly ONE Instantly call for one opened lead');
  assert.equal(fetchLog[0].method, 'GET');
  assert.ok(fetchLog[0].url.includes(`lead=${encodeURIComponent(LEAD)}`), 'the call is lead-scoped');
  assert.ok(!fetchLog[0].url.includes('/emails/reply'), 'no reply endpoint is touched');
  ok('one opened lead = one lead-scoped Instantly GET');

  assert.deepEqual({ append: calls.append, update: calls.update, batchUpdate: calls.batchUpdate },
    { append: 0, update: 0, batchUpdate: 0 });
  ok('the operation reaches no Sheets write method');

  assert.equal(res.body.lead_email, LEAD, 'the lead email came from OUTBOUND, server-side');
  assert.deepEqual(res.body.sender_inbox, { status: 'CONFIRMED', eaccount: NOVUS, candidates: [NOVUS] });
  ok('the sending inbox is resolved server-side from the live conversation');

  assert.equal(res.body.conversation.messages.length, 2, 'the reply is not duplicated');
  const ordered = res.body.conversation.messages.map((m) => m.at);
  assert.ok(new Date(ordered[0]) <= new Date(ordered[1]), 'oldest -> newest');
  assert.equal(res.body.conversation.messages[1].source, 'REPLY_EVENTS');
  ok('the response carries one merged, ordered conversation');

  assert.equal(res.body.sales_messages.available, false);
  assert.ok(res.body.warnings.some((w) => w.code === 'sales_messages_unavailable'));
  ok('a missing SALES_MESSAGES tab is a warning, not a failure');

  // The browser cannot choose the sender, the recipient, the thread or the
  // campaign: supplying them changes nothing about the resolved answer.
  fetchLog.length = 0;
  const spoofed = fakeRes();
  await personalisationHandler({
    ...AUTHED,
    query: {
      novus_operation: 'operator-conversation', outbound_id: 'out_1',
      eaccount: 'attacker@evil.com', lead_email: 'victim@evil.com',
      thread_id: 'thr_evil', campaign_id: 'cmp_evil', to: 'victim@evil.com',
    },
  }, spoofed);
  assert.equal(spoofed.body.lead_email, LEAD);
  assert.equal(spoofed.body.sender_inbox.eaccount, NOVUS);
  assert.ok(fetchLog[0].url.includes(`lead=${encodeURIComponent(LEAD)}`));
  assert.ok(!fetchLog[0].url.includes('evil.com'));
  ok('browser-supplied sender, recipient, thread and campaign values are ignored entirely');
}

{
  // INSTANTLY DOWN. The durable Phase 1 data must still come back.
  const calls = installRepo({ replies: [{ ...replyRow, outreach_id: 'out_1' }] });
  for (const failure of [
    async () => ({ ok: false, status: 429, async text() { return JSON.stringify({ error: 'rate limited' }); } }),
    async () => ({ ok: false, status: 500, async text() { return 'upstream boom'; } }),
    async () => { throw new Error('socket hang up'); },
  ]) {
    fetchLog.length = 0;
    installFetch(failure);
    const res = fakeRes();
    await personalisationHandler({ ...AUTHED, query: { novus_operation: 'operator-conversation', outbound_id: 'out_1' } }, res);

    assert.equal(res.statusCode, 200, 'the drawer still gets a payload');
    assert.equal(res.body.instantly.available, false);
    assert.ok(res.body.instantly.error);
    assert.ok(!JSON.stringify(res.body).includes('test-key'), 'the API key is never echoed');
    assert.equal(res.body.sender_inbox.status, 'UNKNOWN');
    assert.equal(res.body.conversation.messages.length, 2, 'stored reply + campaign marker');
    assert.equal(res.body.conversation.messages[0].message_type, 'CAMPAIGN_ADDED');
    assert.equal(res.body.conversation.messages[1].source, 'REPLY_EVENTS');
    assert.ok(res.body.warnings.some((w) => w.code === 'instantly_unavailable'));
  }
  assert.deepEqual({ append: calls.append, update: calls.update, batchUpdate: calls.batchUpdate },
    { append: 0, update: 0, batchUpdate: 0 });
  ok('Instantly 4xx, 5xx and transport failure all degrade to the stored data with no key leak');
}

{
  // No lead email anywhere: no Instantly call is attempted at all.
  installRepo({ outbound: [{ ...OUTBOUND_ROW, outreach_contact_email: '' }] });
  fetchLog.length = 0;
  installFetch(async () => { throw new Error('should not be called'); });
  const res = fakeRes();
  await personalisationHandler({ ...AUTHED, query: { novus_operation: 'operator-conversation', outbound_id: 'out_1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(fetchLog.length, 0, 'no unscoped fetch was attempted');
  assert.equal(res.body.instantly.error.code, 'no_lead_email');
  assert.ok(res.body.warnings.some((w) => w.code === 'lead_email_missing'));
  ok('an OUTBOUND row with no lead email skips the fetch rather than sweeping the workspace');

  // ...unless a stored reply carries one.
  installRepo({
    outbound: [{ ...OUTBOUND_ROW, outreach_contact_email: '' }],
    replies: [{ ...replyRow, outreach_id: 'out_1' }],
  });
  fetchLog.length = 0;
  installFetch(async () => ({ ok: true, status: 200, async text() { return JSON.stringify({ items: [] }); } }));
  const res2 = fakeRes();
  await personalisationHandler({ ...AUTHED, query: { novus_operation: 'operator-conversation', outbound_id: 'out_1' } }, res2);
  assert.equal(res2.body.lead_email, LEAD);
  assert.ok(res2.body.warnings.some((w) => w.code === 'lead_email_from_reply_events'));
  ok('the stored reply address is the documented fallback, and it is reported');
}

{
  // AMBIGUOUS sender: reported, never resolved by picking one.
  installRepo();
  installFetch(async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        items: [
          instantlyEmail(),
          instantlyEmail({ id: 'em_alt', eaccount: 'joe@novushq.co.uk', from_address_email: 'joe@novushq.co.uk' }),
        ],
      });
    },
  }));
  const res = fakeRes();
  await personalisationHandler({ ...AUTHED, query: { novus_operation: 'operator-conversation', outbound_id: 'out_1' } }, res);
  assert.equal(res.body.sender_inbox.status, 'AMBIGUOUS');
  assert.equal(res.body.sender_inbox.eaccount, null);
  assert.ok(res.body.warnings.some((w) => w.code === 'ambiguous_sender_inbox'));
  ok('two sending inboxes on one lead are reported as AMBIGUOUS with no silent choice');
}

{
  // An empty conversation is a valid, non-error answer.
  installRepo();
  installFetch(async () => ({ ok: true, status: 200, async text() { return JSON.stringify({ items: [] }); } }));
  const res = fakeRes();
  await personalisationHandler({ ...AUTHED, query: { novus_operation: 'operator-conversation', outbound_id: 'out_1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.instantly.available, true);
  assert.equal(res.body.conversation.messages.length, 1, 'only the campaign-added marker');
  assert.equal(res.body.conversation.messages[0].message_type, 'CAMPAIGN_ADDED');
  ok('an empty Instantly conversation returns the campaign marker and no error');
}

{
  // SALES_MESSAGES present: read, filtered, merged.
  installRepo({
    salesTab: [
      SALES_MESSAGES_HEADER.slice(),
      SALES_MESSAGES_HEADER.map((c) => ({
        sales_message_id: 'smg_1', outreach_id: 'out_1', direction: 'OUTBOUND',
        message_type: 'MANUAL_REPLY', eaccount: NOVUS, body_text: 'stored NOVUS reply',
        sent_at: '2026-09-01T16:30:00.000Z', created_at: '2026-09-01T16:30:00.000Z',
      }[c] ?? '')),
      SALES_MESSAGES_HEADER.map((c) => ({ sales_message_id: 'smg_2', outreach_id: 'out_OTHER' }[c] ?? '')),
    ],
  });
  installFetch(async () => ({ ok: true, status: 200, async text() { return JSON.stringify({ items: [instantlyEmail()] }); } }));
  const res = fakeRes();
  await personalisationHandler({ ...AUTHED, query: { novus_operation: 'operator-conversation', outbound_id: 'out_1' } }, res);
  assert.equal(res.body.sales_messages.available, true);
  assert.equal(res.body.sales_messages.count, 1, 'only this outreach_id');
  const stored = res.body.conversation.messages.find((m) => m.sales_message_id === 'smg_1');
  assert.equal(stored.body_text, 'stored NOVUS reply');
  ok('an existing SALES_MESSAGES tab is read for this outreach only and merged into the thread');
}

// ---------------------------------------------------------------------------
part('G. no send, no AI and no classifier change is reachable from Phase 2');
// ---------------------------------------------------------------------------

{
  const fs = await import('node:fs/promises');
  const html = await fs.readFile('novus/operator.html', 'utf8');
  assert.ok(!/<textarea/i.test(html), 'no textarea');
  assert.ok(!/send-demo/.test(html), 'the send-demo operation is not reachable from the page');
  assert.ok(!/novus_operation=instantly-reply-poll(?!-dry-run)/.test(html), 'the live poller is not reachable from the page');
  assert.ok(!/method:\s*'POST'/i.test(html), 'the page issues no POST');
  assert.ok(html.includes('operator-conversation'), 'the page does call the read-only conversation operation');
  assert.ok(html.includes('SALES CONVERSATION') || html.includes('Sales conversation'), 'the section exists');
  assert.ok(html.includes('Probe finding'), 'the probe section is still present and separate');
  ok('the operator page is view-only: no textarea, no POST, no send or generate control');

  const api = await fs.readFile('api/novus/personalisation.js', 'utf8');
  const handler = api.slice(api.indexOf('async function handleOperatorConversation'),
    api.indexOf('// SEND_DEMO execution gate, DRY RUN'));
  assert.ok(!/executeSendDemo|evaluateSendDemoDryRun|pollInstantlyReplies|classifyReply/.test(handler),
    'the handler calls no send, poll or classification function');
  assert.ok(!/appendRecord|updateById|updateCell|writeRowsBatch|writeCellsBatch|appendRowsBatch/.test(handler),
    'the handler calls no Sheets writer');
  ok('the conversation handler reaches no send, no poller, no classifier and no writer');
}

globalThis.fetch = realFetch;
__setRepoForTests(null);
delete process.env.INSTANTLY_REPLY_API_KEY;

console.log(`\nNOVUS operator-conversation self-test passed (${passed} focused assertions).`);
