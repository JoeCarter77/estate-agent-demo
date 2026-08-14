// lib/tier.mjs — lightweight NOVUS Tier / Sales Strategy Engine.
//
// Pure, deterministic reasoning only. The official INTELLIGENCE.grade (A-H,
// produced by lib/grading.mjs) is the sole and decisive routing signal:
//
//   A, B       -> Growth  (strong front-desk response/persistence)
//   C-H        -> Core    (a front-desk opportunity exists)
//   pending /
//   compromised -> unclassified (no evidence the routing decision can rest on)
//
// Deliberately NOT a qualification-gate system: years trading, database
// size, branch count, staff count, CRM presence and qualification_segment
// never override or block the grade-based classification. They may only be
// woven into tier_reason as known context for the sales conversation, and
// only when actually present on the AGENCIES record — missing/unknown
// metadata is neutral, never inferred, never disqualifying.
//
// `segment` (Segment A/B) is deliberately NOT derived from grade here. The
// authoritative definition of Segment A/B was left unresolved and was
// explicitly ruled out as a routing gate — inventing an A/B split from the
// grade would just re-smuggle that unresolved concept back in under a
// different name. This function passes `segment` straight through
// unchanged from whatever authoritative upstream value the caller supplies
// (e.g. an existing INTELLIGENCE row's current segment) and never computes
// or overwrites it based on grade/compromised/tier. With no authoritative
// source wired up yet, callers simply have nothing to pass, so it comes
// out blank.
//
// The Master's "primary sales angle" is NOT produced here. It was originally
// emitted from this module as `sales_angle`, but it is the same concept the
// Sales Strategy Engine expresses as `sales_focus` (Source Master §20), and
// two layers must not both produce one canonical fact. Generation moved to
// lib/sales-strategy.mjs, which is now its single producer; the canonical
// persisted column remains INTELLIGENCE.sales_angle (no rename). This module
// keeps only what is genuinely tier-level: tier, tier_reason and the
// pass-through segment.
//
// No I/O, no AI. Called from lib/observation-recompute.mjs after the grade
// has been decided, same as lib/grading.mjs itself.

const GRADE_ROUTING = {
  A: {
    tier: 'Growth',
    reason: 'Very fast, persistent human response (Grade A) — strong front-desk execution.',
  },
  B: {
    tier: 'Growth',
    reason: 'Fast, persistent human response (Grade B) — strong response and persistence.',
  },
  C: {
    tier: 'Core',
    reason: 'Very fast human response but no genuine follow-up (Grade C).',
  },
  D: {
    tier: 'Core',
    reason: 'Reasonable human response speed but no genuine follow-up (Grade D).',
  },
  E: {
    tier: 'Core',
    reason: 'Persistent but slow human response — a speed gap (Grade E).',
  },
  F: {
    tier: 'Core',
    reason: 'Weak human response and no persistence (Grade F).',
  },
  G: {
    tier: 'Core',
    reason: 'Automated acknowledgement only — no human completion (Grade G).',
  },
  H: {
    tier: 'Core',
    reason: 'No meaningful response on any channel during the 4-day observation window (Grade H).',
  },
};

function toBool(v) {
  return v === true || v === 'TRUE' || v === 'true';
}

// Known-context fields only — never a qualification check. Each is included
// only when actually present on the AGENCIES record; nothing is inferred for
// missing fields, and their presence/absence never changes tier or segment.
const CONTEXT_FIELDS = [
  ['years_trading', (v) => `${v} years trading`],
  ['live_listing_count', (v) => `${v} live listings`],
  ['crm_name', (v) => `CRM: ${v}`],
  ['qualification_segment', (v) => `qualification segment: ${v}`],
];

function agencyContext(agency) {
  if (!agency) return '';
  const parts = [];
  for (const [field, format] of CONTEXT_FIELDS) {
    const value = agency[field];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      parts.push(format(String(value).trim()));
    }
  }
  return parts.length ? ` Known agency context — ${parts.join('; ')}.` : '';
}

// { grade, compromised, agency, segment } -> { tier, tier_reason, segment }
//
// grade: the resolved INTELLIGENCE.grade ('A'..'H', 'pending', or any other
//   not-yet-resolved value — treated the same as 'pending').
// compromised: probe.compromised ('TRUE'/true) — takes priority over grade,
//   since a compromised probe's evidence is invalid regardless of what the
//   grading engine computed from it.
// agency: the matching AGENCIES row object, or null/undefined if unknown.
// segment: the current/authoritative INTELLIGENCE.segment value, if any —
//   passed straight through unchanged. Grade/compromised/tier never derive
//   or overwrite it; with no authoritative source wired up, callers pass
//   nothing and it stays blank.
export function classifyTier({ grade, compromised = false, agency = null, segment = '' } = {}) {
  const passthroughSegment = segment || '';

  if (toBool(compromised)) {
    return {
      tier: 'unclassified',
      tier_reason: 'Probe marked compromised — evidence discarded; requires a fresh probe before a routing decision can be made.',
      segment: passthroughSegment,
    };
  }

  const routing = GRADE_ROUTING[grade];
  if (!routing) {
    return {
      tier: 'unclassified',
      tier_reason: 'No resolved grade yet — insufficient evidence to classify.',
      segment: passthroughSegment,
    };
  }

  return {
    tier: routing.tier,
    tier_reason: routing.reason + agencyContext(agency),
    segment: passthroughSegment,
  };
}
