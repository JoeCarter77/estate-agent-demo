// scripts/novus-manual-reply-selftest.mjs — Phase 3A: the manual (human-authored)
// reply gate, body builder, idempotency key, SALES_MESSAGES schema, the shared
// send-transport extraction, and the READ-ONLY dry-run API operation.
//
// HERMETIC. No network, no Google Sheets, no Instantly, no AI, no credential.
// globalThis.fetch is replaced with a throwing stub for the whole file and only
// re-armed, per scenario, with an explicit handler that REFUSES any request
// that is not the lead-scoped GET.
//
// THE CENTRAL CLAIM THIS FILE EXISTS TO PROVE: Phase 3A cannot send an email.
// Sections F and G assert that structurally — every Sheets writer throws, every
// non-GET Instantly call throws, and neither is ever reached.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  evaluateManualReplyGate,
  buildManualReplyBody,
  normalizeManualReplyBody,
  manualReplyClaimKey,
  manualReplyBodyHash,
  hasPermanentSuppression,
  newestReplyEvent,
  MANUAL_REPLY_BLOCKED_REASONS,
  MANUAL_REPLY_CLAIM_PREFIX,
  MAX_MANUAL_REPLY_BODY_CHARS,
} from '../lib/manual-reply.mjs';
import {
  SALES_MESSAGES_HEADER,
  SALES_MESSAGES_TAB,
  THREAD_CONTINUITY,
  SEND_OUTCOMES,
  SALES_MESSAGE_TYPES,
  SALES_MESSAGE_DIRECTIONS,
  buildSalesMessageRow,
  buildSalesMessagesSetupPlan,
  validateSalesMessageRow,
  parseSalesMessageRecords,
  readSalesMessagesForOutreach,
  resolveThreadContinuity,
  newSalesMessageId,
} from '../lib/sales-messages.mjs';
import * as sharedSend from '../lib/instantly-reply-send.mjs';
import * as sendDemo from '../lib/reply-send-demo.mjs';
import { REPLY_EVENTS_HEADER } from '../lib/reply-router.mjs';
import { OUTBOUND_HEADER } from '../lib/outbound.mjs';
import { __setRepoForTests } from '../lib/sheets.mjs';
import handler, {
  MANUAL_REPLY_DRY_RUN_FIELDS,
  MANUAL_REPLY_DRY_RUN_REJECTED_FIELDS,
} from '../api/novus/personalisation.js';

const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => { throw new Error(`FORBIDDEN network access: ${args[0]}`); };

// Source-level assertions below are about what the CODE can reach. Comments
// discuss the claim store, the send path and the classifier at length on
// purpose, so line comments are stripped before any of these greps.
function codeOf(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

let passed = 0;
function ok(label) { passed += 1; console.log(`  ok  ${label}`); }
function part(label) { console.log(`\n${label}`); }

// -- fixtures ----------------------------------------------------------------
const LEAD = 'sam@ashtonwhite.co.uk';
const EACCOUNT = 'joe@novushq.co.uk';
const OTHER_INBOX = 'joe@trynovus.co.uk';
const MAILBOXES = [EACCOUNT, OTHER_INBOX];
const THREAD = 'ba-AayEOdow6Hjmghl06cSGgbe';
const EMAIL_ID = '01a0596e-d338-72e6-a586-98eac9e4ba20';
const NEWER_EMAIL_ID = '01a0596e-d338-72e6-a586-98eac9e4ba99';

const REPLY = {
  reply_event_id: 'rpl_1',
  instantly_email_id: EMAIL_ID,
  agency_id: 'ag_1',
  outreach_id: 'out_1',
  lead_email: LEAD,
  campaign_id: 'camp_1',
  thread_id: THREAD,
  received_at: '2026-09-01T10:00:00.000Z',
  subject: 'Re: The enquiry we sent through',
  body_text: 'What does it cost?',
  cleaned_reply_text: 'What does it cost?',
  is_auto_reply: 'FALSE',
  // Deliberately a classification the AUTOMATIC path refuses to execute. A
  // human may answer it; that is the whole point of a manual reply.
  classification: 'QUESTION',
  confidence: '0.71',
  suppression_type: 'NONE',
  next_action: 'HUMAN_REPLY',
  priority: 'HIGH',
  action_status: 'PENDING',
};

const OUTBOUND_ROW = {
  outbound_id: 'out_1', agency_id: 'ag_1', probe_id: 'prb_1',
  clean_agency_name: 'Ashton White', outreach_contact_email: LEAD,
  outbound_status: 'SENT',
};
const OUTBOUND_RECORDS = [{ obj: OUTBOUND_ROW }];

const LIVE_PARENT = {
  instantly_email_id: EMAIL_ID,
  direction: 'INBOUND',
  thread_id: THREAD,
  eaccount: EACCOUNT,
  subject: 'Re: The enquiry we sent through',
};

const BODY = 'Hi Sam,\n\nHappy to talk cost — it depends on volume.\n\nJoe';

// Every gate input, wired to the happy path. Each scenario overrides one thing.
function gate(overrides = {}) {
  return evaluateManualReplyGate({
    replyEvent: REPLY,
    outreachReplyEvents: [REPLY],
    outboundRecords: OUTBOUND_RECORDS,
    liveParent: LIVE_PARENT,
    mailboxes: MAILBOXES,
    body: BODY,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
part('A. The manual-reply gate: the eligible case');
// ---------------------------------------------------------------------------
{
  const g = gate();
  assert.equal(g.eligible, true, g.blocked_reason || '');
  assert.equal(g.blocked_reason, null);
  assert.deepEqual(g.blocked_reasons, []);
  assert.equal(g.would_send, true);
  ok('a normal human reply to a live inbound message is eligible');

  assert.equal(g.resolved.reply_event_id, 'rpl_1');
  assert.equal(g.resolved.outreach_id, 'out_1');
  assert.equal(g.resolved.agency_id, 'ag_1');
  assert.equal(g.resolved.eaccount, EACCOUNT);
  assert.equal(g.resolved.reply_to_uuid, EMAIL_ID);
  assert.equal(g.resolved.thread_id, THREAD);
  assert.equal(g.resolved.subject, 'Re: The enquiry we sent through');
  ok('resolved carries exactly the identifiers a send needs, all server-derived');

  // The gate is handed no credential and must invent none.
  const flat = JSON.stringify(g);
  for (const secret of ['Bearer', 'api_key', 'apiKey', 'authorization', 'INSTANTLY_REPLY_API_KEY']) {
    assert.ok(!flat.includes(secret), `no ${secret} in the gate result`);
  }
  ok('the gate result contains no credential, header or secret of any kind');

  // Subject is normalised once, never "Re: Re:".
  assert.equal(gate({ replyEvent: { ...REPLY, subject: 'Fresh enquiry' } }).resolved.subject, 'Re: Fresh enquiry');
  assert.equal(gate({ replyEvent: { ...REPLY, subject: '' } }).resolved.subject, 'Re:');
  ok('the reply subject is built with the SAME shared builder the demo send uses');
}

// ---------------------------------------------------------------------------
part('B. The manual-reply gate: every block');
// ---------------------------------------------------------------------------
{
  // -- missing reply event --------------------------------------------------
  for (const missing of [null, undefined, 'rpl_1', 42]) {
    const g = gate({ replyEvent: missing });
    assert.equal(g.eligible, false);
    assert.equal(g.blocked_reason, 'REPLY_EVENT_NOT_FOUND');
    assert.equal(g.body, null);
  }
  ok('a missing or non-object reply event blocks with REPLY_EVENT_NOT_FOUND');

  // -- OPT-OUT: the mandatory block ----------------------------------------
  // The opted-out message is a DIFFERENT, later row on the same journey; the
  // row being answered says NONE. Journey scope is the whole point.
  const optOut = { ...REPLY, reply_event_id: 'rpl_2', instantly_email_id: NEWER_EMAIL_ID,
    received_at: '2026-09-02T10:00:00.000Z', suppression_type: 'PERMANENT', classification: 'OPT_OUT' };
  const g1 = gate({ outreachReplyEvents: [REPLY, optOut] });
  assert.equal(g1.eligible, false);
  assert.equal(g1.blocked_reason, 'PROSPECT_OPTED_OUT');
  ok('a PERMANENT suppression ANYWHERE on the outreach journey blocks the reply');

  // Even when it is the very row being answered.
  const selfOptOut = { ...REPLY, suppression_type: 'PERMANENT' };
  assert.equal(gate({ replyEvent: selfOptOut, outreachReplyEvents: [selfOptOut] }).blocked_reason, 'PROSPECT_OPTED_OUT');
  ok('an opt-out on the answered row itself blocks too');

  // Opt-out outranks every other failure: a human must see THIS reason.
  const wrecked = { ...REPLY, suppression_type: 'PERMANENT', instantly_email_id: '', thread_id: '', agency_id: 'ag_WRONG' };
  const g2 = gate({ replyEvent: wrecked, outreachReplyEvents: [wrecked], liveParent: null, body: '' });
  assert.equal(g2.blocked_reason, 'PROSPECT_OPTED_OUT', 'opt-out is reported first');
  assert.ok(g2.blocked_reasons.length > 1, 'the other failures are still listed');
  ok('PROSPECT_OPTED_OUT outranks every other blocked reason');

  assert.equal(hasPermanentSuppression([{ suppression_type: ' permanent ' }]), true);
  assert.equal(hasPermanentSuppression([{ suppression_type: 'NONE' }]), false);
  assert.equal(hasPermanentSuppression([]), false);
  assert.equal(hasPermanentSuppression(null), false);
  ok('suppression matching is trimmed, case-insensitive and safe on empty input');

  // -- STALE REPLY ----------------------------------------------------------
  const newer = { ...REPLY, reply_event_id: 'rpl_2', instantly_email_id: NEWER_EMAIL_ID,
    received_at: '2026-09-02T09:00:00.000Z', suppression_type: 'NONE' };
  const g3 = gate({ outreachReplyEvents: [REPLY, newer] });
  assert.equal(g3.eligible, false);
  assert.equal(g3.blocked_reason, 'STALE_REPLY_EVENT');
  assert.equal(g3.newest_reply_event_id, 'rpl_2', 'the UI is told which reply to refresh onto');
  assert.equal(g3.newest_received_at, '2026-09-02T09:00:00.000Z');
  ok('answering an older reply when a newer one has arrived blocks with STALE_REPLY_EVENT');

  // Answering the NEWEST is fine, even with older siblings present.
  const older = { ...REPLY, reply_event_id: 'rpl_0', instantly_email_id: 'older-id',
    received_at: '2026-08-30T09:00:00.000Z' };
  assert.equal(gate({ outreachReplyEvents: [older, REPLY] }).eligible, true);
  ok('older siblings do not block: only a NEWER reply is superseding');

  // Optimistic concurrency.
  assert.equal(gate({ expectedReceivedAt: '2026-09-01T10:00:00.000Z' }).eligible, true);
  assert.equal(gate({ expectedReceivedAt: '2026-08-01T00:00:00.000Z' }).blocked_reason, 'STALE_REPLY_EVENT');
  ok('expected_received_at pins the exact row a human read; a re-stamped row is stale');

  // A row with an unparseable received_at can never win "newest".
  const undated = { ...REPLY, reply_event_id: 'rpl_x', received_at: 'not a date' };
  assert.equal(newestReplyEvent([undated, REPLY]).reply_event_id, 'rpl_1');
  assert.equal(newestReplyEvent([]), null);
  ok('an unparseable received_at never masquerades as the newest reply');

  // -- history unavailable FAILS CLOSED ------------------------------------
  const g4 = gate({ outreachReplyEvents: null });
  assert.equal(g4.eligible, false);
  assert.equal(g4.blocked_reason, 'REPLY_HISTORY_UNAVAILABLE');
  ok('an unloadable reply history blocks: "could not check" never means "it is fine"');

  // -- identifiers ----------------------------------------------------------
  const noEmailId = { ...REPLY, instantly_email_id: '' };
  assert.equal(gate({ replyEvent: noEmailId, outreachReplyEvents: [noEmailId] }).blocked_reason, 'MISSING_INSTANTLY_EMAIL_ID');
  ok('a reply with no instantly_email_id has nothing to reply to and blocks');

  const noThread = { ...REPLY, thread_id: '' };
  assert.equal(gate({ replyEvent: noThread, outreachReplyEvents: [noThread] }).blocked_reason, 'MISSING_THREAD_ID');
  ok('a reply with no stored thread_id blocks');

  // -- the live parent ------------------------------------------------------
  assert.equal(gate({ liveParent: null }).blocked_reason, 'REPLY_NOT_FOUND');
  ok('no live Instantly parent blocks: stored data alone is never enough to send');

  assert.equal(gate({ liveParent: { ...LIVE_PARENT, direction: 'OUTBOUND' } }).blocked_reason, 'REPLY_NOT_CONFIRMED_INBOUND');
  assert.equal(gate({ liveParent: { ...LIVE_PARENT, direction: 'UNKNOWN' } }).blocked_reason, 'REPLY_NOT_CONFIRMED_INBOUND');
  ok('replying to anything that is not a confirmed INBOUND email blocks');

  assert.equal(gate({ liveParent: { ...LIVE_PARENT, thread_id: 'other-thread' } }).blocked_reason, 'THREAD_ID_MISMATCH');
  ok('a live parent on a different thread than the stored one blocks');

  assert.equal(gate({ liveParent: { ...LIVE_PARENT, eaccount: '' } }).blocked_reason, 'MISSING_EACCOUNT');
  ok('a live parent with no eaccount blocks: the sending inbox must be known');

  // -- THE ALLOWLIST --------------------------------------------------------
  assert.equal(gate({ liveParent: { ...LIVE_PARENT, eaccount: 'someone@else.com' } }).blocked_reason, 'EACCOUNT_NOT_ALLOWLISTED');
  assert.equal(gate({ mailboxes: [OTHER_INBOX] }).blocked_reason, 'EACCOUNT_NOT_ALLOWLISTED');
  assert.equal(gate({ mailboxes: [] }).blocked_reason, 'EACCOUNT_NOT_ALLOWLISTED');
  ok('an eaccount outside NOVUS_SENDING_MAILBOXES blocks, and an empty allowlist blocks everything');

  assert.equal(gate({ liveParent: { ...LIVE_PARENT, eaccount: ' JOE@NovusHQ.co.uk ' } }).eligible, true);
  assert.equal(gate({ mailboxes: [' JOE@NOVUSHQ.CO.UK '] }).eligible, true);
  ok('the allowlist comparison is trimmed and case-insensitive on both sides');

  // -- OUTBOUND resolution --------------------------------------------------
  assert.equal(gate({ outboundRecords: [] }).blocked_reason, 'OUTBOUND_MATCH_MISSING');
  ok('no OUTBOUND row blocks with OUTBOUND_MATCH_MISSING');

  const dup = [{ obj: OUTBOUND_ROW }, { obj: { ...OUTBOUND_ROW, outreach_contact_email: 'other@x.com' } }];
  assert.equal(gate({ outboundRecords: dup }).blocked_reason, 'OUTBOUND_MATCH_AMBIGUOUS');
  ok('two OUTBOUND rows sharing the outbound_id block as AMBIGUOUS');

  // The id resolves to one row, but the lead address resolves to a DIFFERENT
  // one — the OUTBOUND row was re-keyed or edited since the poller matched it.
  const crossed = [
    { obj: OUTBOUND_ROW },
    { obj: { ...OUTBOUND_ROW, outbound_id: 'out_2', outreach_contact_email: 'someone@new.com' } },
  ];
  const mismatchedLead = { ...REPLY, lead_email: 'someone@new.com' };
  assert.equal(
    gate({ replyEvent: mismatchedLead, outreachReplyEvents: [mismatchedLead], outboundRecords: crossed }).blocked_reason,
    'OUTBOUND_LEAD_EMAIL_MISMATCH',
  );
  ok('a lead address that resolves to a different OUTBOUND row blocks');

  // -- agency agreement -----------------------------------------------------
  const wrongAgency = { ...REPLY, agency_id: 'ag_99' };
  assert.equal(gate({ replyEvent: wrongAgency, outreachReplyEvents: [wrongAgency] }).blocked_reason, 'AGENCY_ID_MISMATCH');
  const blankAgency = { ...REPLY, agency_id: '' };
  assert.equal(gate({ replyEvent: blankAgency, outreachReplyEvents: [blankAgency] }).blocked_reason, 'AGENCY_ID_MISMATCH');
  ok('REPLY_EVENTS.agency_id must equal OUTBOUND.agency_id; blank is a mismatch, not a pass');

  // -- the message itself ---------------------------------------------------
  for (const empty of ['', '   ', '\n\n\n', '\r\n \t', null, undefined]) {
    assert.equal(gate({ body: empty }).blocked_reason, 'BODY_EMPTY', `blank: ${JSON.stringify(empty)}`);
  }
  ok('a blank, whitespace-only or absent body blocks with BODY_EMPTY');

  assert.equal(gate({ body: 'x'.repeat(MAX_MANUAL_REPLY_BODY_CHARS) }).eligible, true, 'exactly at the limit is allowed');
  assert.equal(gate({ body: 'x'.repeat(MAX_MANUAL_REPLY_BODY_CHARS + 1) }).blocked_reason, 'BODY_TOO_LONG');
  assert.equal(MAX_MANUAL_REPLY_BODY_CHARS, 5000);
  ok(`the body limit is exactly ${MAX_MANUAL_REPLY_BODY_CHARS} characters, inclusive`);
}

// ---------------------------------------------------------------------------
part('C. The gate is PURE, and its judgement checks are deliberately absent');
// ---------------------------------------------------------------------------
{
  // Purity: no fetch (the global throws), no repo, no clock dependency.
  const a = gate();
  const b = gate();
  assert.deepEqual(a, b, 'the same inputs always give the same result');
  ok('the gate is deterministic and performs no I/O (globalThis.fetch would throw)');

  // Inputs are not mutated.
  const before = JSON.stringify({ REPLY, OUTBOUND_RECORDS, LIVE_PARENT, MAILBOXES });
  gate();
  assert.equal(JSON.stringify({ REPLY, OUTBOUND_RECORDS, LIVE_PARENT, MAILBOXES }), before);
  ok('the gate mutates none of its inputs');

  // A human already read the message: the classifier's opinion is not a gate.
  for (const classification of ['QUESTION', 'NOT_NOW', 'NOT_INTERESTED', 'POSITIVE_MEETING',
    'OTHER_UNCLEAR', 'OOO_AUTOMATED', 'POSITIVE_SEND_DEMO', '']) {
    const row = { ...REPLY, classification };
    assert.equal(gate({ replyEvent: row, outreachReplyEvents: [row] }).eligible, true, classification);
  }
  ok('classification is NOT gated: a human may answer any reply class');

  for (const confidence of ['0.10', '0.89', '', 'nonsense']) {
    const row = { ...REPLY, confidence };
    assert.equal(gate({ replyEvent: row, outreachReplyEvents: [row] }).eligible, true, confidence);
  }
  ok('classifier confidence is NOT gated: no 0.90 floor on a human-written reply');

  for (const status of ['COMPLETED', 'REVIEW', 'NO_ACTION', 'FAILED', '']) {
    const row = { ...REPLY, action_status: status, action_completed_at: '2026-09-01T11:00:00.000Z',
      notes: 'SEND_DEMO sent instantly_email_id=x' };
    assert.equal(gate({ replyEvent: row, outreachReplyEvents: [row] }).eligible, true, status);
  }
  ok('demo-sent state, action_status and the SEND_DEMO marker are NOT gated');

  // But the automatic path's own gate is untouched by any of this.
  assert.equal(sendDemo.SEND_DEMO_CONFIDENCE_THRESHOLD, 0.90);
  assert.equal(sendDemo.EXECUTABLE_CLASSIFICATION, 'POSITIVE_SEND_DEMO');
  ok('SEND_DEMO keeps its 0.90 floor and its single executable classification');

  // Contract ordering is total and duplicate-free.
  assert.equal(new Set(MANUAL_REPLY_BLOCKED_REASONS).size, MANUAL_REPLY_BLOCKED_REASONS.length);
  const produced = new Set();
  for (const scenario of [
    gate({ replyEvent: null }), gate({ outreachReplyEvents: null }), gate({ liveParent: null }),
    gate({ outboundRecords: [] }), gate({ body: '' }), gate({ mailboxes: [] }),
  ]) scenario.blocked_reasons.forEach((r) => produced.add(r));
  for (const r of produced) assert.ok(MANUAL_REPLY_BLOCKED_REASONS.includes(r), `${r} is a declared reason`);
  ok('every reason the gate can produce is declared in MANUAL_REPLY_BLOCKED_REASONS');
}

// ---------------------------------------------------------------------------
part('D. The body builder: exact text, safe HTML, no interpretation');
// ---------------------------------------------------------------------------
{
  const b = buildManualReplyBody('Hello\nWorld');
  assert.equal(b.text, 'Hello\nWorld');
  assert.equal(b.html, 'Hello<br/>World');
  ok('newlines become <br/> in html and stay newlines in text');

  const dangerous = 'a & b < c > d "quoted"';
  const e = buildManualReplyBody(dangerous);
  assert.equal(e.text, dangerous, 'text is preserved byte for byte');
  assert.equal(e.html, 'a &amp; b &lt; c &gt; d &quot;quoted&quot;');
  ok('&, <, > and " are escaped in html and untouched in text');

  const injected = buildManualReplyBody('<script>alert("x")</script>');
  assert.ok(!injected.html.includes('<script>'), 'no live tag survives');
  assert.equal(injected.html, '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  ok('browser-supplied HTML is escaped, never rendered: no markup is accepted');

  const md = buildManualReplyBody('**bold** _italic_ [link](http://x)');
  assert.equal(md.text, '**bold** _italic_ [link](http://x)');
  assert.equal(md.html, '**bold** _italic_ [link](http://x)');
  ok('markdown is NOT interpreted: the characters are delivered literally');

  assert.equal(buildManualReplyBody('a\r\nb\rc').text, 'a\nb\nc');
  assert.equal(buildManualReplyBody('a\r\nb\rc').html, 'a<br/>b<br/>c');
  ok('CRLF and bare CR normalise to LF, so text and html cannot disagree');

  const spaced = buildManualReplyBody('  leading and trailing  ');
  assert.equal(spaced.text, '  leading and trailing  ', 'no trimming of what a human typed');
  ok('leading and trailing whitespace is preserved exactly');

  assert.equal(buildManualReplyBody('').text, '');
  assert.equal(buildManualReplyBody(null).text, '');
  assert.equal(buildManualReplyBody(undefined).text, '');
  assert.equal(normalizeManualReplyBody(undefined), '');
  ok('an empty, null or undefined body yields empty text rather than throwing');

  const unicode = 'Café — naïve “smart quotes” … 🎯';
  assert.equal(buildManualReplyBody(unicode).text, unicode);
  assert.equal(buildManualReplyBody(unicode).html, unicode, 'nothing here needs escaping');
  ok('unicode, em dashes, smart quotes and emoji pass through unaltered');

  // The manual and demo paths escape with the SAME function.
  assert.equal(sharedSend.escapeHtml('<&">'), '&lt;&amp;&quot;&gt;');
  const demoBody = sendDemo.buildDemoReplyBody('https://d.example/x');
  assert.ok(demoBody.html.includes('<br/>'), 'the demo body uses the same <br/> convention');
  ok('manual and automatic replies escape and break lines identically (one shared helper)');
}

// ---------------------------------------------------------------------------
part('E. Idempotency key: defined and deterministic, NOT acquired');
// ---------------------------------------------------------------------------
{
  const key = manualReplyClaimKey({ instantlyEmailId: EMAIL_ID, body: BODY });
  assert.ok(key.startsWith(MANUAL_REPLY_CLAIM_PREFIX), key);
  assert.equal(MANUAL_REPLY_CLAIM_PREFIX, 'novus:manualreply:');
  assert.equal(key, `novus:manualreply:${EMAIL_ID}:${manualReplyBodyHash(BODY)}`);
  assert.match(key, /^novus:manualreply:[^:]+:[0-9a-f]{32}$/);
  ok('the key is novus:manualreply:<instantly_email_id>:<sha256 body hash>');

  assert.equal(manualReplyClaimKey({ instantlyEmailId: EMAIL_ID, body: BODY }), key);
  assert.equal(manualReplyClaimKey({ instantlyEmailId: ` ${EMAIL_ID} `, body: BODY }), key);
  ok('the same target and the same body always give the same key');

  assert.notEqual(manualReplyClaimKey({ instantlyEmailId: EMAIL_ID, body: `${BODY} ` }), key);
  assert.notEqual(manualReplyClaimKey({ instantlyEmailId: EMAIL_ID, body: BODY.toUpperCase() }), key);
  assert.notEqual(manualReplyClaimKey({ instantlyEmailId: EMAIL_ID, body: 'Different answer' }), key);
  ok('any change to the body — even one trailing space — gives a different key');

  assert.notEqual(manualReplyClaimKey({ instantlyEmailId: NEWER_EMAIL_ID, body: BODY }), key);
  ok('a different reply target gives a different key');

  // CRLF vs LF is the same message typed on a different platform, not a
  // different message: it must not defeat the double-submit guard.
  assert.equal(
    manualReplyClaimKey({ instantlyEmailId: EMAIL_ID, body: 'a\r\nb' }),
    manualReplyClaimKey({ instantlyEmailId: EMAIL_ID, body: 'a\nb' }),
  );
  ok('line-ending normalisation is applied before hashing, so CRLF and LF collapse');

  assert.throws(() => manualReplyClaimKey({ instantlyEmailId: '', body: BODY }), /instantly_email_id/);
  assert.throws(() => manualReplyClaimKey({}), /instantly_email_id/);
  ok('a key cannot be built without a reply target');

  // PHASE 3A TAKES NO CLAIM. The module has no acquire path at all.
  const manualReplyCode = codeOf('lib/manual-reply.mjs');
  assert.ok(!/getClaimStore|\.acquire\(|reply-claim/.test(manualReplyCode), 'no claim store is reachable');
  assert.ok(!/fetch\(|https?:\/\//.test(manualReplyCode), 'no request of any kind is reachable');
  assert.ok(!/appendRecord|updateById|updateCell|getRepo/.test(manualReplyCode), 'no repo access is reachable');
  ok('lib/manual-reply.mjs acquires no claim and makes no request: it only builds the key');
}

// ---------------------------------------------------------------------------
part('F. SALES_MESSAGES: schema, validation, parser, setup plan');
// ---------------------------------------------------------------------------
{
  const EXPECTED_HEADER = [
    'sales_message_id', 'outreach_id', 'agency_id', 'reply_event_id', 'direction',
    'message_type', 'eaccount', 'in_reply_to_email_id', 'instantly_email_id',
    'instantly_thread_id', 'instantly_message_id', 'thread_continuity', 'subject',
    'body_text', 'send_outcome', 'instantly_status', 'error', 'sent_by', 'sent_at',
    'created_at',
  ];
  assert.deepEqual(SALES_MESSAGES_HEADER, EXPECTED_HEADER, 'the audited Phase 2 schema, in order');
  assert.equal(SALES_MESSAGES_HEADER.length, 20);
  assert.equal(new Set(SALES_MESSAGES_HEADER).size, 20);
  ok('the SALES_MESSAGES header is the audited schema, exactly and in order');

  assert.deepEqual(SALES_MESSAGE_DIRECTIONS, ['OUTBOUND']);
  assert.ok(!SALES_MESSAGE_DIRECTIONS.includes('INBOUND'));
  ok('SALES_MESSAGES is OUTBOUND-only: REPLY_EVENTS stays the canonical inbound record');

  assert.deepEqual(THREAD_CONTINUITY, ['CONFIRMED', 'DIFFERENT', 'UNKNOWN']);
  assert.equal(resolveThreadContinuity(THREAD, THREAD), 'CONFIRMED');
  assert.equal(resolveThreadContinuity(THREAD, 'other'), 'DIFFERENT');
  assert.equal(resolveThreadContinuity(THREAD, ''), 'UNKNOWN');
  assert.equal(resolveThreadContinuity('', THREAD), 'UNKNOWN');
  assert.equal(resolveThreadContinuity(null, undefined), 'UNKNOWN');
  assert.equal(resolveThreadContinuity(` ${THREAD} `, THREAD), 'CONFIRMED', 'trimmed on both sides');
  ok('thread continuity resolves CONFIRMED / DIFFERENT / UNKNOWN, and a missing id is UNKNOWN not an error');

  // -- validation -----------------------------------------------------------
  const valid = {
    sales_message_id: 'smg_1', outreach_id: 'out_1', agency_id: 'ag_1',
    reply_event_id: 'rpl_1', direction: 'OUTBOUND', message_type: 'MANUAL_REPLY',
    eaccount: EACCOUNT, in_reply_to_email_id: EMAIL_ID, instantly_thread_id: THREAD,
    thread_continuity: 'CONFIRMED', subject: 'Re: x', body_text: BODY,
    send_outcome: 'SENT', sent_by: 'joe', sent_at: '2026-09-02T12:00:00.000Z',
    created_at: '2026-09-02T12:00:00.000Z',
  };
  assert.equal(validateSalesMessageRow(valid).valid, true, JSON.stringify(validateSalesMessageRow(valid).errors));
  ok('a complete manual-reply row validates');

  for (const required of ['sales_message_id', 'outreach_id', 'direction', 'message_type', 'created_at']) {
    const r = validateSalesMessageRow({ ...valid, [required]: '' });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes(required)), `${required} is required`);
  }
  ok('every required column is enforced');

  assert.equal(validateSalesMessageRow({ ...valid, direction: 'INBOUND' }).valid, false);
  assert.equal(validateSalesMessageRow({ ...valid, message_type: 'ROBOT' }).valid, false);
  assert.equal(validateSalesMessageRow({ ...valid, send_outcome: 'MAYBE' }).valid, false);
  assert.equal(validateSalesMessageRow({ ...valid, thread_continuity: 'IN_THREAD' }).valid, false);
  ok('every enum column rejects a value outside its list (including the retired IN_THREAD)');

  assert.equal(validateSalesMessageRow({ ...valid, eaccount: '' }).valid, false, 'SENT needs an eaccount');
  assert.equal(validateSalesMessageRow({ ...valid, send_outcome: 'BLOCKED', eaccount: '' }).valid, true);
  ok('a row claiming SENT must name the mailbox it left from');

  const unknown = validateSalesMessageRow({ ...valid, smuggled_column: 'x' });
  assert.equal(unknown.valid, false);
  assert.ok(unknown.errors.some((e) => e.includes('smuggled_column')));
  ok('an unknown column is rejected rather than silently dropped');

  // -- row building ---------------------------------------------------------
  const row = buildSalesMessageRow(valid);
  assert.equal(row.length, SALES_MESSAGES_HEADER.length);
  assert.equal(row[0], 'smg_1');
  assert.equal(row[SALES_MESSAGES_HEADER.indexOf('eaccount')], EACCOUNT);
  assert.equal(row[SALES_MESSAGES_HEADER.indexOf('body_text')], BODY);
  assert.equal(row[SALES_MESSAGES_HEADER.indexOf('instantly_email_id')], '', 'absent columns are blank, never undefined');
  assert.ok(row.every((cell) => typeof cell === 'string'));
  ok('an append row is built in header order, all strings, blanks for absent columns');

  assert.throws(() => buildSalesMessageRow({ ...valid, direction: 'INBOUND' }), /invalid SALES_MESSAGES row/);
  ok('building a row runs validation first and refuses an invalid one');

  assert.ok(newSalesMessageId().startsWith('smg_'));
  assert.notEqual(newSalesMessageId(), newSalesMessageId());
  ok('sales_message_id is minted from lib/ids.mjs with the smg_ prefix');

  // -- the setup plan -------------------------------------------------------
  const plan = buildSalesMessagesSetupPlan();
  assert.equal(plan.tab, SALES_MESSAGES_TAB);
  assert.deepEqual(plan.header_row, SALES_MESSAGES_HEADER);
  assert.equal(plan.schema_note_row.length, SALES_MESSAGES_HEADER.length);
  assert.equal(plan.schema_note_row[0], 'SCHEMA NOTE');
  assert.ok(plan.schema_note_row[1].startsWith('SCHEMA NOTE:'));
  assert.deepEqual(plan.data_rows, [], 'a setup seeds NO sent rows');
  ok('the setup plan is exactly one header row, one schema-note row, and zero data rows');

  plan.header_row.push('tampered');
  assert.equal(SALES_MESSAGES_HEADER.length, 20, 'the exported header is not the same array');
  ok('the setup plan hands back a copy: the canonical header cannot be mutated through it');

  // -- the parser -----------------------------------------------------------
  const table = {
    header: SALES_MESSAGES_HEADER.slice(),
    rows: [
      buildSalesMessagesSetupPlan().schema_note_row,
      SALES_MESSAGES_HEADER.map((c) => valid[c] ?? ''),
      SALES_MESSAGES_HEADER.map(() => ''),
    ],
  };
  const parsed = parseSalesMessageRecords(table);
  assert.equal(parsed.length, 1, 'the schema note and the blank row are both skipped');
  assert.equal(parsed[0].obj.sales_message_id, 'smg_1');
  assert.equal(parsed[0].rowNumber, 3);
  assert.deepEqual(parseSalesMessageRecords({ header: ['nope'], rows: [['x']] }), []);
  assert.deepEqual(parseSalesMessageRecords(null), []);
  ok('the parser skips the schema note and blank rows, and tolerates a missing id column');

  // -- the tolerant read: the tab does not exist yet ------------------------
  const absentRepo = { async getTable() { throw new Error('Unable to parse range: SALES_MESSAGES'); } };
  const absent = await readSalesMessagesForOutreach(absentRepo, 'out_1');
  assert.equal(absent.available, false);
  assert.deepEqual(absent.rows, []);
  assert.ok(absent.error.includes('Unable to parse range'));
  ok('a missing SALES_MESSAGES tab reads as { available: false }, never as an error');

  const emptyRepo = { async getTable() { return { header: [], rows: [] }; } };
  assert.equal((await readSalesMessagesForOutreach(emptyRepo, 'out_1')).available, false);
  assert.equal((await readSalesMessagesForOutreach(absentRepo, '')).error, 'outreach_id is required');
  ok('an empty tab and a blank outreach_id both degrade rather than throw');

  const liveRepo = { async getTable() { return table; } };
  const found = await readSalesMessagesForOutreach(liveRepo, 'out_1');
  assert.equal(found.available, true);
  assert.equal(found.rows.length, 1);
  assert.equal((await readSalesMessagesForOutreach(liveRepo, 'out_OTHER')).rows.length, 0);
  ok('a populated tab reads back, filtered to the one outreach journey');

  // -- NO WRITER EXISTS -----------------------------------------------------
  const salesModule = await import('../lib/sales-messages.mjs');
  for (const name of Object.keys(salesModule)) {
    assert.ok(!/^(append|write|persist|save|insert|create)/i.test(name), `${name} is not a writer`);
  }
  const salesCode = codeOf('lib/sales-messages.mjs');
  assert.ok(!/appendRecord|appendRowsBatch|updateById|updateCell|writeRowsBatch|writeCellsBatch/.test(salesCode));
  ok('lib/sales-messages.mjs exports no writer and calls no repo write method');
}

// ---------------------------------------------------------------------------
part('G. The shared send extraction: SEND_DEMO is unchanged, and not forked');
// ---------------------------------------------------------------------------
{
  // ONE transport, not two. This is the whole point of the extraction.
  assert.equal(sendDemo.sendDemoReply, sharedSend.sendInstantlyReply,
    'sendDemoReply IS the shared function object, not a copy or a wrapper');
  assert.equal(sendDemo.buildInstantlyReplyPayload, sharedSend.buildInstantlyReplyPayload);
  assert.equal(sendDemo.buildReplySubject, sharedSend.buildReplySubject);
  assert.equal(sendDemo.resolveOutboundForSend, sharedSend.resolveOutboundForSend);
  assert.equal(sendDemo.isSendExecutionError, sharedSend.isSendExecutionError);
  assert.equal(sendDemo.INSTANTLY_REPLY_URL, sharedSend.INSTANTLY_REPLY_URL);
  assert.equal(sendDemo.SEND_TIMEOUT_MS, sharedSend.SEND_TIMEOUT_MS);
  assert.equal(sendDemo.AMBIGUOUS_ERROR, sharedSend.AMBIGUOUS_ERROR);
  ok('every extracted primitive is the SAME object in both modules: nothing was forked');

  // The wire itself is unchanged.
  assert.equal(sharedSend.INSTANTLY_REPLY_URL, 'https://api.instantly.ai/api/v2/emails/reply');
  assert.equal(sharedSend.SEND_TIMEOUT_MS, 30000);
  assert.equal(sharedSend.AMBIGUOUS_ERROR, 'AMBIGUOUS_SEND_RESULT');
  ok('the endpoint, the 30s timeout and the ambiguous marker are unchanged');

  // The payload shape is exactly the four documented fields, in order.
  const payload = sharedSend.buildInstantlyReplyPayload({
    replyToUuid: ` ${EMAIL_ID} `, eaccount: ` ${EACCOUNT} `, subject: 'Re: x',
    body: { text: 'a\nb', html: 'a<br/>b' },
  });
  assert.deepEqual(Object.keys(payload), ['reply_to_uuid', 'eaccount', 'subject', 'body']);
  assert.deepEqual(Object.keys(payload.body), ['html', 'text']);
  assert.equal(payload.reply_to_uuid, EMAIL_ID, 'trimmed');
  assert.equal(payload.eaccount, EACCOUNT, 'trimmed');
  assert.equal(payload.subject, 'Re: x', 'not double-prefixed');
  assert.ok(!('thread_id' in payload), 'thread_id is not a request field');
  assert.ok(!('campaign_id' in payload) && !('to' in payload));
  ok('the reply payload is the four documented fields and nothing invented');

  for (const bad of [{}, { replyToUuid: 'u' }, { replyToUuid: 'u', eaccount: 'e' }, { replyToUuid: 'u', eaccount: 'e', body: {} }]) {
    assert.throws(() => sharedSend.buildInstantlyReplyPayload(bad));
  }
  ok('an incomplete payload throws rather than producing a half-formed request');

  // -- outcome classification, over an injected transport -------------------
  const seen = [];
  const stub = (status, bodyText) => async (url, init) => {
    seen.push({ url, method: init.method, auth: init.headers.Authorization });
    return { ok: status >= 200 && status < 300, status, async text() { return bodyText; } };
  };
  const send = (status, bodyText) => sharedSend.sendInstantlyReply({
    apiKey: 'k', payload, fetchImpl: stub(status, bodyText),
  });

  let r = await send(200, JSON.stringify({ id: 'new-1', thread_id: THREAD, message_id: 'm1' }));
  assert.equal(r.outcome, 'SENT');
  assert.equal(r.response.thread_id, THREAD);
  assert.equal(r.error, null);
  r = await send(200, 'not json at all');
  assert.equal(r.outcome, 'SENT', 'a 2xx with an unreadable body is still a send');
  assert.equal(r.response.id, '');
  ok('a 2xx is SENT, and an unparseable 2xx body never downgrades it to a failure');

  for (const status of [400, 401, 402, 403, 404, 422, 429]) {
    r = await send(status, JSON.stringify({ error: 'nope' }));
    assert.equal(r.outcome, 'REJECTED', `${status}`);
    assert.equal(r.error, `INSTANTLY_${status}: nope`);
    assert.equal(sharedSend.isSendExecutionError(r.error), true);
  }
  ok('every 4xx is REJECTED with an INSTANTLY_<status> error a retry can recognise');

  for (const status of [500, 502, 503]) {
    r = await send(status, 'gateway down');
    assert.equal(r.outcome, 'AMBIGUOUS', `${status}`);
    assert.ok(r.error.startsWith('AMBIGUOUS_SEND_RESULT:'));
  }
  ok('every 5xx is AMBIGUOUS and never silently retried');

  r = await sharedSend.sendInstantlyReply({
    apiKey: 'k', payload, fetchImpl: async () => { throw new Error('socket hang up'); },
  });
  assert.equal(r.outcome, 'AMBIGUOUS');
  assert.ok(r.error.includes('transport'));
  ok('a transport failure is AMBIGUOUS, not a rejection');

  // Timeout: an AbortError is classified, and the message names the bound.
  r = await sharedSend.sendInstantlyReply({
    apiKey: 'k', payload, timeoutMs: 5,
    fetchImpl: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
  });
  assert.equal(r.outcome, 'AMBIGUOUS');
  assert.ok(r.error.includes('timeout after 5ms'));
  ok('a timeout is AMBIGUOUS and reports the bound it exceeded');

  // The key is sent as a Bearer header and is never reflected back out: not
  // into a success result, not into a rejection, not into an ambiguous outcome.
  // (Nothing here asserts the key would survive an Instantly response that
  // echoed it verbatim in an unstructured body — that is not a guarantee this
  // transport makes, and inventing a passing test for it would be dishonest.)
  const SECRET = 'sk-super-secret-key';
  for (const result of [
    await sharedSend.sendInstantlyReply({ apiKey: SECRET, payload, fetchImpl: stub(200, '{"id":"x"}') }),
    await sharedSend.sendInstantlyReply({ apiKey: SECRET, payload, fetchImpl: stub(500, 'boom') }),
    await sharedSend.sendInstantlyReply({ apiKey: SECRET, payload, fetchImpl: stub(404, 'gone') }),
    await sharedSend.sendInstantlyReply({ apiKey: SECRET, payload, fetchImpl: async () => { throw new Error('socket hang up'); } }),
  ]) assert.ok(!JSON.stringify(result).includes(SECRET), 'no key in the result');
  ok('the API key never reaches a returned value or a transport error string');

  // It IS sent, and only as a Bearer header on the request itself.
  assert.ok(seen.length > 0);
  assert.ok(seen.every((c) => c.auth.startsWith('Bearer ')), 'always a Bearer header');
  assert.ok(seen.every((c) => c.method === 'POST' && c.url === sharedSend.INSTANTLY_REPLY_URL));
  ok('the key travels only as an Authorization: Bearer header on the one reply POST');

  await assert.rejects(() => sharedSend.sendInstantlyReply({ payload }), /INSTANTLY_REPLY_API_KEY/);
  ok('a send without an API key throws rather than making a request');

  // The transport holds NO policy: no gate, no claim, no persistence.
  const sharedCode = codeOf('lib/instantly-reply-send.mjs');
  assert.ok(!/getClaimStore|reply-claim|updateReplyEvent|getRepo|classify|CONFIDENCE/.test(sharedCode));
  ok('the shared transport imports no gate, no claim store, no repo and no classifier');
}

// ---------------------------------------------------------------------------
part('H. The dry-run API: authenticated, read-only, and unable to send');
// ---------------------------------------------------------------------------

function fakeRes() {
  const res = { statusCode: 0, body: null, headers: {} };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.end = () => res;
  return res;
}

// EVERY write method throws. If the dry run reaches one, the test fails loudly
// rather than quietly mutating a fake.
function installRepo({ replies = [REPLY], outbound = [OUTBOUND_ROW] } = {}) {
  const store = {
    REPLY_EVENTS: [REPLY_EVENTS_HEADER.slice(), ...replies.map((o) => REPLY_EVENTS_HEADER.map((c) => o[c] ?? ''))],
    OUTBOUND: [OUTBOUND_HEADER.slice(), ...outbound.map((o) => OUTBOUND_HEADER.map((c) => o[c] ?? ''))],
  };
  const calls = { reads: 0, tabs: [], writes: 0 };
  const die = (name) => { calls.writes += 1; throw new Error(`WRITE ATTEMPTED: ${name}`); };
  const repo = {
    async getTable(tab) {
      calls.reads += 1; calls.tabs.push(tab);
      if (!store[tab]) throw new Error(`Unable to parse range: ${tab}`);
      return { header: store[tab][0], rows: store[tab].slice(1), allValues: store[tab] };
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
      return (await this.getRecords(tab, idColumn)).find((r) => r.obj[idColumn] === idValue) || null;
    },
    async appendRecord() { die('appendRecord'); },
    async appendRowsBatch() { die('appendRowsBatch'); },
    async updateCell() { die('updateCell'); },
    async updateById() { die('updateById'); },
    async writeRowsBatch() { die('writeRowsBatch'); },
    async writeCellsBatch() { die('writeCellsBatch'); },
  };
  __setRepoForTests(repo);
  return calls;
}

const RAW_INBOUND = {
  id: EMAIL_ID,
  timestamp_email: '2026-09-01T10:00:00.000Z',
  subject: 'Re: The enquiry we sent through',
  from_address_email: LEAD,
  to_address_email_list: EACCOUNT,
  lead: LEAD,
  campaign_id: 'camp_1',
  thread_id: THREAD,
  eaccount: EACCOUNT,
  ue_type: 2,
  content_preview: 'What does it cost?',
};

// The ONLY request this operation may make is the lead-scoped GET. Anything
// else — above all a POST to /emails/reply — fails the test immediately.
const httpLog = [];
function installFetch(emails = [RAW_INBOUND], { status = 200 } = {}) {
  httpLog.length = 0;
  globalThis.fetch = async (url, init) => {
    const method = init?.method || 'GET';
    httpLog.push({ url: String(url), method });
    if (method !== 'GET') throw new Error(`FORBIDDEN non-GET Instantly call: ${method} ${url}`);
    if (String(url).includes('/emails/reply')) throw new Error(`FORBIDDEN send: ${url}`);
    return { ok: status === 200, status, async text() { return JSON.stringify({ items: emails }); } };
  };
}

process.env.NOVUS_BASIC_AUTH_USER = 'test-user';
process.env.NOVUS_BASIC_AUTH_PASS = 'test-pass';
process.env.INSTANTLY_REPLY_API_KEY = 'test-instantly-key';
process.env.NOVUS_SENDING_MAILBOXES = MAILBOXES.join(',');
const AUTH = `Basic ${Buffer.from('test-user:test-pass').toString('base64')}`;
const OP = 'operator-manual-reply-dry-run';

async function dryRun(body, { auth = AUTH, method = 'POST' } = {}) {
  const req = { method, query: { novus_operation: OP }, headers: auth ? { authorization: auth } : {}, body };
  const res = fakeRes();
  await handler(req, res);
  return res;
}

{
  // -- auth -----------------------------------------------------------------
  installRepo(); installFetch();
  let res = await dryRun({ reply_event_id: 'rpl_1', body: BODY }, { auth: null });
  assert.equal(res.statusCode, 401);
  assert.ok(res.headers['www-authenticate']);
  res = await dryRun({ reply_event_id: 'rpl_1', body: BODY }, { auth: `Basic ${Buffer.from('test-user:wrong').toString('base64')}` });
  assert.equal(res.statusCode, 401);
  assert.equal(httpLog.length, 0, 'no Instantly call was made');
  ok('Basic Auth is required, and a rejected caller reaches no Instantly call at all');

  // -- the happy path -------------------------------------------------------
  const calls = installRepo(); installFetch();
  res = await dryRun({ reply_event_id: 'rpl_1', body: BODY });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.eligible, true, res.body.blocked_reason);
  assert.equal(res.body.dry_run, true);
  assert.equal(res.body.sent, false);
  assert.equal(res.body.would_send, true);
  assert.equal(res.body.claim_acquired, false);
  ok('an eligible reply returns 200 with dry_run:true, sent:false and claim_acquired:false');

  assert.equal(res.body.target.sending_inbox, EACCOUNT);
  assert.equal(res.body.target.prospect_email, LEAD);
  assert.equal(res.body.target.agency_id, 'ag_1');
  assert.equal(res.body.target.reply_event_id, 'rpl_1');
  assert.equal(res.body.target.received_at, '2026-09-01T10:00:00.000Z');
  ok('target names the agency, the prospect, the exact sending inbox and the reply being answered');

  assert.equal(res.body.payload_preview.subject, 'Re: The enquiry we sent through');
  assert.equal(res.body.payload_preview.body_text, BODY);
  assert.deepEqual(Object.keys(res.body.payload_preview), ['subject', 'body_text']);
  ok('payload_preview is exactly the subject and body text that would be sent');

  assert.equal(res.body.claim_key_preview, manualReplyClaimKey({ instantlyEmailId: EMAIL_ID, body: BODY }));
  ok('the response previews the future claim key without acquiring it');

  // -- READS ONLY -----------------------------------------------------------
  assert.equal(calls.writes, 0, 'no repo write method was called');
  assert.deepEqual([...new Set(calls.tabs)].sort(), ['OUTBOUND', 'REPLY_EVENTS']);
  ok('the dry run touched only REPLY_EVENTS and OUTBOUND, and wrote nothing');

  assert.equal(httpLog.length, 1, 'exactly one Instantly call');
  assert.equal(httpLog[0].method, 'GET');
  assert.ok(httpLog[0].url.includes('/api/v2/emails?'), httpLog[0].url);
  assert.ok(httpLog[0].url.includes(encodeURIComponent(LEAD)), 'the GET is lead-scoped');
  assert.ok(!httpLog[0].url.includes('/emails/reply'));
  ok('exactly ONE Instantly call is made, a lead-scoped GET — never POST /emails/reply');

  assert.equal(res.headers['cache-control'], 'no-store, max-age=0');
  ok('the response is never cached');

  // -- no secret escapes ----------------------------------------------------
  const flat = JSON.stringify(res.body);
  for (const secret of ['test-instantly-key', 'test-pass', 'Bearer', 'authorization', 'Authorization']) {
    assert.ok(!flat.includes(secret), `no ${secret} in the response`);
  }
  ok('no API key, password or auth header appears anywhere in the response');
}

{
  // -- SPOOFED BROWSER INPUT IS IGNORED ------------------------------------
  // Every field a caller might use to redirect the message somewhere else.
  installRepo(); installFetch();
  const spoofed = {
    reply_event_id: 'rpl_1',
    body: BODY,
    eaccount: 'attacker@evil.com',
    sender: 'attacker@evil.com',
    from: 'attacker@evil.com',
    lead_email: 'victim@elsewhere.com',
    recipient: 'victim@elsewhere.com',
    to: 'victim@elsewhere.com',
    agency_id: 'ag_ATTACKER',
    outbound_id: 'out_ATTACKER',
    thread_id: 'thread_ATTACKER',
    campaign_id: 'camp_ATTACKER',
    reply_to_uuid: 'uuid_ATTACKER',
    subject: 'Subject the attacker chose',
  };
  const res = await dryRun(spoofed);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));

  // Every resolved value came from the server, not from the request.
  assert.equal(res.body.target.sending_inbox, EACCOUNT);
  assert.equal(res.body.target.prospect_email, LEAD);
  assert.equal(res.body.target.agency_id, 'ag_1');
  assert.equal(res.body.target.outreach_id, 'out_1');
  assert.equal(res.body.target.thread_id, THREAD);
  assert.equal(res.body.payload_preview.subject, 'Re: The enquiry we sent through');
  const flat = JSON.stringify(res.body.target) + JSON.stringify(res.body.payload_preview);
  for (const spoof of ['evil.com', 'elsewhere.com', 'ATTACKER', 'Subject the attacker chose']) {
    assert.ok(!flat.includes(spoof), `${spoof} did not influence the resolved target`);
  }
  ok('a spoofed sender, recipient, agency, thread, campaign, uuid or subject is ignored entirely');

  // And the caller is TOLD which of its fields were ignored.
  for (const field of MANUAL_REPLY_DRY_RUN_REJECTED_FIELDS) {
    if (field in spoofed) assert.ok(res.body.ignored_request_fields.includes(field), `${field} reported as ignored`);
  }
  assert.deepEqual(MANUAL_REPLY_DRY_RUN_FIELDS, ['reply_event_id', 'body', 'expected_received_at']);
  for (const accepted of MANUAL_REPLY_DRY_RUN_FIELDS) {
    assert.ok(!res.body.ignored_request_fields.includes(accepted));
  }
  ok('ignored_request_fields names every spoofed field back, so nothing is silently honoured');

  // The GET is still scoped to the SERVER's lead address.
  assert.ok(httpLog[0].url.includes(encodeURIComponent(LEAD)));
  assert.ok(!httpLog[0].url.includes('elsewhere.com'));
  ok('the live conversation fetch is scoped to the stored lead, never the supplied one');
}

{
  // -- blocked responses ----------------------------------------------------
  installRepo(); installFetch();
  let res = await dryRun({ body: BODY });
  assert.equal(res.statusCode, 400);
  assert.ok(/reply_event_id/.test(res.body.error));
  ok('a request with no reply_event_id is a 400');

  res = await dryRun({ reply_event_id: 'rpl_nope', body: BODY });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.blocked_reason, 'REPLY_EVENT_NOT_FOUND');
  assert.equal(res.body.success, false);
  ok('an unknown reply_event_id is a 404 carrying REPLY_EVENT_NOT_FOUND');

  // Blank body: 422.
  installRepo(); installFetch();
  res = await dryRun({ reply_event_id: 'rpl_1', body: '   ' });
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.blocked_reason, 'BODY_EMPTY');
  assert.equal(res.body.eligible, false);
  assert.equal(res.body.payload_preview, null, 'a blocked reply previews no payload');
  assert.equal(res.body.claim_key_preview, null);
  assert.equal(res.body.sent, false);
  ok('a blocked reply is a 422 with no payload preview, no claim key and sent:false');

  // Oversized body: 422.
  res = await dryRun({ reply_event_id: 'rpl_1', body: 'x'.repeat(MAX_MANUAL_REPLY_BODY_CHARS + 1) });
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.blocked_reason, 'BODY_TOO_LONG');
  assert.equal(res.body.body_length, MAX_MANUAL_REPLY_BODY_CHARS + 1);
  assert.equal(res.body.max_body_length, MAX_MANUAL_REPLY_BODY_CHARS);
  ok('an oversized body is a 422 reporting both the length and the limit');

  // Opt-out: 422, and it must be reported as the opt-out.
  const optOut = { ...REPLY, reply_event_id: 'rpl_2', instantly_email_id: NEWER_EMAIL_ID,
    received_at: '2026-08-31T10:00:00.000Z', suppression_type: 'PERMANENT' };
  installRepo({ replies: [REPLY, optOut] }); installFetch();
  res = await dryRun({ reply_event_id: 'rpl_1', body: BODY });
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.blocked_reason, 'PROSPECT_OPTED_OUT');
  ok('an opted-out prospect is refused end to end, through the API, as PROSPECT_OPTED_OUT');

  // Stale: 409, plus the newer reply to refresh onto.
  const newer = { ...REPLY, reply_event_id: 'rpl_3', instantly_email_id: NEWER_EMAIL_ID,
    received_at: '2026-09-02T08:00:00.000Z' };
  installRepo({ replies: [REPLY, newer] }); installFetch();
  res = await dryRun({ reply_event_id: 'rpl_1', body: BODY });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.blocked_reason, 'STALE_REPLY_EVENT');
  assert.equal(res.body.newest_reply_event_id, 'rpl_3');
  assert.equal(res.body.newest_received_at, '2026-09-02T08:00:00.000Z');
  ok('a superseded reply is a 409 naming the newer reply the UI should refresh onto');

  // expected_received_at mismatch is also a 409.
  installRepo(); installFetch();
  res = await dryRun({ reply_event_id: 'rpl_1', body: BODY, expected_received_at: '2020-01-01T00:00:00.000Z' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.blocked_reason, 'STALE_REPLY_EVENT');
  ok('a stale expected_received_at is a 409 too');

  // An eaccount Instantly reports that is NOT ours.
  installRepo();
  installFetch([{ ...RAW_INBOUND, eaccount: 'stranger@notours.com', to_address_email_list: 'stranger@notours.com' }]);
  res = await dryRun({ reply_event_id: 'rpl_1', body: BODY });
  assert.equal(res.statusCode, 422);
  assert.ok(['EACCOUNT_NOT_ALLOWLISTED', 'REPLY_NOT_CONFIRMED_INBOUND'].includes(res.body.blocked_reason), res.body.blocked_reason);
  ok('a live parent on a mailbox outside NOVUS_SENDING_MAILBOXES is refused');

  // Our own SENT message can never be replied to as if it were the prospect's.
  installRepo();
  installFetch([{ ...RAW_INBOUND, from_address_email: EACCOUNT, to_address_email_list: LEAD, ue_type: 1 }]);
  res = await dryRun({ reply_event_id: 'rpl_1', body: BODY });
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.blocked_reason, 'REPLY_NOT_CONFIRMED_INBOUND');
  ok('an OUTBOUND parent is refused: reply_to_uuid can never point at our own message');

  // Instantly unreachable => no live parent => blocked, never sent blind.
  installRepo();
  httpLog.length = 0;
  globalThis.fetch = async () => { throw new Error('socket hang up'); };
  res = await dryRun({ reply_event_id: 'rpl_1', body: BODY });
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.blocked_reason, 'REPLY_NOT_FOUND');
  assert.equal(res.body.instantly.available, false);
  assert.ok(res.body.warnings.some((w) => w.code === 'instantly_unavailable'));
  ok('an unreachable Instantly blocks the reply rather than proceeding on stored data');

  // A 5xx from Instantly likewise blocks, and echoes no key.
  installRepo(); installFetch([], { status: 503 });
  res = await dryRun({ reply_event_id: 'rpl_1', body: BODY });
  assert.equal(res.body.eligible, false);
  assert.ok(!JSON.stringify(res.body).includes('test-instantly-key'));
  ok('an Instantly 5xx blocks and leaks no credential');
}

{
  // -- the operation is POST-only and reaches no other operation -----------
  installRepo(); installFetch();
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    const res = await dryRun({ reply_event_id: 'rpl_1', body: BODY }, { method });
    assert.notEqual(res.statusCode, 200, `${method} must not run the dry run`);
    assert.equal(res.body?.payload_preview, undefined);
  }
  ok('only POST reaches the manual-reply dry run; every other method falls through');

  // A malformed or absent body is a 400, not a crash.
  for (const body of [undefined, null, 'a string', 42, []]) {
    const res = await dryRun(body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }
  ok('a missing or non-object request body is a 400, never an exception');
}

{
  // -- STRUCTURAL: no send, no writer, no AI is reachable ------------------
  const apiCode = codeOf('api/novus/personalisation.js');
  const start = apiCode.indexOf('async function handleOperatorManualReplyDryRun');
  const end = apiCode.indexOf('export default async function handler');
  assert.ok(start > 0 && end > start);
  const fn = apiCode.slice(start, end);

  const BANNED_IN_DRY_RUN = [
    'executeSendDemo', 'sendDemoReply', 'sendInstantlyReply', 'emails/reply',
    'appendRecord', 'appendRowsBatch', 'updateById', 'updateCell',
    'writeRowsBatch', 'writeCellsBatch', 'updateReplyEvent',
    'pollInstantlyReplies', 'classifyReply', 'aiClient', 'callModel',
  ];
  for (const token of BANNED_IN_DRY_RUN) {
    assert.ok(!fn.includes(token), `the dry-run handler must not mention ${token}`);
  }
  ok('the dry-run handler names no send, no writer, no poller and no AI call');

  assert.ok(fn.includes('fetchLeadConversation'), 'the one live read it does make');
  assert.ok(fn.includes('evaluateManualReplyGate'));
  assert.ok(fn.includes('buildInstantlyReplyPayload'), 'the payload is BUILT, not sent');
  ok('it builds the payload with the shared builder and evaluates the shared gate');

  // The operator page is still view-only. Phase 3A adds no send control.
  const html = readFileSync('novus/operator.html', 'utf8');
  assert.ok(!/<textarea/i.test(html), 'no textarea');
  assert.ok(!/manual-reply/i.test(html), 'the page does not call the dry run');
  assert.ok(!/method:\s*'POST'/i.test(html), 'the page issues no POST');
  ok('the operator page is unchanged and still view-only: no reply box, no send button');
}

__setRepoForTests(null);
globalThis.fetch = realFetch;
console.log(`\nNOVUS manual-reply (Phase 3A) self-test passed (${passed} focused assertions).`);
