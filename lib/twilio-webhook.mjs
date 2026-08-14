// lib/twilio-webhook.mjs — shared request-level helpers for the Twilio
// voice/SMS webhook handlers. Kept in one place deliberately: signature
// verification is security-sensitive and must not drift between the three
// handlers (voice-inbound, voice-recording, sms-inbound).

import { verifyTwilioSignature } from './twilio-signature.mjs';

// Vercel Node functions auto-parse application/x-www-form-urlencoded bodies
// (what Twilio always sends) into req.body as a plain object. This only
// exists as a fallback for the rare case req.body arrives as a raw string.
export function parseTwilioBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) {
    return Object.fromEntries(new URLSearchParams(req.body));
  }
  return {};
}

// The exact public URL Twilio POSTed to — required for signature
// verification to match. Prefers an explicitly configured base URL
// (NOVUS_PUBLIC_BASE_URL) so verification never silently depends on
// forwarded-host headers; falls back to them only if it isn't set.
function publicUrlFor(req, pathname) {
  const configured = process.env.NOVUS_PUBLIC_BASE_URL;
  if (configured) return `${configured.replace(/\/$/, '')}${pathname}`;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}${pathname}`;
}

// Returns true if authorised; otherwise writes a 401/500 response and
// returns false. `pathname` is the route's own path, e.g.
// '/api/novus/webhooks/voice-inbound' (must match what's registered in Twilio).
export function requireTwilioSignature(req, res, pathname, body) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    res.status(500).json({ error: 'TWILIO_AUTH_TOKEN is not configured' });
    return false;
  }
  const signature = req.headers?.['x-twilio-signature'];
  const url = publicUrlFor(req, pathname);
  if (!verifyTwilioSignature({ authToken, url, params: body, signature })) {
    res.status(401).json({ error: 'Invalid or missing Twilio signature' });
    return false;
  }
  return true;
}

export function escapeXml(str) {
  return String(str ?? '').replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  }[c]));
}

export function sendTwiml(res, xmlBody) {
  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response>${xmlBody}</Response>`);
}
