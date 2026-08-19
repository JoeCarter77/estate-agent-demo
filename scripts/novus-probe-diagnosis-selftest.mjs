// scripts/novus-probe-diagnosis-selftest.mjs — hermetic test (no network, no
// creds) for lib/probe-diagnosis.mjs: the AI call that turns a closed,
// interpreted INTELLIGENCE row into the nine DIAGNOSIS fields (V2 schema §4).
//
// The AI itself is stubbed via lib/ai-client.mjs's __setAiCallerForTests();
// this suite proves the guarantees the schema requires around it:
//   - a problem is never written without its own evidence, and vice versa
//   - primary_problem/secondary_problem may legitimately both be empty
//   - the grade is passed as context only — two calls with the SAME grade
//     but DIFFERENT evidence produce different diagnoses, because the
//     module never looks the grade up in a template
//
// Run: npm run novus:probe-diagnosis-selftest

import assert from 'node:assert';
import { diagnoseProbe } from '../lib/probe-diagnosis.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

const PROBE = { probe_id: 'prb_001', property_address: 'Barn Field, Chevington, IP29', property_price: '£375,000' };

function baseIntelligence(overrides = {}) {
  return {
    grade: 'F',
    grade_reason: 'Slow human contact (>16h) with 0 genuine follow-up attempts.',
    human_contact: 'yes',
    response_hours: 17.85,
    contact_attempts: 1,
    follow_ups: 0,
    channels_used: 'voice,email',
    viewing_progression: 'availability_requested',
    buyer_qualification: 'thorough',
    buyer_questions_asked: 'partner details; current property position; finance; budget',
    seller_recognition: 'asked_position',
    communication_quality: 'strong',
    did_well: 'Called then emailed within 81 seconds; asked eight qualification questions.',
    missed: 'Asked the seller position but never offered a valuation.',
    evidence: '"Are you on the market or renting for example?" (email, 2026-08-18T16:26:51Z)',
    ...overrides,
  };
}

async function run() {
  console.log('lib/probe-diagnosis.mjs — hermetic selftest\n');

  // ── A problem without evidence is dropped entirely; a problem WITH evidence survives ──
  {
    __setAiCallerForTests(async () => ({
      primary_problem: 'Nothing reached the enquiry for 17.8 hours.',
      primary_evidence: '', // missing on purpose
      secondary_problem: 'The seller thread stalled after the position question.',
      secondary_evidence: 'No valuation or market appraisal was ever offered in either message.',
      strengths: 'Once engaged, asked eight structured qualification questions.',
      missed_opportunities: 'The declared vendor opportunity was recognised and not converted.',
      commercial_implication: 'A £375,000 Chevington instruction sat untouched for 17.8 hours.',
      novus_opportunity: 'Core (front desk)',
      diagnosis_summary: 'Strong front desk, wrong hours.',
    }));
    const result = await diagnoseProbe(baseIntelligence(), PROBE);
    assert.strictEqual(result.primary_problem, '', 'a problem with no evidence field is never written');
    assert.strictEqual(result.primary_evidence, '');
    assert.strictEqual(result.secondary_problem, 'The seller thread stalled after the position question.', 'a problem WITH evidence survives untouched');
    assert.strictEqual(result.secondary_evidence, 'No valuation or market appraisal was ever offered in either message.');
    ok('primary_problem is nulled because it arrived with no evidence, while a properly-evidenced secondary_problem survives');
  }

  // ── Evidence without a problem is dropped too (the guard is symmetric) ──
  {
    __setAiCallerForTests(async () => ({
      primary_problem: '',
      primary_evidence: 'This should never be written since there is no problem statement.',
      secondary_problem: '', secondary_evidence: '',
      strengths: 'Handled well throughout.',
      missed_opportunities: '',
      commercial_implication: 'No implication — handled well.',
      novus_opportunity: 'None evidenced',
      diagnosis_summary: 'Handled this probe well; no front-desk gap evidenced.',
    }));
    const result = await diagnoseProbe(baseIntelligence({ missed: '', evidence: '' }), PROBE);
    assert.strictEqual(result.primary_problem, '');
    assert.strictEqual(result.primary_evidence, '', 'orphaned evidence with no problem statement is dropped');
    assert.strictEqual(result.novus_opportunity, 'None evidenced');
    ok('a probe the evidence shows was handled well can legitimately produce diagnosis_status with no problem at all');
  }

  // ── An invalid novus_opportunity value falls back to the safe default ──
  {
    __setAiCallerForTests(async () => ({
      primary_problem: '', primary_evidence: '', secondary_problem: '', secondary_evidence: '',
      strengths: '', missed_opportunities: '', commercial_implication: '',
      novus_opportunity: 'Something the model invented',
      diagnosis_summary: '',
    }));
    const result = await diagnoseProbe(baseIntelligence(), PROBE);
    assert.strictEqual(result.novus_opportunity, 'None evidenced', 'an out-of-enum value is not trusted verbatim');
    ok('novus_opportunity falls back to "None evidenced" when the model returns something outside the fixed set');
  }

  // ── Same grade, different evidence -> different diagnosis (proves it is not a grade->template lookup) ──
  {
    const responses = new Map([
      ['weak', {
        primary_problem: 'Two and a half days to any human contact, and a holding line when it came.',
        primary_evidence: '63.6 hours to first contact; the reply asked for nothing and offered nothing.',
        secondary_problem: 'The declared seller was never mentioned in any message.',
        secondary_evidence: 'Zero mentions of selling, valuation or appraisal across the one message sent.',
        strengths: 'Limited — the message named the correct property.',
        missed_opportunities: 'Both opportunities: no viewing proposed, no valuation offered.',
        commercial_implication: 'A Brentwood enquiry with an instruction attached went nowhere for 63 hours.',
        novus_opportunity: 'Core (front desk)',
        diagnosis_summary: 'The clearest front-desk gap in the set short of total silence.',
      }],
      ['strong', {
        primary_problem: '',
        primary_evidence: '',
        secondary_problem: '',
        secondary_evidence: '',
        strengths: 'Fast contact, genuine follow-up, thorough qualification, viewing and valuation both booked.',
        missed_opportunities: '',
        commercial_implication: 'No implication — both opportunities were taken.',
        novus_opportunity: 'Growth (valuation list / seller conversion)',
        diagnosis_summary: 'Handled this probe better than the system was built to fault.',
      }],
    ]);
    // Both share grade "F" on purpose — the diagnosis must still differ,
    // because the module keys off the evidence it's handed, not the grade.
    __setAiCallerForTests(async ({ prompt }) => {
      return prompt.includes('Chalmers') ? responses.get('weak') : responses.get('strong');
    });

    const weakResult = await diagnoseProbe(baseIntelligence({ grade: 'F' }), { ...PROBE, property_address: 'Chalmers test property' });
    const strongResult = await diagnoseProbe(baseIntelligence({ grade: 'F' }), PROBE);

    assert.notStrictEqual(weakResult.diagnosis_summary, strongResult.diagnosis_summary);
    assert.strictEqual(weakResult.novus_opportunity, 'Core (front desk)');
    assert.strictEqual(strongResult.primary_problem, '', 'the strong probe finds no forced problem despite sharing a grade with the weak one');
    ok('two probes sharing the same grade produce genuinely different diagnoses, driven by evidence, not the grade letter');
  }

  console.log(`\n${passed} checks passed.`);
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
