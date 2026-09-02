// lib/hunter.mjs — server-only Hunter.io Domain Search, Email Finder + Verifier.
//
// Finder and Verifier answer different questions and are not interchangeable.
// Email Finder answers "what is this person's address at this domain?" — its
// embedded verification block is metadata about that guess, NOT a verification
// of the mailbox. Email Verifier is the only thing that verifies an address,
// whatever discovered it (Finder, AGENCIES, CONTACTS or COMMUNICATIONS).
//
// HUNTER_API_KEY is read only when this server-side module is called. Nothing
// in /novus or any browser bundle imports it.

const HUNTER_EMAIL_FINDER_URL = 'https://api.hunter.io/v2/email-finder';
const HUNTER_EMAIL_VERIFIER_URL = 'https://api.hunter.io/v2/email-verifier';
const HUNTER_DOMAIN_SEARCH_URL = 'https://api.hunter.io/v2/domain-search';
const REQUEST_TIMEOUT_MS = 10_000;

const STATUS_BY_RESULT = {
  valid: 'VALID',
  webmail: 'VALID',
  invalid: 'INVALID',
  disposable: 'DISPOSABLE',
  accept_all: 'RISKY',
  acceptall: 'RISKY',
  'accept-all': 'RISKY',
  accepts_all: 'RISKY',
  catchall: 'RISKY',
  catch_all: 'RISKY',
  'catch-all': 'RISKY',
  unknown: 'UNKNOWN',
  blocked: 'UNKNOWN',
};

export function normalizeHunterVerificationStatus(status, { acceptAll = false } = {}) {
  const normalized = STATUS_BY_RESULT[String(status || '').trim().toLowerCase()] || 'UNKNOWN';
  if (acceptAll && !['INVALID', 'DISPOSABLE'].includes(normalized)) return 'RISKY';
  return normalized;
}

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

// Returns Hunter's named, personal decision-maker records for a domain. Hunter
// performs the company/person discovery: this helper does no scraping, search,
// enrichment or AI work of its own. A miss is an empty array.
async function searchDomainEmails(
  { domain, type = '', decisionMaker = null, requiredField = '' },
  { fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {},
) {
  const normalizedDomain = String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!normalizedDomain) throw new HunterError('Domain is required', { statusCode: 400, code: 'MISSING_DOMAIN' });

  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) throw new HunterError('Hunter is not configured', { statusCode: 500, code: 'MISSING_API_KEY' });
  if (typeof fetchImpl !== 'function') throw new HunterError('Fetch is unavailable in this runtime');

  const url = new URL(HUNTER_DOMAIN_SEARCH_URL);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('domain', normalizedDomain);
  if (type) url.searchParams.set('type', type);
  if (decisionMaker !== null) url.searchParams.set('decision_maker', decisionMaker ? 'true' : 'false');
  if (requiredField) url.searchParams.set('required_field', requiredField);
  url.searchParams.set('limit', '10');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted || err?.name === 'AbortError') {
      throw new HunterError('Hunter domain search timed out', { statusCode: 504, code: 'HUNTER_TIMEOUT', cause: err });
    }
    throw new HunterError('Hunter domain search request failed', { cause: err });
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
    console.error('Hunter domain search error:', { httpStatus: response.status, errors: rawResult?.errors });
    throw new HunterError('Hunter domain search failed', {
      statusCode: response.status >= 400 && response.status < 500 ? 502 : 503,
      code: 'HUNTER_API_ERROR',
    });
  }

  return (Array.isArray(rawResult?.data?.emails) ? rawResult.data.emails : []).map((entry) => ({
    email: String(entry?.value || entry?.email || '').trim().toLowerCase(),
    first_name: String(entry?.first_name || '').trim(),
    last_name: String(entry?.last_name || '').trim(),
    full_name: String(entry?.full_name || `${entry?.first_name || ''} ${entry?.last_name || ''}`).trim(),
    position: String(entry?.position || '').trim(),
    seniority: String(entry?.seniority || '').trim(),
    department: String(entry?.department || '').trim(),
    decision_maker: entry?.decision_maker === true,
    confidence: entry?.confidence ?? null,
    verification_status: normalizeHunterVerificationStatus(entry?.verification?.status, {
      acceptAll: rawResult?.data?.accept_all === true,
    }),
    verification_date: String(entry?.verification?.date || '').trim(),
    raw_result: entry,
  }));
}

export function findDomainDecisionMakers(input, options) {
  return searchDomainEmails({
    ...input,
    type: 'personal',
    decisionMaker: true,
    requiredField: 'full_name,position',
  }, options);
}

// Targeted second-stage fallback. These are Hunter results, not scraped or
// researched addresses; the resolver still applies its own generic-address
// classifier and Email Verifier before anything can be selected.
export function findDomainGenericEmails(input, options) {
  return searchDomainEmails({ ...input, type: 'generic' }, options);
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
    // Finder's own view of the address. Carried for provenance/debugging only —
    // callers must not treat it as a verification result.
    verification_status: normalizeHunterVerificationStatus(rawResult?.data?.verification?.status, {
      acceptAll: rawResult?.data?.accept_all === true,
    }),
    verification_date: String(rawResult?.data?.verification?.date || '').trim(),
    accept_all: rawResult?.data?.accept_all === true,
    raw_result: rawResult,
  };
}

// Verifies an address — the ONLY thing in this module that does. Every address
// goes through here before it can be selected for outreach, including one
// findEmail() proposed: a Finder hit is a candidate, not a verified mailbox.
export async function verifyEmail(
  email,
  { fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {},
) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) throw new HunterError('Email is required', { statusCode: 400, code: 'MISSING_EMAIL' });

  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) throw new HunterError('Hunter is not configured', { statusCode: 500, code: 'MISSING_API_KEY' });
  if (typeof fetchImpl !== 'function') throw new HunterError('Fetch is unavailable in this runtime');

  const url = new URL(HUNTER_EMAIL_VERIFIER_URL);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('email', normalizedEmail);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted || err?.name === 'AbortError') {
      throw new HunterError('Hunter email verifier timed out', { statusCode: 504, code: 'HUNTER_TIMEOUT', cause: err });
    }
    throw new HunterError('Hunter email verifier request failed', { cause: err });
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
    console.error('Hunter email verifier error:', { httpStatus: response.status, errors: rawResult?.errors });
    throw new HunterError('Hunter email verifier failed', {
      statusCode: response.status >= 400 && response.status < 500 ? 502 : 503,
      code: 'HUNTER_API_ERROR',
    });
  }

  return {
    verification_status: normalizeHunterVerificationStatus(rawResult?.data?.status),
    score: rawResult?.data?.score ?? null,
    raw_result: rawResult,
  };
}
