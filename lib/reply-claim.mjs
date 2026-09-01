// lib/reply-claim.mjs — the ONE cross-instance mutual-exclusion primitive.
//
// WHY THIS EXISTS. Every other idempotency guard in the reply pipeline is
// read-then-write, and none of them survive two Vercel instances running at the
// same moment:
//
//   - pollInstantlyReplies' processedIds Set is execution-local. It stops the
//     same email appearing twice in ONE batch and says nothing about a
//     concurrent invocation.
//   - Google Sheets values:append has no uniqueness constraint and the values
//     API has no conditional write, no ETag and no revision precondition, so
//     "check absent, then append" cannot be made indivisible there.
//   - REPLY_EVENTS.notes / action_completed_at / action_status are keyed to ONE
//     ROW. Two overlapping polls create two rows with different reply_event_ids
//     for the SAME prospect email, and every one of those markers is blank on
//     both.
//   - demoSentEvidence's Instantly sweep is a convergence check: it reliably
//     catches a duplicate MINUTES later, and catches nothing at all when both
//     callers sweep before either has POSTed.
//
// So the claim below is not a nicety layered on top of those; it is the only
// thing in the system that is actually atomic across instances. Redis SET NX is
// a single-round-trip compare-and-set, which is exactly the primitive Sheets
// cannot express.
//
// WHAT IT IS NOT. It is not state, not a cache, and not a source of truth.
// Google Sheets remains the source of truth for every value the pipeline
// records. This store holds nothing but short-lived opaque claim tokens, and
// losing the entire store loses no NOVUS data — it only removes the guard,
// which is why the live paths refuse to run without it rather than continuing
// unprotected.
//
// KEYED ON instantly_email_id, NEVER reply_event_id. The identity that must be
// unique is "this inbound email from this prospect". reply_event_id is minted
// per append, so it is the very thing a race duplicates and is therefore
// useless as a mutual-exclusion key.

import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// TTL.
//
// Both claims expire. That is deliberate and is the whole answer to "what if a
// Vercel invocation dies mid-flight": the worst case is that one email waits
// out the TTL and is processed by a later pass, never that it is blocked
// permanently and never that a human has to clear a stuck key.
//
// 900s is chosen from two bounds:
//   LOWER — it must exceed the longest possible single invocation, so a claim
//   cannot lapse while its holder is still working. Vercel's ceiling is 60s on
//   Hobby and 300s on Pro; 900s clears the larger by 3x.
//   UPPER — it must not be so long that a crash strands an email for an
//   embarrassing time. At a one-minute poll, 15 minutes is 15 missed cycles for
//   ONE email: a latency cost, never a correctness one.
//
// The send TTL has a second job the reply TTL does not: it must outlast
// Instantly's indexing lag, so that by the time the claim lapses a genuinely
// sent demo is visible to demoSentEvidence's sweep. See the release policy.
// ---------------------------------------------------------------------------
export const REPLY_CLAIM_TTL_SECONDS = 900;
export const SEND_CLAIM_TTL_SECONDS = 900;

export const REPLY_CLAIM_PREFIX = 'novus:reply:';
export const SEND_CLAIM_PREFIX = 'novus:send:';

function asText(value) { return value === undefined || value === null ? '' : String(value); }

export function replyClaimKey(instantlyEmailId) {
  const id = asText(instantlyEmailId).trim();
  if (!id) throw new Error('replyClaimKey requires an instantly_email_id');
  return `${REPLY_CLAIM_PREFIX}${id}`;
}

export function sendClaimKey(instantlyEmailId) {
  const id = asText(instantlyEmailId).trim();
  if (!id) throw new Error('sendClaimKey requires an instantly_email_id');
  return `${SEND_CLAIM_PREFIX}${id}`;
}

// A fresh opaque token per attempt. It exists so release() can only ever delete
// OUR claim: if ours already expired and another instance re-claimed the same
// key, the compare-and-delete matches nothing and we leave their claim alone.
export function newClaimToken() {
  return crypto.randomUUID();
}

// The error thrown when the live paths are asked to run with no store
// configured. Carried as a flag so the HTTP layer can answer with a precise
// message instead of a generic 500.
export function claimStoreUnavailableError(message) {
  const err = new Error(message);
  err.claim_store_unavailable = true;
  return err;
}

export const CLAIM_STORE_ENV_VARS = ['KV_REST_API_URL', 'KV_REST_API_TOKEN'];

export function isClaimStoreConfigured(env = process.env) {
  return CLAIM_STORE_ENV_VARS.every((name) => Boolean(asText(env?.[name]).trim()));
}

// ---------------------------------------------------------------------------
// The Upstash REST transport.
//
// Upstash's generic command endpoint takes the command as a JSON array POSTed
// to the base URL, which keeps this to plain fetch with no client library and
// no TCP pooling — the shape serverless actually wants.
//
// ACQUIRE:  ["SET", key, token, "NX", "EX", "900"]
//           -> {"result":"OK"}   acquired
//           -> {"result":null}   already held by someone else
//
// RELEASE:  EVAL of a compare-and-delete, so the check and the delete are one
//           atomic server-side step. A plain GET-then-DEL would reintroduce
//           precisely the read-then-write race this module exists to remove.
//
// The token is NEVER echoed into a returned value or an error.
// ---------------------------------------------------------------------------
export const RELEASE_LUA = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";

export const CLAIM_REQUEST_TIMEOUT_MS = 5000;

function safeDetail(value, max = 200) {
  return asText(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

export function createUpstashClaimStore({
  url,
  token: authToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = CLAIM_REQUEST_TIMEOUT_MS,
} = {}) {
  const base = asText(url).trim().replace(/\/+$/, '');
  const auth = asText(authToken).trim();
  if (!base || !auth) {
    throw claimStoreUnavailableError(
      `${CLAIM_STORE_ENV_VARS.join(' / ')} are not set in this environment; the live reply poller and SEND_DEMO execution are disabled.`,
    );
  }

  // The KV token must never leave this module. safeDetail() folds the upstream
  // response body into our error text, and a proxy or gateway that echoes the
  // Authorization header back would carry the token straight into a poll
  // response's skipped[].error. Redacted at the boundary rather than trusted
  // not to happen.
  function safeKvDetail(value) {
    const detail = safeDetail(value);
    return auth ? detail.split(auth).join('[redacted]') : detail;
  }

  async function command(args) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response;
    try {
      response = await fetchImpl(base, {
        method: 'POST',
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${auth}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(args),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    let text = '';
    try { text = await response.text(); } catch { text = ''; }
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }

    if (!response.ok) {
      throw new Error(`kv_status=${response.status} ${safeKvDetail(payload?.error || text || '(empty response body)')}`);
    }
    if (payload && payload.error) throw new Error(safeKvDetail(payload.error));
    return payload ? payload.result : null;
  }

  return {
    // FAILS CLOSED. A transport error, a timeout or a non-2xx resolves to
    // acquired:false WITH an error set — never to acquired:true. The caller
    // cannot proceed either way; the error only tells it (and the operator)
    // which of the two happened.
    async acquire(key, ttlSeconds) {
      const claimToken = newClaimToken();
      try {
        const result = await command(['SET', key, claimToken, 'NX', 'EX', String(ttlSeconds)]);
        // Upstash answers "OK" on a successful NX set and null when the key is
        // already held. Anything else is treated as NOT acquired.
        if (result === 'OK') return { acquired: true, token: claimToken, error: null };
        return { acquired: false, token: null, error: null };
      } catch (err) {
        return { acquired: false, token: null, error: safeKvDetail(err?.name === 'AbortError' ? `kv timeout after ${timeoutMs}ms` : err?.message || 'kv request failed') };
      }
    },

    // Best effort by design. A failed release is SAFE in the only direction
    // that matters: the claim simply lives out its TTL, so the worst outcome is
    // a delayed retry, never a duplicate send.
    async release(key, claimToken) {
      if (!claimToken) return false;
      try {
        const result = await command(['EVAL', RELEASE_LUA, '1', key, claimToken]);
        return Number(result) === 1;
      } catch {
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory store. TEST ONLY — exported so the concurrency selftests can drive
// real contention without a network, and so the existing hermetic selftests can
// satisfy the now-mandatory claim dependency.
//
// It is NEVER used in production: getClaimStore() below reaches for Upstash and
// throws when it is not configured. An in-memory Set is exactly the thing that
// does not work on Vercel, which is the reason this whole module exists.
//
// `now` is injectable so a test can advance the clock and prove that a stale
// claim from a crashed invocation is recoverable.
// ---------------------------------------------------------------------------
export function createMemoryClaimStore({ now = () => Date.now(), failWith = null } = {}) {
  const entries = new Map();
  const log = [];

  return {
    log,
    entries,
    async acquire(key, ttlSeconds) {
      log.push(['acquire', key]);
      if (failWith) return { acquired: false, token: null, error: failWith };
      const existing = entries.get(key);
      // An expired entry is not a claim. This is what makes a crashed holder
      // recoverable rather than permanent.
      if (existing && existing.expires_at > now()) return { acquired: false, token: null, error: null };
      const claimToken = newClaimToken();
      entries.set(key, { token: claimToken, expires_at: now() + (ttlSeconds * 1000) });
      return { acquired: true, token: claimToken, error: null };
    },
    async release(key, claimToken) {
      log.push(['release', key]);
      const existing = entries.get(key);
      // Compare-and-delete, same semantics as the Lua script: we can only ever
      // drop our OWN claim.
      if (!existing || existing.token !== claimToken) return false;
      entries.delete(key);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Resolution. Mirrors lib/sheets.mjs's getRepo()/__setRepoForTests() shape so
// the injection convention is the same one used everywhere else here.
// ---------------------------------------------------------------------------
let _claimStoreOverride = null;

export function __setClaimStoreForTests(store) { _claimStoreOverride = store; }

// THROWS when unconfigured. Callers resolve the store BEFORE doing any work, so
// a missing env var costs zero Instantly reads, zero Sheets access and zero
// sends — it can never degrade into running unprotected.
export function getClaimStore() {
  if (_claimStoreOverride) return _claimStoreOverride;
  return createUpstashClaimStore({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
}
