// scripts/novus-personalisation-story-selection-selftest.mjs — hermetic test
// (no network, no creds) for the refactor that made DIAGNOSIS_FINDINGS the
// canonical story source and turned Personalisation into a SELECTION step:
//
//   COMMUNICATIONS -> INTELLIGENCE -> DIAGNOSIS -> DIAGNOSIS_FINDINGS ->
//   PERSONALISATION + PROBE -> EMAIL
//
// The sibling suite (novus:probe-personalisation-selftest) covers the guards
// that were already there. This one covers the eight probe shapes the change
// has to be right about, END TO END, asserting the COMPLETE email body for the
// ones that matter:
//
//   1. no response
//   2. one genuine but weak response
//   3. strong response + a separate seller opportunity
//   4. the 0007-style duplicate seller story
//   5. multiple distinct findings
//   6. no distinct wider finding
//   7. property value present
//   8. property value absent
//
// THE ONE IT EXISTS FOR IS 4. A probe whose sharpest finding is the seller /
// valuation opportunity used to get that opportunity as its main story AND
// again as its wider beat: two paragraphs, one event, told twice. Nothing
// could see it, because the two paragraphs were different SENTENCES about the
// same THING and only the sentences were compared. Selecting each beat by
// finding index makes the event itself comparable, and this suite asserts the
// duplicate never reaches an email — by index, and by wording.
//
// Run: npm run novus:personalisation-story-selection-selftest

import assert from 'node:assert';
import { personaliseProbe, findingsAreDistinct, isDistinctText, _internal } from '../lib/probe-personalisation.mjs';
import {
  ADDITIONAL_FINDINGS_HOOK_LINE, CTA_LINE, NO_REPLY_LINE,
  NO_RESPONSE_BREAKDOWN_LINE, NO_RESPONSE_CTA_LINE,
  FAIR_OBSERVATION_PREFIX, MAIN_FINDING_PREFIX, THAT_MEANT_PREFIX, THAT_ALSO_MEANT_PREFIX,
} from '../lib/email-assembly.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

const PROBE = {
  probe_id: 'prb_sel_001',
  property_address: 'Fox Cottage, Chevington',
  property_price: '£425,000',
  probe_timestamp: '2026-08-11T10:14:00Z',
  enquiry_text: 'Interested in viewing. Declared: has a property of my own to sell, not yet on the market.',
};

function intelligence(overrides = {}) {
  return {
    human_contact: 'yes',
    response_hours: 3.2,
    contact_attempts: 3,
    follow_ups: 2,
    channels_used: 'voice,email',
    viewing_progression: 'invited',
    buyer_qualification: 'none',
    seller_recognition: 'none',
    grade: 'D',
    ...overrides,
  };
}

const DIAGNOSIS = {
  strengths: 'Persistent follow-up across two channels.',
  missed_opportunities: 'The declared seller was never converted to a valuation.',
  commercial_implication: 'A Fox Cottage enquiry carried a valuation nobody reached.',
  novus_opportunity: 'Core (front desk)',
  diagnosis_summary: 'Persistent, unqualified, seller side untouched.',
};

// The findings tab, in the order Diagnosis persists it: problems and
// opportunities first, positives appended after.
const F = {
  persistence: { finding_index: 4, finding_type: 'positive', finding: 'The team followed up quickly.', evidence: 'Three attempts across phone and email within one day.', significance_note: 'Shows strong persistence.' },
  unqualified: { finding_index: 1, finding_type: 'problem', finding: "The conversation did not establish the buyer's position.", evidence: 'No questions about budget or timescale.', significance_note: 'The enquiry was not properly qualified.' },
  seller: { finding_index: 2, finding_type: 'opportunity', finding: 'The prospect disclosed a property of their own to sell.', evidence: 'The enquiry declared a property to sell, not yet on the market; no valuation was ever offered.', significance_note: 'Potential valuation/seller instruction was not explored.' },
  noViewing: { finding_index: 3, finding_type: 'problem', finding: 'No viewing was ever actually booked.', evidence: 'Viewing progression recorded as invited, never booked.', significance_note: 'The enquiry stopped one step short of the thing that moves a sale.' },
};

function findings(...keys) {
  return keys.map((k) => F[k]).sort((a, b) => a.finding_index - b.finding_index);
}

function story(overrides = {}) {
  return {
    story_reasoning: '1. Finding 4. 2. Finding 1. 3. Nobody found out whether I could proceed. 4. Finding 2. 5. The valuation was never reached.',
    positive_finding_index: 4,
    main_finding_index: 1,
    wider_finding_index: 2,
    primary_narrative: 'Three attempts went into pushing a viewing while neither side of the enquiry was ever qualified.',
    supporting_findings: '',
    fair_observation: 'you followed up with me three times across phone and email inside a day.',
    main_finding: "that the conversation never established my position — nothing about budget, funding or timescale came up.",
    commercial_consequence: 'a £425,000 buyer enquiry was being chased without anyone knowing whether I could proceed at all.',
    wider_observation: "I'd also said in the enquiry that I had a property of my own to sell that wasn't yet on the market.",
    wider_consequence: 'a potential seller instruction sitting inside the same enquiry was never explored.',
    novus_counterfactual: 'NOVUS would have made the same three attempts and qualified both sides on the first one.',
    ...overrides,
  };
}

// One probe through the layer, with a caller the test controls so retries are
// observable. -> { row, calls, prompts }
async function personalise({ result, probe = PROBE, intel = intelligence(), rows = findings('unqualified', 'seller', 'noViewing', 'persistence') } = {}) {
  const prompts = [];
  __setAiCallerForTests(async ({ prompt }) => { prompts.push(prompt); return typeof result === 'function' ? result(prompts.length) : result; });
  const row = await personaliseProbe(probe, intel, DIAGNOSIS, rows, {});
  return { row, calls: prompts.length, prompts };
}

// The email a probe of this shape should produce, paragraph by paragraph.
function expectedBody({ date, property, fair, main, consequence, widerObservation, widerConsequence, variant = 'normal' }) {
  const paragraphs = ['Hi {{first_name}},', `We sent your team an enquiry on ${date} about ${property}.`];
  if (variant === 'no_response') paragraphs.push(NO_REPLY_LINE);
  else {
    paragraphs.push(`${FAIR_OBSERVATION_PREFIX}${fair}`);
    paragraphs.push(`${MAIN_FINDING_PREFIX}${main}`);
  }
  paragraphs.push(`${THAT_MEANT_PREFIX}${consequence}`);
  if (widerObservation) {
    paragraphs.push(widerObservation);
    if (widerConsequence) paragraphs.push(`${THAT_ALSO_MEANT_PREFIX}${widerConsequence}`);
  }
  if (variant === 'no_response') paragraphs.push(NO_RESPONSE_BREAKDOWN_LINE, NO_RESPONSE_CTA_LINE);
  else paragraphs.push(ADDITIONAL_FINDINGS_HOOK_LINE, CTA_LINE);
  paragraphs.push('Joe');
  return paragraphs.join('\n\n');
}

// "Does any one thing get said twice?" — the assertion this whole suite is
// for. Compares every prospect-facing paragraph against every other one, and
// fails on an outright or near-outright restatement.
function assertNoDuplicatedStory(row, label) {
  const paragraphs = [row.fair_observation, row.main_finding, row.commercial_consequence, row.wider_observation, row.wider_consequence]
    .map((t) => String(t || '').trim())
    .filter(Boolean);
  for (let i = 0; i < paragraphs.length; i += 1) {
    for (let j = i + 1; j < paragraphs.length; j += 1) {
      assert.ok(isDistinctText(paragraphs[i], paragraphs[j]),
        `${label}: "${paragraphs[i]}" and "${paragraphs[j]}" are the same point told twice`);
    }
  }
  // ...and the selection behind them names distinct findings.
  if (row.main_finding_index !== '' && row.wider_finding_index !== '') {
    assert.notStrictEqual(row.main_finding_index, row.wider_finding_index,
      `${label}: the main and wider beats rest on the same finding`);
  }
}

async function run() {
  console.log('Personalisation story selection — the eight probe shapes\n');

  // ── 1. NO RESPONSE ────────────────────────────────────────────────────────
  {
    const noReplyFindings = [
      { finding_index: 1, finding_type: 'problem', finding: 'The enquiry was never replied to.', evidence: 'No communications recorded in the 4-day window.', significance_note: 'A buyer and a seller lead both lost in silence.' },
      F.seller,
    ];
    const { row, calls } = await personalise({
      intel: intelligence({ human_contact: 'none', response_hours: '', contact_attempts: 0, follow_ups: 0, channels_used: '' }),
      rows: noReplyFindings,
      // The model is told the variant, but even a model that ignores it and
      // invents a conversation cannot get one into the email.
      result: story({
        positive_finding_index: 1,
        main_finding_index: 1,
        wider_finding_index: 2,
        fair_observation: 'you came back to me quickly and asked good questions.',
        main_finding: 'that the call never got to my timescale.',
        commercial_consequence: 'a £425,000 buyer enquiry never got as far as a conversation with anyone.',
      }),
    });

    assert.strictEqual(calls, 1, 'a no-response probe costs exactly one AI call');
    assert.strictEqual(row.email_variant, 'no_response');
    assert.strictEqual(row.positive_finding_index, '', 'a no-response email cannot carry a positive selection, whatever the model picks');
    // The main finding index IS still selected: the no-response email prints
    // no main_finding paragraph, but its commercial consequence is mandatory
    // and still has to rest on a finding — the silence itself.
    assert.strictEqual(row.main_finding_index, 1, 'the consequence of the silence is grounded in the finding that records it');
    assert.ok(row.evidence.includes('No communications recorded in the 4-day window.'),
      'and the stored evidence is that finding\'s own evidence, not a quote from a conversation that never happened');
    assert.strictEqual(row.fair_observation, '', 'and no invented praise reaches the email');
    assert.strictEqual(row.main_finding, '', 'and no invented conversation either');
    assert.strictEqual(row.email_body, expectedBody({
      variant: 'no_response',
      date: '11 August',
      property: 'Fox Cottage',
      consequence: 'a £425,000 buyer enquiry never got as far as a conversation with anyone.',
      widerObservation: story().wider_observation,
      widerConsequence: story().wider_consequence,
    }), 'the complete no-response email body is exactly the locked structure');
    assertNoDuplicatedStory(row, 'no response');
    ok('1. NO RESPONSE — the email is the silence, its consequence and the declared seller beat; no positive is invented and no conversation is described');
  }

  // ── 2. ONE GENUINE BUT WEAK RESPONSE ──────────────────────────────────────
  {
    const weakFindings = [
      { finding_index: 1, finding_type: 'problem', finding: 'The single reply engaged with nothing in the enquiry.', evidence: 'One generic acknowledgement, no question asked.', significance_note: 'A reply that carries nothing forward reads as no reply.' },
      { finding_index: 2, finding_type: 'positive', finding: 'The enquiry was answered by a person.', evidence: 'A human email 3.2 hours after the enquiry.', significance_note: 'Shows enquiries do reach a person.' },
    ];
    const { row, calls } = await personalise({
      rows: weakFindings,
      result: story({
        positive_finding_index: 2,
        main_finding_index: 1,
        wider_finding_index: null,
        fair_observation: 'you did get back to me the same day, with an email acknowledging the enquiry.',
        main_finding: 'that the reply did not mention the property or answer anything I had actually asked.',
        commercial_consequence: 'a live buyer enquiry was closed off in one message without anyone establishing what I needed or what should happen next.',
        wider_observation: '',
        wider_consequence: '',
      }),
    });

    assert.strictEqual(calls, 1, 'a weak-but-genuine response still costs one AI call');
    assert.strictEqual(row.positive_finding_index, 2, 'the fair observation rests on the one genuine positive');
    assert.strictEqual(row.main_finding_index, 1);
    assert.strictEqual(row.wider_finding_index, '', 'there is no second finding, so there is no wider beat');
    assert.strictEqual(row.email_body, expectedBody({
      date: '11 August',
      property: 'Fox Cottage',
      fair: 'you did get back to me the same day, with an email acknowledging the enquiry.',
      main: 'that the reply did not mention the property or answer anything I had actually asked.',
      consequence: 'a live buyer enquiry was closed off in one message without anyone establishing what I needed or what should happen next.',
    }), 'the complete email body is the three-beat structure with no wider paragraphs');
    assertNoDuplicatedStory(row, 'weak response');
    ok('2. ONE GENUINE BUT WEAK RESPONSE — a small factual positive still opens the email, and with only one problem there is no wider beat to pad with');
  }

  // ── 3. STRONG RESPONSE + A SEPARATE SELLER OPPORTUNITY ────────────────────
  {
    const { row, calls } = await personalise({
      intel: intelligence({ response_hours: 0.8, viewing_progression: 'booked', buyer_qualification: 'thorough' }),
      result: story(),
    });

    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(
      [row.positive_finding_index, row.main_finding_index, row.wider_finding_index], [4, 1, 2],
      'three different findings carry the three beats',
    );
    assert.strictEqual(row.narrative_finding_indexes, '1,2,4', 'and the existing narrative-finding structure records exactly those');
    assert.strictEqual(row.email_body, expectedBody({
      date: '11 August',
      property: 'Fox Cottage',
      fair: story().fair_observation,
      main: story().main_finding,
      consequence: story().commercial_consequence,
      widerObservation: story().wider_observation,
      widerConsequence: story().wider_consequence,
    }), 'the complete email body carries the full five-beat structure');
    assertNoDuplicatedStory(row, 'strong + seller');
    ok('3. STRONG RESPONSE + SEPARATE SELLER OPPORTUNITY — the positive, the qualification gap and the seller opportunity are three different findings, so all five paragraphs are earned');
  }

  // ── 4. THE 0007 DUPLICATE: the seller opportunity as BOTH beats ───────────
  //    This is the shape the whole change exists to fix. It is refused two
  //    independent ways, and neither of them lets it reach an email.
  {
    // 4a. By INDEX — the same finding selected twice.
    let attempt = 0;
    const bySameIndex = await personalise({
      result: () => {
        attempt += 1;
        return story({
          main_finding_index: 2,
          wider_finding_index: 2,
          main_finding: 'that I had told you I had a property of my own to sell, and the conversation stayed entirely on the purchase.',
          commercial_consequence: 'a valuation that was sitting inside this enquiry was never even discussed.',
        });
      },
    });
    assert.strictEqual(bySameIndex.calls, 3, 'the duplicate selection is rejected and re-asked, up to the bounded limit');
    assert.strictEqual(bySameIndex.row.wider_finding_index, '', 'and the wider beat is dropped rather than printed');
    assert.strictEqual(bySameIndex.row.wider_observation, '', 'so the seller story does not appear a second time');
    assert.strictEqual(bySameIndex.row.wider_consequence, '');
    assert.strictEqual(bySameIndex.row.main_finding_index, 2, 'the seller opportunity is still the main story, told once');
    assert.strictEqual((bySameIndex.row.email_body.match(/property of my own to sell/g) || []).length, 1,
      'THE 0007 ASSERTION: the seller story appears exactly once in the email body');
    assert.ok(!bySameIndex.row.email_body.includes(THAT_ALSO_MEANT_PREFIX), 'and the wider paragraph never appears at all');
    assertNoDuplicatedStory(bySameIndex.row, '0007 by index');

    // 4b. By WORDING — two DIFFERENT finding numbers that are the same event.
    const sellerAgain = { finding_index: 3, finding_type: 'opportunity', finding: 'The prospect disclosed a property of their own that they need to sell.', evidence: 'The enquiry declared a property to sell; no valuation was offered.', significance_note: 'The valuation was never explored.' };
    const byWording = await personalise({
      rows: [F.unqualified, F.seller, sellerAgain, F.persistence],
      result: story({ main_finding_index: 2, wider_finding_index: 3 }),
    });
    assert.strictEqual(byWording.calls, 3, 'a differently-numbered restatement of the same event is rejected too');
    assert.strictEqual(byWording.row.wider_finding_index, '', 'and never becomes the wider beat');
    assert.strictEqual(byWording.row.wider_observation, '', 'so the same event is not printed twice under two numbers');
    assertNoDuplicatedStory(byWording.row, '0007 by wording');

    // 4c. The unit behind both.
    assert.strictEqual(findingsAreDistinct(F.seller, sellerAgain), false, 'two findings describing the same disclosure are not distinct');
    assert.strictEqual(findingsAreDistinct(F.seller, F.unqualified), true, 'the seller opportunity and the qualification gap are');
    assert.strictEqual(findingsAreDistinct(F.seller, null), true, 'nothing to compare against is not a duplicate');

    // 4d. ...and the same story written into BOTH PARAGRAPHS, even off a
    // correct selection, is caught on the wording.
    const byParagraph = await personalise({
      result: story({
        main_finding_index: 2,
        wider_finding_index: 1,
        main_finding: 'that I had told you I had a property of my own to sell, and it never came into the conversation.',
        wider_observation: 'I had told you I had a property of my own to sell, and it never came into the conversation.',
      }),
    });
    assert.strictEqual(byParagraph.calls, 3,
      'a wider observation that restates the main finding is sent back too, not just dropped quietly');
    assert.strictEqual(byParagraph.row.wider_observation, '',
      'and it is dropped even though the selection itself was valid');
    assert.strictEqual((byParagraph.row.email_body.match(/property of my own to sell/g) || []).length, 1,
      'so the point still lands exactly once');
    assertNoDuplicatedStory(byParagraph.row, '0007 by paragraph');
    ok('4. THE 0007 DUPLICATE — a seller opportunity used as both the main story and the wider beat is refused by index, by a differently-numbered restatement, and by wording; it reaches the email exactly once');
  }

  // ── 5. MULTIPLE DISTINCT FINDINGS ─────────────────────────────────────────
  {
    const { row } = await personalise({
      result: story({ main_finding_index: 1, wider_finding_index: 2, supporting_findings: 'No viewing was ever actually booked either.' }),
    });
    assert.strictEqual(row.narrative_finding_indexes, '1,2,4', 'the selection names three of the four findings');
    assert.ok(row.supporting_findings.includes('No viewing'), 'the fourth is recorded internally as a supporting finding');
    assert.ok(!row.email_body.includes('No viewing was ever actually booked'),
      'and is never dumped into the email — that is the question the breakdown exists to answer');
    assert.strictEqual(row.email_body.split('\n\n').length, 10,
      'the email is still the locked ten paragraphs of the full five-beat structure, not a list of findings');
    assertNoDuplicatedStory(row, 'multiple findings');
    ok('5. MULTIPLE DISTINCT FINDINGS — three are selected into the three beats, the rest stay internal supporting findings, and the email never becomes a list');
  }

  // ── 6. NO DISTINCT WIDER FINDING ──────────────────────────────────────────
  {
    const { row, calls } = await personalise({
      rows: findings('unqualified', 'persistence'),
      result: story({ wider_finding_index: null, wider_observation: '', wider_consequence: '' }),
    });
    assert.strictEqual(calls, 1, 'null is a complete answer — it costs no retry');
    assert.strictEqual(row.wider_finding_index, '', 'nothing is stored as the wider selection');
    assert.strictEqual(row.wider_observation, '', 'and no wider observation is forced');
    assert.strictEqual(row.wider_consequence, '');
    assert.ok(!row.email_body.includes(THAT_ALSO_MEANT_PREFIX), 'the wider paragraphs are simply absent');
    assert.ok(row.email_body.endsWith(`${ADDITIONAL_FINDINGS_HOOK_LINE}\n\n${CTA_LINE}\n\nJoe`), 'and the locked closing still runs');
    assert.strictEqual(row.email_body, expectedBody({
      date: '11 August',
      property: 'Fox Cottage',
      fair: story().fair_observation,
      main: story().main_finding,
      consequence: story().commercial_consequence,
    }), 'the complete email body is the three-beat structure');
    assertNoDuplicatedStory(row, 'no wider finding');
    ok('6. NO DISTINCT WIDER FINDING — null is accepted first time, nothing is invented to fill the beat, and the email is complete without it');
  }

  // ── 7. PROPERTY VALUE PRESENT ─────────────────────────────────────────────
  {
    const { row, prompts } = await personalise({ result: story() });
    assert.ok(prompts[0].includes('Property value: £425,000'), 'the probe\'s own value reaches the prompt');
    assert.ok(row.commercial_consequence.includes('£425,000'), 'and is allowed to make the scale of the opportunity obvious');
    assert.ok(row.email_body.includes('£425,000'), 'in the email the agency actually reads');
    assert.strictEqual((row.email_body.match(/£/g) || []).length, 1, 'exactly once — it is never repeated across paragraphs');
    ok('7. PROPERTY VALUE PRESENT — the probe\'s own price reaches the prompt and is allowed to sharpen the consequence, once');
  }

  // ── 8. PROPERTY VALUE ABSENT ──────────────────────────────────────────────
  {
    const { row, prompts } = await personalise({
      probe: { ...PROBE, property_price: '' },
      result: story({ commercial_consequence: 'a £425,000 buyer enquiry was being chased without anyone knowing whether I could proceed. Nobody established my position at any point.' }),
    });
    assert.ok(prompts[0].includes('not on file — you may not state ANY monetary figure at all'),
      'the prompt says plainly that no figure may be used');
    assert.ok(!/£/.test(row.commercial_consequence), 'and the sentence carrying an unbacked figure is stripped');
    assert.ok(/nobody established my position/i.test(row.commercial_consequence),
      'while the qualitative sentence beside it survives, de-capitalised to continue the fixed opener');
    assert.ok(!/£/.test(row.email_body), 'no currency figure reaches the email at all');
    assert.ok(row.email_body, 'and the email is still sendable on what is left');
    assertNoDuplicatedStory(row, 'no property value');
    ok('8. PROPERTY VALUE ABSENT — no monetary figure survives anywhere, the qualitative half of the sentence does, and the email is still sendable');
  }

  // ── PHASE 8: what this costs, measured rather than claimed ────────────────
  {
    const { prompts } = await personalise({ result: story() });
    const { SYSTEM_PROMPT } = _internal;
    const inputChars = SYSTEM_PROMPT.length + prompts[0].length;
    // ~4 characters per token is the usual English rule of thumb; this is an
    // order-of-magnitude check, not a billing figure.
    const approxTokens = Math.round(inputChars / 4);
    console.log(`      [usage] one probe: 1 AI call, ~${approxTokens} input tokens (${inputChars} chars: ${SYSTEM_PROMPT.length} system + ${prompts[0].length} prompt)`);
    assert.ok(prompts.length === 1, 'a probe whose answer satisfies the contract still costs exactly one call');

    // ...and a probe that never satisfies it is BOUNDED.
    const { calls } = await personalise({ result: story({ commercial_consequence: '' }) });
    assert.strictEqual(calls, _internal.MAX_PERSONALISATION_ATTEMPTS, 'a probe that never satisfies the contract is bounded at the retry limit');
    assert.strictEqual(_internal.MAX_PERSONALISATION_ATTEMPTS, 3, 'which is 3, unchanged by this refactor');
    ok(`the AI cost is unchanged per probe — one call for a good answer, hard-bounded at ${_internal.MAX_PERSONALISATION_ATTEMPTS} for one that never satisfies the contract`);
  }

  console.log(`\n${passed} checks passed.`);
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
