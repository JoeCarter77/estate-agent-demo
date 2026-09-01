// Hermetic NOVUS POSITIVE_SEND_DEMO execution-gate tests (DRY RUN ONLY).
// Run: npm run novus:send-demo-selftest
//
// Fully offline. globalThis.fetch THROWS, so any unstubbed network access fails
// the suite. The repo is an in-memory fake whose EVERY write method throws:
// appendRecord, writeCell, writeCellsBatch, updateRecord. A dry run that wrote
// anything — to REPLY_EVENTS, to OUTBOUND, anywhere — fails here rather than
// passing quietly. The Instantly reply URL is likewise asserted never to be
// fetched.

import assert from 'node:assert/strict';
import {
  evaluateSendDemoGate,
  evaluateSendDemoDryRun,
  buildDemoReplyBody,
  buildReplySubject,
  buildInstantlyReplyPayload,
  buildSendDemoNote,
  hasSendDemoMarker,
  demoSentEvidence,
  resolveOutboundForSend,
  isValidDemoUrl,
  INSTANTLY_REPLY_URL,
  SEND_DEMO_CONFIDENCE_THRESHOLD,
} from '../lib/reply-send-demo.mjs';
import {
  REPLY_EVENTS_HEADER,
  RAW_EVIDENCE_FIELDS,
  EXECUTION_FIELDS,
  updateReplyEventExecution,
  normalizeInstantlyEmail,
} from '../lib/reply-router.mjs';
import { OUTBOUND_HEADER } from '../lib/outbound.mjs';

const originalFetch = globalThis.fetch;
globalThis.fetch = (...args) => { throw new Error(`FORBIDDEN network access: ${args[0]}`); };

let assertions = 0;
function check(fn) { fn(); assertions += 1; }

// --- Fixtures ---------------------------------------------------------------
const LEAD = 'joedcarter1@gmail.com';
const EACCOUNT = 'joe@novushq.co.uk';
const THREAD = 'ba-AayEOdow6Hjmghl06cSGgbe';
const REPLY_ID = '01a0596e-d338-72e6-a586-98eac9e4ba20';
const DEMO_URL = 'https://demo.getnovus.co.uk/test-1';

const RAW_REPLY = {
  id: REPLY_ID,
  timestamp_email: '2026-08-31T20:07:11.000Z',
  subject: 'Re: TEST',
  from_address_email: LEAD,
  to_address_email_list: EACCOUNT,
  lead: LEAD,
  campaign_id: 'ba02b5cd-f734-465a-9251-1a565270b876',
  thread_id: THREAD,
  eaccount: EACCOUNT,
  ue_type: 2,
  content_preview: 'Yes send',
};

// Our own earlier campaign message on the same thread. It does NOT contain the
// demo URL, which is what makes demo_already_sent answerable as NOT_SENT.
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
  content_preview: 'We sent an enquiry through to you last week. Want me to send the breakdown?',
};

const RAW_NOVUS_WITH_DEMO = {
  ...RAW_NOVUS_OUTBOUND,
  id: 'novus-outbound-2',
  content_preview: `Absolutely — here it is: ${DEMO_URL}`,
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
    campaign_id: RAW_REPLY.campaign_id,
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
    action_completed_at: '',
    classifier_reason: 'explicitly asks for the material to be sent',
    error: '',
    notes: '',
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

const OUTBOUND = [outboundRecord()];
const THREAD_MESSAGES = [RAW_REPLY, RAW_NOVUS_OUTBOUND].map((r) => normalizeInstantlyEmail(r));
const REPLY = THREAD_MESSAGES.find((m) => m.email_id === REPLY_ID);

function gate(overrides = {}) {
  return evaluateSendDemoGate({
    row: replyRow(overrides.row || {}),
    reply: 'reply' in overrides ? overrides.reply : REPLY,
    outboundRecords: overrides.outboundRecords || OUTBOUND,
    threadMessages: 'threadMessages' in overrides ? overrides.threadMessages : THREAD_MESSAGES,
  });
}

// ===========================================================================
console.log('--- eligible case ---');
const eligible = gate();
check(() => assert.equal(eligible.eligible, true));
check(() => assert.equal(eligible.would_send, true));
check(() => assert.equal(eligible.blocked_reason, null));
check(() => assert.deepEqual(eligible.blocked_reasons, []));
check(() => assert.equal(eligible.demo_url, DEMO_URL));
check(() => assert.equal(eligible.thread_id, THREAD));
check(() => assert.equal(eligible.eaccount, EACCOUNT));
check(() => assert.equal(eligible.demo_sent_evidence, 'NOT_SENT'));

// The copy is EXACT and carries the exact demo URL. No CTA, no meeting ask, no
// second link, no generated prose.
const EXPECTED_BODY = [
  'Absolutely — here it is:',
  '',
  DEMO_URL,
  '',
  'I’ve based it on what happened after the enquiry we sent through.',
  '',
  'Joe',
].join('\n');
check(() => assert.equal(eligible.reply_body.text, EXPECTED_BODY));
check(() => assert.equal(eligible.reply_body.html, EXPECTED_BODY.split('\n').join('<br/>')));
check(() => assert.equal(eligible.reply_body.text.includes(DEMO_URL), true));
check(() => assert.match(eligible.reply_body.text, /^Absolutely — here it is:/));
check(() => assert.equal(/call|meeting|book|chat|pricing|reply to this/i.test(eligible.reply_body.text), false));

// ===========================================================================
console.log('--- blocked cases ---');
const BLOCKED = [
  ['confidence 0.89', { row: { confidence: '0.89' } }, 'CONFIDENCE_BELOW_THRESHOLD'],
  ['confidence blank', { row: { confidence: '' } }, 'CONFIDENCE_MISSING'],
  ['QUESTION', { row: { classification: 'QUESTION', next_action: 'HUMAN_REPLY' } }, 'NOT_POSITIVE_SEND_DEMO'],
  ['POSITIVE_MEETING', { row: { classification: 'POSITIVE_MEETING', next_action: 'HUMAN_REPLY' } }, 'NOT_POSITIVE_SEND_DEMO'],
  ['OTHER_UNCLEAR', { row: { classification: 'OTHER_UNCLEAR', next_action: 'MANUAL_REVIEW' } }, 'NOT_POSITIVE_SEND_DEMO'],
  ['next_action hand-edited', { row: { next_action: 'HUMAN_REPLY' } }, 'ROUTING_MISMATCH'],
  ['suppressed', { row: { suppression_type: 'PERMANENT' } }, 'ROUTING_MISMATCH'],
  ['classifier error', { row: { error: 'ai transport failure' } }, 'CLASSIFIER_ERROR'],
  ['auto reply', { row: { is_auto_reply: 'TRUE' } }, 'AUTO_REPLY'],
  ['missing thread_id', { row: { thread_id: '' } }, 'MISSING_THREAD_ID'],
  ['missing instantly_email_id', { row: { instantly_email_id: '' } }, 'MISSING_INSTANTLY_EMAIL_ID'],
  ['reply not found in sweep', { reply: null }, 'REPLY_NOT_FOUND'],
  ['reply is our own outbound', { reply: normalizeInstantlyEmail(RAW_NOVUS_OUTBOUND) }, 'REPLY_NOT_CONFIRMED_INBOUND'],
  ['missing demo_url', { outboundRecords: [outboundRecord({ demo_url: '', demo_slug: '' })] }, 'MISSING_DEMO_URL'],
  ['invalid demo_url', { outboundRecords: [outboundRecord({ demo_url: 'not-a-url' })] }, 'INVALID_DEMO_URL'],
  ['http demo_url', { outboundRecords: [outboundRecord({ demo_url: 'http://demo.getnovus.co.uk/test-1' })] }, 'INVALID_DEMO_URL'],
  ['ambiguous OUTBOUND match', { outboundRecords: [outboundRecord(), outboundRecord({ rowNumber: 3 })] }, 'OUTBOUND_MATCH_AMBIGUOUS'],
  ['no OUTBOUND match', { outboundRecords: [] }, 'OUTBOUND_MATCH_MISSING'],
  ['OUTBOUND row belongs to another lead', { outboundRecords: [outboundRecord({ outreach_contact_email: 'someone@else.com' })] }, 'OUTBOUND_MATCH_MISSING'],
  ['thread evidence unavailable', { threadMessages: [] }, 'THREAD_EVIDENCE_UNAVAILABLE'],
  ['no NOVUS message on thread', { threadMessages: [REPLY] }, 'THREAD_EVIDENCE_UNAVAILABLE'],
  ['demo already in thread', { threadMessages: [...THREAD_MESSAGES, normalizeInstantlyEmail(RAW_NOVUS_WITH_DEMO)] }, 'DEMO_ALREADY_SENT'],
  ['already COMPLETED', { row: { action_status: 'COMPLETED', action_completed_at: '2026-08-31T21:00:00.000Z' } }, 'ALREADY_EXECUTED'],
  ['duplicate execution attempt (notes marker)', { row: { notes: 'SEND_DEMO sent instantly_email_id=x thread_id=y at=z' } }, 'ALREADY_EXECUTED'],
  ['under human review', { row: { action_status: 'REVIEW' } }, 'ACTION_STATUS_NOT_RETRYABLE'],
  ['no-action event', { row: { action_status: 'NO_ACTION' } }, 'ACTION_STATUS_NOT_RETRYABLE'],
];

for (const [name, overrides, expected] of BLOCKED) {
  const result = gate(overrides);
  check(() => assert.equal(result.eligible, false, `${name}: expected blocked`));
  check(() => assert.equal(result.would_send, false, `${name}: would_send must be false`));
  check(() => assert.equal(result.reply_body, null, `${name}: no reply body when blocked`));
  check(() => assert.equal(
    result.blocked_reasons.includes(expected), true,
    `${name}: expected ${expected}, got ${result.blocked_reasons.join(',')}`,
  ));
  console.log(`  blocked: ${name} -> ${result.blocked_reason}`);
}

// A FAILED event is retryable (so a transient Instantly failure can be redriven)
// but ONLY while no successful send is stamped on it.
check(() => assert.equal(gate({ row: { action_status: 'FAILED' } }).eligible, true));
check(() => assert.equal(
  gate({ row: { action_status: 'FAILED', notes: 'SEND_DEMO sent instantly_email_id=a thread_id=b at=c' } }).blocked_reason,
  'ALREADY_EXECUTED',
));
// And a retry whose earlier send DID land is caught by thread evidence even
// though the row still says FAILED — the ambiguous-response recovery path.
check(() => assert.equal(
  gate({
    row: { action_status: 'FAILED', error: '' },
    threadMessages: [...THREAD_MESSAGES, normalizeInstantlyEmail(RAW_NOVUS_WITH_DEMO)],
  }).blocked_reason,
  'DEMO_ALREADY_SENT',
));

// Every failure is reported, not just the first.
const many = gate({ row: { confidence: '0.10', error: 'boom', thread_id: '' } });
check(() => assert.equal(many.blocked_reasons.length >= 3, true));
check(() => assert.equal(many.blocked_reason, 'CLASSIFIER_ERROR'));

// ===========================================================================
console.log('--- helpers ---');
check(() => assert.equal(SEND_DEMO_CONFIDENCE_THRESHOLD, 0.90));
check(() => assert.equal(buildReplySubject('TEST'), 'Re: TEST'));
check(() => assert.equal(buildReplySubject('Re: TEST'), 'Re: TEST'));
check(() => assert.equal(buildReplySubject(''), 'Re:'));
check(() => assert.equal(isValidDemoUrl(DEMO_URL), true));
check(() => assert.equal(isValidDemoUrl('javascript:alert(1)'), false));
check(() => assert.throws(() => buildDemoReplyBody('')));
check(() => assert.equal(hasSendDemoMarker(''), false));
check(() => assert.equal(hasSendDemoMarker(buildSendDemoNote('', { instantlyEmailId: 'a', threadId: 'b', at: 'c' })), true));
check(() => assert.match(buildSendDemoNote('prior note', { instantlyEmailId: 'a', threadId: 'b', at: 'c' }), /^prior note \| SEND_DEMO sent/));
check(() => assert.equal(demoSentEvidence(null, { demoUrl: DEMO_URL }), 'UNKNOWN'));
check(() => assert.equal(resolveOutboundForSend(OUTBOUND, { outreachId: '', leadEmail: LEAD }).reason, 'OUTBOUND_MATCH_MISSING'));

// The Instantly request is built from documented fields only.
const payload = buildInstantlyReplyPayload({
  replyToUuid: REPLY_ID, eaccount: EACCOUNT, subject: 'Re: TEST', body: eligible.reply_body,
});
check(() => assert.deepEqual(Object.keys(payload).sort(), ['body', 'eaccount', 'reply_to_uuid', 'subject']));
check(() => assert.equal(payload.reply_to_uuid, REPLY_ID));
check(() => assert.equal(payload.eaccount, EACCOUNT));
check(() => assert.deepEqual(Object.keys(payload.body).sort(), ['html', 'text']));
// thread_id is NOT a request field: Instantly threads from reply_to_uuid.
check(() => assert.equal('thread_id' in payload, false));
check(() => assert.equal(INSTANTLY_REPLY_URL, 'https://api.instantly.ai/api/v2/emails/reply'));
check(() => assert.throws(() => buildInstantlyReplyPayload({ replyToUuid: '', eaccount: EACCOUNT, body: { text: 'x' } })));
check(() => assert.throws(() => buildInstantlyReplyPayload({ replyToUuid: 'x', eaccount: '', body: { text: 'x' } })));

// The execution updater can never reach raw evidence.
for (const field of EXECUTION_FIELDS) {
  check(() => assert.equal(RAW_EVIDENCE_FIELDS.includes(field), false, `${field} must not be raw evidence`));
}
check(() => assert.rejects(() => updateReplyEventExecution('rev_1', { body_text: 'hacked' }, { dryRun: false, repo: {} })));
check(() => assert.rejects(() => updateReplyEventExecution('rev_1', { classification: 'QUESTION' }, { dryRun: false, repo: {} })));
const execDry = await updateReplyEventExecution('rev_1', { action_status: 'COMPLETED' });
check(() => assert.equal(execDry.updated, false));
check(() => assert.equal(execDry.skipped, 'dry_run'));

// ===========================================================================
console.log('--- dry-run orchestration: reads only, writes nothing ---');
const writeMethods = ['appendRecord', 'writeCell', 'writeCellsBatch', 'updateRecord', 'appendRows', 'writeRow'];
function fakeRepo({ rows = [replyRow()], outbound = OUTBOUND } = {}) {
  const calls = [];
  const base = {
    async findById(tab, column, id) {
      calls.push(`findById:${tab}`);
      if (tab !== 'REPLY_EVENTS') throw new Error(`unexpected findById on ${tab}`);
      const found = rows.find((r) => String(r[column]) === String(id));
      return found ? { rowNumber: 2, obj: found } : null;
    },
    async getRecords(tab) {
      calls.push(`getRecords:${tab}`);
      if (tab !== 'OUTBOUND') throw new Error(`unexpected getRecords on ${tab}`);
      return outbound;
    },
  };
  for (const m of writeMethods) {
    base[m] = () => { throw new Error(`FORBIDDEN write: ${m}`); };
  }
  return { repo: base, calls };
}

let fetchedUrls = [];
function sweepFetch(payload) {
  return async (url) => {
    fetchedUrls.push(String(url));
    return { ok: true, status: 200, text: async () => JSON.stringify({ items: payload }) };
  };
}

const { repo, calls } = fakeRepo();
const dry = await evaluateSendDemoDryRun({
  repo,
  replyEventId: 'rev_test_1',
  apiKey: 'SECRET',
  fetchImpl: sweepFetch([RAW_REPLY, RAW_NOVUS_OUTBOUND]),
});
check(() => assert.equal(dry.dry_run, true));
check(() => assert.equal(dry.sent, false));
check(() => assert.equal(dry.eligible, true));
check(() => assert.equal(dry.would_send, true));
check(() => assert.equal(dry.demo_url, DEMO_URL));
check(() => assert.equal(dry.thread_id, THREAD));
check(() => assert.equal(dry.instantly_request.url, INSTANTLY_REPLY_URL));
check(() => assert.equal(dry.instantly_request.payload.reply_to_uuid, REPLY_ID));
check(() => assert.equal(dry.reply_body.text, EXPECTED_BODY));
// Exactly one Instantly GET, and NEVER the reply endpoint.
check(() => assert.equal(fetchedUrls.length, 1));
check(() => assert.equal(fetchedUrls[0].startsWith('https://api.instantly.ai/api/v2/emails?'), true));
check(() => assert.equal(fetchedUrls.some((u) => u.includes('/emails/reply')), false));
// One REPLY_EVENTS read and one OUTBOUND read. No write method was reachable.
check(() => assert.deepEqual(calls, ['findById:REPLY_EVENTS', 'getRecords:OUTBOUND']));
// The API key is never echoed into the result, on any path.
check(() => assert.equal(JSON.stringify(dry).includes('SECRET'), false));

// Unknown reply_event_id.
fetchedUrls = [];
const { repo: emptyRepo } = fakeRepo({ rows: [] });
const missing = await evaluateSendDemoDryRun({
  repo: emptyRepo, replyEventId: 'rev_nope', apiKey: 'SECRET', fetchImpl: sweepFetch([]),
});
check(() => assert.equal(missing.blocked_reason, 'REPLY_EVENT_NOT_FOUND'));
check(() => assert.equal(missing.would_send, false));
check(() => assert.equal(fetchedUrls.length, 0, 'no Instantly call for an unknown event'));

// A failed Instantly sweep BLOCKS; it never falls through to a send.
fetchedUrls = [];
const { repo: repo2 } = fakeRepo();
const swept = await evaluateSendDemoDryRun({
  repo: repo2,
  replyEventId: 'rev_test_1',
  apiKey: 'SECRET',
  fetchImpl: async () => { throw new Error('instantly unreachable'); },
});
check(() => assert.equal(swept.would_send, false));
check(() => assert.equal(swept.blocked_reason, 'REPLY_NOT_FOUND'));
check(() => assert.equal(swept.thread_sweep_error, 'instantly unreachable'));

globalThis.fetch = originalFetch;
console.log(`\nSEND_DEMO dry-run selftest passed. ${assertions} assertions.`);
