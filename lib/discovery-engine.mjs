// lib/discovery-engine.mjs — the DETERMINISTIC diagnostic layer behind the
// meeting discovery workspace. Pure functions over stored answers; no I/O,
// no model calls. The AI (lib/discovery-pitch.mjs) only ever explains what
// this file decided — it never chooses interventions or invents them.
//
//   assessDimensions(answers, overrides)   → per-dimension finding + evidence status
//   evaluateInterventions(...)             → which deployment rules apply, their
//                                            feasibility and dependency resolution
//   computeEconomics(answers)              → baseline + clearly-labelled illustrations
//   decideSuitability(...)                 → POTENTIAL_FIT | FURTHER_VALIDATION_REQUIRED | NOT_CURRENTLY_SUITABLE
//   buildPlan(diagnosis)                   → the 60-day plan, populated from the selected rules
//   diagnose(session)                      → all of the above in one object
//
// EVIDENCE STATUSES (never upgraded by anything but a recorded override):
//   CONFIRMED          weak/partial primary + a cause + a consequence
//   PROVISIONAL        weak/partial primary, exploration incomplete
//   UNKNOWN            no usable primary answer
//   EXISTING_STRENGTH  strong primary; `verified` says whether the verification
//                      question confirmed it
//   OUTSIDE_SCOPE      a real problem NOVUS does not solve in the pilot
//                      (today: a process that exists but is not followed)
//
// Unknown numbers are unknown. They are never treated as zero.

import {
  QUESTIONS, QUESTION_BY_ID, DIMENSIONS, QUESTIONS_VERSION,
  optionOf, levelOf, effectiveLevel, answerValues, effectiveAnswers, visibleQuestions,
} from './discovery-questions.mjs';
import { RULES, RULE_BY_ID, RULES_VERSION, DELIVERY_STATUSES, PLAN_PHASES, FOUNDING_OFFER } from './discovery-rules.mjs';

const text = (value) => String(value ?? '').trim();
const num = (value) => { if (value === '' || value === null || value === undefined) return null; const n = Number(value); return Number.isFinite(n) ? n : null; };

export const EVIDENCE = Object.freeze(['CONFIRMED', 'PROVISIONAL', 'UNKNOWN', 'EXISTING_STRENGTH', 'OUTSIDE_SCOPE']);
export const FEASIBILITY = Object.freeze(['FEASIBLE', 'FEASIBLE_WITH_FOUNDATION', 'REQUIRES_ASSESSMENT', 'INFEASIBLE']);
export const SUITABILITY = Object.freeze(['POTENTIAL_FIT', 'FURTHER_VALIDATION_REQUIRED', 'NOT_CURRENTLY_SUITABLE']);

// Demand thresholds behind "insufficient existing demand". Deliberately
// modest and in one place: an agency below BOTH has nothing for the
// intelligence workflows to work with inside sixty days.
export const SUITABILITY_POLICY = Object.freeze({
  min_enquiries_per_month: 30,
  min_database_contacts: 300,
});

function labelsFor(question, values) {
  return values.map((value) => optionOf(question, value)?.label || value);
}
function answered(answer) {
  return Boolean(answer) && !answer.skipped && (answerValues(answer).length > 0 || text(answer.value) !== '' || num(answer.value) !== null);
}
function meaningful(answer) {
  // Answered with something other than "don't know".
  if (!answered(answer)) return false;
  const values = answerValues(answer);
  if (values.length) return values.some((value) => value !== 'unknown');
  return true;
}
function numericAnswer(answers, id) {
  const answer = answers?.[id];
  if (!answer || answer.skipped) return { value: null, source: '' };
  return { value: num(answer.value), source: text(answer.source) || 'owner_estimate' };
}
function noteOf(answers, id) { return text(answers?.[id]?.note); }

// ── 1. dimension assessment ───────────────────────────────────────────────
// `stored` is the operator's recorded answers; the assessment reads them
// through the shared discovery context (lib/discovery-questions.mjs
// effectiveAnswers), so a question an earlier answer already covered
// contributes its DERIVED answer. Which answers were derived, and from what,
// is recorded on the finding — and a derived finding can only be CONFIRMED
// when every dimension it was derived from is CONFIRMED itself.
export function assessDimension(dimensionId, stored = {}, overrides = {}, { withCoverage = true } = {}) {
  const eff = withCoverage ? effectiveAnswers(stored) : { answers: stored, coverage: {} };
  const answers = eff.answers;
  const dimension = DIMENSIONS.find((d) => d.id === dimensionId);
  const primary = QUESTION_BY_ID[dimensionId];
  const primaryAnswer = answers[dimensionId];
  const level = effectiveLevel(dimensionId, answers);
  const reportedLevel = levelOf(primary, primaryAnswer);
  const verifyAnswer = answers[`${dimensionId}_verify`];
  const verifyOption = verifyAnswer && !verifyAnswer.skipped ? optionOf(QUESTION_BY_ID[`${dimensionId}_verify`], verifyAnswer.value) : null;

  const pick = (role) => QUESTIONS.find((question) => question.dimension === dimensionId && question.role === role);
  const causeQ = pick('cause');
  const consequenceQ = pick('consequence');
  const causeValues = answerValues(answers[causeQ?.id]).filter((value) => value !== 'unknown');
  const consequenceValues = answerValues(answers[consequenceQ?.id]).filter((value) => value !== 'unknown');
  const details = {};
  for (const question of QUESTIONS.filter((q) => q.dimension === dimensionId && q.role === 'detail')) {
    const answer = answers[question.id];
    if (!answer || answer.skipped) continue;
    details[question.id] = question.type === 'number' ? num(answer.value) : (question.multi ? answerValues(answer) : text(answer.value));
  }
  const frequency = text(answers[`${dimensionId}_frequency`]?.value);
  const tried = answerValues(answers[`${dimensionId}_tried`]);
  const example = text(answers[`${dimensionId}_example`]?.value);
  const ownerNotes = QUESTIONS.filter((q) => q.dimension === dimensionId).map((q) => noteOf(answers, q.id)).filter(Boolean);

  const exploring = level === 'weak' || level === 'partial';
  const required = exploring ? [causeQ?.id, consequenceQ?.id].filter(Boolean) : (level === 'strong' ? [`${dimensionId}_verify`] : []);
  const missing = required.filter((id) => !meaningful(answers[id]));

  let evidence = 'UNKNOWN';
  let verified = null;
  let managementIssue = false;
  let note = '';
  if (level === 'unknown') {
    evidence = 'UNKNOWN';
    note = primaryAnswer?.skipped ? `Skipped: ${text(primaryAnswer.skip_reason) || 'no reason recorded'}` : 'Not yet answered, or owner did not know.';
  } else if (level === 'strong') {
    evidence = 'EXISTING_STRENGTH';
    verified = verifyOption ? verifyOption.verdict === 'confirm' : false;
    note = verifyOption ? 'Verified with a follow-up question.' : 'Reported by the owner; not yet verified.';
  } else {
    // weak or partial
    const processExists = dimensionId === 'F1' && text(answers.F1_process?.value) === 'exists_not_followed';
    const onlyAdoption = causeValues.length > 0 && causeValues.every((value) => value === 'staff_adoption');
    if (onlyAdoption && processExists) {
      managementIssue = true;
      evidence = 'OUTSIDE_SCOPE';
      note = 'A process exists and is not followed. That is a management matter, not a software gap — NOVUS can make the gap visible (see F4) but should not be pitched as the fix.';
    } else if (missing.length === 0) {
      evidence = 'CONFIRMED';
      note = reportedLevel === 'strong' ? 'Reported as strong, but the verification question showed a gap; cause and consequence recorded.' : 'Cause and consequence recorded.';
    } else {
      evidence = 'PROVISIONAL';
      note = `Needs ${missing.map((id) => (id.endsWith('_cause') ? 'a cause' : 'a consequence')).join(' and ')} before it can be confirmed.`;
    }
  }

  // Shared-context bookkeeping: which of this dimension's answers came from
  // an earlier answer rather than being asked, and the cap that implies.
  const derived = QUESTIONS.filter((q) => q.dimension === dimensionId && eff.coverage[q.id])
    .map((q) => ({ question: q.id, basis: eff.coverage[q.id].basis, note: eff.coverage[q.id].note }));
  const basisDimensions = [...new Set(derived.flatMap((d) => d.basis).map((id) => QUESTION_BY_ID[id]?.dimension).filter((d) => d && d !== dimensionId))];
  if (derived.some((d) => d.question === dimensionId) && evidence === 'CONFIRMED') {
    const basisConfirmed = basisDimensions.every((d) => assessDimension(d, stored, {}, { withCoverage: false }).evidence_status === 'CONFIRMED');
    if (!basisConfirmed) { evidence = 'PROVISIONAL'; note = `Derived from ${basisDimensions.join(', ')}, which is not yet confirmed itself.`; }
    else note = `Derived from ${basisDimensions.join(', ')} (${derived.find((d) => d.question === dimensionId).note})`;
  } else if (derived.length && level !== 'unknown') {
    note = `${note} ${derived.map((d) => `${d.question.replace(`${dimensionId}_`, '')} carried from ${d.basis.join('/')}`).join('; ')}.`.trim();
  }

  const override = overrides?.[dimensionId] && typeof overrides[dimensionId] === 'object' ? overrides[dimensionId] : null;
  const original = { level, evidence_status: evidence };
  let finalLevel = level;
  let finalEvidence = evidence;
  if (override) {
    if (override.level && ['weak', 'partial', 'strong', 'unknown'].includes(override.level)) finalLevel = override.level;
    if (override.evidence_status && EVIDENCE.includes(override.evidence_status)) finalEvidence = override.evidence_status;
    // A strength asserted by override (operator or owner) rather than by a
    // verified answer is an UNVERIFIED strength: reused, and checked early.
    if (finalEvidence === 'EXISTING_STRENGTH' && evidence !== 'EXISTING_STRENGTH') verified = false;
  }

  const causeLabels = labelsFor(causeQ, causeValues);
  const consequenceLabels = labelsFor(consequenceQ, consequenceValues);
  const primaryLabel = primaryAnswer && !primaryAnswer.skipped ? (optionOf(primary, primaryAnswer.value)?.label || '') : '';
  const summaryBits = [];
  if (primaryLabel) summaryBits.push(primaryLabel);
  if (causeLabels.length) summaryBits.push(`because: ${causeLabels.join(', ').toLowerCase()}`);
  if (consequenceLabels.length) summaryBits.push(`costing: ${consequenceLabels.join(', ').toLowerCase()}`);

  return {
    dimension: dimensionId, label: dimension?.label || dimensionId, section: dimension?.section || '',
    level: finalLevel, reported_level: reportedLevel, evidence_status: finalEvidence, verified,
    primary_value: text(primaryAnswer?.value), primary_label: primaryLabel,
    verification: verifyOption ? { value: verifyOption.value, label: verifyOption.label, verdict: verifyOption.verdict } : null,
    causes: causeValues.map((value, i) => ({ value, label: causeLabels[i] })),
    consequences: consequenceValues.map((value, i) => ({ value, label: consequenceLabels[i] })),
    frequency: frequency && frequency !== 'unknown' ? frequency : '',
    tried: tried.filter((value) => value !== 'unknown'),
    example, details, owner_notes: ownerNotes,
    exploration: { required, missing, complete: missing.length === 0 },
    derived, basis_dimensions: basisDimensions,
    management_issue: managementIssue,
    note,
    override: override ? { ...override, original } : null,
    summary: summaryBits.join(' — '),
  };
}

export function assessDimensions(answers = {}, overrides = {}) {
  return Object.fromEntries(DIMENSIONS.map((d) => [d.id, assessDimension(d.id, answers, overrides)]));
}

// ── 2. interventions ──────────────────────────────────────────────────────
const FEAS_RANK = { FEASIBLE: 0, FEASIBLE_WITH_FOUNDATION: 1, REQUIRES_ASSESSMENT: 2, INFEASIBLE: 3 };
const worse = (a, b) => (FEAS_RANK[a] >= FEAS_RANK[b] ? a : b);

function applyAnswerConditions(rule, answers) {
  let feasibility = 'FEASIBLE';
  const blockers = [];
  const assessment = [];
  const validation = [];
  for (const condition of rule.answer_conditions || []) {
    const question = QUESTION_BY_ID[condition.question];
    const answer = answers?.[condition.question];
    if (!question) continue;
    if (condition.not) {
      const value = text(answer?.value);
      if (!answered(answer)) {
        // Unknown is unknown: it becomes something to validate, never a block.
        if (condition.effect === 'INFEASIBLE') validation.push(`${question.primary} (${condition.question} unanswered)`);
        continue;
      }
      if (condition.not.includes(value)) {
        // `unless` softens a block to an assessment when a follow-up answer
        // says the block is a "not sure how" rather than a real limit.
        const softened = condition.unless && answerValues(answers?.[condition.unless.question]).some((v) => condition.unless.any.includes(v));
        if (condition.effect === 'INFEASIBLE' && !softened) { feasibility = worse(feasibility, 'INFEASIBLE'); blockers.push(condition.note); }
        else { feasibility = worse(feasibility, 'REQUIRES_ASSESSMENT'); assessment.push(softened ? condition.unless.note || condition.note : condition.note); }
      }
    } else if (condition.min !== undefined) {
      const value = num(answer?.value);
      if (!answered(answer) || value === null) { validation.push(`${condition.note} (${condition.question} unknown)`); continue; }
      if (value < condition.min) { feasibility = worse(feasibility, 'REQUIRES_ASSESSMENT'); assessment.push(condition.note); }
    }
  }
  return { feasibility, blockers, assessment, validation };
}

export function evaluateInterventions(assessments, answers = {}, overrides = {}) {
  const ruleOverrides = overrides?.rules && typeof overrides.rules === 'object' ? overrides.rules : {};
  const evaluated = new Map();
  const order = ['F1', 'F2', 'F3', 'F4', 'F5', 'I1', 'I2', 'I3', 'I5', 'I4'];

  const isStrength = (dim) => assessments[dim]?.evidence_status === 'EXISTING_STRENGTH';
  const isUnknown = (dim) => assessments[dim]?.evidence_status === 'UNKNOWN';

  for (const ruleId of order) {
    const rule = RULE_BY_ID[ruleId];
    const assessment = assessments[rule.dimension];
    const override = ruleOverrides[ruleId] && typeof ruleOverrides[ruleId] === 'object' ? ruleOverrides[ruleId] : null;
    const triggered = rule.triggers.levels.includes(assessment.level) && ['CONFIRMED', 'PROVISIONAL'].includes(assessment.evidence_status);
    let candidate = triggered;
    let notSelectedReason = '';
    if (!triggered) {
      notSelectedReason = assessment.evidence_status === 'EXISTING_STRENGTH' ? 'existing_strength'
        : assessment.evidence_status === 'OUTSIDE_SCOPE' ? 'outside_scope'
        : assessment.evidence_status === 'UNKNOWN' ? 'unknown' : 'not_triggered';
    }
    if (override && override.include === true) { candidate = true; notSelectedReason = ''; }
    if (override && override.include === false) { candidate = false; notSelectedReason = 'excluded_by_override'; }

    const item = {
      rule_id: ruleId, dimension: rule.dimension, kind: rule.kind, title: rule.title,
      candidate, selected: false, not_selected_reason: notSelectedReason,
      confidence: assessment.evidence_status === 'CONFIRMED' ? 'CONFIRMED' : assessment.evidence_status === 'PROVISIONAL' ? 'PROVISIONAL' : (override?.include ? 'OVERRIDE' : ''),
      feasibility: 'FEASIBLE', delivery_status: rule.delivery_status, delivery_status_label: DELIVERY_STATUSES[rule.delivery_status] || rule.delivery_status,
      delivery_status_note: rule.delivery_status_note,
      dependencies: [], blockers: [], assessment_items: [], validation_items: [], added_for_dependency: false,
      override: override || null,
    };
    if (!candidate) { evaluated.set(ruleId, item); continue; }

    const conditions = applyAnswerConditions(rule, answers);
    item.feasibility = conditions.feasibility;
    item.blockers.push(...conditions.blockers);
    item.assessment_items.push(...conditions.assessment);
    item.validation_items.push(...conditions.validation);

    for (const dep of rule.dependencies || []) {
      if (dep.any_of_rules) {
        const satisfiedBy = dep.any_of_rules.filter((id) => evaluated.get(id)?.selected);
        const resolution = satisfiedBy.length ? 'provided' : (dep.soft ? 'soft' : 'missing');
        item.dependencies.push({ need: dep.need, rules: dep.any_of_rules, resolution, note: satisfiedBy.length ? `Provided by ${satisfiedBy.join(', ')}` : `Needs an opportunity source (${dep.any_of_rules.join(' or ')}) or an existing worked list` });
        if (resolution === 'missing') { item.feasibility = worse(item.feasibility, 'REQUIRES_ASSESSMENT'); item.assessment_items.push(dep.need); }
        continue;
      }
      const dim = dep.dimension;
      let resolution;
      let note;
      if (isStrength(dim)) { resolution = 'existing'; note = `${dim} is an existing strength — reused, not rebuilt${assessments[dim].verified === false ? ' (unverified)' : ''}`; }
      else if (evaluated.get(dim)?.selected) { resolution = 'provided'; note = `Provided by the ${dim} foundation work in this plan`; }
      else if (isUnknown(dim)) { resolution = 'unknown'; note = `${dim} was not established in discovery — confirm before relying on it`; }
      else if (assessments[dim]?.evidence_status === 'OUTSIDE_SCOPE') { resolution = 'blocked'; note = `${dim} is outside scope (management issue) — this cannot be built on it in the pilot`; }
      else if (evaluated.get(dim) && evaluated.get(dim).candidate && evaluated.get(dim).feasibility === 'INFEASIBLE') { resolution = 'blocked'; note = `${dim} is infeasible in the pilot: ${evaluated.get(dim).blockers.join('; ')}`; }
      else if (evaluated.get(dim) && evaluated.get(dim).candidate) { resolution = 'assess'; note = `${dim} needs technical assessment first`; }
      else {
        // Weak dimension whose rule was not selected (e.g. excluded, or not
        // triggered): identify the required foundation intervention.
        const foundation = evaluated.get(dim);
        if (foundation && foundation.not_selected_reason === 'excluded_by_override') { resolution = 'blocked'; note = `${dim} was excluded by override — this depends on it`; }
        else if (foundation && ['weak', 'partial'].includes(assessments[dim]?.level)) {
          foundation.candidate = true; foundation.selected = true; foundation.added_for_dependency = true; foundation.confidence = foundation.confidence || 'PROVISIONAL';
          resolution = 'added'; note = `${dim} added to the plan because ${ruleId} depends on it`;
        } else { resolution = dep.soft ? 'soft' : 'unknown'; note = `${dim}: ${dep.need}`; }
      }
      item.dependencies.push({ dimension: dim, need: dep.need, resolution, note, soft: Boolean(dep.soft) });
      if (dep.soft) continue;
      if (resolution === 'provided' || resolution === 'added') item.feasibility = worse(item.feasibility, 'FEASIBLE_WITH_FOUNDATION');
      else if (resolution === 'unknown') { item.feasibility = worse(item.feasibility, 'REQUIRES_ASSESSMENT'); item.validation_items.push(`Confirm ${dim} (${dep.need})`); }
      else if (resolution === 'assess') { item.feasibility = worse(item.feasibility, 'REQUIRES_ASSESSMENT'); item.assessment_items.push(note); }
      else if (resolution === 'blocked') { item.feasibility = worse(item.feasibility, 'INFEASIBLE'); item.blockers.push(note); }
    }
    item.selected = item.feasibility !== 'INFEASIBLE';
    evaluated.set(ruleId, item);
  }
  return RULES.map((rule) => evaluated.get(rule.rule_id));
}

// ── 3. economics ──────────────────────────────────────────────────────────
// Every figure carries its source. Illustrations are labelled as such and
// are computed only from figures the owner actually gave.
export function computeEconomics(answers = {}) {
  const fee = numericAnswer(answers, 'C10');
  const valuations = numericAnswer(answers, 'C8');
  const instructions = numericAnswer(answers, 'C9');
  const enquiries = numericAnswer(answers, 'C4');
  const database = numericAnswer(answers, 'C5');
  const sellerSignals = numericAnswer(answers, 'I1_volume');
  let conversion = numericAnswer(answers, 'C11');
  let conversionSource = conversion.value !== null ? conversion.source : '';
  if (conversion.value === null && valuations.value && instructions.value !== null) {
    conversion = { value: Math.round((instructions.value / valuations.value) * 1000) / 10, source: 'derived' };
    conversionSource = `derived from ${instructions.value} instructions / ${valuations.value} valuations (${valuations.source}, ${instructions.source})`;
  }
  const missing = [];
  if (fee.value === null) missing.push('average fee per instruction');
  if (conversion.value === null) missing.push('valuation-to-instruction conversion');
  if (valuations.value === null) missing.push('monthly valuations');
  const baseline = {
    fee_per_instruction: { value: fee.value, source: fee.source },
    conversion_pct: { value: conversion.value, source: conversion.value !== null ? (conversion.source === 'derived' ? 'derived' : conversion.source) : '', detail: conversionSource },
    valuations_per_month: { value: valuations.value, source: valuations.source },
    instructions_per_month: { value: instructions.value, source: instructions.source },
    enquiries_per_month: { value: enquiries.value, source: enquiries.source },
    database_size: { value: database.value, source: database.source },
    seller_signals_per_month: { value: sellerSignals.value, source: sellerSignals.source },
  };
  const available = fee.value !== null && conversion.value !== null;
  const illustrations = available ? [1, 3, 5].map((extra) => {
    const extraInstructions = Math.round(extra * (conversion.value / 100) * 100) / 100;
    const monthly = Math.round(extraInstructions * fee.value);
    return {
      additional_valuations_per_month: extra,
      additional_instructions_per_month: extraInstructions,
      additional_fee_income_per_month_gbp: monthly,
      additional_fee_income_per_year_gbp: monthly * 12,
      kind: 'HYPOTHETICAL_ILLUSTRATION',
    };
  }) : [];
  return {
    available, missing, baseline, illustrations,
    disclaimer: 'Illustrations are hypothetical scenarios built from the figures given in the meeting. They are not forecasts, not guarantees, and not measured NOVUS outcomes. Measured, NOVUS-influenced outcomes are recorded separately during the pilot and only count as evidence of incremental results when they can be attributed.',
    categories: {
      actual_baseline: 'Figures the owner reported as actual',
      owner_estimate: 'Figures the owner estimated',
      hypothetical: 'Illustrative scenarios (above)',
      measured_novus_influenced: 'Recorded during the pilot — none yet',
      incremental_evidence: 'Attributed incremental results — none yet',
    },
  };
}

// ── 4. suitability ────────────────────────────────────────────────────────
export function decideSuitability({ assessments, interventions, economics, answers }) {
  const reasons = [];
  const dims = Object.values(assessments);
  const unknownDims = dims.filter((a) => a.evidence_status === 'UNKNOWN');
  const strengths = dims.filter((a) => a.evidence_status === 'EXISTING_STRENGTH');
  const candidates = interventions.filter((i) => i.candidate);
  const feasible = candidates.filter((i) => ['FEASIBLE', 'FEASIBLE_WITH_FOUNDATION'].includes(i.feasibility));
  const assess = candidates.filter((i) => i.feasibility === 'REQUIRES_ASSESSMENT');
  const infeasible = candidates.filter((i) => i.feasibility === 'INFEASIBLE');
  const confirmedFeasible = feasible.filter((i) => i.confidence === 'CONFIRMED' || i.confidence === 'OVERRIDE');
  const intelligenceFeasible = feasible.filter((i) => i.kind === 'intelligence');

  const enquiries = economics.baseline.enquiries_per_month.value;
  const database = economics.baseline.database_size.value;
  const demandKnown = enquiries !== null || database !== null;
  const lowEnquiries = enquiries !== null && enquiries < SUITABILITY_POLICY.min_enquiries_per_month;
  const lowDatabase = database !== null && database < SUITABILITY_POLICY.min_database_contacts;
  const insufficientDemand = (lowEnquiries && (database === null || lowDatabase)) || (lowDatabase && (enquiries === null || lowEnquiries));

  let verdict;
  let recommendation;
  if (insufficientDemand) {
    verdict = 'NOT_CURRENTLY_SUITABLE';
    reasons.push('INSUFFICIENT_DEMAND');
    recommendation = `Existing demand looks too small for a sixty-day pilot to show anything (${enquiries !== null ? `${enquiries} enquiries a month` : 'enquiry volume unknown'}${database !== null ? `, ${database} contacts in the database` : ''}). Do not pitch the pilot; note what would change the picture.`;
  } else if (candidates.length === 0 && unknownDims.length >= 5) {
    verdict = 'FURTHER_VALIDATION_REQUIRED';
    reasons.push('INCOMPLETE_DISCOVERY');
    recommendation = `Discovery is incomplete — ${unknownDims.length} of ten dimensions are unknown. Finish the foundations and intelligence questions before deciding.`;
  } else if (candidates.length === 0) {
    verdict = 'NOT_CURRENTLY_SUITABLE';
    reasons.push(strengths.length >= 8 ? 'EXISTING_CAPABILITY' : 'NO_ESTABLISHED_GAP');
    recommendation = strengths.length >= 8
      ? 'The agency already has what we would implement. No meaningful additional opportunity was established — do not pitch the pilot. Say so plainly, and leave the door open for a specific intelligence gap if one emerges.'
      : 'No commercially meaningful gap with a NOVUS intervention was established. Do not pitch the pilot on what has been heard so far.';
  } else if (feasible.length === 0 && assess.length > 0) {
    verdict = 'FURTHER_VALIDATION_REQUIRED';
    reasons.push('TECHNICAL_ASSESSMENT');
    recommendation = `Every relevant intervention (${assess.map((i) => i.rule_id).join(', ')}) needs a technical assessment first — ${[...new Set(assess.flatMap((i) => i.assessment_items))].join('; ')}. Propose the assessment, not the pilot.`;
  } else if (feasible.length === 0) {
    verdict = 'NOT_CURRENTLY_SUITABLE';
    reasons.push('DEPLOYMENT_INFEASIBLE');
    recommendation = `The gaps are real but the interventions are not feasible within the standard pilot: ${[...new Set(infeasible.flatMap((i) => i.blockers))].join('; ')}. Do not pitch the pilot as it stands.`;
  } else if (confirmedFeasible.length === 0) {
    verdict = 'FURTHER_VALIDATION_REQUIRED';
    reasons.push('EVIDENCE_PROVISIONAL');
    recommendation = 'There is potential value, but every finding is still provisional — a cause and a consequence are needed on at least one before pitching.';
  } else if (economics.missing.length >= 3) {
    verdict = 'FURTHER_VALIDATION_REQUIRED';
    reasons.push('ECONOMICS_UNKNOWN');
    recommendation = 'Feasible interventions exist, but none of the commercial baseline (fee, conversion, valuations) is known, so value cannot be framed or measured. Get the numbers, then pitch.';
  } else {
    verdict = 'POTENTIAL_FIT';
    reasons.push(intelligenceFeasible.length ? 'MEANINGFUL_GAP_WITH_INTERVENTION' : 'FOUNDATION_GAP_WITH_INTERVENTION');
    if (strengths.length >= 5 && intelligenceFeasible.length) reasons.push('STRONG_FOUNDATIONS_INTELLIGENCE_GAP');
    if (assess.length) reasons.push('SOME_ITEMS_NEED_ASSESSMENT');
    recommendation = `Pitch the pilot around ${feasible.map((i) => i.rule_id).join(', ')}${assess.length ? `, with ${assess.map((i) => i.rule_id).join(', ')} subject to assessment` : ''}${strengths.length ? `, preserving ${strengths.map((s) => s.dimension).join(', ')}` : ''}.`;
  }
  if (!demandKnown && verdict === 'POTENTIAL_FIT') reasons.push('DEMAND_UNCONFIRMED');
  return {
    verdict, reasons, recommendation, pitch_pilot: verdict === 'POTENTIAL_FIT',
    counts: { candidates: candidates.length, feasible: feasible.length, assess: assess.length, infeasible: infeasible.length, strengths: strengths.length, unknown: unknownDims.length },
  };
}

// ── 5. the 60-day plan ────────────────────────────────────────────────────
const INTELLIGENCE_PRIORITY = ['I1', 'I3', 'I2', 'I4', 'I5'];

export function buildPlan(diagnosis) {
  const selected = diagnosis.interventions.filter((i) => i.selected);
  const feasible = selected.filter((i) => ['FEASIBLE', 'FEASIBLE_WITH_FOUNDATION'].includes(i.feasibility));
  const assess = selected.filter((i) => i.feasibility === 'REQUIRES_ASSESSMENT');
  const foundations = feasible.filter((i) => i.kind === 'foundation');
  const strengths = diagnosis.findings.strengths;
  const rule = (id) => RULE_BY_ID[id];
  const first = INTELLIGENCE_PRIORITY.map((id) => feasible.find((i) => i.rule_id === id)).find(Boolean) || null;
  const remaining = feasible.filter((i) => i.kind === 'intelligence' && i.rule_id !== first?.rule_id);
  const access = [...new Set(selected.flatMap((i) => rule(i.rule_id).required_data_access))];
  const measures = [...new Set(selected.flatMap((i) => rule(i.rule_id).measurement))];
  const provisional = diagnosis.findings.provisional.map((f) => `${f.dimension} — ${f.label}`);
  const strong = strengths.length >= 5;

  const phases = PLAN_PHASES.map((phase) => ({ ...phase, novus_does: [], agency_does: [], changes: [], owner_sees: [], measures: [] }));
  const [p1, p2, p3, p4, p5] = phases;

  p1.novus_does.push('Walk through the discovery findings with the owner and confirm each one');
  if (provisional.length) p1.novus_does.push(`Confirm the provisional findings: ${provisional.join('; ')}`);
  if (assess.length) p1.novus_does.push(`Technical assessment: ${[...new Set(assess.flatMap((i) => i.assessment_items))].join('; ')}`);
  p1.novus_does.push('Agree the success criteria in writing before anything is configured');
  p1.novus_does.push('Record the baseline: current monthly valuations and instructions, and where they come from');
  p1.agency_does.push(...access.map((a) => `Provide: ${a}`));
  p1.agency_does.push('Confirm who owns the pilot on the agency side');
  p1.changes.push('Nothing changes for the team yet');
  p1.owner_sees.push('A one-page scope: findings, interventions, what each side does, how value will be judged');
  p1.measures.push('Baseline recorded', ...(diagnosis.economics.missing.length ? [`Fill the gaps in the baseline: ${diagnosis.economics.missing.join(', ')}`] : []));

  if (foundations.length) {
    for (const item of foundations) {
      const r = rule(item.rule_id);
      p2.novus_does.push(`${item.rule_id} ${r.title}: ${r.implementation_steps.slice(0, 3).join('; ')}`);
      p2.agency_does.push(...r.agency_responsibilities.map((x) => `${item.rule_id}: ${x}`));
      p2.changes.push(`${item.rule_id}: ${r.intervention}`);
      p2.owner_sees.push(...r.measurement.slice(0, 1).map((m) => `${item.rule_id}: ${m}`));
    }
    p2.measures.push(...foundations.flatMap((i) => rule(i.rule_id).measurement.slice(0, 1)));
  } else {
    p2.novus_does.push(strong ? `Foundations are in place — reuse them (${strengths.map((s) => s.dimension).join(', ')}); confirm the action workflow and how valuations/instructions will be confirmed`
      : 'No foundation work selected; confirm the action workflow and how valuations/instructions will be confirmed');
    p2.changes.push('Existing processes are preserved as they are');
    p2.owner_sees.push('Confirmation of which existing processes NOVUS plugs into');
  }
  for (const s of strengths) p2.changes.push(`Preserved: ${s.label} (${s.dimension})${s.verified === false ? ' — verified in days 1–3' : ''}`);

  if (first) {
    const r = rule(first.rule_id);
    p3.novus_does.push(`Activate ${first.rule_id} ${r.title}: ${r.implementation_steps.join('; ')}`);
    p3.agency_does.push(...r.agency_responsibilities);
    p3.changes.push(r.intervention);
    p3.owner_sees.push(...r.measurement.slice(0, 2));
    p3.measures.push(...r.measurement);
  } else if (foundations.length) {
    const r = rule(foundations[0].rule_id);
    p3.novus_does.push(`No intelligence workflow is feasible yet — the first live workflow is ${foundations[0].rule_id} ${r.title}`);
    p3.changes.push(r.intervention);
    p3.owner_sees.push(...r.measurement.slice(0, 1));
    p3.measures.push(...r.measurement);
  } else {
    p3.novus_does.push('No workflow to activate — this plan should not be presented as a pilot');
  }

  for (const item of remaining) {
    const r = rule(item.rule_id);
    p4.novus_does.push(`Add ${item.rule_id} ${r.title}: ${r.implementation_steps.slice(0, 2).join('; ')}`);
    p4.changes.push(r.intervention);
    p4.owner_sees.push(...r.measurement.slice(0, 1));
    p4.measures.push(...r.measurement.slice(0, 1));
  }
  for (const item of assess) {
    const r = rule(item.rule_id);
    p4.novus_does.push(`If the assessment passes, add ${item.rule_id} ${r.title}; otherwise it stays out of the pilot`);
  }
  if (first) p4.novus_does.push(`Review the first two weeks of ${first.rule_id} with the team and adjust the configuration`);
  p4.agency_does.push('Two-week review with the owner');
  if (!remaining.length && !assess.length) p4.changes.push('No expansion — refine the live workflow');

  p5.novus_does.push('Keep every opportunity progressing through the agreed workflow', 'Weekly outcome view; monthly review with the owner');
  p5.novus_does.push('Evaluate commercial value: valuations and instructions attributable to NOVUS-raised opportunities versus the baseline');
  p5.agency_does.push('Confirm valuations and instructions weekly', 'Take part in the day-45 and day-60 reviews');
  p5.changes.push('The workflow is business as usual for the team');
  p5.owner_sees.push('Attributed valuations and instructions, with the evidence for each', 'A written recommendation on continuation, based on measured value');
  p5.measures.push(...measures);
  p5.notes = [FOUNDING_OFFER.extension, 'No completion dates are promised beyond the phase structure; integrations are confirmed in days 1–3, not assumed.'];

  return {
    generated_from: { rules: selected.map((i) => i.rule_id), first_workflow: first?.rule_id || '', strengths: strengths.map((s) => s.dimension) },
    phases,
    required_access: access,
    measurement: measures,
    offer: FOUNDING_OFFER,
  };
}

// ── 6. the whole diagnosis ────────────────────────────────────────────────
export function diagnose({ answers: stored = {}, overrides = {}, notes = {} } = {}) {
  const { answers, coverage } = effectiveAnswers(stored);
  const assessments = assessDimensions(stored, overrides);
  const interventions = evaluateInterventions(assessments, answers, overrides);
  const economics = computeEconomics(answers);
  const suitability = decideSuitability({ assessments, interventions, economics, answers });

  const dims = Object.values(assessments);
  const findings = {
    confirmed: dims.filter((a) => a.evidence_status === 'CONFIRMED'),
    provisional: dims.filter((a) => a.evidence_status === 'PROVISIONAL'),
    unknown: dims.filter((a) => a.evidence_status === 'UNKNOWN'),
    strengths: dims.filter((a) => a.evidence_status === 'EXISTING_STRENGTH'),
    outside_scope: dims.filter((a) => a.evidence_status === 'OUTSIDE_SCOPE'),
  };

  const priorityQ = QUESTION_BY_ID.C1;
  const obstaclesQ = QUESTION_BY_ID.C2;
  const outcomeAnswer = answers.C1a && !answers.C1a.skipped ? answers.C1a : null;
  // "More instructions" is refined by the bottleneck the owner then named:
  // valuations through the door → the working objective is more valuations;
  // winning once there → winning more of the valuations they do. The stated
  // objective is kept alongside; "a bit of both" or no answer leaves it as is.
  const stated = text(answers.C1?.value);
  const bottleneckQ = QUESTION_BY_ID.C1b_instructions;
  const bottleneck = stated === 'more_instructions' ? text(answers.C1b_instructions?.value) : '';
  const priority = { valuation_volume: 'more_valuations', winning_instructions: 'win_instructions' }[bottleneck] || stated;
  const objective = {
    priority, priority_label: optionOf(priorityQ, priority)?.label || '',
    stated_priority: stated, stated_priority_label: optionOf(priorityQ, stated)?.label || '',
    bottleneck: bottleneck ? { value: bottleneck, label: optionOf(bottleneckQ, bottleneck)?.label || bottleneck } : null,
    obstacles: answerValues(answers.C2).map((value) => ({ value, label: optionOf(obstaclesQ, value)?.label || value })),
    // What "gone really well in six months" means to them, in their words.
    // The target is optional and stays null when they did not give one.
    outcome: { text: text(outcomeAnswer?.value), target: num(outcomeAnswer?.target), note: noteOf(answers, 'C1a') },
    notes: [noteOf(answers, 'C1'), noteOf(answers, 'C2'), noteOf(answers, 'C1a')].filter(Boolean),
    // How they would CURRENTLY generate the extra result (C12*) — private
    // context for the guidance; never a finding on its own.
    strategy: Object.fromEntries(['C12', 'C12_selection', 'C12_consistency', 'C12_existing', 'C12_change', 'C12_exhausted', 'C12_results', 'C12_belief']
      .map((id) => [QUESTION_BY_ID[id].key.replace(/^strategy_?/, '') || 'approach', answerValues(answers[id]).filter((v) => v !== 'unknown').map((v) => optionOf(QUESTION_BY_ID[id], v)?.label || v)])
      .concat([['output_per_month', numericAnswer(answers, 'C12_output').value], ['note', noteOf(answers, 'C12')]])),
  };
  const facts = {
    branches: numericAnswer(answers, 'C3').value,
    crm: text(answers.C6?.value) === 'other' ? (noteOf(answers, 'C6') || 'other') : (optionOf(QUESTION_BY_ID.C6, answers.C6?.value)?.label || ''),
    crm_access: text(answers.C7?.value), crm_access_label: optionOf(QUESTION_BY_ID.C7, answers.C7?.value)?.label || '',
  };

  const blockers = [...new Set(interventions.flatMap((i) => i.blockers))];
  if (text(answers.C7?.value) === 'blocked' && !blockers.length) blockers.push('CRM access is blocked — nothing that depends on historical records can be done in the pilot');
  const validation = [...new Set([
    ...findings.unknown.map((a) => `${a.dimension} ${a.label}: not established`),
    ...findings.provisional.map((a) => `${a.dimension} ${a.label}: ${a.note}`),
    ...findings.strengths.filter((a) => a.verified === false).map((a) => `${a.dimension} ${a.label}: reported strength not verified`),
    ...interventions.flatMap((i) => i.validation_items),
    ...(text(answers.C7?.value) === 'unsure' ? ['CRM export/access: owner unsure what is possible'] : []),
    ...economics.missing.map((m) => `Commercial baseline: ${m} unknown`),
  ])];
  const dependencies = interventions.filter((i) => i.candidate).flatMap((i) => i.dependencies.map((d) => ({ rule_id: i.rule_id, ...d })));

  const visible = visibleQuestions(stored);
  const progress = {
    visible: visible.length,
    answered: visible.filter((q) => answered(stored[q.id])).length,
    skipped: visible.filter((q) => stored[q.id]?.skipped).length,
    covered: Object.keys(coverage).length,
    required_missing: dims.flatMap((a) => a.exploration.missing),
  };

  const diagnosis = {
    versions: { questions: QUESTIONS_VERSION, rules: RULES_VERSION },
    objective, facts, assessments, findings, interventions,
    proposed: interventions.filter((i) => i.selected).map((i) => i.rule_id),
    preserved: findings.strengths.map((a) => ({ dimension: a.dimension, label: a.label, verified: a.verified, summary: a.summary })),
    dependencies, blockers, validation, economics, suitability, progress,
    // Shared discovery context: what was established elsewhere and reused.
    coverage: Object.fromEntries(Object.entries(coverage).map(([id, c]) => [id, { rule_id: c.rule_id, basis: c.basis, note: c.note, derived: c.derived }])),
    meeting_notes: text(notes?.meeting || ''),
  };
  diagnosis.plan = buildPlan(diagnosis);
  return diagnosis;
}

export const _internal = { applyAnswerConditions, answered, meaningful, numericAnswer, worse };
