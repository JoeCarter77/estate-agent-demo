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
