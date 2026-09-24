// middleware.js — Vercel Edge Middleware.
//
// Gates the internal NOVUS surface (/novus/* pages and /api/novus/* endpoints).
// The public demo (/, /capture, /api/chat, /api/scrape) is NOT matched here and
// is completely unaffected.
//
// HOW PEOPLE SIGN IN (lib/auth-session.mjs). The branded page /novus/login.html
// posts to /api/novus/auth/login, which sets the novus_session cookie
// (HttpOnly, Secure, SameSite=Lax). Here, a request with that cookie is
// accepted when its HMAC signature and expiry verify (Web Crypto, with
// NOVUS_SESSION_SECRET) AND its server-side record still exists in the session
// store (Upstash REST, KV_REST_API_URL/TOKEN) — so logout, disabling an account
// and resetting its password take effect on the next request. Requests to
// /api/novus/personalisation skip the store lookup here only because that
// function performs the complete check itself (record + USERS row + role).
// A page request without a valid session is redirected to the login page; the
// browser's native password prompt is never triggered.
//
// ROLES. A SETTER session may load Calling Mode only (any other page redirects
// there) and no NOVUS function other than personalisation, which enforces its
// own deny-by-default allowlist (lib/novus-users.mjs SETTER_OPERATIONS).
//
// MACHINE CLIENTS keep the admin env credential as HTTP Basic Auth:
//   · APIs — the GitHub campaign poller (curl -u), unchanged.
//   · pages — the local Playwright worker, which ALSO sends X-NOVUS-Client:
//     worker (worker/src/browser.mjs). Pages require that header with Basic
//     Auth so that a person's browser still caching the old Basic login cannot
//     skip the login page or survive signing out.
//
// Webhooks (/api/novus/webhooks/*) are verified by provider signature and the
// Cron endpoint (/api/novus/intelligence/finalize) by NOVUS_CRON_SECRET, so
// both are skipped here, exactly as before.
//
// Env: NOVUS_BASIC_AUTH_USER, NOVUS_BASIC_AUTH_PASS, NOVUS_SESSION_SECRET,
//      KV_REST_API_URL, KV_REST_API_TOKEN

export const config = {
  matcher: ['/novus/:path*', '/api/novus/:path*'],
};

const SESSION_COOKIE = 'novus_session';
const LOGIN_PAGE = '/novus/login.html';
const PUBLIC_PAGES = new Set(['/novus/login', '/novus/login.html']);
const PUBLIC_API = new Set(['/api/novus/auth/login', '/api/novus/auth/logout']);
const SETTER_PAGES = new Set(['/novus/calling', '/novus/calling.html']);
// Stylesheets, scripts, images and fonts hold no NOVUS data (the repository is
// public); the login page needs them before anyone is signed in.
const STATIC_ASSET = /\.(css|js|png|svg|ico|woff2?)$/i;

function safeEqual(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cookieValue(req, name) {
  for (const part of String(req.headers.get('cookie') || '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return '';
}

const enc = new TextEncoder();
function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// Same token format as lib/auth-session.mjs signSessionToken.
async function verifyToken(token, secret) {
  if (!token || !secret || secret.length < 32) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  try {
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    if (!(await crypto.subtle.verify('HMAC', key, b64urlToBytes(sig), enc.encode(body)))) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
    if (!payload?.sid || !payload?.role || !(Number(payload.exp) * 1000 > Date.now())) return null;
    return payload;
  } catch { return null; }
}

// The server-side record (lib/auth-session.mjs sessionKey). Fails closed.
async function sessionRecordExists(payload) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  try {
    const r = await fetch(String(url).replace(/\/+$/, ''), {
      method: 'POST', cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['GET', `novus:auth:s:${payload.sid}`]),
    });
    if (!r.ok) return false;
    const record = JSON.parse((await r.json())?.result || 'null');
    return Boolean(record && record.uid === payload.uid && record.role === payload.role);
  } catch { return false; }
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export default async function middleware(req) {
  const url = new URL(req.url);
  const { pathname } = url;
  const isApi = pathname.startsWith('/api/');

  // Future webhook endpoints authenticate by provider signature, not Basic Auth.
  if (pathname.startsWith('/api/novus/webhooks')) return;

  // The probe-finalisation Cron endpoint authenticates by NOVUS_CRON_SECRET,
  // not Basic Auth — see api/novus/intelligence/finalize.js.
  if (pathname === '/api/novus/intelligence/finalize') return;

  // The login page, its sign-in/out calls and static assets.
  if (PUBLIC_API.has(pathname) || PUBLIC_PAGES.has(pathname)) return;
  if (!isApi && STATIC_ASSET.test(pathname)) return;

  const user = process.env.NOVUS_BASIC_AUTH_USER;
  const pass = process.env.NOVUS_BASIC_AUTH_PASS;
  if (!user || !pass) {
    return new Response('NOVUS auth not configured', { status: 500 });
  }

  // 1) A login-page session.
  const session = await verifyToken(cookieValue(req, SESSION_COOKIE), process.env.NOVUS_SESSION_SECRET || '');
  if (session) {
    const fullCheckDownstream = pathname === '/api/novus/personalisation';
    if (fullCheckDownstream || await sessionRecordExists(session)) {
      if (session.role === 'ADMIN') return;
      if (session.role === 'SETTER') {
        if (fullCheckDownstream || SETTER_PAGES.has(pathname)) return;
        if (isApi) return json(403, { success: false, error: 'Not available to your account' });
        return Response.redirect(new URL('/novus/calling.html', req.url), 302);
      }
    }
  }

  // 2) The admin machine credential (HTTP Basic Auth).
  const header = req.headers.get('authorization') || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    let decoded = '';
    try { decoded = atob(encoded); } catch { decoded = ''; }
    const sep = decoded.indexOf(':');
    const u = decoded.slice(0, sep);
    const p = decoded.slice(sep + 1);
    const okUser = safeEqual(u, user);
    const okPass = safeEqual(p, pass);
    if (okUser && okPass && (isApi || req.headers.get('x-novus-client') === 'worker')) return;
  }

  // 3) Not signed in.
  if (isApi) {
    // Only non-browser clients get the Basic challenge; a browser tab must
    // never see the native password prompt.
    const challenge = req.headers.get('sec-fetch-mode') ? {} : { 'WWW-Authenticate': 'Basic realm="NOVUS", charset="UTF-8"' };
    return json(401, { success: false, error: 'Authentication required', login: LOGIN_PAGE }, challenge);
  }
  const login = new URL(LOGIN_PAGE, req.url);
  login.searchParams.set('next', pathname + url.search);
  return Response.redirect(login, 302);
}
