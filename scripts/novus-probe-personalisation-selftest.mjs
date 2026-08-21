// scripts/novus-probe-personalisation-selftest.mjs — hermetic test (no
// network, no creds) for lib/probe-personalisation.mjs: the ONE AI call that
// turns a probe's settled INTELLIGENCE + DIAGNOSIS + DIAGNOSIS_FINDINGS into
// the story, and into the sentence-ready copy lib/email-assembly.mjs builds
// the outreach email from.
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
//     left over, and that line never reveals what the finding was
//   - a quote that isn't a literal substring of the cited communication is
//     dropped, exactly like lib/probe-interpretation.mjs's guard
//   - the ONLY currency figure that survives anywhere is this probe's own
//     property value; an invented fee/annual-cost figure is stripped
//   - fair observation: never praise Diagnosis recorded no strengths for, and
//     never detached third-person commentary about the agency
//   - a strong-handling probe (no findings) is never turned into a
//     manufactured weakness
//   - the no-response case switches the email to its own structure, with no
//     fair observation and no main finding invented for a conversation that
//     never happened
//   - commercial_consequence never repeats the assembler's own "That meant"
//   - wider_consequence is optional, and a restatement of the primary
//     consequence is dropped rather than printed twice
//   - every email field is sentence-ready, and email_body is exactly the
//     deterministic assembly of the fields beside it
//   - no email field ever carries our internal reasoning about the analysis
//   - hero_journey is a deterministic lookup, never asked of the model
//
// Run: npm run novus:probe-personalisation-selftest

import assert from 'node:assert';
import {
  personaliseProbe, pickHeroJourney, stripUnbackedCurrency,
  normalizeCurrencyFigure, formatEnquiryDate, cleanAddressForEmail,
  stripThatMeantPrefix, readsAsInternalReasoning, readsAsDetachedThirdPerson,
  distinctWiderConsequence, emailPropertyAddress, readsAsSnuckCriticism,
  consequenceGoesBeyondFinding,
} from '../lib/probe-personalisation.mjs';
import {
  ADDITIONAL_FINDINGS_HOOK_LINE, CTA_LINE, NO_REPLY_LINE, THAT_MEANT_PREFIX,
  THAT_ALSO_MEANT_PREFIX, FAIR_OBSERVATION_PREFIX, MAIN_FINDING_PREFIX, assembleEmail,
} from '../lib/email-assembly.mjs';
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
    fair_observation: 'You picked this up on two channels inside 81 seconds of each other and asked good questions.',
    novus_counterfactual: 'At 22:34, NOVUS would have replied in the same 81 seconds your team used — eleven hours earlier — and offered the valuation in the same breath.',
    main_finding: 'Nothing reached us for about 18 hours, and when it did, the property I mentioned selling never came up again.',
    commercial_consequence: 'the £375,000 enquiry went cold overnight and the valuation behind it was never offered.',
    wider_observation: '',
    wider_consequence: '',
    // additional_findings_hook is deliberately absent: the model is no longer
    // asked for it at all — see the dedicated test proving that even if a
    // caller injects one anyway, it is ignored.
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

  // ── Several findings combine into ONE primary narrative; the leftover
  //    becomes the supporting finding, and only then does the email's
  //    secondary hook show its one fixed intrigue line ──
  {
    __setAiCallerForTests(async () => stubResult());
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {});
    assert.strictEqual(result.narrative_finding_indexes, '1,2', 'the narrative records which findings it combined');
    assert.ok(result.supporting_findings.includes('no follow-up'), 'the finding left out of the narrative survives as a supporting finding');
    assert.strictEqual(result.additional_findings_hook, ADDITIONAL_FINDINGS_HOOK_LINE,
      'the fixed tease line appears because a genuine finding is actually left over');
    assert.ok(!/follow-up/i.test(result.additional_findings_hook),
      'and it teases without revealing what the leftover finding was — that is the question the email exists to provoke');
    ok('multiple findings combine into one primary narrative, the leftover finding becomes a supporting finding, and the email\'s fixed additional-findings tease follows from that without giving the finding away');
  }

  // ── Nothing left over -> no supporting findings, and the secondary hook
  //    stays blank — never populated with nothing behind it ──
  {
    __setAiCallerForTests(async () => stubResult({
      narrative_finding_indexes: [1, 2, 3],
      supporting_findings: 'There were several other issues worth mentioning.', // model padding
    }));
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {});
    assert.strictEqual(result.supporting_findings, '', 'no finding is left over, so supporting_findings is forced empty');
    assert.strictEqual(result.additional_findings_hook, '', 'and the additional-findings hook stays blank alongside it');
    assert.ok(!result.email_body.includes(ADDITIONAL_FINDINGS_HOOK_LINE), 'so that paragraph never appears in the email');
    ok('when the narrative already covers every finding, both the padded supporting_findings and the additional-findings hook are empty, and the email simply omits that paragraph');
  }

  // ── additional_findings_hook is NEVER free text: even if the model returns
  //    one anyway, it is ignored — only the fixed line or blank can appear ──
  {
    __setAiCallerForTests(async () => ({
      ...stubResult(),
      additional_findings_hook: 'A detailed paragraph explaining the second finding and why it matters commercially.',
    }));
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {});
    assert.strictEqual(result.additional_findings_hook, ADDITIONAL_FINDINGS_HOOK_LINE,
      'a model-written hook is discarded entirely in favour of the fixed tease line');
    assert.ok(!result.additional_findings_hook.includes('detailed paragraph'), 'model-authored analysis never reaches this field');
    ok('additional_findings_hook is deterministic — a genuine finding outside the narrative always yields exactly the fixed tease line, never AI-written analysis, however the model responds');
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
      primary_narrative: 'The £375,000 Chevington enquiry waited overnight. That is roughly £11,250 in fees at 3%.',
      commercial_consequence: 'That meant you likely lost around £9,000 of commission on this one enquiry.',
    }));
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {});
    assert.ok(result.primary_narrative.includes('£375,000'), 'the probe\'s own property value survives');
    assert.ok(!result.primary_narrative.includes('11,250'), 'the invented fee assumption is stripped');
    assert.strictEqual(result.commercial_consequence, '', 'an invented commission figure takes the whole sentence with it');
    const emailVars = [result.fair_observation, result.main_finding, result.commercial_consequence, result.wider_consequence].join(' ');
    assert.ok(!/£9,000|£11,250/.test(emailVars), 'no invented figure reaches any email field');
    assert.strictEqual(result.email_body, '', 'and with no commercial consequence left, no email is assembled at all — a human decides');
    ok('the probe\'s own property value is the only currency figure that survives; invented fee and commission figures are stripped everywhere, and a row left without its consequence assembles no email');
  }

  // ── No property value on file -> no currency figure may appear at all ──
  {
    __setAiCallerForTests(async () => stubResult({
      primary_narrative: 'A £375,000 instruction was left on the table. The seller lead was simply dropped.',
    }));
    const priceless = { ...PROBE, property_price: '' };
    const result = await personaliseProbe(priceless, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {});
    assert.ok(!/£/.test(result.primary_narrative), 'with no property value on file, no currency figure survives');
    assert.ok(result.primary_narrative.includes('seller lead was simply dropped'), 'the qualitative sentence alongside it is kept');
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
    ok('a fair observation the Diagnosis records no strengths for is never printed — the mirror of never manufacturing a weakness');
  }

  // ── VOICE: the email is written TO the agency, by the person who sent the
  //    enquiry. Detached commentary about them is the tell that gives the
  //    whole thing away, so it is dropped rather than sent. ──
  {
    for (const detached of [
      "They didn't let this one go cold.",
      'The team came back quickly and chased twice.',
      'Their team used two channels inside 81 seconds.',
    ]) {
      __setAiCallerForTests(async () => stubResult({ fair_observation: detached }));
      const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {});
      assert.strictEqual(result.fair_observation, '', `detached third person "${detached}" never reaches the email`);
      assert.ok(!result.email_body.includes(detached), 'and never reaches the assembled body either');
    }
    // The same observation written to them survives — as the lower-case
    // continuation the assembler prints after "I want to say upfront that ".
    __setAiCallerForTests(async () => stubResult({ fair_observation: "You didn't let this one go cold — you came back twice." }));
    const kept = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {});
    assert.strictEqual(kept.fair_observation, "you didn't let this one go cold — you came back twice.", 'the second-person version survives, de-capitalised to continue the fixed opener');
    assert.ok(kept.email_body.includes("I want to say upfront that you didn't let this one go cold"), 'and reads as one sentence after the assembler\'s fixed opener');
    ok('a fair observation written as detached commentary about the agency is dropped, while the same point addressed to them as "you" survives as a continuation of the fixed opener');
  }

  // readsAsDetachedThirdPerson as a unit — and that it does not eat copy that
  // legitimately says "they" about someone other than the agency.
  {
    assert.strictEqual(readsAsDetachedThirdPerson("They didn't let this one go cold."), true);
    assert.strictEqual(readsAsDetachedThirdPerson('You replied fast. They then went quiet.'), true);
    assert.strictEqual(readsAsDetachedThirdPerson('The agency replied within the hour.'), true);
    assert.strictEqual(readsAsDetachedThirdPerson('You got back to me quickly and followed up three times.'), false);
    assert.strictEqual(readsAsDetachedThirdPerson('Your team called back within the hour.'), false);
    assert.strictEqual(readsAsDetachedThirdPerson('I mentioned a property of my own that I was thinking of selling.'), false);
    assert.strictEqual(readsAsDetachedThirdPerson(''), false);
    ok('readsAsDetachedThirdPerson catches commentary about the agency without eating copy that simply addresses them as "you"');
  }

  // ── No response at all: the email simply says we never received a reply ──
  {
    __setAiCallerForTests(async () => stubResult({
      fair_observation: 'Your team did their best under the circumstances.',
      main_finding: 'When you finally called back, the questions you asked were the right ones.',
      commercial_consequence: 'a buyer who was ready to view never got as far as a conversation.',
      wider_consequence: 'It also meant the property I said I had of my own was never picked up as a valuation.',
      evidence_quotes: [],
    }));
    const noReplyIntelligence = baseIntelligence({ human_contact: 'none', response_hours: '', contact_attempts: 0, channels_used: '' });
    const noReplyFindings = [
      { finding_index: 1, finding: 'The enquiry was never replied to.', evidence: 'No communications recorded in the 4-day window.', significance_note: 'A buyer and a seller lead both lost in silence.' },
      { finding_index: 2, finding: 'No automated acknowledgement was sent either.', evidence: 'Zero communications of any kind.', significance_note: 'Nothing caught the enquiry at all.' },
    ];
    const result = await personaliseProbe(PROBE, noReplyIntelligence, baseDiagnosis({ strengths: '' }), noReplyFindings, [], {});

    assert.strictEqual(result.email_variant, 'no_response', 'the email switches to its own structure');
    assert.strictEqual(result.fair_observation, '', 'there was no handling to be fair about, so nothing is invented');
    assert.strictEqual(result.main_finding, '', 'and the model\'s invented conversation is discarded outright — the failure is the silence');
    assert.strictEqual(result.additional_findings_hook, '', 'the "couple of other things" tease is not stacked on top of the no-response closing');
    assert.strictEqual(result.hero_journey, 'complete_miss', 'the journey is the complete-miss one');
    assert.strictEqual(result.evidence, '', 'nothing was ever said, so there is no evidence to quote');

    // The email says it plainly, once, and never describes a conversation.
    assert.ok(result.email_body.includes(`\n\n${NO_REPLY_LINE}\n\n`), 'the assembler supplies the plain no-reply line');
    assert.ok(!result.email_body.includes('called back'), 'no invented conversation reaches the email');
    assert.ok(result.email_body.includes('That meant a buyer who was ready to view never got as far as a conversation.'), 'the consequence of the silence still lands');
    assert.ok(result.email_body.includes('never picked up as a valuation'), 'and a seller opportunity our own enquiry declared still carries a wider consequence');
    assert.ok(!result.email_body.includes(CTA_LINE), 'the normal CTA does not appear');
    assert.ok(/Happy to send it over if you'd like to see it\.\n\nJoe$/.test(result.email_body), 'the no-response closing still makes the offer');
    ok('a probe that was never replied to switches to the no-response email structure — no fair observation, no invented conversation, just the silence, its consequence and an offer that makes sense');
  }

  // ── Strong handling (no findings) is never turned into a weakness ──
  {
    __setAiCallerForTests(async () => stubResult({
      primary_narrative: 'You answered Barn Field in under an hour and asked eight qualification questions — the question is whether that happens on every enquiry.',
      narrative_finding_indexes: [],
      supporting_findings: 'There were still a few things that could have gone better.', // model padding
      novus_counterfactual: 'NOVUS would have matched this response exactly, every time, regardless of who is on shift.',
    }));
    const strongDiagnosis = baseDiagnosis({ novus_opportunity: 'Growth (valuation list / seller conversion)' });
    const result = await personaliseProbe(PROBE, baseIntelligence({ response_hours: 0.9, follow_ups: 1 }), strongDiagnosis, [], COMMS, {});
    assert.strictEqual(result.supporting_findings, '', 'no findings means nothing can be a supporting finding');
    assert.strictEqual(result.additional_findings_hook, '', 'and no manufactured additional-findings tease either');
    assert.strictEqual(result.narrative_finding_indexes, '', 'no finding numbers are claimed');
    assert.ok(result.novus_counterfactual.includes('matched'), 'the counterfactual matches strong handling instead of inventing a gap');
    assert.strictEqual(result.hero_journey, 'strong_handling_database_opportunity', 'and the journey is the strong-handling one');
    ok('a probe the evidence shows was handled well produces no manufactured weakness anywhere in the story or the email');
  }

  // ── The email fields are produced as sentence-ready copy — no greeting,
  //    no sign-off, no CTA. lib/email-assembly.mjs owns all of that, and
  //    email_body is exactly its deterministic assembly of these fields. ──
  {
    __setAiCallerForTests(async () => stubResult());
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {});

    assert.ok(!('commercial_story' in result), 'the retired commercial_story field is gone');
    assert.ok(!('email_main_point' in result), 'and so are the retired email_* variable names');
    assert.ok(!('email_consequence' in result));
    assert.ok(!('email_secondary_hook' in result));

    // The sentence-ready fields. The three that follow a fixed opener come
    // back as lower-case continuations of it, whatever case the model used.
    assert.strictEqual(result.enquiry_date, '17 August');
    assert.strictEqual(result.property_address, 'Barn Field, Chevington, IP29');
    assert.strictEqual(result.email_variant, 'normal');
    assert.strictEqual(result.fair_observation, 'you picked this up on two channels inside 81 seconds of each other and asked good questions.');
    assert.strictEqual(result.main_finding, 'nothing reached us for about 18 hours, and when it did, the property I mentioned selling never came up again.');
    assert.strictEqual(result.commercial_consequence, 'the £375,000 enquiry went cold overnight and the valuation behind it was never offered.');
    assert.strictEqual(result.additional_findings_hook, ADDITIONAL_FINDINGS_HOOK_LINE);

    // None of them may carry furniture the assembler already supplies.
    for (const [name, value] of Object.entries({
      fair_observation: result.fair_observation,
      main_finding: result.main_finding,
      commercial_consequence: result.commercial_consequence,
      wider_observation: result.wider_observation,
      wider_consequence: result.wider_consequence,
      additional_findings_hook: result.additional_findings_hook,
    })) {
      assert.ok(!/\{\{|\}\}/.test(value), `${name} carries no merge-field syntax of its own`);
      assert.ok(!/^Hi\b|Joe\s*$|personalised breakdown|happy to send it over/i.test(value), `${name} carries no greeting, sign-off or CTA`);
      assert.ok(!/NOVUS|leakage/i.test(value), `${name} does not mention NOVUS or leakage`);
    }

    // THE GRAMMAR CONTRACT. Four fields are continuations of an opener the
    // assembler owns, so each must start lower case; wider_observation is the
    // one narrative field that stands alone, so it must be capitalised. All of
    // them must be terminated.
    for (const [name, value] of Object.entries({
      fair_observation: result.fair_observation,
      main_finding: result.main_finding,
      commercial_consequence: result.commercial_consequence,
      wider_consequence: result.wider_consequence,
    })) {
      if (!value) continue;
      assert.ok(/^[a-z£"']/.test(value), `${name} is the lower-case continuation its fixed opener needs`);
      assert.ok(/[.!?]$/.test(value), `${name} closes as a sentence`);
    }
    if (result.wider_observation) {
      assert.ok(/^[A-Z"']/.test(result.wider_observation), 'wider_observation is a standalone sentence, so it is capitalised');
      assert.ok(/[.!?]$/.test(result.wider_observation), 'and terminated');
    }

    // And the email is exactly the assembly of those fields, in the locked order.
    assert.strictEqual(result.email_body, assembleEmail(result), 'email_body is the deterministic assembly of the fields beside it');
    assert.strictEqual(result.email_body, [
      'Hi {{first_name}},',
      'We sent your team an enquiry on 17 August about Barn Field, Chevington, IP29.',
      `${FAIR_OBSERVATION_PREFIX}${result.fair_observation}`,
      `${MAIN_FINDING_PREFIX}${result.main_finding}`,
      `${THAT_MEANT_PREFIX}${result.commercial_consequence}`,
      ADDITIONAL_FINDINGS_HOOK_LINE,
      CTA_LINE,
      'Joe',
    ].join('\n\n'), 'and it is exactly the locked structure, in the locked order, with the locked CTA');
    assert.ok(!/audit/i.test(result.email_body), 'the email never calls it an audit');
    ok('every email field is sentence-ready and free of template furniture, and email_body is exactly the deterministic assembly of those fields in the locked order'); 
  }

  // ── commercial_consequence must never repeat the assembler's own
  //    "That meant" — the one piece of grammar the code owns ──
  {
    for (const written of [
      'That meant the enquiry went cold overnight.',
      'That meant, the enquiry went cold overnight.',
      'that meant the enquiry went cold overnight.',
      'That means the enquiry went cold overnight.',
      'The enquiry went cold overnight',
    ]) {
      __setAiCallerForTests(async () => stubResult({ commercial_consequence: written }));
      const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {});
      assert.strictEqual(result.commercial_consequence, 'the enquiry went cold overnight.',
        `"${written}" normalises to the bare continuation`);
      assert.ok(!/^that mean(s|t)/i.test(result.commercial_consequence), 'and never repeats the prefix');
      assert.ok(result.email_body.includes('That meant the enquiry went cold overnight.'), 'so the assembled sentence reads correctly, once');
      assert.ok(!/That meant That mean/i.test(result.email_body), 'never as a stutter');
    }
    ok('commercial_consequence is always the bare continuation the assembler needs — the "That meant"/"That means" prefix is stripped however the model writes it, a missing full stop is added, and the assembled sentence never stutters');
  }

  // stripThatMeantPrefix as a unit, including the cases that must NOT be
  // de-capitalised.
  {
    assert.strictEqual(stripThatMeantPrefix('That meant the lead went cold.'), 'the lead went cold.');
    assert.strictEqual(stripThatMeantPrefix('That means the lead went cold.'), 'the lead went cold.');
    assert.strictEqual(stripThatMeantPrefix('That meant NOVUS would have replied.'), 'NOVUS would have replied.');
    assert.strictEqual(stripThatMeantPrefix('the lead went cold'), 'the lead went cold.');
    assert.strictEqual(stripThatMeantPrefix('That meant'), '');
    assert.strictEqual(stripThatMeantPrefix(''), '');
    // A bare "A" is all-capitals by every naive test, but it is the article,
    // not an acronym — "That meant A potential seller instruction..." is the
    // failure this guards.
    assert.strictEqual(stripThatMeantPrefix('That meant A potential seller instruction was never explored.'),
      'a potential seller instruction was never explored.');
    assert.strictEqual(stripThatMeantPrefix("That meant I'd told you something you never picked up."),
      "I'd told you something you never picked up.", 'the pronoun "I" is never lower-cased');
    assert.strictEqual(stripThatMeantPrefix('That meant EPC questions went unasked.'), 'EPC questions went unasked.');
    ok('stripThatMeantPrefix removes the prefix in either tense, restores lower case without mangling an acronym, and guarantees terminal punctuation');
  }

  // ── wider_consequence: optional, and only when genuinely a SECOND
  //    consequence rather than the first one reworded ──
  {
    __setAiCallerForTests(async () => stubResult({
      commercial_consequence: 'the enquiry was getting attention but was not really being progressed.',
      wider_consequence: 'it also meant a potential seller instruction sitting inside the same enquiry was never explored',
    }));
    const distinct = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {});
    assert.strictEqual(distinct.wider_consequence, 'a potential seller instruction sitting inside the same enquiry was never explored.',
      'a genuinely distinct second consequence is kept, as the continuation of the assembler\'s "That also meant "');
    assert.ok(distinct.email_body.includes('\n\nThat also meant a potential seller instruction sitting inside the same enquiry was never explored.'),
      'and it gets its own paragraph, opened by the fixed wording the assembler owns');
    assert.ok(!/That also meant [Ii]t also meant/.test(distinct.email_body), 'the prefix is never printed twice');

    // The realistic failure: an optional field filled with the same point again.
    __setAiCallerForTests(async () => stubResult({
      commercial_consequence: 'the enquiry was getting attention but was not really being progressed.',
      wider_consequence: 'The enquiry was getting attention but was not really being progressed.',
    }));
    const echoed = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {});
    assert.strictEqual(echoed.wider_consequence, '', 'a restatement of the primary consequence is dropped, not printed twice');
    assert.strictEqual((echoed.email_body.match(/was not really being progressed/g) || []).length, 1,
      'so the same point appears exactly once in the email');

    // Genuinely absent stays absent — the field is never forced.
    __setAiCallerForTests(async () => stubResult({ wider_consequence: '' }));
    const absent = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {});
    assert.strictEqual(absent.wider_consequence, '', 'an empty wider consequence stays empty');
    ok('wider_consequence is kept only when it is a genuinely distinct second consequence, as the lower-case continuation of the fixed "That also meant " — a reworded restatement or an empty value simply drops that paragraph');
  }

  // distinctWiderConsequence as a unit.
  {
    assert.strictEqual(distinctWiderConsequence('it also meant the valuation was never offered', 'the viewing never happened.'),
      'the valuation was never offered.');
    assert.strictEqual(distinctWiderConsequence('That also meant the valuation was never offered.', 'the viewing never happened.'),
      'the valuation was never offered.', 'the fixed prefix is stripped in either wording');
    assert.strictEqual(distinctWiderConsequence('The viewing never happened.', 'the viewing never happened.'), '');
    assert.strictEqual(distinctWiderConsequence('The viewing never happened, and nor did anything else.', 'the viewing never happened.'), '',
      'a value that merely wraps the primary consequence is still a restatement');
    assert.strictEqual(distinctWiderConsequence('', 'the viewing never happened.'), '');
    ok('distinctWiderConsequence keeps a real second consequence as the continuation "That also meant " needs, and drops a restatement of the first');
  }

  // ── THE FAIR OBSERVATION MUST BE GENUINELY FAIR ──────────────────────────
  //    Paragraph 1's only job is to disarm. A hedge word smuggles the
  //    criticism forward into it, and "I want to say upfront that you
  //    eventually got back to me" is not a compliment — so the paragraph is
  //    dropped rather than sent hedged.
  {
    for (const hedged of [
      'you eventually came back to me.',
      'you replied quickly, although the reply said very little.',
      'you followed up despite the delay.',
      'you got back to me the same day, however briefly.',
    ]) {
      __setAiCallerForTests(async () => stubResult({ fair_observation: hedged }));
      const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {});
      assert.strictEqual(result.fair_observation, '', `hedged praise "${hedged}" is not printed`);
      assert.ok(!result.email_body.includes(FAIR_OBSERVATION_PREFIX), 'and its fixed opener does not appear with nothing behind it');
    }
    assert.strictEqual(readsAsSnuckCriticism('you came back inside the hour and referenced the property correctly.'), false,
      'genuine, unhedged praise is untouched');
    assert.strictEqual(readsAsSnuckCriticism(''), false);
    ok('a fair observation that sneaks criticism in with eventually/although/despite/however is dropped rather than sent — paragraph 1 is either genuinely fair or absent');
  }

  // ── "That meant ..." MUST BE A CONSEQUENCE, NOT THE FINDING AGAIN ────────
  //    The single rule at the centre of this layer: reveal what the agency
  //    failed to find out, progress, convert or uncover. A consequence that
  //    is the finding reworded answers nothing, so it is refused — and a row
  //    without a consequence assembles no email at all, which is the signal
  //    for a human to look.
  {
    const finding = 'that nobody asked me a single question about my position.';
    for (const restatement of [
      'nobody asked me a single question about my position.',
      'That meant nobody asked me a single question about my position.',
      'nobody asked me a single question about my position, at any point in the conversation.',
    ]) {
      __setAiCallerForTests(async () => stubResult({ main_finding: finding, commercial_consequence: restatement }));
      const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {});
      assert.strictEqual(result.commercial_consequence, '', `"${restatement}" is a restatement of the finding, not a consequence`);
      assert.strictEqual(result.email_body, '', 'so no email is assembled — a human needs to look at this probe');
    }

    // A real consequence — what was not captured or progressed — survives.
    __setAiCallerForTests(async () => stubResult({
      main_finding: finding,
      commercial_consequence: 'a viewing slot was committed before anyone knew whether the buyer could proceed, and the valuation sitting inside the same enquiry was never reached.',
    }));
    const kept = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {});
    assert.ok(kept.commercial_consequence.startsWith('a viewing slot was committed'), 'a genuine consequence is kept');
    assert.ok(kept.email_body.includes('That meant a viewing slot was committed'), 'and reads correctly after the fixed prefix');

    // The unit, including the cases that must NOT trip: a consequence that
    // merely reuses the finding's vocabulary is normal and correct.
    assert.strictEqual(consequenceGoesBeyondFinding('the enquiry went cold.', 'that the enquiry went cold.'), false);
    assert.strictEqual(consequenceGoesBeyondFinding('the enquiry went cold overnight and the valuation was never offered.', 'that the enquiry went cold.'), false,
      'a consequence that wholly contains the finding is still a restatement');
    assert.strictEqual(consequenceGoesBeyondFinding('you never found out whether I could proceed on the enquiry.', 'that nobody asked about my position.'), true,
      'sharing vocabulary is not restating');
    assert.strictEqual(consequenceGoesBeyondFinding('', 'that the enquiry went cold.'), false, 'an empty consequence never passes');
    ok('a commercial consequence that only rephrases the finding is refused — the email says what the failure cost, or it is not sent at all');
  }

  // ── Our internal reasoning must never be merged into a real email ──
  {
    // The realistic failure: asked for a fair observation when there is
    // nothing fair to say, the model explains ITSELF instead of returning ''.
    for (const leak of [
      'There is no strength to point to here.',
      'The evidence does not support a fair observation.',
      'No findings were recorded for this probe.',
      'N/A',
    ]) {
      __setAiCallerForTests(async () => stubResult({ fair_observation: leak, main_finding: leak }));
      const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {});
      assert.strictEqual(result.fair_observation, '', `internal reasoning "${leak}" never reaches fair_observation`);
      assert.strictEqual(result.main_finding, '', `nor main_finding`);
      assert.strictEqual(result.email_body, '', 'and with no main finding left, no email is assembled — a human decides');
    }
    ok('an email field that reads as our own reasoning about the analysis is blanked rather than sent, and a row left without its main finding assembles no email at all');
  }

  // readsAsInternalReasoning as a unit — and, just as important, that it does
  // not eat legitimate copy.
  {
    assert.strictEqual(readsAsInternalReasoning('There is no strength to point to here.'), true);
    assert.strictEqual(readsAsInternalReasoning('The diagnosis shows a speed problem.'), true);
    assert.strictEqual(readsAsInternalReasoning('Not applicable'), true);
    assert.strictEqual(readsAsInternalReasoning('Your team called back within the hour and asked good questions.'), false);
    assert.strictEqual(readsAsInternalReasoning('Nothing reached us for about 18 hours.'), false);
    assert.strictEqual(readsAsInternalReasoning('We never received a reply.'), false);
    assert.strictEqual(readsAsInternalReasoning(''), false);
    // REGRESSION (real 3-probe test run): an earlier version matched a broad
    // "there is/are no ..." pattern intended to catch "there is no strength
    // to point to here", and it also caught ordinary honest descriptions of
    // an absence — exactly the sentences main_finding and
    // commercial_consequence are SUPPOSED to contain — silently blanking
    // both fields (and, downstream, email_body) on real probes that never
    // touched a diagnosis label or an internal-reasoning phrase at all.
    for (const legitimate of [
      'There is no question asked about your budget or timescale.',
      'There is no qualifying question asked before inviting you to view.',
      'There is nothing in the reply that moves the enquiry forward.',
      'What stood out was that there is no clear next step given to us at any point.',
    ]) {
      assert.strictEqual(readsAsInternalReasoning(legitimate), false, `"${legitimate}" is honest prospect-facing copy, not internal reasoning`);
    }
    ok('readsAsInternalReasoning catches notes-to-ourselves without eating legitimate prospect-facing copy, including ordinary "there is no ..." sentences describing a genuine absence');
  }

  // ── REGRESSION: a main_finding that describes a genuine absence in plain
  //    "there is no ..." language survives all the way to a sendable email ──
  {
    __setAiCallerForTests(async () => stubResult({
      main_finding: 'There is no qualifying question asked before inviting you to view.',
      commercial_consequence: 'there is no way of knowing whether the viewing slot went to someone who could actually buy.',
    }));
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {});
    assert.ok(result.main_finding, 'main_finding is populated, not blanked by the absence phrasing');
    assert.ok(result.commercial_consequence, 'commercial_consequence is populated too');
    assert.ok(result.email_body, 'and a real email is assembled from them');
    assert.ok(result.email_body.includes('What stood out, though, was there is no qualifying question'), 'the actual sentence reaches the email, after the fixed opener');
    ok('a main_finding/commercial_consequence phrased as an honest "there is no ..." absence is never blanked, and still produces a sendable email');
  }

  // ── The optional beats really are optional (blank, not absent) ──
  {
    __setAiCallerForTests(async () => stubResult({
      narrative_finding_indexes: [1, 2, 3],
      fair_observation: '',
      wider_consequence: '',
    }));
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis({ strengths: '' }), baseFindings(), COMMS, {});
    assert.strictEqual(result.fair_observation, '', 'an unsupported fair observation is blank');
    assert.strictEqual(result.wider_consequence, '', 'an absent wider consequence is blank');
    assert.strictEqual(result.additional_findings_hook, '', 'with every finding covered by the narrative, the hook stays blank');
    // The mandatory beats are still there.
    assert.ok(result.main_finding, 'the main finding is still populated');
    assert.ok(result.commercial_consequence, 'the consequence is still populated');
    // And the email simply omits the optional paragraphs — no blank gaps.
    assert.strictEqual(result.email_body, [
      'Hi {{first_name}},',
      'We sent your team an enquiry on 17 August about Barn Field, Chevington, IP29.',
      `${MAIN_FINDING_PREFIX}${result.main_finding}`,
      `${THAT_MEANT_PREFIX}${result.commercial_consequence}`,
      CTA_LINE,
      'Joe',
    ].join('\n\n'), 'the optional paragraphs are omitted entirely, not left as blank gaps');
    ok('the optional email fields come back blank and the assembler simply drops those paragraphs, while the mandatory ones stay populated');
  }

  // ── The property address the template merges is prospect-safe ──
  // All of these are verbatim live PROBES.property_address values.
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
      emailPropertyAddress({ property_address: 'Whitmore Way, Basildon, SS14 (2 bed terraced, £285,000)' }),
      'Whitmore Way, Basildon, SS14',
      "the analyst's bracketed note never reaches the merge field"
    );
    // The template has no way to drop the "about ..." clause, so an address we
    // never established comes back EMPTY — a human decides whether to send.
    assert.strictEqual(
      emailPropertyAddress({ property_address: 'UNKNOWN — auto-ack does not name a property' }), '',
      'an unresolved address is blank, never "UNKNOWN — ..." at the prospect'
    );
    assert.strictEqual(emailPropertyAddress({ property_address: '' }), '');

    // ...and a probe with no established address assembles no email at all,
    // rather than one that says "about ." — a blank email_body is the signal.
    __setAiCallerForTests(async () => stubResult());
    const unaddressed = await personaliseProbe(
      { ...PROBE, property_address: 'UNKNOWN — auto-ack does not name a property' },
      baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {},
    );
    assert.strictEqual(unaddressed.property_address, '');
    assert.strictEqual(unaddressed.email_body, '', 'no address means no assembled email');

    // Europe/London, so a 22:34 UK probe keeps the date the agency would recognise.
    assert.strictEqual(formatEnquiryDate('2026-08-17T22:34:41Z'), '17 August');
    assert.strictEqual(formatEnquiryDate('not-a-date'), '');
    ok('the property_address merge field is cleaned of analyst notes and blank when unresolved, and enquiry_date reads in Europe/London');
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
