// lib/hunter.mjs — server-only Hunter.io Email Finder.
//
// FINDING ONLY. Hunter tells us the most likely address for a named person at
// a domain; it never decides whether that address is deliverable. Every result
// from here must still pass lib/neverbounce.mjs's verifyEmail() before it can
// be selected for outreach — Hunter's own verification endpoint is
// deliberately not used, so there is exactly one source of truth for
// deliverability across NOVUS.
//
// HUNTER_API_KEY is read only when this server-side module is called. Nothing
// in /novus or any browser bundle imports it.

const HUNTER_EMAIL_FINDER_URL = 'https://api.hunter.io/v2/email-finder';
const REQUEST_TIMEOUT_MS = 10_000;

export class HunterError extends Error {
  constructor(message, { statusCode = 502, code = 'HUNTER_ERROR', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'HunterError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function isHunterConfigured() {
  return Boolean(process.env.HUNTER_API_KEY);
}

// "John Smith" -> { first_name: 'John', last_name: 'Smith' }. A single-token
// name has no last name; Hunter accepts full_name in that case, so callers get
// { full_name } instead and we never invent a surname.
export function splitPersonName(rawName) {
  const parts = String(rawName || '')
    .replace(/\([^)]*\)/g, ' ')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return { full_name: parts[0] };
  return { first_name: parts[0], last_name: parts[parts.length - 1] };
}

// Finds the most likely email for a person at a domain.
//
// Returns { email, score, position, raw_result } on a hit, or null when Hunter
// has no address for that person (a miss is NOT an error — the caller simply
// carries on down the candidate waterfall). Throws HunterError only for
// configuration/transport failures the caller may want to surface.
export async function findEmail(
  { name, domain },
  { fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {},
) {
  const nameParts = splitPersonName(name);
  const normalizedDomain = String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!nameParts) throw new HunterError('Person name is required', { statusCode: 400, code: 'MISSING_NAME' });
  if (!normalizedDomain) throw new HunterError('Domain is required', { statusCode: 400, code: 'MISSING_DOMAIN' });

  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) throw new HunterError('Hunter is not configured', { statusCode: 500, code: 'MISSING_API_KEY' });
  if (typeof fetchImpl !== 'function') throw new HunterError('Fetch is unavailable in this runtime');

  const url = new URL(HUNTER_EMAIL_FINDER_URL);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('domain', normalizedDomain);
  for (const [key, value] of Object.entries(nameParts)) url.searchParams.set(key, value);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetchImpl(url, { signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted || err?.name === 'AbortError') {
      throw new HunterError('Hunter email finder timed out', { statusCode: 504, code: 'HUNTER_TIMEOUT', cause: err });
    }
    throw new HunterError('Hunter email finder request failed', { cause: err });
  } finally {
    clearTimeout(timeout);
  }

  let rawResult;
  try {
    rawResult = await response.json();
  } catch (err) {
    throw new HunterError('Hunter returned an invalid response', { cause: err });
  }

  if (!response.ok) {
    console.error('Hunter email finder error:', {
      httpStatus: response.status,
      errors: rawResult?.errors,
    });
    throw new HunterError('Hunter email finder failed', {
      statusCode: response.status >= 400 && response.status < 500 ? 502 : 503,
      code: 'HUNTER_API_ERROR',
    });
  }

  const email = String(rawResult?.data?.email || '').trim().toLowerCase();
  if (!email) return null;

  return {
    email,
    score: rawResult?.data?.score ?? null,
    position: String(rawResult?.data?.position || '').trim(),
    raw_result: rawResult,
  };
}
