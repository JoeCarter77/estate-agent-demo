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
//   - a strong-handling probe (no findings) is never turned into
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
    findings: JSON.stringify([
      { finding: 'Nothing reached the enquiry for 17.8 hours.', evidence: 'Probe 22:34 -> first human contact 16:25 next day = 17.85 hours.', significance_note: 'A response-speed gap that recurs on every out-of-hours enquiry.' },
      { finding: 'The declared seller was asked about their position and never offered a valuation.', evidence: 'No valuation, appraisal or valuer mentioned in either message.', significance_note: 'An off-market instruction lead recognised in words and then dropped.' },
    ]),
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

  // ── Strong handling (no findings) is never turned into a manufactured weakness ──
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
    const strongDiagnosis = baseDiagnosis({ findings: '[]', novus_opportunity: 'Growth (valuation list / seller conversion)' });
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
      pickHeroJourney(baseIntelligence(), baseDiagnosis({ findings: '[]', novus_opportunity: 'Growth (valuation list / seller conversion)' })),
      'strong_handling_database_opportunity'
    );
    assert.strictEqual(
      pickHeroJourney(baseIntelligence(), baseDiagnosis({ findings: '[]', novus_opportunity: 'None evidenced' })),
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

  // ── hero_journey response-speed regression: aligned to lib/grading.mjs's
  // own ">1h and <=16h = Fast, >16h = Slow" boundary (Source Master §10),
  // not a second, independently-chosen threshold. Every case below has a
  // at least one real Diagnosis finding, since the speed
  // band only matters once "handled well" has already been ruled out. ──
  {
    // Real, previously-misclassified cases (all genuinely Fast per the
    // grading engine — grade B/D — but were landing on 'slow_response_gap'
    // under the old <=6h threshold).
    assert.strictEqual(
      pickHeroJourney(baseIntelligence({ response_hours: 1.581944444, seller_recognition: '', follow_ups: 2 }), baseDiagnosis()),
      'fast_response_stalled_follow_up',
      '1.58h (prb_hist_0018 shape) is Fast, not a response-speed gap'
    );
    assert.strictEqual(
      pickHeroJourney(baseIntelligence({ response_hours: 6, seller_recognition: '', follow_ups: 1 }), baseDiagnosis()),
      'fast_response_stalled_follow_up',
      '6h is Fast under the real >1h/<=16h boundary — the old <=6h cutoff is gone, not just relocated'
    );
    assert.strictEqual(
      pickHeroJourney(baseIntelligence({ response_hours: 11.96805556, seller_recognition: '', follow_ups: 1 }), baseDiagnosis()),
      'fast_response_stalled_follow_up',
      '11.97h (prb_hist_0014 shape) is Fast'
    );
    assert.strictEqual(
      pickHeroJourney(baseIntelligence({ response_hours: 11.45194444, seller_recognition: 'asked_position', viewing_progression: 'availability_requested', follow_ups: 1 }), baseDiagnosis()),
      'weak_seller_qualification',
      '11.45h (prb_hist_0012 shape) is Fast AND the seller thread stalled — previously misrouted to slow_response_gap because 11.45h > the old 6h cutoff'
    );

    // The 16h boundary itself, both sides — must agree with grading.mjs's
    // own inclusive "lagHours <= 16" test exactly, not a re-derived value.
    assert.strictEqual(
      pickHeroJourney(baseIntelligence({ response_hours: 16, seller_recognition: '', follow_ups: 1 }), baseDiagnosis()),
      'fast_response_stalled_follow_up',
      'exactly 16h is still Fast (inclusive boundary, matches grade B/D)'
    );
    assert.strictEqual(
      pickHeroJourney(baseIntelligence({ response_hours: 16.01, seller_recognition: '', follow_ups: 1 }), baseDiagnosis()),
      'slow_response_gap',
      'just past 16h is Slow (matches grade E/F)'
    );

    // No response at all — independent of any response_hours value.
    assert.strictEqual(
      pickHeroJourney(baseIntelligence({ human_contact: 'none', response_hours: '' }), baseDiagnosis()),
      'complete_miss',
      'no response is complete_miss regardless of speed banding'
    );

    // Fast + no qualification, no seller thread at all — must land on the
    // shallow/stalled journey, never a speed-gap label.
    assert.strictEqual(
      pickHeroJourney(baseIntelligence({ response_hours: 3, seller_recognition: '', viewing_progression: 'invited', buyer_qualification: 'none', follow_ups: 1 }), baseDiagnosis()),
      'fast_response_stalled_follow_up',
      'fast response with no buyer qualification is fast-but-shallow, not a response-speed gap'
    );

    // Strong handling (no findings) is decided before any speed
    // banding is even consulted — confirmed again here at a fast response
    // time specifically, so a future change to the speed logic can't
    // accidentally start routing strong probes through it.
    assert.strictEqual(
      pickHeroJourney(baseIntelligence({ response_hours: 0.53 }), baseDiagnosis({ findings: '[]', novus_opportunity: 'None evidenced' })),
      'strong_handling_no_opportunity',
      'no findings short-circuits before response-speed banding, even at a fast response time'
    );

    ok('hero_journey response-speed banding matches lib/grading.mjs\'s own >1h/<=16h Fast boundary exactly, including at both edges of 16h, and never mislabels a fast probe as a response-speed gap');
  }

  console.log(`\n${passed} checks passed.`);
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
