// lib/rightmove-urls.mjs — the single authority on what a Rightmove URL IS.
//
// WHY THIS EXISTS (NOVUS Part 4 rule): AGENCIES.rightmove_sales_branch_url and
// PROBES.property_url are NOT interchangeable, and a generic search URL must
// NEVER be stored as either. Two separate call sites need that judgement — the
// Rightmove research migration (scripts/novus-rightmove-migrate.mjs) and probe
// creation (api/novus/probe-create.js) — so the rules live here once instead of
// being re-implemented (and drifting) in both.
//
// Pure functions. No I/O, no network, no dependencies — unit-testable in
// isolation and safe to import anywhere.
//
// The two legitimate kinds:
//
//   AGENCY PROFILE  → belongs in AGENCIES.rightmove_sales_branch_url
//     /estate-agents/agent/<Brand>/<Branch>-<id>.html
//     /estate-agents/profile/<...>
//
//   INDIVIDUAL PROPERTY → belongs in PROBES.property_url
//     /properties/<digits>
//     /property-for-sale/property-<digits>.html      (legacy listing form)
//
// Everything else is explicitly rejected, including the cases the earlier
// research produced by accident:
//     /property-for-sale/Rayleigh.html               area/location search
//     /property-for-sale/find.html?...               property search
//     /estate-agents/find.html?...                   generic agent search
//     /estate-agents/Essex.html                      agent area search
//     /estate-agents/UK.html                         agent index

// Canonical classification results.
export const URL_KIND = {
  AGENCY_PROFILE: 'agency_profile',
  PROPERTY: 'property',
  PROPERTY_SEARCH: 'property_search',
  AGENT_SEARCH: 'agent_search',
  NOT_RIGHTMOVE: 'not_rightmove',
  EMPTY: 'empty',
  UNKNOWN: 'unknown',
};

function parse(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed.replace(/^\/+/, '')}`;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

function isRightmoveHost(u) {
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  return host === 'rightmove.co.uk' || host.endsWith('.rightmove.co.uk');
}

/**
 * Classifies any Rightmove-ish URL. Returns
 * { kind, url, normalized, property_id, reason }.
 *
 * `normalized` is only populated for the two legitimate kinds — it is the
 * canonical form safe to persist. For every rejected kind it stays '' so a
 * caller can never accidentally write a search URL to the sheet.
 */
export function classifyRightmoveUrl(raw) {
  const u = parse(raw);
  if (!u) {
    return {
      kind: String(raw ?? '').trim() ? URL_KIND.UNKNOWN : URL_KIND.EMPTY,
      url: String(raw ?? '').trim(),
      normalized: '',
      property_id: '',
      reason: String(raw ?? '').trim() ? 'Not a parseable URL' : 'Empty value',
    };
  }

  const original = u.toString();
  if (!isRightmoveHost(u)) {
    return {
      kind: URL_KIND.NOT_RIGHTMOVE,
      url: original,
      normalized: '',
      property_id: '',
      reason: `Host ${u.hostname} is not rightmove.co.uk`,
    };
  }

  // Path only, lower-cased, trailing slash removed. Query/hash are deliberately
  // dropped for matching (Rightmove appends tracking + "#/" fragments freely).
  const path = u.pathname.toLowerCase().replace(/\/+$/, '');
  const search = u.search || '';

  // ── Individual property ────────────────────────────────────────────────────
  // /properties/173617499  (current canonical form)
  const propMatch = path.match(/^\/properties\/(\d{4,})$/);
  if (propMatch) {
    return {
      kind: URL_KIND.PROPERTY,
      url: original,
      normalized: `https://www.rightmove.co.uk/properties/${propMatch[1]}`,
      property_id: propMatch[1],
      reason: 'Individual property listing',
    };
  }
  // /property-for-sale/property-173617499.html  (legacy listing form)
  const legacyMatch = path.match(/^\/property-(?:for-sale|to-rent)\/property-(\d{4,})\.html$/);
  if (legacyMatch) {
    return {
      kind: URL_KIND.PROPERTY,
      url: original,
      normalized: `https://www.rightmove.co.uk/properties/${legacyMatch[1]}`,
      property_id: legacyMatch[1],
      reason: 'Individual property listing (legacy URL form)',
    };
  }

  // ── Agency profile ─────────────────────────────────────────────────────────
  // Must be /estate-agents/agent/... or /estate-agents/profile/... AND carry a
  // branch segment after it. A bare /estate-agents/agent is an index, not a
  // profile.
  if (/^\/estate-agents\/(agent|profile)\/.+/.test(path)) {
    // Strip query/hash: agency profile URLs are stable without them.
    return {
      kind: URL_KIND.AGENCY_PROFILE,
      url: original,
      normalized: `https://www.rightmove.co.uk${u.pathname.replace(/\/+$/, '')}`,
      property_id: '',
      reason: 'Rightmove agency profile',
    };
  }

  // ── Rejections (named, so the migration can report WHY) ────────────────────
  if (/^\/estate-agents(\/|$)/.test(path)) {
    return {
      kind: URL_KIND.AGENT_SEARCH,
      url: original,
      normalized: '',
      property_id: '',
      reason: 'Generic estate-agent search/index, not a specific agency profile',
    };
  }
  if (/^\/property-(for-sale|to-rent)(\/|$)/.test(path) || /^\/(find|search)(\/|$)/.test(path) || /locationidentifier=/i.test(search)) {
    return {
      kind: URL_KIND.PROPERTY_SEARCH,
      url: original,
      normalized: '',
      property_id: '',
      reason: 'Property/area search results page, not a specific property or agency',
    };
  }

  return {
    kind: URL_KIND.UNKNOWN,
    url: original,
    normalized: '',
    property_id: '',
    reason: 'Rightmove URL of an unrecognised kind',
  };
}

/** True only for a genuine agency-profile URL (AGENCIES.rightmove_sales_branch_url). */
export function isAgencyProfileUrl(raw) {
  return classifyRightmoveUrl(raw).kind === URL_KIND.AGENCY_PROFILE;
}

/** True only for a genuine individual property URL (PROBES.property_url). */
export function isPropertyUrl(raw) {
  return classifyRightmoveUrl(raw).kind === URL_KIND.PROPERTY;
}

/**
 * The agency URL safe to persist, or '' if the input is not a genuine agency
 * profile. Callers store the return value directly — a generic search URL can
 * therefore never reach AGENCIES.rightmove_sales_branch_url.
 */
export function agencyProfileUrlOrEmpty(raw) {
  const c = classifyRightmoveUrl(raw);
  return c.kind === URL_KIND.AGENCY_PROFILE ? c.normalized : '';
}

// ── Rightmove research status vocabulary ──────────────────────────────────────
// AGENCIES.rightmove_status. Mirrors the four outcomes the Rightmove review
// actually produces. Kept small and closed on purpose so downstream filters
// ("who can we probe?") are a single equality check.
export const RIGHTMOVE_STATUS = {
  CONFIRMED: 'confirmed',        // Genuine agency profile URL, verified. Probeable.
  CANDIDATE: 'candidate',        // Likely profile but not verified. Needs a human look.
  UNRESOLVED: 'unresolved',      // No usable profile found yet.
  NOT_APPLICABLE: 'not_applicable', // Lettings-only / non-sales / not to be outreached.
};

const STATUS_SYNONYMS = new Map([
  ['confirmed', RIGHTMOVE_STATUS.CONFIRMED],
  ['confirm', RIGHTMOVE_STATUS.CONFIRMED],
  ['verified', RIGHTMOVE_STATUS.CONFIRMED],
  ['match', RIGHTMOVE_STATUS.CONFIRMED],
  ['matched', RIGHTMOVE_STATUS.CONFIRMED],
  ['found', RIGHTMOVE_STATUS.CONFIRMED],
  ['ok', RIGHTMOVE_STATUS.CONFIRMED],
  ['yes', RIGHTMOVE_STATUS.CONFIRMED],
  ['candidate', RIGHTMOVE_STATUS.CANDIDATE],
  ['probable', RIGHTMOVE_STATUS.CANDIDATE],
  ['likely', RIGHTMOVE_STATUS.CANDIDATE],
  ['possible', RIGHTMOVE_STATUS.CANDIDATE],
  ['needs review', RIGHTMOVE_STATUS.CANDIDATE],
  ['review', RIGHTMOVE_STATUS.CANDIDATE],
  ['unresolved', RIGHTMOVE_STATUS.UNRESOLVED],
  ['not found', RIGHTMOVE_STATUS.UNRESOLVED],
  ['no profile', RIGHTMOVE_STATUS.UNRESOLVED],
  ['none', RIGHTMOVE_STATUS.UNRESOLVED],
  ['no', RIGHTMOVE_STATUS.UNRESOLVED],
  ['unknown', RIGHTMOVE_STATUS.UNRESOLVED],
  ['pending', RIGHTMOVE_STATUS.UNRESOLVED],
  ['not applicable', RIGHTMOVE_STATUS.NOT_APPLICABLE],
  ['n/a', RIGHTMOVE_STATUS.NOT_APPLICABLE],
  ['na', RIGHTMOVE_STATUS.NOT_APPLICABLE],
  ['lettings', RIGHTMOVE_STATUS.NOT_APPLICABLE],
  ['lettings only', RIGHTMOVE_STATUS.NOT_APPLICABLE],
  ['lettings-only', RIGHTMOVE_STATUS.NOT_APPLICABLE],
  ['non-sales', RIGHTMOVE_STATUS.NOT_APPLICABLE],
  ['non sales', RIGHTMOVE_STATUS.NOT_APPLICABLE],
  ['not sales', RIGHTMOVE_STATUS.NOT_APPLICABLE],
  ['do not outreach', RIGHTMOVE_STATUS.NOT_APPLICABLE],
  ['exclude', RIGHTMOVE_STATUS.NOT_APPLICABLE],
  ['excluded', RIGHTMOVE_STATUS.NOT_APPLICABLE],
  ['suppress', RIGHTMOVE_STATUS.NOT_APPLICABLE],
]);

/**
 * Maps a free-text research status onto the closed vocabulary above.
 * Returns '' for an empty input so the migration can leave the cell untouched
 * rather than inventing a status. Unrecognised non-empty text falls back to
 * 'candidate' — never 'confirmed' — so a status we don't understand can never
 * promote an agency into the probeable set.
 */
export function normalizeRightmoveStatus(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return '';
  if (STATUS_SYNONYMS.has(s)) return STATUS_SYNONYMS.get(s);
  // Substring pass, longest key first, so "lettings only (no sales)" resolves.
  const keys = [...STATUS_SYNONYMS.keys()].sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (s.includes(k)) return STATUS_SYNONYMS.get(k);
  }
  return RIGHTMOVE_STATUS.CANDIDATE;
}
