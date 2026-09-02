// lib/instantly-reply-send.mjs — the GENERIC Instantly reply transport.
//
// WHY THIS FILE EXISTS. lib/reply-send-demo.mjs was the only thing in NOVUS
// that could reply to a prospect, so the transport (build the payload, POST it,
// classify the outcome) grew inside the SEND_DEMO policy that used it. A second
// caller is now coming — Joe's own manual replies — and a manual reply MUST go
// out over the exact same wire as an automatic one. Forking the transport would
// mean two POST paths that could drift in timeout, header, payload shape or
// outcome classification, and a divergence there is invisible until a prospect
// receives something wrong.
//
// So the transport moved DOWN here and reply-send-demo.mjs re-exports it. That
// file's public surface is unchanged and its behaviour is unchanged; it simply
// no longer owns the wire.
//
// WHAT IS GENERIC AND WHAT IS NOT. This file knows how to talk to
// POST /api/v2/emails/reply and nothing else. It holds NO policy: no gate, no
// confidence threshold, no classification, no idempotency marker, no claim, no
// persistence, and no opinion about whether a send SHOULD happen. Those live
// with the caller that has the policy — SEND_DEMO's gate stays in
// reply-send-demo.mjs, the manual-reply gate lives in lib/manual-reply.mjs.
//
// resolveOutboundForSend is here for the same reason: "which OUTBOUND row is
// this conversation" is a question every sender asks, and both senders must
// answer it identically strictly.
//
// THIS FILE NEVER DECIDES TO SEND. sendInstantlyReply() POSTs whatever payload
// it is handed. Every caller is responsible for having passed its own gate
// first.

// ---------------------------------------------------------------------------
// Text helpers. Shared so the two senders cannot disagree about what "blank"
// means or how a value is coerced.
// ---------------------------------------------------------------------------
export function asText(value) { return value === undefined || value === null ? '' : String(value); }
export function trimmed(value) { return asText(value).trim(); }
export function lower(value) { return trimmed(value).toLowerCase(); }

// Truncated, whitespace-collapsed detail for an error string. Bounded so a
// provider error body can never balloon a stored cell or a response.
export function safeDetail(value, max = 300) {
  return trimmed(value).replace(/\s+/g, ' ').slice(0, max);
}

// The four characters that can break out of an HTML body. Deliberately NOT a
// markdown or rich-text renderer: whatever a human typed is delivered as that
// text and nothing else.
export function escapeHtml(value) {
  return asText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// "Re: X" once, never "Re: Re: X". A blank subject still yields a valid one.
export function buildReplySubject(originalSubject) {
  const subject = trimmed(originalSubject);
  if (!subject) return 'Re:';
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

// ---------------------------------------------------------------------------
// SEND-ERROR RECOGNITION.
//
// REPLY_EVENTS.error is shared by two very different writers: the classifier
// (an interpretation failure) and a send path (a send failure). They must not
// be confused. A CLASSIFIER error means the row's verdict cannot be trusted. A
// SEND error means a previous ATTEMPT failed, which is precisely the state a
// retry exists for.
//
// The two are told apart by the prefixes THIS file's outcome classification
// writes, and nothing else writes them — which is why the recogniser lives
// beside the code that produces the strings.
// ---------------------------------------------------------------------------
const SEND_EXECUTION_ERROR_PATTERN = /^(INSTANTLY_\d{3}|AMBIGUOUS_SEND_RESULT)\b/;

export function isSendExecutionError(value) {
  return SEND_EXECUTION_ERROR_PATTERN.test(trimmed(value));
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
//               not have been processed. NEVER retried blindly.
//
// The API key is never echoed into the returned value or into any error.
// ---------------------------------------------------------------------------
export const SEND_TIMEOUT_MS = 30000;
export const AMBIGUOUS_ERROR = 'AMBIGUOUS_SEND_RESULT';

export async function sendInstantlyReply({
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
