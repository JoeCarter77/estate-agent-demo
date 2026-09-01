// lib/reply-send-demo.mjs — the POSITIVE_SEND_DEMO execution path.
//
// CLASSIFICATION IS BROAD. EXECUTION IS STRICT.
// lib/reply-classification.mjs decides what a reply MEANS. This file decides
// whether NOVUS may act on that meaning without a human, and it is deliberately
// far narrower: a reply can be a perfectly good POSITIVE_SEND_DEMO and still be
// refused here. Anything refused is left for MANUAL_REVIEW with a recorded
// blocked_reason. Nothing in this file changes a classifier threshold.
//
// THIS FILE IMPLEMENTS ONE ACTION ONLY: SEND_DEMO. POSITIVE_MEETING, QUESTION,
// NOT_NOW, NOT_INTERESTED, OPT_OUT and OOO are not executed here at all.
//
// TWO MODES. dryRun:true (the default) evaluates the gate and returns what it
// WOULD send. It performs Google Sheets READS and ONE Instantly GET (the thread
// sweep) and nothing else — no Instantly write, no send, no REPLY_EVENTS write,
// no OUTBOUND write. The live mode is not built yet; sendDemoReply() below is
// the payload/transport boundary and is currently only exercised with an
// injected fetch by the self-test.

import {
  normalizeInstantlyEmail,
  ROUTING_TABLE,
  REPLY_EVENTS_TAB,
  updateReplyEventExecution,
} from './reply-router.mjs';
import { fetchThreadContextEmails } from './reply-thread-context.mjs';

export const OUTBOUND_TAB = 'OUTBOUND';

// The execution confidence bar. HIGHER than the classifier's 0.85 acceptance
// threshold on purpose: 0.85–0.89 is a reply the classifier was willing to
// label but not certain enough for NOVUS to answer unattended.
export const SEND_DEMO_CONFIDENCE_THRESHOLD = 0.90;

// The one classification this file will ever execute.
export const EXECUTABLE_CLASSIFICATION = 'POSITIVE_SEND_DEMO';

// action_status values from which a SEND_DEMO may still be attempted. COMPLETED
// and NO_ACTION are terminal; REVIEW belongs to a human.
export const RETRYABLE_ACTION_STATUSES = ['PENDING', 'FAILED'];

// The explicit deliberate-action token the live HTTP operation requires, in the
// same spirit as INSTANTLY_LIVE_CONFIRMATION on the outbound handoff. Auth
// proves WHO is calling; this proves the call was MEANT.
export const SEND_DEMO_LIVE_CONFIRMATION = 'SEND_ONE_DEMO_REPLY';

// The idempotency stamp written into REPLY_EVENTS.notes after a successful
// send. notes is outside RAW_EVIDENCE_FIELDS, so using it destroys no evidence
// and needs no new column.
export const SEND_DEMO_NOTE_PREFIX = 'SEND_DEMO sent';
const SEND_DEMO_NOTE_PATTERN = /SEND_DEMO sent\b/;

// REPLY_EVENTS.error is shared by two very different writers: the classifier
// (an interpretation failure) and this file (a send failure). They must not be
// confused. A CLASSIFIER error means the row's verdict cannot be trusted, so it
// blocks. A SEND error means a previous ATTEMPT failed, which is precisely the
// state a retry exists for — blocking on it would make FAILED terminal and
// leave every transient Instantly failure permanently stuck.
//
// The two are told apart by the prefixes this file writes, and nothing else
// writes them.
const SEND_EXECUTION_ERROR_PATTERN = /^(INSTANTLY_\d{3}|AMBIGUOUS_SEND_RESULT)\b/;

export function isSendExecutionError(value) {
  return SEND_EXECUTION_ERROR_PATTERN.test(trimmed(value));
}

export const BLOCKED_REASONS = [
  'REPLY_EVENT_NOT_FOUND',
  'CLASSIFIER_ERROR',
  'NOT_POSITIVE_SEND_DEMO',
  'ROUTING_MISMATCH',
  'CONFIDENCE_MISSING',
  'CONFIDENCE_BELOW_THRESHOLD',
  'AUTO_REPLY',
  'MISSING_INSTANTLY_EMAIL_ID',
  'MISSING_THREAD_ID',
  'REPLY_NOT_FOUND',
  'REPLY_NOT_CONFIRMED_INBOUND',
  'THREAD_ID_MISMATCH',
  'MISSING_EACCOUNT',
  'OUTBOUND_MATCH_MISSING',
  'OUTBOUND_MATCH_AMBIGUOUS',
  'OUTBOUND_LEAD_EMAIL_MISMATCH',
  'MISSING_DEMO_URL',
  'INVALID_DEMO_URL',
  'THREAD_EVIDENCE_UNAVAILABLE',
  'DEMO_ALREADY_SENT',
  'ALREADY_EXECUTED',
  'ACTION_STATUS_NOT_RETRYABLE',
];

function asText(value) { return value === undefined || value === null ? '' : String(value); }
function trimmed(value) { return asText(value).trim(); }
function lower(value) { return trimmed(value).toLowerCase(); }

// ---------------------------------------------------------------------------
// THE REPLY COPY. Fixed, minimal, and NOT generated.
//
// No extra CTA, no reselling, no meeting ask, no model-written prose. The only
// variable is the demo URL. A property reference is DEFERRED: OUTBOUND carries
// property_street, but inserting it changes agreed copy for no gate-relevant
// reason, and an unsafe reference is worse than none.
// ---------------------------------------------------------------------------
export const DEMO_REPLY_TEMPLATE_LINES = [
  'Absolutely — here it is:',
  '',
  '{{demo_url}}',
  '',
  'I’ve based it on what happened after the enquiry we sent through.',
  '',
  'Joe',
];

function escapeHtml(value) {
  return asText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Returns { text, html }. The docs note line breaks must be <br/> in html, so
// both representations are built from the SAME line list — they cannot drift.
export function buildDemoReplyBody(demoUrl) {
  const url = trimmed(demoUrl);
  if (!url) throw new Error('buildDemoReplyBody requires a demo_url');
  const lines = DEMO_REPLY_TEMPLATE_LINES.map((line) => line.replace('{{demo_url}}', url));
  return {
    text: lines.join('\n'),
    html: lines.map((line) => escapeHtml(line)).join('<br/>'),
  };
}

// "Re: X" once, never "Re: Re: X". A blank subject still yields a valid one.
export function buildReplySubject(originalSubject) {
  const subject = trimmed(originalSubject);
  if (!subject) return 'Re:';
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

// A demo URL must be an absolute https URL. Anything else is refused rather
// than sent to a prospect.
export function isValidDemoUrl(value) {
  const url = trimmed(value);
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

export function hasSendDemoMarker(notes) {
  return SEND_DEMO_NOTE_PATTERN.test(asText(notes));
}

// The stamp appended to notes on success. Existing notes are preserved.
export function buildSendDemoNote(existingNotes, { instantlyEmailId, threadId, at }) {
  const stamp = `${SEND_DEMO_NOTE_PREFIX} instantly_email_id=${trimmed(instantlyEmailId) || '(none)'}`
    + ` thread_id=${trimmed(threadId) || '(none)'} at=${trimmed(at)}`;
  const existing = trimmed(existingNotes);
  return existing ? `${existing} | ${stamp}` : stamp;
}

// ---------------------------------------------------------------------------
// OUTBOUND resolution — STRICTER than the poller's match.
//
// TWO independent lookups must agree on ONE row:
//   1. OUTBOUND.outbound_id === REPLY_EVENTS.outreach_id  (what was recorded)
//   2. OUTBOUND.outreach_contact_email === REPLY_EVENTS.lead_email (who replied)
// Either yielding zero, more than one, or a DIFFERENT row blocks execution.
// The poller already recorded a match; this re-derives it at execution time so
// an OUTBOUND row edited, duplicated or re-keyed since then cannot be sent
// against silently.
// ---------------------------------------------------------------------------
export function resolveOutboundForSend(outboundRecords, { outreachId, leadEmail }) {
  const records = outboundRecords || [];
  const idKey = trimmed(outreachId);
  const emailKey = lower(leadEmail);

  if (!idKey) return { status: 'MISSING', reason: 'OUTBOUND_MATCH_MISSING', row: null, candidates: [] };

  const byId = records.filter((r) => trimmed(r?.obj?.outbound_id) === idKey);
  if (byId.length === 0) return { status: 'MISSING', reason: 'OUTBOUND_MATCH_MISSING', row: null, candidates: [] };
  if (byId.length > 1) {
    return {
      status: 'AMBIGUOUS',
      reason: 'OUTBOUND_MATCH_AMBIGUOUS',
      row: null,
      candidates: byId.map((r) => r.obj.outbound_id),
    };
  }

  const byEmail = records.filter((r) => lower(r?.obj?.outreach_contact_email) === emailKey && emailKey);
  if (byEmail.length !== 1) {
    return {
      status: byEmail.length === 0 ? 'MISSING' : 'AMBIGUOUS',
      reason: byEmail.length === 0 ? 'OUTBOUND_MATCH_MISSING' : 'OUTBOUND_MATCH_AMBIGUOUS',
      row: null,
      candidates: byEmail.map((r) => r.obj.outbound_id),
    };
  }
  if (trimmed(byEmail[0].obj.outbound_id) !== idKey) {
    return { status: 'MISMATCH', reason: 'OUTBOUND_LEAD_EMAIL_MISMATCH', row: null, candidates: [byEmail[0].obj.outbound_id, idKey] };
  }

  return { status: 'MATCHED', reason: null, row: byId[0].obj, candidates: [] };
}

// ---------------------------------------------------------------------------
// DEMO-ALREADY-SENT, from THREAD EVIDENCE ONLY.
//
// OUTBOUND.outbound_status is NEVER consulted: SENT means the OUTREACH was
// sent, and demo_url means a demo was BUILT — neither says the link reached
// this prospect. The only acceptable evidence is a NOVUS (OUTBOUND-direction)
// message in this very thread whose body carries the demo URL or slug.
//
// Returns 'SENT' | 'NOT_SENT' | 'UNKNOWN'. UNKNOWN BLOCKS: for a send, "we
// could not check" must never behave like "it has not been sent".
// ---------------------------------------------------------------------------
export function demoSentEvidence(threadMessages, { demoUrl, demoSlug } = {}) {
  const needles = [trimmed(demoUrl), trimmed(demoSlug)].filter(Boolean).map((n) => n.toLowerCase());
  if (!needles.length) return 'UNKNOWN';

  const messages = Array.isArray(threadMessages) ? threadMessages : null;
  if (!messages || !messages.length) return 'UNKNOWN';

  const novus = messages.filter((m) => m?.direction === 'OUTBOUND');
  // No NOVUS message at all on this thread means the sweep did not see our side
  // of the conversation — we cannot assert absence from that.
  if (!novus.length) return 'UNKNOWN';

  // ORDER IS NOT CONSIDERED, on purpose. Any NOVUS message on this thread
  // carrying the link is disqualifying: we cannot have sent it "after" a reply
  // we have not answered yet, so a hit is always a prior send.
  const hit = novus.some((m) => {
    const body = `${asText(m.raw_body_text)}`.toLowerCase();
    return needles.some((n) => body.includes(n));
  });
  return hit ? 'SENT' : 'NOT_SENT';
}

// ---------------------------------------------------------------------------
// THE GATE. Pure: no I/O, no clock, no writes. Every input is supplied.
//
// Returns { eligible, blocked_reason, blocked_reasons, demo_url, thread_id,
//           reply_body, would_send, ... }.
// blocked_reason is the FIRST failure in contract order; blocked_reasons lists
// every failure found, so one dry run shows a human everything that is wrong.
// ---------------------------------------------------------------------------
export function evaluateSendDemoGate({
  row,
  reply = null,
  outboundRecords = [],
  threadMessages = null,
} = {}) {
  const reasons = [];
  const add = (reason) => { if (!reasons.includes(reason)) reasons.push(reason); };

  if (!row || typeof row !== 'object') {
    return {
      eligible: false,
      blocked_reason: 'REPLY_EVENT_NOT_FOUND',
      blocked_reasons: ['REPLY_EVENT_NOT_FOUND'],
      demo_url: '', thread_id: '', reply_body: null, would_send: false,
    };
  }

  // --- classification and routing -----------------------------------------
  // A previous SEND failure does not block a retry; a CLASSIFIER failure does.
  if (trimmed(row.error) && !isSendExecutionError(row.error)) add('CLASSIFIER_ERROR');
  if (trimmed(row.classification) !== EXECUTABLE_CLASSIFICATION) add('NOT_POSITIVE_SEND_DEMO');
  else {
    // Routing consistency. Classification is single-label, so a competing
    // QUESTION/MEETING intent can never coexist with POSITIVE_SEND_DEMO; what
    // CAN happen is a row whose routing fields no longer agree with the table
    // (a hand edit, a partial update). That is refused rather than reconciled.
    const route = ROUTING_TABLE[EXECUTABLE_CLASSIFICATION];
    if (trimmed(row.next_action) !== route.next_action) add('ROUTING_MISMATCH');
    if (trimmed(row.suppression_type) !== route.suppression_type) add('ROUTING_MISMATCH');
  }

  const confidenceRaw = trimmed(row.confidence);
  const confidence = confidenceRaw === '' ? null : Number(confidenceRaw);
  if (confidence === null || !Number.isFinite(confidence)) add('CONFIDENCE_MISSING');
  else if (confidence < SEND_DEMO_CONFIDENCE_THRESHOLD) add('CONFIDENCE_BELOW_THRESHOLD');

  if (trimmed(row.is_auto_reply).toUpperCase() === 'TRUE') add('AUTO_REPLY');

  // --- identifiers ---------------------------------------------------------
  const instantlyEmailId = trimmed(row.instantly_email_id);
  const threadId = trimmed(row.thread_id);
  if (!instantlyEmailId) add('MISSING_INSTANTLY_EMAIL_ID');
  if (!threadId) add('MISSING_THREAD_ID');

  // --- the live reply object, re-verified at execution time ----------------
  // The poller confirmed INBOUND when the row was created. This confirms it
  // AGAIN, from Instantly, immediately before a send: reply_to_uuid must point
  // at a genuine received prospect email, never at our own sent copy.
  let eaccount = '';
  if (!reply) add('REPLY_NOT_FOUND');
  else {
    if (reply.direction !== 'INBOUND') add('REPLY_NOT_CONFIRMED_INBOUND');
    if (threadId && trimmed(reply.thread_id) !== threadId) add('THREAD_ID_MISMATCH');
    eaccount = trimmed(reply.eaccount);
    if (!eaccount) add('MISSING_EACCOUNT');
  }

  // --- OUTBOUND ------------------------------------------------------------
  const outbound = resolveOutboundForSend(outboundRecords, {
    outreachId: row.outreach_id,
    leadEmail: row.lead_email,
  });
  if (outbound.reason) add(outbound.reason);

  const demoUrl = trimmed(outbound.row?.demo_url);
  const demoSlug = trimmed(outbound.row?.demo_slug);
  if (outbound.status === 'MATCHED') {
    if (!demoUrl) add('MISSING_DEMO_URL');
    else if (!isValidDemoUrl(demoUrl)) add('INVALID_DEMO_URL');
  }

  // --- demo-already-sent, from thread evidence -----------------------------
  const evidence = demoUrl && isValidDemoUrl(demoUrl)
    ? demoSentEvidence(threadMessages, { demoUrl, demoSlug })
    : 'UNKNOWN';
  if (evidence === 'SENT') add('DEMO_ALREADY_SENT');
  else if (evidence === 'UNKNOWN') add('THREAD_EVIDENCE_UNAVAILABLE');

  // --- per-event idempotency ----------------------------------------------
  if (hasSendDemoMarker(row.notes)) add('ALREADY_EXECUTED');
  else if (trimmed(row.action_completed_at)) add('ALREADY_EXECUTED');
  else if (!RETRYABLE_ACTION_STATUSES.includes(trimmed(row.action_status))) add('ACTION_STATUS_NOT_RETRYABLE');

  // --- verdict -------------------------------------------------------------
  const ordered = BLOCKED_REASONS.filter((r) => reasons.includes(r));
  const eligible = ordered.length === 0;

  return {
    eligible,
    blocked_reason: eligible ? null : ordered[0],
    blocked_reasons: ordered,
    reply_event_id: trimmed(row.reply_event_id),
    instantly_email_id: instantlyEmailId,
    demo_url: demoUrl,
    thread_id: threadId,
    eaccount,
    subject: buildReplySubject(row.subject),
    reply_body: eligible ? buildDemoReplyBody(demoUrl) : null,
    would_send: eligible,
    demo_sent_evidence: evidence,
    outbound_match_status: outbound.status,
    confidence: confidence === null || !Number.isFinite(confidence) ? null : confidence,
  };
}

// ---------------------------------------------------------------------------
// The Instantly reply request. BUILT HERE, SENT NOWHERE IN DRY RUN.
//
// Fields are exactly those documented for POST /api/v2/emails/reply:
//   reply_to_uuid (the id of the email being replied to), eaccount, subject,
//   body{html,text}. No optional field is guessed or invented; thread_id is
//   NOT a request field — Instantly threads the reply from reply_to_uuid.
// ---------------------------------------------------------------------------
export const INSTANTLY_REPLY_URL = 'https://api.instantly.ai/api/v2/emails/reply';

export function buildInstantlyReplyPayload({ replyToUuid, eaccount, subject, body }) {
  const uuid = trimmed(replyToUuid);
  const account = trimmed(eaccount);
  if (!uuid) throw new Error('reply_to_uuid is required');
  if (!account) throw new Error('eaccount is required');
  if (!body?.text && !body?.html) throw new Error('body.text or body.html is required');
  return {
    reply_to_uuid: uuid,
    eaccount: account,
    subject: buildReplySubject(subject),
    body: { html: body.html, text: body.text },
  };
}

// ---------------------------------------------------------------------------
// FRESH INPUT GATHERING — shared by the dry run and the live send.
//
// The dry run and the live send must never disagree about eligibility, so they
// gather inputs the same way and run the SAME gate function. This is that one
// gathering step.
//
// READS ONLY: REPLY_EVENTS (once), OUTBOUND (once), and ONE Instantly GET — the
// same bounded sweep the classifier already uses (GET /api/v2/emails?limit=100),
// not a new endpoint. That single sweep supplies both the live reply object
// (for the INBOUND re-check and the eaccount) and the thread messages (for the
// demo-already-sent evidence).
//
// EVERY value is re-read at call time. Nothing is carried over from a previous
// dry run, a previous attempt, or the poller's own pass — which is what makes
// the live path's gate a fresh decision rather than a replay of an old one.
// ---------------------------------------------------------------------------
async function gatherSendDemoInputs({ repo, replyEventId, apiKey, fetchImpl, contextLimit, mailboxes }) {
  const record = await repo.findById(REPLY_EVENTS_TAB, 'reply_event_id', replyEventId);
  if (!record) return { row: null };

  const row = record.obj;
  const outboundRecords = await repo.getRecords(OUTBOUND_TAB, 'outbound_id');

  // Any sweep failure resolves to no reply object and no thread messages, which
  // BLOCKS (REPLY_NOT_FOUND / THREAD_EVIDENCE_UNAVAILABLE) rather than sending
  // on incomplete information.
  let sweepError = null;
  let messages = [];
  try {
    const raw = await fetchThreadContextEmails({ apiKey, limit: contextLimit, fetchImpl });
    messages = (raw || []).flatMap((r) => {
      try { return [normalizeInstantlyEmail(r, { mailboxes })]; } catch { return []; }
    });
  } catch (err) {
    sweepError = err?.message || 'thread sweep failed';
  }

  const instantlyEmailId = trimmed(row.instantly_email_id);
  const threadId = trimmed(row.thread_id);

  return {
    row,
    outboundRecords,
    reply: messages.find((m) => trimmed(m.email_id) === instantlyEmailId) || null,
    threadMessages: threadId ? messages.filter((m) => trimmed(m.thread_id) === threadId) : null,
    sweepError,
  };
}

function notFoundResult(id, extra = {}) {
  return {
    reply_event_id: id,
    eligible: false,
    blocked_reason: 'REPLY_EVENT_NOT_FOUND',
    blocked_reasons: ['REPLY_EVENT_NOT_FOUND'],
    demo_url: '', thread_id: '', reply_body: null, would_send: false,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// DRY-RUN EVALUATION of one REPLY_EVENTS row.
//
// Writes NOTHING: no REPLY_EVENTS update, no OUTBOUND write, no Instantly
// write, no send. It returns the exact request the live path WOULD make.
// ---------------------------------------------------------------------------
export async function evaluateSendDemoDryRun({
  repo,
  replyEventId,
  apiKey,
  fetchImpl = globalThis.fetch,
  contextLimit,
  mailboxes,
} = {}) {
  const id = trimmed(replyEventId);
  if (!id) throw new Error('reply_event_id is required');

  const inputs = await gatherSendDemoInputs({ repo, replyEventId: id, apiKey, fetchImpl, contextLimit, mailboxes });
  if (!inputs.row) return { dry_run: true, ...notFoundResult(id) };

  const { row, reply, outboundRecords, threadMessages, sweepError } = inputs;
  const gate = evaluateSendDemoGate({ row, reply, outboundRecords, threadMessages });

  return {
    dry_run: true,
    ...gate,
    // Explicit, so a dry run can never be mistaken for a send.
    sent: false,
    instantly_request: gate.eligible
      ? {
          method: 'POST',
          url: INSTANTLY_REPLY_URL,
          payload: buildInstantlyReplyPayload({
            replyToUuid: gate.instantly_email_id,
            eaccount: gate.eaccount,
            subject: row.subject,
            body: gate.reply_body,
          }),
        }
      : null,
    thread_sweep_error: sweepError,
    thread_messages_seen: threadMessages ? threadMessages.length : 0,
    action_status: trimmed(row.action_status),
    classification: trimmed(row.classification),
  };
}

// ---------------------------------------------------------------------------
// THE SEND. One POST to Instantly, and the classification of its outcome.
//
// THREE OUTCOMES, and the distinction is the whole safety model:
//
//   SENT      — a 2xx. The message left Instantly. Definitive.
//   REJECTED  — a 4xx. Instantly refused the request BEFORE sending: bad uuid,
//               unknown eaccount (404), missing scope (401/403), no active paid
//               plan (402), rate limited (429). Nothing was sent, so a later
//               retry cannot duplicate anything.
//   AMBIGUOUS — a 5xx, a transport error, or a timeout. The request may or may
//               not have been processed. NEVER retried blindly; see
//               AMBIGUOUS_SEND_RESULT handling in executeSendDemo below.
//
// The API key is never echoed into the returned value or into any error.
// ---------------------------------------------------------------------------
export const SEND_TIMEOUT_MS = 30000;
export const AMBIGUOUS_ERROR = 'AMBIGUOUS_SEND_RESULT';

function safeDetail(value, max = 300) {
  return trimmed(value).replace(/\s+/g, ' ').slice(0, max);
}

export async function sendDemoReply({
  apiKey,
  payload,
  fetchImpl = globalThis.fetch,
  timeoutMs = SEND_TIMEOUT_MS,
} = {}) {
  if (!apiKey) throw new Error('INSTANTLY_REPLY_API_KEY is not set in this environment.');

  // A hung request is AMBIGUOUS, not a hang. AbortController bounds it so the
  // outcome is classified rather than left to the platform's own timeout.
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let response;
  try {
    response = await fetchImpl(INSTANTLY_REPLY_URL, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch (err) {
    // Transport failure or abort. The request may have reached Instantly.
    return {
      outcome: 'AMBIGUOUS',
      status: null,
      error: `${AMBIGUOUS_ERROR}: transport ${safeDetail(err?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : err?.message)}`,
      response: null,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }

  let text = '';
  try { text = await response.text(); } catch { text = ''; }
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }

  if (response.ok) {
    return {
      outcome: 'SENT',
      status: response.status,
      error: null,
      // Identifiers are recorded WHERE AVAILABLE. A 2xx with an unparseable
      // body is still a send, and must never be downgraded to a failure.
      response: {
        id: trimmed(body?.id),
        thread_id: trimmed(body?.thread_id),
        message_id: trimmed(body?.message_id),
      },
    };
  }

  const detail = safeDetail(body?.error || body?.message || body?.detail || text || '(empty response body)');

  // 5xx: Instantly accepted the connection and then failed. Whether the send
  // was processed before the failure is unknowable from here.
  if (response.status >= 500) {
    return {
      outcome: 'AMBIGUOUS',
      status: response.status,
      error: `${AMBIGUOUS_ERROR}: instantly_status=${response.status} ${detail}`,
      response: null,
    };
  }

  return {
    outcome: 'REJECTED',
    status: response.status,
    error: `INSTANTLY_${response.status}: ${detail}`,
    response: null,
  };
}

// ---------------------------------------------------------------------------
// LIVE EXECUTION of one REPLY_EVENTS row. THE ONLY PATH THAT SENDS.
//
// FLOW, in order, with no step skippable:
//   1. Freshly load the REPLY_EVENTS row.
//   2. Freshly sweep Instantly for the reply object and the thread evidence.
//   3. Freshly resolve the OUTBOUND row.
//   4. Run the SAME gate the dry run runs — the identical function, not a copy.
//   5. Blocked -> send nothing, return blocked_reason, write nothing.
//   6. Eligible -> ONE POST /api/v2/emails/reply, then record the outcome on
//      the SAME row through the whitelisted execution-field updater.
//
// IT NEVER WRITES OUTBOUND, never changes outbound_status, never applies
// suppression, never reclassifies, and never touches a raw evidence field —
// updateReplyEventExecution structurally cannot reach them.
// ---------------------------------------------------------------------------
export async function executeSendDemo({
  repo,
  replyEventId,
  apiKey,
  fetchImpl = globalThis.fetch,
  now = new Date().toISOString(),
  timeoutMs = SEND_TIMEOUT_MS,
  contextLimit,
  mailboxes,
} = {}) {
  const id = trimmed(replyEventId);
  if (!id) throw new Error('reply_event_id is required');

  const inputs = await gatherSendDemoInputs({ repo, replyEventId: id, apiKey, fetchImpl, contextLimit, mailboxes });
  if (!inputs.row) return { dry_run: false, sent: false, ...notFoundResult(id) };

  const { row, reply, outboundRecords, threadMessages, sweepError } = inputs;
  const gate = evaluateSendDemoGate({ row, reply, outboundRecords, threadMessages });

  const base = {
    dry_run: false,
    ...gate,
    thread_sweep_error: sweepError,
    thread_messages_seen: threadMessages ? threadMessages.length : 0,
    classification: trimmed(row.classification),
  };

  // BLOCKED. Nothing is sent and nothing is written — a blocked event is not a
  // failed event, and must not have its action_status rewritten by an attempt
  // that never happened.
  if (!gate.eligible) {
    return { ...base, sent: false, instantly_status: null, row_update: null };
  }

  const payload = buildInstantlyReplyPayload({
    replyToUuid: gate.instantly_email_id,
    eaccount: gate.eaccount,
    subject: row.subject,
    body: gate.reply_body,
  });

  const result = await sendDemoReply({ apiKey, payload, fetchImpl, timeoutMs });

  // The outcome is recorded on the SAME row, through the execution-field
  // whitelist. A COMPLETED stamp is written ONLY for an unambiguous 2xx.
  const patch = result.outcome === 'SENT'
    ? {
        action_status: 'COMPLETED',
        action_completed_at: now,
        // The previous attempt's error is cleared: it no longer describes the
        // state of this event.
        error: '',
        notes: buildSendDemoNote(row.notes, {
          instantlyEmailId: result.response?.id || gate.instantly_email_id,
          threadId: result.response?.thread_id || gate.thread_id,
          at: now,
        }),
      }
    : {
        action_status: 'FAILED',
        // NOT completed, and no marker written — a retry stays possible, and
        // the gate (not this line) decides whether it is allowed.
        error: result.error,
      };

  // A failed sheet write after a SUCCESSFUL send is the one case that leaves
  // the row behind reality. It is recorded and returned, and it is SAFE: the
  // demo link is now in a NOVUS message on that thread, so the next attempt
  // blocks on DEMO_ALREADY_SENT rather than sending twice.
  let rowUpdate = null;
  let rowUpdateError = null;
  try {
    rowUpdate = await updateReplyEventExecution(id, patch, { repo, dryRun: false });
  } catch (err) {
    rowUpdateError = safeDetail(err?.message || 'REPLY_EVENTS execution update failed');
  }

  return {
    ...base,
    sent: result.outcome === 'SENT',
    send_outcome: result.outcome,
    instantly_status: result.status,
    instantly_response: result.response,
    error: result.error,
    action_status: patch.action_status,
    action_completed_at: patch.action_completed_at || '',
    row_update: rowUpdate,
    row_update_error: rowUpdateError,
  };
}
