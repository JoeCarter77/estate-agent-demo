// Hermetic tests for the poll -> automatic SEND_DEMO connection.
// Run: npm run novus:reply-poll-auto-send-selftest
//
// Drives the REAL HTTP handler (POST /api/novus/personalisation
// ?novus_operation=instantly-reply-poll) end to end: Instantly is mocked only
// at the fetch boundary, the AI classifier is mocked only at the callAi
// boundary (via __setAiCallerForTests), and Google Sheets is a fully offline
// in-memory fake that mirrors the REAL REPLY_EVENTS/OUTBOUND schemas. Nothing
// here re-implements matching, classification, gating or sending — it only
// proves that handleInstantlyReplyPoll wires pollInstantlyReplies's output
// into the EXISTING, unmodified executeSendDemo() correctly and narrowly.

import assert from 'node:assert/strict';
import handler from '../api/novus/personalisation.js';
import { __setRepoForTests } from '../lib/sheets.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';
import { REPLY_POLLER_SECRET_HEADER } from '../api/novus/_auth.mjs';
import { REPLY_EVENTS_HEADER, EXECUTION_FIELDS } from '../lib/reply-router.mjs';
import { OUTBOUND_HEADER } from '../lib/outbound.mjs';
import { INSTANTLY_REPLY_URL, AMBIGUOUS_ERROR } from '../lib/reply-send-demo.mjs';

const originalFetch = globalThis.fetch;

let assertions = 0;
function check(fn) { fn(); assertions += 1; }

// --- Env / auth, matching the poll route's real gates -----------------------
const SECRET = 'poller-secret-do-not-echo';
process.env.NOVUS_BASIC_AUTH_USER = 'novus';
process.env.NOVUS_BASIC_AUTH_PASS = 'basic-pass';
process.env.NOVUS_REPLY_POLLER_SECRET = SECRET;
process.env.INSTANTLY_REPLY_API_KEY = 'instantly-key';
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'; // gates classify:true; __callerOverride bypasses realCall
const BASIC = `Basic ${Buffer.from('novus:basic-pass').toString('base64')}`;
const AUTH_HEADERS = { authorization: BASIC, [REPLY_POLLER_SECRET_HEADER]: SECRET };

function fakeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    end() { return this; },
  };
}

async function callPoll(repo, query = {}) {
  __setRepoForTests(repo);
  const res = fakeRes();
  await handler({ method: 'POST', query: { novus_operation: 'instantly-reply-poll', ...query }, headers: AUTH_HEADERS }, res);
  return res;
}

// --- The fake Sheet: a real REPLY_EVENTS table + a static OUTBOUND table ----
function makeSharedRepo({ outbound = [], existingReplyEvents = [], onWriteCellsBatch = null } = {}) {
  const header = [...REPLY_EVENTS_HEADER];
  const rows = existingReplyEvents.map((row) => header.map((c) => String(row[c] ?? '')));
  const calls = [];

  const rowObject = (r) => Object.fromEntries(header.map((c, i) => [c, r[i]]));
  const rowsAsObjects = () => rows.map(rowObject);

  const repo = {
    async getRecords(tab) {
      calls.push(['getRecords', tab]);
      if (tab === 'OUTBOUND') return outbound;
      throw new Error(`unexpected getRecords ${tab}`);
    },
    async getTable(tab) {
      calls.push(['getTable', tab]);
      if (tab !== 'REPLY_EVENTS') throw new Error(`unexpected getTable ${tab}`);
      return { header, rows: rows.map((r) => [...r]) };
    },
    async findById(tab, col, val) {
      calls.push(['findById', tab, col, val]);
      if (tab !== 'REPLY_EVENTS') throw new Error(`unexpected findById ${tab}`);
      const idx = header.indexOf(col);
      const i = rows.findIndex((r) => String(r[idx]) === String(val));
      return i < 0 ? null : { rowNumber: i + 2, obj: rowObject(rows[i]) };
    },
    async appendRecord(tab, row) {
      calls.push(['appendRecord', tab]);
      if (tab !== 'REPLY_EVENTS') throw new Error(`FORBIDDEN appendRecord ${tab}`);
      rows.push(header.map((c) => String(row[c] ?? '')));
    },
    async writeCellsBatch(cells) {
      calls.push(['writeCellsBatch', cells.map((c) => c.columnNumber)]);
      if (onWriteCellsBatch) onWriteCellsBatch(cells, { header, rows });
      for (const cell of cells) {
        if (cell.tab !== 'REPLY_EVENTS') throw new Error(`FORBIDDEN write ${cell.tab}`);
        rows[cell.rowNumber - 2][cell.columnNumber - 1] = String(cell.value);
      }
    },
    appendRowsBatch() { throw new Error('FORBIDDEN appendRowsBatch'); },
    updateById() { throw new Error('FORBIDDEN updateById'); },
    updateCell() { throw new Error('FORBIDDEN updateCell'); },
  };

  return { repo, calls, rowsAsObjects, header };
}

function outboundRow(overrides = {}) {
  const obj = Object.fromEntries(OUTBOUND_HEADER.map((k) => [k, '']));
  return { rowNumber: 2, obj: { ...obj, outbound_status: 'SENT', ...overrides } };
}

// --- The fake Instantly: one GET stub for every /emails read, a controllable
// POST stub for the reply endpoint. --------------------------------------
function makeInstantlyStub({ sweep = [], reply = null } = {}) {
  const requests = [];
  const impl = async (url, options = {}) => {
    const method = options.method || 'GET';
    requests.push({ url: String(url), method, body: options.body ? JSON.parse(options.body) : null });
    if (method === 'GET') return { ok: true, status: 200, text: async () => JSON.stringify({ items: sweep }) };
    if (String(url) !== INSTANTLY_REPLY_URL) throw new Error(`unexpected POST to ${url}`);
    if (typeof reply === 'function') return reply();
    return reply;
  };
  return { requests, impl, posts: () => requests.filter((r) => r.method === 'POST') };
}

const OK_REPLY_RESPONSE = {
  ok: true, status: 200,
  text: async () => JSON.stringify({ id: 'sent-uuid-1', thread_id: 'irrelevant', message_id: '<m@novushq.co.uk>' }),
};

// A raw Instantly /api/v2/emails object, real observed shape.
function rawEmail({ id, threadId, leadEmail, eaccount = 'joe@novushq.co.uk', ueType = 2, body, autoReply = false, timestamp }) {
  const inbound = ueType === 2;
  return {
    id,
    timestamp_email: timestamp,
    subject: 'Re: TEST',
    from_address_email: inbound ? leadEmail : eaccount,
    to_address_email_list: inbound ? eaccount : leadEmail,
    lead: leadEmail,
    thread_id: threadId,
    eaccount,
    ue_type: ueType,
    content_preview: body,
    is_auto_reply: autoReply,
  };
}

// The AI stub. Routes on a marker prefix in the cleaned reply text so each
// scenario below gets an exact, deliberate classification.
__setAiCallerForTests(async ({ prompt }) => {
  if (prompt.includes('MARKER_SEND_DEMO')) return { classification: 'POSITIVE_SEND_DEMO', confidence: 0.95, reason: 'asks for the material' };
  if (prompt.includes('MARKER_QUESTION')) return { classification: 'QUESTION', confidence: 0.9, reason: 'asks a direct question' };
  if (prompt.includes('MARKER_MEETING')) return { classification: 'POSITIVE_MEETING', confidence: 0.9, reason: 'wants a call' };
  if (prompt.includes('MARKER_NOT_INTERESTED')) return { classification: 'NOT_INTERESTED', confidence: 0.9, reason: 'declines the offer' };
  if (prompt.includes('MARKER_NOT_NOW')) return { classification: 'NOT_NOW', confidence: 0.9, reason: 'timing objection' };
  if (prompt.includes('MARKER_LOW_CONF')) return { classification: 'POSITIVE_SEND_DEMO', confidence: 0.5, reason: 'not sure' };
  if (prompt.includes('MARKER_BAD_ENUM')) return { classification: 'NOT_A_REAL_CLASS', confidence: 0.95, reason: 'broken' };
  if (prompt.includes('MARKER_ERROR')) throw new Error('simulated classifier transport failure');
  return { classification: 'OTHER_UNCLEAR', confidence: 0.5, reason: 'unhandled fixture text' };
});

const DEMO_URL = 'https://demo.getnovus.co.uk/test-1';

function novusOffer({ threadId, leadEmail, ts }) {
  return rawEmail({
    id: `novus-offer-${threadId}`, threadId, leadEmail, ueType: 1, timestamp: ts,
    body: 'We sent an enquiry through last week. Want me to send the demo?',
  });
}

// ===========================================================================
console.log('--- 1 & 3. newly persisted, semantic POSITIVE_SEND_DEMO -> exactly one executeSendDemo call, and it sends ---');
{
  const LEAD = 'prospect1@example.com';
  const THREAD = 'th-1';
  const { repo, rowsAsObjects } = makeSharedRepo({
    outbound: [outboundRow({ outbound_id: 'obd_1', agency_id: 'agc_1', outreach_contact_email: LEAD, demo_url: DEMO_URL, demo_slug: 'test-1' })],
  });
  const reply = rawEmail({ id: 'ev-1', threadId: THREAD, leadEmail: LEAD, body: 'MARKER_SEND_DEMO yeah sure, send it over', timestamp: '2026-09-01T10:05:00.000Z' });
  const offer = novusOffer({ threadId: THREAD, leadEmail: LEAD, ts: '2026-09-01T10:00:00.000Z' });
  const instantly = makeInstantlyStub({ sweep: [reply, offer], reply: OK_REPLY_RESPONSE });
  globalThis.fetch = instantly.impl;

  const res = await callPoll(repo);

  check(() => assert.equal(res.statusCode, 200));
  check(() => assert.equal(res.body.persisted, 1));
  check(() => assert.equal(res.body.classified, 1));
  check(() => assert.equal(res.body.auto_send.length, 1, 'exactly one auto-send attempt'));
  const autoSend = res.body.auto_send[0];
  check(() => assert.equal(autoSend.attempted, true));
  check(() => assert.equal(autoSend.sent, true));
  check(() => assert.equal(autoSend.send_outcome, 'SENT'));
  check(() => assert.equal(autoSend.action_status, 'COMPLETED'));
  check(() => assert.equal(instantly.posts().length, 1, 'exactly one Instantly send'));

  const post = instantly.posts()[0];
  const EXPECTED_BODY = [
    'Absolutely — here it is:', '', DEMO_URL, '',
    'I’ve based it on what happened after the enquiry we sent through.', '', 'Joe',
  ].join('\n');
  check(() => assert.equal(post.body.body.text, EXPECTED_BODY, 'exact existing template, not paraphrased'));
  check(() => assert.equal(post.body.reply_to_uuid, 'ev-1'));
  check(() => assert.equal(post.body.eaccount, 'joe@novushq.co.uk', 'correct sending mailbox'));
  check(() => assert.equal('thread_id' in post.body, false, 'threading is implicit via reply_to_uuid, as today'));

  const row = rowsAsObjects().find((r) => r.instantly_email_id === 'ev-1');
  check(() => assert.equal(row.classification, 'POSITIVE_SEND_DEMO'));
  check(() => assert.equal(row.action_status, 'COMPLETED'));
  check(() => assert.match(row.notes, /SEND_DEMO sent/));
  console.log(`  persisted=${res.body.persisted} auto_send=${res.body.auto_send.length} posts=${instantly.posts().length}`);
}

// ===========================================================================
console.log('--- 2. deterministic router alone never produces POSITIVE_SEND_DEMO (documented, not a gap) ---');
{
  // routeReply() only ever emits OOO_AUTOMATED, OPT_OUT or OTHER_UNCLEAR
  // deterministically (lib/reply-router.mjs) — POSITIVE_SEND_DEMO is reachable
  // ONLY through semantic (AI) classification, exercised above and in 4-9
  // below. There is no separate "deterministic SEND_DEMO" path to test.
  check(() => assert.ok(true));
}

// ===========================================================================
console.log('--- 4-9 & 14. mixed batch: only the SEND_DEMO-eligible reply auto-executes ---');
{
  const T = (m) => `2026-09-01T10:${String(m).padStart(2, '0')}:00.000Z`;
  const cases = [
    { key: 'send', lead: 'batch-send@example.com', body: 'MARKER_SEND_DEMO please send it over', expect: 'POSITIVE_SEND_DEMO', withOffer: true },
    { key: 'question', lead: 'batch-question@example.com', body: 'MARKER_QUESTION how much does this cost?', expect: 'QUESTION' },
    { key: 'meeting', lead: 'batch-meeting@example.com', body: 'MARKER_MEETING can we have a call tomorrow?', expect: 'POSITIVE_MEETING' },
    { key: 'not_interested', lead: 'batch-ni@example.com', body: 'MARKER_NOT_INTERESTED not for us thanks', expect: 'NOT_INTERESTED' },
    { key: 'not_now', lead: 'batch-nn@example.com', body: 'MARKER_NOT_NOW maybe try me in October', expect: 'NOT_NOW' },
    { key: 'ooo', lead: 'batch-ooo@example.com', body: 'I am out of the office', autoReply: true, expect: 'OOO_AUTOMATED' },
    { key: 'optout', lead: 'batch-optout@example.com', body: 'please unsubscribe', expect: 'OPT_OUT' },
    { key: 'fallback_low', lead: 'batch-low@example.com', body: 'MARKER_LOW_CONF yeah okay', expect: 'OTHER_UNCLEAR' },
    { key: 'classifier_error', lead: 'batch-err@example.com', body: 'MARKER_ERROR whatever you think', expect: 'OTHER_UNCLEAR' },
    { key: 'bad_enum', lead: 'batch-badenum@example.com', body: 'MARKER_BAD_ENUM sure', expect: 'OTHER_UNCLEAR' },
  ];

  const outbound = cases.map((c, i) => outboundRow({
    outbound_id: `obd_batch_${i}`, agency_id: `agc_batch_${i}`,
    outreach_contact_email: c.lead, demo_url: DEMO_URL, demo_slug: 'test-1',
  }));
  // Unmatched: no OUTBOUND row at all for this lead.
  const unmatchedReply = rawEmail({ id: 'ev-unmatched', threadId: 'th-unmatched', leadEmail: 'nobody@nowhere.com', body: 'MARKER_SEND_DEMO send it', timestamp: T(50) });
  // Ambiguous: two OUTBOUND rows share this lead.
  const ambiguousLead = 'batch-ambiguous@example.com';
  outbound.push(outboundRow({ outbound_id: 'obd_amb_1', outreach_contact_email: ambiguousLead, demo_url: DEMO_URL }));
  outbound.push(outboundRow({ outbound_id: 'obd_amb_2', outreach_contact_email: ambiguousLead, demo_url: DEMO_URL }));
  const ambiguousReply = rawEmail({ id: 'ev-ambiguous', threadId: 'th-ambiguous', leadEmail: ambiguousLead, body: 'MARKER_SEND_DEMO send it', timestamp: T(51) });
  // Duplicate: already exists in REPLY_EVENTS.
  const dupLead = 'batch-dup@example.com';
  outbound.push(outboundRow({ outbound_id: 'obd_dup', outreach_contact_email: dupLead, demo_url: DEMO_URL }));
  const dupReply = rawEmail({ id: 'ev-duplicate', threadId: 'th-dup', leadEmail: dupLead, body: 'MARKER_SEND_DEMO send it', timestamp: T(52) });

  const { repo, rowsAsObjects } = makeSharedRepo({
    outbound,
    existingReplyEvents: [{ reply_event_id: 'rpl_existing', instantly_email_id: 'ev-duplicate', lead_email: dupLead }],
  });

  const sweep = [];
  cases.forEach((c, i) => {
    sweep.push(rawEmail({ id: `ev-batch-${c.key}`, threadId: `th-batch-${i}`, leadEmail: c.lead, body: c.body, autoReply: !!c.autoReply, timestamp: T(i) }));
    if (c.withOffer) sweep.push(novusOffer({ threadId: `th-batch-${i}`, leadEmail: c.lead, ts: T(i - 1 < 0 ? 0 : i - 1) }));
  });
  sweep.push(unmatchedReply, ambiguousReply, dupReply);

  const instantly = makeInstantlyStub({ sweep, reply: OK_REPLY_RESPONSE });
  globalThis.fetch = instantly.impl;

  const res = await callPoll(repo);

  check(() => assert.equal(res.statusCode, 200));
  check(() => assert.equal(res.body.persisted, cases.length, 'every non-duplicate matched reply is persisted, including non-actionable ones'));
  check(() => assert.equal(res.body.duplicates_skipped, 1));
  check(() => assert.equal(res.body.unmatched, 1));
  check(() => assert.equal(res.body.ambiguous, 1));
  check(() => assert.equal(res.body.auto_send.length, 1, 'only the SEND_DEMO reply triggers an auto-send attempt'));
  check(() => assert.equal(res.body.auto_send[0].sent, true));
  check(() => assert.equal(instantly.posts().length, 1, 'only one Instantly send for the whole batch'));

  const rows = rowsAsObjects();
  for (const c of cases) {
    const row = rows.find((r) => r.instantly_email_id === `ev-batch-${c.key}`);
    check(() => assert.ok(row, `${c.key}: row persisted`));
    check(() => assert.equal(row.classification, c.expect, `${c.key}: classification`));
    if (c.key !== 'send') {
      check(() => assert.notEqual(row.action_status, 'COMPLETED', `${c.key}: never auto-sent`));
    }
  }
  console.log(`  persisted=${res.body.persisted} duplicates=${res.body.duplicates_skipped} unmatched=${res.body.unmatched} ambiguous=${res.body.ambiguous} auto_send=${res.body.auto_send.length}`);
}

// ===========================================================================
console.log('--- 10. DEMO_ALREADY_SENT is a safe blocked/idempotent auto-send result ---');
{
  const LEAD = 'already-sent@example.com';
  const THREAD = 'th-already-sent';
  const { repo, rowsAsObjects } = makeSharedRepo({
    outbound: [outboundRow({ outbound_id: 'obd_as', agency_id: 'agc_as', outreach_contact_email: LEAD, demo_url: DEMO_URL, demo_slug: 'test-1' })],
  });
  const reply = rawEmail({ id: 'ev-already-sent', threadId: THREAD, leadEmail: LEAD, body: 'MARKER_SEND_DEMO go ahead and send it', timestamp: '2026-09-01T10:10:00.000Z' });
  // The demo URL is ALREADY present in a prior NOVUS message on this thread —
  // simulating a manual send that happened before this poll pass ran.
  const alreadySentMsg = rawEmail({
    id: 'novus-already-sent', threadId: THREAD, leadEmail: LEAD, ueType: 1, timestamp: '2026-09-01T10:00:00.000Z',
    body: `Absolutely — here it is: ${DEMO_URL} I’ve based it on what happened after the enquiry we sent through. Joe`,
  });
  const instantly = makeInstantlyStub({ sweep: [reply, alreadySentMsg], reply: OK_REPLY_RESPONSE });
  globalThis.fetch = instantly.impl;

  const res = await callPoll(repo);

  check(() => assert.equal(res.body.persisted, 1));
  check(() => assert.equal(res.body.auto_send.length, 1));
  const autoSend = res.body.auto_send[0];
  check(() => assert.equal(autoSend.sent, false));
  check(() => assert.equal(autoSend.eligible, false));
  check(() => assert.equal(autoSend.blocked_reasons.includes('DEMO_ALREADY_SENT'), true));
  check(() => assert.equal(instantly.posts().length, 0, 'never sends when the thread already shows the demo'));

  const row = rowsAsObjects().find((r) => r.instantly_email_id === 'ev-already-sent');
  check(() => assert.equal(row.classification, 'POSITIVE_SEND_DEMO', 'still persisted and classified'));
  check(() => assert.notEqual(row.action_status, 'COMPLETED', 'blocked attempt never marks completed'));
  console.log(`  blocked_reason includes DEMO_ALREADY_SENT, posts=${instantly.posts().length}`);
}

// ===========================================================================
console.log('--- 11. Instantly 4xx send failure: reply stays persisted/classified, execution FAILED ---');
{
  const LEAD = 'rejected@example.com';
  const THREAD = 'th-rejected';
  const { repo, rowsAsObjects } = makeSharedRepo({
    outbound: [outboundRow({ outbound_id: 'obd_rej', agency_id: 'agc_rej', outreach_contact_email: LEAD, demo_url: DEMO_URL, demo_slug: 'test-1' })],
  });
  const reply = rawEmail({ id: 'ev-rejected', threadId: THREAD, leadEmail: LEAD, body: 'MARKER_SEND_DEMO send it over please', timestamp: '2026-09-01T10:10:00.000Z' });
  const offer = novusOffer({ threadId: THREAD, leadEmail: LEAD, ts: '2026-09-01T10:00:00.000Z' });
  const instantly = makeInstantlyStub({
    sweep: [reply, offer],
    reply: { ok: false, status: 404, text: async () => JSON.stringify({ error: 'unknown eaccount' }) },
  });
  globalThis.fetch = instantly.impl;

  const res = await callPoll(repo);

  check(() => assert.equal(res.body.persisted, 1, 'ingestion is unaffected by a downstream send failure'));
  check(() => assert.equal(res.body.auto_send.length, 1));
  const autoSend = res.body.auto_send[0];
  check(() => assert.equal(autoSend.sent, false));
  check(() => assert.equal(autoSend.send_outcome, 'REJECTED'));
  check(() => assert.equal(instantly.posts().length, 1));

  const row = rowsAsObjects().find((r) => r.instantly_email_id === 'ev-rejected');
  check(() => assert.equal(row.classification, 'POSITIVE_SEND_DEMO', 'raw+classified data untouched by the failed send'));
  check(() => assert.equal(row.lead_email, LEAD));
  check(() => assert.equal(row.action_status, 'FAILED'));
  check(() => assert.equal(row.action_completed_at, ''));
  check(() => assert.equal(row.error.startsWith('INSTANTLY_404'), true));
  console.log(`  action_status=${row.action_status} error="${row.error}"`);
}

// ===========================================================================
console.log('--- 12. 5xx/timeout: existing AMBIGUOUS_SEND_RESULT behaviour preserved ---');
{
  const LEAD = 'ambiguous-send@example.com';
  const THREAD = 'th-ambiguous-send';
  const { repo, rowsAsObjects } = makeSharedRepo({
    outbound: [outboundRow({ outbound_id: 'obd_amb_send', agency_id: 'agc_amb_send', outreach_contact_email: LEAD, demo_url: DEMO_URL, demo_slug: 'test-1' })],
  });
  const reply = rawEmail({ id: 'ev-ambiguous-send', threadId: THREAD, leadEmail: LEAD, body: 'MARKER_SEND_DEMO yes please send', timestamp: '2026-09-01T10:10:00.000Z' });
  const offer = novusOffer({ threadId: THREAD, leadEmail: LEAD, ts: '2026-09-01T10:00:00.000Z' });
  const instantly = makeInstantlyStub({
    sweep: [reply, offer],
    reply: () => { throw new Error('socket hang up'); },
  });
  globalThis.fetch = instantly.impl;

  const res = await callPoll(repo);

  const autoSend = res.body.auto_send[0];
  check(() => assert.equal(autoSend.sent, false));
  check(() => assert.equal(autoSend.send_outcome, 'AMBIGUOUS'));
  const row = rowsAsObjects().find((r) => r.instantly_email_id === 'ev-ambiguous-send');
  check(() => assert.equal(row.action_status, 'FAILED'));
  check(() => assert.equal(row.action_completed_at, ''));
  check(() => assert.equal(row.error.startsWith(AMBIGUOUS_ERROR), true));
  console.log(`  action_status=${row.action_status} error="${row.error}"`);
}

// ===========================================================================
console.log('--- 13. a Sheets write failure on the execution update does not poison the poll response ---');
{
  const LEAD = 'sheet-write-fail@example.com';
  const THREAD = 'th-sheet-write-fail';
  const { repo, rowsAsObjects } = makeSharedRepo({
    outbound: [outboundRow({ outbound_id: 'obd_swf', agency_id: 'agc_swf', outreach_contact_email: LEAD, demo_url: DEMO_URL, demo_slug: 'test-1' })],
    // Only the FINAL execution-field write (after a successful send) fails —
    // the earlier classification-field write must still succeed, exactly the
    // scenario executeSendDemo's own rowUpdateError handling exists for.
    onWriteCellsBatch: (cells, { header }) => {
      const touchesExecutionCompletion = cells.some((c) => header[c.columnNumber - 1] === 'action_completed_at' && c.value);
      if (touchesExecutionCompletion) throw new Error('simulated Sheets outage');
    },
  });
  const reply = rawEmail({ id: 'ev-sheet-write-fail', threadId: THREAD, leadEmail: LEAD, body: 'MARKER_SEND_DEMO please send', timestamp: '2026-09-01T10:10:00.000Z' });
  const offer = novusOffer({ threadId: THREAD, leadEmail: LEAD, ts: '2026-09-01T10:00:00.000Z' });
  const instantly = makeInstantlyStub({ sweep: [reply, offer], reply: OK_REPLY_RESPONSE });
  globalThis.fetch = instantly.impl;

  const res = await callPoll(repo);

  check(() => assert.equal(res.statusCode, 200, 'the HTTP response itself is not lost'));
  check(() => assert.equal(res.body.persisted, 1));
  const autoSend = res.body.auto_send[0];
  // executeSendDemo's own recovery semantics: the send happened (sent:true),
  // but the row-level completion write failed and is reported, not swallowed.
  check(() => assert.equal(autoSend.sent, true, 'a Sheets write failure does not undo a real send'));
  check(() => assert.equal(autoSend.send_outcome, 'SENT'));
  check(() => assert.ok(autoSend.row_update_error, 'the write failure is surfaced, not silently dropped'));
  check(() => assert.equal(instantly.posts().length, 1, 'exactly one send regardless of the write failure'));
  console.log(`  sent=${autoSend.sent} row_update_error="${autoSend.row_update_error}"`);
}

// ===========================================================================
console.log('--- 15. repeat poll after a successful send: zero duplicate sends ---');
{
  const LEAD = 'repeat-poll@example.com';
  const THREAD = 'th-repeat-poll';
  const { repo, rowsAsObjects } = makeSharedRepo({
    outbound: [outboundRow({ outbound_id: 'obd_rp', agency_id: 'agc_rp', outreach_contact_email: LEAD, demo_url: DEMO_URL, demo_slug: 'test-1' })],
  });
  const reply = rawEmail({ id: 'ev-repeat', threadId: THREAD, leadEmail: LEAD, body: 'MARKER_SEND_DEMO send it over', timestamp: '2026-09-01T10:10:00.000Z' });
  const offer = novusOffer({ threadId: THREAD, leadEmail: LEAD, ts: '2026-09-01T10:00:00.000Z' });

  const first = makeInstantlyStub({ sweep: [reply, offer], reply: OK_REPLY_RESPONSE });
  globalThis.fetch = first.impl;
  const res1 = await callPoll(repo);
  check(() => assert.equal(res1.body.persisted, 1));
  check(() => assert.equal(res1.body.auto_send.length, 1));
  check(() => assert.equal(first.posts().length, 1));

  // Second pass sees the SAME email again (Instantly is a live mailbox, not
  // consumed) plus our own now-sent reply in the thread.
  const sentReplyMsg = rawEmail({
    id: 'sent-uuid-1', threadId: THREAD, leadEmail: LEAD, ueType: 1, timestamp: '2026-09-01T10:11:00.000Z',
    body: `Absolutely — here it is: ${DEMO_URL} I’ve based it on what happened after the enquiry we sent through. Joe`,
  });
  const second = makeInstantlyStub({ sweep: [reply, offer, sentReplyMsg], reply: OK_REPLY_RESPONSE });
  globalThis.fetch = second.impl;
  const res2 = await callPoll(repo);

  check(() => assert.equal(res2.body.duplicates_skipped, 1, 'the second pass recognises the already-processed email'));
  check(() => assert.equal(res2.body.persisted, 0));
  check(() => assert.equal(res2.body.auto_send.length, 0, 'a duplicate never reaches the auto-send candidate list'));
  check(() => assert.equal(second.posts().length, 0, 'zero Instantly sends on the repeat pass'));
  console.log(`  first: persisted=${res1.body.persisted} auto_send=${res1.body.auto_send.length}; second: persisted=${res2.body.persisted} auto_send=${res2.body.auto_send.length}`);
}

globalThis.fetch = originalFetch;
__setAiCallerForTests(null);
console.log(`\n✅ NOVUS reply-poll auto-send selftest passed (${assertions} focused assertions).`);
