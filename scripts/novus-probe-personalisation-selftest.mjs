// scripts/novus-probe-personalisation-selftest.mjs — hermetic test (no
// network, no creds) for lib/probe-personalisation.mjs: the ONE AI call that
// turns a probe's settled INTELLIGENCE + DIAGNOSIS + DIAGNOSIS_FINDINGS into
// the story, and into the variables the fixed Instantly email template
// merges in. This layer does NOT assemble an email — see the module header.
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
//   - email_consequence never repeats the template's own "That means"
//   - no email variable ever carries our internal reasoning about the
//     analysis, and no email body is produced at all
//   - hero_journey is a deterministic lookup, never asked of the model
//
// Run: npm run novus:probe-personalisation-selftest

import assert from 'node:assert';
import {
  personaliseProbe, pickHeroJourney, stripUnbackedCurrency,
  normalizeCurrencyFigure, formatEnquiryDate, cleanAddressForEmail,
  stripThatMeansPrefix, readsAsInternalReasoning, emailPropertyAddress,
  _internal,
} from '../lib/probe-personalisation.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';

const { SECONDARY_HOOK_LINE } = _internal;

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
    email_consequence: 'the enquiry went cold overnight and the valuation was never offered.',
    // email_secondary_hook is deliberately absent: the model is no longer
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
    assert.strictEqual(result.email_secondary_hook, SECONDARY_HOOK_LINE,
      'the fixed intrigue line appears because a genuine finding is actually left over');
    ok('multiple findings combine into one primary narrative, the leftover finding becomes a supporting finding, and the email secondary hook\'s fixed intrigue line follows from that');
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
    assert.strictEqual(result.email_secondary_hook, '', 'and the secondary hook stays blank alongside it');
    ok('when the narrative already covers every finding, both the padded supporting_findings and the secondary hook are empty');
  }

  // ── email_secondary_hook is NEVER free text: even if the model returns one
  //    anyway, it is ignored — only the fixed line or blank can appear ──
  {
    __setAiCallerForTests(async () => ({
      ...stubResult(),
      email_secondary_hook: 'A detailed paragraph explaining the second finding and why it matters commercially.',
    }));
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {});
    assert.strictEqual(result.email_secondary_hook, SECONDARY_HOOK_LINE,
      'a model-written secondary hook is discarded entirely in favour of the fixed intrigue line');
    assert.ok(!result.email_secondary_hook.includes('detailed paragraph'), 'model-authored analysis never reaches this field');
    ok('email_secondary_hook is deterministic — a genuine finding outside the narrative always yields exactly the fixed intrigue line, never AI-written analysis, however the model responds');
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
    const emailVars = [result.fair_observation, result.email_main_point, result.email_consequence, result.email_secondary_hook].join(' ');
    assert.ok(!/£9,000|£11,250/.test(emailVars), 'no invented figure reaches any email variable');
    ok('the probe\'s own property value is the only currency figure that survives; invented fee and commission figures are stripped everywhere, including from every email variable');
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
    ok('a fair observation the Diagnosis records no strengths for is never printed — the mirror of never manufacturing a weakness');
  }

  // ── No response at all: the email simply says we never received a reply ──
  {
    __setAiCallerForTests(async () => stubResult({
      fair_observation: 'Your team did their best under the circumstances.',
      evidence_quotes: [],
    }));
    const noReplyIntelligence = baseIntelligence({ human_contact: 'none', response_hours: '', contact_attempts: 0, channels_used: '' });
    const noReplyFindings = [{ finding_index: 1, finding: 'The enquiry was never replied to.', evidence: 'No communications recorded in the 4-day window.', significance_note: 'A buyer and a seller lead both lost in silence.' }];
    const result = await personaliseProbe(PROBE, noReplyIntelligence, baseDiagnosis({ strengths: '' }), noReplyFindings, [], {});
    assert.strictEqual(result.fair_observation, 'We never received a reply.', 'the no-response case states it plainly, overriding whatever the model wrote');
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
    }));
    const strongDiagnosis = baseDiagnosis({ novus_opportunity: 'Growth (valuation list / seller conversion)' });
    const result = await personaliseProbe(PROBE, baseIntelligence({ response_hours: 0.9, follow_ups: 1 }), strongDiagnosis, [], COMMS, {});
    assert.strictEqual(result.supporting_findings, '', 'no findings means nothing can be a supporting finding');
    assert.strictEqual(result.email_secondary_hook, '', 'and no manufactured secondary hook either');
    assert.strictEqual(result.narrative_finding_indexes, '', 'no finding numbers are claimed');
    assert.ok(result.novus_counterfactual.includes('matched'), 'the counterfactual matches strong handling instead of inventing a gap');
    assert.strictEqual(result.hero_journey, 'strong_handling_database_opportunity', 'and the journey is the strong-handling one');
    ok('a probe the evidence shows was handled well produces no manufactured weakness anywhere in the story or the email');
  }

  // ── The email variables are produced discretely — no body, no template
  //    text, no greeting, no sign-off. Instantly owns all of that. ──
  {
    __setAiCallerForTests(async () => stubResult());
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {});

    assert.ok(!('email_body' in result), 'no email body is produced at all');
    assert.ok(!('email_wider_consequence' in result), 'the retired wider-consequence field is gone');

    // Exactly the six merge variables the fixed template needs.
    assert.strictEqual(result.enquiry_date, '17 August');
    assert.strictEqual(result.property_address, 'Barn Field, Chevington, IP29');
    assert.strictEqual(result.fair_observation, 'Once your team did pick this up, they used two channels inside 81 seconds and asked good questions.');
    assert.strictEqual(result.email_main_point, 'Nothing reached us for about 18 hours, and when it did, the property we mentioned selling never came up again.');
    assert.strictEqual(result.email_consequence, 'the enquiry went cold overnight and the valuation was never offered.');
    assert.strictEqual(result.email_secondary_hook, SECONDARY_HOOK_LINE);

    // None of them may carry template furniture the template already supplies.
    for (const [name, value] of Object.entries({
      fair_observation: result.fair_observation,
      email_main_point: result.email_main_point,
      email_consequence: result.email_consequence,
      email_secondary_hook: result.email_secondary_hook,
    })) {
      assert.ok(!/\{\{|\}\}/.test(value), `${name} carries no merge-field syntax of its own`);
      assert.ok(!/^Hi\b|Joe\s*$|personalised audit/i.test(value), `${name} carries no greeting, sign-off or CTA`);
      assert.ok(!/NOVUS|leakage/i.test(value), `${name} does not mention NOVUS or leakage`);
    }
    ok('the six email merge variables are produced discretely, carry no greeting/sign-off/CTA/merge-field furniture, and no email body exists anywhere in the output');
  }

  // ── email_consequence must never repeat the template's own "That means" ──
  {
    for (const written of [
      'That means the enquiry went cold overnight.',
      'That means, the enquiry went cold overnight.',
      'that means the enquiry went cold overnight.',
      'The enquiry went cold overnight',
    ]) {
      __setAiCallerForTests(async () => stubResult({ email_consequence: written }));
      const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {});
      assert.strictEqual(result.email_consequence, 'the enquiry went cold overnight.',
        `"${written}" normalises to the bare continuation`);
      assert.ok(!/^that means/i.test(result.email_consequence), 'and never repeats the prefix');
    }
    ok('email_consequence is always the bare continuation the template needs — the "That means" prefix is stripped however the model writes it, and a missing full stop is added');
  }

  // stripThatMeansPrefix as a unit, including the cases that must NOT be
  // de-capitalised.
  {
    assert.strictEqual(stripThatMeansPrefix('That means the lead went cold.'), 'the lead went cold.');
    assert.strictEqual(stripThatMeansPrefix('That means NOVUS would have replied.'), 'NOVUS would have replied.');
    assert.strictEqual(stripThatMeansPrefix('the lead went cold'), 'the lead went cold.');
    assert.strictEqual(stripThatMeansPrefix('That means'), '');
    assert.strictEqual(stripThatMeansPrefix(''), '');
    ok('stripThatMeansPrefix removes the prefix, restores lower case without mangling an acronym, and guarantees terminal punctuation');
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
      __setAiCallerForTests(async () => stubResult({ fair_observation: leak, email_main_point: leak }));
      const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS, {});
      assert.strictEqual(result.fair_observation, '', `internal reasoning "${leak}" never reaches fair_observation`);
      assert.strictEqual(result.email_main_point, '', `nor email_main_point`);
    }
    ok('an email variable that reads as our own reasoning about the analysis is blanked rather than merged into a real email');
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
    ok('readsAsInternalReasoning catches notes-to-ourselves without eating legitimate prospect-facing copy');
  }

  // ── The optional beats really are optional (blank, not absent) ──
  {
    __setAiCallerForTests(async () => stubResult({
      narrative_finding_indexes: [1, 2, 3],
      fair_observation: '',
    }));
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis({ strengths: '' }), baseFindings(), COMMS, {});
    assert.strictEqual(result.fair_observation, '', 'an unsupported fair observation is blank');
    assert.strictEqual(result.email_secondary_hook, '', 'with every finding covered by the narrative, the secondary hook stays blank');
    // The mandatory beats are still there.
    assert.ok(result.email_main_point, 'the main point is still populated');
    assert.ok(result.email_consequence, 'the consequence is still populated');
    ok('the optional email variables come back blank (so the template simply renders nothing) while the mandatory ones stay populated');
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
