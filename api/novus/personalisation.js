// api/novus/personalisation.js — GET /api/novus/personalisation?probe_id=...
//                                 GET /api/novus/personalisation?agency_id=...
//                                 POST /api/novus/contacts/verify (via rewrite)
//                                 POST /api/novus/contacts/resolve (via rewrite)
//                                 GET  /api/novus/instantly/replies-test (via rewrite)
//                                 GET  /api/novus/instantly/reply-poll-dry-run (via rewrite)
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
import { requireAuth } from './_auth.mjs';
import { pollInstantlyReplies } from '../../lib/instantly-reply-poll.mjs';

// Contact resolution can run owner web research, a Hunter Finder lookup and
// several Hunter Verifier checks in one invocation; 20s was sized for the read-only
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
async function handleResolutionBacklog(req, res) {
  try {
    const includeResolved = String(req.query?.include_resolved || '') === 'true';
    const agencies = await listResolutionBacklog(getRepo(), { includeResolved });
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
    const summary = await pollInstantlyReplies({ repo: getRepo(), apiKey, limit, dryRun: true });
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
