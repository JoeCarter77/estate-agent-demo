#!/usr/bin/env node
// scripts/novus-discovery-selftest.mjs — hermetic test of the meeting
// discovery + personalised pitch system: the question registry, the
// deterministic diagnosis engine over the ten required scenarios, pitch
// generation/validation with a fake model (including a failing and an
// invalid model), and the handlers end to end against an in-memory workbook
// (start → autosave → override → pitch → outcome → persistence).
// No network, no credentials.
//
// Run:  npm run novus:discovery-selftest

import assert from 'node:assert/strict';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';
import { ACTIONS_HEADER } from '../lib/actions-store.mjs';
import { CALLS_HEADER } from '../lib/calling-store.mjs';
import { QUESTIONS, QUESTION_BY_ID, DIMENSIONS, isVisible, effectiveLevel, snapshotFor, QUESTIONS_VERSION, evaluateCoverage, visibleQuestions, wordingFor, visibleOptions, COVERAGE_RULES } from '../lib/discovery-questions.mjs';
import { RULES, RULE_BY_ID, DELIVERY_STATUSES, FOUNDING_OFFER } from '../lib/discovery-rules.mjs';
import { diagnose, assessDimension, computeEconomics, SUITABILITY_POLICY } from '../lib/discovery-engine.mjs';
import { templatePlan } from '../lib/discovery-pitch.mjs';
import { buildPitchInput, templatePitch, validatePitch, generatePitch, pitchSpoken, rankThemes, wordCount, SPOKEN_WORD_CAP, PLAN_PHASES_COMPACT } from '../lib/discovery-pitch.mjs';
import { DISCOVERY_SESSIONS_HEADER, DISCOVERY_PITCHES_HEADER, sessionView, pitchView } from '../lib/discovery-store.mjs';
import {
  handleDiscoveryMeetings, handleDiscoverySession, handleDiscoverySetup, handleDiscoveryStart,
  handleDiscoverySave, handleDiscoveryPitch, handleDiscoveryOutcome, handleDiscoveryConclusion, handleDiscoveryConclusionPolish,
  buildAgencyContext, cleanAnswers, sessionDiagnoses,
} from '../lib/discovery-handlers.mjs';
import { buildFindings, cleanConclusion, polishConclusion, validatePolishedText, presentationPayload } from '../lib/discovery-conclusion.mjs';

let passed = 0;
const ok = (msg) => { passed += 1; console.log(`  ✓ ${msg}`); };

// ── answer helpers ─────────────────────────────────────────────────────────
const a = (value, extra = {}) => ({ value, answered_at: '2026-09-21T10:00:00.000Z', ...extra });
const m = (values) => ({ values, answered_at: '2026-09-21T10:00:00.000Z' });
const weak = (dim, cause, consequence, extras = {}) => ({ [dim]: a(cause.primary), [`${dim}_cause`]: m(cause.causes), [`${dim}_consequence`]: m([consequence]), ...extras });
const strong = (dim, primary, verify) => ({ [dim]: a(primary), [`${dim}_verify`]: a(verify) });
const COMMERCIAL = { C1: a('more_valuations'), C2: m(['not_enough_opportunities', 'slipping_through']), C3: a(2, { source: 'AGENCIES' }), C4: a(250, { source: 'actual' }), C5: a(6000), C6: a('reapit'), C7: a('export'), C8: a(20, { source: 'actual' }), C9: a(8, { source: 'actual' }), C10: a(3500) };
const ALL_WEAK = {
  ...COMMERCIAL,
  ...weak('F1', { primary: 'patchy', causes: ['time', 'no_process'] }, 'missed_sellers'),
  ...weak('F2', { primary: 'no', causes: ['scattered'] }, 'missed_context'),
  ...weak('F3', { primary: 'memory', causes: ['no_process'] }, 'lost_valuations'),
  ...weak('F4', { primary: 'nothing', causes: ['no_overdue_view'] }, 'missed_sellers'),
  ...weak('F5', { primary: 'none', causes: ['no_stages'] }, 'cant_judge'),
  ...weak('I1', { primary: 'ad_hoc', causes: ['nothing_reads'] }, 'lost_valuations', { I1_volume: a(30) }),
  ...weak('I2', { primary: 'no', causes: ['never_looked'] }, 'missed_reactivation', { I2_matching: a('mostly') }),
  ...weak('I3', { primary: 'when_time', causes: ['no_time'] }, 'untouched_value', { I3_history: a('all_in_crm'), I3_quality: a('ok') }),
  ...weak('I4', { primary: 'list_order', causes: ['no_tool'] }, 'missed_ready'),
  ...weak('I5', { primary: 'no_learning', causes: ['no_outcomes'] }, 'keep_failing'),
};
const ALL_STRONG_F = { ...strong('F1', 'consistently', 'yes_all'), ...strong('F2', 'yes_easily', 'yes'), ...strong('F3', 'task_every_time', 'yes'), ...strong('F4', 'tracked_reviewed', 'report_or_alert'), ...strong('F5', 'full', 'yes') };
const ALL_STRONG_I = { ...strong('I1', 'system_flags', 'identifies_routes'), ...strong('I2', 'flags_changes', 'yes'), ...strong('I3', 'systematic', 'know_results'), ...strong('I4', 'scored', 'circumstances'), ...strong('I5', 'measured_adjust', 'system_learns') };
const WEAK_I = Object.fromEntries(Object.entries(ALL_WEAK).filter(([k]) => /^I/.test(k)));
const WEAK_F = Object.fromEntries(Object.entries(ALL_WEAK).filter(([k]) => /^F/.test(k)));
const feas = (d, id) => d.interventions.find((i) => i.rule_id === id);

// ── 1. registry integrity ──────────────────────────────────────────────────
console.log('\n1. Question and rule registries');
{
  const ids = QUESTIONS.map((q) => q.id);
  assert.equal(new Set(ids).size, ids.length, 'question ids unique');
  for (const q of QUESTIONS) {
    assert.ok(q.primary && q.purpose && q.section && q.role, `${q.id} has primary/purpose/section/role`);
    if (q.show_when) assert.ok(QUESTION_BY_ID[q.show_when.question], `${q.id} show_when references a real question`);
    if (q.type === 'single' || q.type === 'multi') assert.ok(q.options.length >= 2, `${q.id} has options`);
    const spoken = [q.primary, q.simpler, q.example].join(' ');
    assert.ok(!/cross-interaction|data architecture|information optimi|adaptive commercial/i.test(spoken), `${q.id} uses plain estate-agency language`);
  }
  for (const d of DIMENSIONS) {
    const p = QUESTION_BY_ID[d.id];
    assert.equal(p.role, 'primary');
    assert.ok(p.simpler && p.example, `${d.id} has simpler wording and an example`);
    assert.ok(p.options.some((o) => o.level === 'weak') && p.options.some((o) => o.level === 'strong') && p.options.some((o) => o.level === 'unknown'), `${d.id} supports weak/strong/unknown`);
    for (const role of ['verify', 'cause', 'consequence']) assert.ok(QUESTIONS.some((q) => q.dimension === d.id && q.role === role), `${d.id} has a ${role} question`);
    assert.ok(RULE_BY_ID[d.id], `rule ${d.id} exists`);
  }
  ok(`${QUESTIONS.length} questions: unique ids, valid conditions, plain language, every dimension has primary/simpler/example/verify/cause/consequence`);

  for (const rule of COVERAGE_RULES) {
    assert.ok(QUESTION_BY_ID[rule.question], `coverage ${rule.id} names a real question`);
    for (const c of rule.when) assert.ok(QUESTION_BY_ID[c.question], `coverage ${rule.id} condition names a real question`);
    for (const b of rule.basis) assert.ok(QUESTION_BY_ID[b], `coverage ${rule.id} basis ${b} exists`);
    const q = QUESTION_BY_ID[rule.question];
    const allowed = new Set(q.options.map((o) => o.value));
    if (rule.derive.value !== undefined) assert.ok(allowed.has(rule.derive.value), `coverage ${rule.id} derives a real option`);
    if (rule.derive.values) for (const v of rule.derive.values) assert.ok(allowed.has(v), `coverage ${rule.id} derives real options`);
    if (rule.derive.map) for (const v of Object.values(rule.derive.map)) assert.ok(allowed.has(v), `coverage ${rule.id} maps onto real options`);
    assert.ok(rule.note, `coverage ${rule.id} explains itself`);
  }
  for (const q of QUESTIONS) for (const v of q.variants || []) assert.ok(QUESTION_BY_ID[v.when.question] && v.primary, `${q.id} variant is well-formed`);
  ok(`${COVERAGE_RULES.length} coverage rules only ever derive real options from real earlier answers, and every contextual variant is well-formed`);

  assert.equal(RULES.length, 10);
  const required = ['rule_id', 'dimension', 'title', 'triggers', 'required_evidence', 'commercial_consequence', 'intervention', 'implementation_steps', 'required_data_access', 'agency_responsibilities', 'novus_responsibilities', 'dependencies', 'measurement', 'scope_limitations', 'pitch_explanation', 'delivery_status', 'delivery_status_note'];
  for (const r of RULES) {
    for (const key of required) assert.ok(r[key] !== undefined && r[key] !== '', `${r.rule_id}.${key}`);
    assert.ok(DELIVERY_STATUSES[r.delivery_status], `${r.rule_id} delivery status is one of the five`);
    for (const dep of r.dependencies) assert.ok(dep.dimension ? RULE_BY_ID[dep.dimension] : dep.any_of_rules.every((id) => RULE_BY_ID[id]), `${r.rule_id} dependency names a real rule`);
  }
  assert.equal(FOUNDING_OFFER.price_gbp, 1500); assert.equal(FOUNDING_OFFER.duration_days, 60); assert.equal(FOUNDING_OFFER.setup_target_days, 14);
  ok('10 rules carry every required field, a valid delivery status and resolvable dependencies; founding offer is £1,500 / 60 days / ~14-day setup');
}

// ── 2. conditional logic ───────────────────────────────────────────────────
console.log('\n2. Conditional exploration');
{
  let answers = { F1: a('consistently') };
  assert.ok(isVisible(QUESTION_BY_ID.F1_verify, answers)); assert.ok(!isVisible(QUESTION_BY_ID.F1_cause, answers));
  answers = { F1: a('patchy') };
  assert.ok(!isVisible(QUESTION_BY_ID.F1_verify, answers)); assert.ok(isVisible(QUESTION_BY_ID.F1_cause, answers)); assert.ok(!isVisible(QUESTION_BY_ID.F1_crm_limit, answers));
  answers = { F1: a('patchy'), F1_cause: m(['crm_limits', 'staff_adoption']) };
  assert.ok(isVisible(QUESTION_BY_ID.F1_crm_limit, answers)); assert.ok(isVisible(QUESTION_BY_ID.F1_process, answers));
  ok('a strong answer opens verification only; a weak answer opens cause/consequence; CRM and staff-adoption causes open their specific follow-ups');

  answers = { F2: a('yes_easily'), F2_verify: a('no') };
  assert.equal(effectiveLevel('F2', answers), 'partial');
  assert.ok(isVisible(QUESTION_BY_ID.F2_cause, answers));
  const as = assessDimension('F2', answers);
  assert.equal(as.reported_level, 'strong'); assert.equal(as.level, 'partial'); assert.equal(as.evidence_status, 'PROVISIONAL');
  ok('a reported strength that fails verification is downgraded to partial/provisional and the exploration opens — not recorded as a strength');

  answers = { F1: a('patchy'), F1_cause: m(['staff_adoption']), F1_process: a('exists_not_followed'), F1_consequence: m(['missed_sellers']) };
  const mgmt = assessDimension('F1', answers);
  assert.equal(mgmt.evidence_status, 'OUTSIDE_SCOPE'); assert.equal(mgmt.management_issue, true);
  const d = diagnose({ answers });
  assert.equal(feas(d, 'F1').candidate, false); assert.equal(feas(d, 'F1').not_selected_reason, 'outside_scope');
  ok('a process that exists but is not followed is a management issue: OUTSIDE_SCOPE, and F1 is not prescribed');

  answers = { F3: a('memory'), F3_cause: m(['no_process']) };
  assert.equal(assessDimension('F3', answers).evidence_status, 'PROVISIONAL');
  answers.F3_consequence = m(['unknown']);
  assert.equal(assessDimension('F3', answers).evidence_status, 'PROVISIONAL', '"don\'t know" does not confirm');
  answers.F3_consequence = m(['lost_valuations']);
  assert.equal(assessDimension('F3', answers).evidence_status, 'CONFIRMED');
  answers = { F3: { skipped: true, skip_reason: 'Ran out of time' } };
  const sk = assessDimension('F3', answers);
  assert.equal(sk.evidence_status, 'UNKNOWN'); assert.match(sk.note, /Skipped: Ran out of time/);
  ok('CONFIRMED needs a real cause and consequence; "don\'t know" stays provisional; a skipped question is UNKNOWN with its reason');
}

// ── 2b. shared discovery context ────────────────────────────────────────────
console.log('\n2b. Shared discovery context (coverage, contextual wording, option hiding)');
{
  // Numbers: conversion is worked out, not asked, when both volumes are known.
  let answers = { C8: a(20, { source: 'actual' }), C9: a(6, { source: 'actual' }) };
  let cov = evaluateCoverage(answers);
  assert.equal(cov.C11.derived.value, 30); assert.deepEqual(cov.C11.basis, ['C8', 'C9']);
  assert.ok(!visibleQuestions(answers, 'value').some((q) => q.id === 'C11'));
  assert.equal(computeEconomics(answers).baseline.conversion_pct.value, 30);
  ok('C11 (conversion) is covered by C8 + C9 and never asked; the economics still carry it');

  // "Nothing happens until they come back" answers accountability too.
  answers = { F3: a('nothing'), F3_cause: m(['unclear_owner']), F3_consequence: m(['lost_valuations']) };
  cov = evaluateCoverage(answers);
  assert.equal(cov.F4.derived.value, 'nothing'); assert.deepEqual(cov.F4_cause.derived.values, ['ownership_unclear']); assert.deepEqual(cov.F4_consequence.derived.values, ['missed_sellers']);
  const f4 = assessDimension('F4', answers);
  assert.equal(f4.level, 'weak'); assert.equal(f4.evidence_status, 'CONFIRMED'); assert.deepEqual(f4.basis_dimensions, ['F3']); assert.match(f4.note, /Derived from F3/);
  assert.ok(!visibleQuestions(answers, 'foundations').some((q) => q.dimension === 'F4' && q.role === 'primary'));
  // …but only as far as F3 is itself confirmed.
  const f4p = assessDimension('F4', { F3: a('nothing'), F3_consequence: m(['lost_valuations']), F4_cause: m(['no_overdue_view']) });
  assert.equal(f4p.evidence_status, 'PROVISIONAL', 'F4 has a cause (asked) and a consequence (derived) but F3 itself is not confirmed'); assert.match(f4p.note, /not yet confirmed/);
  // …and if F3 only says "no process", F4's cause is still asked.
  answers = { F3: a('nothing'), F3_cause: m(['no_process']), F3_consequence: m(['lost_valuations']) };
  assert.ok(visibleQuestions(answers, 'foundations').some((q) => q.id === 'F4_cause'));
  assert.ok(!visibleQuestions(answers, 'foundations').some((q) => q.id === 'F4'));
  ok('F4 is derived from an F3 "nothing happens" answer (cause and consequence mapped from the owner\'s words), capped at F3\'s own evidence, and only the genuinely missing follow-up is asked');

  // Ask anyway: a reopened marker switches coverage off without inventing an answer.
  answers = { F3: a('nothing'), F3_cause: m(['unclear_owner']), F3_consequence: m(['lost_valuations']), F4: { reopened: true } };
  assert.equal(evaluateCoverage(answers).F4, undefined);
  assert.ok(visibleQuestions(answers, 'foundations').some((q) => q.id === 'F4'));
  assert.equal(assessDimension('F4', answers).evidence_status, 'UNKNOWN', 'reopened but unanswered is unknown, not derived');
  answers.F4 = a('manager_asks');
  assert.equal(assessDimension('F4', answers).level, 'partial', 'a real answer always beats coverage');
  ok('"Ask anyway" reopens a covered question: nothing is derived until the owner answers, and a real answer always wins');

  // Capture already weak with missed sellers → seller-signal recognition is established.
  answers = { F1: a('patchy'), F1_cause: m(['time', 'crm_limits']), F1_consequence: m(['missed_sellers']) };
  cov = evaluateCoverage(answers);
  assert.equal(cov.I1.derived.value, 'ad_hoc'); assert.deepEqual(cov.I1_cause.derived.values, ['busy', 'nothing_reads']); assert.deepEqual(cov.I1_consequence.derived.values, ['lost_valuations']);
  assert.equal(cov.I1_current, undefined, 'coverage never chains: I1_current reads the STORED I1_cause, which was not asked');
  ok('I1 and its cause/consequence are carried from a weak F1 with missed sellers; the derived cause is a mapping of the real one');
}
{
  // Strong context and system flags: matching and activity signals are not asked twice.
  let answers = { ...strong('F2', 'yes_easily', 'yes'), ...strong('I2', 'flags_changes', 'yes') };
  let cov = evaluateCoverage(answers);
  assert.equal(cov.I2_matching.derived.value, 'yes'); assert.equal(cov.I4_signals.derived.value, 'yes');
  answers = { F2: a('sometimes'), F2_cause: m(['duplicates']), F2_consequence: m(['missed_context']) };
  assert.equal(evaluateCoverage(answers).I2_matching.derived.value, 'mostly');
  // Systematic database work covers prioritisation (but verification still runs).
  answers = { ...strong('I3', 'systematic', 'know_results') };
  cov = evaluateCoverage(answers);
  assert.equal(cov.I4.derived.value, 'scored');
  assert.ok(visibleQuestions(answers, 'intelligence').some((q) => q.id === 'I4_verify'), 'the verification question is still asked');
  assert.equal(assessDimension('I4', answers).evidence_status, 'EXISTING_STRENGTH');
  // No way of knowing who to call → prioritisation weak, its cause carried, its consequence still asked.
  answers = { I3: a('when_time'), I3_cause: m(['no_way_to_prioritise']), I3_consequence: m(['untouched_value']) };
  cov = evaluateCoverage(answers);
  assert.equal(cov.I4.derived.value, 'judgement'); assert.deepEqual(cov.I4_cause.derived.values, ['no_data']); assert.equal(cov.I4_consequence, undefined);
  assert.ok(visibleQuestions(answers, 'intelligence').some((q) => q.id === 'I4_consequence'));
  // No outcome tracking → learning's cause is known; the primary is still asked, reworded.
  answers = { F5: a('none'), F5_cause: m(['no_stages']), F5_consequence: m(['cant_judge']) };
  cov = evaluateCoverage(answers);
  assert.deepEqual(cov.I5_cause.derived.values, ['no_outcomes']); assert.deepEqual(cov.I5_consequence.derived.values, ['cant_scale']); assert.equal(cov.I5, undefined);
  assert.match(wordingFor(QUESTION_BY_ID.I5, answers).primary, /outcomes aren't really tracked/);
  ok('context/system strengths cover matching and activity signals; database answers cover prioritisation; outcome tracking covers the cause of learning — related dimensions stay distinct');

  // Contextual wording and hidden options.
  answers = { F1: a('mostly'), F3: a('memory'), C2: m(['slipping_through', 'database']) };
  assert.match(wordingFor(QUESTION_BY_ID.F4, answers).primary, /negotiator remembering/);
  assert.match(wordingFor(QUESTION_BY_ID.F3, answers).primary, /slipping through the net/);
  assert.match(wordingFor(QUESTION_BY_ID.F2, answers).primary, /For what does make it into the CRM/);
  assert.match(wordingFor(QUESTION_BY_ID.I1, answers).primary, /mostly gets recorded/);
  assert.match(wordingFor(QUESTION_BY_ID.I3, answers).primary, /can't get much out of the database/);
  assert.equal(wordingFor(QUESTION_BY_ID.F5, answers).variant, '');
  assert.ok(!visibleOptions(QUESTION_BY_ID.F2_cause, answers).some((o) => o.value === 'not_recorded'));
  assert.ok(visibleOptions(QUESTION_BY_ID.F2_cause, {}).some((o) => o.value === 'not_recorded'));
  // A blocked CRM opens the "what is the block" follow-up, and "nobody knows how" softens the block to an assessment.
  answers = { ...ALL_WEAK, C7: a('blocked') };
  assert.ok(visibleQuestions(answers, 'commercial').some((q) => q.id === 'C7_block'));
  assert.equal(feas(diagnose({ answers }), 'I3').feasibility, 'INFEASIBLE');
  assert.equal(feas(diagnose({ answers: { ...answers, C7_block: a('nobody_knows_how') } }), 'I3').feasibility, 'REQUIRES_ASSESSMENT');
  assert.equal(feas(diagnose({ answers: { ...answers, C7_block: a('provider_policy') } }), 'I3').feasibility, 'INFEASIBLE');
  ok('follow-ups build on the previous answer instead of restarting; redundant options are hidden; a blocked CRM is explored and a "not worked out" block becomes an assessment item');
}

// ── 3. the ten scenarios ───────────────────────────────────────────────────
console.log('\n3. Scenarios');
const scenarios = {};
{
  // 1. weak foundations + weak intelligence
  let d = diagnose({ answers: ALL_WEAK }); scenarios.weakWeak = d;
  assert.equal(d.suitability.verdict, 'POTENTIAL_FIT');
  assert.equal(d.findings.confirmed.length, 10);
  assert.deepEqual(d.assessments.I1.derived.map((x) => x.question), ['I1_current'], 'the I1 answers given explicitly win; only the unasked "what does the CRM do today" detail is carried from the stated cause');
  assert.deepEqual(d.proposed, ['F1', 'F2', 'F3', 'F4', 'F5', 'I1', 'I2', 'I3', 'I4', 'I5']);
  assert.equal(feas(d, 'I1').feasibility, 'FEASIBLE_WITH_FOUNDATION');
  assert.ok(feas(d, 'I1').dependencies.some((x) => x.dimension === 'F3' && x.resolution === 'provided'));
  assert.equal(d.plan.generated_from.first_workflow, 'I1');
  assert.ok(d.plan.phases[1].novus_does.some((x) => x.startsWith('F1 ')), 'days 4–7 carry the foundation work');
  ok('1. weak foundations + weak intelligence → POTENTIAL_FIT; all ten rules, intelligence depends on foundations provided by the plan; days 4–7 populated');

  // 2. strong foundations + weak intelligence
  d = diagnose({ answers: { ...COMMERCIAL, ...ALL_STRONG_F, ...WEAK_I } }); scenarios.strongWeak = d;
  assert.equal(d.suitability.verdict, 'POTENTIAL_FIT');
  assert.ok(d.suitability.reasons.includes('STRONG_FOUNDATIONS_INTELLIGENCE_GAP'));
  assert.equal(d.findings.strengths.length, 5);
  assert.deepEqual(d.proposed, ['I1', 'I2', 'I3', 'I4', 'I5']);
  assert.ok(feas(d, 'I1').dependencies.every((x) => x.resolution === 'existing'), 'I1 reuses existing F1/F3');
  assert.equal(feas(d, 'I1').feasibility, 'FEASIBLE');
  assert.ok(d.plan.phases[1].novus_does[0].startsWith('Foundations are in place'), 'plan reuses foundations');
  assert.ok(d.plan.phases[1].changes.some((x) => x.startsWith('Preserved:')));
  ok('2. strong foundations + weak intelligence → POTENTIAL_FIT on intelligence only; foundations reused, never rebuilt; plan says so');

  // 3. weak foundations + sophisticated intelligence
  d = diagnose({ answers: { ...COMMERCIAL, ...WEAK_F, ...ALL_STRONG_I } }); scenarios.weakStrong = d;
  assert.equal(d.suitability.verdict, 'POTENTIAL_FIT');
  assert.ok(d.suitability.reasons.includes('FOUNDATION_GAP_WITH_INTERVENTION'));
  assert.deepEqual(d.proposed, ['F1', 'F2', 'F3', 'F4', 'F5']);
  assert.ok(d.preserved.map((p) => p.dimension).includes('I1'));
  assert.equal(d.plan.generated_from.first_workflow, '', 'no intelligence workflow to activate');
  assert.match(d.plan.phases[2].novus_does[0], /first live workflow is F1/);
  ok('3. weak foundations + existing sophisticated intelligence → foundations only; intelligence preserved; first live workflow is a foundation');

  // 4. strong + strong
  d = diagnose({ answers: { ...COMMERCIAL, ...ALL_STRONG_F, ...ALL_STRONG_I } }); scenarios.strongStrong = d;
  assert.equal(d.suitability.verdict, 'NOT_CURRENTLY_SUITABLE');
  assert.ok(d.suitability.reasons.includes('EXISTING_CAPABILITY'));
  assert.equal(d.suitability.pitch_pilot, false);
  assert.deepEqual(d.proposed, []);
  assert.match(d.suitability.recommendation, /do not pitch/i);
  ok('4. strong foundations + strong intelligence → NOT_CURRENTLY_SUITABLE with a no-pitch recommendation');

  // 5. insufficient demand
  d = diagnose({ answers: { ...ALL_WEAK, C4: a(12), C5: a(150) } }); scenarios.lowDemand = d;
  assert.equal(d.suitability.verdict, 'NOT_CURRENTLY_SUITABLE');
  assert.ok(d.suitability.reasons.includes('INSUFFICIENT_DEMAND'));
  const dUnknownDemand = diagnose({ answers: { ...ALL_WEAK, C4: undefined, C5: undefined } });
  assert.notEqual(dUnknownDemand.suitability.verdict, 'NOT_CURRENTLY_SUITABLE', 'unknown demand is not zero demand');
  assert.ok(dUnknownDemand.suitability.reasons.includes('DEMAND_UNCONFIRMED'));
  ok(`5. insufficient demand (< ${SUITABILITY_POLICY.min_enquiries_per_month} enquiries and < ${SUITABILITY_POLICY.min_database_contacts} contacts) → NOT_CURRENTLY_SUITABLE; unknown demand is flagged, never treated as zero`);

  // 6. blocked CRM
  d = diagnose({ answers: { ...ALL_WEAK, C7: a('blocked') } }); scenarios.blockedCrm = d;
  assert.equal(feas(d, 'F2').feasibility, 'INFEASIBLE'); assert.equal(feas(d, 'I2').feasibility, 'INFEASIBLE'); assert.equal(feas(d, 'I3').feasibility, 'INFEASIBLE');
  assert.equal(feas(d, 'I2').selected, false);
  assert.ok(d.blockers.length >= 1);
  assert.equal(feas(d, 'I1').selected, true, 'inbound-feed work does not need the CRM export');
  assert.equal(d.suitability.verdict, 'POTENTIAL_FIT');
  assert.ok(!d.proposed.includes('I3'));
  const unsure = diagnose({ answers: { ...ALL_WEAK, C7: a('unsure') } });
  assert.equal(feas(unsure, 'I3').feasibility, 'REQUIRES_ASSESSMENT');
  assert.ok(unsure.validation.some((v) => /CRM export/.test(v)));
  ok('6. blocked CRM → F2/I2/I3 infeasible and excluded, I1 still feasible, blocker recorded; "unsure" → requires assessment + validation item');

  // 7. multiple problems requiring conditional exploration
  const partial = { ...COMMERCIAL, F1: a('patchy'), F1_cause: m(['crm_limits', 'staff_adoption']), F1_crm_limit: a('no_fields'), F1_process: a('never_set_out'), F3: a('memory'), I1: a('ad_hoc'), I1_cause: m(['nothing_reads']) };
  d = diagnose({ answers: partial }); scenarios.multi = d;
  const vis = QUESTIONS.filter((q) => isVisible(q, partial)).map((q) => q.id);
  assert.ok(vis.includes('F1_crm_limit') && vis.includes('F1_process') && vis.includes('F3_cause') && vis.includes('I1_consequence'));
  assert.ok(!vis.includes('F2_cause'));
  assert.equal(d.assessments.F1.evidence_status, 'PROVISIONAL'); assert.equal(d.assessments.F3.evidence_status, 'PROVISIONAL'); assert.equal(d.assessments.I1.evidence_status, 'PROVISIONAL');
  assert.deepEqual(d.assessments.F1.exploration.missing, ['F1_consequence']);
  assert.deepEqual(d.assessments.F3.exploration.missing, ['F3_cause', 'F3_consequence']);
  assert.equal(d.suitability.verdict, 'FURTHER_VALIDATION_REQUIRED'); assert.ok(d.suitability.reasons.includes('EVIDENCE_PROVISIONAL'));
  assert.deepEqual(d.progress.required_missing, ['F1_consequence', 'F3_cause', 'F3_consequence', 'I1_consequence']);
  ok('7. several problems open their own follow-ups (CRM limitation, process question); each stays PROVISIONAL until its own cause+consequence are in; verdict is further validation');

  // 8. incomplete discovery
  d = diagnose({ answers: { C1: a('more_valuations'), F1: a('patchy'), F1_cause: m(['time']), F1_consequence: m(['missed_sellers']) } }); scenarios.incomplete = d;
  assert.equal(d.findings.unknown.length, 8, 'I1 is carried from the F1 answer; the other eight are unknown');
  assert.equal(d.assessments.I1.evidence_status, 'CONFIRMED'); assert.deepEqual(d.assessments.I1.basis_dimensions, ['F1']);
  assert.equal(d.suitability.verdict, 'FURTHER_VALIDATION_REQUIRED');
  assert.ok(d.suitability.reasons.includes('ECONOMICS_UNKNOWN') || d.suitability.reasons.includes('INCOMPLETE_DISCOVERY'));
  assert.ok(d.validation.length >= 8);
  assert.equal(d.economics.available, false); assert.deepEqual(d.economics.missing, ['average fee per instruction', 'valuation-to-instruction conversion', 'monthly valuations']);
  const empty = diagnose({ answers: {} });
  assert.equal(empty.suitability.verdict, 'FURTHER_VALIDATION_REQUIRED'); assert.ok(empty.suitability.reasons.includes('INCOMPLETE_DISCOVERY'));
  ok('8. incomplete discovery → FURTHER_VALIDATION_REQUIRED; unknown dimensions listed for validation (a dimension established by an earlier answer is not unknown); economics unavailable with the missing figures named; an empty session is never a fit');

  // 9. existing process should be preserved
  d = diagnose({ answers: { ...ALL_WEAK, ...strong('F3', 'task_every_time', 'yes') } }); scenarios.preserve = d;
  assert.equal(d.assessments.F3.evidence_status, 'EXISTING_STRENGTH'); assert.equal(d.assessments.F3.verified, true);
  assert.equal(feas(d, 'F3').candidate, false); assert.equal(feas(d, 'F3').not_selected_reason, 'existing_strength');
  assert.ok(feas(d, 'I1').dependencies.some((x) => x.dimension === 'F3' && x.resolution === 'existing'));
  assert.ok(d.preserved.some((p) => p.dimension === 'F3'));
  assert.ok(d.plan.phases[1].changes.some((x) => /Preserved: Next actions \(F3\)/.test(x)));
  const unverified = diagnose({ answers: { ...ALL_WEAK, F3: a('task_every_time') } });
  assert.equal(unverified.assessments.F3.verified, false);
  assert.ok(unverified.validation.some((v) => /F3 .*not verified/.test(v)));
  assert.ok(unverified.plan.phases[1].changes.some((x) => /F3\) — verified in days 1–3/.test(x)));
  ok('9. a working follow-up process is an EXISTING STRENGTH: F3 is not proposed, I1 reuses it, the plan says "Preserved"; unverified strengths are checked in days 1–3');

  // 10. not suitable (real gaps, everything infeasible / outside scope)
  d = diagnose({ answers: { ...COMMERCIAL, C7: a('blocked'), ...ALL_STRONG_F, ...weak('I2', { primary: 'no', causes: ['separate_places'] }, 'missed_reactivation', { I2_matching: a('no') }), ...weak('I3', { primary: 'not_used', causes: ['data_messy'] }, 'untouched_value', { I3_history: a('elsewhere'), I3_quality: a('messy') }), ...strong('I1', 'system_flags', 'identifies_routes'), ...strong('I4', 'scored', 'circumstances'), ...strong('I5', 'measured_adjust', 'system_learns') } });
  scenarios.notSuitable = d;
  assert.equal(d.suitability.verdict, 'NOT_CURRENTLY_SUITABLE');
  assert.ok(d.suitability.reasons.includes('DEPLOYMENT_INFEASIBLE'));
  assert.deepEqual(d.proposed, []);
  assert.equal(d.suitability.pitch_pilot, false);
  ok('10. real gaps but every intervention infeasible in the pilot (blocked CRM, history outside the CRM) → NOT_CURRENTLY_SUITABLE, nothing proposed');
}

// ── 4. overrides, economics, dependency chains ─────────────────────────────
console.log('\n4. Overrides, economics and dependencies');
{
  let d = diagnose({ answers: ALL_WEAK, overrides: { F4: { evidence_status: 'EXISTING_STRENGTH', level: 'strong', reason: 'Owner showed me the overdue report on screen', at: '2026-09-21T10:30:00.000Z' }, rules: { I5: { include: false, reason: 'Keep the pilot focused', at: '2026-09-21T10:31:00.000Z' } } } });
  assert.equal(d.assessments.F4.evidence_status, 'EXISTING_STRENGTH'); assert.equal(d.assessments.F4.override.original.evidence_status, 'CONFIRMED');
  assert.equal(feas(d, 'I5').selected, false); assert.equal(feas(d, 'I5').not_selected_reason, 'excluded_by_override');
  assert.ok(!d.proposed.includes('F4') && !d.proposed.includes('I5'));
  ok('overrides change the diagnosis with the reason and original recorded; rule exclusion removes it from the proposal');

  d = diagnose({ answers: { ...ALL_WEAK, C10: a(3500), C11: undefined } });
  const e = d.economics;
  assert.equal(e.baseline.conversion_pct.value, 40); assert.equal(e.baseline.conversion_pct.source, 'derived');
  assert.equal(e.illustrations.length, 3); assert.equal(e.illustrations[1].additional_valuations_per_month, 3);
  assert.equal(e.illustrations[1].additional_instructions_per_month, 1.2); assert.equal(e.illustrations[1].additional_fee_income_per_month_gbp, 4200);
  assert.equal(e.illustrations[0].kind, 'HYPOTHETICAL_ILLUSTRATION'); assert.match(e.disclaimer, /not forecasts, not guarantees/);
  assert.equal(e.baseline.valuations_per_month.source, 'actual'); assert.equal(e.baseline.fee_per_instruction.source, 'owner_estimate');
  const none = computeEconomics({ C8: a(20) });
  assert.equal(none.available, false); assert.equal(none.illustrations.length, 0);
  ok('economics: conversion derived from actual figures, illustrations labelled hypothetical with sources, nothing computed from unknowns');

  // Dependency: I3 needs F3; F3 unknown → I3 requires assessment with a validation item
  d = diagnose({ answers: { ...COMMERCIAL, ...weak('I3', { primary: 'when_time', causes: ['no_time'] }, 'untouched_value', { I3_history: a('all_in_crm'), I3_quality: a('ok') }) } });
  assert.equal(feas(d, 'I3').feasibility, 'REQUIRES_ASSESSMENT');
  assert.ok(feas(d, 'I3').validation_items.some((v) => /Confirm F3/.test(v)));
  // Dependency: I3 needs F3; F3 weak but its own exploration incomplete → F3 still triggers as PROVISIONAL and is provided
  d = diagnose({ answers: { ...COMMERCIAL, F3: a('memory'), ...weak('I3', { primary: 'when_time', causes: ['no_time'] }, 'untouched_value', { I3_history: a('all_in_crm'), I3_quality: a('ok') }) } });
  assert.equal(feas(d, 'I3').feasibility, 'FEASIBLE_WITH_FOUNDATION');
  assert.ok(feas(d, 'I3').dependencies.some((x) => x.dimension === 'F3' && x.resolution === 'provided'));
  // I5 needs F5; F5 outside/unknown → assessment, and its delivery status is PROPOSED
  assert.equal(feas(scenarios.weakWeak, 'I5').delivery_status, 'PROPOSED');
  ok('dependencies: an unknown foundation makes the intelligence rule an assessment item; a weak one is provided by the plan; I5 is honestly PROPOSED');
}

// ── 5. pitch generation and validation ─────────────────────────────────────
console.log('\n5. Pitch');
const session = { session_id: 'dsc_test', agency_id: 'ag_1', agency_name: 'Alpha Estates', contact_name: 'Jane Alpha' };
const spokenOk = (spoken, input) => { const v = validatePitch({ spoken, plan: templatePitch(input).plan }, input); assert.ok(v.valid, v.issues.join('; ')); return v.words; };
{
  const input = buildPitchInput(session, scenarios.weakWeak);
  assert.equal(input.mode, 'PILOT');
  assert.equal(input.interventions.length, 10);
  assert.ok(!JSON.stringify(input).includes('@') && !/0124\d+/.test(JSON.stringify(input)), 'no emails or phone numbers go to the model');
  assert.ok(!input.allowed_money_figures.includes(1500), 'the price is not an allowed spoken figure');
  assert.ok(input.allowed_money_figures.includes(4200) && input.allowed_money_figures.includes(3500));
  assert.ok(input.focus.length >= 2 && input.focus.length <= 3, 'two or three themes in focus');
  assert.equal(input.focus[0].id, 'opportunities', 'owner wants more valuations → the demand/database theme leads');
  assert.ok(input.plan_skeleton.week1 && input.plan_skeleton.weeks5_8);
  const strongInput = buildPitchInput(session, scenarios.strongStrong);
  assert.equal(strongInput.mode, 'NO_PITCH'); assert.equal(strongInput.interventions.length, 0);
  ok('pitch input: structured findings, selected rules, two or three ranked themes, plan skeleton and allowed figures — no PII, no price; mode follows suitability');

  const themes = rankThemes(scenarios.strongWeak);
  assert.ok(themes.every((t) => t.rules.every((id) => /^I/.test(id))), 'strong foundations → only intelligence rules can be spoken about');
  assert.equal(rankThemes(scenarios.preserve).find((t) => t.id === 'progress')?.rules.includes('F3'), false, 'a preserved strength is never presented as a change');
  ok('themes only ever group SELECTED rules; preserved strengths are not themes');

  // Template: the spoken pitch and the four-phase plan.
  const tpl = templatePitch(input, scenarios.weakWeak);
  const words = spokenOk(tpl.spoken, input);
  assert.ok(words >= 150 && words <= 250, `template spoken pitch is ${words} words`);
  assert.match(tpl.spoken, /Jane, from what you've told me, Alpha Estates runs 2 branches/);
  assert.match(tpl.spoken, /The first thing I'd do is/); assert.match(tpl.spoken, /sixty-day pilot/); assert.match(tpl.spoken, /\?$/);
  assert.ok(!/£/.test(tpl.spoken), 'no money in the spoken pitch by default'); assert.ok(!/1,?500/.test(tpl.spoken), 'no price');
  assert.ok(!/F[1-5]\b|I[1-5]\b/.test(tpl.spoken), 'no rule ids spoken aloud');
  assert.ok(!/guarantee/i.test(tpl.spoken));
  for (const ph of PLAN_PHASES_COMPACT) { assert.ok(tpl.plan[ph.key]); assert.ok(tpl.plan[ph.key].split(/(?<=[.!?])\s+/).length <= 2, `${ph.key} ≤ 2 sentences`); }
  assert.match(tpl.plan.week1, /record the baseline \(20 valuations and 8 instructions a month\)/);
  assert.match(tpl.plan.week2, /Seller-signal recognition running on the incoming enquiry feed/);
  assert.match(tpl.plan.weeks5_8, /day 45 and day 60/);
  ok('template: 150–250-word spoken pitch in the agency\'s own numbers, three themes, sixty-day objective, closing question, no price, no rule ids; four plan phases of at most two sentences with the baseline and the first workflow');

  // Preserved strengths and caveats.
  const preserveInput = buildPitchInput(session, scenarios.preserve);
  assert.match(templatePitch(preserveInput, scenarios.preserve).spoken, /What you've already got around next actions works, and we'd plug into it/);
  const assessInput = buildPitchInput(session, diagnose({ answers: { ...ALL_WEAK, C7: a('unsure') } }));
  assert.match(templatePitch(assessInput).spoken, /depends on what Reapit will let us see/);
  assert.match(templatePlan(diagnose({ answers: { ...ALL_WEAK, C7: a('unsure') } })).weeks3_4, /joins? only if the week-1 check passes/);
  ok('the spoken pitch keeps existing strengths and CRM-access caveats; the plan keeps feasibility limits');

  // No-pitch and validation variants.
  const noPitch = templatePitch(strongInput);
  assert.match(noPitch.spoken, /I don't think a pilot is the right thing right now/); assert.equal(noPitch.plan, null);
  assert.ok(validatePitch(noPitch, strongInput).valid, validatePitch(noPitch, strongInput).issues.join('; '));
  const valInput = buildPitchInput(session, scenarios.multi);
  const val = templatePitch(valInput);
  assert.match(val.spoken, /I'm not going to put a pilot to you today/); assert.ok(validatePitch(val, valInput).valid);
  ok('no-pitch and validation variants decline plainly, without a plan or a price, and still end with a question');

  // Validation catches what the brief forbids.
  const long = `${tpl.spoken} ${tpl.spoken}`;
  assert.ok(validatePitch({ spoken: long, plan: tpl.plan }, input).issues.some((i) => /cap 250/.test(i)), 'hard 250-word cap');
  const bad = { spoken: tpl.spoken.replace(/\?$/, '. We guarantee ten extra valuations, worth £40,000, for £1,500. Also we would establish usable customer context.'), plan: tpl.plan };
  const bv = validatePitch(bad, buildPitchInput(session, scenarios.blockedCrm));
  assert.ok(bv.issues.some((i) => /guarantee/.test(i)) && bv.issues.some((i) => /£40,000/.test(i)) && bv.issues.some((i) => /price/.test(i)) && bv.issues.some((i) => /not proposed: F2/.test(i)) && bv.issues.some((i) => /end with a question/.test(i)));
  const badPlan = validatePitch({ spoken: tpl.spoken, plan: { ...tpl.plan, week2: 'One. Two. Three sentences here.' } }, input);
  assert.ok(badPlan.issues.some((i) => /more than two sentences/.test(i)));
  assert.ok(validatePitch({ spoken: '- first\n- second?', plan: tpl.plan }, input).issues.some((i) => /bullet/.test(i)));
  ok('validation rejects the word cap, guarantees, invented money, the price, unproposed rules, a missing closing question, bullets and long plan phases');

  // Model paths through generatePitch.
  const good = async () => ({ spoken: `${tpl.spoken.slice(0, -1)} — shall we?`, week1: 'Confirm the findings and set up capture.', week2: 'Switch on seller-signal recognition.', weeks3_4: 'Add the database list.', weeks5_8: 'Run it and count the valuations.' });
  let out = await generatePitch({ session, diagnosis: scenarios.weakWeak, call: good });
  assert.equal(out.source, 'AI'); assert.deepEqual(out.sources, { spoken: 'AI', plan: 'AI' }); assert.equal(out.validation.valid, true); assert.match(out.pitch.spoken, /shall we\?$/);
  out = await generatePitch({ session, diagnosis: scenarios.weakWeak, call: async () => { throw new Error('simulated outage'); } });
  assert.equal(out.source, 'TEMPLATE'); assert.deepEqual(out.sources, { spoken: 'TEMPLATE', plan: 'TEMPLATE' }); assert.match(out.error, /simulated outage/); assert.equal(out.validation.valid, true);
  out = await generatePitch({ session, diagnosis: scenarios.weakWeak, call: async () => ({ spoken: 'We guarantee £9,999 a month for £1,500. Interested?', week1: 'a', week2: 'b', weeks3_4: 'c', weeks5_8: 'd' }) });
  assert.equal(out.sources.spoken, 'TEMPLATE'); assert.equal(out.sources.plan, 'AI'); assert.equal(out.validation.ai_rejected, true); assert.ok(out.validation.ai_issues.some((i) => /guarantee/.test(i)));
  out = await generatePitch({ session, diagnosis: scenarios.weakWeak, call: async () => ({ spoken: `${tpl.spoken.slice(0, -1)} — shall we?`, week1: 'One. Two. Three.', week2: 'b', weeks3_4: 'c', weeks5_8: 'd' }) });
  assert.deepEqual(out.sources, { spoken: 'AI', plan: 'TEMPLATE' }); assert.equal(out.source, 'AI');
  out = await generatePitch({ session, diagnosis: scenarios.weakWeak, call: async () => ({ spoken: long, week1: 'a', week2: 'b', weeks3_4: 'c', weeks5_8: 'd' }) });
  assert.equal(out.sources.spoken, 'TEMPLATE'); assert.ok(out.validation.ai_issues.some((i) => /cap 250/.test(i)));
  ok('generatePitch: a valid model result is used; outage, an invalid spoken pitch, an over-long spoken pitch or a long plan each fall back part-by-part to the template with the reason recorded');
}

// ── 5b. the revised flow on realistic owners ───────────────────────────────
console.log('\n5b. Realistic owners');
const flowIds = (answers) => visibleQuestions(answers).map((q) => q.id);
{
  // Louis (the live session's real answers, questions v1): three branches, Reapit,
  // 250 enquiries, 5,000 contacts, mostly-captured but fragmented context,
  // limited database and cross-interaction work, some processes fine.
  const LOUIS = { C1: a('more_valuations'), C2: m(['not_enough_opportunities', 'losing_to_competitors', 'team_time']), C3: a(3), C4: a(250), C5: a(5000), C6: a('reapit'), C7: a('export'), C8: a(20), C9: a(6), C10: a(4500),
    F1: a('mostly'), F1_cause: m(['no_process', 'crm_limits']), F1_crm_limit: a('no_fields'), F1_consequence: m(['repeated_questions', 'missed_sellers']),
    F2: a('sometimes'), F2_cause: m(['scattered']), F2_consequence: m(['repeated_questions', 'missed_context']), F2_frequency: a('daily'),
    F3: a('sometimes_task'), F3_cause: m(['no_process']), F3_consequence: m(['unknown']), F4: a('unknown'),
    F5: a('none'), F5_cause: m(['not_recorded']), F5_consequence: m(['unknown']), F5_tried: m(['crm_change']),
    I1: a('process_manual'), I1_current: a('nothing'), I1_consequence: m(['unknown']),
    I2: a('no'), I2_cause: m(['never_looked']), I2_matching: a('unknown'), I2_consequence: m(['missed_sellers', 'missed_reactivation', 'repeated_questions']),
    I3: a('when_time'), I3_cause: m(['no_time', 'not_priority']), I3_history: a('partly'), I3_quality: a('ok'), I3_consequence: m(['unknown_value']),
    I4: a('judgement'), I4_cause: m(['never_needed']), I4_signals: a('some'), I4_consequence: m(['unknown']),
    I5: a('informal'), I5_cause: m(['no_outcomes', 'no_time']), I5_consequence: m(['keep_failing', 'drop_working']) };
  // What the ORIGINAL flow asked Louis that the revised flow would not:
  const before = { ...LOUIS, C11: a(30) };
  const cov = evaluateCoverage(Object.fromEntries(Object.entries(before).filter(([k]) => !['C11', 'I5_cause'].includes(k))));
  assert.equal(cov.C11.derived.value, 30, 'C11 was asked (Louis said 30%) although C8/C9 already gave 30%');
  assert.deepEqual(cov.I5_cause.derived.values, ['no_outcomes'], 'I5_cause was asked although F5 = "none" already established no outcomes');
  assert.ok(!visibleOptions(QUESTION_BY_ID.F2_cause, before).some((o) => o.value === 'not_recorded'), 'F2 offered "not much gets recorded" after F1 had covered capture');
  assert.match(wordingFor(QUESTION_BY_ID.F4, before).primary, /For the ones that do get a task set/, 'F4 was asked cold after F3 said "sometimes a task"');
  assert.match(wordingFor(QUESTION_BY_ID.I1, before).primary, /mostly gets recorded/);
  assert.match(wordingFor(QUESTION_BY_ID.I5, before).primary, /outcomes aren't really tracked/);
  const d = diagnose({ answers: LOUIS });
  assert.equal(d.suitability.verdict, 'POTENTIAL_FIT');
  assert.equal(d.economics.baseline.conversion_pct.value, 30); assert.equal(d.economics.baseline.conversion_pct.source, 'derived');
  assert.deepEqual(d.assessments.I5.derived.map((x) => x.question), []);
  assert.ok(d.proposed.includes('I1') && d.proposed.includes('I3') && d.proposed.includes('F1') && d.proposed.includes('F2'));
  const input = buildPitchInput({ agency_name: 'TEST - Louis', contact_name: 'Louis' }, d);
  const tpl = templatePitch(input, d);
  const words = spokenOk(tpl.spoken, input);
  assert.ok(words >= 150 && words <= 250, `Louis template pitch is ${words} words`);
  assert.equal(input.focus[0].id, 'opportunities'); assert.equal(input.focus[1].id, 'capture');
  assert.match(tpl.spoken, /read every incoming enquiry for buyers who've also got somewhere to sell/);
  assert.match(tpl.spoken, /Louis, from what you've told me, TEST - Louis runs 3 branches doing about 20 valuations a month/);
  assert.match(tpl.plan.week1, /20 valuations and 6 instructions a month/);
  const ai = await generatePitch({ session: { agency_name: 'TEST - Louis', contact_name: 'Louis' }, diagnosis: d, call: async ({ prompt }) => { const inp = JSON.parse(prompt.slice(prompt.indexOf('\n\n') + 2)); return { spoken: `Louis, you want more valuations, and with two hundred and fifty enquiries a month across three branches the demand is already there; the gap is what happens to the sellers you hear about. ${inp.focus.slice(0, 2).map((t) => `We'd ${inp.interventions.find((r) => r.rule_id === t.spoken_rules[0]).what_we_would_change}, and ${inp.interventions.find((r) => r.rule_id === (t.spoken_rules[1] || t.spoken_rules[0])).what_we_would_change}.`).join(' ')} Put together, that means more of the sellers already talking to you, and the ones sitting in Reapit, turn into valuation appointments without your team working a different system. The sixty days are for setting it up in the first fortnight, running it, and counting the valuations and instructions it produced against your twenty a month. Does that sound like the right place to start?`, ...inp.plan_skeleton }; } });
  assert.equal(ai.source, 'AI', JSON.stringify(ai.validation.ai_issues)); assert.ok(wordCount(ai.pitch.spoken) <= SPOKEN_WORD_CAP); assert.ok(ai.validation.valid);
  console.log(`\n     Louis (template, ${words} words):\n     ${tpl.spoken.replace(/\n/g, ' ')}\n`);
  ok('Louis: the revised flow drops C11 and I5_cause (already established), hides the redundant F2 option, rewords F4/I1/I5 on his earlier answers; diagnosis unchanged; both template and model pitches are under 250 words and lead with incoming demand + capture');

  // An owner who explains several related problems in one answer: capture patchy
  // because they're busy, sellers lost daily, tried training. Recorded in one go —
  // nothing further is asked for F1, and I1 is established from it.
  let answers = { ...COMMERCIAL, F1: a('patchy'), F1_cause: m(['time']), F1_consequence: m(['missed_sellers']), F1_frequency: a('daily'), F1_tried: m(['training']) };
  assert.equal(assessDimension('F1', answers).evidence_status, 'CONFIRMED');
  let ids = flowIds(answers);
  assert.ok(!ids.includes('I1') && !ids.includes('I1_cause') && !ids.includes('I1_consequence'), 'I1 is not re-explored');
  assert.ok(ids.includes('I1_volume'), 'but the one thing F1 did not tell us — how many buyers mention selling — is still asked');
  assert.equal(diagnose({ answers }).assessments.I1.evidence_status, 'CONFIRMED');
  ok('one rich answer: F1 confirmed in one go, I1 carried from it with only the volume question left');

  // Foundations already strong: one verification each, no exploration, and the
  // intelligence questions still run in full.
  answers = { ...COMMERCIAL, ...ALL_STRONG_F };
  ids = flowIds(answers);
  assert.deepEqual(ids.filter((id) => /^F/.test(id)), ['F1', 'F1_verify', 'F2', 'F2_verify', 'F3', 'F3_verify', 'F4', 'F4_verify', 'F5', 'F5_verify']);
  assert.ok(ids.includes('I1') && ids.includes('I3') && !ids.includes('I2_matching'), 'matching is covered by the verified context answer');
  ok('strong foundations: exactly one verification per dimension, nothing challenged twice, intelligence still explored');

  // Repeatedly relevant answers: F3 "nothing" + F5 "none" + I3 "no way to prioritise".
  answers = { ...COMMERCIAL, F3: a('nothing'), F3_cause: m(['unclear_owner', 'too_busy']), F3_consequence: m(['lost_valuations']), F5: a('none'), F5_cause: m(['no_stages']), F5_consequence: m(['cant_judge']), I3: a('not_used'), I3_cause: m(['no_way_to_prioritise']), I3_consequence: m(['untouched_value']), I3_history: a('all_in_crm'), I3_quality: a('ok') };
  ids = flowIds(answers);
  for (const id of ['F4', 'F4_cause', 'F4_consequence', 'I5_cause', 'I5_consequence', 'I4', 'I4_cause']) assert.ok(!ids.includes(id), `${id} not asked`);
  for (const id of ['I5', 'I4_consequence', 'I4_signals']) assert.ok(ids.includes(id), `${id} still asked`);
  const dd = diagnose({ answers });
  assert.equal(dd.assessments.F4.evidence_status, 'CONFIRMED'); assert.equal(dd.assessments.I4.evidence_status, 'PROVISIONAL', 'consequence still needed');
  assert.ok(dd.proposed.includes('F4') && dd.proposed.includes('I4'));
  ok('an owner whose answers keep covering later ground: seven questions are skipped as covered, the diagnosis still selects F4 and I4, and only the genuinely missing pieces remain');

  // A clear accountability problem: follow-ups are set but ignored.
  answers = { ...COMMERCIAL, F3: a('task_every_time'), F3_verify: a('yes'), F4: a('tracked_not_reviewed'), F4_cause: m(['tasks_ignored', 'no_overdue_view']), F4_consequence: m(['missed_sellers']) };
  const dacc = diagnose({ answers });
  assert.equal(dacc.assessments.F3.evidence_status, 'EXISTING_STRENGTH'); assert.equal(dacc.assessments.F4.evidence_status, 'CONFIRMED');
  assert.ok(dacc.proposed.includes('F4') && !dacc.proposed.includes('F3'));
  assert.ok(feas(dacc, 'F4').dependencies.some((x) => x.dimension === 'F3' && x.resolution === 'existing'));
  assert.match(wordingFor(QUESTION_BY_ID.F4, { F3: a('task_every_time') }).primary, /^How do you make sure those follow-ups actually happen\?/);
  ok('clear accountability problem: F3 preserved, F4 confirmed and proposed on top of it');

  // A sophisticated CRM: flags seller signals and changes, prioritises, but the
  // owner cannot say what it produces.
  answers = { ...COMMERCIAL, ...ALL_STRONG_F, ...strong('I1', 'system_flags', 'identifies_routes'), ...strong('I2', 'flags_changes', 'yes'), ...strong('I3', 'systematic', 'not_measured'), ...strong('I4', 'scored', 'circumstances'), I5: a('informal'), I5_cause: m(['no_time']), I5_consequence: m(['cant_scale']) };
  ids = flowIds(answers);
  assert.ok(!ids.includes('I2_matching') && !ids.includes('I4_signals'), 'matching and activity signals are not asked when the system already flags changes');
  const dcrm = diagnose({ answers });
  assert.equal(dcrm.assessments.I3.evidence_status, 'PROVISIONAL', 'reported systematic database work that is not measured is not taken as a strength');
  assert.equal(dcrm.assessments.I4.evidence_status, 'EXISTING_STRENGTH');
  assert.deepEqual(dcrm.proposed, ['I3', 'I5']);
  ok('sophisticated CRM: verified strengths preserved, unverified claims downgraded and explored, nothing re-investigated');

  // Vague or incomplete answers: "don't know" everywhere stays unknown, never derived.
  answers = { F1: a('unknown'), F3: a('unknown'), F5: a('unknown'), I3: a('unknown') };
  assert.deepEqual(Object.keys(evaluateCoverage(answers)), []);
  const dv = diagnose({ answers });
  assert.equal(dv.findings.unknown.length, 10); assert.equal(dv.suitability.verdict, 'FURTHER_VALIDATION_REQUIRED');
  ok('vague answers: nothing is derived from "don\'t know", every dimension stays unknown, verdict is further validation');
}

// ── 5c. the meeting conclusion ─────────────────────────────────────────────
console.log('\n5c. Meeting conclusion (deterministic, no model)');
const LOUIS = { C1: a('more_valuations'), C2: m(['not_enough_opportunities', 'losing_to_competitors', 'team_time']), C3: a(3), C4: a(250), C5: a(5000), C6: a('reapit'), C7: a('export'), C8: a(20), C9: a(6), C10: a(4500),
  F1: a('mostly'), F1_cause: m(['no_process', 'crm_limits']), F1_crm_limit: a('no_fields'), F1_consequence: m(['repeated_questions', 'missed_sellers']),
  F2: a('sometimes'), F2_cause: m(['scattered']), F2_consequence: m(['repeated_questions', 'missed_context']), F2_frequency: a('daily'),
  F3: a('sometimes_task'), F3_cause: m(['no_process']), F3_consequence: m(['unknown']), F4: a('unknown'),
  F5: a('none'), F5_cause: m(['not_recorded']), F5_consequence: m(['unknown']), F5_tried: m(['crm_change']),
  I1: a('process_manual'), I1_current: a('nothing'), I1_consequence: m(['unknown']),
  I2: a('no'), I2_cause: m(['never_looked']), I2_matching: a('unknown'), I2_consequence: m(['missed_sellers', 'missed_reactivation', 'repeated_questions']),
  I3: a('when_time'), I3_cause: m(['no_time', 'not_priority']), I3_history: a('partly'), I3_quality: a('ok'), I3_consequence: m(['unknown_value']),
  I4: a('judgement'), I4_cause: m(['never_needed']), I4_signals: a('some'), I4_consequence: m(['unknown']),
  I5: a('informal'), I5_cause: m(['no_outcomes', 'no_time']), I5_consequence: m(['keep_failing', 'drop_working']) };
const louisSession = { session_id: 'dsc_louis', agency_id: 'ag_l', agency_name: 'TEST - Louis', contact_name: 'Louis Example', answers: LOUIS, overrides: {}, notes: {} };
const conclude = (session, conclusion = null) => { const { base, agreed, conclusion: out, presentation } = sessionDiagnoses(session, conclusion); return { base, agreed, c: out, p: presentation }; };
const leak = (obj) => { const js = JSON.stringify(obj); return [/\b[FI][1-5]\b/.test(js) && 'rule id', /CONFIRMED|PROVISIONAL|EXISTING_STRENGTH|OUTSIDE_SCOPE|FEASIB|REQUIRES_ASSESSMENT|INFEASIBLE/.test(js) && 'evidence/feasibility code', /"(rule_id|delivery_status|pricing_script|owner_note|note|reason|agreement|guidance|talking_points|implementation|questions|fallback|closing)"/.test(js) && 'internal field'].filter(Boolean); };
{
  // Louis: the worked example from the brief.
  const { c, p } = conclude(louisSession);
  assert.equal(c.mode, 'PILOT');
  assert.equal(c.understanding.opening, "Right Louis, correct me if I'm wrong, but this is what I've understood from our conversation...");
  assert.equal(c.understanding.closing, "Is that a fair reflection of what's happening, or have I missed anything?");
  const s = c.understanding.situation;
  assert.equal(s.enquiries_per_month.display, '250 a month'); assert.equal(s.database_size.display, '5,000 contacts'); assert.equal(s.valuations_per_month.display, '20 a month'); assert.equal(s.instructions_per_month.display, '6 a month');
  assert.equal(s.fee_per_instruction.display, '£4,500'); assert.equal(s.conversion_pct.display, '30%'); assert.equal(s.objective.priority_label, 'More valuations');
  assert.ok(c.understanding.findings.length >= 2 && c.understanding.findings.length <= 3, 'two or three findings');
  assert.deepEqual(c.understanding.findings.map((f) => f.id), ['opportunities', 'capture', 'measure'], 'grouped by theme, ranked: demand first for an owner who wants more valuations');
  assert.ok(c.understanding.findings.every((f) => f.dimensions.length >= 1 && !/\b[FI][1-5]\b/.test(f.statement)), 'statements are in plain language, no ids');
  assert.match(c.understanding.findings[1].statement, /"mostly, but some gets missed"/, 'uses the owner\'s actual answer');
  assert.match(c.understanding.findings[1].statement, /You said that happens most days/);
  assert.match(c.understanding.findings[0].statement, /^I think /, 'a provisional dimension is hedged');
  assert.equal(c.understanding.agreed, false);
  ok('Louis: opening + closing lines as briefed, situation in his numbers, three grouped findings ranked by evidence and priority, hedged where provisional, in his own words');

  const o = c.opportunity;
  assert.equal(o.available, true); assert.equal(o.fee_per_instruction.value, 4500); assert.equal(o.conversion_pct.value, 30);
  assert.equal(o.expected_fee_income_per_valuation_gbp, 1350);
  assert.equal(o.selected_additional_valuations, 2); assert.equal(o.selected.monthly_gbp, 2700); assert.equal(o.selected.annual_gbp, 32400);
  assert.deepEqual(o.rows.map((r) => r.additional_valuations_per_month), [1, 2, 3, 4, 5]);
  assert.deepEqual(o.rows.map((r) => r.monthly_gbp), [1350, 2700, 4050, 5400, 6750]);
  assert.equal(o.label, 'Illustration, not a forecast'); assert.ok(o.rows.every((r) => r.kind === 'HYPOTHETICAL_ILLUSTRATION'));
  const c5 = conclude(louisSession, { additional_valuations: 5 }).c;
  assert.equal(c5.opportunity.selected.monthly_gbp, 6750); assert.equal(c5.opportunity.selected.annual_gbp, 81000);
  assert.equal(conclude(louisSession, { additional_valuations: 9 }).c.opportunity.selected_additional_valuations, 2, 'out-of-range selection falls back to the default');
  ok('Louis economics: £4,500 × 30% = £1,350 per additional valuation; 2/month = £2,700/month, £32,400/year; selector 1–5 persisted, labelled as illustrations');

  assert.ok(c.changes.groups.length >= 2 && c.changes.groups.length <= 3);
  assert.equal(c.changes.groups[0].id, 'opportunities', 'the group carrying the first live workflow leads');
  for (const g of c.changes.groups) { assert.ok(g.problem && g.change && g.effect && Array.isArray(g.preserve) && Array.isArray(g.conditions), `${g.id} has problem/change/effect/preserve/conditions`); assert.ok(g.rules.every((r) => c.agreed ? true : true)); }
  assert.ok(c.changes.groups.every((g) => g.rules.every((r) => louisSession && conclude(louisSession).agreed.proposed.includes(r.rule_id))), 'only selected rules appear as changes');
  assert.ok(c.changes.foundations.includes('F1') && c.changes.foundations.includes('F3'), 'weak foundations the intelligence work needs are built');
  assert.match(c.changes.foundations_note, /only built where the intelligence work needs them/);
  for (const ph of c.deployment.phases) { assert.ok(ph.summary && ph.heading, `${ph.key} has a summary and heading`); assert.ok(!/\b[FI][1-5]\b/.test(ph.summary), `${ph.key} summary carries no rule ids: ${ph.summary}`); }
  assert.deepEqual(c.deployment.phases.map((ph) => ph.heading), ['Scope, access and necessary foundations', 'Activate the initial intelligence workflow', 'Expand and refine', 'Progress opportunities and measure commercial results']);
  assert.ok(c.deployment.phases[0].novus_does.length > 3, 'implementation detail is available for expansion');
  assert.equal(c.pilot.proposed, true); assert.equal(c.pilot.price_gbp, 1500); assert.equal(c.pilot.duration_days, 60); assert.equal(c.pilot.headline, '£1,500 all-in for 60 days');
  assert.match(c.pilot.pricing_script, /^Louis, the founding pilot is £1,500 all-in for 60 days\./); assert.match(c.pilot.pricing_script, /no long-term commitment/); assert.match(c.pilot.pricing_script, /separate arrangement/); assert.match(c.pilot.pricing_script, /\?$/);
  assert.ok(c.pilot.includes.some((x) => /End-of-pilot review/.test(x)) && c.pilot.success_criteria.length >= 2);
  assert.deepEqual(c.pilot.scope_rule_ids, conclude(louisSession).agreed.proposed, 'default scope = everything proposed');
  ok('Louis: 2–3 intervention groups (problem / change / effect / preserve / conditions), four adapted phases with expandable detail, £1,500 pilot with scope, success criteria, review and a short pricing script');

  // The presentation payload carries nothing internal.
  assert.equal(p.screens.length, 7); assert.deepEqual(p.screens.map((x) => x.id), ['today', 'established', 'opportunity', 'help', 'needs', 'deployment', 'pilot']);
  assert.ok(p.screens[3].cards.length >= 2 && p.screens[3].cards.length <= 3, 'at most three solution cards');
  assert.deepEqual(p.screens[3].cards.map((x) => x.id), ['foundations', 'identify', 'progress'], 'the implementation sequence, not the highest-ranked problems');
  for (const card of p.screens[3].cards) { assert.ok(card.heading.length < 55); assert.ok(/\.$/.test(card.sentence) && card.sentence.split(/(?<=[.!?])\s+/).length <= 2, 'concise — one or two sentences'); }
  assert.match(p.screens[3].cards[0].sentence, /gets recorded in Reapit/, 'the foundations card names the CRM it would connect to');
  assert.match(p.screens[3].cards[1].sentence, /read every incoming enquiry/, 'the identify card leads with the seller-signal work');
  assert.match(p.screens[3].cards[2].sentence, /dated next step|track every seller/, 'the progress card is about progressing and measuring');
  assert.equal(p.screens[4].cards.length, 3); assert.equal(p.screens[4].cards[0].heading, 'Access to the relevant systems & information');
  assert.match(p.screens[4].cards[2].sentence, /records what they hear about selling/, 'third card adapted because capture (F1) is in scope');
  assert.equal(p.screens[5].title, 'Your first 60 days');
  // Private guidance: one entry per client solution card, never on a client screen.
  const gd = c.guidance;
  assert.deepEqual(Object.keys(gd.help), p.screens[3].cards.map((x) => x.id), 'guidance keyed to the client cards, same order');
  for (const card of p.screens[3].cards) {
    const g = gd.help[card.id];
    assert.ok(g.talking_points.length >= 3 && g.talking_points[0].startsWith('Why it matters here: you told me'), 'talking points start from their words');
    assert.ok(g.talking_points.some((x) => /Why that's more valuations/.test(x)), 'connected to the commercial objective');
    assert.ok(g.implementation.length >= 1 && g.implementation.every((r) => r.configure.length && r.systems_data.length && r.novus.length && r.agency.length && r.team_change && r.fallback && r.limits.length && r.delivery_status_label), 'implementation answers from the rule registry');
    assert.ok(g.implementation.every((r) => c.pilot.scope_rule_ids.includes(r.rule_id)), 'only selected rules');
    assert.ok(g.questions.length >= 5 && g.questions.every((x) => x.q && x.a.length > 40));
  }
  assert.ok(gd.help.identify.questions.some((x) => /database is a mess/.test(x.q)) && !gd.help.progress.questions.some((x) => /database is a mess/.test(x.q)), 'only relevant questions');
  assert.match(gd.help.identify.questions.find((x) => /Reapit/.test(x.q)).a, /You said we can get an export/);
  assert.ok(gd.needs.access.length >= 3 && gd.needs.setup.length >= 3 && gd.needs.act.length >= 3);
  assert.ok(gd.needs.access.some((x) => /CRM: Reapit/.test(x)));
  assert.equal(gd.pilot.closing[0], c.pilot.pricing_script); assert.ok(gd.pilot.questions.some((x) => /guaranteeing/.test(x.q) && /No —/.test(x.a)));
  assert.ok(!JSON.stringify(p).includes('Why it matters here') && !JSON.stringify(p).includes(gd.help.identify.questions[0].a), 'private guidance never reaches the client screens');
  assert.ok(p.screens[4].cards.every((x) => ['access', 'setup', 'act'].includes(x.id)));
  assert.deepEqual(leak(p), [], `presentation leaks: ${leak(p).join(', ')}`);
  assert.ok(!JSON.stringify(p).includes(c.pilot.pricing_script), 'the pricing script is not on a client screen');
  assert.equal(p.screens[1].findings.length, 3, 'before any agreement every finding is presentable');
  assert.equal(p.screens[2].per_valuation, '£1,350'); assert.equal(p.screens[2].rows[1].monthly, '£2,700'); assert.equal(p.screens[2].rows[1].annual, '£32,400');
  assert.equal(p.screens[6].price, '£1,500');
  // The private discovery-to-pitch transition scripts: deterministic, from
  // real figures and real findings, never on a client screen.
  assert.match(c.understanding.script, /^Right Louis, I think I've got a pretty good picture/);
  assert.match(c.understanding.script, /250 enquiries a month/); assert.match(c.understanding.script, /5,000 contacts in the database/);
  assert.match(c.understanding.script, /Is that a fair reflection, or is there anything you'd change\?$/);
  assert.match(c.understanding.after_agreement_script, /^Perfect\. Based on that/); assert.match(c.understanding.after_agreement_script, /share my screen/);
  assert.ok(!JSON.stringify(p).includes(c.understanding.script) && !JSON.stringify(p).includes(c.understanding.after_agreement_script), 'the private scripts never reach the client screens');
  ok('presentation payload: seven screens, no rule ids, evidence codes, notes, scripts or controls; economics and price as figures; the private transition scripts stay off the client screens');
}
{
  // Owner corrections recompute the deployment without touching the answers.
  const findings = buildFindings(diagnose({ answers: LOUIS }));
  const before = conclude(louisSession);
  const agreement = { opportunities: { status: 'AGREED' }, capture: { status: 'CORRECTED', dropped: ['F2'], note: 'History is fine in Reapit once you know the name' }, measure: { status: 'REJECTED', note: 'We see it in the monthly figures' } };
  const { base, agreed, c, p } = conclude(louisSession, { agreement });
  assert.deepEqual(base.proposed, before.agreed.proposed, 'the base diagnosis is unchanged');
  assert.ok(before.agreed.proposed.includes('F2') && before.agreed.proposed.includes('F5') && before.agreed.proposed.includes('I5'));
  assert.ok(!agreed.proposed.includes('F2') && !agreed.proposed.includes('F5') && !agreed.proposed.includes('I5'), 'rejected / dropped parts leave the proposal');
  assert.ok(agreed.proposed.includes('I1') && agreed.proposed.includes('F1'));
  assert.equal(agreed.assessments.F2.evidence_status, 'EXISTING_STRENGTH'); assert.equal(agreed.assessments.F2.verified, false, 'an owner-asserted strength is unverified');
  assert.match(agreed.assessments.F2.override.reason, /^Owner \(meeting conclusion\)/); assert.equal(agreed.assessments.F2.override.original.evidence_status, 'CONFIRMED');
  assert.ok(agreed.validation.some((v) => /F2 .*not verified/.test(v)), 'checked in days 1–3');
  assert.equal(louisSession.answers.F2.value, 'sometimes', 'the answer is untouched'); assert.deepEqual(louisSession.overrides, {}, 'the operator\'s overrides are untouched');
  assert.equal(c.understanding.findings.length, 3, 'a rejected finding still shows, as rejected');
  assert.equal(c.understanding.findings.find((f) => f.id === 'measure').agreement.status, 'REJECTED'); assert.equal(c.understanding.findings.find((f) => f.id === 'measure').present, false);
  assert.equal(c.understanding.agreed, true); assert.deepEqual(c.understanding.counts, { findings: 3, agreed: 1, corrected: 1, rejected: 1 });
  assert.ok(!c.changes.groups.some((g) => g.id === 'measure'), 'no change is proposed for a rejected finding');
  assert.ok(c.changes.groups.find((g) => g.id === 'opportunities').preserve.includes('Customer context'), 'the corrected part is now preserved, not rebuilt');
  assert.ok(!c.pilot.scope_rule_ids.includes('F2') && !c.pilot.scope_rule_ids.includes('F5'));
  assert.equal(p.screens[1].findings.length, 2, 'only findings approved for presentation');
  assert.equal(p.screens[1].findings[1].corrected, 'History is fine in Reapit once you know the name');
  assert.equal(p.screens[1].findings[1].points.length, 1, 'the dropped part is not presented');
  assert.deepEqual(leak(p), []);
  assert.ok(!c.guidance.help.progress.implementation.some((r) => ['F5', 'I5'].includes(r.rule_id)), 'a rejected finding leaves the implementation answers for its rules');
  assert.ok(!c.guidance.help.foundations.implementation.some((r) => r.rule_id === 'F2') && !c.guidance.needs.access.some((x) => /customer history/.test(x)), 'the dropped part leaves the implementation answers and the needs');
  assert.match(c.guidance.help.foundations.talking_points[0], /History is fine in Reapit/, 'the owner\'s correction is in the talking points');
  const foundationsCard = p.screens[3].cards.find((x) => x.id === 'foundations');
  assert.ok(foundationsCard && !/customer.s history in one place/.test(foundationsCard.sentence) && /customer context/i.test(foundationsCard.sentence), 'the corrected part becomes a reuse clause on the client card, not a proposed change');
  // Operator's own override wins over the owner's remark.
  const withOp = conclude({ ...louisSession, overrides: { F2: { evidence_status: 'CONFIRMED', level: 'weak', reason: 'Saw the duplicate mess on screen' } } }, { agreement });
  assert.equal(withOp.agreed.assessments.F2.evidence_status, 'CONFIRMED');
  // Bad input is cleaned, not stored.
  const cleaned = cleanConclusion({ agreement: { capture: { status: 'MAYBE' }, nope: { status: 'AGREED' }, opportunities: { status: 'CORRECTED', dropped: ['F1', 'I1'], present: false } }, additional_valuations: '3', scope_rule_ids: ['I1', 'ZZ'] }, findings);
  assert.equal(cleaned.agreement.capture, undefined); assert.equal(cleaned.agreement.nope, undefined); assert.deepEqual(cleaned.agreement.opportunities.dropped, ['I1'], 'only that finding\'s own dimensions can be dropped'); assert.equal(cleaned.agreement.opportunities.present, false);
  assert.equal(cleaned.additional_valuations, 3); assert.deepEqual(cleaned.scope_rule_ids, ['I1']);
  ok('owner corrections: a rejected finding and a dropped part become recorded EXISTING_STRENGTH overrides (unverified, checked early), interventions and scope are recomputed, the answers and the operator\'s overrides are untouched, the operator\'s override still wins, and only approved findings are presented');
}
{
  // Strong foundations: reuse them, change only the intelligence side.
  const sess = { ...louisSession, answers: { ...COMMERCIAL, ...ALL_STRONG_F, ...WEAK_I } };
  const { c, p } = conclude(sess);
  assert.equal(c.mode, 'PILOT');
  assert.ok(c.understanding.findings.every((f) => f.dimensions.every((x) => /^I/.test(x.dimension))), 'findings only on the intelligence side');
  assert.equal(c.changes.foundations.length, 0); assert.match(c.changes.foundations_note, /reused as they are — nothing is rebuilt/);
  assert.equal(c.changes.preserved.length, 5);
  assert.ok(c.changes.groups.every((g) => g.rules.every((r) => r.kind === 'intelligence')));
  assert.ok(c.changes.groups.find((g) => g.id === 'opportunities').preserve.length >= 1, 'reused foundations named as preserved');
  assert.equal(c.deployment.phases[0].heading, 'Scope, access and reuse of what already works');
  assert.match(c.deployment.phases[0].summary, /stays as it is and NOVUS plugs into it/);
  assert.ok(p.screens[3].preserved.length === 5 && p.screens[3].cards.every((x) => !/capture|record/.test(x.heading)));
  assert.match(p.screens[4].cards[2].sentence, /^Your team contacts the relevant customers and records the outcomes/, 'no capture work → the plain third card');
  assert.deepEqual(leak(p), []);
  // The implementation sequence is genuinely different from Louis's, not the
  // same three cards restated: the foundations card reuses rather than
  // builds, and the sentences name different rules.
  const louisCards = conclude(louisSession).p.screens[3].cards;
  assert.notEqual(p.screens[3].cards[0].heading, louisCards[0].heading, 'foundations heading differs: reuse vs build');
  assert.notEqual(p.screens[3].cards[0].sentence, louisCards[0].sentence);
  assert.match(p.screens[3].cards[0].sentence, /information capture and customer context already work well/);
  ok('strong-foundation agency: findings and changes on the intelligence side only, all five foundations preserved and reused, week 1 says so; the help slide is genuinely different from Louis\'s');

  // Incomplete information: no numbers, one finding, hedged; no pilot ask.
  const inc = conclude({ ...louisSession, answers: { C1: a('more_valuations'), F1: a('patchy'), F1_cause: m(['time']), F3: a('memory') } });
  assert.equal(inc.c.mode, 'VALIDATION');
  assert.equal(inc.c.opportunity.available, false); assert.ok(inc.c.opportunity.missing.length >= 2);
  assert.equal(inc.c.understanding.situation.enquiries_per_month.known, false); assert.ok(inc.c.understanding.situation.missing.includes('fee_per_instruction'));
  assert.ok(inc.c.understanding.findings.length >= 1 && inc.c.understanding.findings.every((f) => f.evidence === 'PROVISIONAL'));
  assert.ok(inc.c.understanding.findings.every((f) => /I think/.test(f.statement)), 'everything hedged');
  assert.ok(inc.c.understanding.unknown.length >= 5);
  assert.equal(inc.c.pilot.proposed, false); assert.equal(inc.c.pilot.pricing_script, ''); assert.match(inc.c.next_step, /^I'm not going to put a pilot to you today/); assert.ok(!/\b[FI][1-5]\b|do not pitch/i.test(inc.c.next_step), 'owner-facing, not the internal recommendation');
  assert.equal(inc.p.screens[2].available, false); assert.equal(inc.p.screens[6].proposed, false); assert.ok(inc.p.screens[6].next_step);
  
  assert.deepEqual(leak(inc.p), []);
  const empty = conclude({ ...louisSession, answers: {} });
  assert.equal(empty.c.understanding.findings.length, 0); assert.equal(empty.c.mode, 'VALIDATION'); assert.equal(empty.p.screens[1].findings.length, 0);
  ok('incomplete information: unknown figures stay unknown, findings are provisional and hedged, the economics screen says so, and the pilot is not asked for — an empty session still renders');

  // Technical blockers: a blocked CRM.
  const blk = conclude({ ...louisSession, answers: { ...ALL_WEAK, C7: a('blocked') } });
  assert.equal(blk.c.mode, 'PILOT');
  const oppG = blk.c.changes.groups.find((g) => g.id === 'opportunities');
  assert.ok(oppG && oppG.rules.every((r) => !['I2', 'I3'].includes(r.rule_id)), 'infeasible rules are not proposed as changes');
  assert.ok(!blk.c.pilot.scope_rule_ids.includes('I3') && !blk.c.pilot.scope_rule_ids.includes('F2'));
  assert.ok(blk.c.understanding.findings.some((f) => f.dimensions.some((x) => x.dimension === 'I3')), 'the finding is still reflected — it is real, just not solvable in the pilot');
  const unsure = conclude({ ...louisSession, answers: { ...ALL_WEAK, C7: a('unsure') } });
  const unsureG = unsure.c.changes.groups.find((g) => g.id === 'opportunities');
  assert.ok(unsureG.conditions.some((x) => x.kind === 'assess' && /CRM/.test(x.text)), 'CRM access appears as a condition');
  assert.notEqual(unsureG.status, 'FEASIBLE');
  assert.ok(unsure.p.screens[3].cards.some((g) => /read every incoming enquiry/.test(g.sentence)), 'the feasible change leads the card');
  assert.deepEqual(leak(unsure.p), []);
  ok('technical blockers: a blocked CRM keeps the finding but drops the infeasible changes from the proposal and scope; an unsure CRM becomes a stated feasibility condition on the change and one plain line on the client screen');

  // Non-fit agencies: strong everywhere, or too small.
  const nf = conclude({ ...louisSession, answers: { ...COMMERCIAL, ...ALL_STRONG_F, ...ALL_STRONG_I } });
  assert.equal(nf.c.mode, 'NO_PITCH'); assert.equal(nf.c.understanding.findings.length, 0); assert.equal(nf.c.changes.groups.length, 0); assert.equal(nf.c.pilot.proposed, false);
  assert.match(nf.c.next_step, /^I'll be straight with you: from what you've told me you already have most of what we'd put in/); assert.ok(!/do not pitch|say so plainly/i.test(nf.c.next_step), 'owner-facing, not the internal recommendation');
  assert.equal(nf.p.screens[3].cards.length, 0); assert.ok(nf.p.screens[3].next_step); assert.equal(nf.p.screens[5].proposed, false); assert.equal(nf.p.screens[6].subtitle, 'Not today');
  const small = conclude({ ...louisSession, answers: { ...ALL_WEAK, C4: a(12), C5: a(150) } });
  assert.equal(small.c.mode, 'NO_PITCH'); assert.ok(small.c.understanding.findings.length >= 2, 'the problems are still reflected honestly'); assert.equal(small.c.pilot.proposed, false);
  assert.match(small.c.next_step, /wouldn't have enough to work with/); assert.match(small.c.next_step, /12 a month, 150 contacts/);
  assert.deepEqual(leak(nf.p), []); assert.deepEqual(leak(small.p), []);
  ok('non-fit agencies: no findings/changes for a strong agency, findings but no pilot for a too-small one; the conclusion says so plainly and the client screens carry the next step instead of a price');
}
{
  // Optional AI polish: wording only, validated, never scope or price.
  const { c } = conclude(louisSession);
  const good = async ({ prompt }) => { const inp = JSON.parse(prompt.slice(prompt.indexOf('\n\n') + 2)); return { findings: inp.findings.map((f) => ({ id: f.id, text: f.text.replace(/Mainly because/g, 'That comes down to') })), changes: inp.changes.map((x) => ({ id: x.id, text: x.text })) }; };
  let out = await polishConclusion({ conclusion: c, call: good });
  assert.equal(out.rejected, 0); assert.equal(out.accepted, c.understanding.findings.length + c.solutions.length);
  const polished = conclude(louisSession, { polish: out.polish }).c;
  assert.ok(polished.understanding.findings.some((f) => /That comes down to/.test(f.statement_polished)) && polished.polish.applied === out.accepted);
  assert.ok(polished.understanding.findings.every((f) => f.statement === c.understanding.findings.find((x) => x.id === f.id).statement), 'the deterministic statement is kept alongside');
  assert.ok(polished.solutions.every((st) => st.sentence_polished === undefined || st.sentence_polished.length > 0), 'solution sentences can be polished too');
  // A correction changes the original → the polish for that stage is stale and dropped.
  const stale = conclude(louisSession, { polish: out.polish, agreement: { capture: { status: 'CORRECTED', dropped: ['F2'], note: 'x' } } }).c;
  assert.ok(stale.solutions.find((st) => st.id === 'foundations') ? stale.solutions.find((st) => st.id === 'foundations').sentence_polished === undefined : true);
  assert.ok(stale.polish.stale >= 1);
  const bad = async ({ prompt }) => { const inp = JSON.parse(prompt.slice(prompt.indexOf('\n\n') + 2)); return { findings: inp.findings.map((f, i) => ({ id: f.id, text: i === 0 ? `${f.text} We guarantee £40,000 a year.` : i === 1 ? 'Too short? Sure. F1 is broken.' : f.text })), changes: inp.changes.map((x) => ({ id: x.id, text: `${x.text} It leverages cutting-edge AI-powered intelligence.` })) }; };
  out = await polishConclusion({ conclusion: c, call: bad });
  assert.ok(out.rejected >= 2 + c.solutions.length && out.accepted === 1, JSON.stringify(out.polish.issues));
  assert.ok(out.polish.issues.some((i) => /guarantee/.test(i)) && out.polish.issues.some((i) => /figure/.test(i)) && out.polish.issues.some((i) => /rule id/.test(i)) && out.polish.issues.some((i) => /marketing/.test(i)));
  out = await polishConclusion({ conclusion: c, call: async () => { throw new Error('simulated outage'); } });
  assert.equal(out.accepted, 0); assert.match(out.error, /simulated outage/);
  const plain = conclude(louisSession, { polish: out.polish }).c;
  assert.ok(plain.understanding.findings.every((f) => !f.statement_polished) && plain.polish.applied === 0);
  assert.equal(validatePolishedText('', 'x').valid, false);
  ok('AI polish: valid rewording is applied per sentence with the original kept; guarantees, figures, rule ids and marketing are rejected; an outage leaves the plain wording; a correction invalidates stale polish');
}

// ── 6. handlers end to end against an in-memory workbook ──────────────────
console.log('\n6. Handlers and persistence');
function makeStore(initial) {
  const store = structuredClone(initial);
  const api = {
    async get(range) { const tab = String(range).split('!')[0]; if (!(tab in store)) throw new Error(`Unable to parse range: ${tab}`); return store[tab].map((r) => r.slice()); },
    async append(range, rows) { const tab = String(range).split('!')[0]; if (!(tab in store)) throw new Error(`no tab ${tab}`); store[tab].push(...rows.map((r) => r.slice())); },
    async update(range, rows) {
      const [tab, a1] = String(range).split('!'); const mm = a1.match(/^([A-Z]+)(\d+)/);
      const colIdx = mm[1].split('').reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1; const rowIdx = Number(mm[2]) - 1;
      rows.forEach((row, i) => { while (store[tab].length <= rowIdx + i) store[tab].push([]); const target = store[tab][rowIdx + i]; row.forEach((v, j) => { while (target.length <= colIdx + j) target.push(''); target[colIdx + j] = v; }); });
    },
    async batchUpdate(data) { for (const { range, values } of data) await api.update(range, values); },
    async listTabs() { return Object.keys(store); },
    async addTab(tab) { store[tab] = []; },
  };
  return { store, repo: createRepo(api) };
}
function req(method, query, body) { return { method, query, body, headers: {} }; }
function res() {
  const r = { statusCode: 200, headers: {}, body: null, status(c) { r.statusCode = c; return r; }, setHeader(k, v) { r.headers[k] = v; return r; }, json(b) { r.body = b; return r; }, end() { return r; } };
  return r;
}
const T0 = Date.now(); const DAY = 86_400_000; const iso = (ms) => new Date(ms).toISOString();
const AG = ['agency_id', 'agency_name', 'clean_agency_name', 'location', 'branch_count', 'crm_name', 'outreach_contact_name', 'outreach_contact_email', 'current_pipeline_status', 'main_phone', 'updated_at'];
const callRow = (obj) => CALLS_HEADER.map((k) => obj[k] ?? '');
const workbook = () => ({
  AGENCIES: [AG, ['ag_1', 'Alpha Estates', 'Alpha Estates', 'Chelmsford', '2', 'Reapit', 'Jane Alpha', 'jane@alpha.co.uk', 'MEETING_BOOKED', '01245 000001', iso(T0)], ['ag_2', 'Beta Homes', 'Beta Homes', 'Brentwood', '', 'Some Unknown CRM', 'Sam Beta', 'sam@beta.co.uk', '', '', iso(T0)]],
  CONTACTS: [['contact_id', 'agency_id', 'contact_name', 'contact_role', 'email', 'is_selected_for_outreach'], ['cnt_1', 'ag_1', 'Jane Alpha', 'Director', 'jane@alpha.co.uk', 'TRUE']],
  PROBES: [['probe_id', 'probe_reference', 'agency_id', 'property_address', 'property_street', 'probe_timestamp', 'probe_status', 'created_at'], ['pr_1', 'RM-0001', 'ag_1', '10 High Street, Chelmsford', '10 High Street', iso(T0 - 10 * DAY), 'closed', iso(T0 - 10 * DAY)]],
  INTELLIGENCE: [['intelligence_id', 'agency_id', 'probe_id', 'grade', 'grade_reason', 'human_contact', 'response_hours', 'seller_recognition', 'updated_at'], ['int_1', 'ag_1', 'pr_1', 'D', 'Slow, single touch, no seller question.', 'yes', '26', 'none', iso(T0 - 3 * DAY)]],
  DIAGNOSIS: [['diagnosis_id', 'agency_id', 'handling_summary', 'updated_at'], ['dg_1', 'ag_1', 'Slow single-touch handling.', iso(T0 - 2 * DAY)]],
  DEMOS: [['demo_id', 'agency_id', 'meeting_booked_at', 'created_at', 'updated_at']],
  ACTIONS: [ACTIONS_HEADER.slice(), ACTIONS_HEADER.map((_, i) => (i === 0 ? 'SCHEMA NOTE' : ''))],
  CALLS: [CALLS_HEADER.slice(), callRow({ call_id: 'cal_1', agency_id: 'ag_1', contact_name: 'Jane Alpha', contact_role: 'Director', call_mode: 'MANUAL', started_at: iso(T0 - DAY), call_status: 'manual', outcome: 'BOOKED_MEETING', connected: 'TRUE', owner_reached: 'TRUE', pitched: 'TRUE', meeting_at: iso(T0 + 2 * DAY), meeting_note: 'Teams', main_priority: 'More valuations', useful_note: 'Frustrated buyers who mention selling get lost.', created_at: iso(T0 - DAY), updated_at: iso(T0 - DAY) })],
});
{
  const { store, repo } = makeStore(workbook());
  __setRepoForTests(repo);
  const fakeModel = async ({ prompt }) => { const inp = JSON.parse(prompt.slice(prompt.indexOf('\n\n') + 2)); const t = templatePitch(inp); return { spoken: `${t.spoken.slice(0, -1)} — shall we?`, ...(inp.plan_skeleton || { week1: 'n/a', week2: 'n/a', weeks3_4: 'n/a', weeks5_8: 'n/a' }) }; };
  __setAiCallerForTests(fakeModel);

  // context: prepopulated from records, nothing invented
  const tables = Object.fromEntries(await Promise.all(Object.keys(store).map(async (t) => [t, await repo.getTable(t)])));
  const ctx = buildAgencyContext(tables, 'ag_1');
  assert.equal(ctx.agency_name, 'Alpha Estates'); assert.equal(ctx.contact_name, 'Jane Alpha'); assert.equal(ctx.crm_name, 'Reapit'); assert.equal(ctx.branch_count, 2);
  assert.equal(ctx.meeting_at, iso(T0 + 2 * DAY)); assert.equal(ctx.meeting_source, 'CALLS'); assert.equal(ctx.source_call_id, 'cal_1');
  assert.equal(ctx.probe.grade, 'D'); assert.equal(ctx.probe.seller_recognition, 'none'); assert.equal(ctx.previous_calls.length, 1); assert.match(ctx.previous_calls[0].note, /buyers who mention selling/);
  const ctx2 = buildAgencyContext(tables, 'ag_2');
  assert.equal(ctx2.branch_count, null); assert.equal(ctx2.meeting_at, ''); assert.equal(ctx2.probe, null);
  ok('agency context is prepopulated from AGENCIES/CONTACTS/CALLS/PROBES/INTELLIGENCE/DIAGNOSIS; missing facts stay missing');

  // meetings before setup → setup → meetings
  let r = res(); await handleDiscoveryMeetings(req('GET', {}), r);
  assert.equal(r.statusCode, 200); assert.equal(r.body.setup.available, false); assert.equal(r.body.meetings[0].agency_id, 'ag_1'); assert.ok(r.body.meetings[0].meeting_sources.includes('CALLS'));
  r = res(); await handleDiscoverySetup(req('POST', {}, {}), r); assert.equal(r.statusCode, 400);
  r = res(); await handleDiscoverySetup(req('POST', {}, { confirm: 'SETUP_DISCOVERY' }), r); assert.equal(r.statusCode, 200);
  assert.deepEqual(store.DISCOVERY_SESSIONS[0], [...DISCOVERY_SESSIONS_HEADER]); assert.deepEqual(store.DISCOVERY_PITCHES[0], [...DISCOVERY_PITCHES_HEADER]);
  r = res(); await handleDiscoverySetup(req('POST', {}, { confirm: 'SETUP_DISCOVERY' }), r); assert.equal(r.body.results[0].result, 'exists');
  ok('meetings list reads booked meetings before the tabs exist; setup needs its confirm token, creates both tabs once, never rewrites them');

  // start (prefill + resume)
  r = res(); await handleDiscoveryStart(req('POST', {}, { agency_id: 'ag_1' }), r);
  assert.equal(r.statusCode, 201); const sessionId = r.body.session_id; assert.equal(r.body.resumed, false);
  let row = sessionView(Object.fromEntries(DISCOVERY_SESSIONS_HEADER.map((k, i) => [k, store.DISCOVERY_SESSIONS[2][i]])));
  assert.equal(row.agency_name, 'Alpha Estates'); assert.equal(row.contact_name, 'Jane Alpha'); assert.equal(row.meeting_at, iso(T0 + 2 * DAY)); assert.equal(row.source_call_id, 'cal_1');
  assert.equal(row.answers.C3.value, 2); assert.equal(row.answers.C3.source, 'AGENCIES'); assert.equal(row.answers.C3.prefilled, true);
  assert.equal(row.answers.C6.value, 'reapit'); assert.equal(row.questions_version, QUESTIONS_VERSION);
  r = res(); await handleDiscoveryStart(req('POST', {}, { agency_id: 'ag_1' }), r);
  assert.equal(r.statusCode, 200); assert.equal(r.body.resumed, true); assert.equal(r.body.session_id, sessionId);
  r = res(); await handleDiscoveryStart(req('POST', {}, { agency_id: 'ag_2' }), r);
  const row2 = sessionView(Object.fromEntries(DISCOVERY_SESSIONS_HEADER.map((k, i) => [k, store.DISCOVERY_SESSIONS[3][i]])));
  assert.equal(row2.answers.C3, undefined, 'blank branch count is not prefilled as zero'); assert.equal(row2.answers.C6.value, 'other'); assert.equal(row2.answers.C6.note, 'Some Unknown CRM');
  r = res(); await handleDiscoveryStart(req('POST', {}, { agency_id: 'ag_nope' }), r); assert.equal(r.statusCode, 404);
  ok('start prefills branch count and CRM from the agency record (flagged, never invented), resumes an open session, 404s an unknown agency');

  // session read carries context + registry + live diagnosis
  r = res(); await handleDiscoverySession(req('GET', { session_id: sessionId }), r);
  assert.equal(r.statusCode, 200); assert.equal(r.body.context.agency_name, 'Alpha Estates'); assert.equal(r.body.registry.questions.length, QUESTIONS.length); assert.equal(r.body.registry.rules.length, 10);
  assert.equal(r.body.diagnosis.suitability.verdict, 'FURTHER_VALIDATION_REQUIRED'); assert.equal(r.body.registry_drift.questions, false);
  r = res(); await handleDiscoverySession(req('GET', { agency_id: 'ag_1' }), r); assert.equal(r.body.session.session_id, sessionId);
  ok('session read returns the session, the prepopulated context, both registries and a live diagnosis');

  // autosave with validation of the payload
  r = res(); await handleDiscoverySave(req('POST', {}, { session_id: sessionId, answers: { ...ALL_WEAK, ZZ: a('nope'), F1: a('not-an-option'), C4: a('abc') }, notes: { meeting: 'Owner keen; two negotiators leaving in October.' }, stage: 'foundations' }), r);
  assert.equal(r.statusCode, 200); assert.equal(r.body.diagnosis.suitability.verdict, 'POTENTIAL_FIT');
  row = sessionView(Object.fromEntries(DISCOVERY_SESSIONS_HEADER.map((k, i) => [k, store.DISCOVERY_SESSIONS[2][i]])));
  assert.equal(row.answers.ZZ, undefined); assert.equal(row.answers.F1, undefined, 'an invalid option is dropped, not stored'); assert.equal(row.answers.C4, undefined, 'a non-number is not stored');
  assert.equal(row.notes.meeting, 'Owner keen; two negotiators leaving in October.'); assert.equal(row.stage, 'foundations');
  assert.equal(row.diagnosis.suitability.verdict, 'POTENTIAL_FIT'); assert.ok(row.plan.phases.length === 5); assert.equal(row.economics.available, true);
  const cleaned = cleanAnswers({ F1_cause: { values: ['time', 'bogus'] }, F1: { skipped: true, skip_reason: 'Ran out of time' } });
  assert.deepEqual(cleaned.F1_cause.values, ['time']); assert.equal(cleaned.F1.skipped, true);
  ok('autosave validates against the registry (unknown ids, invalid options and non-numbers dropped), stores notes/stage, and persists the recomputed diagnosis, plan and economics');

  // override with reason; without reason ignored
  r = res(); await handleDiscoverySave(req('POST', {}, { session_id: sessionId, answers: ALL_WEAK, overrides: { F4: { evidence_status: 'EXISTING_STRENGTH', level: 'strong', reason: 'Saw the report' }, F5: { evidence_status: 'EXISTING_STRENGTH' }, rules: { I5: { include: false, reason: 'Focus' } } } }), r);
  assert.equal(r.body.diagnosis.assessments.F4.evidence_status, 'EXISTING_STRENGTH'); assert.equal(r.body.diagnosis.assessments.F5.evidence_status, 'CONFIRMED', 'override without a reason is ignored');
  assert.ok(!r.body.diagnosis.proposed.includes('I5'));
  row = sessionView(Object.fromEntries(DISCOVERY_SESSIONS_HEADER.map((k, i) => [k, store.DISCOVERY_SESSIONS[2][i]])));
  assert.equal(row.overrides.F4.reason, 'Saw the report'); assert.equal(row.overrides.F5, undefined); assert.equal(row.answers.F4.value, 'nothing', 'the answer itself is not rewritten');
  ok('overrides need a reason, are recorded with it, and never overwrite the discovery answer');

  // pitch v1 (AI), v2 (outage → template); versions preserved
  r = res(); await handleDiscoveryPitch(req('POST', {}, { session_id: sessionId }), r); assert.equal(r.statusCode, 400);
  r = res(); await handleDiscoveryPitch(req('POST', {}, { session_id: sessionId, confirm: 'GENERATE_PITCH' }), r);
  assert.equal(r.statusCode, 201); assert.equal(r.body.pitch.version, 1); assert.equal(r.body.pitch.source, 'AI'); assert.equal(r.body.pitch.status, 'OK');
  assert.deepEqual(r.body.pitch.diagnosis_snapshot.proposed, r.body.diagnosis.proposed);
  __setAiCallerForTests(async () => { throw new Error('simulated outage'); });
  r = res(); await handleDiscoveryPitch(req('POST', {}, { session_id: sessionId, confirm: 'GENERATE_PITCH' }), r);
  assert.equal(r.body.pitch.version, 2); assert.equal(r.body.pitch.source, 'TEMPLATE'); assert.match(r.body.ai_error, /simulated outage/);
  assert.equal(store.DISCOVERY_PITCHES.length, 4, 'two immutable pitch rows');
  const p1 = pitchView(Object.fromEntries(DISCOVERY_PITCHES_HEADER.map((k, i) => [k, store.DISCOVERY_PITCHES[2][i]])));
  assert.equal(p1.version, 1); assert.match(p1.pitch.spoken, /shall we\?$/); assert.deepEqual(p1.pitch.sources, { spoken: 'AI', plan: 'AI' }); assert.ok(p1.pitch.word_count <= SPOKEN_WORD_CAP);
  row = sessionView(Object.fromEntries(DISCOVERY_SESSIONS_HEADER.map((k, i) => [k, store.DISCOVERY_SESSIONS[2][i]])));
  assert.equal(row.pitch_count, 2); assert.equal(row.stage, 'pitch'); assert.deepEqual(Object.keys(row.answers).length, Object.keys(ALL_WEAK).length, 'answers untouched by pitch generation');
  r = res(); await handleDiscoverySession(req('GET', { session_id: sessionId }), r);
  assert.equal(r.body.pitches.length, 2); assert.equal(r.body.pitches[0].version, 2);
  ok('pitch: confirm token required; v1 from the model, v2 falls back to the template on an outage; both versions kept; answers untouched');

  // outcome: invalid, then PILOT_AGREED with follow-up + agreed scope; snapshot frozen; ACTIONS row
  r = res(); await handleDiscoveryOutcome(req('POST', {}, { session_id: sessionId, confirm: 'RECORD_OUTCOME', outcome: 'MAYBE' }), r); assert.equal(r.statusCode, 400);
  r = res(); await handleDiscoveryOutcome(req('POST', {}, { session_id: sessionId, confirm: 'RECORD_OUTCOME', outcome: 'PILOT_AGREED', outcome_notes: 'Agreed.', follow_up_at: iso(T0 + 4 * DAY), agreed_scope_rule_ids: ['F1', 'I1', 'F2', 'ZZ'] }), r);
  assert.equal(r.statusCode, 200); assert.ok(r.body.follow_up_action?.action_id); assert.deepEqual(r.body.warnings, []);
  row = sessionView(Object.fromEntries(DISCOVERY_SESSIONS_HEADER.map((k, i) => [k, store.DISCOVERY_SESSIONS[2][i]])));
  assert.equal(row.status, 'COMPLETED'); assert.equal(row.outcome, 'PILOT_AGREED'); assert.equal(row.follow_up_at, iso(T0 + 4 * DAY));
  assert.deepEqual(row.agreed_scope.rule_ids, ['F1', 'I1', 'F2'], 'only proposed rules can be agreed');
  assert.ok(row.agreed_scope.checklist.length > 5); assert.ok(row.agreed_scope.checklist.some((c) => c.rule_id === 'I1' && c.owner === 'NOVUS'));
  assert.equal(row.question_snapshot.F1.primary, QUESTION_BY_ID.F1.primary); assert.equal(row.question_snapshot.F1.options.patchy, 'Patchy — depends who takes the call');
  const actions = store.ACTIONS.slice(2).map((r2) => Object.fromEntries(ACTIONS_HEADER.map((k, i) => [k, r2[i]])));
  assert.equal(actions.length, 1); assert.equal(actions[0].action_type, 'MEETING_FOLLOW_UP'); assert.equal(actions[0].agency_id, 'ag_1'); assert.equal(actions[0].dedupe_key, `discovery:${sessionId}:followup`);
  r = res(); await handleDiscoverySave(req('POST', {}, { session_id: sessionId, answers: ALL_WEAK }), r); assert.equal(r.statusCode, 409, 'a completed session is not silently edited');
  r = res(); await handleDiscoverySave(req('POST', {}, { session_id: sessionId, answers: ALL_WEAK, reopen: true }), r); assert.equal(r.statusCode, 200);
  ok('outcome: validated, freezes the question snapshot, stores the agreed scope + delivery checklist, creates one MEETING_FOLLOW_UP action; completed sessions need reopen=true to edit');

  // not interested → agency status
  r = res(); await handleDiscoveryStart(req('POST', {}, { agency_id: 'ag_2' }), r); const s2 = r.body.session_id;
  r = res(); await handleDiscoveryOutcome(req('POST', {}, { session_id: s2, confirm: 'RECORD_OUTCOME', outcome: 'NOT_INTERESTED' }), r); assert.equal(r.statusCode, 200);
  assert.equal(store.AGENCIES[2][AG.indexOf('current_pipeline_status')], 'NOT_INTERESTED');
  assert.equal(store.AGENCIES[1][AG.indexOf('current_pipeline_status')], 'MEETING_BOOKED', 'pilot agreed does not change the pipeline status');
  r = res(); await handleDiscoveryMeetings(req('GET', {}), r);
  const m1 = r.body.meetings.find((x) => x.agency_id === 'ag_1');
  assert.equal(m1.session.status, 'IN_PROGRESS', 'ag_1 was reopened above'); assert.equal(m1.session.outcome, 'PILOT_AGREED'); assert.equal(m1.session.suitability, 'POTENTIAL_FIT'); assert.equal(r.body.counts.pilots_agreed, 1); assert.equal(r.body.counts.completed, 1); assert.equal(r.body.counts.in_progress, 1);
  ok('not interested marks the agency NOT_INTERESTED; the meetings list reflects reopened/completed sessions, outcomes and suitability');

  // older meeting stays readable: the snapshot survives a registry label change
  const snap = snapshotFor(ALL_WEAK);
  assert.equal(snap.I3.options.when_time, 'When negotiators have time to call through it'); assert.equal(snap.C4.primary, QUESTION_BY_ID.C4.primary);
  ok('the frozen snapshot carries the wording and option labels a completed session was answered against');
}

// ── 7. the conclusion through the handlers ─────────────────────────────────
console.log('\n7. Conclusion handlers, persistence and an older tab header');
{
  // A workbook whose DISCOVERY_SESSIONS tab predates conclusion_json.
  const oldHeader = DISCOVERY_SESSIONS_HEADER.filter((k) => k !== 'conclusion_json');
  const wb = workbook();
  wb.DISCOVERY_SESSIONS = [oldHeader.slice(), oldHeader.map((_, i) => (i === 0 ? 'SCHEMA NOTE' : ''))];
  wb.DISCOVERY_PITCHES = [DISCOVERY_PITCHES_HEADER.slice(), DISCOVERY_PITCHES_HEADER.map((_, i) => (i === 0 ? 'SCHEMA NOTE' : ''))];
  const { store, repo } = makeStore(wb);
  __setRepoForTests(repo);
  let r = res(); await handleDiscoveryMeetings(req('GET', {}), r);
  assert.equal(r.body.setup.available, true, 'an older header (a strict prefix) still counts as set up');
  r = res(); await handleDiscoveryStart(req('POST', {}, { agency_id: 'ag_1' }), r); const sid = r.body.session_id;
  r = res(); await handleDiscoverySave(req('POST', {}, { session_id: sid, answers: LOUIS, contact_name: 'Louis Example', stage: 'conclusion' }), r);
  assert.equal(r.statusCode, 200); assert.ok(r.body.conclusion && r.body.presentation, 'autosave returns the conclusion and the presentation');
  assert.equal(r.body.conclusion.understanding.findings.length, 3);
  r = res(); await handleDiscoverySession(req('GET', { session_id: sid }), r);
  assert.equal(r.body.conclusion.mode, 'PILOT'); assert.equal(r.body.presentation.screens.length, 7); assert.ok(r.body.registry.conclusion_steps.length === 7);
  assert.equal(store.DISCOVERY_SESSIONS[0].length, oldHeader.length, 'nothing extended yet — no conclusion has been written');
  ok('older tab header: still available, session read and autosave carry the deterministic conclusion and the presentation payload');

  // Save the owner's agreement: header extended in place, row patched, diagnosis recomputed.
  r = res(); await handleDiscoveryConclusion(req('POST', {}, { session_id: sid, agreement: { opportunities: { status: 'AGREED' }, capture: { status: 'CORRECTED', dropped: ['F2'], note: 'Reapit history is fine' }, measure: { status: 'REJECTED' } }, additional_valuations: 4 }), r);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(store.DISCOVERY_SESSIONS[0], [...DISCOVERY_SESSIONS_HEADER], 'the header was extended with conclusion_json');
  const rowOf = () => sessionView(Object.fromEntries(DISCOVERY_SESSIONS_HEADER.map((k, i) => [k, store.DISCOVERY_SESSIONS[2][i]])));
  let row = rowOf();
  assert.equal(row.conclusion.agreement.measure.status, 'REJECTED'); assert.equal(row.conclusion.agreement.measure.present, false); assert.equal(row.conclusion.additional_valuations, 4);
  assert.ok(!row.diagnosis.proposed.includes('F2') && !row.diagnosis.proposed.includes('F5'), 'the stored diagnosis reflects the corrections');
  assert.equal(row.answers.F2.value, 'sometimes'); assert.deepEqual(row.overrides, {}); assert.equal(row.stage, 'conclusion');
  assert.equal(r.body.conclusion.opportunity.selected.monthly_gbp, 5400); assert.equal(r.body.presentation.screens[1].findings.length, 2);
  r = res(); await handleDiscoverySession(req('GET', { session_id: sid }), r);
  assert.equal(r.body.conclusion.understanding.counts.rejected, 1); assert.equal(r.body.diagnosis.assessments.F2.evidence_status, 'EXISTING_STRENGTH');
  // Scope ticks persist and bound the pilot.
  r = res(); await handleDiscoveryConclusion(req('POST', {}, { session_id: sid, scope_rule_ids: ['I1', 'F1', 'F3', 'ZZ', 'F2'] }), r);
  assert.deepEqual(r.body.conclusion.pilot.scope_rule_ids, ['I1', 'F1', 'F3'].filter((id) => r.body.diagnosis.proposed.includes(id)));
  row = rowOf(); assert.equal(row.conclusion.agreement.measure.status, 'REJECTED', 'a scope save keeps the agreement');
  // A later autosave keeps the agreement in force.
  r = res(); await handleDiscoverySave(req('POST', {}, { session_id: sid, answers: { ...LOUIS, C4: a(300) } }), r);
  assert.ok(!r.body.diagnosis.proposed.includes('F5')); assert.equal(r.body.conclusion.understanding.counts.rejected, 1);
  ok('discovery-conclusion: extends an older header in place, persists agreement / illustration / scope, recomputes and stores the corrected diagnosis, never rewrites answers or operator overrides; a later autosave keeps the agreement');

  // Polish through the handler: fake model, then invalid, then outage.
  __setAiCallerForTests(async ({ prompt, tool }) => { const inp = JSON.parse(prompt.slice(prompt.indexOf('\n\n') + 2)); if (tool.name !== 'polish_conclusion') return { spoken: 'x?', week1: 'a', week2: 'b', weeks3_4: 'c', weeks5_8: 'd' }; return { findings: inp.findings.map((f) => ({ id: f.id, text: f.text.replace(/Mainly because/g, 'That comes down to') })), changes: inp.changes.map((x) => ({ id: x.id, text: x.text })) }; });
  r = res(); await handleDiscoveryConclusionPolish(req('POST', {}, { session_id: sid }), r); assert.equal(r.statusCode, 400);
  r = res(); await handleDiscoveryConclusionPolish(req('POST', {}, { session_id: sid, confirm: 'POLISH_CONCLUSION' }), r);
  assert.equal(r.statusCode, 200); assert.ok(r.body.accepted >= 3); assert.equal(r.body.rejected, 0);
  assert.ok(r.body.conclusion.understanding.findings.some((f) => /That comes down to/.test(f.statement_polished || '')));
  row = rowOf(); assert.ok(row.conclusion.polish && row.conclusion.agreement.measure.status === 'REJECTED', 'polish is stored beside the agreement');
  __setAiCallerForTests(async () => ({ findings: [{ id: 'capture', text: 'We guarantee £50,000.' }], changes: [] }));
  r = res(); await handleDiscoveryConclusionPolish(req('POST', {}, { session_id: sid, confirm: 'POLISH_CONCLUSION' }), r);
  assert.equal(r.body.accepted, 0); assert.ok(r.body.rejected >= 3); assert.match(r.body.ai_error, /guarantee/);
  assert.ok(r.body.conclusion.understanding.findings.every((f) => !f.statement_polished), 'plain wording stands');
  __setAiCallerForTests(async () => { throw new Error('simulated outage'); });
  r = res(); await handleDiscoveryConclusionPolish(req('POST', {}, { session_id: sid, confirm: 'POLISH_CONCLUSION' }), r);
  assert.equal(r.statusCode, 200); assert.equal(r.body.accepted, 0); assert.match(r.body.ai_error, /simulated outage/);
  r = res(); await handleDiscoveryConclusion(req('POST', {}, { session_id: sid, clear_polish: true }), r); assert.equal(r.body.conclusion.polish, null);
  ok('discovery-conclusion-polish: confirm token required; valid rewording stored and applied; an invalid model result or an outage leaves the plain wording, with the reason returned; polish can be cleared');

  // Pitch versions are still generated from the corrected diagnosis and kept.
  __setAiCallerForTests(async () => { throw new Error('no model'); });
  r = res(); await handleDiscoveryPitch(req('POST', {}, { session_id: sid, confirm: 'GENERATE_PITCH' }), r);
  assert.equal(r.statusCode, 201); assert.equal(r.body.pitch.version, 1); assert.ok(!r.body.pitch.diagnosis_snapshot.proposed.includes('F2'));
  ok('the spoken pitch archive still works on the corrected diagnosis and keeps its immutable versions');

  // Outcome: the exact findings and scope the owner agreed are frozen with the scope.
  r = res(); await handleDiscoveryOutcome(req('POST', {}, { session_id: sid, confirm: 'RECORD_OUTCOME', outcome: 'PILOT_AGREED', outcome_notes: 'Yes.' }), r);
  assert.equal(r.statusCode, 200);
  row = rowOf();
  assert.deepEqual(row.agreed_scope.rule_ids, ['I1', 'F1', 'F3'].filter((id) => row.diagnosis.proposed.includes(id)), 'the scope ticked in the conclusion is the default agreed scope');
  const snap = row.agreed_scope.conclusion;
  assert.equal(snap.findings.length, 3); assert.equal(snap.findings.find((f) => f.id === 'measure').agreement.status, 'REJECTED'); assert.equal(snap.findings.find((f) => f.id === 'capture').agreement.note, 'Reapit history is fine');
  assert.equal(snap.opportunity.expected_fee_income_per_valuation_gbp, 1350); assert.equal(snap.opportunity.selected.additional_valuations_per_month, 4);
  assert.equal(snap.pilot.headline, '£1,500 all-in for 60 days'); assert.ok(snap.owner_overrides.F2 && snap.owner_overrides.F5);
  assert.ok(row.agreed_scope.checklist.length > 3);
  r = res(); await handleDiscoveryConclusion(req('POST', {}, { session_id: sid, additional_valuations: 1 }), r); assert.equal(r.statusCode, 409, 'a completed session is not silently changed');
  r = res(); await handleDiscoveryConclusion(req('POST', {}, { session_id: sid, additional_valuations: 1, reopen: true }), r); assert.equal(r.statusCode, 200); assert.equal(rowOf().status, 'IN_PROGRESS');
  ok('outcome: the agreed scope defaults to the conclusion\'s ticks and freezes the exact findings, agreement, economics illustration, pilot headline and owner overrides; completed sessions need reopen=true');
}

console.log(`\n✅ Discovery self-test passed (${passed} checks).\n`);
