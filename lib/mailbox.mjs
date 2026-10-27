// lib/mailbox.mjs — each person's OWN connected inbox (Google Workspace /
// Gmail or Microsoft 365 / Outlook), used for one-to-one email sent from
// NOVUS. Cold-outreach campaigns are NOT here: they stay in Instantly
// (lib/instantly-*.mjs, lib/campaign-*.mjs) with Instantly's own sending
// accounts. See docs/MULTI_USER_OPERATIONS.md for the full split.
//
// WHAT IS STORED, WHERE. One record per NOVUS user in the session store
// (Redis, lib/kv.mjs) under `novus:mail:acct:<user_id>`: provider, address,
// status, timestamps, last error — and the OAuth tokens ENCRYPTED with
// AES-256-GCM under NOVUS_MAIL_TOKEN_KEY (32 bytes, base64 or hex), bound to
// the user id as associated data so a record copied onto another user cannot
// be decrypted. No password is ever asked for or stored; tokens never leave
// this module (publicAccount() is all any response sees).
//
// SCOPES (least privilege): sending only.
//   Google:    openid email profile + gmail.send
//   Microsoft: openid email profile offline_access + User.Read + Mail.Send
// NOVUS cannot read anyone's inbox with these. Replies land in the sender's
// own inbox as normal mail; they are not imported (see the docs).
//
// SENDER IDENTITY. A send uses the CALLER's own record and nothing else.
// There is no fallback account: no record, an expired grant or a provider
// error is reported to the person, never routed through someone else. One
// address can be connected by one NOVUS user only (`novus:mail:addr:<email>`).
//
// Env: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET,
//      MICROSOFT_OAUTH_CLIENT_ID, MICROSOFT_OAUTH_CLIENT_SECRET,
//      MICROSOFT_OAUTH_TENANT (default 'organizations'),
//      NOVUS_MAIL_TOKEN_KEY, NOVUS_MAIL_ALLOWED_DOMAINS (optional, comma list),
//      NOVUS_APP_ORIGIN (optional; else the request's own host).

import crypto from 'node:crypto';
import { kvStore } from './kv.mjs';

const text = (value) => String(value ?? '').trim();
const lower = (value) => text(value).toLowerCase();

export const MAIL_PROVIDERS = Object.freeze(['GOOGLE', 'MICROSOFT']);
export const MAIL_STATUSES = Object.freeze(['CONNECTED', 'NEEDS_RECONNECT', 'ERROR']);
export const OAUTH_CALLBACK_PATH = '/api/novus/mail/oauth/callback';
const STATE_TTL_SECONDS = 600;

const accountKey = (userId) => `novus:mail:acct:${text(userId)}`;
const addressKey = (email) => `novus:mail:addr:${crypto.createHash('sha256').update(lower(email)).digest('hex').slice(0, 40)}`;
const stateKey = (state) => `novus:mail:state:${text(state)}`;

// ── provider configuration ─────────────────────────────────────────────────
export function providerConfig(provider, env = process.env) {
  if (provider === 'GOOGLE') {
    const clientId = text(env.GOOGLE_OAUTH_CLIENT_ID);
    const clientSecret = text(env.GOOGLE_OAUTH_CLIENT_SECRET);
    return {
      provider, label: 'Google Workspace / Gmail', configured: Boolean(clientId && clientSecret), clientId, clientSecret,
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.send'],
      // offline + consent: always returns a refresh token, so a reconnect works.
      extraAuthParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    };
  }
  if (provider === 'MICROSOFT') {
    const tenant = text(env.MICROSOFT_OAUTH_TENANT) || 'organizations';
    const clientId = text(env.MICROSOFT_OAUTH_CLIENT_ID);
    const clientSecret = text(env.MICROSOFT_OAUTH_CLIENT_SECRET);
    return {
      provider, label: 'Microsoft 365 / Outlook', configured: Boolean(clientId && clientSecret), clientId, clientSecret,
      authUrl: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`,
      tokenUrl: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
      scopes: ['openid', 'email', 'profile', 'offline_access', 'https://graph.microsoft.com/User.Read', 'https://graph.microsoft.com/Mail.Send'],
      extraAuthParams: { prompt: 'select_account', response_mode: 'query' },
    };
  }
  return null;
}

export function mailSetupStatus(env = process.env) {
  const key = tokenKey(env);
  return {
    encryption_configured: Boolean(key),
    providers: MAIL_PROVIDERS.map((p) => { const c = providerConfig(p, env); return { provider: p, label: c.label, configured: c.configured }; }),
    allowed_domains: allowedDomains(env),
  };
}

export function allowedDomains(env = process.env) {
  return text(env.NOVUS_MAIL_ALLOWED_DOMAINS).split(',').map(lower).filter(Boolean);
}

// ── token encryption ───────────────────────────────────────────────────────
function tokenKey(env = process.env) {
  const raw = text(env.NOVUS_MAIL_TOKEN_KEY);
  if (!raw) return null;
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  return buf.length === 32 ? buf : null;
}

export function encryptTokens(tokens, userId, env = process.env) {
  const key = tokenKey(env);
  if (!key) throw new MailError('NOT_CONFIGURED', 'Email connections are not configured on this deployment (NOVUS_MAIL_TOKEN_KEY).');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`novus-mail:${text(userId)}`));
  const ct = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
}

export function decryptTokens(sealed, userId, env = process.env) {
  const key = tokenKey(env);
  if (!key) throw new MailError('NOT_CONFIGURED', 'Email connections are not configured on this deployment (NOVUS_MAIL_TOKEN_KEY).');
  const [v, iv, tag, ct] = text(sealed).split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new MailError('NEEDS_RECONNECT', 'The stored connection is unreadable. Reconnect your inbox.');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(`novus-mail:${text(userId)}`));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8'));
  } catch {
    throw new MailError('NEEDS_RECONNECT', 'The stored connection could not be decrypted (the encryption key changed?). Reconnect your inbox.');
  }
}

export class MailError extends Error {
  constructor(code, message, { status = null, detail = '' } = {}) {
    super(message);
    this.name = 'MailError';
    this.code = code;
    this.httpStatus = status;
    this.detail = detail;
  }
}

// ── HTTP (injectable for tests: NO real provider is ever called by a test) ─
let _fetch = null;
export function __setMailFetchForTests(fn) { _fetch = fn; }
const mailFetch = (...args) => (_fetch || globalThis.fetch)(...args);

async function postForm(url, params) {
  const res = await mailFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(params).toString() });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ── account records ────────────────────────────────────────────────────────
export function publicAccount(record) {
  if (!record) return null;
  return {
    user_id: text(record.user_id), provider: text(record.provider), email: text(record.email), display_name: text(record.display_name),
    status: text(record.status), connected_at: text(record.connected_at), updated_at: text(record.updated_at),
    last_sent_at: text(record.last_sent_at), last_error: text(record.last_error), last_error_at: text(record.last_error_at),
    scopes: Array.isArray(record.scopes) ? record.scopes : [],
  };
}

export async function readAccount(userId, { kv = null } = {}) {
  const raw = await (kv || kvStore()).command(['GET', accountKey(userId)]);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

async function writeAccount(record, { kv = null } = {}) {
  await (kv || kvStore()).command(['SET', accountKey(record.user_id), JSON.stringify(record)]);
  return record;
}

export async function markAccount(userId, patch, { kv = null } = {}) {
  const record = await readAccount(userId, { kv });
  if (!record) return null;
  return writeAccount({ ...record, ...patch, updated_at: new Date().toISOString() }, { kv });
}

export async function disconnectAccount(userId, { kv = null } = {}) {
  const store = kv || kvStore();
  const record = await readAccount(userId, { kv: store });
  if (!record) return { disconnected: false };
  // Best-effort revoke at Google (Microsoft grants are revoked by the user in
  // their account; the tokens are deleted here either way).
  if (record.provider === 'GOOGLE') {
    try {
      const tokens = decryptTokens(record.token, userId);
      const token = tokens.refresh_token || tokens.access_token;
      if (token) await mailFetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    } catch { /* deleting below is what matters */ }
  }
  await store.command(['DEL', accountKey(userId)]);
  if (record.email) {
    const owner = await store.command(['GET', addressKey(record.email)]);
    if (owner === text(userId)) await store.command(['DEL', addressKey(record.email)]);
  }
  return { disconnected: true, email: text(record.email), provider: text(record.provider) };
}

// ── OAuth: start ───────────────────────────────────────────────────────────
export function appOrigin(req, env = process.env) {
  const fixed = text(env.NOVUS_APP_ORIGIN).replace(/\/+$/, '');
  if (fixed) return fixed;
  const host = text(req.headers?.['x-forwarded-host'] || req.headers?.host).split(',')[0].trim();
  return `https://${host}`;
}

export function safeReturnTo(value) {
  const v = text(value);
  return /^\/novus\/[A-Za-z0-9._\-/]*(\?[^#\s]*)?(#[^\s]*)?$/.test(v) && !v.startsWith('//') && !/login/.test(v) ? v : '/novus/operator.html#settings';
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export async function startConnect({ user, sid, provider, origin, returnTo, kv = null, env = process.env }) {
  const config = providerConfig(provider, env);
  if (!config) throw new MailError('BAD_PROVIDER', 'Choose Google or Microsoft.');
  if (!config.configured) throw new MailError('NOT_CONFIGURED', `${config.label} sign-in is not set up on this deployment yet (an administrator must add the OAuth client in Vercel).`);
  if (!tokenKey(env)) throw new MailError('NOT_CONFIGURED', 'Email connections are not configured on this deployment (NOVUS_MAIL_TOKEN_KEY).');
  const state = b64u(crypto.randomBytes(24));
  const verifier = b64u(crypto.randomBytes(32));
  const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
  const redirectUri = `${origin}${OAUTH_CALLBACK_PATH}`;
  await (kv || kvStore()).command(['SET', stateKey(state), JSON.stringify({
    user_id: text(user.user_id), sid: text(sid), provider, verifier, redirect_uri: redirectUri, return_to: safeReturnTo(returnTo), created_at: new Date().toISOString(),
  }), 'EX', STATE_TTL_SECONDS]);
  const params = new URLSearchParams({
    client_id: config.clientId, redirect_uri: redirectUri, response_type: 'code', scope: config.scopes.join(' '),
    state, code_challenge: challenge, code_challenge_method: 'S256', ...config.extraAuthParams,
  });
  return { url: `${config.authUrl}?${params.toString()}`, redirect_uri: redirectUri, state };
}

// ── OAuth: callback ────────────────────────────────────────────────────────
async function fetchIdentity(provider, accessToken) {
  const url = provider === 'GOOGLE' ? 'https://openidconnect.googleapis.com/v1/userinfo' : 'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName';
  const res = await mailFetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new MailError('IDENTITY_FAILED', 'Connected, but the provider would not say which address this is. Try again.');
  if (provider === 'GOOGLE') {
    if (data.email_verified === false) throw new MailError('UNVERIFIED', 'That Google address is not verified.');
    return { email: lower(data.email), display_name: text(data.name) };
  }
  return { email: lower(data.mail || data.userPrincipalName), display_name: text(data.displayName) };
}

// Returns { record, return_to } or throws MailError. `user` is the signed-in
// caller of the callback request — it must be the person who started it.
export async function completeConnect({ user, sid, state, code, kv = null, env = process.env, nowIso = new Date().toISOString() }) {
  const store = kv || kvStore();
  const raw = text(state) ? await store.command(['GET', stateKey(state)]) : null;
  if (!raw) throw new MailError('STATE_EXPIRED', 'That connection attempt expired or was already used. Start again from Settings → Email accounts.');
  await store.command(['DEL', stateKey(state)]); // single use
  const pending = JSON.parse(raw);
  if (pending.user_id !== text(user?.user_id) || (pending.sid && pending.sid !== text(sid))) {
    throw new MailError('WRONG_USER', 'This connection was started by a different NOVUS sign-in. Start again while signed in as yourself.');
  }
  const config = providerConfig(pending.provider, env);
  if (!config?.configured) throw new MailError('NOT_CONFIGURED', 'Email sign-in is not set up on this deployment.');
  if (!text(code)) throw new MailError('DENIED', 'The provider did not grant access.');
  const token = await postForm(config.tokenUrl, {
    grant_type: 'authorization_code', code: text(code), redirect_uri: pending.redirect_uri,
    client_id: config.clientId, client_secret: config.clientSecret, code_verifier: pending.verifier,
  });
  if (!token.ok || !token.data.access_token) throw new MailError('TOKEN_FAILED', 'The provider refused the connection. Try again.', { detail: text(token.data.error) });
  if (!token.data.refresh_token) throw new MailError('NO_REFRESH', 'The provider did not grant offline access, so NOVUS could not keep the connection. Remove NOVUS from your account\'s connected apps and try again.');
  const granted = text(token.data.scope).split(/\s+/).filter(Boolean);
  const sendScope = pending.provider === 'GOOGLE' ? 'https://www.googleapis.com/auth/gmail.send' : 'Mail.Send';
  if (granted.length && !granted.some((s) => s === sendScope || s.endsWith(`/${sendScope}`))) {
    throw new MailError('SCOPE_MISSING', 'Permission to send email was not granted. Connect again and allow sending.');
  }
  const identity = await fetchIdentity(pending.provider, token.data.access_token);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(identity.email)) throw new MailError('IDENTITY_FAILED', 'The provider did not return an email address.');
  const domains = allowedDomains(env);
  if (domains.length && !domains.includes(identity.email.split('@')[1])) {
    throw new MailError('DOMAIN_NOT_ALLOWED', `Only company inboxes can be connected (${domains.join(', ')}). ${identity.email} is not one.`);
  }
  // One mailbox ↔ one NOVUS user: never two people sending as one address.
  const holder = await store.command(['GET', addressKey(identity.email)]);
  if (holder && holder !== text(user.user_id)) {
    const holderRecord = await readAccount(holder, { kv: store });
    if (holderRecord && lower(holderRecord.email) === identity.email) {
      throw new MailError('ADDRESS_IN_USE', `${identity.email} is already connected by another NOVUS user. Each person connects their own inbox.`);
    }
  }
  const previous = await readAccount(user.user_id, { kv: store });
  if (previous?.email && lower(previous.email) !== identity.email) {
    const prevHolder = await store.command(['GET', addressKey(previous.email)]);
    if (prevHolder === text(user.user_id)) await store.command(['DEL', addressKey(previous.email)]);
  }
  const record = {
    user_id: text(user.user_id), provider: pending.provider, email: identity.email, display_name: identity.display_name || text(user.display_name),
    status: 'CONNECTED', scopes: granted.length ? granted : config.scopes, connected_at: nowIso, updated_at: nowIso,
    last_sent_at: previous?.last_sent_at || '', last_error: '', last_error_at: '',
    token: encryptTokens({ refresh_token: token.data.refresh_token, access_token: token.data.access_token, expires_at: Date.now() + (Number(token.data.expires_in) || 3600) * 1000 }, user.user_id, env),
  };
  await writeAccount(record, { kv: store });
  await store.command(['SET', addressKey(identity.email), text(user.user_id)]);
  return { record, return_to: pending.return_to };
}

// ── access tokens ──────────────────────────────────────────────────────────
async function accessTokenFor(record, { kv = null, env = process.env } = {}) {
  const tokens = decryptTokens(record.token, record.user_id, env);
  if (tokens.access_token && Number(tokens.expires_at) > Date.now() + 60_000) return tokens.access_token;
  const config = providerConfig(record.provider, env);
  if (!config?.configured) throw new MailError('NOT_CONFIGURED', 'Email sign-in is not set up on this deployment.');
  const refreshed = await postForm(config.tokenUrl, {
    grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: config.clientId, client_secret: config.clientSecret,
    ...(record.provider === 'MICROSOFT' ? { scope: config.scopes.join(' ') } : {}),
  });
  if (!refreshed.ok || !refreshed.data.access_token) {
    const code = text(refreshed.data.error);
    if (code === 'invalid_grant' || refreshed.status === 400 || refreshed.status === 401) {
      throw new MailError('NEEDS_RECONNECT', 'Your inbox connection has expired or was revoked. Reconnect it in Settings → Email accounts.', { detail: code });
    }
    throw new MailError('PROVIDER_UNAVAILABLE', 'The email provider did not answer. Nothing was sent — try again shortly.', { detail: code });
  }
  const next = {
    // Microsoft rotates refresh tokens; Google keeps the original.
    refresh_token: refreshed.data.refresh_token || tokens.refresh_token,
    access_token: refreshed.data.access_token,
    expires_at: Date.now() + (Number(refreshed.data.expires_in) || 3600) * 1000,
  };
  await writeAccount({ ...record, token: encryptTokens(next, record.user_id, env), updated_at: new Date().toISOString() }, { kv });
  return next.access_token;
}

// ── message building ───────────────────────────────────────────────────────
const headerSafe = (value) => text(value).replace(/[\r\n]+/g, ' ');
function encodeHeaderWord(value) {
  const v = headerSafe(value);
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}
function addressHeader(name, email) {
  const n = headerSafe(name).replace(/["\\]/g, '');
  return n ? `${encodeHeaderWord(`"${n}"`)} <${headerSafe(email)}>` : `<${headerSafe(email)}>`;
}

export function buildMimeMessage({ from, fromName, to, cc = [], subject, body, messageId }) {
  const lines = [
    `From: ${addressHeader(fromName, from)}`,
    `To: ${to.map((a) => `<${headerSafe(a)}>`).join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.map((a) => `<${headerSafe(a)}>`).join(', ')}`] : []),
    `Subject: ${encodeHeaderWord(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    `X-NOVUS-Message-Id: ${headerSafe(messageId)}`,
    '',
    Buffer.from(String(body).replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n'),
  ];
  return lines.join('\r\n');
}

// The send request itself. If the connection drops after the request left,
// the provider may have sent it — that is UNCONFIRMED, never "retry freely".
async function sendRequest(url, init) {
  try { return await mailFetch(url, init); }
  catch { throw new MailError('UNCONFIRMED', 'The connection to the email provider dropped while sending. The email MAY have been sent — check your Sent folder before trying again.'); }
}

// Sends through the caller's own mailbox. Returns
// { provider, provider_message_id, provider_thread_id, accepted_at }.
export async function sendViaMailbox(record, { to, cc = [], subject, body, messageId }, { kv = null, env = process.env } = {}) {
  if (!record || text(record.status) === 'NEEDS_RECONNECT') throw new MailError('NEEDS_RECONNECT', 'Reconnect your inbox in Settings → Email accounts before sending.');
  const accessToken = await accessTokenFor(record, { kv, env });
  const acceptedAt = new Date().toISOString();
  if (record.provider === 'GOOGLE') {
    const raw = Buffer.from(buildMimeMessage({ from: record.email, fromName: record.display_name, to, cc, subject, body, messageId })).toString('base64url');
    const res = await sendRequest('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) throw new MailError(res.status === 401 ? 'NEEDS_RECONNECT' : 'PROVIDER_REFUSED', res.status === 401 ? 'Gmail rejected the connection. Reconnect your inbox.' : `Gmail refused the send: ${text(data?.error?.message) || 'permission denied'}.`, { status: res.status });
    if (!res.ok || !data.id) throw new MailError('PROVIDER_REFUSED', `Gmail did not accept the email: ${text(data?.error?.message) || `HTTP ${res.status}`}.`, { status: res.status });
    return { provider: 'GOOGLE', provider_message_id: text(data.id), provider_thread_id: text(data.threadId), accepted_at: acceptedAt };
  }
  if (record.provider === 'MICROSOFT') {
    const res = await sendRequest('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject: headerSafe(subject), body: { contentType: 'Text', content: String(body) },
          toRecipients: to.map((address) => ({ emailAddress: { address } })),
          ccRecipients: cc.map((address) => ({ emailAddress: { address } })),
          internetMessageHeaders: [{ name: 'X-NOVUS-Message-Id', value: headerSafe(messageId) }],
        },
        saveToSentItems: true,
      }),
    });
    if (res.status === 401) throw new MailError('NEEDS_RECONNECT', 'Outlook rejected the connection. Reconnect your inbox.', { status: 401 });
    if (res.status !== 202 && !res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new MailError('PROVIDER_REFUSED', `Outlook did not accept the email: ${text(data?.error?.message) || `HTTP ${res.status}`}.`, { status: res.status });
    }
    // Graph's sendMail answers 202 with no id; the X-NOVUS-Message-Id header
    // on the message (visible in Sent Items) is the cross-reference.
    return { provider: 'MICROSOFT', provider_message_id: '', provider_thread_id: '', accepted_at: acceptedAt };
  }
  throw new MailError('BAD_PROVIDER', 'Unknown email provider on this connection. Reconnect your inbox.');
}

export const _internal = { accountKey, addressKey, stateKey, tokenKey };
