// lib/auth-session.mjs — the NOVUS login page's server side: signed session
// cookies backed by a server-side session record, login rate limiting, logout,
// revocation and the same-origin (CSRF) rule for cookie-authenticated writes.
//
// HOW A LOGIN SESSION WORKS
//   · POST /api/novus/auth/login verifies the username/password — the admin
//     env credential (NOVUS_BASIC_AUTH_USER/PASS, constant-time) or an ACTIVE
//     USERS row (scrypt, lib/novus-users.mjs) — and creates a random session
//     id with a SERVER-SIDE record in Redis (lib/kv.mjs).
//   · The browser gets one cookie, novus_session: HttpOnly, Secure,
//     SameSite=Lax, Path=/. Its value is a signed token
//     base64url({sid,uid,role,iat,exp}).HMAC-SHA256(NOVUS_SESSION_SECRET). It
//     carries no secret and no password; the signature only lets the Edge
//     middleware reject forgeries cheaply.
//   · A token is valid only while its Redis record exists. Logout, disabling
//     the account and resetting its password delete the records, so those
//     take effect on the next request (see revokeUserSessions).
//   · Expiry: absolute 12 hours from sign-in; idle 2 hours (the record's TTL
//     slides forward on use, never past the absolute limit).
//
// MACHINE CLIENTS (the GitHub campaign poller, the local Playwright worker)
// keep using the admin credential as HTTP Basic Auth — see api/novus/_auth.mjs.

import crypto from 'node:crypto';
import { kvStore } from './kv.mjs';
import { adminCaller, findUserById, resolveUserCredential, normaliseUsername, verifyPassword, hashPassword } from './novus-users.mjs';

const text = (value) => String(value ?? '').trim();

export const SESSION_COOKIE = 'novus_session';
export const SESSION_ABSOLUTE_SECONDS = 12 * 3600;
export const SESSION_IDLE_SECONDS = 2 * 3600;
const TOUCH_EVERY_MS = 5 * 60_000;
export const LOGIN_WINDOW_SECONDS = 15 * 60;
export const LOGIN_MAX_FAILS_PER_USER = 5;
export const LOGIN_MAX_FAILS_PER_IP = 20;

const sessionKey = (sid) => `novus:auth:s:${sid}`;
const userSessionsKey = (uid) => `novus:auth:u:${uid}`;
const failUserKey = (u) => `novus:auth:fail:u:${crypto.createHash('sha256').update(u).digest('hex').slice(0, 32)}`;
const failIpKey = (ip) => `novus:auth:fail:ip:${crypto.createHash('sha256').update(ip).digest('hex').slice(0, 32)}`;

// ≥32 characters or sign-in is disabled (fail closed, never a weak default).
export function sessionSecret(env = process.env) {
  const s = text(env.NOVUS_SESSION_SECRET);
  return s.length >= 32 ? s : '';
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
function hmac(secret, data) { return crypto.createHmac('sha256', secret).update(data).digest('base64url'); }

export function signSessionToken(payload, secret) {
  const body = b64u(JSON.stringify(payload));
  return `${body}.${hmac(secret, body)}`;
}

// Signature + absolute expiry only. The server-side record is checked by
// resolveSessionCaller; this is also what the sync requireAuth uses.
export function verifySessionToken(token, secret, nowMs = Date.now()) {
  if (!secret) return null;
  const [body, sig] = text(token).split('.');
  if (!body || !sig) return null;
  const expected = Buffer.from(hmac(secret, body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  let payload = null;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload?.sid || !payload?.uid || !payload?.role || !(Number(payload.exp) * 1000 > nowMs)) return null;
  return payload;
}

export function parseCookies(header) {
  const out = {};
  for (const part of text(header).split(';')) {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}
export function sessionCookieOf(req) { return parseCookies(req.headers?.cookie)[SESSION_COOKIE] || ''; }

function cookieHeader(value, maxAge) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

// ── same-origin rule for writes ────────────────────────────────────────────
// A cookie-authenticated write must come from a NOVUS page: its Origin (or,
// failing that, Sec-Fetch-Site) must be this host. Non-browser clients send
// neither header and are only accepted with the Basic machine credential.
export function isSameOriginWrite(req, { basic = false } = {}) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || 'GET').toUpperCase())) return true;
  const host = text(req.headers?.['x-forwarded-host'] || req.headers?.host).toLowerCase();
  const origin = text(req.headers?.origin);
  if (origin) {
    try { return new URL(origin).host.toLowerCase() === host; } catch { return false; }
  }
  const site = text(req.headers?.['sec-fetch-site']).toLowerCase();
  if (site) return site === 'same-origin';
  return basic;
}

// ── resolve a request's login session ───────────────────────────────────────
export async function resolveSessionCaller(req, { repo, kv = null, nowMs = Date.now() } = {}) {
  const token = sessionCookieOf(req);
  if (!token) return null;
  const payload = verifySessionToken(token, sessionSecret(), nowMs);
  if (!payload) return null;
  let store; try { store = kv || kvStore(); } catch { return null; }
  let record = null;
  try { record = JSON.parse((await store.command(['GET', sessionKey(payload.sid)])) || 'null'); } catch { return null; }
  if (!record || record.uid !== payload.uid || record.role !== payload.role) return null;
  let caller;
  if (payload.role === 'ADMIN') caller = adminCaller();
  else {
    const user = await findUserById(repo, payload.uid, nowMs);
    // Disabled, role changed, or password reset after this sign-in → invalid.
    if (!user || user.status !== 'ACTIVE' || user.role !== payload.role) return null;
    // Millisecond precision: a sign-in in the same second as the account's
    // creation or reset is valid; one issued before the reset is not.
    if (Date.parse(user.password_set_at) > Number(payload.iat_ms ?? Number(payload.iat) * 1000)) return null;
    caller = { user_id: user.user_id, username: user.username, display_name: user.display_name, role: user.role };
  }
  // Sliding idle expiry, capped at the absolute expiry.
  if (nowMs - Number(record.last_seen || 0) > TOUCH_EVERY_MS) {
    const ttl = Math.max(1, Math.min(SESSION_IDLE_SECONDS, Math.floor(Number(payload.exp) - nowMs / 1000)));
    record.last_seen = nowMs;
    try { await store.command(['SET', sessionKey(payload.sid), JSON.stringify(record), 'EX', ttl]); } catch { /* best effort */ }
  }
  return { ...caller, sid: payload.sid, via: 'session', session_expires_at: new Date(Number(payload.exp) * 1000).toISOString() };
}

export async function revokeUserSessions(userId, { kv = null } = {}) {
  const store = kv || kvStore();
  const sids = (await store.command(['SMEMBERS', userSessionsKey(userId)])) || [];
  for (const sid of sids) await store.command(['DEL', sessionKey(sid)]);
  await store.command(['DEL', userSessionsKey(userId)]);
  return sids.length;
}

function clientIp(req) {
  return text(req.headers?.['x-real-ip']) || text(String(req.headers?.['x-forwarded-for'] || '').split(',')[0]) || 'unknown';
}

// A path inside NOVUS the caller may land on after sign-in.
export function safeNext(next, role) {
  if (role === 'SETTER') return '/novus/calling.html';
  const n = text(next);
  if (/^\/novus\/[A-Za-z0-9._\-/]*(\?[^#\s]*)?(#[^\s]*)?$/.test(n) && !n.startsWith('//') && !/login/.test(n)) return n;
  return '/novus/operator.html';
}

const DUMMY_HASH = hashPassword('novus-timing-equaliser');

// ── POST auth-login ─────────────────────────────────────────────────────────
export async function handleAuthLogin(req, res, { repo, kv = null } = {}) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
  if (!isSameOriginWrite(req)) return res.status(403).json({ success: false, error: 'Sign in from the NOVUS login page.' });
  const secret = sessionSecret();
  let store; try { store = kv || kvStore(); } catch { store = null; }
  if (!secret || !store) {
    return res.status(503).json({ success: false, error: 'Sign-in is not configured on this deployment (NOVUS_SESSION_SECRET / session store).' });
  }
  const username = normaliseUsername(req.body?.username).slice(0, 64);
  const password = String(req.body?.password ?? '').slice(0, 256);
  if (!username || !password) return res.status(400).json({ success: false, error: 'Enter your username and password.' });
  const uKey = failUserKey(username);
  const ipKey = failIpKey(clientIp(req));
  try {
    const [uFails, ipFails] = await Promise.all([store.command(['GET', uKey]), store.command(['GET', ipKey])]);
    if (Number(uFails) >= LOGIN_MAX_FAILS_PER_USER || Number(ipFails) >= LOGIN_MAX_FAILS_PER_IP) {
      res.setHeader('Retry-After', String(LOGIN_WINDOW_SECONDS));
      return res.status(429).json({ success: false, error: 'Too many sign-in attempts. Wait 15 minutes and try again.' });
    }
  } catch {
    return res.status(503).json({ success: false, error: 'Sign-in is temporarily unavailable. Try again shortly.' });
  }

  // Verify. The admin credential is compared in constant time; an unknown
  // username still runs one scrypt so response time does not reveal it.
  const adminUser = text(process.env.NOVUS_BASIC_AUTH_USER);
  const adminPass = String(process.env.NOVUS_BASIC_AUTH_PASS ?? '');
  const eq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  let caller = null;
  if (adminUser && adminPass && normaliseUsername(adminUser) === username) {
    const okPass = eq(password, adminPass);
    verifyPassword(password, DUMMY_HASH);
    if (okPass) caller = adminCaller();
  } else {
    caller = await resolveUserCredential(repo, { username, password }).catch(() => null);
    if (!caller) verifyPassword(password, DUMMY_HASH);
  }
  if (!caller) {
    try {
      for (const key of [uKey, ipKey]) {
        const n = await store.command(['INCR', key]);
        if (Number(n) === 1) await store.command(['EXPIRE', key, LOGIN_WINDOW_SECONDS]);
      }
    } catch { /* counting failure never grants access */ }
    return res.status(401).json({ success: false, error: 'Incorrect username or password.' });
  }

  const nowMs = Date.now();
  const nowS = Math.floor(nowMs / 1000);
  const sid = crypto.randomBytes(24).toString('base64url');
  const payload = { sid, uid: caller.user_id, role: caller.role, iat: nowS, iat_ms: nowMs, exp: nowS + SESSION_ABSOLUTE_SECONDS };
  const record = { uid: caller.user_id, role: caller.role, created_at: new Date(nowS * 1000).toISOString(), last_seen: Date.now(), ua: text(req.headers?.['user-agent']).slice(0, 160) };
  try {
    await store.command(['SET', sessionKey(sid), JSON.stringify(record), 'EX', SESSION_IDLE_SECONDS]);
    await store.command(['SADD', userSessionsKey(caller.user_id), sid]);
    await store.command(['EXPIRE', userSessionsKey(caller.user_id), SESSION_ABSOLUTE_SECONDS]);
    await store.command(['DEL', uKey]);
  } catch {
    return res.status(503).json({ success: false, error: 'Sign-in is temporarily unavailable. Try again shortly.' });
  }
  res.setHeader('Set-Cookie', cookieHeader(signSessionToken(payload, secret), SESSION_ABSOLUTE_SECONDS));
  return res.status(200).json({
    success: true,
    user: { user_id: caller.user_id, username: caller.username, display_name: caller.display_name, role: caller.role },
    redirect: safeNext(req.body?.next, caller.role),
    expires_at: new Date(payload.exp * 1000).toISOString(),
  });
}

// ── POST auth-logout ────────────────────────────────────────────────────────
// Always clears the cookie; deletes the server-side record when the token is
// genuine, so the same cookie value cannot be replayed afterwards.
export async function handleAuthLogout(req, res, { kv = null } = {}) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
  if (!isSameOriginWrite(req)) return res.status(403).json({ success: false, error: 'Sign out from a NOVUS page.' });
  const payload = verifySessionToken(sessionCookieOf(req), sessionSecret());
  if (payload) {
    try {
      const store = kv || kvStore();
      await store.command(['DEL', sessionKey(payload.sid)]);
      await store.command(['SREM', userSessionsKey(payload.uid), payload.sid]);
    } catch { /* the cookie is still cleared below */ }
  }
  res.setHeader('Set-Cookie', cookieHeader('', 0));
  return res.status(200).json({ success: true, redirect: '/novus/login.html' });
}

export const _internal = { sessionKey, userSessionsKey, cookieHeader };
