// api/novus/_auth.mjs — HTTP Basic Auth guard for NOVUS human-facing endpoints.
//
// This is the same credential the Edge middleware enforces on the /novus pages.
// Enforcing it here too is defence-in-depth: the Google Sheets write path stays
// protected even if the middleware is ever misconfigured or bypassed.
//
// HUMAN auth (this file + middleware.js) is intentionally SEPARATE from future
// WEBHOOK auth (Twilio signatures, Gmail push tokens). Webhooks are public
// endpoints verified by provider signature — never by this shared password — and
// must live under /api/novus/webhooks/*, which is excluded from Basic Auth.
//
// Env: NOVUS_BASIC_AUTH_USER, NOVUS_BASIC_AUTH_PASS
//
// requireReplyPollerSecret below is a SECOND, dedicated guard layered on top of
// Basic Auth for the one operation that writes REPLY_EVENTS. See its comment.

import crypto from 'node:crypto';

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Returns true if the request is authorised. If not, writes a 401 (with the
// WWW-Authenticate challenge) or 500 (if not configured) and returns false.
export function requireAuth(req, res) {
  const user = process.env.NOVUS_BASIC_AUTH_USER;
  const pass = process.env.NOVUS_BASIC_AUTH_PASS;
  if (!user || !pass) {
    res.status(500).json({ error: 'NOVUS auth not configured (NOVUS_BASIC_AUTH_USER/PASS)' });
    return false;
  }
  const header = req.headers?.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const u = decoded.slice(0, sep);
    const p = decoded.slice(sep + 1);
    // Compare both, always, to avoid short-circuit timing leaks.
    const okUser = safeEqual(u, user);
    const okPass = safeEqual(p, pass);
    if (okUser && okPass) return true;
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="NOVUS", charset="UTF-8"');
  res.status(401).json({ error: 'Authentication required' });
  return false;
}


// ---------------------------------------------------------------------------
// Dedicated guard for the LIVE reply poller (the only operation that appends
// REPLY_EVENTS). Layered ON TOP of requireAuth, never instead of it: Basic Auth
// is a shared human credential held by anyone who can open the /novus pages,
// which is too broad a key for an endpoint that writes.
//
// FAILS CLOSED. It runs before the Instantly API key is read, before getRepo(),
// and therefore before any Instantly request or any Google Sheets read or
// write. A missing env secret, a missing header or a wrong header all return
// without touching a single external system.
//
// The dry-run operation deliberately does NOT require this: it writes nothing.
//
// The secret is NEVER echoed into a response and NEVER logged — not on the
// success path, not in an error, not in a length or prefix hint. The failure
// responses below are deliberately identical whether the header was absent or
// wrong, so a caller learns nothing from the difference.
export const REPLY_POLLER_SECRET_HEADER = 'x-novus-reply-poller-secret';

export function requireReplyPollerSecret(req, res) {
  const secret = process.env.NOVUS_REPLY_POLLER_SECRET;
  if (!secret) {
    // Config error, not an auth failure — but still fails closed.
    res.status(500).json({
      success: false,
      error: 'NOVUS_REPLY_POLLER_SECRET is not set in this environment; the live reply poller is disabled.',
    });
    return false;
  }

  // Node lowercases incoming header names; the fallback covers any caller that
  // hands us a raw, unnormalised header bag.
  const provided = req.headers?.[REPLY_POLLER_SECRET_HEADER]
    ?? req.headers?.['X-NOVUS-REPLY-POLLER-SECRET']
    ?? '';

  if (typeof provided === 'string' && provided && safeEqual(provided, secret)) return true;

  res.status(403).json({ success: false, error: 'Reply poller secret missing or invalid' });
  return false;
}
