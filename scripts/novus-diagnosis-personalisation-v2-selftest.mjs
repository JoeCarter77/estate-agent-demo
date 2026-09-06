#!/usr/bin/env node

import assert from 'node:assert/strict';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';
import { diagnoseProbe, parseDiagnosisFindings, _internal as diagnosisInternal } from '../lib/probe-diagnosis.mjs';
import { selectPersonalisationFacts } from '../lib/personalisation-facts.mjs';
import { personaliseProbeFromFacts, renderCanonicalFactCopy } from '../lib/fact-constrained-personalisation.mjs';
import { containsInternalProspectLanguage, wordCount } from '../lib/prospect-language.mjs';

const PROBE = {
  probe_id: 'prb_v2',
  property_address: 'Grey Lady Place',
  property_price: '£425,000',
  probe_timestamp: '2026-08-21T09:00:00.000Z',
  observation_deadline: '2026-08-25T09:00:00.000Z',
  enquiry_text: 'Declared: has a property to sell, yes, it is not yet on the market — Please send more details.',
};

function answer(overrides = {}) {
  return {
    findings: [], positive_findings: [],
    enquiry_signals: [
      { label: 'Buyer enquiry', value: '£425k', context: 'Listed property enquired about', source_type: 'probe' },
      { label: 'Seller context', value: 'Property to sell', context: 'Declared in the original enquiry', source_type: 'probe' },
      { label: 'Address supplied', value: 'Billericay', context: 'Relationship to the sale is unknown', source_type: 'probe' },
      { label: 'Contact', value: 'New enquiry', context: 'No prior conversation is evidenced', source_type: 'probe' },
    ],
    unresolved_context: [
      { question: 'Is the Billericay address the property being sold?', why_it_matters: 'This must be known before deciding whether seller action is relevant.' },
      { question: 'Does the prospect still want to arrange a viewing?', why_it_matters: 'This determines the buyer-side next step.' },
      { question: 'What is the location and condition of the property they have to sell?', why_it_matters: 'This would provide more seller detail.' },
    ],
    recommended_actions: [
      { title: 'Respond to the viewing enquiry', detail: 'Make human contact and establish whether a viewing is still wanted.' },
      { title: 'Clarify the sale', detail: 'Establish whether the Billericay address is the property being sold.' },
      { title: 'Confirm valuation status', detail: 'Offer or confirm a valuation appointment for the property to sell.' },
      { title: 'Log as a dual-sided lead', detail: 'Prioritise the prospect in the CRM.' },
    ],
    handling_summary: 'No human contact was made during the observation window, with no response or follow-up attempt.', handling_quality: 'weak',
    strengths: '', missed_opportunities: '', commercial_implication: '',
    novus_opportunity: 'Core (front desk)', diagnosis_summary: 'Diagnosis complete.',
    ...overrides,
  };
}

const shapes = [
  {
    name: 'complete miss',
    intelligence: { human_contact: 'none', response_hours: '', contact_attempts: 0, follow_ups: 0, channels_used: '', viewing_progression: 'none', buyer_qualification: 'none', buyer_questions_asked: '', seller_recognition: 'none', communication_quality: 'poor', grade: 'H' },
    ai: answer({ findings: [
      { finding_type: 'problem', finding: 'No human response was recorded.', evidence: 'Human contact: none.', significance_note: 'The enquiry was not handled.' },
      { finding_type: 'opportunity', finding: 'A valuation opportunity was missed.', evidence: 'A property to sell was declared and no valuation was offered.', significance_note: 'Potential instruction.' },
    ] }),
    quality: 'weak', observation: /four days.*didn't record a human response/i,
  },
  {
    name: 'slow response',
    intelligence: { human_contact: 'yes', response_hours: 19, contact_attempts: 1, follow_ups: 0, channels_used: 'email', viewing_progression: 'availability_requested', buyer_qualification: 'minimal', buyer_questions_asked: 'viewing availability', seller_recognition: 'none', communication_quality: 'competent', grade: 'E' },
    ai: answer({
      findings: [{ finding_type: 'problem', finding: 'The first human response was slow.', evidence: 'It arrived after 19 hours.', significance_note: 'Response speed was the clearest weakness.' }],
      positive_findings: [{ finding: 'The team asked for viewing availability.', evidence: 'Viewing progression: availability requested.', significance_note: 'It gave the buyer a next step.' }],
      handling_summary: 'The reply moved the viewing forward, but arrived after 19 hours.', handling_quality: 'mixed',
    }),
    quality: 'mixed', observation: /16 hours|availability/i,
  },
  {
    name: 'fast but shallow',
    intelligence: { human_contact: 'yes', response_hours: 0.2, contact_attempts: 1, follow_ups: 0, channels_used: 'email', viewing_progression: 'mentioned', buyer_qualification: 'none', buyer_questions_asked: '', seller_recognition: 'none', communication_quality: 'generic', grade: 'B' },
    ai: answer({
      findings: [{ finding_type: 'problem', finding: 'Useful moving context remained unresolved.', evidence: 'No buyer questions were recorded and seller recognition was none.', significance_note: 'The response added little understanding.' }],
      positive_findings: [{ finding: 'The team replied quickly.', evidence: 'Human response after 12 minutes.', significance_note: 'Response speed was strong.' }],
      handling_summary: 'The team replied quickly, but established little useful context.', handling_quality: 'mixed',
    }),
    quality: 'mixed', observation: /within 12 minutes|position as a buyer/i,
  },
  {
    name: 'persistent but unresolved',
    intelligence: { human_contact: 'yes', response_hours: 1.5, contact_attempts: 3, follow_ups: 2, channels_used: 'email,phone', viewing_progression: 'invited', buyer_qualification: 'minimal', buyer_questions_asked: 'viewing availability', seller_recognition: 'none', communication_quality: 'competent', grade: 'B' },
    ai: answer({
      findings: [{ finding_type: 'problem', finding: 'The wider moving context remained unresolved.', evidence: 'Seller recognition was none after three attempts.', significance_note: 'One clarification would improve understanding.' }],
      positive_findings: [{ finding: 'The team followed up persistently.', evidence: 'Three attempts including two follow-ups.', significance_note: 'Persistence was strong.' }],
      handling_summary: 'The team followed up persistently while wider moving context remained unresolved.', handling_quality: 'mixed',
    }),
    quality: 'mixed', observation: /follow-up|related to this move/i,
  },
  {
    name: 'strong handling',
    intelligence: { human_contact: 'yes', response_hours: 0.15, contact_attempts: 3, follow_ups: 2, channels_used: 'email,phone', viewing_progression: 'slot_offered', buyer_qualification: 'standard', buyer_questions_asked: 'finance; timescale; viewing availability', seller_recognition: 'valuation_offered', communication_quality: 'strong', grade: 'A' },
    ai: answer({
      positive_findings: [{ finding: 'The team handled the enquiry strongly.', evidence: 'A reply arrived in nine minutes, useful questions were asked and a viewing slot was offered.', significance_note: 'The interaction had a clear next step.' }],
      unresolved_context: [],
      recommended_actions: [], handling_summary: 'The team responded quickly, clarified the position and offered a clear viewing next step.', handling_quality: 'strong',
      novus_opportunity: 'None evidenced',
    }),
    quality: 'strong', observation: /specific viewing slot/i,
  },
];

for (const shape of shapes) {
  __setAiCallerForTests(async ({ purpose, tool }) => {
    if (purpose === 'diagnosis') {
      assert.ok(tool.input_schema.required.includes('enquiry_signals'));
      return shape.ai;
    }
    throw new Error(`unexpected purpose ${purpose}`);
  });
  const diagnosis = await diagnoseProbe(shape.intelligence, PROBE);
  assert.equal(diagnosis.handling_quality, shape.quality, shape.name);
  assert.ok(JSON.parse(diagnosis.enquiry_signals).length >= 4);
  assert.ok(JSON.parse(diagnosis.unresolved_context).length <= 3);
  assert.ok(JSON.parse(diagnosis.recommended_actions).length <= 3);
  assert.equal(containsInternalProspectLanguage(diagnosis.handling_summary), false, shape.name);
  assert.doesNotMatch(JSON.stringify(diagnosis), /£425,?000[^.!?]*(?:seller|valuation)|(?:seller|valuation)[^.!?]*£425,?000/i);
  assert.doesNotMatch(JSON.stringify(parseDiagnosisFindings(diagnosis)), /valuation opportunity was missed/i);
  if (shape.name === 'strong handling') {
    assert.deepEqual(parseDiagnosisFindings(diagnosis).filter((f) => f.finding_type !== 'positive'), []);
    assert.deepEqual(JSON.parse(diagnosis.unresolved_context), [], 'answered timescale is not unresolved');
    assert.deepEqual(JSON.parse(diagnosis.recommended_actions), []);
  }
  if (shape.name === 'complete miss') {
    const unresolved = JSON.parse(diagnosis.unresolved_context);
    const actions = JSON.parse(diagnosis.recommended_actions);
    assert.equal(unresolved.length, 2, 'overlapping seller-property detail is removed');
    assert.doesNotMatch(JSON.stringify(unresolved), /condition/i);
    assert.deepEqual(actions.map((item) => item.title), ['Respond to the viewing enquiry', 'Clarify the seller position']);
    assert.match(diagnosis.handling_summary, /four days after the enquiry/i);
  }

  const facts = selectPersonalisationFacts({ findings: parseDiagnosisFindings(diagnosis), intelligence: shape.intelligence, probe: PROBE });
  const gold = renderCanonicalFactCopy(facts);
  __setAiCallerForTests(async ({ purpose, tool }) => {
    assert.equal(purpose, 'personalisation_fact_constrained');
    assert.deepEqual(tool.input_schema.required, ['email_observation', 'email_commercial_hook']);
    return gold;
  });
  const surface = await personaliseProbeFromFacts(facts, { enabled: true });
  assert.match(surface.email_observation, shape.observation, shape.name);
  assert.ok(surface.email_commercial_hook);
  assert.ok(wordCount(surface.email_observation) <= 25, `${shape.name}: concise observation`);
  assert.equal(containsInternalProspectLanguage(`${surface.email_observation} ${surface.email_commercial_hook}`), false);
  assert.equal('email_commercial_hook_email_2' in surface, false);
  assert.notEqual(surface.email_observation.toLowerCase(), surface.email_commercial_hook.toLowerCase());
  assert.doesNotMatch(`${surface.email_observation} ${surface.email_commercial_hook}`, /valuation opportunity|lost revenue|instruction|fee/i);
  if (shape.name === 'complete miss') {
    assert.match(surface.email_commercial_hook, /property-to-sell declaration/i);
    assert.doesNotMatch(surface.email_commercial_hook, /several signals/i);
  }
}

assert.match(diagnosisInternal.SYSTEM_PROMPT, /BILLERICAY RULE/);
assert.doesNotMatch(diagnosisInternal.SYSTEM_PROMPT, /always creates exactly two opportunities/i);
assert.equal(diagnosisInternal.questionAlreadyAnswered('What timescale are they working towards?', {}, {
  enquiry_text: 'We are hoping to move within 3 months.',
}), true);
assert.equal(diagnosisInternal.questionAlreadyAnswered('What timescale are they working towards?', {
  buyer_questions_asked: 'timescale',
}, PROBE), false, 'a question asked but never answered remains unresolved');
assert.equal(diagnosisInternal.questionAlreadyAnswered('Is the Billericay address the property being sold?', {}, {
  enquiry_text: 'The flat I need to sell is in Chelmsford; it is not the Billericay contact address.',
}), true, 'an explicit negative relationship answers seller-property identity');
__setAiCallerForTests(null);
console.log('✅ novus-diagnosis-personalisation-v2-selftest: five evidence shapes pass');
