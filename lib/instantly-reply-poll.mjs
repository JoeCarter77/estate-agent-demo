// lib/instantly-reply-poll.mjs — inbound Instantly reply poll.
//
// One bounded pass: fetch received emails -> normalise -> confirm INBOUND ->
// idempotency check -> match OUTBOUND -> classify deterministically -> propose
// a REPLY_EVENTS row. It PROPOSES; it does not persist.
//
// TWO MODES. dryRun:true (the default) proposes and writes nothing. dryRun:false
// additionally APPENDS one REPLY_EVENTS row per accepted reply — and does
// nothing else: it still never updates OUTBOUND, never changes outbound_status,
// never applies suppression, never writes to Instantly, and never sends. The
// event row may CARRY a classification/suppression decision; nothing downstream
// executes it.
//
// In dry-run this module:
//   - never writes REPLY_EVENTS
//   - never updates OUTBOUND or outbound_status
//   - never writes suppression
//   - never sends anything
//   - never calls an Instantly write endpoint (it issues one GET, nothing else)
//
// lib/instantly-outbound.mjs — the OUTBOUND write path — is not imported here.
// Outbound sending behaviour is untouched.

import {
  normalizeInstantlyEmail,
  routeReply,
  buildReplyEventRow,
  persistReplyEvent,
  findExistingReplyEvent,
  loadProcessedReplyEventIds,
} from './reply-router.mjs';

export const INSTANTLY_EMAILS_URL = 'https://api.instantly.ai/api/v2/emails';
export const OUTBOUND_TAB = 'OUTBOUND';

// Bounded batch. GET /api/v2/emails documents email_type (received|sent|manual),
// so we ask the API for received mail only rather than pulling mixed traffic and
// discarding our own sent copies client-side.
//
// latest_of_thread is deliberately NOT set: it would hide a second reply on a
// thread, and one received email must equal one REPLY_EVENTS row.
export const DEFAULT_POLL_LIMIT = 50;

export function buildReceivedEmailsUrl({ limit = DEFAULT_POLL_LIMIT } = {}) {
  const params = new URLSearchParams({
    email_type: 'received',
    limit: String(limit),
    sort_order: 'desc',
  });
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

// One GET. Never echoes the API key into any returned value or error.
export async function fetchReceivedEmails({
  apiKey,
  limit = DEFAULT_POLL_LIMIT,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) throw new Error('INSTANTLY_REPLY_API_KEY is not set in this environment.');

  const response = await fetchImpl(buildReceivedEmailsUrl({ limit }), {
    method: 'GET',
    cache: 'no-store',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  const text = await response.text();

  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const err = new Error('Instantly API returned an error');
    err.instantly_status = response.status;
    err.instantly_error = payload?.error || payload?.message || payload?.detail
      || (text ? String(text).slice(0, 500) : '(empty response body)');
    throw err;
  }

  return emailsFromPayload(payload);
}

// ---------------------------------------------------------------------------
// OUTBOUND matching.
//
// PRIMARY (and currently ONLY) RULE: normalised lead_email against
// OUTBOUND.outreach_contact_email, compared trimmed and case-insensitively.
//
// WHY EMAIL ONLY: OUTBOUND has no campaign_id column. The campaign lives solely
// in the INSTANTLY_CAMPAIGN_ID env var, applied at upload time by
// lib/instantly-outbound.mjs; nothing per-row records which campaign a lead
// entered. A single global value cannot corroborate an individual row, so
// inventing a campaign rule would be a fake match rule. Hence EMAIL_ONLY.
//
// WHY NOT repo.findById: it compares with === (case-sensitive, untrimmed) and
// returns the FIRST match, silently discarding duplicates — exactly the
// behaviour that must not happen here. A scan is required.
// ---------------------------------------------------------------------------
export const MATCH_METHOD_EMAIL_ONLY = 'EMAIL_ONLY';

export const MATCH_STATUSES = ['MATCHED', 'UNMATCHED', 'AMBIGUOUS'];

// Fields lifted from the matched OUTBOUND row. Every one already exists in
// OUTBOUND_HEADER — no new columns are invented, and probe_id/instantly_lead_id
// are included only when the row actually carries them.
const MATCH_FIELDS = [
  'outbound_id', 'agency_id', 'probe_id', 'outreach_contact_email',
  'outbound_status', 'instantly_lead_id', 'demo_slug', 'demo_url',
];

function normalizeEmailKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

function summariseOutboundRow(obj) {
  const summary = {};
  for (const field of MATCH_FIELDS) {
    if (obj[field] !== undefined && obj[field] !== '') summary[field] = obj[field];
  }
  return summary;
}

// Returns { status, match_method, match, candidates }.
//   MATCHED   — exactly one OUTBOUND row carries this email
//   UNMATCHED — none (the expected result for a test lead never uploaded)
//   AMBIGUOUS — more than one; candidates are listed and NOTHING is chosen
//
// No tie-break heuristic exists on purpose. Narrowing duplicates by
// outbound_status would be a guess about which outreach a reply belongs to, and
// a wrong guess attributes a prospect's reply to the wrong probe.
export function matchOutboundByEmail(outboundRecords, leadEmail) {
  const key = normalizeEmailKey(leadEmail);
  const base = { match_method: MATCH_METHOD_EMAIL_ONLY, match: null, candidates: [] };
  if (!key) return { ...base, status: 'UNMATCHED' };

  const candidates = (outboundRecords || []).filter(
    (record) => normalizeEmailKey(record?.obj?.outreach_contact_email) === key,
  );

  if (candidates.length === 0) return { ...base, status: 'UNMATCHED' };
  if (candidates.length > 1) {
    return {
      ...base,
      status: 'AMBIGUOUS',
      candidates: candidates.map((c) => summariseOutboundRow(c.obj)),
    };
  }
  return { ...base, status: 'MATCHED', match: summariseOutboundRow(candidates[0].obj) };
}

// Advisory only. OUTBOUND cannot corroborate a campaign per row, so this
// compares the reply's campaign_id against the configured INSTANTLY_CAMPAIGN_ID
// purely so a human reviewing the dry run can see a mismatch. It NEVER accepts
// or rejects a match.
export function campaignCorroboration(replyCampaignId, configuredCampaignId) {
  const configured = String(configuredCampaignId ?? '').trim();
  const actual = String(replyCampaignId ?? '').trim();
  if (!configured) return 'NOT_CONFIGURED';
  if (!actual) return 'NO_CAMPAIGN_ON_REPLY';
  return actual === configured ? 'MATCHES_CONFIGURED_CAMPAIGN' : 'DIFFERENT_CAMPAIGN';
}

// ---------------------------------------------------------------------------
// The poll.
// ---------------------------------------------------------------------------
export async function pollInstantlyReplies({
  repo,
  apiKey,
  limit = DEFAULT_POLL_LIMIT,
  // dryRun defaults to true: a caller that forgets the flag proposes, it does
  // not write. Each HTTP operation hard-codes its own value.
  dryRun = true,
  fetchImpl = globalThis.fetch,
  configuredCampaignId = process.env.INSTANTLY_CAMPAIGN_ID,
  now = new Date().toISOString(),
  mailboxes,
} = {}) {
  const emails = await fetchReceivedEmails({ apiKey, limit, fetchImpl });

  const live = dryRun === false;

  const summary = {
    dry_run: !live,
    fetched: emails.length,
    inbound_confirmed: 0,
    skipped_not_inbound: 0,
    duplicates_skipped: 0,
    matched: 0,
    unmatched: 0,
    ambiguous: 0,
    persisted: 0,
    failed: 0,
    events: [],
    skipped: [],
  };
  // proposed_events is a NON-ENUMERABLE alias of the same array, kept for the
  // existing dry-run callers. Non-enumerable so JSON.stringify emits the events
  // list once rather than twice in the HTTP response.
  Object.defineProperty(summary, 'proposed_events', {
    get: () => summary.events,
    enumerable: false,
  });

  // OUTBOUND is loaded ONCE and scanned in memory: one read for the whole
  // batch instead of one per reply.
  let outboundRecords = [];
  if (emails.length) outboundRecords = await repo.getRecords(OUTBOUND_TAB, 'outbound_id');

  // LIVE ONLY: REPLY_EVENTS is loaded ONCE per pass and its instantly_email_id
  // values become an execution-local Set used for every duplicate check in this
  // pass. The Sheet stays the source of truth; the Set is discarded when the
  // pass ends and is never carried across invocations.
  //
  // A header that is not exactly REPLY_EVENTS_HEADER aborts the pass before any
  // append: appendRecord maps onto the live header, so writing into a drifted
  // tab would put correct values in wrong columns.
  let processedIds = null;
  if (live && emails.length) {
    const loaded = await loadProcessedReplyEventIds(repo);
    if (!loaded.header_matches) {
      const err = new Error('REPLY_EVENTS header does not match the expected schema; refusing to append.');
      err.header_mismatch = loaded.header_mismatch;
      throw err;
    }
    processedIds = loaded.ids;
  }

  for (const raw of emails) {
    const reply = normalizeInstantlyEmail(raw, { mailboxes });

    // Direction gate. email_type=received is the provider's claim; this is the
    // verification. A contradiction resolves to UNKNOWN and is skipped rather
    // than processed, so our own sent copy can never become a reply event.
    if (reply.direction !== 'INBOUND') {
      summary.skipped_not_inbound += 1;
      summary.skipped.push({
        instantly_email_id: reply.email_id,
        reason: `direction_${reply.direction.toLowerCase()}`,
        ue_type: reply.ue_type,
      });
      continue;
    }
    summary.inbound_confirmed += 1;

    // Idempotency, before anything else is done with this email.
    //
    // LIVE: the Set built from the single REPLY_EVENTS read at the top of this
    // pass, which is also updated the instant an append succeeds — so two
    // copies of the same email inside ONE fetched batch produce exactly one
    // row, not two.
    //
    // DRY-RUN: unchanged — one findById per candidate. It writes nothing, so
    // there is no in-pass state to keep, and the per-candidate read keeps the
    // existing diagnostic behaviour (it reports the existing reply_event_id).
    const emailKey = String(reply.email_id ?? '').trim();
    const existing = live
      ? (processedIds.has(emailKey) ? { obj: {} } : null)
      : await findExistingReplyEvent(repo, reply.email_id);
    if (existing) {
      summary.duplicates_skipped += 1;
      summary.skipped.push({
        instantly_email_id: reply.email_id,
        reason: 'duplicate_reply_event',
        existing_reply_event_id: existing.obj?.reply_event_id,
      });
      continue;
    }

    const matchResult = matchOutboundByEmail(outboundRecords, reply.lead_email);

    if (matchResult.status !== 'MATCHED') {
      summary[matchResult.status === 'AMBIGUOUS' ? 'ambiguous' : 'unmatched'] += 1;
      summary.skipped.push({
        instantly_email_id: reply.email_id,
        lead_email: reply.lead_email,
        reason: matchResult.status === 'AMBIGUOUS' ? 'ambiguous_outbound_match' : 'no_outbound_match',
        match_method: matchResult.match_method,
        // Listed so a human can resolve the duplicate; nothing is chosen here.
        candidates: matchResult.candidates,
        needs_manual_review: matchResult.status === 'AMBIGUOUS',
      });
      continue;
    }

    summary.matched += 1;

    // Deterministic only: OOO_AUTOMATED, OPT_OUT, else OTHER_UNCLEAR. No AI.
    const decision = routeReply(reply);
    const row = buildReplyEventRow(reply, decision, {
      agencyId: matchResult.match.agency_id || '',
      outreachId: matchResult.match.outbound_id || '',
      now,
    });

    const event = {
      row,
      match_method: matchResult.match_method,
      matched_outbound: matchResult.match,
      campaign_corroboration: campaignCorroboration(reply.campaign_id, configuredCampaignId),
      persisted: false,
    };

    if (!live) {
      // Dry-run: returns the proposed row, touches no sheet.
      await persistReplyEvent(row, { repo, dryRun: true });
      summary.events.push(event);
      continue;
    }

    // LIVE APPEND. This is the ONLY write in the whole pass.
    //
    // duplicateChecked:true skips a second full-tab read — the Set above has
    // already established this id is unprocessed.
    try {
      await persistReplyEvent(row, { repo, dryRun: false, duplicateChecked: true });
      // Only AFTER the append resolves. A throw skips this line, so a failed
      // append leaves the id unprocessed and the next pass retries it.
      processedIds.add(emailKey);
      summary.persisted += 1;
      event.persisted = true;
    } catch (err) {
      summary.failed += 1;
      event.error = err?.message || 'append failed';
      // No OUTBOUND update, no suppression, no action — none of those run in
      // this module at all, so a failure here leaves nothing half-applied.
      summary.skipped.push({
        instantly_email_id: reply.email_id,
        lead_email: reply.lead_email,
        reason: 'append_failed',
        error: event.error,
        will_retry_next_poll: true,
      });
    }

    summary.events.push(event);
  }

  return summary;
}
