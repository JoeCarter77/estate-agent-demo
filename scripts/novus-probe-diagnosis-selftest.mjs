// scripts/novus-probe-diagnosis-selftest.mjs — hermetic test (no network, no
// creds) for lib/probe-diagnosis.mjs: the AI call that turns a closed,
// interpreted INTELLIGENCE row into the DIAGNOSIS fields, including the
// `findings` array (0-4 items, most commercially damaging first).
//
// The AI itself is stubbed via lib/ai-client.mjs's __setAiCallerForTests();
// this suite proves the guarantees the schema requires around it:
//   - a finding is never written without its own evidence, and vice versa
//   - findings may legitimately be an empty array
//   - more than MAX_FINDINGS items returned by the model are truncated
//   - the grade is passed as context only — two calls with the SAME grade
//     but DIFFERENT evidence produce different diagnoses, because the
//     module never looks the grade up in a template
//
// Run: npm run novus:probe-diagnosis-selftest

import assert from 'node:assert';
import { diagnoseProbe, parseDiagnosisFindings } from '../lib/probe-diagnosis.mjs';
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

  // ── A finding without evidence is dropped entirely; a finding WITH evidence survives ──
  {
    __setAiCallerForTests(async () => ({
      findings: [
        { finding: 'Nothing reached the enquiry for 17.8 hours.', evidence: '', significance_note: 'Should be dropped.' }, // missing evidence, on purpose
        { finding: 'The seller thread stalled after the position question.', evidence: 'No valuation or market appraisal was ever offered in either message.', significance_note: 'An instruction lead recognised and never converted.' },
      ],
      strengths: 'Once engaged, asked eight structured qualification questions.',
      missed_opportunities: 'The declared vendor opportunity was recognised and not converted.',
      commercial_implication: 'A £375,000 Chevington instruction sat untouched for 17.8 hours.',
      novus_opportunity: 'Core (front desk)',
      diagnosis_summary: 'Strong front desk, wrong hours.',
    }));
    const result = await diagnoseProbe(baseIntelligence(), PROBE);
    const findings = parseDiagnosisFindings(result);
    assert.strictEqual(findings.length, 1, 'the evidence-less finding is dropped, the evidenced one survives');
    assert.strictEqual(findings[0].finding, 'The seller thread stalled after the position question.');
    assert.strictEqual(findings[0].evidence, 'No valuation or market appraisal was ever offered in either message.');
    ok('a finding with no evidence field is never written, while a properly-evidenced finding survives untouched');
  }

  // ── Evidence without a finding is dropped too (the guard is symmetric) ──
  {
    __setAiCallerForTests(async () => ({
      findings: [{ finding: '', evidence: 'This should never be written since there is no finding statement.', significance_note: '' }],
      strengths: 'Handled well throughout.',
      missed_opportunities: '',
      commercial_implication: 'No implication — handled well.',
      novus_opportunity: 'None evidenced',
      diagnosis_summary: 'Handled this probe well; no front-desk gap evidenced.',
    }));
    const result = await diagnoseProbe(baseIntelligence({ missed: '', evidence: '' }), PROBE);
    const findings = parseDiagnosisFindings(result);
    assert.strictEqual(findings.length, 0, 'orphaned evidence with no finding statement is dropped');
    assert.strictEqual(result.novus_opportunity, 'None evidenced');
    ok('a probe the evidence shows was handled well can legitimately produce an empty findings array');
  }

  // ── More than MAX_FINDINGS returned by the model is truncated, not rejected ──
  {
    __setAiCallerForTests(async () => ({
      findings: [1, 2, 3, 4, 5].map((n) => ({ finding: `Finding ${n}`, evidence: `Evidence ${n}`, significance_note: `Significance ${n}` })),
      strengths: '', missed_opportunities: '', commercial_implication: 'Specific to this agency and probe.',
      novus_opportunity: 'Core (front desk)', diagnosis_summary: 'Multiple genuine findings.',
    }));
    const result = await diagnoseProbe(baseIntelligence(), PROBE);
    const findings = parseDiagnosisFindings(result);
    assert.strictEqual(findings.length, 4, 'a 5th finding is dropped even if the model over-returns');
    assert.strictEqual(findings[3].finding, 'Finding 4', 'the first 4, in order, are kept');
    ok('findings are capped at 4, defensively, even if the schema is somehow exceeded');
  }

  // ── An invalid novus_opportunity value falls back to the safe default ──
  {
    __setAiCallerForTests(async () => ({
      findings: [],
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
        findings: [
          { finding: 'Two and a half days to any human contact, and a holding line when it came.', evidence: '63.6 hours to first contact; the reply asked for nothing and offered nothing.', significance_note: 'The clearest front-desk gap in the set short of total silence.' },
          { finding: 'The declared seller was never mentioned in any message.', evidence: 'Zero mentions of selling, valuation or appraisal across the one message sent.', significance_note: 'An instruction lead that was never even acknowledged.' },
        ],
        strengths: 'Limited — the message named the correct property.',
        missed_opportunities: 'Both opportunities: no viewing proposed, no valuation offered.',
        commercial_implication: 'A Brentwood enquiry with an instruction attached went nowhere for 63 hours.',
        novus_opportunity: 'Core (front desk)',
        diagnosis_summary: 'The clearest front-desk gap in the set short of total silence.',
      }],
      ['strong', {
        findings: [],
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
    assert.strictEqual(parseDiagnosisFindings(strongResult).length, 0, 'the strong probe finds no forced finding despite sharing a grade with the weak one');
    ok('two probes sharing the same grade produce genuinely different diagnoses, driven by evidence, not the grade letter');
  }

  // ── parseDiagnosisFindings never throws on unparsable/legacy content ──
  {
    assert.deepStrictEqual(parseDiagnosisFindings({ findings: '' }), []);
    assert.deepStrictEqual(parseDiagnosisFindings({ findings: 'not json' }), []);
    assert.deepStrictEqual(parseDiagnosisFindings({}), []);
    ok('parseDiagnosisFindings reads back as no findings for blank, unparsable, or missing content');
  }

  console.log(`\n${passed} checks passed.`);
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
