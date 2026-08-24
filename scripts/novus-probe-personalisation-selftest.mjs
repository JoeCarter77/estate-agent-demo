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
  distinctWiderConsequence, emailPropertyAddress, readsAsSnuckCriticism, stripInventedLoss,
  consequenceGoesBeyondFinding, extractProtectedWords,
  readsAsSpeculativeProspectBehaviour,
} from '../lib/probe-personalisation.mjs';
import {
  ADDITIONAL_FINDINGS_HOOK_LINE, CTA_LINE, NO_REPLY_LINE, THAT_MEANT_PREFIX, emailContractViolations,
  NO_RESPONSE_BREAKDOWN_LINE, NO_RESPONSE_CTA_LINE,
  THAT_ALSO_MEANT_PREFIX, FAIR_OBSERVATION_PREFIX, MAIN_FINDING_PREFIX, assembleEmail,
  withMainFindingPrefix,
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
// exactly the shape lib/diagnosis-findings.mjs reads back out of the tab,
// including finding_type. Problems and opportunities come first (so index 1
// still means "most commercially damaging"), positives after them.
function baseFindings() {
  return [
    { finding_index: 1, finding_type: 'problem', finding: 'Nothing reached the enquiry for 17.8 hours.', evidence: 'Probe 22:34 -> first human contact 16:25 next day = 17.85 hours.', significance_note: 'A response-speed gap that recurs on every out-of-hours enquiry.' },
    { finding_index: 2, finding_type: 'opportunity', finding: 'The declared seller was asked about their position and never offered a valuation.', evidence: 'No valuation, appraisal or valuer mentioned in either message.', significance_note: 'An off-market instruction lead recognised in words and then dropped.' },
    { finding_index: 3, finding_type: 'problem', finding: 'No follow-up was made after the single first contact.', evidence: 'follow_ups = 0 against contact_attempts = 1.', significance_note: 'The viewing was never actually secured.' },
    { finding_index: 4, finding_type: 'positive', finding: 'The enquiry was picked up on two channels within 81 seconds of each other.', evidence: 'A voicemail at 16:25:30 and an email at 16:26:51.', significance_note: 'Shows the front desk moves properly once it engages.' },
  ];
}

function stubResult(overrides = {}) {
  return {
    story_reasoning: '1. Positive: finding 4. 2. Main: finding 1. 3. The enquiry went cold. 4. Wider: finding 2. 5. The valuation was never reached.',
    positive_finding_index: 4,
    main_finding_index: 1,
    wider_finding_index: null,
    primary_narrative: 'The enquiry sat for 17.8 hours, and when contact finally came it opened a seller conversation it never closed.',
    supporting_findings: 'There was also no follow-up after that single first contact.',
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

// The prompt shape this change REPLACED, reconstructed here so the size
// reduction is measured against something concrete rather than asserted. It is
// the pre-change buildPrompt: probe facts + the full INTELLIGENCE block + the
// findings + the full DIAGNOSIS block + the scale fact + every raw message.
function legacyPromptSize(probe, intelligence, diagnosis, findings, communications) {
  const findingsBlock = findings
    .map((f) => `  Finding ${f.finding_index}: ${f.finding}\n     Evidence: ${f.evidence}\n     Why it matters: ${f.significance_note}`)
    .join('\n');
  const commsBlock = communications
    .map((c, i) => `--- Message ${i + 1} | communication_id: ${c.communication_id} | channel: ${c.channel} | occurred_at: ${c.occurred_at} ---\n${[c.subject, c.body_text, c.transcript, c.raw_content].filter(Boolean).join('\n')}`)
    .join('\n\n');
  return [
    '=== THE ENQUIRY (probe facts — these are the facts the email opens with) ===',
    `Property address: ${probe.property_address}`,
    `Property value: ${probe.property_price}`,
    `Enquiry sent: ${probe.probe_timestamp} (17 August)`,
    `What the enquiry said: ${probe.enquiry_text}`,
    '',
    '=== INTELLIGENCE (settled interpretation — do not re-derive) ===',
    `Grade (reference only): ${intelligence.grade} — ${intelligence.grade_reason}`,
    `Response: ${intelligence.human_contact}, ${intelligence.response_hours} hours to first human contact`,
    `Contact attempts: ${intelligence.contact_attempts}, follow-ups after the first: ${intelligence.follow_ups}, channels: ${intelligence.channels_used}`,
    `Viewing progression: ${intelligence.viewing_progression}; buyer qualification: ${intelligence.buyer_qualification} (${intelligence.buyer_questions_asked})`,
    `Seller/vendor recognition: ${intelligence.seller_recognition}`,
    `Communication quality: ${intelligence.communication_quality}`,
    `What they did well: ${intelligence.did_well}`,
    `What they missed: ${intelligence.missed}`,
    '',
    '=== DIAGNOSIS FINDINGS (every genuine, independently evidence-backed finding — this is the complete set; decide which of these combine into the story) ===',
    findingsBlock,
    '',
    '=== DIAGNOSIS (the rest of the settled commercial conclusion — do not re-derive) ===',
    `Strengths: ${diagnosis.strengths}`,
    `Missed opportunities: ${diagnosis.missed_opportunities}`,
    `Commercial implication: ${diagnosis.commercial_implication}`,
    `NOVUS opportunity: ${diagnosis.novus_opportunity}`,
    `Diagnosis summary: ${diagnosis.diagnosis_summary}`,
    '',
    '=== SCALE FACT (the only number about this agency you may cite; draw no arithmetic from it) ===\n42 live listings currently on the market',
    '',
    '=== RAW COMMUNICATIONS (quote from here, verbatim) ===',
    commsBlock,
  ].join('\n').length;
}

async function run() {
  console.log('lib/probe-personalisation.mjs — hermetic selftest\n');

  // ── PHASE 3: THE PERSONALISATION INPUT IS PROBE FACTS + FINDINGS, AND
  //    NOTHING ELSE. Everything the model used to be handed twice — the
  //    INTELLIGENCE interpretation, the DIAGNOSIS prose, every raw message in
  //    full — is gone from the prompt, and what is left is what a correct
  //    email genuinely needs. ──
  {
    let seenPrompt = '';
    __setAiCallerForTests(async ({ prompt }) => { seenPrompt = prompt; return stubResult(); });
    await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), { live_listing_count: 42 });

    // WHAT IS IN: every finding, typed and numbered, with its evidence and
    // its significance note.
    for (const finding of baseFindings()) {
      assert.ok(seenPrompt.includes(finding.finding), `finding ${finding.finding_index} reached the prompt`);
      assert.ok(seenPrompt.includes(finding.evidence), `finding ${finding.finding_index}'s evidence reached the prompt`);
      assert.ok(seenPrompt.includes(finding.significance_note), `finding ${finding.finding_index}'s significance reached the prompt`);
      assert.ok(seenPrompt.includes(`Finding ${finding.finding_index} [${finding.finding_type.toUpperCase()}]`),
        `finding ${finding.finding_index} is labelled with its type, so it can be selected by number and validated by type`);
    }
    // The probe/enquiry facts the email itself is built from.
    assert.ok(seenPrompt.includes('Barn Field, Chevington, IP29'), 'property address reached the prompt');
    assert.ok(seenPrompt.includes('£375,000'), 'property value reached the prompt');
    assert.ok(seenPrompt.includes('17 August'), 'the enquiry date reached the prompt');
    assert.ok(seenPrompt.includes('has a property to sell'), 'the enquiry text reached the prompt');
    // The one code-computed fact about the agency.
    assert.ok(seenPrompt.includes('42 live listings'), 'the code-computed scale fact reached the prompt');
    // ...and which of the two locked structures is being written, decided in
    // code from human_contact rather than inferred from a layer the model can
    // no longer see.
    assert.ok(seenPrompt.includes('EMAIL VARIANT: NORMAL'), 'the email variant is stated, not left to be inferred');

    // WHAT IS OUT: the three upstream layers, in full.
    assert.ok(!seenPrompt.includes('Voicemail and email inside 81 seconds'), 'the DIAGNOSIS strengths prose is gone');
    assert.ok(!seenPrompt.includes('An off-market instruction recognised in words'), 'missed_opportunities prose is gone');
    assert.ok(!seenPrompt.includes('A Chevington enquiry sat untouched'), 'commercial_implication prose is gone');
    assert.ok(!seenPrompt.includes('Strong front desk, wrong hours.'), 'diagnosis_summary prose is gone');
    assert.ok(!seenPrompt.includes('Core (front desk)'), 'novus_opportunity is gone — it is a code-side hero-journey input, not a story input');
    assert.ok(!seenPrompt.includes('Two channels used inside 81 seconds of each other.'), 'INTELLIGENCE did_well prose is gone');
    assert.ok(!seenPrompt.includes('No valuation was ever offered.'), 'INTELLIGENCE missed prose is gone');
    assert.ok(!seenPrompt.includes('Slow human contact'), 'the grade reason is gone');
    assert.ok(!/buyer qualification|Viewing progression|Communication quality/i.test(seenPrompt), 'the INTELLIGENCE interpretation fields are gone');
    assert.ok(!seenPrompt.includes('See what your position is at the moment.'), 'the raw communications are gone');
    assert.ok(!seenPrompt.includes('Are you on the market or renting for example?'), 'every raw message is gone, not just the first');
    assert.ok(!/communication_id/.test(seenPrompt), 'and so is the message scaffolding around them');
    ok('the story-generation call receives ONLY the probe facts, the email variant, the typed findings and the scale fact — the DIAGNOSIS prose, the INTELLIGENCE prose and every raw communication are gone from the prompt');
  }

  // ── ...and the reduction is real, not cosmetic ───────────────────────────
  {
    let seenPrompt = '';
    __setAiCallerForTests(async ({ prompt }) => { seenPrompt = prompt; return stubResult(); });
    await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), { live_listing_count: 42 });
    const before = legacyPromptSize(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), COMMS);
    assert.ok(seenPrompt.length < before * 0.75,
      `the input is materially smaller (${before} -> ${seenPrompt.length} chars), not reorganised`);
    ok(`the Personalisation input is materially smaller than the layered one it replaces (${before} -> ${seenPrompt.length} characters on this fixture)`);
  }

  // ── Several findings combine into ONE primary narrative; the leftover
  //    becomes the supporting finding, and only then does the email's
  //    secondary hook show its one fixed intrigue line ──
  {
    __setAiCallerForTests(async () => stubResult({ wider_finding_index: 2, wider_observation: "I'd also said I had a property of my own to sell.", wider_consequence: 'a valuation sitting inside the same enquiry was never explored.' }));
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});
    assert.strictEqual(result.narrative_finding_indexes, '1,2,4', 'the narrative records exactly the findings the three beats were selected from');
    assert.strictEqual(result.positive_finding_index, 4, 'and the selection is stored beat by beat');
    assert.strictEqual(result.main_finding_index, 1);
    assert.strictEqual(result.wider_finding_index, 2);
    assert.ok(result.supporting_findings.includes('no follow-up'), 'the story finding left out of the selection survives as a supporting finding');
    assert.strictEqual(result.additional_findings_hook, ADDITIONAL_FINDINGS_HOOK_LINE,
      'the fixed tease line appears because a genuine finding is actually left over');
    assert.ok(!/follow-up/i.test(result.additional_findings_hook),
      'and it teases without revealing what the leftover finding was — that is the question the email exists to provoke');
    ok('multiple findings combine into one primary narrative, the leftover finding becomes a supporting finding, and the email\'s fixed additional-findings tease follows from that without giving the finding away');
  }

  // ── Nothing left over -> no supporting findings, but the LOCKED closing
  //    transition still appears: it is the hand-off into the breakdown, not a
  //    claim that two more findings exist ──
  {
    // Two story findings and a positive: selecting main + wider covers every
    // story finding there is, so nothing can be left over.
    const twoStoryFindings = baseFindings().filter((f) => f.finding_index !== 3);
    __setAiCallerForTests(async () => stubResult({
      wider_finding_index: 2,
      wider_observation: "I'd also said I had a property of my own to sell.",
      wider_consequence: 'a valuation sitting inside the same enquiry was never explored.',
      supporting_findings: 'There were several other issues worth mentioning.', // model padding
    }));
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), twoStoryFindings, {});
    assert.strictEqual(result.supporting_findings, '', 'no story finding is left over, so the INTERNAL supporting_findings is forced empty');
    assert.strictEqual(result.narrative_finding_indexes, '1,2,4', 'and the selection covers them all');
    assert.strictEqual(result.additional_findings_hook, ADDITIONAL_FINDINGS_HOOK_LINE,
      'but the locked closing transition is still there — it is not conditional on a leftover finding');
    assert.ok(result.email_body.includes(ADDITIONAL_FINDINGS_HOOK_LINE), 'and the email still carries that paragraph');
    assert.ok(result.email_body.endsWith(`${ADDITIONAL_FINDINGS_HOOK_LINE}\n\n${CTA_LINE}\n\nJoe`),
      'the locked final two paragraphs close the email');
    ok('the locked closing transition appears even when the narrative already covers every finding — it is the curiosity hand-off into the breakdown, while the padded internal supporting_findings is still dropped');
  }

  // ── additional_findings_hook is NEVER free text: whatever the model
  //    returns, only the one locked line can appear ──
  {
    for (const injected of ['A detailed paragraph explaining the second finding and why it matters commercially.', '']) {
      __setAiCallerForTests(async () => ({ ...stubResult(), additional_findings_hook: injected }));
      const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});
      assert.strictEqual(result.additional_findings_hook, ADDITIONAL_FINDINGS_HOOK_LINE,
        'a model-written hook is discarded entirely in favour of the locked line');
      assert.ok(!result.email_body.includes('detailed paragraph'), 'model-authored analysis never reaches the email');
    }
    ok('additional_findings_hook is deterministic — always exactly the locked line, never AI-written analysis, however the model responds');
  }

  // ── PHASE 6: a selected finding number that does not exist is refused ──
  //    A hallucinated index would make the audit trail back to
  //    DIAGNOSIS_FINDINGS lie about which finding the email rests on, so it is
  //    never silently kept — the model is asked again, and an answer that
  //    still cannot name a real finding leaves the row unsendable.
  {
    let calls = 0;
    __setAiCallerForTests(async () => { calls += 1; return stubResult({ main_finding_index: 7 }); });
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});
    assert.strictEqual(calls, 3, 'the impossible index is rejected and re-asked, up to the bounded retry limit');
    assert.strictEqual(result.main_finding_index, '', 'finding 7 does not exist, so nothing is stored as the main selection');
    assert.strictEqual(result.narrative_finding_indexes, '4', 'and only the selections that resolve reach the audit trail');
    ok('a selected finding number that does not exist is refused rather than stored, so the audit trail back to DIAGNOSIS_FINDINGS cannot lie');
  }

  // ── PHASE 6: the positive beat can only be written from a POSITIVE
  //    finding, and the main story only from a problem/opportunity ──
  {
    let calls = 0;
    __setAiCallerForTests(async () => { calls += 1; return stubResult({ positive_finding_index: 1 }); });
    const wrongPositive = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});
    assert.strictEqual(calls, 3, 'a problem picked as the fair observation\'s positive is sent back');
    assert.strictEqual(wrongPositive.positive_finding_index, '', 'and is never stored as a positive selection');

    calls = 0;
    __setAiCallerForTests(async () => { calls += 1; return stubResult({ main_finding_index: 4 }); });
    const wrongMain = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});
    assert.strictEqual(calls, 3, 'a positive picked as the main story is sent back too');
    assert.strictEqual(wrongMain.main_finding_index, '', 'and is never stored as the main story');
    ok('the positive index must be a POSITIVE finding and the main index a PROBLEM or OPPORTUNITY — a mistyped selection is refused, never stored');
  }

  // ── PHASE 6: a probe whose findings carry no positive at all (every row
  //    written before finding_type existed) still personalises normally ──
  {
    const legacyFindings = baseFindings()
      .filter((f) => f.finding_type !== 'positive')
      .map(({ finding_type, ...rest }) => rest); // eslint-disable-line no-unused-vars
    let calls = 0;
    __setAiCallerForTests(async () => { calls += 1; return stubResult({ positive_finding_index: null }); });
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), legacyFindings, {});
    assert.strictEqual(calls, 1, 'no positive exists to select, so a null positive index is a correct answer and costs one call');
    assert.strictEqual(result.positive_finding_index, '', 'nothing is stored as the positive selection');
    assert.ok(result.fair_observation, 'the fair observation is still written and still mandatory');
    assert.ok(result.email_body, 'and the email is still sendable');
    ok('a legacy findings list with no positive rows still produces a sendable email — the positive index is optional exactly when no positive exists');
  }

  // ── PHASE 6: EVIDENCE IS GROUNDED BY CONSTRUCTION ────────────────────────
  //    The model is no longer asked for quotes at all — it never sees a raw
  //    message, so there is nothing for it to misquote. The stored evidence is
  //    the evidence of the findings the story actually selected, and nothing
  //    else can get in.
  {
    __setAiCallerForTests(async () => stubResult({
      wider_finding_index: 2,
      wider_observation: "I'd also said I had a property of my own to sell.",
      wider_consequence: 'a valuation sitting inside the same enquiry was never explored.',
      // A model that invents a quote anyway has nowhere to put it: the field
      // does not exist on the tool.
      evidence_quotes: [{ quote: 'We will absolutely smash this valuation for you', communication_id: 'com_2' }],
    }));
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});

    assert.ok(result.evidence.includes('Probe 22:34 -> first human contact 16:25 next day = 17.85 hours.'),
      "the main finding's own evidence is recorded");
    assert.ok(result.evidence.includes('No valuation, appraisal or valuer mentioned in either message.'),
      "the wider finding's own evidence is recorded");
    assert.ok(result.evidence.includes('A voicemail at 16:25:30 and an email at 16:26:51.'),
      "the positive finding's own evidence is recorded");
    assert.ok(!result.evidence.includes('follow_ups = 0'),
      'an unselected finding\'s evidence is not — the record is what this email rests on, not everything known');
    assert.ok(!result.evidence.includes('smash this valuation'), 'an invented quote has nowhere to enter from');
    assert.ok(/^Finding 1:/.test(result.evidence), 'and each piece is labelled with the finding it came from');
    ok('the stored evidence is exactly the evidence of the findings the story selected — grounded by construction, with no quote for the model to fabricate');
  }

  // ── Currency: the probe's own property value is allowed; an invented fee
  //    or annual-cost figure is not — anywhere in the output ──
  {
    __setAiCallerForTests(async () => stubResult({
      primary_narrative: 'The £375,000 Chevington enquiry waited overnight. That is roughly £11,250 in fees at 3%.',
      commercial_consequence: 'That meant you likely lost around £9,000 of commission on this one enquiry.',
    }));
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});
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
    const result = await personaliseProbe(priceless, baseIntelligence(), baseDiagnosis(), baseFindings(), {});
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

  // ── Fair observation is MANDATORY wherever there was human contact ──
  {
    // Diagnosis records the strengths worth writing up COMMERCIALLY, and the
    // email's bar is far lower: any human contact at all leaves something
    // factual to acknowledge. So an empty Diagnosis strengths field no longer
    // suppresses the paragraph the brief makes mandatory.
    __setAiCallerForTests(async () => stubResult({ fair_observation: 'you did get back to me, with an email asking what I was looking for.' }));
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis({ strengths: '' }), baseFindings(), {});
    assert.strictEqual(result.fair_observation, 'you did get back to me, with an email asking what I was looking for.',
      'a small, factual acknowledgement survives even when Diagnosis recorded no commercial strength');
    assert.ok(result.email_body.includes('I want to say upfront that you did get back to me'), 'and opens the email');
    ok('the fair observation is mandatory for any probe with human contact — a weak interaction still has something factual to acknowledge, so it is no longer gated on Diagnosis recording a commercial strength');
  }

  // ── ...and a probe with human contact that ends up WITHOUT one is not
  //    sendable, rather than sending an email that opens on the criticism ──
  {
    for (const [why, injected] of [
      ['the model returned nothing', ''],
      ['it was detached third-person commentary', 'They came back quickly and chased twice.'],
      ['it hedged the compliment', 'you eventually came back to me.'],
    ]) {
      __setAiCallerForTests(async () => stubResult({ fair_observation: injected }));
      const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});
      assert.strictEqual(result.fair_observation, '', `${why}: nothing is printed`);
      assert.strictEqual(result.email_body, '', `${why}: and no email is assembled at all`);
      assert.ok(emailContractViolations(result).includes('missing_fair_observation'), `${why}: the violation names the missing fair observation`);
      assert.ok(result.main_finding && result.commercial_consequence,
        `${why}: the rest of the story is still recorded for the human who now has to look at it`);
    }
    ok('a normal probe left without a fair observation — blank, detached, or hedged — fails the contract: email_body is empty and the violation is named, rather than an email going out that opens on criticism');
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
      const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});
      assert.strictEqual(result.fair_observation, '', `detached third person "${detached}" never reaches the email`);
      assert.ok(!result.email_body.includes(detached), 'and never reaches the assembled body either');
    }
    // The same observation written to them survives — as the lower-case
    // continuation the assembler prints after "I want to say upfront that ".
    __setAiCallerForTests(async () => stubResult({ fair_observation: "You didn't let this one go cold — you came back twice." }));
    const kept = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});
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
      positive_finding_index: 1,
      main_finding_index: 1,
      wider_finding_index: 3,
      fair_observation: 'Your team did their best under the circumstances.',
      main_finding: 'When you finally called back, the questions you asked were the right ones.',
      commercial_consequence: 'a buyer who was ready to view never got as far as a conversation.',
      wider_observation: "I'd also said I had a property of my own I was thinking of selling.",
      wider_consequence: 'It also meant the property I said I had of my own was never picked up as a valuation.',
      evidence_quotes: [],
    }));
    const noReplyIntelligence = baseIntelligence({ human_contact: 'none', response_hours: '', contact_attempts: 0, channels_used: '' });
    const noReplyFindings = [
      { finding_index: 1, finding_type: 'problem', finding: 'The enquiry was never replied to.', evidence: 'No communications recorded in the 4-day window.', significance_note: 'A buyer and a seller lead both lost in silence.' },
      { finding_index: 2, finding_type: 'problem', finding: 'No automated acknowledgement was sent either.', evidence: 'Zero communications of any kind.', significance_note: 'Nothing caught the enquiry at all.' },
      // The wider beat is written FROM a finding, so a seller opportunity the
      // email is allowed to raise has to exist as one. If Diagnosis never
      // recorded it, the email cannot invent it — which is the point.
      { finding_index: 3, finding_type: 'opportunity', finding: 'A declared property to sell was never picked up as a valuation.', evidence: 'The enquiry declared a property to sell; nothing was ever sent back.', significance_note: 'A valuation opportunity lost in the same silence.' },
    ];
    const result = await personaliseProbe(PROBE, noReplyIntelligence, baseDiagnosis({ strengths: '' }), noReplyFindings, {});

    assert.strictEqual(result.email_variant, 'no_response', 'the email switches to its own structure');
    assert.strictEqual(result.fair_observation, '', 'there was no handling to be fair about, so nothing is invented');
    assert.strictEqual(result.main_finding, '', 'and the model\'s invented conversation is discarded outright — the failure is the silence');
    assert.strictEqual(result.additional_findings_hook, '',
      'the no-response variant has its own closing, so the normal tease is not stored on top of it');
    assert.strictEqual(result.hero_journey, 'complete_miss', 'the journey is the complete-miss one');
    // Nothing was ever said, so the evidence is the ABSENCE the findings
    // record — never a quote, because there is nothing to quote from.
    assert.ok(result.evidence.includes('No communications recorded in the 4-day window.'),
      "the evidence is the selected findings' own evidence: the silence itself, which is what the consequence rests on");
    assert.ok(!/"/.test(result.evidence), 'and never a quote — there was nothing said to quote');

    // The email says it plainly, once, and never describes a conversation.
    assert.ok(result.email_body.includes(`\n\n${NO_REPLY_LINE}\n\n`), 'the assembler supplies the plain no-reply line');
    assert.ok(!result.email_body.includes('called back'), 'no invented conversation reaches the email');
    assert.ok(result.email_body.includes('That meant a buyer who was ready to view never got as far as a conversation.'), 'the consequence of the silence still lands');
    assert.ok(result.email_body.includes('never picked up as a valuation'), 'and a seller opportunity our own enquiry declared still carries a wider consequence');
    assert.ok(result.email_body.endsWith(`${NO_RESPONSE_BREAKDOWN_LINE}\n\n${NO_RESPONSE_CTA_LINE}\n\nJoe`),
      'and it closes with the no-response variant\'s own locked two paragraphs');
    assert.ok(!result.email_body.includes(ADDITIONAL_FINDINGS_HOOK_LINE), 'never the normal tease');
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
    const result = await personaliseProbe(PROBE, baseIntelligence({ response_hours: 0.9, follow_ups: 1 }), strongDiagnosis, [], {});
    assert.strictEqual(result.supporting_findings, '', 'no findings means nothing can be a supporting finding');
    assert.strictEqual(result.additional_findings_hook, ADDITIONAL_FINDINGS_HOOK_LINE,
      'but the locked closing transition still runs — it hands off to the breakdown rather than claiming more findings');
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
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});

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
      'We sent your team an enquiry on 17 August about a house on Barn Field.',
      `${FAIR_OBSERVATION_PREFIX}${result.fair_observation}`,
      withMainFindingPrefix(result.main_finding),
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
      const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});
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

  // ── wider_consequence: optional, paired with wider_observation, and only
  //    when genuinely a SECOND consequence rather than the first reworded ──
  {
    const WIDER_OBSERVATION = "I'd also mentioned that I had a property of my own that I was considering selling, but that never really came into the conversation.";
    __setAiCallerForTests(async () => stubResult({
      wider_finding_index: 2,
      commercial_consequence: 'the enquiry was getting attention but was not really being progressed.',
      wider_observation: WIDER_OBSERVATION,
      wider_consequence: 'it also meant a potential seller instruction sitting inside the same enquiry was never explored',
    }));
    const distinct = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});
    assert.strictEqual(distinct.wider_consequence, 'a potential seller instruction sitting inside the same enquiry was never explored.',
      'a genuinely distinct second consequence is kept, as the continuation of the assembler\'s "That also meant "');
    assert.ok(distinct.email_body.includes(`\n\n${WIDER_OBSERVATION}\n\nThat also meant a potential seller instruction sitting inside the same enquiry was never explored.`),
      'and it follows the observation it belongs to, opened by the fixed wording the assembler owns');
    assert.ok(!/That also meant [Ii]t also meant/.test(distinct.email_body), 'the prefix is never printed twice');

    // The realistic failure: an optional field filled with the same point again.
    __setAiCallerForTests(async () => stubResult({
      wider_finding_index: 2,
      commercial_consequence: 'the enquiry was getting attention but was not really being progressed.',
      wider_observation: WIDER_OBSERVATION,
      wider_consequence: 'The enquiry was getting attention but was not really being progressed.',
    }));
    const echoed = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});
    assert.strictEqual(echoed.wider_consequence, '', 'a restatement of the primary consequence is dropped, not printed twice');
    assert.strictEqual((echoed.email_body.match(/was not really being progressed/g) || []).length, 1,
      'so the same point appears exactly once in the email');

    // THE PAIR: a wider consequence with no observation in front of it is the
    // consequence of something the reader was never told, so it is dropped
    // here rather than left for the assembler to skip.
    __setAiCallerForTests(async () => stubResult({
      wider_finding_index: 2,
      wider_observation: '',
      wider_consequence: 'a potential seller instruction sitting inside the same enquiry was never explored.',
    }));
    const orphan = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});
    assert.strictEqual(orphan.wider_observation, '', 'no observation was returned');
    assert.strictEqual(orphan.wider_consequence, '', 'so its consequence is dropped too — the wider beat is a pair');
    assert.ok(!orphan.email_body.includes('That also meant'), 'and that paragraph never appears in the email');

    // UNGROUNDED: a wider beat the model wrote without selecting a finding for
    // it is an invented finding, whatever it says, so it is not printed.
    __setAiCallerForTests(async () => stubResult({
      wider_finding_index: null,
      wider_observation: WIDER_OBSERVATION,
      wider_consequence: 'a potential seller instruction sitting inside the same enquiry was never explored.',
    }));
    const ungrounded = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});
    assert.strictEqual(ungrounded.wider_observation, '', 'a wider observation with no finding behind it is not printed');
    assert.strictEqual(ungrounded.wider_consequence, '', 'and neither is its consequence');
    assert.ok(!ungrounded.email_body.includes('property of my own'), 'so nothing ungrounded reaches the email');
    assert.ok(ungrounded.email_body, 'while the rest of the email is unaffected and still sendable');

    // Genuinely absent stays absent — neither field is ever forced.
    __setAiCallerForTests(async () => stubResult({ wider_observation: '', wider_consequence: '' }));
    const absent = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});
    assert.strictEqual(absent.wider_consequence, '', 'an empty wider consequence stays empty');
    assert.strictEqual(absent.wider_observation, '', 'and so does an empty wider observation');
    ok('the wider beat is a pair: the consequence is kept only when it follows a real observation AND is genuinely a second consequence, as the lower-case continuation of the fixed "That also meant "');
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
      const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});
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
      const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});
      assert.strictEqual(result.commercial_consequence, '', `"${restatement}" is a restatement of the finding, not a consequence`);
      assert.strictEqual(result.email_body, '', 'so no email is assembled — a human needs to look at this probe');
    }

    // A real consequence — what was not captured or progressed — survives.
    __setAiCallerForTests(async () => stubResult({
      main_finding: finding,
      commercial_consequence: 'a viewing slot was committed before anyone knew whether the buyer could proceed, and the valuation sitting inside the same enquiry was never reached.',
    }));
    const kept = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});
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

  // ── Consequences describe established commercial state, never invented
  //    prospect behaviour ──────────────────────────────────────────────────
  {
    const speculative = 'leaving it open for me to lose interest or go and view something similar elsewhere.';
    assert.strictEqual(readsAsSpeculativeProspectBehaviour(speculative), true);
    assert.strictEqual(readsAsSpeculativeProspectBehaviour('the enquiry remained unqualified and no next step was established.'), false);

    __setAiCallerForTests(async () => stubResult({ commercial_consequence: speculative }));
    const rejected = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});
    assert.strictEqual(rejected.commercial_consequence, '', 'hypothetical loss of interest or viewing elsewhere is rejected');
    assert.strictEqual(rejected.email_body, '', 'an invented prospect action never reaches an assembled email');

    __setAiCallerForTests(async () => stubResult({
      commercial_consequence: 'the enquiry remained unqualified, the viewing remained unbooked, and no next step was established.',
    }));
    const grounded = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});
    assert.ok(grounded.commercial_consequence.includes('viewing remained unbooked'), 'a strong consequence grounded in established state survives');
    assert.ok(grounded.email_body.includes('That meant the enquiry remained unqualified'), 'and is assembled into the email');
    ok('speculative prospect behaviour is rejected while grounded, commercially strong consequences remain sendable');
  }

  // ── PROPER NOUNS from this probe's own address/agency survive a
  //    continuation unchanged — never forced to lower case ──────────────────
  {
    // PROBE.property_address is 'Barn Field, Chevington, IP29'.
    assert.deepStrictEqual([...extractProtectedWords(PROBE, {})].sort(),
      ['barn', 'chevington', 'field', 'ip'], 'protected words come from this probe\'s own address (including the postcode fragment)');
    assert.deepStrictEqual([...extractProtectedWords(PROBE, { agency_name: 'Ensum Brown' })].sort(),
      ['barn', 'brown', 'chevington', 'ensum', 'field', 'ip'], 'and the agency name too, when given');
    assert.deepStrictEqual([...extractProtectedWords({}, {})], [], 'no probe, no agency: nothing protected');

    __setAiCallerForTests(async () => stubResult({
      main_finding: 'Barn Field was mentioned twice but never actually offered as a viewing.',
      commercial_consequence: 'Chevington itself was never confirmed as the area I was searching in.',
    }));
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});
    assert.strictEqual(result.main_finding, 'Barn Field was mentioned twice but never actually offered as a viewing.',
      'a continuation opening with this probe\'s own proper noun keeps its capital, unlike an ordinary opening word');
    assert.strictEqual(result.commercial_consequence, 'Chevington itself was never confirmed as the area I was searching in.');
    assert.ok(result.email_body.includes('What stood out, though, was that Barn Field was mentioned'),
      'and the assembler adds the complementiser while preserving the genuine proper noun');

    // An ordinary word that merely LOOKS like it could be a name, but isn't
    // established by this probe's own address or agency, is still lower-cased.
    __setAiCallerForTests(async () => stubResult({ main_finding: 'Nobody asked about my timescale at any point.' }));
    const ordinary = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});
    assert.strictEqual(ordinary.main_finding, 'nobody asked about my timescale at any point.',
      'an opening word not established as a proper noun by this probe is still de-capitalised');
    ok('proper nouns from this probe\'s own property address or agency name survive a continuation capitalised; ordinary words do not');
  }

  // ── "That meant ..." must go beyond the finding even when it is a NEAR-
  //    duplicate — the same handful of words lightly reworded, not just an
  //    exact substring ──────────────────────────────────────────────────────
  {
    const finding = 'that nobody asked a single question about my position before inviting me to view.';
    const nearDuplicate = 'nobody asked a single question about my position before I was invited to view.';
    __setAiCallerForTests(async () => stubResult({ main_finding: finding, commercial_consequence: nearDuplicate }));
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});
    assert.strictEqual(result.commercial_consequence, '', 'a lightly reworded restatement is still refused, not just an exact substring');
    assert.strictEqual(result.email_body, '', 'so the row is unsendable, same as an exact restatement');

    // The unit: near-duplicate wording is caught; genuinely different wording
    // that happens to share a few of the finding's own words is not.
    assert.strictEqual(consequenceGoesBeyondFinding(nearDuplicate, finding), false);
    assert.strictEqual(consequenceGoesBeyondFinding(
      'a viewing slot was committed before anyone knew whether the buyer could proceed, and the valuation sitting inside the same enquiry was never reached.',
      finding,
    ), true, 'a genuinely different consequence that only shares a couple of nouns with the finding still passes');
    // Two short sentences sharing a couple of words by coincidence must not trip it.
    assert.strictEqual(consequenceGoesBeyondFinding('the valuation was never offered.', 'that nobody asked about my timescale.'), true,
      'two short, unrelated sentences are never mistaken for a restatement');
    ok('a commercial consequence that is a near-duplicate rewording of the finding is refused, not just an exact substring match');
  }

  // ── wider_consequence is refused the same way when it near-duplicates
  //    the primary consequence ──────────────────────────────────────────────
  {
    assert.strictEqual(
      distinctWiderConsequence(
        'the enquiry was getting attention, but was not really being progressed at any point',
        'the enquiry was getting attention but it was not really being progressed at any point',
      ),
      '',
      'a near-duplicate reword of the primary consequence is dropped, not just an exact restatement',
    );
    ok('distinctWiderConsequence also catches a near-duplicate rewording of the primary consequence, not just an exact one');
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
      const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});
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
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});
    assert.ok(result.main_finding, 'main_finding is populated, not blanked by the absence phrasing');
    assert.ok(result.commercial_consequence, 'commercial_consequence is populated too');
    assert.ok(result.email_body, 'and a real email is assembled from them');
    assert.ok(result.email_body.includes('What stood out, though, was that there is no qualifying question'), 'the actual sentence reaches the email, after the grammatical fixed opener');
    ok('a main_finding/commercial_consequence phrased as an honest "there is no ..." absence is never blanked, and still produces a sendable email');
  }

  // ── REGRESSION: "finding out" is ordinary English, not our own jargon ──
  //    An earlier blanket /findings?/ pattern blanked a real commercial
  //    consequence — "without anyone finding out whether I was ready to view"
  //    — and took the whole email with it. The singular only counts as our
  //    concept when it is a noun with a determiner in front of it.
  {
    assert.strictEqual(readsAsInternalReasoning('without anyone finding out whether I was ready to view'), false);
    assert.strictEqual(readsAsInternalReasoning('you never got round to finding a time that suited'), false);
    assert.strictEqual(readsAsInternalReasoning('no findings were recorded'), true);
    assert.strictEqual(readsAsInternalReasoning('the finding here is that nobody asked'), true);

    __setAiCallerForTests(async () => stubResult({
      commercial_consequence: 'a £375,000 buyer enquiry sat overnight without anyone finding out whether I was ready to view.',
    }));
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});
    assert.ok(result.commercial_consequence.includes('finding out whether I was ready to view'),
      'the sentence survives intact');
    assert.ok(result.email_body.includes('That meant a £375,000 buyer enquiry sat overnight'), 'and reaches the email');
    ok('"finding out" and "finding a time" are ordinary English and survive; "no findings", "our findings" and "the finding" are still caught as notes to ourselves');
  }

  // ── The property value speaks; we never cost the loss out for them ──
  {
    // The allowed figure is kept where it makes the scale obvious...
    assert.strictEqual(
      stripInventedLoss('you had a £225,000 buyer enquiry in front of you without establishing whether I was ready to move.'),
      'you had a £225,000 buyer enquiry in front of you without establishing whether I was ready to move.',
    );
    // ...and any sentence that turns it into their loss goes, even though the
    // figure itself was allowed.
    for (const costed of [
      'on a typical fee that is £4,500 you never billed.',
      'that is a commission you never earned.',
      'at 1.5% that is real money.',
      'this could have cost you a £425,000 sale.',
      'you may have lost your £12,000.',
      'it is worth £8,000 in revenue to you.',
    ]) {
      assert.strictEqual(stripInventedLoss(costed), '', `"${costed}" is never sent`);
    }

    // Sentence-level, so the honest half of a mixed answer survives.
    __setAiCallerForTests(async () => stubResult({
      commercial_consequence: 'you had a £375,000 buyer enquiry in front of you and never established my position. On a typical fee that is around £5,600 you never billed.',
    }));
    const mixed = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});
    assert.ok(mixed.commercial_consequence.includes('£375,000 buyer enquiry'), 'the property value survives');
    assert.ok(!/5,600|fee/i.test(mixed.commercial_consequence), 'the invented fee sentence does not');
    assert.ok(mixed.email_body, 'and the email is still sendable on the honest half');
    ok('the property value is allowed to make the scale obvious, while any sentence that turns it into a fee, a commission, a percentage or "what this cost you" is stripped');
  }

  // ── A weak interaction still yields a genuine, unhedged positive ──
  {
    // One late call that asked nothing — the worst case that still counts as
    // human contact. The acknowledgement is small and factual, and it is not
    // rewritten, shortened or hedged by the code.
    __setAiCallerForTests(async () => stubResult({
      fair_observation: 'you did get back to me with a phone call about my enquiry, rather than leaving it unanswered altogether.',
    }));
    const result = await personaliseProbe(
      PROBE,
      baseIntelligence({ response_hours: 18.9, contact_attempts: 1, follow_ups: 0, communication_quality: 'generic' }),
      baseDiagnosis({ strengths: '' }),
      baseFindings(), {},
    );
    assert.strictEqual(result.fair_observation, 'you did get back to me with a phone call about my enquiry, rather than leaving it unanswered altogether.',
      'the small factual positive is stored exactly as written');
    assert.ok(!readsAsSnuckCriticism(result.fair_observation), 'and carries no hedge word');
    assert.ok(result.email_body.startsWith('Hi {{first_name}},'), 'so the email is sendable');
    assert.ok(result.email_body.includes('I want to say upfront that you did get back to me with a phone call'),
      'and opens on it, after the fixed opener');
    ok('a weak interaction still opens the email with a genuine, unhedged positive — the acknowledgement is small and factual, and the code never rewrites it');
  }

  // ── Only the wider beat is optional — the rest of the normal email is not ──
  {
    __setAiCallerForTests(async () => stubResult({
      narrative_finding_indexes: [1, 2, 3],
      wider_observation: '',
      wider_consequence: '',
    }));
    const result = await personaliseProbe(PROBE, baseIntelligence(), baseDiagnosis(), baseFindings(), {});
    assert.strictEqual(result.wider_observation, '', 'an absent wider observation is blank');
    assert.strictEqual(result.wider_consequence, '', 'and so is its consequence');
    // The mandatory beats are all there.
    assert.ok(result.fair_observation, 'the fair observation is populated');
    assert.ok(result.main_finding, 'the main finding is populated');
    assert.ok(result.commercial_consequence, 'the consequence is populated');
    // The email drops the wider paragraphs — and nothing else.
    assert.strictEqual(result.email_body, [
      'Hi {{first_name}},',
      'We sent your team an enquiry on 17 August about a house on Barn Field.',
      `${FAIR_OBSERVATION_PREFIX}${result.fair_observation}`,
      withMainFindingPrefix(result.main_finding),
      `${THAT_MEANT_PREFIX}${result.commercial_consequence}`,
      ADDITIONAL_FINDINGS_HOOK_LINE,
      CTA_LINE,
      'Joe',
    ].join('\n\n'), 'the wider paragraphs are omitted entirely, not left as blank gaps, and the locked closing still runs');
    ok('the wider beat is the only optional part of a normal email — it comes back blank and the assembler drops those two paragraphs, while every mandatory beat and the locked closing stay');
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
      baseIntelligence(), baseDiagnosis(), baseFindings(), {},
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
