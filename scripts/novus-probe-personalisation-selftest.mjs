// scripts/novus-probe-personalisation-selftest.mjs — hermetic test (no
// network, no creds) for lib/probe-personalisation.mjs: the ONE AI call that
// turns a probe's settled INTELLIGENCE + DIAGNOSIS + DIAGNOSIS_FINDINGS into
// the story, and assembles the outreach email from it.
//
// The AI itself is stubbed via lib/ai-client.mjs's __setAiCallerForTests();
// this suite proves the guarantees enforced in CODE, not just prompted for:
//   - the COMPLETE Diagnosis picture reaches the prompt: every finding, plus
//     strengths / missed_opportunities / commercial_implication /
//     novus_opportunity / diagnosis_summary, plus the probe facts the email
//     needs (property value, address, enquiry date, the enquiry itself)
//   - multiple findings can combine into one primary narrative, and the
//     finding numbers claimed are validated against the findings that exist
//   - supporting_findings (and therefore the email's optional "a couple of
//     other things" line) can only appear when a genuine finding is actually
//     left over
//   - a quote that isn't a literal substring of the cited communication is
//     dropped, exactly like lib/probe-interpretation.mjs's guard
//   - the ONLY currency figure that survives anywhere is this probe's own
//     property value; an invented fee/annual-cost figure is stripped
//   - fair observation: never praise Diagnosis recorded no strengths for, and
//     the plain "we never received a reply" line when nothing came back
//   - a strong-handling probe (no findings) is never turned into a
//     manufactured weakness
//   - the locked email structure is assembled deterministically in code
//   - hero_journey is a deterministic lookup, never asked of the model
//
// Run: npm run novus:probe-personalisation-selftest

import assert from 'node:assert';
import {
  personaliseProbe, pickHeroJourney, stripUnbackedCurrency,
  normalizeCurrencyFigure, formatEnquiryDate, buildOpeningLine, buildEmailBody,
  cleanAddressForEmail,
} from '../lib/probe-personalisation.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

const PROBE = {
  probe_id: 'prb_001',
  property_address: 'Barn Field, Chevington, IP29',
  property_price: '£375,000',
  probe_timestamp: '2026-08-17T22:34:41Z',
  enquiry_text: 'Declared: has a property to sell, yes, it is not yet on the market',
};

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
    did_well: 'Two channels used inside 81 seconds of each other.',
    missed: 'No valuation was ever offered.',
    evidence: '"Are you on the market or renting for example?" (email, 2026-08-18T16:26:51Z)',
    ...overrides,
  };
}

function baseDiagnosis(overrides = {}) {
  return {
    strengths: 'Voicemail and email inside 81 seconds across two channels.',
    missed_opportunities: 'An off-market instruction recognised in words and never converted to a valuation.',
    commercial_implication: 'A Chevington enquiry sat untouched from 11:34pm until nearly 5:30pm the next day.',
    novus_opportunity: 'Core (front desk)',
    diagnosis_summary: 'Strong front desk, wrong hours.',
    ...overrides,
  };
}

// The DIAGNOSIS_FINDINGS rows for this probe, in finding_index order —
// exactly the shape lib/diagnosis-findings.mjs reads back out of the tab.
function baseFindings() {
  return [
    { finding_index: 1, finding: 'Nothing reached the enquiry for 17.8 hours.', evidence: 'Probe 22:34 -> first human contact 16:25 next day = 17.85 hours.', significance_note: 'A response-speed gap that recurs on every out-of-hours enquiry.' },
    { finding_index: 2, finding: 'The declared seller was asked about their position and never offered a valuation.', evidence: 'No valuation, appraisal or valuer mentioned in either message.', significance_note: 'An off-market instruction lead recognised in words and then dropped.' },
    { finding_index: 3, finding: 'No follow-up was made after the single first contact.', evidence: 'follow_ups = 0 against contact_attempts = 1.', significance_note: 'The viewing was never actually secured.' },
  ];
}

function stubResult(overrides = {}) {
  return {
    primary_narrative: 'The enquiry sat for 17.8 hours, and when contact finally came it opened a seller conversation it never closed.',
    narrative_finding_indexes: [1, 2],
    supporting_findings: 'There was also no follow-up after that single first contact.',
    evidence_quotes: [],
    commercial_story: 'A £375,000 Chevington enquiry waited overnight and the instruction behind it was never pursued.',
    fair_observation: 'Once your team did pick this up, they used two channels inside 81 seconds and asked good questions.',
    novus_counterfactual: 'At 22:34, NOVUS would have replied in the same 81 seconds your team used — eleven hours earlier — and offered the valuation in the same breath.',
    email_main_point: 'Nothing reached us for about 18 hours, and when it did, the property we mentioned selling never came up again.',
    email_consequence: 'That means the enquiry went cold overnight and the valuation was never offered.',
    email_wider_consequence: 'That means every evening enquiry is landing the same way.',
    ...overrides,
  };
}

async function run() {
  console.log('lib/probe-personalisation.mjs — hermetic selftest\n');

  // ── The COMPLETE Diagnosis picture + probe facts reach the one AI call ──
  {
    let seenPrompt = '';
    __setAiCallerForTests(async ({ prompt }) => { seenPrompt = prompt; return stubResult(); });
    await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, { live_listing_count: 42 });

    for (const finding of baseFindings()) {
      assert.ok(seenPrompt.includes(finding.finding), `finding ${finding.finding_index} reached the prompt`);
      assert.ok(seenPrompt.includes(finding.evidence), `finding ${finding.finding_index}'s evidence reached the prompt`);
      assert.ok(seenPrompt.includes(finding.significance_note), `finding ${finding.finding_index}'s significance reached the prompt`);
    }
    // Not just findings[] — the rest of the Diagnosis row too.
    assert.ok(seenPrompt.includes('Voicemail and email inside 81 seconds'), 'strengths reached the prompt');
    assert.ok(seenPrompt.includes('An off-market instruction recognised in words'), 'missed_opportunities reached the prompt');
    assert.ok(seenPrompt.includes('A Chevington enquiry sat untouched'), 'commercial_implication reached the prompt');
    assert.ok(seenPrompt.includes('Core (front desk)'), 'novus_opportunity reached the prompt');
    assert.ok(seenPrompt.includes('Strong front desk, wrong hours.'), 'diagnosis_summary reached the prompt');
    // The probe/enquiry facts the email itself is built from.
    assert.ok(seenPrompt.includes('Barn Field, Chevington, IP29'), 'property address reached the prompt');
    assert.ok(seenPrompt.includes('£375,000'), 'property value reached the prompt');
    assert.ok(seenPrompt.includes('17 August'), 'the enquiry date reached the prompt');
    assert.ok(seenPrompt.includes('has a property to sell'), 'the enquiry text reached the prompt');
    // The actual interaction, verbatim.
    assert.ok(seenPrompt.includes('See what your position is at the moment.'), 'the raw communications reached the prompt');
    assert.ok(seenPrompt.includes('42 live listings'), 'the code-computed scale fact reached the prompt');
    ok('the complete Diagnosis picture (all findings + strengths, missed_opportunities, commercial_implication, novus_opportunity, summary), the probe facts and the raw interaction all reach the single AI call');
  }

  // ── Several findings combine into ONE primary narrative; the leftovers
  //    become the supporting findings, and only then can the email's
  //    "a couple of other things" line appear ──
  {
    __setAiCallerForTests(async () => stubResult());
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {});
    assert.strictEqual(result.narrative_finding_indexes, '1,2', 'the narrative records which findings it combined');
    assert.ok(result.supporting_findings.includes('no follow-up'), 'the finding left out of the narrative survives as a supporting finding');
    assert.ok(result.email_body.includes('There were also a couple of other things from this enquiry that caught our attention.'),
      'the optional line appears because a genuine finding is actually left over');
    ok('multiple findings combine into one primary narrative, the leftover finding becomes a supporting finding, and the email\'s optional line follows from that');
  }

  // ── Nothing left over -> no supporting findings, and the optional email
  //    line cannot appear with nothing behind it ──
  {
    __setAiCallerForTests(async () => stubResult({
      narrative_finding_indexes: [1, 2, 3],
      supporting_findings: 'There were several other issues worth mentioning.', // model padding
    }));
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {});
    assert.strictEqual(result.supporting_findings, '', 'no finding is left over, so supporting_findings is forced empty');
    assert.ok(!result.email_body.includes('a couple of other things'), 'the optional email line is not printed with nothing behind it');
    ok('when the narrative already covers every finding, padded supporting_findings is discarded and the optional email line is suppressed');
  }

  // ── A claimed finding number that does not exist is discarded ──
  {
    __setAiCallerForTests(async () => stubResult({ narrative_finding_indexes: [1, 7, 2, 1] }));
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {});
    assert.strictEqual(result.narrative_finding_indexes, '1,2', 'finding 7 does not exist and is dropped; the duplicate is collapsed');
    ok('the narrative can only claim finding numbers that genuinely exist, so the audit trail back to DIAGNOSIS_FINDINGS cannot lie');
  }

  // ── A quote that is not a literal substring of the cited message is dropped ──
  {
    __setAiCallerForTests(async () => stubResult({
      evidence_quotes: [
        { quote: 'See what your position is at the moment.', communication_id: 'com_1' }, // genuine
        { quote: 'We will absolutely smash this valuation for you', communication_id: 'com_2' }, // fabricated
      ],
    }));
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {});
    assert.ok(result.evidence.includes('See what your position is at the moment.'), 'the genuine quote survives');
    assert.ok(!result.evidence.includes('smash this valuation'), 'the fabricated quote is dropped');
    assert.ok(result.evidence.includes('2026-08-18T16:25:30Z'), 'the surviving quote carries its channel and timestamp');
    ok('a quote not literally present in its cited communication is discarded, a genuine one survives with channel + timestamp');
  }

  // ── Currency: the probe's own property value is allowed; an invented fee
  //    or annual-cost figure is not — anywhere in the output ──
  {
    __setAiCallerForTests(async () => stubResult({
      commercial_story: 'A £375,000 instruction was left on the table. That is roughly £11,250 in fees at 3%.',
      email_consequence: 'That means you likely lost around £9,000 of commission on this one enquiry.',
      primary_narrative: 'The £375,000 Chevington enquiry waited overnight.',
    }));
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {});
    assert.ok(result.commercial_story.includes('£375,000'), 'the probe\'s own property value survives');
    assert.ok(!result.commercial_story.includes('11,250'), 'the invented fee assumption is stripped');
    assert.strictEqual(result.email_consequence, '', 'an invented commission figure takes the whole sentence with it');
    assert.ok(result.primary_narrative.includes('£375,000'), 'the property value survives in the narrative too');
    assert.ok(!/£9,000|£11,250/.test(result.email_body), 'no invented figure reaches the assembled email');
    ok('the probe\'s own property value is the only currency figure that survives; invented fee and commission figures are stripped everywhere, including from the email');
  }

  // ── No property value on file -> no currency figure may appear at all ──
  {
    __setAiCallerForTests(async () => stubResult({
      commercial_story: 'A £375,000 instruction was left on the table. The seller lead was simply dropped.',
    }));
    const priceless = { ...PROBE, property_price: '' };
    const result = await personaliseProbe(priceless, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {});
    assert.ok(!/£/.test(result.commercial_story), 'with no property value on file, no currency figure survives');
    assert.ok(result.commercial_story.includes('seller lead was simply dropped'), 'the qualitative sentence alongside it is kept');
    ok('a probe with no property value on file can carry no currency figure at all, while the qualitative sentence beside it survives');
  }

  // stripUnbackedCurrency / normalizeCurrencyFigure as units.
  {
    assert.strictEqual(stripUnbackedCurrency('No currency here at all.', '£375,000'), 'No currency here at all.');
    assert.strictEqual(stripUnbackedCurrency('This costs £12,000 a year.', '£375,000'), '');
    assert.strictEqual(stripUnbackedCurrency('A £375,000 home.', '£375,000'), 'A £375,000 home.');
    assert.strictEqual(stripUnbackedCurrency('A £375,000 home. Worth £11,250 in fees.', '£375,000'), 'A £375,000 home.');
    assert.strictEqual(stripUnbackedCurrency('This costs £12,000 a year.', ''), '');
    assert.strictEqual(normalizeCurrencyFigure('£375,000'), '375000');
    assert.strictEqual(normalizeCurrencyFigure('375000'), '375000');
    assert.strictEqual(normalizeCurrencyFigure('£375k'), '375000');
    assert.strictEqual(normalizeCurrencyFigure(''), null);
    ok('stripUnbackedCurrency keeps only the allowed property value, sentence by sentence, and normalizeCurrencyFigure equates £375,000 / 375000 / £375k');
  }

  // ── Fair observation: never praise the Diagnosis records no strengths for ──
  {
    __setAiCallerForTests(async () => stubResult({ fair_observation: 'Your team handled this really well throughout.' }));
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis({ strengths: '' }), baseFindings(), COMMS, {});
    assert.strictEqual(result.fair_observation, '', 'praise with no recorded strengths behind it is discarded');
    assert.ok(!result.email_body.includes('handled this really well'), 'and never reaches the email');
    ok('a fair observation the Diagnosis records no strengths for is never printed — the mirror of never manufacturing a weakness');
  }

  // ── No response at all: the email simply says we never received a reply ──
  {
    __setAiCallerForTests(async () => stubResult({
      fair_observation: 'Your team did their best under the circumstances.',
      evidence_quotes: [],
      email_wider_consequence: '',
    }));
    const noReplyIntelligence = baseIntelligence({ human_contact: 'none', response_hours: '', contact_attempts: 0, channels_used: '' });
    const noReplyFindings = [{ finding_index: 1, finding: 'The enquiry was never replied to.', evidence: 'No communications recorded in the 4-day window.', significance_note: 'A buyer and a seller lead both lost in silence.' }];
    const result = await personaliseProbe(PROBE, noReplyIntelligence, baseDiagnosis({ strengths: '' }), noReplyFindings, [], {});
    assert.strictEqual(result.fair_observation, 'We never received a reply.', 'the no-response case states it plainly, overriding whatever the model wrote');
    assert.ok(result.email_body.includes('We never received a reply.'), 'and that line is what appears in the email');
    assert.strictEqual(result.hero_journey, 'complete_miss', 'the journey is the complete-miss one');
    assert.strictEqual(result.evidence, '', 'nothing was ever said, so there is no evidence to quote');
    ok('a probe that was never replied to says exactly that, in place of any fair observation, and routes to the complete_miss journey');
  }

  // ── Strong handling (no findings) is never turned into a weakness ──
  {
    __setAiCallerForTests(async () => stubResult({
      primary_narrative: 'You answered Barn Field in under an hour and asked eight qualification questions — the question is whether that happens on every enquiry.',
      narrative_finding_indexes: [],
      supporting_findings: 'There were still a few things that could have gone better.', // model padding
      commercial_story: 'Nothing was lost here.',
      novus_counterfactual: 'NOVUS would have matched this response exactly, every time, regardless of who is on shift.',
      email_wider_consequence: '',
    }));
    const strongDiagnosis = baseDiagnosis({ novus_opportunity: 'Growth (valuation list / seller conversion)' });
    const result = await personaliseProbe(PROBE, baseIntelligence({ response_hours: 0.9, follow_ups: 1 }), strongDiagnosis, [], COMMS, {});
    assert.strictEqual(result.supporting_findings, '', 'no findings means nothing can be a supporting finding');
    assert.ok(!result.email_body.includes('a couple of other things'), 'no manufactured "other things" line');
    assert.strictEqual(result.narrative_finding_indexes, '', 'no finding numbers are claimed');
    assert.ok(result.novus_counterfactual.includes('matched'), 'the counterfactual matches strong handling instead of inventing a gap');
    assert.strictEqual(result.hero_journey, 'strong_handling_database_opportunity', 'and the journey is the strong-handling one');
    ok('a probe the evidence shows was handled well produces no manufactured weakness anywhere in the story or the email');
  }

  // ── The email structure is locked and assembled in code ──
  {
    __setAiCallerForTests(async () => stubResult());
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {});
    const paragraphs = result.email_body.split('\n\n');
    assert.strictEqual(paragraphs[0], 'Hi {{first_name}},', 'the greeting keeps first_name as a merge field');
    assert.strictEqual(paragraphs[1], 'We sent your team an enquiry on 17 August about Barn Field, Chevington, IP29.', 'the second line states the real enquiry date and property');
    assert.ok(paragraphs[2].startsWith('Once your team did pick this up'), 'the fair observation comes next');
    assert.ok(paragraphs[3].startsWith('Nothing reached us'), 'then the main point');
    assert.ok(paragraphs[4].startsWith('That means'), 'then the immediate consequence');
    assert.ok(paragraphs[5].startsWith('That means'), 'then the wider consequence');
    assert.strictEqual(paragraphs[6], 'There were also a couple of other things from this enquiry that caught our attention.');
    assert.strictEqual(paragraphs[7], "I've put together the full breakdown of what we found. Happy to send it over if you want to take a look.");
    assert.strictEqual(paragraphs.length, 8, 'and nothing else');
    // Not selling NOVUS or a demo.
    assert.ok(!/NOVUS|demo|leakage/i.test(result.email_body), 'the email never mentions NOVUS, a demo, or leakage');
    ok('the locked email structure is assembled deterministically in code: greeting, enquiry line, fair observation, main point, That means, That means, other things, CTA — and nothing else');
  }

  // ── The optional beats really are optional ──
  {
    __setAiCallerForTests(async () => stubResult({
      narrative_finding_indexes: [1, 2, 3],
      fair_observation: '',
      email_wider_consequence: '',
    }));
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis({ strengths: '' }), baseFindings(), COMMS, {});
    const paragraphs = result.email_body.split('\n\n');
    assert.strictEqual(paragraphs.length, 5, 'greeting, enquiry line, main point, one consequence, CTA');
    assert.strictEqual(paragraphs[2], 'Nothing reached us for about 18 hours, and when it did, the property we mentioned selling never came up again.');
    assert.ok(paragraphs[3].startsWith('That means'));
    assert.ok(paragraphs[4].startsWith("I've put together the full breakdown"));
    ok('the fair observation, the second "That means" and the "other things" line all drop out cleanly when they are not supported');
  }

  // ── "That means" is normalised so the locked structure cannot drift ──
  {
    __setAiCallerForTests(async () => stubResult({
      email_consequence: 'The enquiry went cold overnight.',
      email_wider_consequence: '',
    }));
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {});
    assert.strictEqual(result.email_consequence, 'That means the enquiry went cold overnight.', 'the prefix is added when the model omits it');
    ok('a consequence written without the "That means" opener is normalised, so the locked email beat holds whatever the model writes');
  }

  // ── An address we never established is left out rather than shown ──
  {
    assert.strictEqual(
      buildOpeningLine({ probe_timestamp: '2026-08-11T21:21:04Z', property_address: 'UNKNOWN — auto-ack does not name a property' }),
      'We sent your team an enquiry on 11 August.',
      'an unresolved address is omitted, never printed at the prospect'
    );
    assert.strictEqual(
      buildOpeningLine({ probe_timestamp: '2026-08-11T21:21:04Z', property_address: 'Bounderby Grove' }),
      'We sent your team an enquiry on 11 August about Bounderby Grove.'
    );
    assert.strictEqual(
      buildOpeningLine({ probe_timestamp: '', property_address: 'Bounderby Grove' }),
      'We sent your team an enquiry about Bounderby Grove.',
      'an unparseable timestamp drops the date rather than printing a broken one'
    );
    // Europe/London, so a 22:34 UK probe keeps the date the agency would recognise.
    assert.strictEqual(formatEnquiryDate('2026-08-17T22:34:41Z'), '17 August');
    assert.strictEqual(formatEnquiryDate('not-a-date'), '');
    ok('the opening line degrades gracefully when the address or the timestamp is not established, and dates read in Europe/London');
  }

  // ── An analyst's bracketed note on the address never reaches the prospect ──
  // All three of these are verbatim live PROBES.property_address values.
  {
    assert.strictEqual(cleanAddressForEmail("Fox Cottage (relationship to 'Church Road' UNCONFIRMED)"), 'Fox Cottage');
    assert.strictEqual(cleanAddressForEmail('Rayleigh Road (exact property not evidenced)'), 'Rayleigh Road');
    assert.strictEqual(
      cleanAddressForEmail('Whitmore Way, Basildon, SS14 (2 bed terraced, £285,000)'),
      'Whitmore Way, Basildon, SS14',
      'and the stray price inside the note goes with it'
    );
    assert.strictEqual(cleanAddressForEmail('Apt 16, Southwood Court, Southend Road, Billericay'), 'Apt 16, Southwood Court, Southend Road, Billericay', 'an ordinary address is untouched');
    assert.strictEqual(
      buildOpeningLine({ probe_timestamp: '2026-08-11T21:21:04Z', property_address: 'Whitmore Way, Basildon, SS14 (2 bed terraced, £285,000)' }),
      'We sent your team an enquiry on 11 August about Whitmore Way, Basildon, SS14.'
    );
    ok('an analyst\'s bracketed note on the property address — including a stray price inside it — is dropped from the email line, while an ordinary address is untouched');
  }

  // buildEmailBody as a unit — every optional beat absent.
  {
    const body = buildEmailBody({ probe_timestamp: '2026-08-11T21:21:04Z', property_address: 'Bounderby Grove' }, {
      fair_observation: '', email_main_point: 'Main point.', email_consequence: 'That means x.',
      email_wider_consequence: '', has_other_things: false,
    });
    assert.strictEqual(body, [
      'Hi {{first_name}},',
      'We sent your team an enquiry on 11 August about Bounderby Grove.',
      'Main point.',
      'That means x.',
      "I've put together the full breakdown of what we found. Happy to send it over if you want to take a look.",
    ].join('\n\n'));
    ok('buildEmailBody with every optional beat absent produces exactly the five mandatory paragraphs');
  }

  // ── hero_journey is a deterministic lookup, never asked of the model ──
  {
    const F = baseFindings();
    assert.strictEqual(pickHeroJourney(baseIntelligence({ human_contact: 'none' }), F, baseDiagnosis()), 'complete_miss');
    assert.strictEqual(pickHeroJourney(baseIntelligence({ human_contact: 'automated_only' }), F, baseDiagnosis()), 'automated_ack_only');
    assert.strictEqual(
      pickHeroJourney(baseIntelligence(), [], baseDiagnosis({ novus_opportunity: 'Growth (valuation list / seller conversion)' })),
      'strong_handling_database_opportunity'
    );
    assert.strictEqual(
      pickHeroJourney(baseIntelligence(), [], baseDiagnosis({ novus_opportunity: 'None evidenced' })),
      'strong_handling_no_opportunity'
    );
    assert.strictEqual(pickHeroJourney(baseIntelligence({ response_hours: 17.85 }), F, baseDiagnosis()), 'slow_response_gap');
    assert.strictEqual(
      pickHeroJourney(baseIntelligence({ response_hours: 2, seller_recognition: 'asked_position', viewing_progression: 'booked' }), F, baseDiagnosis()),
      'weak_seller_qualification'
    );
    assert.strictEqual(
      pickHeroJourney(baseIntelligence({ response_hours: 2, seller_recognition: '', follow_ups: 0 }), F, baseDiagnosis()),
      'fast_response_stalled_follow_up'
    );
    ok('hero_journey is derived deterministically from Intelligence/findings shape for every branch, with no AI call involved');
  }

  // ── hero_journey response-speed regression: aligned to lib/grading.mjs's
  // own ">1h and <=16h = Fast, >16h = Slow" boundary (Source Master §10),
  // not a second, independently-chosen threshold. Every case below has a
  // non-empty findings list (a real Diagnosis finding), since the speed band
  // only matters once "handled well" has already been ruled out. ──
  {
    const F = baseFindings();
    assert.strictEqual(
      pickHeroJourney(baseIntelligence({ response_hours: 1.581944444, seller_recognition: '', follow_ups: 2 }), F, baseDiagnosis()),
      'fast_response_stalled_follow_up',
      '1.58h (prb_hist_0018 shape) is Fast, not a response-speed gap'
    );
    assert.strictEqual(
      pickHeroJourney(baseIntelligence({ response_hours: 6, seller_recognition: '', follow_ups: 1 }), F, baseDiagnosis()),
      'fast_response_stalled_follow_up',
      '6h is Fast under the real >1h/<=16h boundary — the old <=6h cutoff is gone, not just relocated'
    );
    assert.strictEqual(
      pickHeroJourney(baseIntelligence({ response_hours: 11.96805556, seller_recognition: '', follow_ups: 1 }), F, baseDiagnosis()),
      'fast_response_stalled_follow_up',
      '11.97h (prb_hist_0014 shape) is Fast'
    );
    assert.strictEqual(
      pickHeroJourney(baseIntelligence({ response_hours: 11.45194444, seller_recognition: 'asked_position', viewing_progression: 'availability_requested', follow_ups: 1 }), F, baseDiagnosis()),
      'weak_seller_qualification',
      '11.45h (prb_hist_0012 shape) is Fast AND the seller thread stalled'
    );
    assert.strictEqual(
      pickHeroJourney(baseIntelligence({ response_hours: 16, seller_recognition: '', follow_ups: 1 }), F, baseDiagnosis()),
      'fast_response_stalled_follow_up',
      'exactly 16h is still Fast (inclusive boundary, matches grade B/D)'
    );
    assert.strictEqual(
      pickHeroJourney(baseIntelligence({ response_hours: 16.01, seller_recognition: '', follow_ups: 1 }), F, baseDiagnosis()),
      'slow_response_gap',
      'just past 16h is Slow (matches grade E/F)'
    );
    assert.strictEqual(
      pickHeroJourney(baseIntelligence({ human_contact: 'none', response_hours: '' }), F, baseDiagnosis()),
      'complete_miss',
      'no response is complete_miss regardless of speed banding'
    );
    assert.strictEqual(
      pickHeroJourney(baseIntelligence({ response_hours: 3, seller_recognition: '', viewing_progression: 'invited', buyer_qualification: 'none', follow_ups: 1 }), F, baseDiagnosis()),
      'fast_response_stalled_follow_up',
      'fast response with no buyer qualification is fast-but-shallow, not a response-speed gap'
    );
    assert.strictEqual(
      pickHeroJourney(baseIntelligence({ response_hours: 0.53 }), [], baseDiagnosis({ novus_opportunity: 'None evidenced' })),
      'strong_handling_no_opportunity',
      'an empty findings list short-circuits before response-speed banding, even at a fast response time'
    );
    ok('hero_journey response-speed banding matches lib/grading.mjs\'s own >1h/<=16h Fast boundary exactly, including at both edges of 16h, and never mislabels a fast probe as a response-speed gap');
  }

  console.log(`\n${passed} checks passed.`);
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
