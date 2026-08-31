// lib/reply-router.mjs — NOVUS Instantly reply router (skeleton, read-only).
//
// PIPELINE THIS FILE SERVES:
//   REPLY DETECTED -> deterministic prospect/outreach match -> persist raw
//   reply event -> classify -> update NOVUS acquisition state -> route next
//   action.
//
// This file currently implements only the DETERMINISTIC decision step plus a
// non-destructive REPLY_EVENTS row builder. Matching, classification and state
// updates are deliberately NOT here yet — see the deferral notes below.
//
// WHAT THIS FILE MUST NEVER DO — and why:
//
// 1. NO "stop outreach" action for human replies. Instantly automatically
//    stops a lead's campaign sequence when a genuine reply arrives. Instantly
//    remains the outbound EXECUTION layer and owns that stop. A NOVUS stop
//    call would be redundant, so `next_action` has no STOP value at all.
//
// 2. NOVUS still keeps its OWN suppression state, but only for explicit
//    OPT_OUT. That is not a duplicate of Instantly's sequence stop: it exists
//    so a prospect cannot be re-entered into a FUTURE NOVUS campaign after
//    Instantly is changed, recreated or re-imported. It is expressed as
//    suppression_type=PERMANENT here, and is eventually applied as
//    OUTBOUND.outbound_status='SUPPRESSED' — already a valid value in
//    lib/outbound.mjs's OUTBOUND_STATUSES, so no schema change is needed.
//    Applying it is NOT implemented in this file.
//
// 3. NO Instantly writes, no sends, and (in DRY_RUN, the default) no Google
//    Sheets access whatsoever.
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
// poller must look this up in REPLY_EVENTS before doing anything else. See
// findExistingReplyEvent below.
export const REPLY_EVENTS_IDEMPOTENCY_COLUMN = 'instantly_email_id';

// REPLY_EVENTS.outreach_id references OUTBOUND.outbound_id. OUTBOUND has no
// column literally named outreach_id; outbound_id is its stable opaque key
// (its business key is agency_id + probe_id). Populating it requires the
// deterministic match step, which is not implemented yet.
export const OUTREACH_ID_SOURCE_COLUMN = 'outbound_id';

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

// The eventual routing table, recorded now so the intended mapping lives in one
// place. Only the three deterministic classifications below are ever PRODUCED
// by routeReply() today; the rest are reached only once a classifier exists.
//
// POSITIVE_MEETING is listed as HUMAN_REPLY because the HUMAN_REPLY /
// BOOK_MEETING choice for that case is not settled yet — a human confirming
// the slot is the safer default until booking is actually wired.
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
// Normalised reply input.
//
// PROVISIONAL: the exact Instantly field names are NOT finalised. We are
// waiting on one real controlled Instantly reply object before committing to a
// mapping, so every read below is a fallback chain and nothing assumes a field
// exists. Treat the candidate lists as a guess to be corrected, not a contract.
// The normalised SHAPE is the stable part; the mapping is not.
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

function bodyText(raw) {
  const body = pickField(raw, 'body', 'content', 'message');
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object') {
    const nested = pickField(body, 'text', 'plain', 'html');
    if (typeof nested === 'string') return nested;
  }
  return asText(pickField(raw, 'body_text', 'text', 'content_preview', 'snippet', 'preview') ?? '');
}

// Instantly may express "this is an automated reply" as a boolean, a 0/1, or a
// string. Anything not recognisably truthy is false: defaulting an unknown to
// "automated" would silently drop a real human reply into NONE/no-action.
function autoReplyFlag(raw) {
  const value = pickField(raw, 'is_auto_reply', 'auto_reply', 'ai_interest_status_auto_reply');
  if (value === true || value === 1) return true;
  if (typeof value === 'string') return ['true', '1', 'yes'].includes(value.trim().toLowerCase());
  return false;
}

export function normalizeReplyEmail(raw) {
  return {
    email_id: pickField(raw, 'id', 'email_id', '_id'),
    lead_email: pickField(raw, 'lead', 'lead_email', 'from_address_email', 'from_address', 'from', 'email'),
    subject: asText(pickField(raw, 'subject') ?? ''),
    body_text: bodyText(raw),
    is_auto_reply: autoReplyFlag(raw),
    campaign_id: pickField(raw, 'campaign_id', 'campaign', 'campaignId'),
    thread_id: pickField(raw, 'thread_id', 'threadId'),
    timestamp: pickField(raw, 'timestamp', 'timestamp_created', 'timestamp_email', 'created_at', 'date'),
  };
}

// ---------------------------------------------------------------------------
// Deterministic routing.
// ---------------------------------------------------------------------------

// Opt-out phrases are matched on normalised text: lowercased, curly apostrophes
// folded to straight ones, whitespace collapsed. Phrases (not bare words like
// "stop" or "remove") keep the false-positive rate low.
//
// KNOWN LIMITATION, deliberately accepted for now: the word "unsubscribe" can
// appear in a quoted footer beneath an otherwise positive reply, which would
// misfile it as OPT_OUT. Erring toward suppression is the safe direction, and
// quoted-text stripping needs a real reply object to design against.
const OPT_OUT_PATTERNS = [
  'unsubscribe',
  'remove me',
  'remove my details',
  'do not contact me',
  "don't contact me",
  'stop emailing me',
  "don't email me again",
];

export function normalizeTextForMatching(value) {
  return asText(value)
    .replace(/[‘’ʼ]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectOptOut(reply) {
  const haystack = `${normalizeTextForMatching(reply?.subject)} ${normalizeTextForMatching(reply?.body_text)}`;
  return OPT_OUT_PATTERNS.find((phrase) => haystack.includes(phrase)) || null;
}

function decision(classification, reason) {
  const route = ROUTING_TABLE[classification];
  return {
    classification,
    suppression_type: route.suppression_type,
    next_action: route.next_action,
    priority: route.priority,
    reason,
  };
}

// routeReply — pure, synchronous, no I/O, no AI.
//
// RULE ORDER IS PART OF THE CONTRACT:
//   1. is_auto_reply === true  -> OOO_AUTOMATED. An out-of-office is not a
//      human intent signal, so it must never reach opt-out matching (an OOO
//      body quoting our footer would otherwise suppress a live prospect).
//   2. Explicit opt-out language -> OPT_OUT + PERMANENT NOVUS suppression.
//      This runs BEFORE any AI classification, always, so a compliance-critical
//      signal never depends on a model call.
//   3. Everything else -> OTHER_UNCLEAR / MANUAL_REVIEW / HIGH. Semantic
//      classification is NOT wired: lib/classification.mjs's
//      classifyCommunication() is for estate-agent responses to a NOVUS probe,
//      a different domain with a different enum, so reusing it here would be
//      neither safe nor isolated. A human sees these until a real classifier
//      exists — nothing is silently auto-actioned.
export function routeReply(reply) {
  if (reply?.is_auto_reply === true) {
    return decision('OOO_AUTOMATED', 'is_auto_reply flag set by Instantly');
  }

  const phrase = detectOptOut(reply);
  if (phrase) {
    return decision('OPT_OUT', `deterministic opt-out phrase matched: "${phrase}"`);
  }

  return decision('OTHER_UNCLEAR', 'no deterministic rule matched; awaiting classification');
}

// ---------------------------------------------------------------------------
// REPLY_EVENTS row construction and (disabled) persistence.
// ---------------------------------------------------------------------------

// action_status reflects what still has to happen to THIS event:
//   NONE          -> NO_ACTION (OOO, and OPT_OUT once suppression is applied)
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
// agency_id and outreach_id come from the deterministic match step, which is
// not built yet — until it is, callers pass nothing and both stay blank rather
// than being guessed. NOVUS's matching rule forbids guessing an agency id.
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
    body_text: asText(reply?.body_text ?? ''),
    is_auto_reply: reply?.is_auto_reply === true ? 'TRUE' : 'FALSE',
    classification: decisionObj.classification,
    // Deterministic rules are certain by construction; a model score belongs
    // here only once a model actually runs.
    confidence: decisionObj.classification === 'OTHER_UNCLEAR' ? '' : '1',
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

export const DEFAULT_DRY_RUN = true;

// persistReplyEvent — DRY-RUN BY DEFAULT, and non-destructive until we have
// inspected a real Instantly inbound object.
//
// dryRun (the default) touches NOTHING: no repo call at all, so no Sheets read
// and no Sheets write. It returns the proposed row for logging/inspection.
//
// The live branch requires BOTH an explicit dryRun:false AND a repo, and even
// then it only ever APPENDS after the instantly_email_id idempotency check —
// it never updates or overwrites an existing row, because a later email on the
// same thread is a new event, not a revision of an old one. It is not called
// from anywhere in the codebase yet.
export async function persistReplyEvent(row, { repo = null, dryRun = DEFAULT_DRY_RUN } = {}) {
  if (dryRun) {
    return { dryRun: true, persisted: false, skipped: 'dry_run', row };
  }
  if (!repo) throw new Error('persistReplyEvent requires a repo when dryRun is false');

  const existing = await findExistingReplyEvent(repo, row.instantly_email_id);
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
export async function processReplyEmail(rawEmail, options = {}) {
  const reply = normalizeReplyEmail(rawEmail);
  const decisionObj = routeReply(reply);
  const row = buildReplyEventRow(reply, decisionObj, options);
  const persistence = await persistReplyEvent(row, options);
  return { reply, decision: decisionObj, row, persistence };
}
