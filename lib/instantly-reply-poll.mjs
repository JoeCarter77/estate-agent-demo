// lib/instantly-reply-poll.mjs — inbound Instantly reply poll (DRY-RUN).
//
// One bounded pass: fetch received emails -> normalise -> confirm INBOUND ->
// idempotency check -> match OUTBOUND -> classify deterministically -> propose
// a REPLY_EVENTS row. It PROPOSES; it does not persist.
//
// READ-ONLY BY CONSTRUCTION. In dry-run (the default, and the only mode the
// HTTP operation can reach) this module:
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
  // dryRun is a parameter rather than a constant so tests can prove the guard,
  // but the HTTP operation hard-codes true and exposes no way to change it.
  dryRun = true,
  fetchImpl = globalThis.fetch,
  configuredCampaignId = process.env.INSTANTLY_CAMPAIGN_ID,
  now = new Date().toISOString(),
  mailboxes,
} = {}) {
  const emails = await fetchReceivedEmails({ apiKey, limit, fetchImpl });

  const summary = {
    dry_run: dryRun !== false,
    fetched: emails.length,
    inbound_confirmed: 0,
    skipped_not_inbound: 0,
    duplicates_skipped: 0,
    matched: 0,
    unmatched: 0,
    ambiguous: 0,
    proposed_events: [],
    skipped: [],
  };

  // OUTBOUND is loaded ONCE and scanned in memory: one read for the whole
  // batch instead of one per reply.
  let outboundRecords = [];
  if (emails.length) outboundRecords = await repo.getRecords(OUTBOUND_TAB, 'outbound_id');

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

    // Idempotency, before anything else is done with this email. The source of
    // truth is REPLY_EVENTS itself — never an in-memory set.
    //
    // NOTE for the live poller: this is one findById per inbound email, and
    // each reads the whole tab. Fine for a bounded dry-run batch; when this
    // runs on a schedule it should load REPLY_EVENTS once per pass instead.
    const existing = await findExistingReplyEvent(repo, reply.email_id);
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

    // Dry-run: returns the proposed row, touches no sheet.
    const persistence = await persistReplyEvent(row, { repo, dryRun });

    summary.proposed_events.push({
      row,
      match_method: matchResult.match_method,
      matched_outbound: matchResult.match,
      campaign_corroboration: campaignCorroboration(reply.campaign_id, configuredCampaignId),
      persisted: persistence.persisted,
    });
  }

  return summary;
}
