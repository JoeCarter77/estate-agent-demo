// scripts/novus-email-contract-selftest.mjs — the END-TO-END regression for
// the LOCKED email contract, run over the three probe shapes the live test
// probes cover: no response at all, a weak-but-real interaction, and a strong
// interaction with a seller opportunity sitting inside it.
//
// The other two suites prove the halves — lib/probe-personalisation.mjs
// sanitises the sentences, lib/email-assembly.mjs puts them in order. This one
// proves the WHOLE THING against the contract as written: it asserts the exact,
// complete email text, word for word, for each of the three shapes, so any
// future change to the wording, the paragraph order, the variants or the
// locked closing shows up here as a diff rather than as a subtly different
// email arriving in an agency's inbox.
//
// It also proves the contract is enforced in CODE rather than by prompting.
// For each of the failure modes the brief names by name:
//   - finding -> finding -> blank consequence
//   - a consequence that merely repeats the finding
//   - a fair observation that is disguised criticism
//   - a seller observation repeated back as its own consequence
//   - human contact with no fair observation at all
// the row must come back NOT SENDABLE with a named violation, rather than
// producing an incomplete or dishonest email.
//
// And it covers THE CONTRACT GATE: the prb_hist_0004 / prb_hist_0009 pattern,
// where the model wrote the commercial consequence into primary_narrative and
// left commercial_consequence blank. That answer must be rejected and asked
// again — with the gap named and its own reasoning handed back — until the
// email is complete, rather than stored as an unsendable row.
//
// Run: npm run novus:email-contract-selftest

import assert from 'node:assert';
import { personaliseProbe, _internal } from '../lib/probe-personalisation.mjs';
import { emailContractViolations, isSendable } from '../lib/email-assembly.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

// ── The three probes ─────────────────────────────────────────────────────────
// Shaped like the live test probes: one that was never replied to, one that
// got a thin same-day reply, and one that was handled well on the buying side
// with a declared seller opportunity that was never picked up.

const PROBES = {
  silent: {
    probe_id: 'prb_test_silent',
    property_address: 'Rayleigh Road, Basildon, SS14',
    property_price: '£285,000',
    probe_timestamp: '2026-08-11T21:21:04Z',
    enquiry_text: 'Interested in a viewing. Declared: has a property of their own to sell, not yet on the market.',
  },
  weak: {
    probe_id: 'prb_test_weak',
    property_address: 'Church Road, Hadleigh',
    property_price: '£340,000',
    probe_timestamp: '2026-08-12T08:04:11Z',
    enquiry_text: 'Interested in a viewing. Asked what the position is on the property.',
  },
  seller: {
    probe_id: 'prb_test_seller',
    property_address: 'Fox Cottage',
    property_price: '£475,000',
    probe_timestamp: '2026-08-13T19:47:00Z',
    enquiry_text: 'Interested in a viewing. Declared: has a property of their own to sell.',
  },
};

const COMMS = {
  silent: [],
  weak: [
    {
      communication_id: 'com_w1',
      channel: 'email',
      occurred_at: '2026-08-12T14:31:00Z',
      subject: 'RE: Church Road',
      body_text: 'Thanks for getting in touch about Church Road. What sort of thing are you looking for?',
    },
  ],
  seller: [
    {
      communication_id: 'com_s1',
      channel: 'voice',
      occurred_at: '2026-08-13T20:02:00Z',
      transcript: 'Hi, calling about Fox Cottage. I can get you in on Thursday if that suits.',
    },
    {
      communication_id: 'com_s2',
      channel: 'email',
      occurred_at: '2026-08-14T09:15:00Z',
      subject: 'Fox Cottage viewing',
      body_text: 'Confirming Thursday 2pm at Fox Cottage. Could you let me know your budget and how you are funding it?',
    },
  ],
};

function intelligence(overrides = {}) {
  return {
    agency_id: 'agc_test',
    grade: 'D',
    grade_reason: '',
    human_contact: 'yes',
    response_hours: 6.4,
    contact_attempts: 1,
    follow_ups: 0,
    channels_used: 'email',
    viewing_progression: 'none',
    buyer_qualification: 'none',
    buyer_questions_asked: '',
    seller_recognition: 'none',
    communication_quality: 'generic',
    did_well: 'Replied the same day.',
    missed: 'Nothing about my position was established.',
    ...overrides,
  };
}

function diagnosis(overrides = {}) {
  return {
    strengths: 'Replied inside the same working day.',
    missed_opportunities: 'The enquiry was never qualified.',
    commercial_implication: 'A live buyer enquiry was answered and never progressed.',
    novus_opportunity: 'Core (front desk)',
    diagnosis_summary: 'Answered, never taken anywhere.',
    ...overrides,
  };
}

// ── The three real Personalisation outputs, in the shape the model returns ───
// These are what the AI is expected to produce for each shape under the
// rebuilt contract: reasoning first, then the variables.

const STORIES = {
  silent: {
    story_reasoning: '1. Nothing at all came back, so there is nothing to acknowledge. 2. The enquiry was never picked up by anyone. 3. Nobody established that there was a buyer here at all, let alone what they were looking for. 4. Yes — I said I had a property of my own to sell. 5. That valuation was never identified either.',
    primary_narrative: 'Nothing came back across the whole window — no acknowledgement, no call, nothing.',
    narrative_finding_indexes: [1],
    supporting_findings: '',
    evidence_quotes: [],
    fair_observation: '',
    main_finding: '',
    commercial_consequence: 'a buyer who was ready to book a viewing never got as far as a conversation, so nobody ever found out how serious I was or what I could actually afford.',
    wider_observation: "I'd also mentioned that I had a property of my own that I was considering selling.",
    wider_consequence: 'a valuation sitting inside the same enquiry was never identified.',
    novus_counterfactual: 'NOVUS would have answered the enquiry the moment it landed, at 21:21, and qualified both sides of it.',
  },
  weak: {
    story_reasoning: '1. You did reply, the same day, and asked me a question. 2. The reply never established anything about my position. 3. Nobody found out whether I was a serious buyer, whether I was ready to move, or what the next step was. 4. Nothing genuinely separate. 5. n/a',
    primary_narrative: 'The reply arrived the same day and asked an open question, and then nothing about the enquiry was established.',
    narrative_finding_indexes: [1],
    supporting_findings: '',
    evidence_quotes: [{ quote: 'What sort of thing are you looking for?', communication_id: 'com_w1' }],
    fair_observation: 'you did get back to me, with an email asking what I was looking for.',
    main_finding: 'that the conversation never really established my position, my timescale or what I could afford.',
    commercial_consequence: 'you had a live buyer enquiry in front of you, but nobody ever found out whether I was ready to move or what the next step should have been.',
    wider_observation: '',
    wider_consequence: '',
    novus_counterfactual: 'NOVUS would have asked the position, the timescale and the funding in that same first reply.',
  },
  seller: {
    story_reasoning: '1. You called back inside the evening and had a viewing booked by the next morning. 2. The property I said I had to sell never came up. 3. A valuation and a potential instruction inside the same enquiry were never explored. 4. Yes, the seller side. 5. It was never identified as an instruction opportunity.',
    primary_narrative: 'The buying side was handled well and the selling side, which the enquiry declared, was never touched.',
    narrative_finding_indexes: [1],
    supporting_findings: '',
    evidence_quotes: [{ quote: 'I can get you in on Thursday if that suits.', communication_id: 'com_s1' }],
    fair_observation: 'you did follow up with me and tried to get me on the phone the same evening.',
    main_finding: 'that I had told you I was considering selling my own property, but the conversation stayed entirely around the purchase.',
    commercial_consequence: 'the £475,000 enquiry was treated as a viewing to book rather than as a household that was about to move twice.',
    wider_observation: "I'd also mentioned that I had a property of my own that I was considering selling, but that never really came into the conversation.",
    wider_consequence: 'a potential seller instruction sitting inside the same enquiry was never explored.',
    novus_counterfactual: 'NOVUS would have booked the same Thursday viewing and offered the valuation on the same call.',
  },
};

// Drives one probe through Personalisation with a caller the test controls, so
// a multi-turn test can answer differently on the repair pass. Returns the row
// alongside every prompt the layer actually sent.
async function personaliseWithCaller(shape, caller, { probe: probeOverrides = {}, intelligence: intelligenceOverrides = {} } = {}) {
  const prompts = [];
  __setAiCallerForTests(async (args) => {
    prompts.push(args.prompt);
    return caller(prompts.length, args);
  });
  const findings = [{ finding_index: 1, finding: 'The enquiry was not progressed.', evidence: 'From the communications above.', significance_note: 'A live enquiry that stopped.' }];
  const row = await personaliseProbe(
    { ...PROBES[shape], ...probeOverrides },
    intelligence(shape === 'silent' ? { human_contact: 'none', response_hours: '', contact_attempts: 0, channels_used: '', ...intelligenceOverrides } : intelligenceOverrides),
    diagnosis(),
    findings,
    COMMS[shape],
    {},
  );
  return { row, prompts, calls: prompts.length };
}

async function personalise(shape, storyOverrides = {}, intelligenceOverrides = {}, diagnosisOverrides = {}) {
  __setAiCallerForTests(async () => ({ ...STORIES[shape], ...storyOverrides }));
  const findings = [{ finding_index: 1, finding: 'The enquiry was not progressed.', evidence: 'From the communications above.', significance_note: 'A live enquiry that stopped.' }];
  return personaliseProbe(
    PROBES[shape],
    intelligence(shape === 'silent' ? { human_contact: 'none', response_hours: '', contact_attempts: 0, channels_used: '', ...intelligenceOverrides } : intelligenceOverrides),
    diagnosis(diagnosisOverrides),
    findings,
    COMMS[shape],
    {},
  );
}

async function run() {
  console.log('the locked email contract — end-to-end regression over the three test probes\n');

  // ── VARIANT 1, exactly ──
  {
    const result = await personalise('silent');
    assert.strictEqual(result.email_variant, 'no_response');
    assert.strictEqual(result.email_body, [
      'Hi {{first_name}},',
      'We sent your team an enquiry on 11 August about Rayleigh Road, Basildon, SS14.',
      'We never received a reply.',
      'That meant a buyer who was ready to book a viewing never got as far as a conversation, so nobody ever found out how serious I was or what I could actually afford.',
      "I'd also mentioned that I had a property of my own that I was considering selling.",
      'That also meant a valuation sitting inside the same enquiry was never identified.',
      'There were a couple of other things from the enquiry that caught our attention too.',
      "I've put together a personalised breakdown of what we found. Happy to send it over if you'd like to see it.",
      'Joe',
    ].join('\n\n'));
    ok('VARIANT 1 (no response) assembles exactly as the contract specifies, ending in the same locked two paragraphs as every other email');
  }

  // ── VARIANT 2 with no wider beat, exactly ──
  {
    const result = await personalise('weak');
    assert.strictEqual(result.email_variant, 'normal');
    assert.strictEqual(result.email_body, [
      'Hi {{first_name}},',
      'We sent your team an enquiry on 12 August about Church Road, Hadleigh.',
      'I want to say upfront that you did get back to me, with an email asking what I was looking for.',
      'What stood out, though, was that the conversation never really established my position, my timescale or what I could afford.',
      'That meant you had a live buyer enquiry in front of you, but nobody ever found out whether I was ready to move or what the next step should have been.',
      'There were a couple of other things from the enquiry that caught our attention too.',
      "I've put together a personalised breakdown of what we found. Happy to send it over if you'd like to see it.",
      'Joe',
    ].join('\n\n'));
    ok('VARIANT 2 with a weak-but-real interaction assembles exactly as the contract specifies — the fair observation is small, factual and genuinely positive, and the locked closing still runs with no wider beat');
  }

  // ── VARIANT 2 with the full wider beat, exactly ──
  {
    const result = await personalise('seller', {}, { human_contact: 'yes', response_hours: 0.25, contact_attempts: 2, follow_ups: 1, channels_used: 'voice,email', viewing_progression: 'booked', buyer_qualification: 'thorough' });
    assert.strictEqual(result.email_body, [
      'Hi {{first_name}},',
      'We sent your team an enquiry on 13 August about Fox Cottage.',
      'I want to say upfront that you did follow up with me and tried to get me on the phone the same evening.',
      'What stood out, though, was that I had told you I was considering selling my own property, but the conversation stayed entirely around the purchase.',
      'That meant the £475,000 enquiry was treated as a viewing to book rather than as a household that was about to move twice.',
      "I'd also mentioned that I had a property of my own that I was considering selling, but that never really came into the conversation.",
      'That also meant a potential seller instruction sitting inside the same enquiry was never explored.',
      'There were a couple of other things from the enquiry that caught our attention too.',
      "I've put together a personalised breakdown of what we found. Happy to send it over if you'd like to see it.",
      'Joe',
    ].join('\n\n'));
    ok('VARIANT 2 with a genuine wider opportunity assembles exactly as the contract specifies — observation, its own separate consequence, then the locked closing');
  }

  // ── The story reads as a story, not a list of problems ──
  {
    for (const shape of ['silent', 'weak', 'seller']) {
      const body = (await personalise(shape)).email_body;
      assert.ok(body, `${shape}: sendable`);
      assert.ok(!/^\s*[-*\d]+[.)]\s/m.test(body), `${shape}: no bullet or numbered list anywhere in the email`);
      assert.ok(!/audit|grade|score|report/i.test(body), `${shape}: it never reads as an audit, a grading or a report`);
      assert.ok(!/NOVUS/i.test(body), `${shape}: the email does not sell NOVUS`);
      assert.strictEqual((body.match(/personalised breakdown/g) || []).length, 1, `${shape}: the offer is made exactly once`);
      assert.ok(body.endsWith('Happy to send it over if you\'d like to see it.\n\nJoe'), `${shape}: and the locked CTA is the last thing before the sign-off`);
    }
    ok('all three shapes read as one story ending in one offer — never a list of problems, never an audit, and never a pitch');
  }

  // ── Every failure mode the brief names by name fails VALIDATION ──
  {
    // finding -> finding -> blank consequence.
    const blank = await personalise('weak', { commercial_consequence: '' });
    assert.strictEqual(blank.email_body, '', 'a blank consequence produces no email');
    assert.ok(emailContractViolations(blank).includes('missing_commercial_consequence'));

    // A consequence that merely repeats the finding.
    const repeated = await personalise('weak', {
      commercial_consequence: 'the conversation never really established my position, my timescale or what I could afford.',
    });
    assert.strictEqual(repeated.commercial_consequence, '', 'a consequence that restates the finding is dropped');
    assert.strictEqual(repeated.email_body, '', 'so the row is not sendable rather than sending a hollow email');
    assert.ok(emailContractViolations(repeated).includes('missing_commercial_consequence'));

    // A fair observation that is disguised criticism.
    for (const hedged of [
      'you eventually got back to me.',
      'you replied, although the reply said very little.',
      'you replied, despite it taking a while.',
      'you replied quickly, however nothing came of it.',
      'you finally came back to me.',
      'you at least acknowledged the enquiry.',
      'you replied the same day, albeit with a template.',
    ]) {
      const backhanded = await personalise('weak', { fair_observation: hedged });
      assert.strictEqual(backhanded.fair_observation, '', `"${hedged}" is not a compliment and is dropped`);
      assert.strictEqual(backhanded.email_body, '', 'and the email is not sent at all rather than opening on criticism');
      assert.ok(emailContractViolations(backhanded).includes('missing_fair_observation'));
    }

    // Human contact with no fair observation at all.
    const none = await personalise('weak', { fair_observation: '' });
    assert.strictEqual(none.email_body, '', 'a probe with human contact and no fair observation is not sendable');
    assert.ok(emailContractViolations(none).includes('missing_fair_observation'));

    // A seller observation repeated back as its own consequence.
    const echoed = await personalise('seller', {
      wider_consequence: 'a property of my own that I was considering selling never really came into the conversation.',
      commercial_consequence: 'a property of my own that I was considering selling never really came into the conversation.',
    });
    assert.strictEqual(echoed.wider_consequence, '', 'the seller observation restated as its own consequence is dropped');
    assert.ok(!echoed.email_body.includes('That also meant'), 'so it is never printed twice, one paragraph apart');

    ok('every failure mode the contract names — blank consequence, a consequence that repeats the finding, a hedged fair observation, a missing fair observation, an echoed seller consequence — fails validation in code rather than producing an incomplete email');
  }

  // ── An unsendable row still records the story for the human ──
  {
    const unsendable = await personalise('weak', { fair_observation: '' });
    assert.strictEqual(isSendable(unsendable), false);
    assert.ok(unsendable.primary_narrative, 'the internal narrative is still written');
    assert.ok(unsendable.main_finding && unsendable.commercial_consequence, 'and so is the rest of the email copy');
    assert.ok(unsendable.novus_counterfactual, 'the counterfactual survives for the breakdown');
    ok('a row that fails the contract still carries its full story — the blank email_body flags it for a human, it does not throw the analysis away');
  }

  // ── THE prb_hist_0004 / prb_hist_0009 PATTERN ──────────────────────────
  //    A strong narrative, a strong fair observation, a strong main finding, a
  //    strong wider beat — and a BLANK commercial_consequence, with the
  //    consequence sitting in prose inside primary_narrative. The model
  //    understood it perfectly and put it in the wrong place. That answer must
  //    be rejected and asked again, not stored as an unsendable row.
  {
    // prb_hist_0009's actual primary_narrative.
    const NARRATIVE = 'The persistence went entirely into pushing a viewing, while the two things that would have told them who they were dealing with — his buying readiness and his selling potential — were left completely unexplored.';
    const DISTILLED = 'nobody ever established how ready I actually was to buy, or that there was a second property to value sitting inside the same enquiry.';

    const { row, prompts, calls } = await personaliseWithCaller('seller', (turn) => (turn === 1
      // Turn 1: everything right except the field that carries the whole point.
      ? { ...STORIES.seller, primary_narrative: NARRATIVE, commercial_consequence: '' }
      // Turn 2: the same story, with the consequence distilled out of it.
      : { ...STORIES.seller, primary_narrative: NARRATIVE, commercial_consequence: DISTILLED }));

    assert.strictEqual(calls, 2, 'the blank consequence was rejected and the model was asked again, exactly once');
    assert.strictEqual(row.commercial_consequence, DISTILLED, 'the accepted output carries the distilled commercial consequence');
    assert.ok(isSendable(row), 'and the row is sendable');
    assert.deepStrictEqual(emailContractViolations(row), [], 'with no contract violations left');
    assert.ok(row.email_body.includes(`That meant ${DISTILLED}`), 'the email says what it meant, in the locked paragraph');
    assert.ok(row.email_body.startsWith('Hi {{first_name}},'), 'and the full email is assembled');

    // Nothing else was lost on the way through the repair pass.
    assert.ok(row.fair_observation && row.main_finding, 'the fair observation and main finding survive');
    assert.strictEqual(row.primary_narrative, NARRATIVE, 'and so does the internal narrative');

    // The repair turn is what makes this work: the model gets its own
    // reasoning back, and is told exactly what was wrong with the answer.
    const repair = prompts[1];
    assert.ok(repair.includes(NARRATIVE), 'the repair prompt hands the model its own narrative back to distil from');
    assert.ok(/commercial_consequence came back EMPTY/.test(repair), 'and names the specific gap');
    assert.ok(/primary_narrative and story_reasoning are INTERNAL/.test(repair), 'and restates that the narrative is not an email field');
    assert.ok(repair.startsWith(prompts[0]), 'the repair turn is the same question again, not a different one');
    ok('the 0004/0009 pattern — a consequence written into primary_narrative and left blank in commercial_consequence — is rejected and regenerated, and the accepted output is a complete, sendable email');
  }

  // ── The gate costs nothing on an answer that satisfies the contract ──
  {
    const clean = await personaliseWithCaller('seller', () => STORIES.seller);
    assert.strictEqual(clean.calls, 1, 'a complete answer is accepted on the first call — no repair pass, no extra cost');
    assert.ok(clean.row.email_body, 'and produces its email');

    const silent = await personaliseWithCaller('silent', () => STORIES.silent);
    assert.strictEqual(silent.calls, 1, 'the no-response variant needs no fair observation or main finding, so it never triggers a repair');

    // A DATA problem is not a model problem: no number of AI calls will invent
    // a property address the probe never established, so it is not retried.
    const noAddress = await personaliseWithCaller('seller', () => STORIES.seller, { probe: { property_address: 'UNKNOWN — never established' } });
    assert.strictEqual(noAddress.calls, 1, 'an unestablished address is not retried — it is a data problem, not a wrong answer');
    assert.strictEqual(noAddress.row.email_body, '', 'and the row is unsendable, as before');
    assert.ok(emailContractViolations(noAddress.row).includes('missing_property_address'));
    // The caller's AI-call budget is billed by calls, not probes, so a batch
    // capped at N calls still makes at most N even when rows need repair.
    assert.strictEqual(clean.row.ai_calls_used, 1, 'an accepted first answer reports one AI call');
    const repaired = await personaliseWithCaller('weak', (turn) => (turn === 1
      ? { ...STORIES.weak, commercial_consequence: '' }
      : STORIES.weak));
    assert.strictEqual(repaired.row.ai_calls_used, repaired.calls, 'and a repaired row reports every call it actually took');
    ok('the gate only spends AI calls on what asking again could actually fix — a satisfying answer costs one call, a missing property address is never retried, and every call is reported for the caller\'s budget');
  }

  // ── An answer that never satisfies the contract is bounded, and honest ──
  {
    const { row, calls } = await personaliseWithCaller('weak', () => ({ ...STORIES.weak, commercial_consequence: '' }));
    assert.strictEqual(calls, 3, 'the repair pass is bounded — it does not loop forever on a model that will not fill the field');
    assert.strictEqual(row.commercial_consequence, '', 'nothing is invented to fill the gap');
    assert.strictEqual(row.email_body, '', 'so the row stays unsendable and a human gets to look at it');
    assert.ok(row.primary_narrative && row.main_finding && row.fair_observation,
      'and the rest of the story is still stored, rather than the whole analysis being thrown away');
    ok('a probe the model never completes is asked at most three times, then stored unsendable with its full story — never invented, never looped on');
  }

  // ── The repair pass names what was wrong, not just that something was ──
  {
    // Rejected for a different reason each time: a hedged compliment, then a
    // consequence that only restates the finding.
    const hedged = await personaliseWithCaller('weak', (turn) => (turn === 1
      ? { ...STORIES.weak, fair_observation: 'you eventually got back to me.' }
      : STORIES.weak));
    assert.strictEqual(hedged.calls, 2);
    assert.ok(/hedged the compliment/.test(hedged.prompts[1]), 'a hedged fair observation is sent back as a hedge, not as a blank');
    assert.ok(hedged.row.email_body, 'and the honest rewrite is accepted');

    const restated = await personaliseWithCaller('weak', (turn) => (turn === 1
      ? { ...STORIES.weak, commercial_consequence: STORIES.weak.main_finding }
      : STORIES.weak));
    assert.strictEqual(restated.calls, 2);
    assert.ok(/restated main_finding/.test(restated.prompts[1]), 'a consequence that repeats the finding is sent back as a restatement, not as a blank');
    assert.ok(restated.row.email_body, 'and the real consequence is accepted');
    ok('each rejection tells the model what actually went wrong — blank, hedged, or a restatement — because a model asked simply to try again reproduces the same answer');
  }

  // ── The model reasons about the story BEFORE it fills the variables ──
  {
    const { TOOL, SYSTEM_PROMPT } = _internal;
    const required = TOOL.input_schema.required;
    const properties = Object.keys(TOOL.input_schema.properties);
    assert.ok(required.includes('story_reasoning'), 'story_reasoning is a required field, not an optional extra');
    assert.strictEqual(required[0], 'story_reasoning', 'and it is required FIRST');
    assert.strictEqual(properties[0], 'story_reasoning', 'and declared first, so it is generated before any email variable');
    for (const emailField of ['fair_observation', 'main_finding', 'commercial_consequence']) {
      assert.ok(properties.indexOf('story_reasoning') < properties.indexOf(emailField),
        `story_reasoning is reasoned out before ${emailField} is written`);
    }
    // The five questions themselves, in the schema rather than only in prose.
    const reasoning = TOOL.input_schema.properties.story_reasoning.description;
    for (const question of ['genuinely do well', 'strongest primary missed opportunity', 'fail to establish', 'SEPARATE wider opportunity', 'mean commercially']) {
      assert.ok(reasoning.includes(question), `the reasoning field asks: ${question}`);
    }
    // And the contract's own "never allow" rules are stated to the model too.
    for (const rule of ['finding -> finding -> blank consequence', 'repeats the finding', 'disguised criticism', 'seller observation repeated back']) {
      assert.ok(SYSTEM_PROMPT.includes(rule), `the system prompt forbids: ${rule}`);
    }
    // Mandatory means mandatory, in the prompt as well as in the code.
    assert.ok(TOOL.input_schema.properties.fair_observation.description.includes('MANDATORY'), 'fair_observation is described as mandatory');
    assert.ok(TOOL.input_schema.properties.commercial_consequence.description.includes('MANDATORY'), 'commercial_consequence is described as mandatory');
    assert.ok(!properties.includes('additional_findings_hook'), 'the locked closing transition is never asked of the model at all');
    ok('the schema makes the model reason through the five story questions before any variable is written, and states the mandatory fields and the forbidden shapes rather than leaving them to prompting alone');
  }

  console.log(`\n${passed} checks passed.`);
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
