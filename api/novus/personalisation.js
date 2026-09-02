// api/novus/personalisation.js — GET /api/novus/personalisation?probe_id=...
//                                 GET /api/novus/personalisation?agency_id=...
//                                 POST /api/novus/contacts/verify (via rewrite)
//                                 POST /api/novus/contacts/resolve (via rewrite)
//                                 GET  /api/novus/instantly/replies-test (via rewrite)
//                                 GET  /api/novus/instantly/reply-poll-dry-run (via rewrite)
//                                 POST /api/novus/instantly/reply-poll (via rewrite)
//                                 GET  /api/novus/instantly/send-demo-dry-run (via rewrite)
//                                 POST /api/novus/instantly/send-demo (via rewrite)
//                                 GET  /api/novus/operator/leads (via rewrite)
//
// Read-only lookup for the PERSONALISATION row lib/personalisation-rebuild.mjs
// writes (via the existing /api/novus/intelligence/rebuild-all + cron finalize
// rebuild flow — this file never triggers generation, only reads what's
// already there). One row per probe_id; ?agency_id= returns that agency's
// most recently created row, since an agency can have more than one probe.
//
// This is the single feed point for Instantly variables and the demo compiler.
// Instantly owns the fixed templates; NOVUS supplies property_reference,
// email_observation and email_commercial_hook (Email 1) plus
// email_commercial_hook_email_2 (Email 2). All three email prose fields come
// from the row's one traceable DIAGNOSIS_FINDINGS selection, and each does a
// different job: what happened, why it matters commercially, and the one
// extra thing that changes how the enquiry reads. This route does not touch
// index.html/api/lead.js's separate legacy demo data source.
//
// Same NOVUS_BASIC_AUTH guard as the rest of /api/novus/*.

import { getRepo } from '../../lib/sheets.mjs';
import { NeverBounceError, verifyEmail } from '../../lib/neverbounce.mjs';
import { resolveAgencyContact, listResolutionBacklog } from '../../lib/contact-resolution.mjs';
import { requireAuth, requireReplyPollerSecret } from './_auth.mjs';
import { pollInstantlyReplies } from '../../lib/instantly-reply-poll.mjs';
import {
  evaluateSendDemoDryRun,
  executeSendDemo,
  SEND_DEMO_LIVE_CONFIRMATION,
} from '../../lib/reply-send-demo.mjs';
import { classifyReply, CONFIDENCE_THRESHOLD } from '../../lib/reply-classification.mjs';
import { _internal as aiClientInternal } from '../../lib/ai-client.mjs';
import { normalizeInstantlyEmail } from '../../lib/reply-router.mjs';
import { PHRASES, DETERMINISTIC_PHRASES, CONTEXTUAL_PHRASES } from '../../lib/reply-classification-fixtures.mjs';
import { buildOperatorLeads, OPERATOR_TABS } from '../../lib/operator-leads.mjs';

// Contact resolution can run Hunter Domain Search, Finder and several Verifier
// checks in one invocation; 20s was sized for the read-only
// Personalisation GET alone. This is a ceiling, not a reservation — the GET
// path is unaffected.
export const maxDuration = 60;

// Vercel rewrites the internal contact-verification URL here with the marker
// below. Keeping this in an existing protected function avoids consuming a
// thirteenth Hobby-plan Serverless Function; this path never calls getRepo()
// and therefore does not read from or write to Google Sheets.
async function handleContactVerification(req, res) {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  if (!email) return res.status(400).json({ error: 'Missing email' });

  try {
    const verification = await verifyEmail(email);
    return res.status(200).json({ email, ...verification });
  } catch (err) {
    if (err instanceof NeverBounceError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    console.error('contacts/verify error:', err);
    return res.status(500).json({ error: 'Unable to verify email' });
  }
}

// Single-agency contact resolution — POST /api/novus/contacts/resolve.
//
// Rewritten here with its own marker for exactly the same reason as
// verify-contact above: /api/novus/* is already at Vercel Hobby's 12
// Serverless Function limit, so a new protected NOVUS action becomes another
// operation on an existing protected function rather than a thirteenth file.
//
// Body: { agency_id, dry_run? }. One agency per call — deliberately no
// "resolve everything" mode here. GET ?novus_operation=resolution-backlog
// lists the probed agencies a future bulk run would cover WITHOUT resolving
// any of them.
async function handleContactResolution(req, res) {
  const agencyId = typeof req.body?.agency_id === 'string' ? req.body.agency_id.trim() : '';
  if (!agencyId) return res.status(400).json({ error: 'Missing agency_id' });
  const dryRun = req.body?.dry_run === true;

  try {
    const result = await resolveAgencyContact(getRepo(), agencyId, { dryRun });
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof NeverBounceError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    if (err?.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error('contacts/resolve error:', err);
    return res.status(500).json({ error: err.message || 'Unable to resolve contact' });
  }
}

// Read-only: what the later backlog run WOULD process. Resolves nothing.
//
// require_probe_sent defaults to true (original behaviour: probed-and-
// unresolved only). Pass require_probe_sent=false for the separate blank-
// contact_resolution_status bulk run, which deliberately ignores probe_sent.
async function handleResolutionBacklog(req, res) {
  try {
    const includeResolved = String(req.query?.include_resolved || '') === 'true';
    const requireProbeSent = String(req.query?.require_probe_sent ?? 'true') !== 'false';
    const agencies = await listResolutionBacklog(getRepo(), { includeResolved, requireProbeSent });
    return res.status(200).json({ count: agencies.length, agencies });
  } catch (err) {
    console.error('contacts/resolution-backlog error:', err);
    return res.status(500).json({ error: err.message || 'Failed to list resolution backlog' });
  }
}

// Instantly reply-router connectivity test —
// GET /api/novus/personalisation?novus_operation=instantly-replies-test
// (also reachable via the /api/novus/instantly/replies-test rewrite).
//
// READ-ONLY. One GET against Instantly API V2's /emails collection, returning
// a simplified view of whatever came back. It sends nothing, updates no lead,
// suppresses nothing, writes no Sheets row (never calls getRepo()) and runs no
// classification. It exists here, as another operation on an already-protected
// function, for the same Hobby-plan reason as verify-contact above.
//
// Deliberately separate from the OUTBOUND handoff (lib/instantly-outbound.mjs,
// untouched by this file): that is a WRITE path on INSTANTLY_API_KEY, this is a
// READ path on its own credential, INSTANTLY_REPLY_API_KEY.
const INSTANTLY_EMAILS_URL = 'https://api.instantly.ai/api/v2/emails';
const INSTANTLY_REPLIES_TEST_LIMIT = 20;

// Instantly's reply payload shape is not yet observed (no campaign has run),
// so every read below is defensive: unknown envelope, unknown field names,
// unknown nesting. Nothing assumes a field exists.
function pickField(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function emailsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['items', 'data', 'emails', 'results', 'records']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function textPreview(value, max = 300) {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}\u2026` : text;
}

function emailBodyPreview(email) {
  const body = pickField(email, 'body', 'content', 'message');
  if (typeof body === 'string') return textPreview(body);
  if (body && typeof body === 'object') return textPreview(pickField(body, 'text', 'plain', 'html'));
  return textPreview(pickField(email, 'body_text', 'text', 'content_preview', 'snippet', 'preview'));
}

function simplifyInstantlyEmail(email) {
  if (!email || typeof email !== 'object') return { raw_type: typeof email };
  return {
    id: pickField(email, 'id', 'email_id', '_id'),
    timestamp: pickField(email, 'timestamp', 'timestamp_created', 'timestamp_email', 'created_at', 'date'),
    subject: pickField(email, 'subject'),
    from: pickField(email, 'from_address_email', 'from_address', 'from', 'from_email'),
    to: pickField(email, 'to_address_email_list', 'to_address_email', 'to_address', 'to', 'to_email'),
    lead_email: pickField(email, 'lead', 'lead_email', 'email'),
    lead_id: pickField(email, 'lead_id', 'leadId'),
    campaign_id: pickField(email, 'campaign_id', 'campaign', 'campaignId'),
    thread_id: pickField(email, 'thread_id', 'threadId'),
    // eaccount verbatim: lib/reply-router.mjs prefers it as the NOVUS-side
    // address for direction validation, but we have only seen the field NAME so
    // far. Surfaced raw to confirm whether it is an address, an account
    // id/UUID, or some other structure. It is a mailbox identifier, not a
    // credential — the API key is never echoed anywhere in this response.
    eaccount: pickField(email, 'eaccount', 'email_account'),
    is_unread: pickField(email, 'is_unread', 'unread'),
    is_auto_reply: pickField(email, 'is_auto_reply', 'auto_reply', 'ai_interest_status_auto_reply'),
    body_preview: emailBodyPreview(email),
  };
}

async function handleInstantlyRepliesTest(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const apiKey = process.env.INSTANTLY_REPLY_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      success: false,
      error: 'INSTANTLY_REPLY_API_KEY is not set in this environment.',
    });
  }

  let response;
  let text;
  try {
    response = await fetch(`${INSTANTLY_EMAILS_URL}?limit=${INSTANTLY_REPLIES_TEST_LIMIT}`, {
      method: 'GET',
      cache: 'no-store',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    text = await response.text();
  } catch (err) {
    // Transport failure. Never echo the key back.
    return res.status(502).json({
      success: false,
      error: 'Request to Instantly failed',
      message: String(err?.message || err),
    });
  }

  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const status = response.status === 401 || response.status === 403 ? response.status : 502;
    return res.status(status).json({
      success: false,
      error: 'Instantly API returned an error',
      instantly_status: response.status,
      instantly_error:
        pickField(payload, 'error', 'message', 'detail') ?? textPreview(text, 500) ?? '(empty response body)',
    });
  }

  // Zero emails is the EXPECTED result until the campaign goes live.
  const items = emailsFromPayload(payload);

  // available_fields lists the KEY NAMES (never the values) present on the
  // first email. simplifyInstantlyEmail whitelists fields, so without this we
  // cannot tell whether Instantly exposes a stronger direction/message-type
  // field (ue_type, email_type, eaccount, ...) that lib/reply-router.mjs should
  // preserve. Key names are not secrets; no value is echoed.
  const availableFields = items.length && items[0] && typeof items[0] === 'object'
    ? Object.keys(items[0]).sort()
    : [];

  return res.status(200).json({
    success: true,
    count: items.length,
    available_fields: availableFields,
    emails: items.map(simplifyInstantlyEmail),
  });
}

// Inbound reply poll, DRY RUN —
// GET /api/novus/personalisation?novus_operation=instantly-reply-poll-dry-run
// (also reachable via the /api/novus/instantly/reply-poll-dry-run rewrite).
//
// READ-ONLY. One GET to Instantly for received emails only, plus Google Sheets
// READS (OUTBOUND once per pass, REPLY_EVENTS per candidate) to match and to
// de-duplicate. It proposes REPLY_EVENTS rows and writes none.
//
// dryRun is hard-coded true and is NOT taken from the query string: there is no
// request this operation can be sent that causes a write. It changes no
// outbound_status, writes no suppression, sends nothing, and calls no Instantly
// write endpoint. Another operation on this already-protected function, for the
// same Hobby-plan reason as verify-contact above.
async function handleInstantlyReplyPollDryRun(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const apiKey = process.env.INSTANTLY_REPLY_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      success: false,
      error: 'INSTANTLY_REPLY_API_KEY is not set in this environment.',
    });
  }

  const requested = Number(req.query?.limit);
  const limit = Number.isInteger(requested) && requested > 0 && requested <= 100 ? requested : 50;

  try {
    // Semantic classification is opt-in and only runs when a key exists. In
    // dry-run it classifies and reports what it WOULD write; it updates
    // nothing. ?classify=0 turns it off for a pure zero-cost pass.
    const classify = process.env.ANTHROPIC_API_KEY ? req.query?.classify !== '0' : false;
    const summary = await pollInstantlyReplies({ repo: getRepo(), apiKey, limit, dryRun: true, classify });
    return res.status(200).json({ success: true, ...summary });
  } catch (err) {
    // Never echo the API key, on any path.
    if (err?.instantly_status) {
      return res.status(502).json({
        success: false,
        error: 'Instantly API returned an error',
        instantly_status: err.instantly_status,
        instantly_error: err.instantly_error,
      });
    }
    console.error('instantly-reply-poll-dry-run error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Reply poll failed' });
  }
}

// AUTOMATIC SEND_DEMO EXECUTION, run immediately after a live poll pass.
//
// Scope is deliberately narrow: only events THIS poll pass itself just
// persisted — event.persisted === true, never a pre-existing/duplicate row,
// which never reaches summary.events at all (see the duplicate-skip branch in
// pollInstantlyReplies) — AND whose classification this same pass produced is
// exactly POSITIVE_SEND_DEMO. No extra confidence/source check is needed:
// classifyReply() can only return POSITIVE_SEND_DEMO via a genuine AI verdict
// (source:'AI'), because every failure/low-confidence/fallback path in
// lib/reply-classification.mjs is hardcoded to OTHER_UNCLEAR.
//
// Reuses executeSendDemo() from lib/reply-send-demo.mjs UNCHANGED — it
// re-reads/re-derives the row, the OUTBOUND match and the Instantly thread
// evidence itself, and runs the exact same gate the manual live send route
// runs. This function only decides WHICH reply_event_ids to call it for; it
// never evaluates eligibility itself and never touches REPLY_EVENTS directly.
//
// One event failing to send must never lose the fact that the reply was
// ingested/classified: each call is isolated in its own try/catch, and a
// thrown error becomes its own recorded result rather than aborting the pass.
async function runAutoSendDemo({ repo, apiKey, events }) {
  const candidates = (events || []).filter(
    (event) => event.persisted === true && event.classification?.classification === 'POSITIVE_SEND_DEMO',
  );

  const results = [];
  for (const event of candidates) {
    const replyEventId = event.row?.reply_event_id;
    try {
      const result = await executeSendDemo({ repo, replyEventId, apiKey });
      results.push({ reply_event_id: replyEventId, attempted: true, ...result });
    } catch (err) {
      // Never echo the API key, on any path.
      console.error('auto-send-demo error:', err);
      results.push({
        reply_event_id: replyEventId,
        attempted: true,
        sent: false,
        error: err?.message || 'auto-send execution failed',
      });
    }
  }
  return results;
}

// Inbound reply poll, LIVE —
// POST /api/novus/personalisation?novus_operation=instantly-reply-poll
// (also reachable via the /api/novus/instantly/reply-poll rewrite).
//
// The ONLY REPLY_EVENTS write this performs directly is APPENDING rows for
// confirmed inbound replies that matched exactly one OUTBOUND row and were
// not already processed; it changes no outbound_status, writes no
// suppression, and calls no Instantly write endpoint itself. It DOES, after
// that append+classify pass, invoke runAutoSendDemo() above for any row this
// SAME pass just persisted and classified as POSITIVE_SEND_DEMO — which is the
// one path in this function that can cause an Instantly send. See
// runAutoSendDemo for the exact condition and lib/reply-send-demo.mjs for the
// gate that still has to pass before anything is actually sent.
//
// POST, not GET, because it writes — the dry-run diagnostic stays on GET.
//
// Guarded by Basic Auth AND by the dedicated X-NOVUS-REPLY-POLLER-SECRET header
// (see requireReplyPollerSecret in ./_auth.mjs), both enforced by the router
// before this function is entered — so a blocked request performs zero Instantly
// reads and zero Google Sheets access. The dry-run operation is NOT so guarded.
// Another operation on this already-protected function, for the same Hobby-plan
// 12-function reason as the operations above.
async function handleInstantlyReplyPoll(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const apiKey = process.env.INSTANTLY_REPLY_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      success: false,
      error: 'INSTANTLY_REPLY_API_KEY is not set in this environment.',
    });
  }

  const requested = Number(req.query?.limit);
  const limit = Number.isInteger(requested) && requested > 0 && requested <= 100 ? requested : 50;

  try {
    // Classification runs AFTER each raw row is appended, and updates only the
    // derived classification columns on that same row. It still writes
    // nothing to Instantly and touches no OUTBOUND row itself — see
    // runAutoSendDemo for the one thing that runs after it.
    const classify = process.env.ANTHROPIC_API_KEY ? req.query?.classify !== '0' : false;
    const repo = getRepo();
    const summary = await pollInstantlyReplies({ repo, apiKey, limit, dryRun: false, classify });
    const autoSend = await runAutoSendDemo({ repo, apiKey, events: summary.events });
    return res.status(200).json({
      success: true,
      dry_run: false,
      fetched: summary.fetched,
      inbound_confirmed: summary.inbound_confirmed,
      skipped_not_inbound: summary.skipped_not_inbound,
      duplicates_skipped: summary.duplicates_skipped,
      matched: summary.matched,
      unmatched: summary.unmatched,
      ambiguous: summary.ambiguous,
      persisted: summary.persisted,
      failed: summary.failed,
      // CROSS-INSTANCE CONTENTION. claim_conflicts > 0 means another invocation
      // held the claim for that inbound email — the guard worked and the reply
      // is already being processed elsewhere, so this is informational, not an
      // error. claim_errors > 0 means the KV store could not be reached at all:
      // those replies were processed by NOBODY and are waiting for the next
      // pass, which is the one number here worth alerting on. Per-email detail
      // is in skipped[] under reason claim_conflict / claim_store_error.
      claim_conflicts: summary.claim_conflicts,
      claim_errors: summary.claim_errors,
      classified: summary.classified,
      classification_fallbacks: summary.classification_fallbacks,
      classification_updates: summary.classification_updates,
      // Whether each reply's immediately preceding NOVUS message was actually
      // resolved. A short reply cannot be classified confidently without it, so
      // context_missing > 0 is the first thing to check when a plainly
      // affirmative reply lands on MANUAL_REVIEW. Per-event detail (including
      // context_source and previous_novus_cta_type) is on events[].thread_context.
      context_resolved: summary.context_resolved,
      context_missing: summary.context_missing,
      context_error: summary.context_error,
      events: summary.events,
      skipped: summary.skipped,
      auto_send: autoSend,
    });
  } catch (err) {
    // Never echo the API key, on any path.
    if (err?.instantly_status) {
      return res.status(502).json({
        success: false,
        error: 'Instantly API returned an error',
        instantly_status: err.instantly_status,
        instantly_error: err.instantly_error,
      });
    }
    if (err?.claim_store_unavailable) {
      // FAIL CLOSED, and say so precisely. The pass threw before the Instantly
      // GET and before any Sheets access, so nothing was read, appended or
      // sent. Never echoes the token.
      return res.status(500).json({
        success: false,
        error: err.message,
      });
    }
    if (err?.header_mismatch) {
      return res.status(500).json({
        success: false,
        error: 'REPLY_EVENTS header does not match the expected schema; nothing was appended.',
        header_mismatch: err.header_mismatch,
      });
    }
    console.error('instantly-reply-poll error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Reply poll failed' });
  }
}

// GET /api/novus/personalisation?novus_operation=reply-classifier-live-test
// (also reachable via the /api/novus/instantly/reply-classifier-live-test
// rewrite, if one is added — not required, the query-param route works as-is).
//
// LIVE MODEL DIAGNOSTIC. Runs the fixed phrase test set (the SAME table the
// offline selftest asserts against — lib/reply-classification-fixtures.mjs)
// through classifyReply() EXACTLY as built: no prompt change, no threshold
// change, nothing special-cased for this route. Every phrase is wrapped in a
// synthetic normalised reply object and passed straight into the real
// classifier, so this exercises the identical code path production replies do
// — deterministic rules first, semantic AI only for what is left.
//
// READ-ONLY, by construction, not by extra guarding: classifyReply() never
// calls repo, Instantly, or anything else. This handler never calls getRepo()
// at all, so there is no Sheets access, no REPLY_EVENTS write, no OUTBOUND
// write, no Instantly write, and no email send — there is nothing in this
// function capable of any of those. The only network call it makes is the
// Anthropic Messages call inside callAi(), once per case that reaches the
// model.
//
// Existing NOVUS Basic Auth guards it, same as every other operation on this
// function — see requireAuth in ./_auth.mjs, enforced by the router below
// before this function is entered.
async function handleReplyClassifierLiveTest(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!process.env.ANTHROPIC_API_KEY) {
    // Fail clearly, without ever echoing whether some OTHER key-shaped env var
    // exists, and without touching the model.
    return res.status(500).json({
      success: false,
      error: 'ANTHROPIC_API_KEY is not configured in this environment.',
    });
  }

  // TWO fixture sets, run through the SAME classifier:
  //   context_free — the original baseline table, no thread context supplied.
  //     Kept unchanged so its score stays comparable run to run.
  //   contextual   — the same reply text with different immediately-previous
  //     NOVUS messages, which is the whole point of this change.
  const cases = [
    ...[...DETERMINISTIC_PHRASES, ...PHRASES].map(([phrase, expected]) => ({
      phrase, expected, context: null, set: 'context_free', label: '',
    })),
    ...CONTEXTUAL_PHRASES.map((c) => ({
      phrase: c.phrase, expected: c.expected, context: c.context, set: 'contextual', label: c.label,
    })),
  ];

  const results = [];
  for (const { phrase, expected, context, set, label } of cases) {
    // A minimal synthetic Instantly email, normalised through the SAME
    // normalizeInstantlyEmail() production replies go through, so
    // classifyReply() sees exactly the shape it sees live (cleaned_reply_text,
    // is_auto_reply, etc.) rather than a hand-built shortcut object.
    const reply = normalizeInstantlyEmail({
      id: `live-test-${results.length}`,
      ue_type: 2,
      eaccount: 'joe@novushq.co.uk',
      from_address_email: 'agency@example-agency.co.uk',
      to_address_email_list: 'joe@novushq.co.uk',
      lead: 'agency@example-agency.co.uk',
      timestamp: new Date().toISOString(),
      subject: 'Re: your enquiry handling',
      body: { text: phrase },
    });

    let decision;
    let error = null;
    try {
      decision = await classifyReply(reply, { context });
    } catch (err) {
      // classifyReply() is built not to throw (every failure mode resolves to
      // a safe OTHER_UNCLEAR decision) — this is a last-resort guard so one
      // unexpected error cannot abort the whole diagnostic run.
      error = err?.message || 'classification threw unexpectedly';
      decision = { classification: 'OTHER_UNCLEAR', confidence: null, next_action: 'MANUAL_REVIEW', priority: 'HIGH', reason: '', source: 'HANDLER_ERROR' };
    }

    results.push({
      set,
      label,
      phrase,
      previous_novus_message: context?.previous_novus_message || null,
      demo_already_sent: context?.demo_already_sent ?? null,
      expected_classification: expected,
      actual_classification: decision.classification,
      confidence: decision.confidence,
      next_action: decision.next_action,
      priority: decision.priority,
      reason: decision.reason,
      source: decision.source,
      agreement: decision.classification === expected,
      error,
    });
  }

  const score = (rows) => {
    const agreed = rows.filter((r) => r.agreement).length;
    return {
      total_cases: rows.length,
      agreement_count: agreed,
      agreement_percentage: rows.length ? Math.round((agreed / rows.length) * 1000) / 10 : 0,
    };
  };

  const contextFree = results.filter((r) => r.set === 'context_free');
  const contextual = results.filter((r) => r.set === 'contextual');

  const disagreements = results.filter((r) => !r.agreement);
  const lowConfidenceCases = results.filter((r) => typeof r.confidence === 'number' && r.confidence < CONFIDENCE_THRESHOLD);
  const otherUnclearCases = results.filter((r) => r.actual_classification === 'OTHER_UNCLEAR');

  return res.status(200).json({
    success: true,
    model: aiClientInternal.DEFAULT_MODEL,
    confidence_threshold: CONFIDENCE_THRESHOLD,
    ...score(results),
    by_set: {
      context_free: score(contextFree),
      contextual: score(contextual),
    },
    disagreements,
    low_confidence_cases: lowConfidenceCases,
    other_unclear_cases: otherUnclearCases,
    results,
  });
}

// OPERATOR LEADS — GET /api/novus/personalisation?novus_operation=operator-leads
// (also reachable via the /api/novus/operator/leads rewrite).
//
// The read-only feed behind novus/operator.html — the Acquisition Command
// Centre. Phase 1 is a VIEW and nothing else.
//
// WHAT THIS BRANCH DOES: seven Google Sheets READS in parallel, then one call
// into the pure lib/operator-leads.mjs aggregator.
//
// WHAT IT CANNOT DO, structurally rather than by convention: it is GET-only,
// it calls no writer, it runs no AI, it touches no Instantly endpoint, it does
// not call GET /api/demo (which would count a view), and it never invokes
// rebuildOutbound, runRebuildPass or the reply poller. The only repo methods it
// reaches are getTable() reads.
//
// It lives here, as another operation on an already-protected function, for the
// same Hobby-plan reason as verify-contact above: /api/novus/* is at Vercel's
// 12 Serverless Function ceiling, so a new protected NOVUS action becomes an
// operation, never a thirteenth file.
const OPERATOR_LEADS_CACHE_TTL_MS = 45_000;

// Module-scope, in-process, single-entry cache. Scoped to THIS branch alone:
// no other operation reads or writes it, it holds only data the caller is
// already authorised to see, and a cold lambda simply misses. It exists so a
// UI refresh does not re-read seven full tabs every few seconds. Deliberately
// not Redis/KV — a stale operator view for at most 45s is the correct trade,
// and nothing downstream (live reply polling, the nightly rebuild) shares it.
let operatorLeadsCache = null; // { at: epochMs, payload }

async function loadOperatorTables(repo) {
  const loaded = await Promise.all(OPERATOR_TABS.map((tab) => repo.getTable(tab)));
  return Object.fromEntries(OPERATOR_TABS.map((tab, i) => [tab, loaded[i]]));
}

async function handleOperatorLeads(req, res) {
  // Private, authenticated data: never shared-cacheable, never stored by a
  // proxy. The in-process cache above is the only caching layer.
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');

  const refresh = String(req.query?.refresh || '') === '1';
  const nowMs = Date.now();

  if (!refresh && operatorLeadsCache && nowMs - operatorLeadsCache.at < OPERATOR_LEADS_CACHE_TTL_MS) {
    return res.status(200).json({
      ...operatorLeadsCache.payload,
      cached: true,
      cache_age_ms: nowMs - operatorLeadsCache.at,
    });
  }

  try {
    const tables = await loadOperatorTables(getRepo());
    const built = buildOperatorLeads(tables, { now: new Date().toISOString() });
    const payload = {
      success: true,
      generated_at: built.generated_at,
      cache_ttl_ms: OPERATOR_LEADS_CACHE_TTL_MS,
      counts: built.counts,
      warnings: built.warnings,
      leads: built.leads,
    };
    operatorLeadsCache = { at: Date.now(), payload };
    return res.status(200).json({ ...payload, cached: false, cache_age_ms: 0 });
  } catch (err) {
    console.error('operator-leads error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Failed to build operator leads' });
  }
}

// SEND_DEMO execution gate, DRY RUN —
// GET /api/novus/personalisation?novus_operation=send-demo-dry-run&reply_event_id=...
// (also reachable via the /api/novus/instantly/send-demo-dry-run rewrite).
//
// READ-ONLY. It evaluates whether ONE REPLY_EVENTS row is eligible for an
// automatic in-thread demo reply and returns the exact request it WOULD make.
// It performs Google Sheets reads (REPLY_EVENTS, OUTBOUND) and one Instantly
// GET (the same bounded sweep the classifier uses — no new endpoint), and
// writes nothing anywhere: no Instantly reply, no REPLY_EVENTS update, no
// OUTBOUND write, no suppression.
//
// dryRun is not a query parameter. There is no request this operation can be
// sent that causes a send. The live operation is a SEPARATE, POST-only,
// secret-guarded operation and is not built yet.
async function handleSendDemoDryRun(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const replyEventId = (req.query?.reply_event_id || '').trim();
  if (!replyEventId) {
    return res.status(400).json({ success: false, error: 'Missing reply_event_id' });
  }

  const apiKey = process.env.INSTANTLY_REPLY_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      success: false,
      error: 'INSTANTLY_REPLY_API_KEY is not set in this environment.',
    });
  }

  try {
    const result = await evaluateSendDemoDryRun({ repo: getRepo(), replyEventId, apiKey });
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    // Never echo the API key, on any path.
    if (err?.instantly_status) {
      return res.status(502).json({
        success: false,
        error: 'Instantly API returned an error',
        instantly_status: err.instantly_status,
        instantly_error: err.instantly_error,
      });
    }
    console.error('send-demo-dry-run error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Send-demo dry run failed' });
  }
}

// SEND_DEMO execution, LIVE —
// POST /api/novus/personalisation?novus_operation=send-demo&reply_event_id=...
// (also reachable via the /api/novus/instantly/send-demo rewrite).
//
// THE ONLY OPERATION IN NOVUS THAT SENDS AN EMAIL TO A PROSPECT.
//
// It re-reads everything, re-runs the SAME execution gate the dry run runs, and
// sends at most ONE reply — POST /api/v2/emails/reply — for exactly one
// reply_event_id. A blocked event sends nothing and writes nothing.
//
// The only write is to the FOUR execution columns of that one REPLY_EVENTS row
// (action_status, action_completed_at, error, notes). It changes no
// outbound_status, writes no suppression, reclassifies nothing, touches no
// OUTBOUND row, and cannot reach a raw evidence column.
//
// FOUR gates stand in front of it, all before any Instantly read, any Sheets
// access and any send:
//   1. POST only — a GET can never reach this function.
//   2. The shared human Basic Auth.
//   3. The dedicated X-NOVUS-REPLY-POLLER-SECRET machine-action secret.
//   4. An explicit confirm=SEND_ONE_DEMO_REPLY, the same deliberate-action
//      convention the live Instantly outbound handoff already uses.
// 1-3 are enforced by the router before this function is entered.
//
// No other reply class is executable here: the gate refuses anything that is
// not POSITIVE_SEND_DEMO, so POSITIVE_MEETING, QUESTION, NOT_NOW,
// NOT_INTERESTED, OPT_OUT and OOO reach no send path at all.
async function handleSendDemoLive(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const replyEventId = (req.query?.reply_event_id || req.body?.reply_event_id || '').trim();
  if (!replyEventId) {
    return res.status(400).json({ success: false, error: 'Missing reply_event_id' });
  }

  const confirm = (req.query?.confirm || req.body?.confirm || '').trim();
  if (confirm !== SEND_DEMO_LIVE_CONFIRMATION) {
    return res.status(400).json({
      success: false,
      error: `Missing or incorrect confirmation; expected confirm=${SEND_DEMO_LIVE_CONFIRMATION}`,
    });
  }

  const apiKey = process.env.INSTANTLY_REPLY_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      success: false,
      error: 'INSTANTLY_REPLY_API_KEY is not set in this environment.',
    });
  }

  try {
    const result = await executeSendDemo({ repo: getRepo(), replyEventId, apiKey });
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    // Never echo the API key, on any path. A throw here means the send was
    // never attempted (input gathering failed) — executeSendDemo classifies
    // every send outcome internally rather than throwing.
    console.error('send-demo error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Send-demo execution failed' });
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'POST' && req.query?.novus_operation === 'verify-contact') {
    if (!requireAuth(req, res)) return;
    return handleContactVerification(req, res);
  }
  if (req.method === 'POST' && req.query?.novus_operation === 'resolve-contact') {
    if (!requireAuth(req, res)) return;
    return handleContactResolution(req, res);
  }
  if (req.method === 'GET' && req.query?.novus_operation === 'resolution-backlog') {
    if (!requireAuth(req, res)) return;
    return handleResolutionBacklog(req, res);
  }
  if (req.method === 'GET' && req.query?.novus_operation === 'instantly-replies-test') {
    if (!requireAuth(req, res)) return;
    return handleInstantlyRepliesTest(req, res);
  }
  if (req.method === 'GET' && req.query?.novus_operation === 'instantly-reply-poll-dry-run') {
    if (!requireAuth(req, res)) return;
    return handleInstantlyReplyPollDryRun(req, res);
  }
  if (req.method === 'GET' && req.query?.novus_operation === 'operator-leads') {
    // GET-only by construction: this branch is unreachable on any other
    // method, and the operation performs Sheets READS only.
    if (!requireAuth(req, res)) return;
    return handleOperatorLeads(req, res);
  }
  if (req.method === 'GET' && req.query?.novus_operation === 'reply-classifier-live-test') {
    if (!requireAuth(req, res)) return;
    return handleReplyClassifierLiveTest(req, res);
  }
  if (req.method === 'GET' && req.query?.novus_operation === 'send-demo-dry-run') {
    if (!requireAuth(req, res)) return;
    return handleSendDemoDryRun(req, res);
  }
  if (req.method === 'POST' && req.query?.novus_operation === 'instantly-reply-poll') {
    // TWO layers, in order, both before any Instantly or Sheets access: the
    // shared human Basic Auth, then the dedicated poller secret.
    if (!requireAuth(req, res)) return;
    if (!requireReplyPollerSecret(req, res)) return;
    return handleInstantlyReplyPoll(req, res);
  }
  if (req.method === 'POST' && req.query?.novus_operation === 'send-demo') {
    // TWO layers, in order, both before any Instantly read, any Sheets access
    // and any send: the shared human Basic Auth, then the dedicated machine
    // secret. The dry-run operation is deliberately NOT secret-guarded.
    if (!requireAuth(req, res)) return;
    if (!requireReplyPollerSecret(req, res)) return;
    return handleSendDemoLive(req, res);
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const probeId = (req.query?.probe_id || '').trim();
  const agencyId = (req.query?.agency_id || '').trim();
  if (!probeId && !agencyId) {
    return res.status(400).json({ error: 'Missing probe_id or agency_id' });
  }

  try {
    const repo = getRepo();

    if (probeId) {
      const record = await repo.findById('PERSONALISATION', 'probe_id', probeId);
      if (!record) return res.status(404).json({ error: 'No Personalisation found for this probe (probe may not be diagnosed yet)' });
      return res.status(200).json({ personalisation: record.obj });
    }

    const records = await repo.getRecords('PERSONALISATION', 'probe_id');
    const forAgency = records.filter((r) => r.obj.agency_id === agencyId);
    if (forAgency.length === 0) {
      return res.status(404).json({ error: 'No Personalisation found for this agency' });
    }
    forAgency.sort((a, b) => new Date(b.obj.created_at) - new Date(a.obj.created_at));
    return res.status(200).json({ personalisation: forAgency[0].obj });
  } catch (err) {
    console.error('personalisation (get) error:', err);
    return res.status(500).json({ error: err.message || 'Failed to fetch personalisation' });
  }
}
