// scripts/novus-diagnosis-seller-price-selftest.mjs — hermetic regression test
// (no network, no creds) for the SELLER-PRICE PROVENANCE rule at its source:
// lib/probe-diagnosis.mjs.
//
// PROBES.property_price is the asking price of the property the prospect
// enquired about AS A BUYER, and nothing else. The probe carries no figure for
// whatever property that same prospect declared they have to SELL, so any
// price attached to the seller/valuation/instruction opportunity in DIAGNOSIS
// or DIAGNOSIS_FINDINGS asserts a valuation nobody ever gave us.
//
// The Personalisation guard downstream stays exactly where it is; this suite
// proves the bad claim no longer reaches the sheet in the first place, and
// that the legitimate BUYER-side use of the same figure still survives.
//
// Run: npm run novus:diagnosis-seller-price-selftest

import assert from 'node:assert';
import { diagnoseProbe, parseDiagnosisFindings, _internal } from '../lib/probe-diagnosis.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

// The scenario from the report: a £450,000 enquiry property, a declared seller
// opportunity, and NO figure anywhere for the property they have to sell.
const PROBE = {
  probe_id: 'prb_450',
  property_address: 'Barn Field, Chevington, IP29',
  property_price: '£450,000',
};

const INTELLIGENCE = {
  grade: 'F',
  grade_reason: 'Slow human contact (>16h) with 0 genuine follow-up attempts.',
  human_contact: 'yes',
  response_hours: 17.85,
  contact_attempts: 1,
  follow_ups: 0,
  channels_used: 'voice,email',
  viewing_progression: 'availability_requested',
  buyer_qualification: 'thorough',
  buyer_questions_asked: 'partner details; current property position; finance',
  seller_recognition: 'asked_position',
  communication_quality: 'strong',
  did_well: 'Called then emailed within 81 seconds.',
  missed: 'Asked the seller position but never offered a valuation.',
  evidence: '"Are you on the market or renting for example?" (email, 2026-08-18T16:26:51Z)',
};

// Everything a DIAGNOSIS row and its DIAGNOSIS_FINDINGS rows put in front of a
// human, as one flat list of strings.
function allDiagnosisText(result) {
  const findings = parseDiagnosisFindings(result);
  return [
    result.strengths,
    result.missed_opportunities,
    result.commercial_implication,
    result.diagnosis_summary,
    ...findings.flatMap((f) => [f.finding, f.evidence, f.significance_note]),
  ].filter(Boolean);
}

// Any way of writing the enquiry figure that a model might reach for.
const PRICE_SHAPES = /£\s?450|450,000|450k|450,000\.00/i;
const SELLER_TERMS = /\b(sellers?|vendors?|valuations?|instructions?|to\s+sell|to\s+list)\b/i;

async function run() {
  console.log('Diagnosis seller-price provenance — hermetic selftest\n');

  // ── THE REPORTED BUG: the model prices the seller opportunity off the
  //    enquiry price, in every field it can reach. None of it may be written. ──
  {
    __setAiCallerForTests(async () => ({
      findings: [
        {
          finding_type: 'opportunity',
          finding: 'A £450k valuation opportunity was never followed up.',
          evidence: 'The enquiry declared a property to sell worth around £450,000 and no valuation was offered.',
          significance_note: 'A £450,000 instruction left on the table.',
        },
        {
          finding_type: 'opportunity',
          finding: 'A valuation opportunity on a named £255k property went nowhere.',
          evidence: 'The seller property was named and never valued.',
          significance_note: 'Missed listing revenue.',
        },
      ],
      positive_findings: [{
        finding: 'The team replied on both channels.',
        evidence: 'Called then emailed within 81 seconds.',
        significance_note: 'Shows a responsive front desk.',
      }],
      strengths: 'Quick to respond, though a £450,000 vendor opportunity was ignored.',
      missed_opportunities: 'A valuation lead worth pursuing for a potential £225k+ instruction.',
      commercial_implication: 'A £450,000 instruction sat untouched for 17.8 hours.',
      novus_opportunity: 'Growth (valuation list / seller conversion)',
      diagnosis_summary: 'Fast front desk. A £450k seller conversation was never had.',
    }));

    const result = await diagnoseProbe(INTELLIGENCE, PROBE);
    for (const text of allDiagnosisText(result)) {
      const sellerClauseWithPrice = SELLER_TERMS.test(text) && PRICE_SHAPES.test(text);
      assert.strictEqual(
        sellerClauseWithPrice, false,
        `seller-side price attribution reached the sheet: ${JSON.stringify(text)}`,
      );
    }
    ok('no DIAGNOSIS or DIAGNOSIS_FINDINGS field attributes the £450,000 enquiry price to the seller opportunity');

    // The findings themselves survive — this is a price strip, not a finding
    // strip. The commercial point is still made, just unpriced.
    const findings = parseDiagnosisFindings(result);
    assert.strictEqual(findings.length, 3, 'all three evidenced findings are still written');
    assert.match(findings[0].finding, /valuation opportunity/i, 'the seller finding survives, without its invented figure');
    assert.strictEqual(findings[0].finding_type, 'opportunity', 'finding_type is untouched');
    assert.strictEqual(findings[2].finding_type, 'positive', 'the positive is still appended last');
    assert.ok(findings.every((f) => f.finding && f.evidence), 'no finding was emptied into a drop by the guard');
    assert.strictEqual(result.novus_opportunity, 'Growth (valuation list / seller conversion)', 'novus_opportunity is untouched');
    assert.ok(result.strengths && result.missed_opportunities && result.commercial_implication && result.diagnosis_summary,
      'no prose field was emptied — the strip is surgical, not sentence-level');
    ok('the seller-side findings and every prose field survive unpriced — nothing is dropped, only the figure goes');
  }

  // ── The legitimate BUYER-side use of the very same figure is untouched. ──
  {
    __setAiCallerForTests(async () => ({
      findings: [{
        finding_type: 'problem',
        finding: 'The £450,000 enquiry went unanswered for 17.8 hours.',
        evidence: 'First human contact came 17.85 hours after the enquiry on a £450,000 property.',
        significance_note: 'A £450,000 buyer was left waiting most of a day.',
      }],
      positive_findings: [],
      strengths: 'Thorough qualification once engaged.',
      missed_opportunities: 'The buying opportunity on the £450,000 property was slow to be taken.',
      commercial_implication: 'A £450,000 Chevington enquiry sat for 17.8 hours.',
      novus_opportunity: 'Core (front desk)',
      diagnosis_summary: 'A £450,000 enquiry waited most of a day for a reply.',
    }));

    const result = await diagnoseProbe(INTELLIGENCE, PROBE);
    const findings = parseDiagnosisFindings(result);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].finding, 'The £450,000 enquiry went unanswered for 17.8 hours.');
    assert.strictEqual(findings[0].evidence, 'First human contact came 17.85 hours after the enquiry on a £450,000 property.');
    assert.strictEqual(findings[0].significance_note, 'A £450,000 buyer was left waiting most of a day.');
    assert.strictEqual(result.commercial_implication, 'A £450,000 Chevington enquiry sat for 17.8 hours.');
    assert.strictEqual(result.diagnosis_summary, 'A £450,000 enquiry waited most of a day for a reply.');
    ok('buyer-side use of the £450,000 enquiry price survives verbatim in findings and prose');
  }

  // ── Co-occurrence is not attribution: one sentence may carry the buyer price
  //    and a seller mention in DIFFERENT clauses and keep both. ──
  {
    const line = 'They replied fast on the £450,000 property I asked about, but nobody picked up that I had a property to sell.';
    __setAiCallerForTests(async () => ({
      findings: [{ finding_type: 'problem', finding: line, evidence: line, significance_note: 'Both halves are true.' }],
      positive_findings: [],
      strengths: '', missed_opportunities: '', commercial_implication: line,
      novus_opportunity: 'Growth (valuation list / seller conversion)',
      diagnosis_summary: line,
    }));
    const result = await diagnoseProbe(INTELLIGENCE, PROBE);
    assert.strictEqual(parseDiagnosisFindings(result)[0].finding, line, 'a price and a seller mention in separate clauses attribute nothing');
    assert.strictEqual(result.commercial_implication, line);
    ok('a buyer price and a seller mention in separate clauses of one sentence are both kept');
  }

  // ── The brief itself states the provenance and forbids the seller-side use,
  //    so the deterministic strip is a net rather than the only defence. ──
  {
    const prompt = _internal.SYSTEM_PROMPT;
    assert.match(prompt, /NEVER PRICE THE SELLER OPPORTUNITY/, 'the system prompt carries the provenance rule');
    assert.match(prompt, /AS A BUYER/, 'the brief states what the figure actually is');
    assert.match(prompt, /valuation opportunity/i, 'the brief gives the unpriced seller phrasings to use instead');
    ok('the diagnosis brief states the price provenance and bans seller-side use of the figure');
  }

  // ── The existing per-probe guarantees are unchanged by all of the above. ──
  {
    __setAiCallerForTests(async () => ({
      findings: [
        { finding_type: 'problem', finding: 'No evidence for this one.', evidence: '', significance_note: 'Dropped.' },
        { finding_type: 'opportunity', finding: 'A declared seller opportunity was never converted.', evidence: 'No valuation was ever offered.', significance_note: 'An instruction lead recognised and not taken.' },
        { finding_type: 'problem', finding: 'Nothing reached the enquiry for 17.8 hours.', evidence: 'First contact at 17.85 hours.', significance_note: 'Slow front desk.' },
        { finding_type: 'problem', finding: 'A fourth story finding.', evidence: 'Over the story cap.', significance_note: 'Should be capped away.' },
      ],
      positive_findings: [
        { finding: 'The team followed up quickly.', evidence: 'Three attempts within one day.', significance_note: 'Shows persistence.' },
        { finding: 'A second positive.', evidence: 'Over the positive cap.', significance_note: 'Should be capped away.' },
      ],
      strengths: 'Strong qualification.',
      missed_opportunities: 'The declared vendor opportunity was not converted.',
      commercial_implication: 'A Chevington enquiry went nowhere for 17.8 hours.',
      novus_opportunity: 'Growth (valuation list / seller conversion)',
      diagnosis_summary: 'Strong front desk, wrong hours.',
    }));
    const findings = parseDiagnosisFindings(await diagnoseProbe(INTELLIGENCE, PROBE));
    assert.strictEqual(findings.length, 4, 'evidence-less finding dropped, story cap 3 and positive cap 1 still applied, four per probe');
    assert.deepStrictEqual(findings.map((f) => f.finding_type), ['opportunity', 'problem', 'problem', 'positive'],
      'story findings still come first in order, positive still appended last');
    assert.strictEqual(findings[0].finding, 'A declared seller opportunity was never converted.',
      'an already-unpriced seller finding passes through byte-for-byte');
    ok('finding selection, evidence guard, caps, ordering and typing are all unchanged');
  }

  console.log(`\n${passed} checks passed.`);
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
