// lib/reply-thread-context.mjs — MINIMAL immediate thread context for the
// semantic reply classifier.
//
// WHY THIS EXISTS. The same short reply means different things depending on
// what NOVUS said immediately before it:
//   "Want me to send the demo?"        + "yeah okay" -> POSITIVE_SEND_DEMO
//   "Open to a quick call tomorrow?"   + "yeah okay" -> POSITIVE_MEETING
//   (nothing known)                    + "yeah okay" -> OTHER_UNCLEAR
// Without the preceding message the classifier is guessing between two
// different next actions, so it must not be confident.
//
// WHAT IS RETRIEVED — deliberately small:
//   - the immediately previous NOVUS (OUTBOUND) message in the same thread
//   - the immediately previous prospect (INBOUND) message in the same thread
//   - whether a demo has demonstrably already been sent in that thread
// NOT the whole thread, not raw quoted history, not the full body.
//
// HOW IT IS RETRIEVED. GET /api/v2/emails has NO thread_id query parameter
// (confirmed against the API reference: limit, starting_after, search,
// campaign_id, list_id, i_status, eaccount, is_unread, has_reminder, mode,
// preview_only, sort_order, scheduled_only, assigned_to, lead, company_domain,
// marked_as_done, email_type, min/max_timestamp_created, latest_of_thread).
// There is only a `search=thread:<id>` prefix convention, which is not
// documented well enough to build a classifier input on.
//
// Nor can the poller's own batch supply it: that batch is email_type=received,
// so NOVUS's own sent messages are never in it.
//
// Hence ONE bounded sweep PER PASS — not per reply. /api/v2/emails is rate
// limited to 20 requests/minute, so a per-reply lookup would break a pass with
// more than a handful of replies. One sweep of the most recent messages is
// indexed by thread_id in memory and serves every reply in the pass.
//
// DEFERRED, not needed to classify correctly today: a targeted per-thread
// fallback (lead=<email>&max_timestamp_created=<reply>) for a thread older than
// the sweep window. selectThreadContext() already reports context_source, so
// the gap is visible when it happens; until then a missed thread simply yields
// blank context and a conservative classification, which is the safe direction.
//
// THIS MODULE NEVER WRITES ANYTHING. One GET, in-memory selection, nothing
// else. A failure here must never prevent REPLY_EVENTS persistence — callers
// treat every error as "no context".

import { normalizeInstantlyEmail } from './reply-router.mjs';

export const INSTANTLY_EMAILS_URL = 'https://api.instantly.ai/api/v2/emails';

// The sweep window. 100 is the API maximum for `limit`.
export const DEFAULT_CONTEXT_SWEEP_LIMIT = 100;

// Context messages are trimmed before they reach the model. The classifier
// needs the OFFER that was made, which is short and near the top; it does not
// need a signature block or a full pitch.
export const CONTEXT_EXCERPT_MAX_CHARS = 600;

// No email_type filter: the previous NOVUS message may be a campaign send
// (ue_type 1) or a manual send (ue_type 3), and Instantly exposes those as two
// different email_type values. Asking for everything and validating direction
// locally is both fewer calls and consistent with the standing rule that a
// provider-side filter is a claim, never a substitute for the address check.
export function buildContextSweepUrl({ limit = DEFAULT_CONTEXT_SWEEP_LIMIT } = {}) {
  const params = new URLSearchParams({
    limit: String(limit),
    sort_order: 'desc',
  });
  return `${INSTANTLY_EMAILS_URL}?${params.toString()}`;
}

// One GET. Never echoes the API key into any returned value or error.
export async function fetchThreadContextEmails({
  apiKey,
  limit = DEFAULT_CONTEXT_SWEEP_LIMIT,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) throw new Error('INSTANTLY_REPLY_API_KEY is not set in this environment.');

  const response = await fetchImpl(buildContextSweepUrl({ limit }), {
    method: 'GET',
    cache: 'no-store',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  const text = await response.text();

  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }

  if (!response.ok) {
    const err = new Error('Instantly API returned an error');
    err.instantly_status = response.status;
    err.instantly_error = payload?.error || payload?.message || payload?.detail
      || (text ? String(text).slice(0, 500) : '(empty response body)');
    throw err;
  }

  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    for (const key of ['items', 'data', 'emails', 'results', 'records']) {
      if (Array.isArray(payload[key])) return payload[key];
    }
  }
  return [];
}

// thread_id -> normalised messages on that thread. Direction is computed by the
// existing validated path (provider ue_type cross-checked against the address
// relationship), so a message whose direction cannot be established is present
// but will never be selected as context below.
export function buildThreadIndex(rawEmails, { mailboxes } = {}) {
  const index = new Map();
  for (const raw of rawEmails || []) {
    let message;
    try { message = normalizeInstantlyEmail(raw, { mailboxes }); } catch { continue; }
    const threadId = String(message.thread_id ?? '').trim();
    if (!threadId) continue;
    if (!index.has(threadId)) index.set(threadId, []);
    index.get(threadId).push(message);
  }
  return index;
}

function timestampMs(value) {
  const ms = new Date(String(value ?? '')).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function excerpt(text) {
  const cleaned = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= CONTEXT_EXCERPT_MAX_CHARS) return cleaned;
  return `${cleaned.slice(0, CONTEXT_EXCERPT_MAX_CHARS)}…`;
}

// The context for ONE reply, selected from that reply's thread.
//
// STRICTLY BEFORE THE REPLY. A message at or after the reply's own timestamp is
// never context for it — that would let a later message (including a NOVUS
// message sent in response to this very reply) change how the reply is read.
// The reply's own email_id is excluded too, belt and braces.
//
// A candidate with an unparseable timestamp is SKIPPED rather than assumed to
// be earlier: "we could not order these messages" must not become "this one
// came first".
//
// Returns blank context (never throws) when nothing usable is found.
export function selectThreadContext(reply, threadIndex, { demoUrl = '', demoSlug = '' } = {}) {
  const blank = {
    previous_novus_message: '',
    previous_prospect_message: '',
    demo_already_sent: null,
    context_source: 'NONE',
  };

  const threadId = String(reply?.thread_id ?? '').trim();
  if (!threadId || !threadIndex || typeof threadIndex.get !== 'function') return blank;

  const messages = threadIndex.get(threadId);
  if (!Array.isArray(messages) || !messages.length) return blank;

  const replyMs = timestampMs(reply?.timestamp);
  if (replyMs === null) {
    // We cannot order the thread against this reply, so we cannot know what
    // came before it. Conservative: no context.
    return { ...blank, context_source: 'UNORDERABLE_REPLY_TIMESTAMP' };
  }

  const replyId = String(reply?.email_id ?? '').trim();

  const earlier = messages
    .map((m) => ({ message: m, ms: timestampMs(m.timestamp) }))
    .filter(({ message, ms }) => ms !== null
      && ms < replyMs
      && String(message.email_id ?? '').trim() !== replyId)
    .sort((a, b) => b.ms - a.ms);

  if (!earlier.length) return { ...blank, context_source: 'NO_EARLIER_MESSAGE' };

  const previousNovus = earlier.find(({ message }) => message.direction === 'OUTBOUND')?.message || null;
  const previousProspect = earlier.find(({ message }) => message.direction === 'INBOUND')?.message || null;

  // demo_already_sent is asserted ONLY from evidence in the thread itself: a
  // NOVUS message that actually carries the demo link. OUTBOUND cannot answer
  // this — its SENT status means the OUTREACH was sent, and demo_url only means
  // a demo was BUILT. Unknown stays null, never false.
  let demoAlreadySent = null;
  const needles = [String(demoUrl ?? '').trim(), String(demoSlug ?? '').trim()].filter(Boolean);
  if (needles.length) {
    const novusBodies = earlier
      .filter(({ message }) => message.direction === 'OUTBOUND')
      .map(({ message }) => `${message.raw_body_text ?? ''}`.toLowerCase());
    if (novusBodies.length) {
      demoAlreadySent = novusBodies.some((body) => needles.some((n) => body.includes(n.toLowerCase())));
    }
  }

  return {
    previous_novus_message: previousNovus ? excerpt(previousNovus.cleaned_reply_text || previousNovus.raw_body_text) : '',
    previous_prospect_message: previousProspect ? excerpt(previousProspect.cleaned_reply_text || previousProspect.raw_body_text) : '',
    demo_already_sent: demoAlreadySent,
    context_source: previousNovus ? 'THREAD_SWEEP' : 'NO_PREVIOUS_NOVUS_MESSAGE',
  };
}

// A pass-local, lazily-loaded thread index.
//
// The sweep runs AT MOST ONCE per pass, on first use, and only if something
// actually needs context. Any failure is swallowed into an empty index and
// recorded — context is an enhancement, and losing it must never cost us the
// event.
export function createThreadContextLoader({ apiKey, limit, fetchImpl, mailboxes } = {}) {
  let index = null;
  let error = null;
  let attempted = false;

  return {
    async get() {
      if (attempted) return { index, error };
      attempted = true;
      try {
        const raw = await fetchThreadContextEmails({ apiKey, limit, fetchImpl });
        index = buildThreadIndex(raw, { mailboxes });
      } catch (err) {
        index = new Map();
        error = err?.message || 'thread context sweep failed';
      }
      return { index, error };
    },
    get attempted() { return attempted; },
  };
}
