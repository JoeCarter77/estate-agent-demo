// scripts/novus-probe-diagnosis-selftest.mjs — hermetic test (no network, no
// creds) for lib/probe-diagnosis.mjs: the AI call that turns a closed,
// interpreted INTELLIGENCE row into the DIAGNOSIS fields, including the
// `findings` array (0-4 items, most commercially damaging first).
//
// The AI itself is stubbed via lib/ai-client.mjs's __setAiCallerForTests();
// this suite proves the guarantees the schema requires around it:
//   - a finding is never written without its own evidence, and vice versa
//   - findings may legitimately be an empty array
//   - a probe is capped at FOUR findings in total — at most three
//     problem/opportunity findings plus at most one positive — and the model
//     over-returning on either array cannot get a fifth row written
//   - the grade is passed as context only — two calls with the SAME grade
//     but DIFFERENT evidence produce different diagnoses, because the
//     module never looks the grade up in a template
//
// Run: npm run novus:probe-diagnosis-selftest

import assert from 'node:assert';
import { diagnoseProbe, parseDiagnosisFindings, _internal } from '../lib/probe-diagnosis.mjs';
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

  // ── FOUR PER PROBE, BY ROLE ───────────────────────────────────────────────
  //
  // Personalisation writes three beats (a fair observation from a positive,
  // the main story, and an optional wider beat), so a probe carrying six
  // findings was not telling the agency six things — it was handing the
  // selection step near-duplicates to tell apart. The budget is now one
  // positive + up to three problem/opportunity findings, and the caps are
  // enforced in code as well as in the schema.
  {
    __setAiCallerForTests(async () => ({
      findings: [1, 2, 3, 4, 5, 6].map((n) => ({ finding_type: 'problem', finding: `Finding ${n}`, evidence: `Evidence ${n}`, significance_note: `Significance ${n}` })),
      positive_findings: [1, 2].map((n) => ({ finding: `Positive ${n}`, evidence: `Positive evidence ${n}`, significance_note: `Positive significance ${n}` })),
      strengths: '', missed_opportunities: '', commercial_implication: 'Specific to this agency and probe.',
      novus_opportunity: 'Core (front desk)', diagnosis_summary: 'Multiple genuine findings.',
    }));
    const result = await diagnoseProbe(baseIntelligence(), PROBE);
    const findings = parseDiagnosisFindings(result);

    assert.strictEqual(findings.length, 4, 'a probe with six problems and two positives on offer is capped at four findings in total');
    assert.deepStrictEqual(findings.map((f) => f.finding), ['Finding 1', 'Finding 2', 'Finding 3', 'Positive 1'],
      'the three strongest problem/opportunity findings, in the order the model ranked them, plus the single strongest positive');
    assert.deepStrictEqual(findings.map((f) => f.finding_type), ['problem', 'problem', 'problem', 'positive'],
      'ordering is unchanged: index 1 is still the strongest/main finding, positives still come last');
    ok('4-FINDING CAP — six problems and two positives on offer come back as three problem findings plus one positive, strongest first');
  }

  // ── ...and the cap keeps the model's own priority order, so an overlapping
  //    lower-ranked restatement is what gets dropped, not the strong finding ──
  {
    __setAiCallerForTests(async () => ({
      findings: [
        { finding_type: 'problem', finding: 'The conversation never established my position — no budget, funding or timescale question was asked.', evidence: 'No qualification question appears in either message.', significance_note: 'The enquiry was never qualified.' },
        { finding_type: 'opportunity', finding: 'A property of my own to sell was declared and no valuation was ever offered.', evidence: 'The enquiry declared a property to sell; no valuation appears in any reply.', significance_note: 'A seller instruction was left on the table.' },
        // Two lower-ranked restatements of the first finding, worded
        // differently — the shape the cap has to survive.
        { finding_type: 'problem', finding: 'My timescale was never asked about.', evidence: 'No timescale question appears.', significance_note: 'Same qualification gap.' },
        { finding_type: 'problem', finding: 'Nobody asked about my budget.', evidence: 'No budget question appears.', significance_note: 'Same qualification gap.' },
      ],
      positive_findings: [{ finding: 'The team followed up quickly.', evidence: 'Three attempts across phone and email within one day.', significance_note: 'Shows strong persistence.' }],
      strengths: 'Persistent follow-up.', missed_opportunities: 'The declared vendor opportunity.',
      commercial_implication: 'A £375,000 Chevington enquiry was never qualified.',
      novus_opportunity: 'Growth (valuation list / seller conversion)', diagnosis_summary: 'Qualification gap with a live seller opportunity behind it.',
    }));
    const result = await diagnoseProbe(baseIntelligence(), PROBE);
    const findings = parseDiagnosisFindings(result);

    assert.strictEqual(findings.length, 4, 'still four');
    assert.ok(findings[0].finding.startsWith('The conversation never established my position'), 'the main story keeps index 1');
    assert.ok(!findings.some((f) => /valuation was ever offered/i.test(f.finding)),
      'seller declaration plus no valuation is not promoted to an opportunity');
    assert.strictEqual(findings.filter((f) => f.finding_type === 'positive').length, 1, 'the genuine positive is retained rather than squeezed out by problem findings');
    ok('seller declaration alone never creates the former valuation-opportunity beat');
  }

  // ── The instruction the model is actually given: consolidate, don't duplicate ──
  {
    const { TOOL, SYSTEM_PROMPT } = _internal;
    const storyDescription = TOOL.input_schema.properties.findings.description;
    assert.strictEqual(TOOL.input_schema.properties.findings.maxItems, 3, 'the schema allows at most three problem/opportunity findings');
    assert.strictEqual(TOOL.input_schema.properties.positive_findings.maxItems, 1, '...and exactly one positive');
    assert.ok(/consolidate/i.test(storyDescription), 'the schema tells the model to consolidate two findings that are the same underlying issue');
    assert.ok(/Unknown context is not an opportunity/.test(storyDescription) && /seller declaration alone is never a valuation opportunity/i.test(storyDescription),
      'and distinguishes unresolved context from evidence-supported opportunity');
    assert.ok(/FOUR FINDINGS PER PROBE, MAXIMUM/.test(SYSTEM_PROMPT), 'the system prompt states the per-probe budget');
    assert.ok(/Never invent a wider opportunity, a supporting problem or a positive to fill a slot/.test(SYSTEM_PROMPT),
      'and that an empty slot is never filled by invention');
    ok('THE BRIEF ITSELF — the schema and prompt separate unknown context from opportunity and invent nothing to fill a slot');
  }

  // ── Fewer than four is a complete answer ──────────────────────────────────
  {
    __setAiCallerForTests(async () => ({
      findings: [
        { finding_type: 'problem', finding: 'Nothing reached the enquiry for 17.8 hours.', evidence: 'First human contact at 17.85 hours.', significance_note: 'The enquiry went cold before anyone spoke to me.' },
      ],
      positive_findings: [{ finding: 'The reply, when it came, answered the question asked.', evidence: 'The email answered the availability question directly.', significance_note: 'The handling itself was competent.' }],
      strengths: 'Competent once engaged.', missed_opportunities: '', commercial_implication: 'A £375,000 enquiry sat for 17.8 hours.',
      novus_opportunity: 'Core (front desk)', diagnosis_summary: 'One clear gap, nothing else evidenced.',
    }));
    const result = await diagnoseProbe(baseIntelligence({ seller_recognition: '' }), PROBE);
    const findings = parseDiagnosisFindings(result);
    assert.strictEqual(findings.length, 2, 'a probe with one real problem and one real positive stores exactly those two');
    assert.deepStrictEqual(findings.map((f) => f.finding_type), ['problem', 'positive'], 'nothing is invented to reach four');
    ok('FEWER THAN FOUR IS COMPLETE — a probe with no distinct wider opportunity and no supporting problem stores two findings, not four');
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
