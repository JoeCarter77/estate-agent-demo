// lib/instantly-execution-state.mjs — the CANONICAL outreach execution state.
//
// WHY THIS EXISTS. `OUTBOUND.instantly_lead_id` means one thing only: the lead
// has been HANDED to Instantly. It has never meant "an email was sent", and
// lib/instantly-outbound.mjs deliberately leaves `outbound_status` on READY
// after a successful upload. Nothing in the workbook therefore records whether
// email 1 actually went out, so every downstream surface had to guess — and
// the Command Centre guessed "handed = waiting", which is right for the 51
// leads Instantly has not mailed yet and wrong for the 49 it has.
//
// Instantly is the source of truth for EXECUTION. Google Sheets stays the
// system of record for everything else. This module is the only place the two
// are reconciled, and it emits ONE canonical status object per lead that both
// the Pipeline and Analytics consume, so their numbers cannot disagree.
//
// READ CONTRACT — this module:
//   - issues GET /api/v2/emails and nothing else (no write endpoint, ever)
//   - never touches Google Sheets (no repo, no getRepo import)
//   - never runs AI and never classifies
//   - never echoes the API key into a return value or an error
//   - never alters live sending behaviour: it observes, it does not act
//   - is pure below the single fetch function
//
// WHY /emails AND NOT THE LEAD OBJECT. The user-facing question is "did email
// N actually leave", and a sent-email event is that fact directly. A lead-level
// counter is a provider summary of the same events, one indirection further
// away, and this repo has already proved the /emails contract in
// lib/instantly-reply-poll.mjs, lib/instantly-conversation.mjs and
// lib/reply-thread-context.mjs. Fields the /emails sweep cannot see — Instantly
// pause/bounce/completion status — are reported as unavailable rather than
// inferred. See LIMITATIONS at the bottom of this file.
//
// WHY A CAMPAIGN-WIDE SWEEP AND NOT ONE CALL PER LEAD. /api/v2/emails is rate
// limited to 20 requests/minute. 100 leads would be 100 calls: an instant N+1
// that would break the moment the campaign grows. One bounded, paginated,
// campaign-scoped sweep serves every lead in the workspace, and the caller
// caches it.

import { normalizeInstantlyEmail, UE_TYPE } from './reply-router.mjs';

export const INSTANTLY_EMAILS_URL = 'https://api.instantly.ai/api/v2/emails';

// 100 is the API maximum for `limit`.
export const EXECUTION_PAGE_LIMIT = 100;

// Ceiling, not an expectation: 12 pages is 1200 emails, comfortably more than
// a 100-lead campaign produces, and it bounds a runaway loop absolutely.
export const EXECUTION_MAX_PAGES = 12;

// One sweep must not hold a serverless invocation open indefinitely. The
// Command Centre renders the durable Sheets projection either way.
export const EXECUTION_TIMEOUT_MS = 20_000;

// The canonical execution states, in sequence order. Nothing outside this list
// is ever emitted.
export const EXECUTION_STATES = Object.freeze([
  'NOT_HANDED',
  'WAITING_FIRST_EMAIL',
  'EMAIL_1_SENT',
  'FOLLOWUP_1_SENT',
  'FOLLOWUP_2_SENT',
  'LATER_STEP_SENT',
]);

// Sequence position -> state. Position 1 is email 1, so follow-up N is
// position N+1. Anything past position 4 is "a later step", named for what we
// can prove rather than pretending to know the template layout.
const STATE_BY_POSITION = Object.freeze({
  1: 'EMAIL_1_SENT',
  2: 'FOLLOWUP_1_SENT',
  3: 'FOLLOWUP_2_SENT',
});

const text = (value) => String(value ?? '').trim();
const lower = (value) => text(value).toLowerCase();

function ms(value) {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

// Instantly's `step` is 1-based on real objects. A blank, zero or non-integer
// value is treated as absent rather than coerced — a wrong step number would
// put a lead in the wrong pipeline stage.
function stepOf(raw) {
  const candidate = raw?.provider_hints?.step ?? raw?.step;
  const parsed = Number(candidate);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

// The state an absent lead gets. Kept as a function so no caller can mutate a
// shared object and leak one lead's numbers into another's.
export function unavailableExecution(reason = '') {
  return {
    source: 'UNAVAILABLE',
    unavailable_reason: text(reason),
    handed_to_instantly: false,
    waiting_for_first_email: false,
    emails_sent_count: 0,
    manual_emails_sent_count: 0,
    first_email_sent_at: '',
    last_email_sent_at: '',
    last_sequence_step: null,
    sequence_position: 0,
    execution_state: 'NOT_HANDED',
    replied: false,
    last_reply_at: '',
  };
}

// ---------------------------------------------------------------------------
// URL construction.
//
// campaign_id is a documented /emails filter and is applied server-side purely
// to keep the sweep small. It is NOT trusted: every returned email's own
// campaign_id is re-checked locally in buildOutreachExecutionState, because a
// provider-side filter is a claim, not a verification.
//
// email_type is deliberately NOT filtered. Instantly splits our own traffic
// across `sent` (campaign, ue_type 1) and `manual` (ue_type 3), and the same
// sweep is what tells us a prospect has replied (ue_type 2). Asking for
// everything once and classifying locally is both fewer calls and consistent
// with the standing rule in lib/reply-thread-context.mjs.
// ---------------------------------------------------------------------------
export function buildExecutionSweepUrl({ campaignId, limit = EXECUTION_PAGE_LIMIT, startingAfter = '' } = {}) {
  const bounded = Number.isInteger(limit) && limit > 0 && limit <= EXECUTION_PAGE_LIMIT
    ? limit
    : EXECUTION_PAGE_LIMIT;
  const params = new URLSearchParams({ limit: String(bounded), sort_order: 'desc' });
  if (text(campaignId)) params.set('campaign_id', text(campaignId));
  if (text(startingAfter)) params.set('starting_after', text(startingAfter));
  return `${INSTANTLY_EMAILS_URL}?${params.toString()}`;
}

function emailsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['items', 'data', 'emails', 'results', 'records']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

// The cursor is taken ONLY from the field the API returns. It is never
// synthesised from the last item's id: inventing a cursor is how a paginated
// read silently loops or silently stops half way.
function cursorFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return text(payload.next_starting_after ?? payload.starting_after ?? '');
}

// ---------------------------------------------------------------------------
// The single I/O function. One bounded, paginated GET sweep.
// ---------------------------------------------------------------------------
export async function fetchCampaignEmails({
  apiKey,
  campaignId,
  limit = EXECUTION_PAGE_LIMIT,
  maxPages = EXECUTION_MAX_PAGES,
  timeoutMs = EXECUTION_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!text(apiKey)) throw new Error('Instantly read credential is not set in this environment.');
  if (typeof fetchImpl !== 'function') throw new Error('Instantly fetch transport is unavailable');

  const bounded = Math.max(1, Math.min(EXECUTION_MAX_PAGES, Math.floor(Number(maxPages)) || EXECUTION_MAX_PAGES));
  const emails = [];
  let cursor = '';
  let pages = 0;
  let truncated = false;

  while (pages < bounded) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response;
    let body;
    try {
      response = await fetchImpl(buildExecutionSweepUrl({ campaignId, limit, startingAfter: cursor }), {
        method: 'GET',
        cache: 'no-store',
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        ...(controller ? { signal: controller.signal } : {}),
      });
      const raw = await response.text();
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      if (!response.ok) {
        const err = new Error('Instantly API returned an error');
        err.instantly_status = response.status;
        err.instantly_error = body?.error || body?.message || body?.detail || '(no detail)';
        throw err;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }

    const page = emailsFromPayload(body);
    emails.push(...page);
    pages += 1;
    cursor = cursorFromPayload(body);
    if (!page.length || !cursor) break;
    // The cursor is still live on the last permitted page, so there is more
    // mail than this sweep saw. Say so rather than reporting a short count as
    // if it were complete.
    if (pages >= bounded) truncated = true;
  }

  return { emails, pages, truncated, emails_scanned: emails.length };
}

// ---------------------------------------------------------------------------
// Pure derivation. No I/O below this line.
// ---------------------------------------------------------------------------

function blankLeadState() {
  return {
    sends: [],
    manual_sends: 0,
    replies: [],
  };
}

// Every lead the sweep saw, keyed by lowercased lead email. `handedEmails` (the
// OUTBOUND addresses that carry an instantly_lead_id) is what turns "no sent
// email for this address" into the positive fact WAITING_FIRST_EMAIL rather
// than "we know nothing about this address".
export function buildOutreachExecutionState({
  emails = [],
  campaignId = '',
  handedEmails = [],
  mailboxes,
  pages = 0,
  truncated = false,
} = {}) {
  const wantedCampaign = text(campaignId);
  const raw = new Map();
  let ignoredOtherCampaign = 0;
  let ignoredNoLead = 0;

  for (const item of emails) {
    const message = normalizeInstantlyEmail(item, { mailboxes });
    const leadEmail = lower(message.lead_email);
    if (!leadEmail) { ignoredNoLead += 1; continue; }
    // Local re-check of the provider's own filter.
    if (wantedCampaign && text(message.campaign_id) && text(message.campaign_id) !== wantedCampaign) {
      ignoredOtherCampaign += 1;
      continue;
    }
    if (!raw.has(leadEmail)) raw.set(leadEmail, blankLeadState());
    const bucket = raw.get(leadEmail);
    const at = ms(message.timestamp);

    // A campaign send is the ONLY thing that counts as a sequence email. Both
    // signals must agree: Instantly's own ue_type AND the address-derived
    // direction that lib/reply-router.mjs cross-checks it against. A
    // contradiction is not counted — an over-count here would move a lead into
    // a stage it has not reached.
    if (message.ue_type === UE_TYPE.SENT_FROM_CAMPAIGN && message.direction === 'OUTBOUND') {
      bucket.sends.push({ at, at_iso: text(message.timestamp), step: stepOf(message) });
      continue;
    }
    // Manual sends are NOVUS replies. They are already recorded in
    // SALES_MESSAGES, so they are reported separately and never folded into
    // the sequence count.
    if (message.ue_type === UE_TYPE.SENT_MANUALLY && message.direction === 'OUTBOUND') {
      bucket.manual_sends += 1;
      continue;
    }
    if (message.ue_type === UE_TYPE.RECEIVED && message.direction === 'INBOUND') {
      bucket.replies.push({ at, at_iso: text(message.timestamp) });
    }
  }

  const byEmail = new Map();
  for (const [leadEmail, bucket] of raw) {
    byEmail.set(leadEmail, finaliseLead(bucket, { handed: true }));
  }
  // A handed lead with no sent campaign email is WAITING, positively. Without
  // this pass such a lead would fall through to UNAVAILABLE and the resolver
  // would use its old guess.
  for (const value of handedEmails) {
    const leadEmail = lower(value);
    if (!leadEmail || byEmail.has(leadEmail)) continue;
    byEmail.set(leadEmail, finaliseLead(blankLeadState(), { handed: true }));
  }

  const totals = summarise(byEmail);

  return {
    available: true,
    source: 'INSTANTLY',
    campaign_id: wantedCampaign,
    by_email: byEmail,
    totals,
    pages,
    truncated,
    emails_scanned: emails.length,
    ignored_other_campaign: ignoredOtherCampaign,
    ignored_no_lead: ignoredNoLead,
  };
}

function finaliseLead(bucket, { handed }) {
  const sends = [...bucket.sends].sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  const dated = sends.filter((row) => row.at !== null);
  const steps = sends.map((row) => row.step).filter((row) => row !== null);
  const lastStep = steps.length ? Math.max(...steps) : null;
  // Prefer Instantly's own step number; fall back to the number of distinct
  // sends we can actually see. Both are execution evidence — neither is a
  // guess about mail we have not observed.
  const position = sends.length ? Math.max(lastStep ?? 0, sends.length) : 0;
  const replies = [...bucket.replies].filter((row) => row.at !== null).sort((a, b) => a.at - b.at);

  return {
    source: 'INSTANTLY',
    unavailable_reason: '',
    handed_to_instantly: Boolean(handed),
    waiting_for_first_email: Boolean(handed) && sends.length === 0,
    emails_sent_count: sends.length,
    manual_emails_sent_count: bucket.manual_sends,
    first_email_sent_at: dated.length ? dated[0].at_iso : '',
    last_email_sent_at: dated.length ? dated[dated.length - 1].at_iso : '',
    last_sequence_step: lastStep,
    sequence_position: position,
    execution_state: sends.length === 0
      ? 'WAITING_FIRST_EMAIL'
      : (STATE_BY_POSITION[position] || 'LATER_STEP_SENT'),
    replied: replies.length > 0,
    last_reply_at: replies.length ? replies[replies.length - 1].at_iso : '',
  };
}

function summarise(byEmail) {
  const totals = {
    leads_with_evidence: byEmail.size,
    waiting_for_first_email: 0,
    first_emails_sent: 0,
    followup_emails_sent: 0,
    total_emails_sent: 0,
    manual_emails_sent: 0,
    leads_replied: 0,
    by_state: Object.fromEntries(EXECUTION_STATES.map((state) => [state, 0])),
  };
  for (const lead of byEmail.values()) {
    totals.by_state[lead.execution_state] = (totals.by_state[lead.execution_state] || 0) + 1;
    totals.total_emails_sent += lead.emails_sent_count;
    totals.manual_emails_sent += lead.manual_emails_sent_count;
    if (lead.emails_sent_count === 0) totals.waiting_for_first_email += 1;
    else {
      totals.first_emails_sent += 1;
      totals.followup_emails_sent += lead.emails_sent_count - 1;
    }
    if (lead.replied) totals.leads_replied += 1;
  }
  return totals;
}

// The ONE lookup every consumer uses. `state` may be null/unavailable, in which
// case the caller gets an UNAVAILABLE object and is expected to fall back to
// stored evidence rather than to invent a send.
export function lookupOutreachExecution(state, { email = '', handed = false } = {}) {
  if (!state || state.available !== true) {
    return unavailableExecution(state?.error || 'Instantly execution state was not loaded');
  }
  const found = state.by_email?.get(lower(email));
  if (found) return found;
  if (!text(email)) return unavailableExecution('lead has no contact email to correlate on');
  if (handed) {
    // Handed, correlatable, and the sweep saw no mail either way. That is a
    // real WAITING answer, not an absence of data.
    return finaliseLead(blankLeadState(), { handed: true });
  }
  return unavailableExecution('lead is not handed to Instantly');
}

// ---------------------------------------------------------------------------
// The shared, cached loader.
//
// ONE source of truth means ONE loader: the dashboard projection and the action
// reconciler must never disagree about what "sent" means, and they would the
// moment each did its own read. Both call this.
//
// The sweep — not the derived state — is cached, because `handedEmails` differs
// between callers and rebuilding the derivation is pure and free. A cold lambda
// simply misses. Failure is always soft: an unavailable execution read leaves
// every consumer on its pre-existing stored-evidence behaviour.
// ---------------------------------------------------------------------------
export const EXECUTION_CACHE_TTL_MS = 300_000;

let sweepCache = null; // { at: epochMs, sweep }

export function invalidateExecutionCache() {
  sweepCache = null;
}

export async function loadOutreachExecutionState({
  handedEmails = [],
  refresh = false,
  fetchImpl = globalThis.fetch,
  mailboxes,
} = {}) {
  // The READ credential, never the write key: lib/instantly-outbound.mjs owns
  // INSTANTLY_API_KEY and this module must not be able to reach a write path.
  const apiKey = process.env.INSTANTLY_REPLY_API_KEY;
  const campaignId = process.env.INSTANTLY_CAMPAIGN_ID;
  if (!text(apiKey)) {
    return { available: false, source: 'UNAVAILABLE', error: 'INSTANTLY_REPLY_API_KEY is not set in this environment.' };
  }

  const nowMs = Date.now();
  let sweep = null;
  let cached = false;
  if (!refresh && sweepCache && nowMs - sweepCache.at < EXECUTION_CACHE_TTL_MS) {
    sweep = sweepCache.sweep;
    cached = true;
  } else {
    try {
      sweep = await fetchCampaignEmails({ apiKey, campaignId, fetchImpl });
      sweepCache = { at: Date.now(), sweep };
    } catch (err) {
      return {
        available: false,
        source: 'UNAVAILABLE',
        error: `Instantly execution read failed: ${err?.instantly_error || err?.message || 'unknown error'}`.slice(0, 500),
      };
    }
  }

  const state = buildOutreachExecutionState({
    emails: sweep.emails,
    campaignId,
    handedEmails,
    mailboxes,
    pages: sweep.pages,
    truncated: sweep.truncated,
  });
  return { ...state, cached, cache_age_ms: cached ? nowMs - sweepCache.at : 0 };
}

// LIMITATIONS of this source, recorded here so no caller has to rediscover them:
//   - Instantly's own lead status (paused / bounced / unsubscribed / sequence
//     completed) is not exposed by /api/v2/emails, so `sequence_completed` is
//     deliberately NOT derived. A lead that has finished its sequence is
//     reported at the last step we can prove was sent.
//   - `replied` here counts inbound mail seen in this sweep. REPLY_EVENTS in
//     the workbook remains the system of record for replies and their
//     classification, and the lifecycle resolver still reads it first.
//   - a truncated sweep (see `truncated`) means the oldest mail was not seen;
//     counts are then lower bounds, and the caller surfaces a warning.
export const _internal = { finaliseLead, summarise, stepOf, cursorFromPayload, emailsFromPayload };
