// lib/novus-users.mjs — individual NOVUS accounts layered onto the existing
// HTTP Basic Auth gate (middleware.js + api/novus/_auth.mjs).
//
// WHAT STAYS THE SAME. The administrator is still the one env credential
// (NOVUS_BASIC_AUTH_USER / NOVUS_BASIC_AUTH_PASS). It is checked first, with
// no Sheets read, exactly as before — so the admin login cannot be broken by
// anything in this file or in the USERS tab.
//
// WHAT IS NEW. Additional, restricted accounts (role SETTER) live in the
// USERS tab of the existing workbook. Passwords are never stored: each row
// carries a salted scrypt hash. Passwords are generated server-side (high
// entropy, so no lockout is needed to resist guessing), returned ONCE in the
// admin's create/reset response, and never logged or written anywhere else.
//
// DENY BY DEFAULT. A setter may call only the operations in
// SETTER_OPERATIONS. Every other operation — and every other NOVUS function
// (probe.js, intelligence/rebuild-all.js) — still runs the original,
// admin-only requireAuth, so anything added later is admin-only unless it is
// deliberately put on this list.
//
// REVOCATION. Setting a user's status to DISABLED (or resetting the
// password) takes effect on the next USERS read: at most USERS_CACHE_TTL_MS
// on a warm instance, immediately on a cold one.

import crypto from 'node:crypto';

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();

export const USERS_TAB = 'USERS';
export const USERS_HEADER = Object.freeze([
  'user_id', 'username', 'display_name', 'role', 'status', 'password_hash',
  'password_set_at', 'created_at', 'updated_at', 'disabled_at', 'notes',
]);
export const USERS_SCHEMA_NOTE = 'One row per non-admin NOVUS login. password_hash is salted scrypt; plaintext passwords are never stored. The admin login is the NOVUS_BASIC_AUTH_USER/PASS env credential and has no row here. Manage from Calling analytics → Team (admin only); do not edit hashes by hand.';

export const ROLES = Object.freeze(['ADMIN', 'SETTER']);
export const USER_STATUSES = Object.freeze(['ACTIVE', 'DISABLED']);
// The identity every pre-existing, unattributed CALLS/ACTIONS row belongs to.
// Nothing historical is rewritten: a row with no user_id simply reads as this.
export const ADMIN_USER_ID = 'admin';

// The only operations a SETTER may reach. Everything here is Calling Mode:
// reading his queue, dialling, saving outcomes (callbacks and booked meetings
// are outcomes), reviewing his own call actions, answering an inbound call,
// his own analytics, the read-only email history of a lead he is calling, and
// ⌘K lead search (how an inbound caller is linked to a lead).
// Deliberately absent: calling-setup, calling-repair, script-*, objection-*,
// every campaign-*, operator-*, discovery-*, send-*, contact
// resolution and the team-* admin operations.
export const SETTER_OPERATIONS = Object.freeze(new Set([
  'whoami',
  'calling-workspace', 'calling-analytics', 'calling-recording', 'calling-inbound', 'twilio-token',
  'calling-start', 'calling-save', 'calling-discard', 'calling-action-review', 'calling-inbound-intent',
  'operator-conversation', 'lead-search',
  // Any agency's calling profile — contacts, calls, probe, email activity,
  // open work, meeting history — read-only and narrowed; queue membership is
  // not required to read it (lib/lead-timeline.mjs buildCallingProfile).
  'calling-lead-profile',
  // His own calling-session timer and performance (lib/call-session-handlers
  // scopes each of these to the caller). Correct/approve are admin-only.
  'call-session-current', 'call-session-start', 'call-session-pause', 'call-session-resume',
  'call-session-end', 'call-session-heartbeat', 'call-performance', 'call-session-detail',
]));

// The only /novus pages a setter's browser may load (middleware.js).
export const SETTER_PAGES = Object.freeze(['/novus/calling', '/novus/calling.html']);

// ── password hashing ───────────────────────────────────────────────────────
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function hashPassword(password, salt = crypto.randomBytes(16)) {
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const parts = text(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  if (!expected.length) return false;
  try {
    const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
    return crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

// 18 random bytes → 24 url-safe characters (~144 bits). Never logged.
export function generatePassword() {
  return crypto.randomBytes(18).toString('base64url');
}

export function newUserId() {
  return `usr_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

export function normaliseUsername(value) {
  return text(value).toLowerCase();
}

export function validateUsername(username, adminUsername = process.env.NOVUS_BASIC_AUTH_USER) {
  const u = normaliseUsername(username);
  if (!/^[a-z][a-z0-9._-]{2,31}$/.test(u)) return 'Username must be 3-32 characters: lowercase letters, digits, dot, dash or underscore, starting with a letter';
  if (adminUsername && u === normaliseUsername(adminUsername)) return 'That username is the administrator login';
  if (u === ADMIN_USER_ID) return 'That username is reserved';
  return '';
}

// ── USERS rows ─────────────────────────────────────────────────────────────
export function userRecords(table) {
  const header = table?.header || [];
  const idIndex = header.indexOf('user_id');
  if (idIndex < 0) return [];
  return (table.rows || []).flatMap((row, index) => {
    const id = text(row[idIndex]);
    if (!id || id === 'SCHEMA NOTE') return [];
    return [{ rowNumber: index + 2, obj: Object.fromEntries(header.map((key, i) => [key, row[i] ?? ''])) }];
  });
}

// What any response may say about a user. Never the hash.
export function publicUser(row) {
  return {
    user_id: text(row.user_id), username: text(row.username), display_name: text(row.display_name) || text(row.username),
    role: upper(row.role), status: upper(row.status), password_set_at: text(row.password_set_at),
    created_at: text(row.created_at), updated_at: text(row.updated_at), disabled_at: text(row.disabled_at),
  };
}

export function adminCaller(env = process.env) {
  return { user_id: ADMIN_USER_ID, username: text(env.NOVUS_BASIC_AUTH_USER), display_name: text(env.NOVUS_ADMIN_DISPLAY_NAME) || 'Admin', role: 'ADMIN' };
}

// ── credential resolution (with short caches) ─────────────────────────────
export const USERS_CACHE_TTL_MS = 30_000;
let usersCache = null; // { at, rows }
const verifiedCache = new Map(); // sha256(user:pass) -> { user_id, password_hash, at }

export function invalidateUsersCache() { usersCache = null; verifiedCache.clear(); }

async function loadUserRows(repo, nowMs) {
  if (usersCache && nowMs - usersCache.at < USERS_CACHE_TTL_MS) return usersCache.rows;
  let rows = [];
  try { rows = userRecords(await repo.getTable(USERS_TAB)).map((r) => r.obj); }
  catch { rows = []; } // no USERS tab yet: there are simply no setter accounts
  usersCache = { at: nowMs, rows };
  return rows;
}

export function decodeBasic(header) {
  const [scheme, encoded] = text(header).split(' ');
  if (scheme !== 'Basic' || !encoded) return null;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep < 0) return null;
  return { username: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
}

// Resolves a non-admin Basic credential to an ACTIVE USERS row, or null.
// The admin credential is handled by the caller (requireAuth) and never
// reaches this function's Sheets read.
export async function resolveUserCredential(repo, { username, password }, nowMs = Date.now()) {
  const u = normaliseUsername(username);
  if (!u || !password) return null;
  const rows = await loadUserRows(repo, nowMs);
  const row = rows.find((r) => normaliseUsername(r.username) === u);
  if (!row || upper(row.status) !== 'ACTIVE' || !ROLES.includes(upper(row.role)) || upper(row.role) === 'ADMIN') return null;
  const cacheKey = crypto.createHash('sha256').update(`${u}:${password}`).digest('hex');
  const hit = verifiedCache.get(cacheKey);
  // A reset changes password_hash, so a cached verification of the old
  // password stops matching the row immediately.
  const verified = (hit && hit.user_id === text(row.user_id) && hit.password_hash === text(row.password_hash) && nowMs - hit.at < USERS_CACHE_TTL_MS)
    || verifyPassword(password, row.password_hash);
  if (!verified) return null;
  if (verifiedCache.size > 200) verifiedCache.clear();
  verifiedCache.set(cacheKey, { user_id: text(row.user_id), password_hash: text(row.password_hash), at: nowMs });
  return { user_id: text(row.user_id), username: u, display_name: text(row.display_name) || u, role: upper(row.role) };
}

// An account by id, from the same cached USERS read (≤ USERS_CACHE_TTL_MS
// stale on a warm instance). Used to re-check a login session's account.
export async function findUserById(repo, userId, nowMs = Date.now()) {
  const rows = await loadUserRows(repo, nowMs);
  const row = rows.find((r) => text(r.user_id) === text(userId));
  return row ? { ...publicUser(row) } : null;
}

// ── attribution helpers (metadata_json on CALLS / ACTIONS) ─────────────────
export function metaOf(row) {
  try { return JSON.parse(text(row?.metadata_json) || '{}') || {}; } catch { return {}; }
}
// The user a CALLS row belongs to. Unattributed history is the admin's.
export function callUserId(row) {
  return text(metaOf(row).user_id) || ADMIN_USER_ID;
}
// The user an ACTIONS row is assigned to, or '' when nobody is (system
// actions, email-reply call requests, and every pre-existing action).
export function actionAssignee(row) {
  return text(metaOf(row).assigned_user_id);
}
