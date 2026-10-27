// lib/auth-session.mjs — the NOVUS login page's server side: signed session
// cookies backed by a server-side session record, login rate limiting, logout,
// revocation and the same-origin (CSRF) rule for cookie-authenticated writes.
//
// HOW A LOGIN SESSION WORKS
//   · POST /api/novus/auth/login verifies the username/password — the admin
//     env credential (NOVUS_BASIC_AUTH_USER/PASS, constant-time) or an ACTIVE
//     USERS row, SETTER or ADMIN (scrypt, lib/novus-users.mjs) — and creates a random session
//     id with a SERVER-SIDE record in Redis (lib/kv.mjs).
//   · The browser gets one cookie, novus_session: HttpOnly, Secure,
//     SameSite=Lax, Path=/. Its value is a signed token
//     base64url({sid,uid,role,iat,exp}).HMAC-SHA256(NOVUS_SESSION_SECRET). It
//     carries no secret and no password; the signature only lets the Edge
//     middleware reject forgeries cheaply.
//   · A token is valid only while its Redis record exists. Logout, disabling
//     the account, changing its role and resetting its password delete the
//     records, so those take effect on the next request (see
//     revokeUserSessions).
//   · Expiry: absolute 12 hours from sign-in; idle 2 hours (the record's TTL
//     slides forward on use, never past the absolute limit).
//
// MACHINE CLIENTS (the GitHub campaign poller, the local Playwright worker)
// keep using the admin credential as HTTP Basic Auth — see api/novus/_auth.mjs.

import crypto from 'node:crypto';
import { kvStore } from './kv.mjs';
import { ADMIN_USER_ID, AccountsUnavailableError, adminCaller, findUserById, resolveUserCredential, normaliseUsername, verifyPassword, hashPassword, invalidateUsersCache, USERS_TAB } from './novus-users.mjs';

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
// null = this request has no valid session (→ 401, the page goes to login).
// THROWS SessionUnavailableError when the session store or the account store
// cannot be read: that is not a signed-out user and must never be answered
// with 401, which is what used to log Louis out on every Redis/Sheets blip.
export class SessionUnavailableError extends Error {
  constructor(cause) {
    super('NOVUS could not check your sign-in just now. Your session is still valid — try again in a moment.');
    this.name = 'SessionUnavailableError';
    this.code = 'SESSION_UNAVAILABLE';
    this.statusCode = 503;
    this.cause = cause;
  }
}
export const isUnavailableError = (err) => err instanceof SessionUnavailableError || err instanceof AccountsUnavailableError;

export async function resolveSessionCaller(req, { repo, kv = null, nowMs = Date.now() } = {}) {
  const token = sessionCookieOf(req);
  if (!token) return null;
  const payload = verifySessionToken(token, sessionSecret(), nowMs);
  if (!payload) return null;
  let store; try { store = kv || kvStore(); } catch (err) { throw new SessionUnavailableError(err); }
  let record = null;
  try { record = JSON.parse((await store.command(['GET', sessionKey(payload.sid)])) || 'null'); } catch (err) { throw new SessionUnavailableError(err); }
  if (!record || record.uid !== payload.uid || record.role !== payload.role) return null;
  let caller;
  // Only the env credential's sign-in carries uid 'admin'. Every USERS-row
  // account — SETTER or promoted ADMIN — is re-checked against its row, so a
  // promoted admin acts as themself (attribution, audit) and a demotion,
  // disable or reset refuses their old session.
  if (payload.role === 'ADMIN' && payload.uid === ADMIN_USER_ID) caller = adminCaller();
  else {
    let user;
    try { user = await findUserById(repo, payload.uid, nowMs); } catch (err) { throw new SessionUnavailableError(err); }
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

// Clears the per-username failure counter — an admin password reset and a
// successful password change both unlock the account at once.
export async function clearLoginFailures(username, { kv = null } = {}) {
  try { await (kv || kvStore()).command(['DEL', failUserKey(normaliseUsername(username))]); return true; } catch { return false; }
}

function clientIp(req) {
  return text(req.headers?.['x-real-ip']) || text(String(req.headers?.['x-forwarded-for'] || '').split(',')[0]) || 'unknown';
}

// A path inside NOVUS the caller may land on after sign-in.
export function safeNext(next, role) {
  // Everyone lands on Your Priorities (one shared workspace).
  if (role === 'SETTER') return /^\/novus\/(calling|priorities)(\.html)?([?#][^\s]*)?$/.test(text(next)) ? text(next) : '/novus/priorities.html';
  const n = text(next);
  if (/^\/novus\/[A-Za-z0-9._\-/]*(\?[^#\s]*)?(#[^\s]*)?$/.test(n) && !n.startsWith('//') && !/login/.test(n)) return n;
  return '/novus/priorities.html';
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
  const rawPassword = String(req.body?.password ?? '').slice(0, 256);
  // Account passwords never start or end with whitespace (generated ones are
  // base64url; chosen ones are refused with it), so trimming only removes
  // what a copy-paste from chat adds. The env admin's is compared as given.
  const password = rawPassword.trim();
  if (!username || !password) return res.status(400).json({ success: false, error: 'Enter your username and password.' });
  const uKey = failUserKey(username);
  const ipKey = failIpKey(clientIp(req));
  try {
    const [uFails, ipFails] = await Promise.all([store.command(['GET', uKey]), store.command(['GET', ipKey])]);
    const userLocked = Number(uFails) >= LOGIN_MAX_FAILS_PER_USER;
    if (userLocked || Number(ipFails) >= LOGIN_MAX_FAILS_PER_IP) {
      const ttl = Number(await store.command(['TTL', userLocked ? uKey : ipKey]).catch(() => -1));
      const seconds = ttl > 0 ? ttl : LOGIN_WINDOW_SECONDS;
      const minutes = Math.max(1, Math.ceil(seconds / 60));
      res.setHeader('Retry-After', String(seconds));
      return res.status(429).json({
        success: false, locked: true, retry_after_seconds: seconds,
        error: userLocked
          ? `Too many incorrect passwords for this account. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or ask an administrator to reset your password (that unlocks it straight away).`
          : `Too many failed sign-ins from this network. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      });
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
    const okPass = eq(rawPassword, adminPass);
    verifyPassword(password, DUMMY_HASH);
    if (okPass) caller = adminCaller();
  } else {
    try { caller = await resolveUserCredential(repo, { username, password }); }
    catch (err) {
      // USERS could not be read: say so, and do NOT count it as a failed
      // attempt — this is what used to lock out a correct password.
      if (err instanceof AccountsUnavailableError) {
        res.setHeader('Retry-After', '10');
        return res.status(503).json({ success: false, retryable: true, error: 'NOVUS could not check your account just now (the account store did not answer). Your password was not counted as wrong — try again in a few seconds.' });
      }
      caller = null;
    }
    if (!caller) verifyPassword(password, DUMMY_HASH);
  }
  if (!caller) {
    try {
      for (const key of [uKey, ipKey]) {
        const n = await store.command(['INCR', key]);
        if (Number(n) === 1) await store.command(['EXPIRE', key, LOGIN_WINDOW_SECONDS]);
      }
    } catch { /* counting failure never grants access */ }
    let left = null;
    try { left = Math.max(0, LOGIN_MAX_FAILS_PER_USER - Number(await store.command(['GET', uKey]) || 0)); } catch { /* unknown */ }
    return res.status(401).json({
      success: false, attempts_left: left,
      error: left === null || left > 2 ? 'Incorrect username or password.'
        : left === 0 ? 'Incorrect username or password. This account is now locked for 15 minutes — an administrator can reset your password to unlock it.'
        : `Incorrect username or password. ${left} attempt${left === 1 ? '' : 's'} left before a 15-minute lock.`,
    });
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

// ── POST auth-change-password ───────────────────────────────────────────────
// Self-service, for a signed-in USERS-row account (the env admin's password
// lives in Vercel env and is changed there). Needs the current password; the
// new one must be 12-256 characters with no leading/trailing whitespace.
// Every OTHER session of the account ends (password_set_at moves on), and
// this browser gets a fresh session so the person stays signed in here.
export const MIN_PASSWORD_LENGTH = 12;
export function validateNewPassword(value) {
  const p = String(value ?? '');
  if (p.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (p.length > 256) return 'Use at most 256 characters.';
  if (p !== p.trim()) return 'The password cannot start or end with a space.';
  return '';
}
export async function handleAuthChangePassword(req, res, { repo, kv = null } = {}) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
  const caller = req.novusUser;
  if (!caller || caller.via !== 'session') return res.status(401).json({ success: false, error: 'Sign in first.' });
  if (caller.user_id === ADMIN_USER_ID) return res.status(400).json({ success: false, error: 'The environment administrator password is set in Vercel (NOVUS_BASIC_AUTH_PASS), not here.' });
  const current = String(req.body?.current_password ?? '').trim();
  const next = String(req.body?.new_password ?? '');
  const problem = validateNewPassword(next);
  if (problem) return res.status(400).json({ success: false, error: problem });
  if (next === current) return res.status(400).json({ success: false, error: 'Choose a password different from the current one.' });
  const secret = sessionSecret();
  let store; try { store = kv || kvStore(); } catch { store = null; }
  if (!secret || !store) return res.status(503).json({ success: false, error: 'Sign-in is not configured on this deployment.' });
  let verified;
  try { verified = await resolveUserCredential(repo, { username: caller.username, password: current }); }
  catch (err) { if (err instanceof AccountsUnavailableError) return res.status(503).json({ success: false, retryable: true, error: err.message }); throw err; }
  if (!verified || verified.user_id !== caller.user_id) return res.status(400).json({ success: false, error: 'Your current password is not correct.' });
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  try {
    const updated = await repo.updateById(USERS_TAB, 'user_id', caller.user_id, { password_hash: hashPassword(next), password_set_at: now, updated_at: now });
    if (!updated) return res.status(404).json({ success: false, error: 'Account not found.' });
  } catch (err) {
    return res.status(503).json({ success: false, retryable: true, error: 'Could not save the new password just now. Your old password still works — try again.' });
  }
  invalidateUsersCache();
  try { await revokeUserSessions(caller.user_id, { kv: store }); } catch { /* password_set_at already refuses them */ }
  await clearLoginFailures(caller.username, { kv: store });
  // A fresh session for this browser, minted after password_set_at.
  const issuedMs = nowMs + 1;
  const nowS = Math.floor(issuedMs / 1000);
  const sid = crypto.randomBytes(24).toString('base64url');
  const payload = { sid, uid: caller.user_id, role: caller.role, iat: nowS, iat_ms: issuedMs, exp: nowS + SESSION_ABSOLUTE_SECONDS };
  try {
    await store.command(['SET', sessionKey(sid), JSON.stringify({ uid: caller.user_id, role: caller.role, created_at: now, last_seen: issuedMs, ua: text(req.headers?.['user-agent']).slice(0, 160) }), 'EX', SESSION_IDLE_SECONDS]);
    await store.command(['SADD', userSessionsKey(caller.user_id), sid]);
    await store.command(['EXPIRE', userSessionsKey(caller.user_id), SESSION_ABSOLUTE_SECONDS]);
    res.setHeader('Set-Cookie', cookieHeader(signSessionToken(payload, secret), SESSION_ABSOLUTE_SECONDS));
  } catch { return res.status(200).json({ success: true, signed_out: true, message: 'Password changed. Sign in again with your new password.' }); }
  return res.status(200).json({ success: true, message: 'Password changed. Other devices have been signed out.' });
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
