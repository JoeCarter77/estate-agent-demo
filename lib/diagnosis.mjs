// lib/diagnosis.mjs — deterministic, rules-based Diagnosis derivation.
//
// Diagnosis is a commercial read of an already-graded, closed Intelligence
// record. It adds NO new evidence and NO new grading: it consumes the A-H
// grade + grade_reason lib/grading.mjs already produced (Source Master
// §10) and applies the fixed Grade -> Tier routing table from
// docs/Novus_Tier_Sheets_Updated_2026-08-14.docx ("Probe Grade & Tier
// Routing"): A/B -> Growth opportunity, C-H -> Core / Front Desk opportunity.
//
// Pure function, no I/O — same shape as lib/grading.mjs.

const TIER_BY_GRADE = {
  A: 'Growth', B: 'Growth',
  C: 'Core', D: 'Core', E: 'Core', F: 'Core', G: 'Core', H: 'Core',
};

const PRIMARY_PROBLEM_BY_GRADE = {
  A: 'None observed — very fast human contact with genuine follow-up persistence.',
  B: 'None observed — fast human contact with genuine follow-up persistence.',
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

// Builds an evidence summary strictly from fields lib/observation.mjs and
// lib/grading.mjs already computed on the Intelligence row — no new claims.
function buildEvidenceSummary(intelligence) {
  const parts = [];
  if (intelligence.grade_reason) parts.push(intelligence.grade_reason);
  if (intelligence.human_lag_hours !== '' && intelligence.human_lag_hours != null) {
    parts.push(`Human lag: ${intelligence.human_lag_hours}h.`);
  }
  parts.push(`Follow-ups: ${intelligence.follow_up_count || 0}.`);
  if (intelligence.channels_used) parts.push(`Channels used: ${intelligence.channels_used}.`);
  if (intelligence.days_chased !== '' && intelligence.days_chased != null) {
    parts.push(`Days chased: ${intelligence.days_chased}.`);
  }
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

  return {
    grade,
    tier,
    primary_problem: PRIMARY_PROBLEM_BY_GRADE[grade],
    evidence_summary: buildEvidenceSummary(intelligence),
    commercial_implication: COMMERCIAL_IMPLICATION_BY_TIER[tier],
    recommended_solution: RECOMMENDED_SOLUTION_BY_TIER[tier],
    sales_angle: SALES_ANGLE_BY_GRADE[grade],
  };
}
