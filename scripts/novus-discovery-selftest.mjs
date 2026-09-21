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
import { QUESTIONS, QUESTION_BY_ID, DIMENSIONS, isVisible, effectiveLevel, snapshotFor, QUESTIONS_VERSION } from '../lib/discovery-questions.mjs';
import { RULES, RULE_BY_ID, DELIVERY_STATUSES, FOUNDING_OFFER } from '../lib/discovery-rules.mjs';
import { diagnose, assessDimension, computeEconomics, SUITABILITY_POLICY } from '../lib/discovery-engine.mjs';
import { buildPitchInput, templatePitch, validatePitch, generatePitch, pitchSpoken } from '../lib/discovery-pitch.mjs';
import { DISCOVERY_SESSIONS_HEADER, DISCOVERY_PITCHES_HEADER, sessionView, pitchView } from '../lib/discovery-store.mjs';
import {
  handleDiscoveryMeetings, handleDiscoverySession, handleDiscoverySetup, handleDiscoveryStart,
  handleDiscoverySave, handleDiscoveryPitch, handleDiscoveryOutcome, buildAgencyContext, cleanAnswers,
} from '../lib/discovery-handlers.mjs';

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

// ── 3. the ten scenarios ───────────────────────────────────────────────────
console.log('\n3. Scenarios');
const scenarios = {};
{
  // 1. weak foundations + weak intelligence
  let d = diagnose({ answers: ALL_WEAK }); scenarios.weakWeak = d;
  assert.equal(d.suitability.verdict, 'POTENTIAL_FIT');
  assert.equal(d.findings.confirmed.length, 10);
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
  assert.equal(d.findings.unknown.length, 9);
  assert.equal(d.suitability.verdict, 'FURTHER_VALIDATION_REQUIRED');
  assert.ok(d.suitability.reasons.includes('ECONOMICS_UNKNOWN') || d.suitability.reasons.includes('INCOMPLETE_DISCOVERY'));
  assert.ok(d.validation.length >= 9);
  assert.equal(d.economics.available, false); assert.deepEqual(d.economics.missing, ['average fee per instruction', 'valuation-to-instruction conversion', 'monthly valuations']);
  const empty = diagnose({ answers: {} });
  assert.equal(empty.suitability.verdict, 'FURTHER_VALIDATION_REQUIRED'); assert.ok(empty.suitability.reasons.includes('INCOMPLETE_DISCOVERY'));
  ok('8. incomplete discovery → FURTHER_VALIDATION_REQUIRED; unknown dimensions listed for validation; economics unavailable with the missing figures named; an empty session is never a fit');

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
{
  const input = buildPitchInput(session, scenarios.weakWeak);
  assert.equal(input.mode, 'PILOT');
  assert.equal(input.interventions.length, 10);
  assert.ok(!JSON.stringify(input).includes('@') && !/0124\d+/.test(JSON.stringify(input)), 'no emails or phone numbers go to the model');
  assert.ok(input.allowed_money_figures.includes(1500) && input.allowed_money_figures.includes(4200) && input.allowed_money_figures.includes(3500));
  const strongInput = buildPitchInput(session, scenarios.strongStrong);
  assert.equal(strongInput.mode, 'NO_PITCH'); assert.equal(strongInput.interventions.length, 0);
  ok('pitch input carries only structured findings, selected rules and allowed figures; mode follows suitability');

  const tpl = templatePitch(input);
  const v = validatePitch(tpl, input);
  assert.equal(v.valid, true, v.issues.join('; '));
  for (const key of ['situation', 'gaps', 'interventions', 'preserved', 'together', 'plan_60_days', 'measurement', 'pilot_offer']) assert.ok(tpl.sections[key], `template has ${key}`);
  assert.match(tpl.sections.pilot_offer, /£1,500 all-in for sixty days/);
  assert.match(tpl.sections.measurement, /as an illustration, not a forecast/);
  assert.match(tpl.sections.interventions, /read every enquiry that comes in/);
  assert.ok(!/guarantee/i.test(pitchSpoken(tpl)));
  const noPitch = templatePitch(strongInput);
  assert.match(noPitch.sections.interventions, /I don't think we should run the pilot/);
  assert.equal(noPitch.sections.pilot_offer, '');
  assert.equal(validatePitch(noPitch, strongInput).valid, true);
  const preserveInput = buildPitchInput(session, scenarios.preserve);
  assert.match(templatePitch(preserveInput).sections.preserved, /next actions — a follow-up gets set every time/i);
  ok('template pitch: eight sections, the offer verbatim, illustration hedged, strengths preserved; no-pitch variant declines plainly with no price');

  const bad = { ...tpl, sections: { ...tpl.sections, measurement: 'We guarantee at least ten extra valuations, worth £40,000 a month.', interventions: `${tpl.sections.interventions} Also we would establish usable customer context.` } };
  const badInput = buildPitchInput(session, scenarios.blockedCrm);
  const bv = validatePitch(bad, badInput);
  assert.equal(bv.valid, false);
  assert.ok(bv.issues.some((i) => /guarantee/.test(i)));
  assert.ok(bv.issues.some((i) => /£40,000/.test(i)));
  assert.ok(bv.issues.some((i) => /not proposed: F2/.test(i)));
  ok('validation rejects guarantees, money figures not from discovery, and interventions that were not proposed');

  // AI paths through generatePitch with a fake caller
  const good = async ({ tool }) => Object.fromEntries(tool.input_schema.required.map((k) => [k, k === 'pilot_offer' ? 'The founding pilot is £1,500 all-in for sixty days.' : `Spoken ${k}.`]));
  let out = await generatePitch({ session, diagnosis: scenarios.weakWeak, call: good });
  assert.equal(out.source, 'AI'); assert.equal(out.validation.valid, true); assert.equal(out.pitch.sections.gaps, 'Spoken gaps.');
  out = await generatePitch({ session, diagnosis: scenarios.weakWeak, call: async () => { throw new Error('simulated outage'); } });
  assert.equal(out.source, 'TEMPLATE'); assert.match(out.error, /simulated outage/); assert.equal(out.validation.valid, true);
  out = await generatePitch({ session, diagnosis: scenarios.weakWeak, call: async ({ tool }) => Object.fromEntries(tool.input_schema.required.map((k) => [k, 'We guarantee £9,999 a month.'])) });
  assert.equal(out.source, 'TEMPLATE'); assert.equal(out.validation.ai_rejected, true); assert.ok(out.validation.ai_issues.some((i) => /guarantee/.test(i)));
  ok('generatePitch: a valid model result is used; an outage and an invalid result both fall back to the template with the reason recorded — discovery data untouched');
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
  __setAiCallerForTests(async ({ tool }) => Object.fromEntries(tool.input_schema.required.map((k) => [k, k === 'pilot_offer' ? 'The founding pilot is £1,500 all-in for sixty days.' : `Spoken ${k}.`])));

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
  assert.equal(p1.version, 1); assert.equal(p1.pitch.sections.gaps, 'Spoken gaps.');
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

console.log(`\n✅ Discovery self-test passed (${passed} checks).\n`);
