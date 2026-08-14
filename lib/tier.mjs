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
// No I/O, no AI. Called from lib/observation-recompute.mjs after the grade
// has been decided, same as lib/grading.mjs itself.

const GRADE_ROUTING = {
  A: {
    tier: 'Growth',
    segment: 'A',
    reason: 'Very fast, persistent human response (Grade A) — strong front-desk execution.',
    angle: 'The front desk is already working — sell the additional database/outcome/growth opportunity rather than fixing front-desk response.',
  },
  B: {
    tier: 'Growth',
    segment: 'A',
    reason: 'Fast, persistent human response (Grade B) — strong response and persistence.',
    angle: 'Response and persistence are already strong — sell the additional growth/database opportunity built on top of that.',
  },
  C: {
    tier: 'Core',
    segment: 'B',
    reason: 'Very fast human response but no genuine follow-up (Grade C).',
    angle: 'Fast response but no persistence — sell completion and follow-through on the enquiries already arriving.',
  },
  D: {
    tier: 'Core',
    segment: 'B',
    reason: 'Reasonable human response speed but no genuine follow-up (Grade D).',
    angle: 'Reasonable response speed but no persistence — sell completion and follow-through.',
  },
  E: {
    tier: 'Core',
    segment: 'B',
    reason: 'Persistent but slow human response — a speed gap (Grade E).',
    angle: 'Persistence is there but first contact is slow — sell closing the response-speed gap.',
  },
  F: {
    tier: 'Core',
    segment: 'B',
    reason: 'Weak human response and no persistence (Grade F).',
    angle: 'Both response speed and persistence are weak — the strongest front-desk gap short of a complete miss.',
  },
  G: {
    tier: 'Core',
    segment: 'B',
    reason: 'Automated acknowledgement only — no human completion (Grade G).',
    angle: 'Acknowledgement exists but never becomes a human conversation — sell completion and conversion.',
  },
  H: {
    tier: 'Core',
    segment: 'B',
    reason: 'No meaningful response on any channel during the 4-day observation window (Grade H).',
    angle: 'The strongest possible front-desk evidence: the enquiry sat with no response at all.',
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

// { grade, compromised, agency } -> { tier, tier_reason, sales_angle, segment }
//
// grade: the resolved INTELLIGENCE.grade ('A'..'H', 'pending', or any other
//   not-yet-resolved value — treated the same as 'pending').
// compromised: probe.compromised ('TRUE'/true) — takes priority over grade,
//   since a compromised probe's evidence is invalid regardless of what the
//   grading engine computed from it.
// agency: the matching AGENCIES row object, or null/undefined if unknown.
export function classifyTier({ grade, compromised = false, agency = null } = {}) {
  if (toBool(compromised)) {
    return {
      tier: 'unclassified',
      tier_reason: 'Probe marked compromised — evidence discarded; requires a fresh probe before a routing decision can be made.',
      sales_angle: '',
      segment: 'unclassified',
    };
  }

  const routing = GRADE_ROUTING[grade];
  if (!routing) {
    return {
      tier: 'unclassified',
      tier_reason: 'No resolved grade yet — insufficient evidence to classify.',
      sales_angle: '',
      segment: 'unclassified',
    };
  }

  return {
    tier: routing.tier,
    tier_reason: routing.reason + agencyContext(agency),
    sales_angle: routing.angle,
    segment: routing.segment,
  };
}
