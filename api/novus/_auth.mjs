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
// requireReplyPollerSecret and requireCampaignPollerSecret below are SECOND,
// dedicated guards layered on top of Basic Auth, one per automated writer
// (REPLY_EVENTS; the campaign sync poller). See their comments.

import crypto from 'node:crypto';
import { getRepo } from '../../lib/sheets.mjs';
import { adminCaller, decodeBasic } from '../../lib/novus-users.mjs';
import { resolveSessionCaller, sessionCookieOf, sessionSecret, verifySessionToken } from '../../lib/auth-session.mjs';

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Returns true if the request is authorised AS THE ADMIN. If not, writes a
// 401 or 500 (if not configured) and returns false.
//
// Two ways to be the admin: the env credential as HTTP Basic Auth (machine
// clients: GitHub poller, Playwright worker), or an ADMIN login-page session
// cookie. The cookie is checked here synchronously (signature + expiry);
// its server-side record was already checked by middleware.js before this
// function was invoked, and personalisation.js re-checks it in full.
//
// The WWW-Authenticate challenge is sent only to non-browser clients: a
// browser (which always sends Sec-Fetch-Mode) must never get the native
// password prompt — its pages send the user to /novus/login.html instead.
export function requireAuth(req, res) {
  const session = verifySessionToken(sessionCookieOf(req), sessionSecret());
  if (session?.role === 'ADMIN') return true;
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
  if (!req.headers?.['sec-fetch-mode']) res.setHeader('WWW-Authenticate', 'Basic realm="NOVUS", charset="UTF-8"');
  res.status(401).json({ error: 'Authentication required' });
  return false;
}

// ---------------------------------------------------------------------------
// INDIVIDUAL ACCOUNTS (lib/novus-users.mjs, lib/auth-session.mjs). This
// resolves WHO is calling without deciding what they may do; the operation
// allowlist is enforced by the caller (api/novus/personalisation.js).
//   1. A login-page session cookie, fully validated: signature, expiry, the
//      server-side record (logout/revocation), and for a setter the USERS row
//      (ACTIVE, same role, password not reset since sign-in). It wins over
//      Basic Auth, so a browser that still caches the old admin Basic
//      credential never turns a setter's session into the admin.
//   2. The admin env credential as HTTP Basic Auth (machine clients).
// Setter accounts sign in ONLY through the login page; there is no setter
// Basic Auth path. Returns the caller, or null.
export function isAdminCredential(req) {
  const user = process.env.NOVUS_BASIC_AUTH_USER;
  const pass = process.env.NOVUS_BASIC_AUTH_PASS;
  if (!user || !pass) return false;
  const creds = decodeBasic(req.headers?.authorization);
  if (!creds) return false;
  const okUser = safeEqual(creds.username, user);
  const okPass = safeEqual(creds.password, pass);
  return okUser && okPass;
}

// The 401 for a request with no valid caller. Same challenge rule as above.
export function sendUnauthorized(req, res) {
  if (!req.headers?.['sec-fetch-mode']) res.setHeader('WWW-Authenticate', 'Basic realm="NOVUS", charset="UTF-8"');
  return res.status(401).json({ success: false, error: 'Authentication required', login: '/novus/login.html' });
}

export async function resolveCaller(req, { repo = null } = {}) {
  if (sessionCookieOf(req)) {
    const viaSession = await resolveSessionCaller(req, { repo: repo || getRepo() }).catch(() => null);
    if (viaSession) return viaSession;
  }
  if (isAdminCredential(req)) return { ...adminCaller(), via: 'basic' };
  return null;
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

// ---------------------------------------------------------------------------
// Dedicated guard for the automated CAMPAIGN sync poller
// (?novus_operation=campaign-sync-poll). Same shape and the same reasoning as
// requireReplyPollerSecret above: layered on top of Basic Auth, fails closed
// before getRepo() or any Instantly call, never echoes the secret.
//
// Instantly's Growth plan does not include webhooks (Hyper Growth only), so
// this operation — driven by an external scheduler roughly every 10-15
// minutes, e.g. a free GitHub Actions cron (see docs/EMAIL_CAMPAIGNS.md) — is
// the PRIMARY way campaign/lead/reply/bounce/unsubscribe state reaches NOVUS.
// The Instantly webhook endpoint (requireInstantlyWebhookSecret in
// lib/campaign-handlers.mjs) remains for a future Hyper Growth upgrade but is
// entirely optional: nothing here requires INSTANTLY_WEBHOOK_SECRET to be set.
export const CAMPAIGN_POLLER_SECRET_HEADER = 'x-novus-campaign-poller-secret';

export function requireCampaignPollerSecret(req, res) {
  const secret = process.env.NOVUS_CAMPAIGN_POLLER_SECRET;
  if (!secret) {
    res.status(500).json({
      success: false,
      error: 'NOVUS_CAMPAIGN_POLLER_SECRET is not set in this environment; the automated campaign sync poll is disabled. Manual Sync Now and the nightly reconciliation still work.',
    });
    return false;
  }

  const provided = req.headers?.[CAMPAIGN_POLLER_SECRET_HEADER]
    ?? req.headers?.['X-NOVUS-CAMPAIGN-POLLER-SECRET']
    ?? '';

  if (typeof provided === 'string' && provided && safeEqual(provided, secret)) return true;

  res.status(403).json({ success: false, error: 'Campaign poller secret missing or invalid' });
  return false;
}
