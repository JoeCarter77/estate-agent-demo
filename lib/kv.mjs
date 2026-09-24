// lib/kv.mjs — a minimal Upstash Redis (REST) client for the login system:
// server-side login sessions, login rate limiting and the one-active-calling-
// session lock. Same store and env as lib/reply-claim.mjs (KV_REST_API_URL /
// KV_REST_API_TOKEN), which the live reply poller already requires.
//
// FAILS CLOSED. Without the store there is no way to validate a login session
// or rate-limit sign-in, so kvStore() throws and sign-in refuses rather than
// running unprotected. The admin's machine credential (Basic Auth, used by the
// Playwright worker and the GitHub poller) does not depend on this.
//
// Commands used: GET, SET (EX / NX / KEEPTTL), DEL, INCR, EXPIRE, SADD,
// SMEMBERS, SREM. The in-memory store implements exactly those, for tests.

const text = (value) => String(value ?? '').trim();
const KV_TIMEOUT_MS = 5000;

export function isKvConfigured(env = process.env) {
  return Boolean(text(env.KV_REST_API_URL) && text(env.KV_REST_API_TOKEN));
}

export function createUpstashKv({ url, token, fetchImpl = globalThis.fetch } = {}) {
  const base = text(url).replace(/\/+$/, '');
  const auth = text(token);
  if (!base || !auth) {
    const err = new Error('KV_REST_API_URL / KV_REST_API_TOKEN are not set; sign-in is disabled.');
    err.kv_unavailable = true;
    throw err;
  }
  async function command(args) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), KV_TIMEOUT_MS);
    try {
      const response = await fetchImpl(base, {
        method: 'POST', cache: 'no-store', signal: controller.signal,
        headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args.map(String)),
      });
      const body = await response.json().catch(() => ({}));
      // The token is never echoed: only the command name reaches an error.
      if (!response.ok || body.error) {
        const err = new Error(`KV ${args[0]} failed (${response.status})`);
        err.kv_unavailable = true;
        throw err;
      }
      return body.result;
    } finally { clearTimeout(timer); }
  }
  return { command };
}

// TEST ONLY. `now` is injectable so expiry can be exercised.
export function createMemoryKv({ now = () => Date.now() } = {}) {
  const data = new Map(); // key -> { value, expires_at|null }
  const live = (key) => {
    const e = data.get(key);
    if (e && e.expires_at !== null && e.expires_at <= now()) { data.delete(key); return undefined; }
    return e;
  };
  async function command(args) {
    const [cmd, key, ...rest] = args.map(String);
    const upperCmd = cmd.toUpperCase();
    if (upperCmd === 'GET') { const e = live(key); return e && typeof e.value === 'string' ? e.value : null; }
    if (upperCmd === 'SET') {
      const opts = rest.slice(1).map((s) => s.toUpperCase());
      const e = live(key);
      if (opts.includes('NX') && e) return null;
      let expires = null;
      const exAt = opts.indexOf('EX');
      if (exAt >= 0) expires = now() + Number(rest[1 + exAt + 1]) * 1000;
      if (opts.includes('KEEPTTL') && e) expires = e.expires_at;
      data.set(key, { value: rest[0], expires_at: expires });
      return 'OK';
    }
    if (upperCmd === 'DEL') { const had = Boolean(live(key)); data.delete(key); return had ? 1 : 0; }
    if (upperCmd === 'INCR') { const e = live(key); const n = Number(e?.value || 0) + 1; data.set(key, { value: String(n), expires_at: e?.expires_at ?? null }); return n; }
    if (upperCmd === 'EXPIRE') { const e = live(key); if (!e) return 0; e.expires_at = now() + Number(rest[0]) * 1000; return 1; }
    if (upperCmd === 'SADD') { const e = live(key); const set = e && e.value instanceof Set ? e.value : new Set(); rest.forEach((m) => set.add(m)); data.set(key, { value: set, expires_at: e?.expires_at ?? null }); return rest.length; }
    if (upperCmd === 'SMEMBERS') { const e = live(key); return e && e.value instanceof Set ? [...e.value] : []; }
    if (upperCmd === 'SREM') { const e = live(key); if (e && e.value instanceof Set) rest.forEach((m) => e.value.delete(m)); return 1; }
    throw new Error(`memory kv: unsupported ${cmd}`);
  }
  return { command, data };
}

let _override = null;
export function __setKvForTests(kv) { _override = kv; }
export function kvStore() {
  if (_override) return _override;
  return createUpstashKv({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}
