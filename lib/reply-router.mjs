// lib/reply-router.mjs — NOVUS Instantly reply router (pure logic, read-only).
//
// PIPELINE THIS FILE SERVES:
//   REPLY DETECTED -> deterministic prospect/outreach match -> persist raw
//   reply event -> classify -> update NOVUS acquisition state -> route next
//   action.
//
// Implemented here: normalisation (from REAL observed Instantly fields),
// deterministic direction, quoted-history cleaning, deterministic routing, and
// a dry-run REPLY_EVENTS row builder. NOT here: OUTBOUND matching, semantic
// classification, state updates, action execution.
//
// WHAT THIS FILE MUST NEVER DO — and why:
//
// 1. NO "stop outreach" action for human replies. Instantly automatically
//    stops a lead's campaign sequence when a genuine reply arrives and remains
//    the outbound EXECUTION layer. A NOVUS stop call would be redundant, so
//    `next_action` has no STOP value at all.
//
// 2. NOVUS still keeps its OWN suppression state, but only for explicit
//    OPT_OUT. That is not a duplicate of Instantly's sequence stop: it exists
//    so a prospect cannot be re-entered into a FUTURE NOVUS campaign after
//    Instantly is changed, recreated or re-imported. Expressed as
//    suppression_type=PERMANENT here, eventually applied as
//    OUTBOUND.outbound_status='SUPPRESSED' — already a valid value in
//    lib/outbound.mjs's OUTBOUND_STATUSES, so no schema change is needed.
//    Applying it is NOT implemented in this file.
//
// 3. NO Instantly writes, no sends, no outbound_status changes, and (in
//    DRY_RUN, the default) no Google Sheets access whatsoever.
//
// lib/instantly-outbound.mjs — the OUTBOUND write path — is untouched by this
// file and is not imported here. Outbound sending behaviour is unchanged.

import { newReplyEventId } from './ids.mjs';

// ---------------------------------------------------------------------------
// REPLY_EVENTS — the raw/audit event store.
//
// ONE RECEIVED EMAIL = ONE ROW. A later reply on the same thread is a NEW row;
// an existing row is NEVER overwritten because a newer email arrived. The
// mutable per-row fields (processed_at, action_status, action_completed_at,
// error) describe the fate of THAT event only.
//
// Column order below is the exact tab layout and is what buildReplyEventRow
// emits. lib/sheets.mjs addresses tabs by name with no central registry, so
// nothing else needs to learn about this tab.
// ---------------------------------------------------------------------------
export const REPLY_EVENTS_TAB = 'REPLY_EVENTS';

export const REPLY_EVENTS_HEADER = [
  'reply_event_id',
  'instantly_email_id',
  'agency_id',
  'outreach_id',
  'lead_email',
  'campaign_id',
  'thread_id',
  'received_at',
  'subject',
  'body_text',
  'cleaned_reply_text',
  'is_auto_reply',
  'classification',
  'confidence',
  'suppression_type',
  'next_action',
  'priority',
  'processed_at',
  'action_status',
  'action_completed_at',
  'classifier_reason',
  'error',
  'notes',
];

// instantly_email_id is the EXTERNAL EVENT IDEMPOTENCY KEY: the production
// poller must look this up in REPLY_EVENTS before doing anything else, via
// getRepo().findById('REPLY_EVENTS', 'instantly_email_id', id). Never an
// in-memory cache. See findExistingReplyEvent below.
export const REPLY_EVENTS_IDEMPOTENCY_COLUMN = 'instantly_email_id';

// REPLY_EVENTS.outreach_id stores OUTBOUND.outbound_id — OUTBOUND's stable
// opaque outreach identifier. OUTBOUND has no column literally named
// outreach_id. Populating it requires the match step (see MATCH_PLAN).
export const OUTREACH_ID_SOURCE_COLUMN = 'outbound_id';

// The match, implemented in lib/instantly-reply-poll.mjs. Campaign corroboration
// is NOT available: OUTBOUND stores no campaign_id (the campaign lives only in
// the INSTANTLY_CAMPAIGN_ID env var, applied at upload time), so matching is
// EMAIL_ONLY. Callers that do not match still leave agency_id and outreach_id
// blank rather than guessing.
export const MATCH_PLAN = Object.freeze({
  primary: { from: 'lead_email', to: 'OUTBOUND.outreach_contact_email' },
  method: 'EMAIL_ONLY',
  campaign_corroboration_available: false,
  implemented: true,
});

export const CLASSIFICATIONS = [
  'POSITIVE_SEND_DEMO',
  'POSITIVE_MEETING',
  'QUESTION',
  'NOT_INTERESTED',
  'NOT_NOW',
  'OPT_OUT',
  'OOO_AUTOMATED',
  'OTHER_UNCLEAR',
];

export const SUPPRESSION_TYPES = ['NONE', 'PERMANENT'];

export const NEXT_ACTIONS = [
  'SEND_DEMO',
  'HUMAN_REPLY',
  'BOOK_MEETING',
  'CREATE_NURTURE',
  'CLOSE',
  'NONE',
  'MANUAL_REVIEW',
];

export const PRIORITIES = ['CRITICAL', 'HIGH', 'NORMAL', 'LOW'];

export const ACTION_STATUSES = ['PENDING', 'COMPLETED', 'REVIEW', 'FAILED', 'NO_ACTION'];

export const DIRECTIONS = ['INBOUND', 'OUTBOUND', 'UNKNOWN'];

// The eventual routing table, recorded now so the intended mapping lives in one
// place. Only OOO_AUTOMATED, OPT_OUT and OTHER_UNCLEAR are ever PRODUCED by
// routeReply() today; the rest are reached only once a classifier exists.
//
// POSITIVE_MEETING is HUMAN_REPLY because the HUMAN_REPLY / BOOK_MEETING choice
// is not settled — a human confirming the slot is safer until booking is wired.
export const ROUTING_TABLE = {
  POSITIVE_SEND_DEMO: { next_action: 'SEND_DEMO', priority: 'HIGH', suppression_type: 'NONE' },
  POSITIVE_MEETING: { next_action: 'HUMAN_REPLY', priority: 'CRITICAL', suppression_type: 'NONE' },
  QUESTION: { next_action: 'HUMAN_REPLY', priority: 'HIGH', suppression_type: 'NONE' },
  NOT_INTERESTED: { next_action: 'CLOSE', priority: 'NORMAL', suppression_type: 'NONE' },
  NOT_NOW: { next_action: 'CREATE_NURTURE', priority: 'NORMAL', suppression_type: 'NONE' },
  OPT_OUT: { next_action: 'NONE', priority: 'NORMAL', suppression_type: 'PERMANENT' },
  OOO_AUTOMATED: { next_action: 'NONE', priority: 'LOW', suppression_type: 'NONE' },
  OTHER_UNCLEAR: { next_action: 'MANUAL_REVIEW', priority: 'HIGH', suppression_type: 'NONE' },
};

// ---------------------------------------------------------------------------
// Field access helpers. Every read is a fallback chain: the observed test
// response confirmed some names, but one controlled reply is not the whole API
// surface, so nothing assumes a field exists.
// ---------------------------------------------------------------------------
function pickField(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function asText(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return String(value);
}

// Accepts "a@b.com", "Joe Carter <a@b.com>", "a@b.com, c@d.com", or an array of
// any of those. Returns lowercased addresses.
export function extractEmails(value) {
  const parts = Array.isArray(value) ? value : [value];
  const found = [];
  for (const part of parts) {
    const text = asText(part);
    const matches = text.match(/[^\s<>,;"']+@[^\s<>,;"']+/g) || [];
    for (const match of matches) {
      const cleaned = match.replace(/[.,;]+$/, '').toLowerCase();
      if (!found.includes(cleaned)) found.push(cleaned);
    }
  }
  return found;
}

function firstEmail(value) {
  return extractEmails(value)[0];
}

// The NOVUS sending mailbox(es). Overridable via env for other sending
// identities without a code change; the observed campaign sends from
// joe@novushq.co.uk.
export const DEFAULT_NOVUS_MAILBOXES = ['joe@novushq.co.uk'];

export function novusMailboxes(override) {
  if (Array.isArray(override) && override.length) return override.map((m) => asText(m).toLowerCase());
  const fromEnv = process.env.NOVUS_SENDING_MAILBOXES;
  if (fromEnv) {
    const parsed = extractEmails(fromEnv.split(','));
    if (parsed.length) return parsed;
  }
  return DEFAULT_NOVUS_MAILBOXES;
}

// Instantly may express "automated reply" as a boolean, 0/1, or a string.
// Anything not recognisably truthy is false: defaulting an unknown to
// "automated" would silently drop a real human reply into NONE/no-action.
function truthyFlag(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') return ['true', '1', 'yes'].includes(value.trim().toLowerCase());
  return false;
}

function rawBody(raw) {
  const body = pickField(raw, 'body', 'content', 'message');
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object') {
    const nested = pickField(body, 'text', 'plain', 'html');
    if (typeof nested === 'string') return nested;
  }
  return asText(pickField(raw, 'body_text', 'text', 'body_preview', 'content_preview', 'snippet', 'preview') ?? '');
}

// Provider fields that MIGHT encode direction/message type. Preserved verbatim
// when present so we can inspect them against real traffic, but deliberately
// NOT used by detectDirection: direction stays deterministic from addresses,
// per the agreed rule. is_unread is likewise never a direction input.
const PROVIDER_HINT_KEYS = [
  'ue_type', 'email_type', 'message_type', 'direction', 'type',
  'eaccount', 'email_account', 'message_id', 'from_address_json', 'to_address_json',
  'i_status', 'ai_interest_value', 'is_focused', 'step', 'organization_id',
];

export function providerHints(raw) {
  const hints = {};
  if (!raw || typeof raw !== 'object') return hints;
  for (const key of PROVIDER_HINT_KEYS) {
    if (raw[key] !== undefined && raw[key] !== null && raw[key] !== '') hints[key] = raw[key];
  }
  return hints;
}

// ---------------------------------------------------------------------------
// ue_type — Instantly's own message-type field, confirmed present on real
// objects and documented as:
//   1 = Sent from campaign   2 = Received   3 = Sent manually   4 = Scheduled
//
// Only 2 can ever be an inbound prospect reply. 1/3/4 are our own traffic.
// ---------------------------------------------------------------------------
export const UE_TYPE = Object.freeze({
  SENT_FROM_CAMPAIGN: 1,
  RECEIVED: 2,
  SENT_MANUALLY: 3,
  SCHEDULED: 4,
});

const UE_TYPE_EXPECTED_DIRECTION = {
  1: 'OUTBOUND',
  2: 'INBOUND',
  3: 'OUTBOUND',
  4: 'OUTBOUND',
};

export function parseUeType(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && UE_TYPE_EXPECTED_DIRECTION[n] ? n : null;
}

// The production poller's intended query — RECORDED, NOT IMPLEMENTED.
//
// GET /api/v2/emails documents an `email_type` enum (received | sent | manual),
// so the poller can ask the API for received mail only instead of pulling mixed
// traffic and discarding our own sent copies client-side. Fetching mixed and
// filtering locally is what the current diagnostic does; the poller should not.
//
// This is a narrowing of what we ask for, NOT a replacement for the direction
// check: a provider-side filter is still a provider claim, and the address
// cross-check below stays mandatory either way.
export const POLLER_QUERY_PLAN = Object.freeze({
  url: 'https://api.instantly.ai/api/v2/emails',
  params: Object.freeze({ email_type: 'received', limit: 100, sort_order: 'desc' }),
  supports_received_only_filter: true,
  implemented: false,
});

// ---------------------------------------------------------------------------
// Direction — provider signal FIRST, address relationship as a mandatory
// cross-check. Never guessed.
//
// THE NOVUS MAILBOX USED FOR VALIDATION:
// `eaccount` is Instantly's own "email account used for this email", so it is
// the authoritative NOVUS-side address for THAT message and is preferred over
// any configured list — it keeps direction correct when sending identities are
// added or changed without a code change. NOVUS_SENDING_MAILBOXES (defaulting
// to joe@novushq.co.uk) is the fallback for when eaccount is absent or does not
// parse as an address.
//
// ADDRESS RELATIONSHIP:
//   inbound-shaped  : from == lead_email AND recipients include the NOVUS account
//   outbound-shaped : from is the NOVUS account AND recipients include lead_email
//   Both true at once (lead_email IS the NOVUS account) is ambiguous, not inbound.
//
// FINAL DECISION:
//   ue_type present -> the provider's claim and the address relationship must
//     AGREE. ue_type 2 + inbound-shaped => INBOUND. ue_type 1/3/4 +
//     outbound-shaped => OUTBOUND. Any contradiction, including ue_type 2 with
//     addresses that do not validate, => UNKNOWN. ue_type 1/3/4 can never
//     produce INBOUND regardless of what the addresses look like.
//   ue_type absent/unrecognised -> address relationship alone decides, which is
//     the pre-ue_type behaviour rather than a new failure mode.
//
// NOT consulted, deliberately: is_unread (read state, and it was 1 on the
// observed reply only because nobody had opened it), i_status, and
// ai_interest_value. None of them describe who sent what.
// ---------------------------------------------------------------------------

// The NOVUS-side address for one message: eaccount when usable, else the
// configured list.
export function novusAccountsFor({ eaccount, mailboxes } = {}) {
  const fromEaccount = extractEmails(eaccount);
  if (fromEaccount.length) return { accounts: fromEaccount, source: 'eaccount' };
  return { accounts: novusMailboxes(mailboxes), source: 'configured' };
}

// The address relationship on its own. Exported so tests (and later the match
// step) can reason about it independently of the provider signal.
export function addressRelationship({ fromEmail, toEmails, leadEmail, eaccount, mailboxes }) {
  const from = asText(fromEmail).toLowerCase();
  const lead = asText(leadEmail).toLowerCase();
  const recipients = (toEmails || []).map((t) => asText(t).toLowerCase());
  const { accounts } = novusAccountsFor({ eaccount, mailboxes });
  if (!from || !lead || !recipients.length) return 'UNKNOWN';

  const inbound = from === lead && recipients.some((r) => accounts.includes(r));
  const outbound = accounts.includes(from) && recipients.includes(lead);
  // Both true means the lead address IS the NOVUS account — genuinely ambiguous.
  if (inbound && outbound) return 'UNKNOWN';
  if (inbound) return 'INBOUND';
  if (outbound) return 'OUTBOUND';
  return 'UNKNOWN';
}

export function detectDirection({ ueType, fromEmail, toEmails, leadEmail, eaccount, mailboxes }) {
  const byAddress = addressRelationship({ fromEmail, toEmails, leadEmail, eaccount, mailboxes });
  const parsed = parseUeType(ueType);

  // No usable provider signal: fall back to addresses alone.
  if (parsed === null) return byAddress;

  const claimed = UE_TYPE_EXPECTED_DIRECTION[parsed];
  // Trust ue_type only where the addresses corroborate it. A ue_type of 2 whose
  // sender/recipient/lead relationship does not validate is a contradiction,
  // and a contradiction is UNKNOWN — never INBOUND.
  return claimed === byAddress ? claimed : 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Quoted-history cleaning.
//
// Cuts at the EARLIEST quoted-history marker and keeps what precedes it. The
// raw body is preserved separately and untouched — nothing is deleted, only
// the classifier's view is narrowed. V1 handles the common separators only; if
// no marker is found the whole (trimmed) body is the cleaned text.
//
// If cutting would leave nothing (e.g. a reply that is ONLY quoted history),
// the trimmed raw text is returned instead: an empty cleaned_reply_text would
// make an opt-out phrase unfindable and silently route the event to review.
// ---------------------------------------------------------------------------
const QUOTE_MARKERS = [
  // "On Mon, 31 Aug 2026 at 21:01, Joe Carter <joe@novushq.co.uk> wrote:"
  //
  // "On" MUST BE FOLLOWED BY A DATE-LIKE TOKEN. A bare /\bOn\b .. wrote:/ also
  // matched the "on" INSIDE an ordinary reply — "yeah go on" above a quoted
  // header was cut to "yeah go", mangling exactly the kind of short positive
  // reply the classifier has to read. Requiring a weekday, day number or month
  // next keeps every real header (they all carry a date) and stops the
  // conversational "on". NOT anchored to a line start: the real observed
  // Instantly preview carries the header inline, on the same line as the reply.
  /\bOn\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d{1,2}\b)[\s\S]{0,300}?\bwrote:/i,
  // "-----Original Message-----"
  /-{2,}\s*Original Message\s*-{2,}/i,
  // A quoted header block: From: ... followed by Sent:/Date:/To:/Subject:.
  // Both parts required so an ordinary sentence starting "From" is not a match.
  /(^|\n)\s*From:.{0,200}(\n|\s)+\s*(Sent|Date|To|Subject):/i,
  // A quoted line beginning with ">".
  /(^|\n)\s*>/,
];

export function cleanReplyText(rawText) {
  const text = asText(rawText);
  if (!text.trim()) return '';

  let cutAt = text.length;
  for (const marker of QUOTE_MARKERS) {
    const match = text.match(marker);
    if (match && match.index !== undefined && match.index < cutAt) cutAt = match.index;
  }

  const cleaned = text.slice(0, cutAt).replace(/\s+/g, ' ').trim();
  return cleaned || text.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Normalisation of one Instantly email object.
// ---------------------------------------------------------------------------
export function normalizeInstantlyEmail(raw, { mailboxes } = {}) {
  const from_email = firstEmail(pickField(raw, 'from_address_email', 'from_address', 'from', 'from_email'));
  const to_emails = extractEmails(pickField(raw, 'to_address_email_list', 'to_address_email', 'to_address', 'to', 'to_email'));
  const lead_email = firstEmail(pickField(raw, 'lead', 'lead_email', 'email'));
  const raw_body_text = rawBody(raw);
  const ue_type = parseUeType(pickField(raw, 'ue_type'));
  const eaccount = firstEmail(pickField(raw, 'eaccount', 'email_account')) || '';

  return {
    email_id: asText(pickField(raw, 'id', 'email_id', '_id') ?? ''),
    timestamp: asText(pickField(raw, 'timestamp', 'timestamp_created', 'timestamp_email', 'created_at', 'date') ?? ''),
    subject: asText(pickField(raw, 'subject') ?? ''),
    from_email: from_email || '',
    to_emails,
    lead_email: lead_email || '',
    campaign_id: asText(pickField(raw, 'campaign_id', 'campaign', 'campaignId') ?? ''),
    thread_id: asText(pickField(raw, 'thread_id', 'threadId') ?? ''),
    is_unread: truthyFlag(pickField(raw, 'is_unread', 'unread')),
    is_auto_reply: truthyFlag(pickField(raw, 'is_auto_reply', 'auto_reply', 'ai_interest_status_auto_reply')),
    raw_body_text,
    cleaned_reply_text: cleanReplyText(raw_body_text),
    // Provider fields promoted to first-class because direction depends on
    // them. ue_type is the primary signal; eaccount names the NOVUS-side
    // account; message_id is the RFC message id, kept for threading/audit.
    ue_type,
    eaccount,
    message_id: asText(pickField(raw, 'message_id') ?? ''),
    direction: detectDirection({
      ueType: ue_type,
      fromEmail: from_email,
      toEmails: to_emails,
      leadEmail: lead_email,
      eaccount,
      mailboxes,
    }),
    // Full provider payload hints, preserved verbatim for auditability —
    // including ue_type, so the raw claim survives even when direction
    // disagrees with it and resolves to UNKNOWN.
    provider_hints: providerHints(raw),
  };
}

// Kept as the router's input name. Same function; the previous provisional
// shape has been replaced by the real-field one above.
export const normalizeReplyEmail = normalizeInstantlyEmail;

// ---------------------------------------------------------------------------
// Deterministic routing.
// ---------------------------------------------------------------------------

// Matched on normalised cleaned_reply_text: lowercased, curly apostrophes
// folded, whitespace collapsed. Phrases (not bare words like "stop" or
// "remove") keep the false-positive rate low.
//
// Matching CLEANED text is what makes this safe against quoted history: a
// positive reply above a quoted footer containing "unsubscribe" is no longer
// misfiled as an opt-out, because the footer is cut before matching.
const OPT_OUT_PATTERNS = [
  'unsubscribe',
  'remove me',
  'remove my details',
  'do not contact me',
  "don't contact me",
  'stop emailing me',
  "don't email me again",
  'do not email me again',
];

export function normalizeTextForMatching(value) {
  return asText(value)
    .replace(/[‘’ʼ]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectOptOut(reply) {
  const body = normalizeTextForMatching(reply?.cleaned_reply_text ?? reply?.raw_body_text ?? '');
  const haystack = `${normalizeTextForMatching(reply?.subject)} ${body}`;
  return OPT_OUT_PATTERNS.find((phrase) => haystack.includes(phrase)) || null;
}

function decision(classification, reason, confidence) {
  const route = ROUTING_TABLE[classification];
  return {
    classification,
    confidence,
    suppression_type: route.suppression_type,
    next_action: route.next_action,
    priority: route.priority,
    reason,
  };
}

// routeReply — pure, synchronous, no I/O, no AI, no writes.
//
// RULE ORDER IS PART OF THE CONTRACT:
//   1. is_auto_reply === true -> OOO_AUTOMATED. An out-of-office is not a human
//      intent signal, so it must never reach opt-out matching.
//   2. Explicit opt-out language -> OPT_OUT + PERMANENT NOVUS suppression. Runs
//      BEFORE any AI classification, always, so a compliance-critical signal
//      never depends on a model call.
//   3. Everything else -> OTHER_UNCLEAR / MANUAL_REVIEW / HIGH, confidence
//      null. AI is NOT wired: lib/classification.mjs's classifyCommunication()
//      targets estate-agent responses to a NOVUS probe — a different domain
//      with a different enum — so reusing it here would be neither safe nor
//      isolated. A human sees these; nothing is silently auto-actioned. This is
//      why the observed "Yes send" reply routes to MANUAL_REVIEW rather than
//      POSITIVE_SEND_DEMO today.
//
// Deterministic verdicts carry confidence 1 (certain by construction); the
// undecided branch carries null, never a fabricated score.
export function routeReply(reply) {
  if (reply?.is_auto_reply === true) {
    return decision('OOO_AUTOMATED', 'is_auto_reply flag set by Instantly', 1);
  }

  const phrase = detectOptOut(reply);
  if (phrase) {
    return decision('OPT_OUT', `deterministic opt-out phrase matched: "${phrase}"`, 1);
  }

  return decision('OTHER_UNCLEAR', 'no deterministic rule matched; semantic classification not wired', null);
}

// ---------------------------------------------------------------------------
// REPLY_EVENTS row construction and (disabled) persistence.
// ---------------------------------------------------------------------------

// action_status reflects what still has to happen to THIS event:
//   NONE          -> NO_ACTION (OOO)
//   MANUAL_REVIEW -> REVIEW
//   anything else -> PENDING
//
// OPT_OUT is PENDING, not NO_ACTION: its next_action is NONE only because there
// is no OUTREACH action to take (Instantly already stopped the sequence), but
// NOVUS still owes a suppression write, so the event is not finished.
function actionStatusFor(decisionObj) {
  if (decisionObj.classification === 'OPT_OUT') return 'PENDING';
  if (decisionObj.next_action === 'NONE') return 'NO_ACTION';
  if (decisionObj.next_action === 'MANUAL_REVIEW') return 'REVIEW';
  return 'PENDING';
}

// Builds the row object for one received email. Pure: no I/O, no clock reads
// beyond the caller-supplied `now`, no id minting unless the caller omits one.
//
// agency_id and outreach_id come from the match step (MATCH_PLAN), which is not
// built yet — callers pass nothing and both stay blank rather than guessed.
export function buildReplyEventRow(reply, decisionObj, {
  agencyId = '',
  outreachId = '',
  replyEventId,
  now = new Date().toISOString(),
  notes = '',
} = {}) {
  return {
    reply_event_id: replyEventId || newReplyEventId(),
    instantly_email_id: asText(reply?.email_id ?? ''),
    agency_id: agencyId,
    outreach_id: outreachId,
    lead_email: asText(reply?.lead_email ?? ''),
    campaign_id: asText(reply?.campaign_id ?? ''),
    thread_id: asText(reply?.thread_id ?? ''),
    received_at: asText(reply?.timestamp ?? ''),
    subject: asText(reply?.subject ?? ''),
    // The raw body is stored verbatim; cleaning never destroys it.
    body_text: asText(reply?.raw_body_text ?? ''),
    cleaned_reply_text: asText(reply?.cleaned_reply_text ?? ''),
    is_auto_reply: reply?.is_auto_reply === true ? 'TRUE' : 'FALSE',
    classification: decisionObj.classification,
    confidence: decisionObj.confidence === null || decisionObj.confidence === undefined
      ? ''
      : String(decisionObj.confidence),
    suppression_type: decisionObj.suppression_type,
    next_action: decisionObj.next_action,
    priority: decisionObj.priority,
    processed_at: now,
    action_status: actionStatusFor(decisionObj),
    action_completed_at: '',
    classifier_reason: decisionObj.reason,
    error: '',
    notes,
  };
}

// The production idempotency check, expressed once so the poller cannot invent
// its own. A read, never a write. Returns the existing record or null.
export async function findExistingReplyEvent(repo, instantlyEmailId) {
  const id = asText(instantlyEmailId).trim();
  if (!id) throw new Error('instantly_email_id is required for the idempotency check');
  return repo.findById(REPLY_EVENTS_TAB, REPLY_EVENTS_IDEMPOTENCY_COLUMN, id);
}

// ONE read of REPLY_EVENTS for a whole polling pass.
//
// WHY: findExistingReplyEvent reads the entire tab per candidate email. That is
// fine for a bounded manual dry run, but on a schedule it is N full-tab reads
// per pass. This loads the tab ONCE and returns the set of instantly_email_id
// values already present.
//
// THE SHEET REMAINS THE SOURCE OF TRUTH. The set is EXECUTION-LOCAL ONLY: it is
// built fresh at the start of every pass and discarded at the end. It is not a
// cache, not an index, and is never persisted between invocations — a stale
// cross-pass memory would either re-process a reply or, worse, permanently
// suppress a new one it wrongly believed it had seen.
//
// It also validates the live header. If the tab's columns are not exactly
// REPLY_EVENTS_HEADER, header_matches is false and the caller must abort the
// pass rather than append: appendRecord maps onto the LIVE header, so appending
// into a drifted tab would write correct values into the wrong columns.
export async function loadProcessedReplyEventIds(repo) {
  const { header, rows } = await repo.getTable(REPLY_EVENTS_TAB);
  const idIdx = header.indexOf(REPLY_EVENTS_IDEMPOTENCY_COLUMN);

  const ids = new Set();
  if (idIdx >= 0) {
    for (const row of rows) {
      const value = asText(row?.[idIdx]).trim();
      // Blank ids and the SCHEMA NOTE row are not events.
      if (!value || value === 'SCHEMA NOTE') continue;
      ids.add(value);
    }
  }

  const headerMatches = header.length === REPLY_EVENTS_HEADER.length
    && REPLY_EVENTS_HEADER.every((col, i) => header[i] === col);

  return {
    ids,
    header,
    header_matches: headerMatches,
    header_mismatch: headerMatches ? null : {
      expected: REPLY_EVENTS_HEADER,
      actual: header,
    },
  };
}

// Every REPLY_EVENTS column must be present, and nothing else may be. Cheap,
// but it is the last gate before a write: a row shaped by a future code change
// that silently dropped or renamed a field must fail here, not append a row
// with a blank idempotency key that can never be de-duplicated again.
export function validateReplyEventRow(row) {
  const errors = [];
  if (!row || typeof row !== 'object') return ['row is not an object'];

  const keys = Object.keys(row);
  for (const col of REPLY_EVENTS_HEADER) {
    if (!keys.includes(col)) errors.push(`missing column: ${col}`);
  }
  for (const key of keys) {
    if (!REPLY_EVENTS_HEADER.includes(key)) errors.push(`unexpected column: ${key}`);
  }
  // These three identify the event. A blank one is never appendable.
  for (const required of ['reply_event_id', 'instantly_email_id', 'lead_email']) {
    if (!asText(row[required]).trim()) errors.push(`blank required value: ${required}`);
  }
  return errors;
}

export const DEFAULT_DRY_RUN = true;

// persistReplyEvent — DRY-RUN BY DEFAULT and non-destructive.
//
// dryRun (the default) touches NOTHING: no repo call at all, so no Sheets read
// and no Sheets write. It returns the proposed row for logging/inspection.
//
// The live branch requires BOTH an explicit dryRun:false AND a repo, and even
// then only ever APPENDS after the instantly_email_id idempotency check — it
// never updates or overwrites an existing row, because a later email on the
// same thread is a new event, not a revision of an old one. It is not called
// from anywhere in the codebase.
// duplicateChecked lets a caller that has ALREADY established this
// instantly_email_id is unprocessed — the poller, which loaded REPLY_EVENTS
// once per pass — skip a second full-tab read. It defaults to false, so the
// unsafe direction (appending without any check) is never the default.
export async function persistReplyEvent(row, {
  repo = null,
  dryRun = DEFAULT_DRY_RUN,
  duplicateChecked = false,
} = {}) {
  if (dryRun) {
    return { dryRun: true, persisted: false, skipped: 'dry_run', row };
  }
  if (!repo) throw new Error('persistReplyEvent requires a repo when dryRun is false');

  const errors = validateReplyEventRow(row);
  if (errors.length) {
    const err = new Error(`REPLY_EVENTS row failed schema validation: ${errors.join('; ')}`);
    err.validation_errors = errors;
    throw err;
  }

  const existing = duplicateChecked
    ? null
    : await findExistingReplyEvent(repo, row.instantly_email_id);
  if (existing) {
    // Already processed: do not classify again, do not create another event,
    // do not execute another action.
    return { dryRun: false, persisted: false, skipped: 'duplicate_instantly_email_id', row: existing.obj };
  }

  await repo.appendRecord(REPLY_EVENTS_TAB, row);
  return { dryRun: false, persisted: true, skipped: null, row };
}

// End-to-end skeleton for one raw Instantly email: normalise -> route -> build
// row -> (dry-run) persist. Deliberately does NOT match, classify semantically,
// update acquisition state, send anything, or call Instantly.
//
// Only an INBOUND email is a reply. An OUTBOUND email (our own sent message,
// which the same API result contains) or an UNKNOWN one is returned with a null
// decision and null row rather than being routed — routing our own outbound
// copy would manufacture a phantom reply event.
export async function processReplyEmail(rawEmail, options = {}) {
  const reply = normalizeInstantlyEmail(rawEmail, options);
  if (reply.direction !== 'INBOUND') {
    return { reply, decision: null, row: null, persistence: null, skipped: `direction_${reply.direction.toLowerCase()}` };
  }
  const decisionObj = routeReply(reply);
  const row = buildReplyEventRow(reply, decisionObj, options);
  const persistence = await persistReplyEvent(row, options);
  return { reply, decision: decisionObj, row, persistence, skipped: null };
}

// ---------------------------------------------------------------------------
// DERIVED-FIELD UPDATE, on the SAME already-persisted REPLY_EVENTS row.
//
// The raw event is written first and is EVIDENCE. Classification produces an
// INTERPRETATION of that evidence, and an interpretation may never rewrite what
// it interpreted. So the update path below can only ever touch the columns in
// DERIVED_CLASSIFICATION_FIELDS, is enforced to do so, and writes those cells
// INDIVIDUALLY — it never rewrites the row, which is what makes it impossible
// for a bug here to damage body_text, cleaned_reply_text, lead_email, thread_id,
// received_at, instantly_email_id, agency_id or outreach_id.
//
// It also never appends: a classification is not a new event.
//
// action_status IS derived — it is a pure function of next_action (see
// actionStatusFor), so leaving it stale after a reclassification would make the
// row internally contradictory (e.g. next_action=SEND_DEMO, action_status=
// REVIEW). processed_at is NOT in the list: it records when the event was
// processed into REPLY_EVENTS, which classification does not change.
// ---------------------------------------------------------------------------
export const DERIVED_CLASSIFICATION_FIELDS = [
  'classification',
  'confidence',
  'suppression_type',
  'next_action',
  'priority',
  'action_status',
  'classifier_reason',
  'error',
];

// Columns that carry the raw evidence of the event. Never written after append.
export const RAW_EVIDENCE_FIELDS = REPLY_EVENTS_HEADER.filter(
  (col) => !DERIVED_CLASSIFICATION_FIELDS.includes(col) && col !== 'processed_at'
    && col !== 'action_completed_at' && col !== 'notes',
);

// One decision -> the patch of derived cells it implies. Pure.
export function buildClassificationPatch(decisionObj) {
  if (!decisionObj || !ROUTING_TABLE[decisionObj.classification]) {
    throw new Error(`buildClassificationPatch: unknown classification ${JSON.stringify(decisionObj?.classification)}`);
  }
  const route = ROUTING_TABLE[decisionObj.classification];
  const patch = {
    classification: decisionObj.classification,
    confidence: decisionObj.confidence === null || decisionObj.confidence === undefined
      ? ''
      : String(decisionObj.confidence),
    // Routing metadata always comes from the table, never from the model.
    suppression_type: route.suppression_type,
    next_action: route.next_action,
    priority: route.priority,
    classifier_reason: asText(decisionObj.reason ?? ''),
    error: asText(decisionObj.error ?? ''),
  };
  patch.action_status = actionStatusFor({
    classification: patch.classification,
    next_action: patch.next_action,
  });
  return patch;
}

// Applies a derived-field patch to ONE existing row, located by reply_event_id.
//
// dryRun (the default) reads nothing and writes nothing — it returns the patch
// it would have applied. The live branch performs ONE getTable read to resolve
// the row number and the column positions, then ONE writeCellsBatch of only the
// derived cells.
//
// Throws if the patch contains anything outside DERIVED_CLASSIFICATION_FIELDS:
// that is a programming error, and the whole point of this function is that it
// cannot be the route by which raw evidence is lost.
export async function updateReplyEventClassification(replyEventId, patch, {
  repo = null,
  dryRun = DEFAULT_DRY_RUN,
} = {}) {
  const id = asText(replyEventId).trim();
  if (!id) throw new Error('updateReplyEventClassification requires a reply_event_id');

  const illegal = Object.keys(patch || {}).filter((k) => !DERIVED_CLASSIFICATION_FIELDS.includes(k));
  if (illegal.length) {
    throw new Error(`refusing to update non-derived REPLY_EVENTS fields: ${illegal.join(', ')}`);
  }

  if (dryRun) return { dryRun: true, updated: false, skipped: 'dry_run', reply_event_id: id, patch };
  if (!repo) throw new Error('updateReplyEventClassification requires a repo when dryRun is false');

  const { header, rows } = await repo.getTable(REPLY_EVENTS_TAB);
  const idIdx = header.indexOf('reply_event_id');
  if (idIdx < 0) throw new Error('REPLY_EVENTS has no reply_event_id column; refusing to update.');

  const rowIndex = rows.findIndex((row) => asText(row?.[idIdx]).trim() === id);
  if (rowIndex < 0) {
    return { dryRun: false, updated: false, skipped: 'reply_event_not_found', reply_event_id: id, patch };
  }
  // rows excludes the header, so data row 0 is sheet row 2.
  const rowNumber = rowIndex + 2;

  const writes = [];
  const missing = [];
  for (const [column, value] of Object.entries(patch)) {
    const colIdx = header.indexOf(column);
    if (colIdx < 0) { missing.push(column); continue; }
    writes.push({ tab: REPLY_EVENTS_TAB, rowNumber, columnNumber: colIdx + 1, value });
  }
  if (missing.length) {
    throw new Error(`REPLY_EVENTS is missing derived columns: ${missing.join(', ')}`);
  }

  await repo.writeCellsBatch(writes);
  return {
    dryRun: false,
    updated: true,
    skipped: null,
    reply_event_id: id,
    row_number: rowNumber,
    patch,
    cells_written: writes.length,
  };
}

// ---------------------------------------------------------------------------
// EXECUTION-FIELD UPDATE, on the SAME already-persisted REPLY_EVENTS row.
//
// The classification updater above records what a reply MEANS. This records
// what NOVUS DID about it. They are kept separate so neither can widen into the
// other's columns, and both are strictly narrower than the row.
//
// EXECUTION_FIELDS is a subset of the columns already outside
// RAW_EVIDENCE_FIELDS, so this path — like the classification path — cannot
// reach body_text, cleaned_reply_text, lead_email, thread_id, received_at,
// instantly_email_id, agency_id or outreach_id. Cells are written
// INDIVIDUALLY; the row is never rewritten, and nothing is ever appended.
//
// classification/confidence/suppression_type/next_action/priority are NOT here:
// executing an action does not reclassify the reply. next_action stays
// SEND_DEMO after a completed send — action_status carries the outcome.
// ---------------------------------------------------------------------------
export const EXECUTION_FIELDS = [
  'action_status',
  'action_completed_at',
  'error',
  'notes',
];

export async function updateReplyEventExecution(replyEventId, patch, {
  repo = null,
  dryRun = DEFAULT_DRY_RUN,
} = {}) {
  const id = asText(replyEventId).trim();
  if (!id) throw new Error('updateReplyEventExecution requires a reply_event_id');

  const illegal = Object.keys(patch || {}).filter((k) => !EXECUTION_FIELDS.includes(k));
  if (illegal.length) {
    throw new Error(`refusing to update non-execution REPLY_EVENTS fields: ${illegal.join(', ')}`);
  }

  if (dryRun) return { dryRun: true, updated: false, skipped: 'dry_run', reply_event_id: id, patch };
  if (!repo) throw new Error('updateReplyEventExecution requires a repo when dryRun is false');

  const { header, rows } = await repo.getTable(REPLY_EVENTS_TAB);
  const idIdx = header.indexOf('reply_event_id');
  if (idIdx < 0) throw new Error('REPLY_EVENTS has no reply_event_id column; refusing to update.');

  const rowIndex = rows.findIndex((row) => asText(row?.[idIdx]).trim() === id);
  if (rowIndex < 0) {
    return { dryRun: false, updated: false, skipped: 'reply_event_not_found', reply_event_id: id, patch };
  }
  const rowNumber = rowIndex + 2;

  const writes = [];
  const missing = [];
  for (const [column, value] of Object.entries(patch)) {
    const colIdx = header.indexOf(column);
    if (colIdx < 0) { missing.push(column); continue; }
    writes.push({ tab: REPLY_EVENTS_TAB, rowNumber, columnNumber: colIdx + 1, value });
  }
  if (missing.length) {
    throw new Error(`REPLY_EVENTS is missing execution columns: ${missing.join(', ')}`);
  }

  await repo.writeCellsBatch(writes);
  return {
    dryRun: false, updated: true, skipped: null,
    reply_event_id: id, row_number: rowNumber, patch, cells_written: writes.length,
  };
}
