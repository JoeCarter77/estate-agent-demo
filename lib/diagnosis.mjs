// lib/diagnosis.mjs — deterministic, rules-based Diagnosis derivation.
//
// Diagnosis is a commercial read of an already-graded, closed Intelligence
// record. It adds NO new evidence and NO new grading: it consumes the A-H
// grade + grade_reason lib/grading.mjs already produced (Source Master
// §10) and applies the fixed Grade -> Tier routing table from
// docs/Novus_Tier_Sheets_Updated_2026-08-14.docx ("Probe Grade & Tier
// Routing"): A/B -> Growth opportunity, C-H -> Core / Front Desk opportunity.
//
// EVIDENCE-AWARE (this is the fix): the grade alone answers one question —
// response speed and persistence. When the grade is strong (A/B) that question
// has no problem in it, and Diagnosis used to stop there and report
// "None observed", discarding everything else Intelligence had established
// about the agency. But a Grade A agency that answered in four minutes and
// still never mentioned the vendor's declared intention to sell has a real,
// and commercially larger, problem — it just isn't a speed problem.
//
// So the primary problem is now chosen from ALL the evidence on the
// Intelligence row, in commercial-importance order (see PROBLEM_CANDIDATES
// below): the grade's own finding is one candidate among several, and the
// highest-priority candidate the evidence actually supports wins. Nothing is
// invented — every candidate is gated on a field lib/observation.mjs,
// lib/vendor-intent.mjs or lib/grading.mjs already computed and wrote.
//
// The A-H grade itself is NOT changed, re-derived or contaminated by any of
// this: grade and tier still come from the grade alone, exactly as before.
//
// Pure function, no I/O — same shape as lib/grading.mjs.

import { readVendorStatus } from './vendor-intent.mjs';

const TIER_BY_GRADE = {
  A: 'Growth', B: 'Growth',
  C: 'Core', D: 'Core', E: 'Core', F: 'Core', G: 'Core', H: 'Core',
};

const PRIMARY_PROBLEM_BY_GRADE = {
  A: 'No response-handling problem — very fast human contact with genuine follow-up persistence.',
  B: 'No response-handling problem — fast human contact with genuine follow-up persistence.',
  C: 'Fast first response but no follow-up persistence after it.',
  D: 'Slower first response (over 1 hour) and no follow-up persistence.',
  E: 'Slow first response (over 16 hours), though follow-up persistence exists.',
  F: 'Slow first response (over 16 hours) and no follow-up persistence.',
  G: 'Automated acknowledgement only — no human contact at all.',
  H: 'No meaningful response on any channel within the 4-day observation window.',
};

const COMMERCIAL_IMPLICATION_BY_TIER = {
  Growth: 'Front-desk response is already strong; the commercial opportunity is volume/pipeline (database and appraisal follow-through), not response handling.',
  Core: 'Enquiries are going cold before, or shortly after, first contact — a direct front-desk response-handling gap.',
};

const RECOMMENDED_SOLUTION_BY_TIER = {
  Growth: 'NOVUS Growth',
  Core: 'NOVUS Core (Front Desk)',
};

const SALES_ANGLE_BY_GRADE = {
  A: 'Their front desk already performs at the top of the market — the conversation is about the stalled valuation list, not response speed.',
  B: 'Their front desk performs well — the opening is the database and appraisal pipeline they are not yet working.',
  C: 'They respond fast once, then nothing — Core’s automatic second and third chase closes that gap with no extra leads.',
  D: 'The first reply already takes over an hour and nobody chases after it — Core answers inside a minute and keeps chasing.',
  E: 'They do chase, but the first reply is too slow to beat the other agents the prospect also messaged that night.',
  F: 'Slow first reply and no chase after it — the exact gap Core is built to close.',
  G: 'They look responsive because of the auto-reply, but no human ever actually follows up — Core turns that acknowledgement into a real conversation.',
  H: 'The enquiry went completely unanswered — the clearest possible case for Core.',
};

// ── Evidence-based problem candidates ────────────────────────────────────────
// Ordered most commercially important FIRST. Each `when` reads only fields
// already present on the Intelligence row. The first candidate whose `when`
// holds becomes primary_problem; the rest are preserved in
// `secondary_problems` so nothing found is thrown away.
//
// Rationale for the order: a missed vendor/valuation opportunity is worth more
// than a viewing, and a missed viewing booking is worth more than a stylistic
// weakness in how the agency responded. The grade's own finding sits below
// them because A-H already has its own field (grade/grade_reason) and its own
// tier routing — it is never lost by being outranked here.
const PROBLEM_CANDIDATES = [
  {
    key: 'vendor_missed',
    when: (ev) => ev.vendorStatus === 'no_evidence',
    problem: 'The vendor opportunity was never picked up — the enquiry declared a property to sell that is not yet on the market, and no human communication ever mentioned selling, a valuation or a market appraisal.',
    implication: 'A live instruction lead was handed to them and went unrecognised — the highest-value miss in the whole observation, independent of how fast they answered.',
  },
  {
    key: 'vendor_stalled',
    when: (ev) => ev.vendorStatus === 'acknowledged' || ev.vendorStatus === 'discussed',
    problem: 'The vendor opportunity was raised but never converted — selling/valuation was discussed and no valuation or market appraisal was ever actually booked.',
    implication: 'They can spot an instruction lead but not close one into a valuation appointment — the gap sits at conversion, not recognition.',
  },
  {
    key: 'no_booking_push',
    when: (ev) => ev.hasHumanContact && !ev.bookingAttempt,
    problem: 'Human contact was made but no viewing or valuation was ever proposed — the conversation never moved toward an appointment.',
    implication: 'Enquiries are being answered rather than converted; the response exists but produces no diary activity.',
  },
  {
    key: 'reactive_only',
    when: (ev) => ev.hasHumanContact && ev.proactiveReactive === 'reactive',
    problem: 'Contact was purely reactive — a single responding attempt, with no follow-up and no push for a specific time or the prospect\'s availability.',
    implication: 'They answer when contacted and then wait; anything not closed on the first touch is left to go cold.',
  },
];

// Which of the above the evidence supports, ignoring order.
function evidenceOf(intelligence, grade) {
  const num = (v) => (v === '' || v == null ? 0 : Number(v) || 0);
  return {
    vendorStatus: readVendorStatus(intelligence.ai_evidence_summary),
    hasHumanContact: String(intelligence.first_human_touch || '').trim().toLowerCase() === 'yes',
    bookingAttempt: intelligence.booking_attempt === 'TRUE' || intelligence.booking_attempt === true,
    proactiveReactive: String(intelligence.proactive_reactive || '').trim().toLowerCase(),
    followUpCount: num(intelligence.follow_up_count),
    grade,
  };
}

// Builds an evidence summary strictly from fields lib/observation.mjs and
// lib/grading.mjs already computed on the Intelligence row — no new claims.
function buildEvidenceSummary(intelligence) {
  const parts = [];
  if (intelligence.grade_reason) parts.push(intelligence.grade_reason);
  if (intelligence.proactive_reactive) parts.push(`Contact posture: ${intelligence.proactive_reactive}.`);
  if (intelligence.human_lag_hours !== '' && intelligence.human_lag_hours != null) {
    parts.push(`Human lag: ${intelligence.human_lag_hours}h.`);
  }
  parts.push(`Follow-ups: ${intelligence.follow_up_count || 0}.`);
  if (intelligence.channels_used) parts.push(`Channels used: ${intelligence.channels_used}.`);
  if (intelligence.days_chased !== '' && intelligence.days_chased != null) {
    parts.push(`Days chased: ${intelligence.days_chased}.`);
  }
  // The Intelligence evidence read itself — the vendor line plus the verbatim
  // quotes lib/evidence-summary.mjs collected. Previously discarded here, which
  // is why a Diagnosis row could say nothing the grade hadn't already said.
  if (intelligence.ai_evidence_summary) parts.push(String(intelligence.ai_evidence_summary));
  return parts.join(' ');
}

// intelligence: an INTELLIGENCE row object (observation_status must already
// be 'closed' — caller's responsibility, same convention as gradeObservation).
// Returns null for a grade the routing table has no entry for (e.g.
// 'pending' — should not occur once closed, but defensive rather than
// throwing on unexpected data).
export function computeDiagnosis(intelligence) {
  // Same normalization rationale as the observation_status check in
  // lib/diagnosis-rebuild.mjs: a sheet-sourced grade with incidental
  // whitespace/case would otherwise silently miss every TIER_BY_GRADE entry.
  const grade = String(intelligence.grade || '').trim().toUpperCase();
  const tier = TIER_BY_GRADE[grade];
  if (!tier) return null;

  const evidence = evidenceOf(intelligence, grade);
  const supported = PROBLEM_CANDIDATES.filter((c) => c.when(evidence));

  // The grade's own finding is always a candidate too, ranked below the
  // evidence-based ones for A/B (where the grade found no problem at all) and
  // ABOVE them for C-H (where the grade IS the headline problem — a front-desk
  // that never answers is the thing to sell against, whatever else is true).
  const gradeProblem = {
    key: `grade_${grade}`,
    problem: PRIMARY_PROBLEM_BY_GRADE[grade],
    implication: COMMERCIAL_IMPLICATION_BY_TIER[tier],
  };
  const gradeFoundAProblem = tier === 'Core';
  const ranked = gradeFoundAProblem ? [gradeProblem, ...supported] : [...supported, gradeProblem];

  const primary = ranked[0];
  const secondary = ranked.slice(1);

  // Everything else the evidence supports is KEPT, appended to the existing
  // evidence_summary column rather than discarded (and rather than adding a
  // new DIAGNOSIS column for it). So a probe with several weaknesses shows all
  // of them, and the most commercially important one is simply the one
  // promoted to primary_problem.
  const alsoObserved = secondary.length > 0
    ? ` Also observed: ${secondary.map((c) => c.problem).join(' ')}`
    : '';

  return {
    grade,
    tier,
    primary_problem: primary.problem,
    evidence_summary: `${buildEvidenceSummary(intelligence)}${alsoObserved}`.trim(),
    commercial_implication: primary.implication || COMMERCIAL_IMPLICATION_BY_TIER[tier],
    recommended_solution: RECOMMENDED_SOLUTION_BY_TIER[tier],
    sales_angle: SALES_ANGLE_BY_GRADE[grade],
  };
}
