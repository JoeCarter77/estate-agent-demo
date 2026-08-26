// lib/neverbounce.mjs — server-only NeverBounce single-email verification.
//
// NEVERBOUNCE_API_KEY is deliberately read only when this server-side module is
// called. Nothing in /novus or any browser bundle imports this module.

const NEVERBOUNCE_SINGLE_CHECK_URL = 'https://api.neverbounce.com/v4.2/single/check';
const REQUEST_TIMEOUT_MS = 10_000;

// The five verdicts NOVUS distinguishes, kept SEPARATE on purpose.
//
// DISPOSABLE used to collapse into INVALID. Both are hard rejects for outreach
// selection, but they are different facts about the address and the resolver's
// caution rules read them, so they are no longer flattened here.
//
// CATCHALL / ACCEPT-ALL IS NOT A FAILURE. A small estate agency's mail server
// that accepts everything cannot confirm a specific mailbox — that is a
// property of the SERVER, not evidence against the address. It maps to RISKY
// (NOVUS's accept-all/catchall equivalent) and must never be treated as a hard
// failure. NeverBounce spells this several ways depending on endpoint and
// account; all of them land on RISKY.
const STATUS_BY_RESULT = {
  valid: 'VALID',
  invalid: 'INVALID',
  disposable: 'DISPOSABLE',
  catchall: 'RISKY',
  catch_all: 'RISKY',
  'catch-all': 'RISKY',
  accept_all: 'RISKY',
  acceptall: 'RISKY',
  'accept-all': 'RISKY',
  accepts_all: 'RISKY',
  unknown: 'UNKNOWN',
};

// Statuses that must never be selected for outreach, whatever else is known
// about the contact. Exported so the resolver states the rule once.
export const HARD_FAIL_STATUSES = new Set(['INVALID', 'DISPOSABLE']);

// Statuses that mean "the server would not confirm this mailbox" rather than
// "this mailbox is bad".
export const INCONCLUSIVE_STATUSES = new Set(['UNKNOWN', 'RISKY']);

export class NeverBounceError extends Error {
  constructor(message, { statusCode = 502, code = 'NEVERBOUNCE_ERROR', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'NeverBounceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function normalizeNeverBounceResult(result) {
  return STATUS_BY_RESULT[String(result || '').trim().toLowerCase()] || 'UNKNOWN';
}

// Returns the app-owned verification_status alongside the full successful
// NeverBounce payload so callers can retain provider-level detail if needed.
export async function verifyEmail(email, { fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const normalizedEmail = String(email || '').trim();
  if (!normalizedEmail) {
    throw new NeverBounceError('Email is required', {
      statusCode: 400,
      code: 'MISSING_EMAIL',
    });
  }

  const apiKey = process.env.NEVERBOUNCE_API_KEY;
  if (!apiKey) {
    throw new NeverBounceError('NeverBounce is not configured', {
      statusCode: 500,
      code: 'MISSING_API_KEY',
    });
  }
  if (typeof fetchImpl !== 'function') {
    throw new NeverBounceError('Fetch is unavailable in this runtime');
  }

  const url = new URL(NEVERBOUNCE_SINGLE_CHECK_URL);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('email', normalizedEmail);
  // Prevent NeverBounce itself from waiting longer than our server-side cap.
  url.searchParams.set('timeout', String(Math.max(1, Math.floor(timeoutMs / 1000))));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetchImpl(url, { signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted || err?.name === 'AbortError') {
      throw new NeverBounceError('NeverBounce verification timed out', {
        statusCode: 504,
        code: 'NEVERBOUNCE_TIMEOUT',
        cause: err,
      });
    }
    throw new NeverBounceError('NeverBounce verification request failed', { cause: err });
  } finally {
    clearTimeout(timeout);
  }

  let rawResult;
  try {
    rawResult = await response.json();
  } catch (err) {
    throw new NeverBounceError('NeverBounce returned an invalid response', { cause: err });
  }

  if (!response.ok || rawResult?.status !== 'success') {
    console.error('NeverBounce single verification error:', {
      httpStatus: response.status,
      status: rawResult?.status,
      message: rawResult?.message,
    });
    throw new NeverBounceError('NeverBounce verification failed', {
      statusCode: response.status >= 400 && response.status < 500 ? 502 : 503,
      code: 'NEVERBOUNCE_API_ERROR',
    });
  }

  return {
    verification_status: normalizeNeverBounceResult(rawResult.result),
    raw_result: rawResult,
  };
}
