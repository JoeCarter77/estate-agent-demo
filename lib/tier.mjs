// lib/tier.mjs — rules-driven tier routing and next-action selection.
//
// Source Master §10 routing principle, verbatim:
//   "Grades A and B indicate strong human response/persistence and are natural
//    candidates for Growth when the agency meets Tier 2 qualification
//    requirements. Grades C–H indicate a front-desk opportunity and are
//    natural candidates for Core / Front Desk, subject to the existing
//    qualification and segment rules. This does not override the Tier Sheet's
//    other eligibility requirements."
//
// Two things follow from that wording, and both are honoured here:
//
//   1. Tier is RULES-DRIVEN, never AI-decided (§29: tier eligibility sits with
//      the rules engine, same as the official grade).
//   2. The grade produces a CANDIDATE tier, not a final one. Qualification
//      data (branch count, years trading, sales-led vs lettings-only) is not
//      captured for the 144 imported agencies, so this module deliberately
//      emits `tier_candidate` semantics and says so in tier_reason. It must
//      not present a routing decision as more settled than the evidence is.
//
// No AI. No invented eligibility. A grade that is still 'pending' produces no
// tier at all rather than a provisional guess.

const GROWTH_GRADES = new Set(['A', 'B']);
const FRONT_DESK_GRADES = new Set(['C', 'D', 'E', 'F', 'G', 'H']);

// grade -> { tier, tier_reason }
export function routeTier(grade, { agency } = {}) {
  const g = String(grade || '').trim().toUpperCase();

  if (!g || g === 'PENDING') {
    return { tier: '', tier_reason: 'Observation not resolved yet — no tier assigned until a grade exists.' };
  }

  if (GROWTH_GRADES.has(g)) {
    const gaps = qualificationGaps(agency);
    return {
      tier: 'Growth (candidate)',
      tier_reason: gaps.length
        ? `Grade ${g}: strong human response and persistence — natural Growth candidate (Source Master §10). Not confirmed: ${gaps.join('; ')}.`
        : `Grade ${g}: strong human response and persistence — natural Growth candidate (Source Master §10), and qualification data is on record.`,
    };
  }

  if (FRONT_DESK_GRADES.has(g)) {
    return {
      tier: 'Core / Front Desk (candidate)',
      tier_reason: `Grade ${g}: observed front-desk response gap — natural Core / Front Desk candidate (Source Master §10), subject to qualification and segment rules.`,
    };
  }

  return { tier: '', tier_reason: `Unrecognised grade "${grade}" — no tier assigned.` };
}

// Which Tier-Sheet qualification inputs are missing for this agency. Named
// explicitly so the gap is visible in the workbook rather than assumed away.
function qualificationGaps(agency) {
  if (!agency) return ['no agency record available'];
  const gaps = [];
  if (!String(agency.branch_count ?? '').trim()) gaps.push('branch count unknown');
  if (!String(agency.years_trading ?? '').trim()) gaps.push('years trading unknown');
  if (!String(agency.sales_led_lettings_only ?? '').trim()) gaps.push('sales-led vs lettings-only unknown');
  if (!String(agency.independent_franchise_corporate ?? '').trim()) gaps.push('ownership type unknown');
  return gaps;
}

// The commercial angle the eventual personalised outreach will be built from.
// This is EVIDENCE SUMMARY, not copy: it states what was observed and what it
// implies, and stops short of writing the sales email (explicitly deferred).
export function salesAngle(grade, observation = {}) {
  const g = String(grade || '').trim().toUpperCase();
  const lag = typeof observation.human_lag_hours === 'number'
    ? `${Math.round(observation.human_lag_hours * 10) / 10}h`
    : 'unknown';
  const followUps = observation.follow_up_count || 0;

  switch (g) {
    case 'A':
      return `Responded in ${lag} with ${followUps} genuine follow-up attempt(s). Front desk is already strong — the angle is growth and conversion quality, not speed.`;
    case 'B':
      return `Responded in ${lag} with ${followUps} genuine follow-up attempt(s). Solid persistence, but first contact was not same-hour — the angle is closing the speed gap.`;
    case 'C':
      return `Responded fast (${lag}) but never followed up. The angle is persistence: the first reply was good and the lead was then dropped.`;
    case 'D':
      return `Responded in ${lag} and never followed up. The angle is both speed and persistence on a single unrepeated touch.`;
    case 'E':
      return `Took ${lag} to reach a human but did follow up. The angle is speed — the intent to chase exists, the response time undermines it.`;
    case 'F':
      return `Took ${lag} to reach a human and never followed up. The angle is a slow, single-touch front desk.`;
    case 'G':
      return 'Automated acknowledgement only — no human ever made contact. The angle is that the enquiry was received and then went nowhere.';
    case 'H':
      return 'No meaningful response on any channel across the full four-day window. The angle is a complete miss on a live enquiry.';
    default:
      return '';
  }
}

// Every active prospect must have a next action (Source Master source-of-truth
// principle). Derived from observation state + grade, so no probe can end up
// resolved with nothing queued behind it.
export function nextAction({ grade, observationStatus, probe }) {
  const g = String(grade || '').trim().toUpperCase();
  const closed = String(observationStatus || '').toLowerCase() === 'closed';

  if (!closed) {
    return {
      action_type: 'await_observation',
      priority: 'low',
      reason: `Observation window open until ${probe?.observation_deadline || 'its deadline'}; evidence still accumulating.`,
      due_at: probe?.observation_deadline || '',
    };
  }

  if (!g || g === 'PENDING') {
    return {
      action_type: 'review_observation',
      priority: 'high',
      reason: 'Observation window closed without resolving to a grade — needs a human look before this agency is used.',
      due_at: '',
    };
  }

  if (GROWTH_GRADES.has(g)) {
    return {
      action_type: 'qualify_for_growth',
      priority: 'high',
      reason: `Grade ${g} — strong front desk. Confirm Tier 2 qualification data before positioning.`,
      due_at: '',
    };
  }

  return {
    action_type: 'prepare_front_desk_outreach',
    priority: g === 'H' || g === 'G' ? 'high' : 'medium',
    reason: `Grade ${g} — evidenced front-desk gap. Build the personalised opener from the captured evidence.`,
    due_at: '',
  };
}
