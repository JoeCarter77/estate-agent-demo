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
import { emailContractViolations, isSendable, ADDITIONAL_FINDINGS_HOOK_LINE } from '../lib/email-assembly.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

// ── The three test probes ────────────────────────────────────────────────────
// Shaped like the live test probes prb_hist_0003 / 0004 / 0009: one that was
// never replied to, one that got a late call that asked nothing, and one that
// was followed up hard on the buying side with a declared seller opportunity
// that never came up. Addresses are in the live PROBES shape, analyst note and
// all — the note is stripped for display, never sent.

const PROBES = {
  // prb_hist_0003 — no response at all. Road-only address, so the email must
  // say "a house on Perry Street" and must never invent a house number.
  silent: {
    probe_id: 'prb_hist_0003',
    property_address: 'Perry Street (exact property not evidenced)',
    property_price: '£425,000',
    probe_timestamp: '2026-08-10T09:12:00Z',
    enquiry_text: 'Interested in viewing. Declared: has a property of their own to sell, not yet on the market.',
  },
  // prb_hist_0004 — one call, ~19 hours later, that answered nothing and
  // asked nothing.
  weak: {
    probe_id: 'prb_hist_0004',
    property_address: 'Southend Road',
    property_price: '£225,000',
    probe_timestamp: '2026-08-10T14:03:00Z',
    enquiry_text: 'Asked whether the property is still available and whether there is a chain. Declared: has a property of their own to sell.',
  },
  // prb_hist_0009 — three attempts inside a day, all pushing the viewing.
  // NOTE THE ADDRESS. The live row records Fox Cottage and flags the Church
  // Road relationship as UNCONFIRMED, so the email opens on Fox Cottage: the
  // unconfirmed road never reaches the intro, because we do not assume a
  // relationship the data says is unverified.
  seller: {
    probe_id: 'prb_hist_0009',
    property_address: "Fox Cottage (relationship to 'Church Road' UNCONFIRMED)",
    property_price: '£650,000',
    probe_timestamp: '2026-08-10T18:40:00Z',
    enquiry_text: 'Interested in viewing Fox Cottage. Declared: has a property of their own to sell, not yet on the market.',
  },
};

const COMMS = {
  silent: [],
  weak: [
    {
      communication_id: 'com_w1',
      channel: 'voice',
      occurred_at: '2026-08-11T08:57:00Z',
      transcript: 'Hi, calling about your enquiry. Give us a ring back when you get a minute and we can have a chat.',
    },
  ],
  seller: [
    {
      communication_id: 'com_s1',
      channel: 'voice',
      occurred_at: '2026-08-10T19:20:00Z',
      transcript: 'Hi, this is about your enquiry on Fox Cottage. I can get you booked in for a viewing whenever suits.',
    },
    {
      communication_id: 'com_s2',
      channel: 'email',
      occurred_at: '2026-08-11T08:15:00Z',
      subject: 'Fox Cottage viewing',
      body_text: 'Just following up on Fox Cottage — happy to get a viewing in the diary this week if you let me know a time.',
    },
    {
      communication_id: 'com_s3',
      channel: 'voice',
      occurred_at: '2026-08-11T16:44:00Z',
      transcript: 'Trying you again about Fox Cottage. Let me know when you would like to view.',
    },
  ],
};

// The INTELLIGENCE each probe actually carries, so the layer sees the shape it
// is writing about rather than one generic probe three times.
const INTELLIGENCE = {
  silent: {
    human_contact: 'none', response_hours: '', contact_attempts: 0, follow_ups: 0, channels_used: '',
    grade: 'H', communication_quality: 'none', did_well: '', missed: 'Nothing was ever sent.',
  },
  weak: {
    human_contact: 'yes', response_hours: 18.9, contact_attempts: 1, follow_ups: 0, channels_used: 'voice',
    grade: 'F', buyer_qualification: 'none', communication_quality: 'generic',
    did_well: 'Called rather than leaving it unanswered.', missed: 'The call answered nothing and asked nothing.',
  },
  seller: {
    human_contact: 'yes', response_hours: 0.67, contact_attempts: 3, follow_ups: 2, channels_used: 'voice,email',
    grade: 'D', viewing_progression: 'availability_requested', buyer_qualification: 'none',
    did_well: 'Three attempts across two channels inside a day, property referenced correctly.',
    missed: 'Nothing was asked about the buyer, and the declared property to sell never came up.',
  },
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

// ── The three Personalisation outputs, at target quality ─────────────────────
// This is what the AI is expected to produce for each shape under the rebuilt
// contract: reasoning first, then the variables — tight, one job per sentence,
// the property value used to make the scale obvious without ever costing it
// out, and the seller side kept to two short sentences in the wider beat.

const STORIES = {
  silent: {
    story_reasoning: '1. Nothing came back at all, so there is nothing to acknowledge. 2. The enquiry was never picked up by anyone. 3. Nobody established whether I was ready to view, what my timescale was, or what would have got me through the door. 4. Yes — I said I had a property of my own to sell, not yet on the market. 5. That instruction opportunity was never explored either.',
    primary_narrative: 'Nothing came back across four days — no acknowledgement, no call, nothing — on an enquiry that carried both a buyer and a seller.',
    narrative_finding_indexes: [1],
    supporting_findings: '',
    evidence_quotes: [],
    fair_observation: '',
    main_finding: '',
    commercial_consequence: 'a £425,000 buyer enquiry sat for four days without anyone finding out whether I was ready to view, what my timescale was, or what it would have taken to get me through the door.',
    wider_observation: "I'd also said in the enquiry that I had a property of my own to sell that wasn't yet on the market.",
    wider_consequence: 'a potential seller instruction sitting inside the same enquiry was never explored.',
    novus_counterfactual: 'NOVUS would have answered the enquiry the moment it landed and qualified both sides of it.',
  },
  weak: {
    story_reasoning: '1. You did phone me back about the enquiry rather than ignoring it. 2. The call came almost 19 hours later, answered nothing I had asked, and asked nothing about me. 3. Nobody established whether I was ready to move, what I needed, or what should happen next. 4. Yes — I said I had a property of my own to sell. 5. That valuation and instruction were never explored.',
    primary_narrative: 'The call came the next morning and went nowhere: it answered none of the questions in the enquiry and asked none of its own.',
    narrative_finding_indexes: [1],
    supporting_findings: '',
    evidence_quotes: [{ quote: 'Give us a ring back when you get a minute', communication_id: 'com_w1' }],
    fair_observation: 'you did get back to me with a phone call about my enquiry, rather than leaving it unanswered altogether.',
    main_finding: "that the call came almost 19 hours later, didn't answer what I'd asked about the property, and didn't ask me anything about my own situation.",
    commercial_consequence: 'you had a £225,000 buyer enquiry in front of you without establishing whether I was ready to move, what I needed from the property, or what should happen next.',
    wider_observation: "I'd also said in my enquiry that I had a property of my own that I was looking to sell, but that never came up.",
    wider_consequence: 'a potential valuation and seller instruction sitting inside the same enquiry was never explored.',
    novus_counterfactual: 'NOVUS would have answered inside the hour and asked the position, the timescale and the funding on that first call.',
  },
  seller: {
    story_reasoning: '1. You followed up quickly and persistently — three attempts across phone and email inside a day, with my name and Fox Cottage referenced correctly. 2. Every attempt pushed the viewing and asked nothing about me. 3. Nobody established whether I was in a position to move forward at all. 4. Yes — I said I had a property of my own to sell, not yet on the market. 5. That instruction opportunity was never explored.',
    primary_narrative: 'The persistence went entirely into pushing a viewing, while the two things that would have told them who they were dealing with — buying readiness and selling potential — were left completely unexplored.',
    narrative_finding_indexes: [1],
    supporting_findings: '',
    evidence_quotes: [{ quote: 'I can get you booked in for a viewing whenever suits.', communication_id: 'com_s1' }],
    fair_observation: 'you did follow up with me quickly and persistently — three attempts by phone and email within a day, with my name and Fox Cottage referenced correctly and a clear invitation to book a viewing.',
    main_finding: 'that all three attempts focused on getting me to a viewing without asking anything about my budget, timescale, requirements or position as a buyer.',
    commercial_consequence: 'you had a £650,000 buyer enquiry in front of you without establishing whether I was actually in a position to move forward.',
    wider_observation: "I'd also said in my enquiry that I had a property of my own to sell that wasn't yet on the market, but that never came into the conversation.",
    wider_consequence: 'a potential seller instruction sitting inside the same enquiry was never explored.',
    novus_counterfactual: 'NOVUS would have made the same three attempts and qualified the buyer and the seller side on the first one.',
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
    intelligence({ ...INTELLIGENCE[shape], ...intelligenceOverrides }),
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
    intelligence({ ...INTELLIGENCE[shape], ...intelligenceOverrides }),
    diagnosis(diagnosisOverrides),
    findings,
    COMMS[shape],
    {},
  );
}

async function run() {
  console.log('the locked email contract — end-to-end regression over the three test probes\n');

  // ── prb_hist_0003 — VARIANT 1 (no response), word for word ──
  {
    const result = await personalise('silent');
    assert.strictEqual(result.email_variant, 'no_response');
    assert.strictEqual(result.email_body, [
      'Hi {{first_name}},',
      'We sent your team an enquiry on 10 August about a house on Perry Street.',
      'We never received a reply.',
      'That meant a £425,000 buyer enquiry sat for four days without anyone finding out whether I was ready to view, what my timescale was, or what it would have taken to get me through the door.',
      "I'd also said in the enquiry that I had a property of my own to sell that wasn't yet on the market.",
      'That also meant a potential seller instruction sitting inside the same enquiry was never explored.',
      "We found a couple of things that may explain it, so we've put together a short breakdown that might be useful.",
      "Happy to send it over if you'd like to see it.",
      'Joe',
    ].join('\n\n'));
    ok('prb_hist_0003 (no response) assembles exactly as specified — "a house on Perry Street", the silence, its consequence at £425,000, the seller beat, and the no-response closing');
  }

  // ── prb_hist_0004 — VARIANT 2, word for word ──
  {
    const result = await personalise('weak');
    assert.strictEqual(result.email_variant, 'normal');
    assert.strictEqual(result.email_body, [
      'Hi {{first_name}},',
      'We sent your team an enquiry on 10 August about a house on Southend Road.',
      'I want to say upfront that you did get back to me with a phone call about my enquiry, rather than leaving it unanswered altogether.',
      "What stood out, though, was that the call came almost 19 hours later, didn't answer what I'd asked about the property, and didn't ask me anything about my own situation.",
      'That meant you had a £225,000 buyer enquiry in front of you without establishing whether I was ready to move, what I needed from the property, or what should happen next.',
      "I'd also said in my enquiry that I had a property of my own that I was looking to sell, but that never came up.",
      'That also meant a potential valuation and seller instruction sitting inside the same enquiry was never explored.',
      'There were a couple of other things from the enquiry that caught our attention too.',
      "I've put together a personalised breakdown of what we found. Happy to send it over if you'd like to see it.",
      'Joe',
    ].join('\n\n'));
    ok('prb_hist_0004 (a late call that asked nothing) assembles exactly as specified — a genuine positive for a weak interaction, the finding, the £225,000 consequence, the seller beat, and the normal closing');
  }

  // ── prb_hist_0009 — VARIANT 2 with strong follow-up, word for word ──
  {
    const result = await personalise('seller');
    assert.strictEqual(result.email_body, [
      'Hi {{first_name}},',
      'We sent your team an enquiry on 10 August about Fox Cottage.',
      'I want to say upfront that you did follow up with me quickly and persistently — three attempts by phone and email within a day, with my name and Fox Cottage referenced correctly and a clear invitation to book a viewing.',
      'What stood out, though, was that all three attempts focused on getting me to a viewing without asking anything about my budget, timescale, requirements or position as a buyer.',
      'That meant you had a £650,000 buyer enquiry in front of you without establishing whether I was actually in a position to move forward.',
      "I'd also said in my enquiry that I had a property of my own to sell that wasn't yet on the market, but that never came into the conversation.",
      'That also meant a potential seller instruction sitting inside the same enquiry was never explored.',
      'There were a couple of other things from the enquiry that caught our attention too.',
      "I've put together a personalised breakdown of what we found. Happy to send it over if you'd like to see it.",
      'Joe',
    ].join('\n\n'));

    // THE ADDRESS CHECK the brief asks for. The live row records Fox Cottage
    // and marks the Church Road relationship UNCONFIRMED, so the intro opens
    // on Fox Cottage — the road is never assumed into the email. Fox Cottage
    // itself IS evidenced in the communications, so quoting it back in the
    // fair observation is honest.
    assert.ok(!/Church Road/.test(result.email_body), 'an UNCONFIRMED road relationship never reaches the email');
    assert.ok(!/UNCONFIRMED|relationship/i.test(result.email_body), "and neither does the analyst's own note");
    assert.ok(result.email_body.includes('about Fox Cottage.'), 'the intro opens on the property the data actually establishes');
    ok('prb_hist_0009 (three attempts, all pushing the viewing) assembles exactly as specified — and the intro names Fox Cottage, never the road the data flags as an unconfirmed relationship');
  }

  // ── THE PROPERTY VALUE MAKES THE SCALE OBVIOUS; WE NEVER COST IT OUT ──
  {
    // Used where it strengthens the consequence...
    for (const shape of ['silent', 'weak', 'seller']) {
      const body = (await personalise(shape)).email_body;
      const price = PROBES[shape].property_price;
      assert.ok(body.includes(price), `${shape}: the confirmed property value is used to make the scale obvious`);
      assert.strictEqual((body.match(/£/g) || []).length, 1, `${shape}: exactly one figure appears, and it is that one`);
      assert.ok(!/\bfees?\b|\bcommission\b|\bper cent\b|%/i.test(body), `${shape}: no fee, commission or percentage is ever stated`);
      assert.ok(!/cost you|lost you|could have (?:earned|made)/i.test(body), `${shape}: and the loss is never costed out for them`);
    }

    // ...and omitted entirely when it adds nothing. A consequence written
    // without the value is stored exactly as written — nothing forces a price
    // into an email that does not need one.
    const noPrice = await personalise('weak', {
      commercial_consequence: 'nobody ever established whether I was ready to move or what should happen next.',
    });
    assert.ok(!noPrice.email_body.includes('£'), 'no figure is forced into an email whose consequence does not use one');
    assert.ok(noPrice.email_body.includes('That meant nobody ever established whether I was ready to move'), 'and the consequence is printed exactly as written');

    // An invented cost is stripped even when it uses the ALLOWED figure.
    const costed = await personalise('weak', {
      commercial_consequence: 'you had a £225,000 buyer enquiry in front of you without establishing whether I was ready to move. On a typical fee that is around £4,500 you never billed.',
    });
    assert.ok(costed.email_body.includes('£225,000 buyer enquiry'), 'the property value survives');
    assert.ok(!/4,500|fee/i.test(costed.email_body), 'and the invented fee sentence beside it does not');
    ok('the property value is used to make the scale obvious and never turned into what it cost them — no fees, no commission, no percentages — and it is never forced into an email that does not need it');
  }

  // ── THE SELLER SIDE IS A SEPARATE BEAT, AND NEVER INVENTED ──
  {
    // Where the enquiry declared it, it is two short sentences: the
    // observation, then what missing it meant.
    for (const shape of ['silent', 'weak', 'seller']) {
      const body = (await personalise(shape)).email_body;
      assert.ok(/property of my own/.test(body), `${shape}: the declared seller side is named in its own paragraph`);
      assert.ok(/That also meant a potential (?:valuation and )?seller instruction sitting inside the same enquiry was never explored\./.test(body),
        `${shape}: and its consequence is the separate wider beat`);
      assert.ok(!/would have (?:won|got|secured|listed)|definitely|certainly/i.test(body),
        `${shape}: it is never claimed the instruction would definitely have followed`);
    }

    // Where the enquiry did NOT declare one, nothing is manufactured.
    const noSeller = await personalise('weak', { wider_observation: '', wider_consequence: '' });
    assert.ok(!/property of my own|seller instruction|valuation/i.test(noSeller.email_body),
      'an enquiry with no declared seller side gets no seller paragraph at all');
    assert.ok(noSeller.email_body.includes(ADDITIONAL_FINDINGS_HOOK_LINE), 'and the email simply closes');
    ok('the seller opportunity is handled as its own two-sentence wider beat when the enquiry declared it, is never claimed to be a certain instruction, and is never invented when it was not declared');
  }

  // ── The story reads as a story, not a list of problems ──
  {
    for (const shape of ['silent', 'weak', 'seller']) {
      const body = (await personalise(shape)).email_body;
      assert.ok(body, `${shape}: sendable`);
      assert.ok(!/^\s*[-*\d]+[.)]\s/m.test(body), `${shape}: no bullet or numbered list anywhere in the email`);
      assert.ok(!/audit|grade|score|report/i.test(body), `${shape}: it never reads as an audit, a grading or a report`);
      assert.ok(!/NOVUS/i.test(body), `${shape}: the email does not sell NOVUS`);
      assert.strictEqual((body.match(/breakdown/g) || []).length, 1, `${shape}: the breakdown is offered exactly once`);
      assert.strictEqual((body.match(/couple of/g) || []).length, 1, `${shape}: and "a couple of things" is said exactly once`);
      assert.ok(body.endsWith('Happy to send it over if you\'d like to see it.\n\nJoe'), `${shape}: the offer is the last thing before the sign-off`);
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
    // Derived from the story itself, so this stays a restatement however the
    // fixture's wording changes.
    const repeated = await personalise('weak', {
      commercial_consequence: STORIES.weak.main_finding.replace(/^that /, ''),
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
      wider_consequence: 'a property of my own that I was looking to sell never came into the conversation.',
      commercial_consequence: 'a property of my own that I was looking to sell never came into the conversation.',
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
