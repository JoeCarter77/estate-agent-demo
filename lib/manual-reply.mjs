// lib/manual-reply.mjs — the MANUAL (human-authored) reply path. PHASE 3A:
// gate, body builder and idempotency key only. NOTHING HERE SENDS.
//
// WHAT A MANUAL REPLY IS, AND WHY ITS GATE IS NOT SEND_DEMO'S.
// lib/reply-send-demo.mjs answers a prospect WITHOUT a human. Because no one is
// looking, it must be certain the machine UNDERSTOOD the reply, so it gates on
// classification, on a 0.90 confidence floor, and on demo-already-sent
// evidence. A manual reply is the opposite situation: Joe has read the message
// and written the answer himself. Re-imposing the classifier's judgement on his
// would block him from answering a QUESTION or a NOT_NOW — replies the
// automatic path deliberately refuses precisely BECAUSE they need a human.
//
// So this gate drops every JUDGEMENT check and keeps every SAFETY check:
//
//   DROPPED (human already made the call): classification, classifier
//     confidence, demo-sent state, action_status/next_action routing.
//
//   KEPT (a human cannot see these from a drawer): does the parent email
//     really exist in Instantly right now, is it really INBOUND, is it really
//     on the thread we stored, is the sending inbox one of ours, does the
//     OUTBOUND row still resolve to this exact lead, and — the two that
//     protect the PROSPECT rather than the data — has this person opted out,
//     and has a newer reply arrived that Joe has not seen.
//
// PURITY. evaluateManualReplyGate performs NO I/O: no fetch, no Sheets, no
// clock, no send. Every input is supplied by the caller. That is what lets the
// dry run and (later) the live send run the IDENTICAL function over freshly
// gathered inputs, exactly as the SEND_DEMO pair already do.
//
// PHASE 3A SENDS NOTHING. There is no export here that performs a request.

import crypto from 'node:crypto';
import {
  trimmed,
  lower,
  escapeHtml,
  buildReplySubject,
  resolveOutboundForSend,
} from './instantly-reply-send.mjs';
import { novusMailboxes } from './reply-router.mjs';

// The ceiling on a typed reply. Not a style rule — a bound, so a runaway paste
// or a mis-wired client cannot push an unbounded body at Instantly or into a
// durable cell. Comfortably longer than any real sales reply.
export const MAX_MANUAL_REPLY_BODY_CHARS = 5000;

// REPLY_EVENTS.suppression_type value that means "never contact again".
export const PERMANENT_SUPPRESSION = 'PERMANENT';

// Ordered by CONTRACT, not by evaluation order: blocked_reason is the first of
// these that applies, so the reason a human is shown is the most important one
// rather than whichever check happened to run first. The two that protect the
// prospect (opted out, and answering a superseded message) rank above every
// data-integrity reason on purpose.
export const MANUAL_REPLY_BLOCKED_REASONS = [
  'REPLY_EVENT_NOT_FOUND',
  'PROSPECT_OPTED_OUT',
  'REPLY_HISTORY_UNAVAILABLE',
  'STALE_REPLY_EVENT',
  'MISSING_INSTANTLY_EMAIL_ID',
  'MISSING_THREAD_ID',
  'REPLY_NOT_FOUND',
  'REPLY_NOT_CONFIRMED_INBOUND',
  'THREAD_ID_MISMATCH',
  'MISSING_EACCOUNT',
  'EACCOUNT_NOT_ALLOWLISTED',
  'OUTBOUND_MATCH_MISSING',
  'OUTBOUND_MATCH_AMBIGUOUS',
  'OUTBOUND_LEAD_EMAIL_MISMATCH',
  'AGENCY_ID_MISMATCH',
  'BODY_EMPTY',
  'BODY_TOO_LONG',
];

// ---------------------------------------------------------------------------
// THE BODY. Plain text in, {text, html} out.
//
// NO MARKDOWN. NO HTML FROM THE BROWSER. NO AI. Whatever Joe typed is delivered
// as that text and nothing else: the html representation is the SAME string,
// escaped, with line breaks turned into <br/>. The two can never say different
// things because both are built from one normalised line list — the same
// discipline buildDemoReplyBody already follows.
//
// escapeHtml is imported from the shared transport, so a manual reply and an
// automatic one escape identically.
// ---------------------------------------------------------------------------

// CRLF/CR -> LF only. Nothing else about the text is altered: no trimming, no
// collapsing, no smart quotes. What Joe typed is what is preserved.
export function normalizeManualReplyBody(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function buildManualReplyBody(value) {
  const text = normalizeManualReplyBody(value);
  return {
    text,
    html: text.split('\n').map((line) => escapeHtml(line)).join('<br/>'),
  };
}

// ---------------------------------------------------------------------------
// IDEMPOTENCY KEY — DEFINED AND TESTED NOW, ACQUIRED IN A LATER PHASE.
//
// Phase 3A takes no claim, because Phase 3A never sends. The key is built here
// so the live path inherits a shape that is already proven deterministic.
//
// KEYED ON instantly_email_id, NOT reply_event_id — the same reasoning as
// sendClaimKey in lib/reply-claim.mjs: two overlapping poller passes can append
// two REPLY_EVENTS rows with different reply_event_ids for the SAME prospect
// email, and only an email-keyed claim collapses them to one send.
//
// THE BODY IS PART OF THE KEY, which is the difference from SEND_DEMO. The demo
// reply is one fixed template, so the email alone identifies it. A manual reply
// is whatever Joe typed: two DIFFERENT messages to the same parent are two
// legitimate sends, and must not be mistaken for a double-submit of one. A
// re-submitted IDENTICAL body is a double-submit, and collapses.
// ---------------------------------------------------------------------------
export const MANUAL_REPLY_CLAIM_PREFIX = 'novus:manualreply:';

// 128 bits of a SHA-256 digest. Long enough that a collision is not a practical
// concern, short enough to keep the key readable in a store listing.
export const MANUAL_REPLY_BODY_HASH_CHARS = 32;

export function manualReplyBodyHash(body) {
  return crypto
    .createHash('sha256')
    .update(normalizeManualReplyBody(body), 'utf8')
    .digest('hex')
    .slice(0, MANUAL_REPLY_BODY_HASH_CHARS);
}

export function manualReplyClaimKey({ instantlyEmailId, body } = {}) {
  const id = trimmed(instantlyEmailId);
  if (!id) throw new Error('manualReplyClaimKey requires an instantly_email_id');
  return `${MANUAL_REPLY_CLAIM_PREFIX}${id}:${manualReplyBodyHash(body)}`;
}

// ---------------------------------------------------------------------------
// OPT-OUT — the mandatory block.
//
// Scoped to the OUTREACH JOURNEY, not to the one reply being answered: a
// prospect who opted out in their second message has opted out of the whole
// conversation, so replying to their first message must be refused too.
//
// REPLY_EVENTS is the canonical inbound evidence and the only source consulted.
// This phase deliberately does NOT write OUTBOUND.suppressed — blocking the
// send is the whole requirement, and adding a suppression writer would be a
// live-data write this phase does not need.
// ---------------------------------------------------------------------------
export function hasPermanentSuppression(replyEvents) {
  return (replyEvents || []).some(
    (row) => trimmed(row?.suppression_type).toUpperCase() === PERMANENT_SUPPRESSION,
  );
}

// ---------------------------------------------------------------------------
// STALENESS — the second block that protects the prospect.
//
// Joe opens a reply, writes an answer, and while he is typing the prospect
// sends another message. Answering the older one now is at best confusing and
// at worst wrong, because the newer message may withdraw, correct or opt out of
// what the older one said. So the submitted event must be the NEWEST inbound
// reply on its outreach journey.
//
// REPLY_EVENTS is received-only, so every row on the journey IS an inbound
// reply and no direction filter is needed.
//
// Ordering is by received_at. An unparseable or absent received_at sorts as
// -Infinity so it can never masquerade as the newest.
// ---------------------------------------------------------------------------
function receivedAtMs(row) {
  const t = Date.parse(trimmed(row?.received_at));
  return Number.isFinite(t) ? t : -Infinity;
}

// Returns the newest row on the journey, or null when there is nothing to
// compare. Exported so the dry run can tell the UI which reply to refresh to.
export function newestReplyEvent(replyEvents) {
  const rows = (replyEvents || []).filter(Boolean);
  if (!rows.length) return null;
  return rows.reduce((best, row) => (receivedAtMs(row) > receivedAtMs(best) ? row : best), rows[0]);
}

// ---------------------------------------------------------------------------
// THE GATE. Pure. Every input supplied; nothing fetched, nothing written.
//
// inputs:
//   replyEvent           the REPLY_EVENTS row being answered, or null
//   outreachReplyEvents  EVERY REPLY_EVENTS row for the same outreach_id
//                        (including replyEvent). null means the caller could
//                        not load them, which BLOCKS — see below.
//   outboundRecords      [{ obj }] OUTBOUND records, as repo.getRecords returns
//   liveParent           the LIVE Instantly email for instantly_email_id, as
//                        normalizeInstantlyEmail produces, or null
//   mailboxes            the NOVUS sending-inbox allowlist
//   body                 the text Joe typed
//   expectedReceivedAt   optional optimistic-concurrency token
//
// Returns { eligible, blocked_reason, blocked_reasons, resolved, body, ... }.
// NO SECRET, no API key and no auth header is read or returned here — this
// function is given none.
// ---------------------------------------------------------------------------
export function evaluateManualReplyGate({
  replyEvent = null,
  outreachReplyEvents = null,
  outboundRecords = [],
  liveParent = null,
  // Reads NOVUS_SENDING_MAILBOXES when the caller supplies nothing. Env is not
  // I/O, and every test passes the list explicitly.
  mailboxes = novusMailboxes(),
  body = '',
  expectedReceivedAt = '',
} = {}) {
  const reasons = [];
  const add = (reason) => { if (!reasons.includes(reason)) reasons.push(reason); };

  const replyBody = buildManualReplyBody(body);

  const blank = (extra = {}) => ({
    eligible: false,
    blocked_reason: 'REPLY_EVENT_NOT_FOUND',
    blocked_reasons: ['REPLY_EVENT_NOT_FOUND'],
    resolved: {
      reply_event_id: '', outreach_id: '', agency_id: '', eaccount: '',
      subject: '', reply_to_uuid: '', thread_id: '',
    },
    body: null,
    would_send: false,
    ...extra,
  });

  if (!replyEvent || typeof replyEvent !== 'object') return blank();

  const replyEventId = trimmed(replyEvent.reply_event_id);
  const outreachId = trimmed(replyEvent.outreach_id);
  const instantlyEmailId = trimmed(replyEvent.instantly_email_id);
  const threadId = trimmed(replyEvent.thread_id);
  const receivedAt = trimmed(replyEvent.received_at);

  // --- opt-out, over the whole journey -------------------------------------
  // Evaluated against whatever history the caller could load; the separate
  // availability check below is what refuses to proceed on no history at all.
  if (hasPermanentSuppression(outreachReplyEvents)) add('PROSPECT_OPTED_OUT');

  // --- staleness -----------------------------------------------------------
  // FAILS CLOSED. Without the journey's replies we can check neither opt-out
  // nor staleness, and "we could not check" must never behave like "it is
  // fine" — the same rule THREAD_EVIDENCE_UNAVAILABLE follows on the SEND_DEMO
  // path.
  let newest = null;
  if (!Array.isArray(outreachReplyEvents)) {
    add('REPLY_HISTORY_UNAVAILABLE');
  } else {
    newest = newestReplyEvent(outreachReplyEvents);
    const newestId = trimmed(newest?.reply_event_id);
    if (newestId && replyEventId && newestId !== replyEventId) add('STALE_REPLY_EVENT');
    // Optimistic concurrency: the caller may pin the exact received_at it
    // showed the human. A row that has since been re-stamped is not the row
    // Joe read, so it is treated as stale rather than answered.
    const expected = trimmed(expectedReceivedAt);
    if (expected && expected !== receivedAt) add('STALE_REPLY_EVENT');
  }

  // --- identifiers ---------------------------------------------------------
  if (!instantlyEmailId) add('MISSING_INSTANTLY_EMAIL_ID');
  if (!threadId) add('MISSING_THREAD_ID');

  // --- the live parent email, re-verified now ------------------------------
  // reply_to_uuid must point at a genuine RECEIVED prospect email, never at a
  // copy of something NOVUS itself sent. The poller confirmed INBOUND when the
  // row was written; this confirms it again, from Instantly, at reply time.
  let eaccount = '';
  if (!liveParent) add('REPLY_NOT_FOUND');
  else {
    if (liveParent.direction !== 'INBOUND') add('REPLY_NOT_CONFIRMED_INBOUND');
    if (threadId && trimmed(liveParent.thread_id) !== threadId) add('THREAD_ID_MISMATCH');
    eaccount = trimmed(liveParent.eaccount);
    if (!eaccount) add('MISSING_EACCOUNT');
    else {
      // THE ALLOWLIST. The eaccount comes from Instantly, not the browser, but
      // it still decides which mailbox a prospect sees this arrive from, so it
      // is checked against NOVUS_SENDING_MAILBOXES rather than trusted.
      const allowed = (mailboxes || []).map((m) => lower(m)).filter(Boolean);
      if (!allowed.includes(lower(eaccount))) add('EACCOUNT_NOT_ALLOWLISTED');
    }
  }

  // --- OUTBOUND, re-derived (the SAME resolver the demo send uses) ----------
  const outbound = resolveOutboundForSend(outboundRecords, {
    outreachId,
    leadEmail: replyEvent.lead_email,
  });
  if (outbound.reason) add(outbound.reason);

  // --- agency agreement ----------------------------------------------------
  // Checked only once OUTBOUND resolved, so a missing match is reported as the
  // match failure it is rather than as a spurious agency mismatch. A BLANK
  // agency on either side is a MISMATCH, not a pass: this is the check that
  // stops one agency's conversation being answered against another's row.
  const replyAgencyId = trimmed(replyEvent.agency_id);
  const outboundAgencyId = trimmed(outbound.row?.agency_id);
  if (outbound.status === 'MATCHED' && replyAgencyId !== outboundAgencyId) add('AGENCY_ID_MISMATCH');

  // --- the message itself --------------------------------------------------
  if (!replyBody.text.trim()) add('BODY_EMPTY');
  else if (replyBody.text.length > MAX_MANUAL_REPLY_BODY_CHARS) add('BODY_TOO_LONG');

  // --- verdict -------------------------------------------------------------
  const ordered = MANUAL_REPLY_BLOCKED_REASONS.filter((r) => reasons.includes(r));
  const eligible = ordered.length === 0;

  return {
    eligible,
    blocked_reason: eligible ? null : ordered[0],
    blocked_reasons: ordered,
    resolved: {
      reply_event_id: replyEventId,
      outreach_id: outreachId,
      agency_id: replyAgencyId,
      eaccount,
      subject: buildReplySubject(replyEvent.subject),
      // The parent this reply threads from. Instantly derives the thread from
      // reply_to_uuid; thread_id is carried for verification, not for sending.
      reply_to_uuid: instantlyEmailId,
      thread_id: threadId,
    },
    body: eligible ? replyBody : null,
    would_send: eligible,
    // Enough for a UI to refresh onto the message it should have been
    // answering. Ids only — no body text is echoed back here.
    received_at: receivedAt,
    newest_reply_event_id: trimmed(newest?.reply_event_id),
    newest_received_at: trimmed(newest?.received_at),
    outbound_match_status: outbound.status,
    body_length: replyBody.text.length,
  };
}
