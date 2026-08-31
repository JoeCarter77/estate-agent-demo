// api/instant/replies-test.js — GET /api/instant/replies-test
//
// READ-ONLY connectivity test for the Instantly reply router. It performs a
// single GET against Instantly API V2's /emails collection and returns a
// simplified view of what came back. It sends nothing, updates no lead,
// pauses nothing, and touches no Google Sheet.
//
// This is deliberately separate from the existing OUTBOUND handoff
// (lib/instantly-outbound.mjs), which is a WRITE path using INSTANTLY_API_KEY.
// This endpoint uses its own credential, INSTANTLY_REPLY_API_KEY.
//
// AUTH: /api/instant/* is NOT covered by the Edge middleware matcher (which
// only gates /novus/* and /api/novus/*), so this handler enforces the same
// NOVUS Basic Auth credential itself rather than sitting on the public
// internet. See api/novus/_auth.mjs.
//
// Env: INSTANTLY_REPLY_API_KEY (plus NOVUS_BASIC_AUTH_USER/PASS for access)

import { requireAuth } from '../novus/_auth.mjs';

const INSTANTLY_EMAILS_URL = 'https://api.instantly.ai/api/v2/emails';
const DEFAULT_LIMIT = 20;

// Instantly's response shape is not guaranteed here (no campaign has run yet),
// so every read is defensive: unknown envelope, unknown field names, unknown
// nesting. Nothing below assumes a field exists.
function pick(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function asArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['items', 'data', 'emails', 'results', 'records']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function preview(value, max = 300) {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function bodyPreview(email) {
  const body = pick(email, 'body', 'content', 'message');
  if (typeof body === 'string') return preview(body);
  if (body && typeof body === 'object') {
    return preview(pick(body, 'text', 'plain', 'html'));
  }
  return preview(pick(email, 'body_text', 'text', 'content_preview', 'snippet', 'preview'));
}

function simplify(email) {
  if (!email || typeof email !== 'object') return { raw_type: typeof email };
  return {
    id: pick(email, 'id', 'email_id', '_id'),
    timestamp: pick(email, 'timestamp', 'timestamp_created', 'timestamp_email', 'created_at', 'date'),
    subject: pick(email, 'subject'),
    from: pick(email, 'from_address_email', 'from_address', 'from', 'from_email'),
    to: pick(email, 'to_address_email_list', 'to_address_email', 'to_address', 'to', 'to_email'),
    lead_email: pick(email, 'lead', 'lead_email', 'email'),
    lead_id: pick(email, 'lead_id', 'leadId'),
    campaign_id: pick(email, 'campaign_id', 'campaign', 'campaignId'),
    thread_id: pick(email, 'thread_id', 'threadId'),
    is_unread: pick(email, 'is_unread', 'unread'),
    is_auto_reply: pick(email, 'is_auto_reply', 'auto_reply', 'ai_interest_status_auto_reply'),
    body_preview: bodyPreview(email),
  };
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ success: false, error: 'Method not allowed. Use GET.' });
    return;
  }

  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const apiKey = process.env.INSTANTLY_REPLY_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      success: false,
      error: 'INSTANTLY_REPLY_API_KEY is not set in this environment.',
    });
    return;
  }

  const url = `${INSTANTLY_EMAILS_URL}?limit=${DEFAULT_LIMIT}`;

  let response;
  let text;
  try {
    response = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });
    text = await response.text();
  } catch (err) {
    // Network/transport failure — never echo the key back.
    res.status(502).json({
      success: false,
      error: 'Request to Instantly failed',
      message: String(err?.message || err),
    });
    return;
  }

  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    res.status(response.status === 401 || response.status === 403 ? response.status : 502).json({
      success: false,
      error: 'Instantly API returned an error',
      instantly_status: response.status,
      instantly_error:
        pick(payload, 'error', 'message', 'detail') ?? preview(text, 500) ?? '(empty response body)',
    });
    return;
  }

  const items = asArray(payload);

  res.status(200).json({
    success: true,
    count: items.length,
    emails: items.map(simplify),
  });
}
