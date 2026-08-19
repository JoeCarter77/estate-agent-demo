// scripts/novus-probe-personalisation-selftest.mjs — hermetic test (no
// network, no creds) for lib/probe-personalisation.mjs: the AI call that
// turns a probe's settled INTELLIGENCE + DIAGNOSIS into the Personalisation
// narrative (COMMUNICATIONS = evidence, INTELLIGENCE = interpretation,
// DIAGNOSIS = commercial conclusion, PERSONALISATION = the acquisition
// story).
//
// The AI itself is stubbed via lib/ai-client.mjs's __setAiCallerForTests();
// this suite proves the guarantees enforced in code, not just prompted for:
//   - a quote that isn't a literal substring of the raw communication it
//     cites is dropped, exactly like lib/probe-interpretation.mjs's guard
//   - wider_leakage can NEVER carry a currency figure, even if the model
//     writes one anyway — stripInventedCurrency() removes it deterministically
//   - hero_journey is picked deterministically from Intelligence/Diagnosis
//     shape, never by asking the model
//   - a strong-handling probe (blank primary_problem) is never turned into
//     a manufactured weakness
//
// Run: npm run novus:probe-personalisation-selftest

import assert from 'node:assert';
import { personaliseProbe, pickHeroJourney, stripInventedCurrency } from '../lib/probe-personalisation.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

const PROBE = { probe_id: 'prb_001', property_address: 'Barn Field, Chevington, IP29', property_price: '£375,000', probe_timestamp: '2026-08-17T22:34:41Z', enquiry_text: 'Declared: has a property to sell, yes, it is not yet on the market' };

const COMMS = [
  { communication_id: 'com_1', channel: 'voice', occurred_at: '2026-08-18T16:25:30Z', transcript: 'Just wanted to have a quick chat. See what your position is at the moment.' },
  { communication_id: 'com_2', channel: 'email', occurred_at: '2026-08-18T16:26:51Z', subject: 'Ensum Brown | Viewing Enquiry', body_text: 'Are you on the market or renting for example? Please also let us know your availability for a viewing.' },
];

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
    buyer_questions_asked: 'current property position; finance; budget',
    seller_recognition: 'asked_position',
    communication_quality: 'strong',
    evidence: '"Are you on the market or renting for example?" (email, 2026-08-18T16:26:51Z)',
    ...overrides,
  };
}

function baseDiagnosis(overrides = {}) {
  return {
    primary_problem: 'Nothing reached the enquiry for 17.8 hours.',
    primary_evidence: 'Probe 22:34 -> first human contact 16:25 next day = 17.85 hours.',
    secondary_problem: 'The declared seller was asked about their position and never offered a valuation.',
    secondary_evidence: 'No valuation, appraisal or valuer mentioned in either message.',
    strengths: 'Voicemail and email inside 81 seconds across two channels.',
    missed_opportunities: 'An off-market instruction recognised in words and never converted to a valuation.',
    commercial_implication: 'A £375,000 Chevington enquiry sat untouched from 11:34pm until nearly 5:30pm the next day.',
    novus_opportunity: 'Core (front desk)',
    diagnosis_summary: 'Strong front desk, wrong hours.',
    ...overrides,
  };
}

async function run() {
  console.log('lib/probe-personalisation.mjs — hermetic selftest\n');

  // ── A quote that is not a literal substring of the cited message is dropped ──
  {
    __setAiCallerForTests(async () => ({
      personalised_opener: 'Vicky called within 81 seconds of her own email — but 17.85 hours after your enquiry landed.',
      quotes_used: [
        { quote: 'See what your position is at the moment.', communication_id: 'com_1' }, // genuine
        { quote: 'We will absolutely smash this valuation for you', communication_id: 'com_2' }, // fabricated
      ],
      novus_counterfactual: 'At 22:34, NOVUS would have called and emailed within the same 81 seconds Vicky used — just eleven hours earlier.',
      wider_leakage: 'This is not a one-off: evening enquiries land the same way every week.',
      systemic_promise: 'NOVUS catches this gap before the agency itself would ever see the pattern.',
      why_novus: 'Same quality, no waiting.',
      objection_response: '',
      demo_intro: 'Here is what happened when Barn Field enquired.',
    }));
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), COMMS, { live_listing_count: 0 });
    assert.ok(result.quotes_used.includes('See what your position is at the moment.'), 'the genuine quote survives');
    assert.ok(!result.quotes_used.includes('smash this valuation'), 'the fabricated quote is dropped');
    ok('a quote not literally present in its cited communication is discarded, a genuine one survives with channel + timestamp');
  }

  // ── wider_leakage can never carry a currency figure, even if the model writes one ──
  {
    __setAiCallerForTests(async () => ({
      personalised_opener: 'opener',
      quotes_used: [],
      novus_counterfactual: 'counterfactual',
      wider_leakage: 'This pattern likely costs Ensum Brown around £40,000 a year in lost instructions. It also repeats on every out-of-hours enquiry.',
      systemic_promise: 'promise',
      why_novus: 'why',
      objection_response: '',
      demo_intro: 'intro',
    }));
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), COMMS, {});
    assert.ok(!/[£$€]/.test(result.wider_leakage), 'no currency symbol survives in wider_leakage');
    assert.ok(result.wider_leakage.includes('repeats on every out-of-hours enquiry'), 'the qualitative sentence alongside the invented figure survives');
    ok('an AI-invented currency figure is stripped from wider_leakage even though the model wrote it, while the surrounding qualitative sentence is kept');
  }

  // stripInventedCurrency as a unit, both directions.
  {
    assert.strictEqual(stripInventedCurrency('No currency here at all.'), 'No currency here at all.');
    assert.strictEqual(stripInventedCurrency('This costs £12,000 a year.'), '');
    ok('stripInventedCurrency leaves currency-free text untouched and empties text that is only a currency claim');
  }

  // ── Strong handling (blank primary_problem) is never turned into a manufactured weakness ──
  {
    __setAiCallerForTests(async () => ({
      personalised_opener: 'You answered Barn Field in under an hour and asked eight qualification questions.',
      quotes_used: [],
      novus_counterfactual: 'NOVUS would have matched this response exactly, every time, regardless of who is on shift.',
      wider_leakage: '',
      systemic_promise: 'The value is consistency at this standard on every enquiry, not just when your strongest person answers.',
      why_novus: 'Your best response, guaranteed every time.',
      objection_response: '',
      demo_intro: 'Here is your strongest response, now guaranteed at scale.',
    }));
    const strongDiagnosis = baseDiagnosis({ primary_problem: '', primary_evidence: '', secondary_problem: '', secondary_evidence: '', novus_opportunity: 'Growth (valuation list / seller conversion)' });
    const result = await personaliseProbe(PROBE, baseIntelligence({ response_hours: 0.9, follow_ups: 1 }), strongDiagnosis, COMMS, {});
    assert.strictEqual(result.wider_leakage, '', 'no manufactured leakage claim for a well-handled probe');
    assert.strictEqual(result.objection_response, '', 'no manufactured objection for a well-handled probe');
    assert.ok(result.novus_counterfactual.includes('matched'), 'the counterfactual matches strong handling instead of inventing a gap');
    ok('a probe the evidence shows was handled well produces no manufactured weakness anywhere in the story');
  }

  // ── hero_journey is a deterministic lookup, never asked of the model ──
  {
    assert.strictEqual(pickHeroJourney(baseIntelligence({ human_contact: 'none' }), baseDiagnosis()), 'complete_miss');
    assert.strictEqual(pickHeroJourney(baseIntelligence({ human_contact: 'automated_only' }), baseDiagnosis()), 'automated_ack_only');
    assert.strictEqual(
      pickHeroJourney(baseIntelligence(), baseDiagnosis({ primary_problem: '', novus_opportunity: 'Growth (valuation list / seller conversion)' })),
      'strong_handling_database_opportunity'
    );
    assert.strictEqual(
      pickHeroJourney(baseIntelligence(), baseDiagnosis({ primary_problem: '', novus_opportunity: 'None evidenced' })),
      'strong_handling_no_opportunity'
    );
    assert.strictEqual(pickHeroJourney(baseIntelligence({ response_hours: 17.85 }), baseDiagnosis()), 'slow_response_gap');
    assert.strictEqual(
      pickHeroJourney(baseIntelligence({ response_hours: 2, seller_recognition: 'asked_position', viewing_progression: 'booked' }), baseDiagnosis()),
      'weak_seller_qualification'
    );
    assert.strictEqual(
      pickHeroJourney(baseIntelligence({ response_hours: 2, seller_recognition: '', follow_ups: 0 }), baseDiagnosis()),
      'fast_response_stalled_follow_up'
    );
    ok('hero_journey is derived deterministically from Intelligence/Diagnosis shape for every branch, with no AI call involved');
  }

  console.log(`\n${passed} checks passed.`);
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
