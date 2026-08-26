// scripts/novus-personalisation-contract-selftest.mjs — the OUTPUT CONTRACT
// for Personalisation, hermetic and AI-free.
//
// The simplified architecture (findings-driven selection, two Instantly
// variables, no email assembly, at most two AI calls) is not what regressed.
// The CONTRACT regressed: across 14 historical probes, fair_observation was
// blank 9 times, commercial_consequence 5, email_commercial_hook 5, tool
// markup reached primary_narrative 4 times, and 8 of 14 demos compiled
// needs_review. Every check below pins one of those failures shut.
//
// Sibling suites, deliberately not duplicated here:
//   novus:email-personalisation-selftest   the simplified email's own shape
//   novus:diagnosis-findings-flow-selftest DIAGNOSIS_FINDINGS -> PERSONALISATION
//   novus:demo-selftest                    the demo compiler in full
//   novus:historical-replay (not a test)   the 14-probe before/after report

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';
import { normaliseToolInput, containsToolMarkup, splitLeakedValue, AiStructuredOutputError } from '../lib/ai-structured-output.mjs';
import {
  personaliseProbe, buildOpportunityShape, hookFailureAgainstObservation,
  quantifiesOpportunityShape, readsAsThirdPersonProspect, normalizeCurrencyFigure,
  readsAsConsultantSpeak, claimsUnaskedQuestions, namesConcreteOutcome,
  introducesUnselectedFinding, readsAsUnfairOutcomeCriticism,
  agencyMadeNextStepAttempt, secondHookFailure, isDistinctText,
  hasUnreliableVoicemailEvidence, makesUnsupportedVoicemailClaim, _internal,
} from '../lib/probe-personalisation.mjs';
import { buildDemoRow, reviewReasonsFor } from '../lib/demos.mjs';
import { needsPersonalisation } from '../lib/personalisation-rebuild.mjs';

let passed = 0;
const ok = (m) => { passed += 1; console.log(`  ✓ ${m}`); };
const has = (v) => Boolean(String(v ?? '').trim());

const PROBE = {
  probe_id: 'prb_contract_1', agency_id: 'agc_contract', probe_reference: 'NOV-C-1',
  property_address: 'Grey Lady Place', property_price: '£450,000.00',
  portal: 'Rightmove', probe_timestamp: '2026-08-21T20:14:00Z',
  observation_deadline: '2026-08-25T20:14:00Z',
  enquiry_text: 'Interested in viewing this property. Also declared: has a property to sell — it is not yet on the market.',
};
const BUYER_ONLY_PROBE = { ...PROBE, probe_id: 'prb_contract_2', enquiry_text: 'Interested in viewing this property. Please call me back to arrange a time.' };

const F = {
  positive: { finding_index: 4, finding_type: 'positive', finding: 'The team replied quickly and progressed the viewing.', evidence: 'A human reply arrived in 8 minutes and offered a viewing slot.', significance_note: 'Fast buyer-side handling.' },
  noFollowUp: { finding_index: 1, finding_type: 'problem', finding: 'No follow-up was sent after the first reply.', evidence: 'Contact attempts: 1; follow-ups: 0.', significance_note: 'The enquiry had no second attempt.' },
  sellerMissed: { finding_index: 2, finding_type: 'opportunity', finding: 'The declared seller opportunity was missed completely.', evidence: 'The enquiry declared a property to sell; nobody mentioned it.', significance_note: 'A potential valuation was invisible.' },
  qualification: { finding_index: 3, finding_type: 'problem', finding: 'Buyer qualification was weak and incomplete.', evidence: 'No budget, funding or timescale questions were asked.', significance_note: 'Buyer readiness remained unknown.' },
  sellerWeak: { finding_index: 5, finding_type: 'opportunity', finding: 'The declared seller opportunity was recognised but never progressed.', evidence: 'The team asked whether the property was on the market but offered no valuation.', significance_note: 'Recognition did not become progression.' },
  noResponse: { finding_index: 6, finding_type: 'problem', finding: 'No meaningful human response arrived in the four-day observation period.', evidence: 'Human contact: none across four days.', significance_note: 'No conversation was created.' },
  slowCall: { finding_index: 7, finding_type: 'problem', finding: 'The only contact came 37 hours later and offered no viewing.', evidence: 'Response time 37.1 hours; no viewing invitation.', significance_note: 'The buyer waited a day and a half.' },
};
const ordered = (...items) => [...items].sort((a, b) => a.finding_index - b.finding_index);

const INTEL = {
  human_contact: 'yes', response_hours: 0.13, contact_attempts: 2, follow_ups: 1,
  channels_used: 'email', viewing_progression: 'invited', seller_recognition: 'none', grade: 'D',
};

function answer(overrides = {}) {
  return {
    story_reasoning: '1. positive 4. 2. main 1. 3. second 2.',
    positive_finding_index: 4, main_finding_index: 1, wider_finding_index: 2,
    primary_narrative: 'The buying side moved and the selling side never did.',
    supporting_findings: '',
    fair_observation: 'you replied quickly and progressed the viewing.',
    main_finding: 'no follow-up was sent and the seller side was never raised.',
    commercial_consequence: 'a declared valuation opportunity was never opened at all.',
    // WHAT HAPPENED / WHY IT MATTERS COMMERCIALLY / THE EXTRA THING THAT
    // CHANGES HOW THE ENQUIRY READS — three different jobs, and the guards
    // below exist to keep them that way.
    email_observation: "You got back to me almost instantly, but no follow-ups were sent and nobody picked up that I'd also said I had a property to sell.",
    email_commercial_hook: "That seller wasn't a cold database record — they were already engaging with your branch as a buyer.",
    email_commercial_hook_email_2: 'You handled the buying side quickly; the part worth a look is that the same message had already given you a second reason to call.',
    novus_counterfactual: 'NOVUS would have opened both threads in the same conversation.',
    ...overrides,
  };
}

async function run({ probe = PROBE, findings, intelligence = {}, reply }) {
  let calls = 0;
  const toolNames = [];
  __setAiCallerForTests(async ({ tool }) => {
    calls += 1;
    toolNames.push(tool.name);
    return typeof reply === 'function' ? reply(calls, tool) : reply;
  });
  const row = await personaliseProbe(
    probe, { ...INTEL, ...intelligence },
    { diagnosis_summary: 'final', novus_opportunity: 'Core (front desk)' },
    findings, { agency_name: 'Example Estates' },
  );
  return { row, calls, toolNames };
}

const compileDemo = (row, { findings, intelligence = {}, probe = PROBE }) => buildDemoRow({
  probe, agency: { agency_name: 'Example Estates' },
  intelligence: { ...INTEL, ...intelligence }, findings,
  personalisation: { personalisation_id: 'psn_contract', ...row },
  communications: [], now: '2026-08-25T12:00:00.000Z',
});

async function main() {
  console.log('Personalisation output contract — hermetic selftest\n');

  // ══ 1-8: the eight probe shapes ═══════════════════════════════════════════
  {
    const shapes = [
      {
        name: '1. no response + seller opportunity',
        findings: ordered(F.noResponse, F.sellerMissed),
        intelligence: { human_contact: 'none', response_hours: '', contact_attempts: 0, follow_ups: 0, viewing_progression: 'none' },
        reply: answer({
          positive_finding_index: null, main_finding_index: 6, wider_finding_index: 2,
          fair_observation: '', main_finding: '',
          commercial_consequence: 'no buyer or seller conversation was ever created.',
          email_observation: "We didn't receive a response during the four-day observation period, and nobody picked up that I'd also said I had a property to sell.",
          email_commercial_hook: "That's 2 live opportunities from 1 enquiry, with 0 conversations created.",
          email_commercial_hook_email_2: 'The issue here was not qualification or follow-up quality — the enquiry never got a genuine human response in the first place.',
        }),
        expect: (row) => {
          assert.strictEqual(row.fair_observation, '', 'no fake positive on a no-response probe');
          assert.strictEqual(row.positive_finding_index, '');
          assert.ok(has(row.commercial_consequence) && has(row.email_observation) && has(row.email_commercial_hook));
          assert.match(row.email_commercial_hook, /0 conversations/,
            'nobody came back at all, so an outcome criticism here is simply accurate');
          assert.ok(has(row.email_commercial_hook_email_2));
        },
      },
      {
        name: '2. fast personalised response + no progression',
        findings: ordered(F.positive, F.noFollowUp),
        reply: answer({
          wider_finding_index: null,
          email_observation: 'You got back to me almost instantly, but nothing followed that first reply.',
          email_commercial_hook: 'So 1 enquiry got a fast first reply and 0 follow-ups after it.',
          email_commercial_hook_email_2: 'Speed was never the issue here; the gap is that one fast reply and a worked enquiry are two different things.',
        }),
        expect: (row) => {
          assert.strictEqual(row.narrative_finding_indexes, '1,4');
          assert.ok(has(row.fair_observation) && has(row.main_finding) && has(row.commercial_consequence));
        },
      },
      {
        name: '3. genuine positive + seller missed',
        findings: ordered(F.positive, F.sellerMissed),
        reply: answer({ main_finding_index: 2, wider_finding_index: null }),
        expect: (row) => { assert.strictEqual(row.main_finding_index, 2); assert.ok(has(row.fair_observation)); },
      },
      {
        name: '4. positive + seller missed + buyer qualification missed',
        findings: ordered(F.positive, F.sellerMissed, F.qualification),
        reply: answer({ main_finding_index: 2, wider_finding_index: 3 }),
        expect: (row) => { assert.strictEqual(row.narrative_finding_indexes, '2,3,4'); },
      },
      {
        name: '5. buyer progressed + seller missed',
        findings: ordered(F.positive, F.sellerMissed),
        intelligence: { viewing_progression: 'booked' },
        reply: answer({
          main_finding_index: 2, wider_finding_index: null,
          email_observation: "You handled the viewing side well, but nobody picked up that I'd also said I had a property to sell.",
          email_commercial_hook: 'So the buyer side moved forward, while the potential seller was missed entirely.',
          email_commercial_hook_email_2: 'The interesting part is that the buying side worked exactly as it should — the vendor had already volunteered themselves in the same message.',
        }),
        expect: (row) => { assert.match(row.email_commercial_hook, /potential seller was missed/); },
      },
      {
        name: '6. seller recognised but weakly progressed',
        findings: ordered(F.positive, F.sellerWeak),
        intelligence: { seller_recognition: 'asked_position' },
        reply: answer({
          main_finding_index: 5, wider_finding_index: null,
          email_observation: 'You did ask whether my place was on the market, but nothing came back about actually valuing it.',
          email_commercial_hook: 'So the seller opportunity was seen, and 0 seller next steps came out of it.',
          email_commercial_hook_email_2: 'Spotting a vendor and offering to value their place are two different things, and only the first of them happened here.',
        }),
        expect: (row) => { assert.strictEqual(row.main_finding_index, 5); assert.ok(has(row.email_commercial_hook)); },
      },
      {
        name: '7. no seller opportunity (buyer-only enquiry)',
        probe: BUYER_ONLY_PROBE,
        findings: ordered(F.positive, F.noFollowUp),
        reply: answer({
          wider_finding_index: null,
          email_observation: 'You came back to me quickly, but nothing followed that first reply.',
          email_commercial_hook: 'So 1 enquiry received 1 reply and 0 follow-ups.',
          email_commercial_hook_email_2: 'One reply is not the same as a worked enquiry, and the difference between them is where a buyer like me gets lost.',
        }),
        expect: (row) => {
          assert.doesNotMatch(
            `${row.email_observation} ${row.email_commercial_hook} ${row.email_commercial_hook_email_2}`,
            /property to sell|valuation/i, 'a buyer-only enquiry never grows a seller beat');
        },
      },
      {
        name: '8. strong handling — no manufactured weakness',
        findings: [F.positive],
        intelligence: { viewing_progression: 'booked', seller_recognition: 'valuation_booked' },
        reply: answer({
          main_finding_index: null, wider_finding_index: null,
          main_finding: '', commercial_consequence: '',
          email_observation: 'You came back within minutes, booked the viewing and picked up that I had a place to sell too.',
          email_commercial_hook: 'So both the viewing and the valuation came out of that one enquiry.',
          email_commercial_hook_email_2: 'Worth knowing how rare that is: most branches work the buying side of a message like mine and never notice the second half.',
        }),
        expect: (row) => {
          assert.strictEqual(row.main_finding_index, '', 'no problem finding exists, so none is selected');
          assert.strictEqual(row.main_finding, '', 'and no weakness is invented to fill the slot');
          assert.strictEqual(row.commercial_consequence, '');
          assert.ok(has(row.fair_observation), 'the genuine positive is still credited');
        },
      },
    ];

    for (const shape of shapes) {
      const { row, calls } = await run(shape);
      assert.ok(calls <= _internal.MAX_PERSONALISATION_ATTEMPTS, `${shape.name}: within the AI-call cap`);
      shape.expect(row);
      ok(shape.name);
    }
  }

  // ══ 9: demo-required fields are never blank where valid findings exist ════
  {
    // Every wording guard fires at once on copy that is TRUE. The old code
    // blanked all three demo fields silently and never told the correction
    // call; the row persisted half-empty and the demo failed to compile.
    const hostile = answer({
      fair_observation: 'you eventually got back to me, although it took a while.',   // snuck_criticism
      commercial_consequence: 'no follow-up was sent and the seller side was never raised.', // restates main_finding
    });
    const { row, calls, toolNames } = await run({
      findings: ordered(F.positive, F.noFollowUp, F.sellerMissed),
      reply: (call) => (call === 1 ? hostile : {
        fair_observation: 'you replied within minutes of the enquiry landing.',
        commercial_consequence: 'a declared valuation opportunity was never opened at all.',
      }),
    });
    assert.strictEqual(calls, 2, 'exactly one bounded correction');
    assert.strictEqual(toolNames[1], 'correct_probe_personalisation_fields', 'and it is SCOPED to the failed fields');
    for (const field of ['fair_observation', 'main_finding', 'commercial_consequence']) {
      assert.ok(has(row[field]), `${field} is populated after the scoped repair`);
    }
    ok('9. demo-required fields survive a wording failure via a scoped repair, not a blank');
  }
  {
    // And when the repair ALSO misses, a true sentence beats a blank.
    const hostile = answer({ fair_observation: 'you eventually got back to me, although it took a while.' });
    const { row, calls } = await run({
      findings: ordered(F.positive, F.noFollowUp, F.sellerMissed),
      reply: () => hostile,
    });
    assert.strictEqual(calls, 2);
    assert.ok(has(row.fair_observation),
      'a stylistic guard that fails twice persists the sanitised sentence rather than deleting the field');
    ok('9b. a repeatedly-rejected WORDING guard never leaves a mandatory demo field blank');
  }
  {
    // A TRUTHFULNESS failure is different: it stays blank, on purpose.
    const { row } = await run({
      findings: ordered(F.positive, F.noFollowUp, F.sellerMissed),
      reply: () => answer({ fair_observation: 'the evidence in the findings shows they replied quickly.' }),
    });
    assert.strictEqual(row.fair_observation, '',
      'copy that leaks our own analytical vocabulary is never persisted, repaired or not');
    ok('9c. a truthfulness failure still blanks the field — that blank has a real reason');
  }

  // ══ LIVE REGRESSION: prb_hist_0002 / prb_hist_0005 blank email_observation ═
  {
    // ParaBar's real shape. Findings 1, 2 and 4 are selected; finding 3 — the
    // passive "call us" viewing line — is not. A correct observation shares
    // exactly two ordinary words with it, "viewing" and "times", and the old
    // scope guard read that as importing an unselected finding, blanked the
    // field HARD, and banked no fallback. Two attempts later the row persisted
    // blank. This is that exact case.
    const parabar = [
      { finding_index: 1, finding_type: 'opportunity', finding: 'Seller recognition: none; all three emails are brochure-and-call-us templates with no mention of his own property.', evidence: 'Seller recognition: none across three emails.', significance_note: '' },
      { finding_index: 2, finding_type: 'problem', finding: 'Buyer qualification depth: none (questions asked: none) across three emails.', evidence: 'No budget, timescale or finance questions.', significance_note: '' },
      { finding_index: 3, finding_type: 'problem', finding: 'Viewing progression stayed passive with a generic call-us line rather than proactively offering times.', evidence: '"Please contact me if you are interested in arranging any viewings."', significance_note: '' },
      { finding_index: 4, finding_type: 'positive', finding: 'Emails addressed to Dear Joe Carter and included personalised, well-matched brochures.', evidence: 'Brochures for Outwood Common Road and Kilbarry Walk.', significance_note: '' },
    ];
    const observation = "You replied three times with brochures for me, but no viewing was ever offered and nobody picked up that I'd also said I had a property to sell.";
    const selected = parabar.filter((f) => [1, 2, 4].includes(f.finding_index));
    assert.strictEqual(introducesUnselectedFinding(observation, selected, parabar, PROBE), false,
      '"viewing" and "times" are the enquiry\'s own vocabulary, not finding 3\'s content');

    const { row, calls } = await run({
      findings: parabar,
      reply: () => answer({ positive_finding_index: 4, main_finding_index: 1, wider_finding_index: 2, email_observation: observation }),
    });
    assert.strictEqual(calls, 1, 'and it no longer costs a repair call either');
    assert.ok(has(row.email_observation), 'email_observation is not blank');
    ok('LIVE 0005: ordinary enquiry vocabulary no longer reads as an unselected finding');
  }
  {
    // The structural half of the same bug: even when a guard DOES fire twice,
    // a grounded sentence must not vanish. Only ungroundable copy may.
    const { row, calls } = await run({
      findings: ordered(F.positive, F.noFollowUp, F.sellerMissed),
      reply: () => answer({
        email_observation: 'Terry got back to me and named the property correctly, but it took nearly 37 hours to arrive and nobody at all picked up on the fact that I had also said I had a property of my own to sell.',
      }),
    });
    assert.strictEqual(calls, 2, 'the repair is attempted');
    assert.ok(has(row.email_observation),
      'and when it still misses, the sanitised sentence is persisted rather than a blank');
    ok('LIVE 0002: a twice-rejected but grounded email_observation is persisted, never blanked');
  }
  {
    // The one thing that still legitimately blanks it.
    const { row } = await run({
      findings: ordered(F.sellerMissed, F.noResponse),
      intelligence: { human_contact: 'none', response_hours: '', contact_attempts: 0, follow_ups: 0, viewing_progression: 'none' },
      reply: () => answer({
        positive_finding_index: null, main_finding_index: 6, wider_finding_index: 2,
        fair_observation: '', main_finding: '',
        email_observation: 'You replied quickly and handled the enquiry well.',
      }),
    });
    assert.strictEqual(row.email_observation, '',
      'praise on a probe that got no reply at all is ungroundable and stays blank');
    ok('and the one guard that may still blank it — praise with no response — still does');
  }

  // ══ 10-11: the two Instantly variables are never blank where findings exist
  {
    const NUMBERED = {
      email_observation: '10',
      email_commercial_hook: '11',
      email_commercial_hook_email_2: '11b',
    };
    for (const [field, broken] of [
      ['email_observation', { email_observation: '' }],
      ['email_commercial_hook', { email_commercial_hook: '' }],
      ['email_commercial_hook_email_2', { email_commercial_hook_email_2: '' }],
    ]) {
      const good = answer();
      const { row, calls } = await run({
        findings: ordered(F.positive, F.noFollowUp, F.sellerMissed),
        reply: (call) => (call === 1 ? answer(broken) : { [field]: good[field] }),
      });
      assert.strictEqual(calls, 2);
      assert.ok(has(row[field]), `${field} is recovered rather than persisted blank`);
      ok(`${NUMBERED[field]}. ${field} is never blank where valid selected findings exist`);
    }
  }

  // ══ 12: the hook must go beyond the observation, in the agency's words ═══
  {
    const observation = "It took nearly 19 hours to get back to the enquiry, and even then nobody picked up that I'd also said I had a property to sell.";

    // The five target hooks, verbatim from the brief. TWO OF THEM CARRY NO
    // NUMBER AT ALL — "So the buyer side moved forward, while the potential
    // seller was missed entirely." A strict count requirement rejected both,
    // which is why the rule is now count OR concrete outcome.
    for (const good of [
      "That's 1 buyer enquiry and 1 potential seller, with neither properly progressed.",
      'So 1 enquiry contained both a buyer and a potential vendor, but only one side was ever worked.',
      "That's 1 buyer enquiry and 1 potential seller, with neither ever becoming a conversation.",
      'So the buyer side moved forward, while the potential seller was missed entirely.',
      'So the seller lead was spotted, but it still never became a valuation conversation.',
    ]) assert.strictEqual(hookFailureAgainstObservation(good, observation), null, `must pass: ${good}`);

    // Deck language is rejected wherever it appears, including inside a hook
    // that is otherwise well formed and correctly counted.
    for (const jargon of [
      "That's 2 commercial opportunities from 1 enquiry, with neither fully progressed.",
      'This is revenue leakage the branch never sees.',
      'That points to a process failure in how enquiries are handled.',
      'The commercial value of that enquiry was never realised.',
    ]) assert.strictEqual(hookFailureAgainstObservation(jargon, observation), 'consultant_speak', `must fail: ${jargon}`);

    // Lexical restatement is still caught.
    assert.strictEqual(hookFailureAgainstObservation(`${observation} Really.`, observation), 'restates_observation');
    // And a hook that names nothing an agent counts or recognises.
    assert.strictEqual(
      hookFailureAgainstObservation('That is a real shame and worth a look.', observation), 'no_quantification');
    // "no valuation conversation" describes an absence; it is not a count.
    assert.strictEqual(quantifiesOpportunityShape('no valuation conversation ever started'), false);

    // HONESTY BOUNDARY, asserted so nobody later "fixes" it by heuristic.
    // This hook is flat — it redescribes the observation instead of naming what
    // was missed — and it passes every mechanical test here, because it is
    // written in concrete agency terms and is not a lexical restatement. The
    // difference between it and the target hook above is semantic, and the
    // PROMPT carries it (the good/bad pairs sit side by side in
    // SYSTEM_PROMPT). Do not add a heuristic that pretends to decide this.
    assert.strictEqual(
      hookFailureAgainstObservation('A potential seller went completely unengaged, meaning no valuation conversation ever had the chance to start.', observation),
      null, 'a well-formed but flat hook is the prompt\'s job, not the guard\'s');
    assert.ok(_internal.SYSTEM_PROMPT.includes("That seller wasn't a cold database record"),
      'so the prompt must carry the target hooks');
    assert.ok(_internal.SYSTEM_PROMPT.includes('FLAT:'),
      'and the flat hook that shows what "adds nothing" looks like');
    assert.ok(_internal.SYSTEM_PROMPT.includes('TOO SOFT:'),
      'and the observation pair that shows what soft looks like');
    ok('12. the hook lands in the agency\'s own words — all five target hooks pass, deck language is rejected, and the semantic judgement is left to the prompt on purpose');
  }
  {
    const { row, calls } = await run({
      findings: ordered(F.positive, F.noFollowUp, F.sellerMissed),
      reply: (call) => (call === 1
        ? answer({ email_commercial_hook: "That's 2 commercial opportunities from 1 enquiry, with neither fully progressed." })
        : { email_commercial_hook: 'So the vendor you never asked about was already in the building, talking to you as a buyer.' }),
    });
    assert.strictEqual(calls, 2);
    assert.match(row.email_commercial_hook, /already in the building/);
    assert.doesNotMatch(row.email_commercial_hook, /commercial opportunit/i);
    ok('12b. a deck-language hook is repaired into the agency\'s own words inside the two-call budget');
  }

  // ══ 13: the hook cannot introduce an unselected finding ═══════════════════
  {
    const all = ordered(F.positive, F.noFollowUp, F.sellerMissed, F.qualification);
    const selected = [F.noFollowUp, F.sellerMissed, F.positive];
    const leaked = 'Buyer qualification was weak and incomplete across 2 opportunities.';
    assert.strictEqual(introducesUnselectedFinding(leaked, selected, all), true);
    const { row, calls } = await run({
      findings: all,
      reply: (call) => (call === 1 ? answer({ email_commercial_hook: leaked }) : { email_commercial_hook: answer().email_commercial_hook }),
    });
    assert.strictEqual(calls, 2);
    assert.doesNotMatch(row.email_commercial_hook, /qualification/i);
    assert.strictEqual(row.narrative_finding_indexes, '1,2,4', 'and the scoped repair did not disturb the selection');
    ok('13. the hook cannot introduce an unselected finding, and repairing it leaves the selection untouched');
  }

  // ══ 14: Email 1 never refers to the enquirer in the third person ══════════
  {
    // Verbatim from prb_hist_0010 and prb_hist_0006.
    for (const bad of [
      "Your initial email correctly personalised Joe's enquiry by name and property.",
      'Joe explicitly flagged an off-market property to sell.',
      'That means the buyer was never qualified and the seller lead went unpursued.',
      'no acknowledgement of the property he wants to sell',
      'The enquirer declared an unlisted property to sell.',
    ]) assert.strictEqual(readsAsThirdPersonProspect(bad), true, `third person: ${bad}`);
    for (const fine of [
      "Terry's callback was well personalised, using my name and the exact property details.",
      'The declared property to sell was never acknowledged in any contact.',
      "You handled the viewing side well, but nobody picked up that I'd also said I had a property to sell.",
      // The target hooks name SIDES of the enquiry, not the person who sent
      // it. "the buyer side" / "the buyer enquiry" is the agency's own
      // vocabulary and must not be mistaken for third-person reference.
      'So the buyer side moved forward, while the potential seller was missed entirely.',
      "That's 1 buyer enquiry and 1 potential seller, with neither properly progressed.",
      'So 1 enquiry contained both a buyer and a potential vendor, but only one side was ever worked.',
    ]) assert.strictEqual(readsAsThirdPersonProspect(fine), false, `must stay valid: ${fine}`);

    const { row, calls } = await run({
      findings: ordered(F.positive, F.noFollowUp, F.sellerMissed),
      reply: (call) => (call === 1
        ? answer({ email_observation: "Your initial email correctly personalised Joe's enquiry, but nobody picked up the property he wants to sell." })
        : { email_observation: answer().email_observation }),
    });
    assert.strictEqual(calls, 2);
    assert.doesNotMatch(row.email_observation, /\bJoe\b/);
    assert.strictEqual(readsAsThirdPersonProspect(row.email_observation), false);
    // The demo fields keep their own voice: "the buyer has little reason to
    // call back" is legitimate copy in an agency-facing demo.
    assert.strictEqual(readsAsThirdPersonProspect('the buyer has little reason or means to call back'), true);
    const demoRow = await run({
      findings: ordered(F.positive, F.noFollowUp, F.sellerMissed),
      reply: () => answer({ commercial_consequence: 'the buyer has little reason or means to call back.' }),
    });
    assert.ok(has(demoRow.row.commercial_consequence), 'the Email-1-only rule does not touch demo prose');
    ok('14. Email 1 is always first person; the rule is scoped to the two Instantly variables');
  }

  // ══ 19: THE PROBE RULE — we never reply, so nothing that needed our reply
  //        is the agency's failure ══════════════════════════════════════════
  {
    // Verbatim from the brief's list of invalid criticism.
    for (const unfair of [
      'the viewing never got booked',
      'the buyer side never progressed',
      'neither opportunity became a conversation',
      'the viewing was left hanging',
      'the enquiry never moved forward',
      "That's 1 buyer enquiry and 1 potential seller, with neither properly progressed.",
      "That's 1 buyer enquiry and 1 potential seller, with neither ever becoming a conversation.",
    ]) assert.strictEqual(readsAsUnfairOutcomeCriticism(unfair), true, `needs my reply: ${unfair}`);

    // Everything the agency could have done alone, on the day, stays sayable.
    for (const fair of [
      "You handled the viewing side well, but nobody picked up that I'd also said I had a property to sell.",
      'No follow-up was ever sent after that first reply.',
      'It took nearly 19 hours to get back to the enquiry.',
      'So the buyer side moved forward, while the potential seller was missed entirely.',
      'So the seller lead was spotted, but it still never became a valuation conversation.',
      'The enquiry never got a genuine human response in the first place.',
      "That seller wasn't a cold database record — they were already engaging with your branch as a buyer.",
    ]) assert.strictEqual(readsAsUnfairOutcomeCriticism(fair), false, `theirs alone to do: ${fair}`);

    // human_contact = 'yes' is NECESSARY but not SUFFICIENT: a normal human
    // reply or a brochure with nothing to act on must not, by itself, put the
    // ball in my court.
    assert.strictEqual(
      agencyMadeNextStepAttempt({ human_contact: 'yes', viewing_progression: 'none', seller_recognition: 'none' }),
      false, 'a human reply alone is not a next-step attempt');
    assert.strictEqual(
      agencyMadeNextStepAttempt({ human_contact: 'yes', viewing_progression: 'mentioned', seller_recognition: 'acknowledged' }),
      false, 'a passive mention/acknowledgement is not a concrete ask either');
    // Only a concrete ask that genuinely needed my answer activates it.
    for (const genuine of [
      { human_contact: 'yes', viewing_progression: 'invited' },
      { human_contact: 'yes', viewing_progression: 'availability_requested' },
      { human_contact: 'yes', viewing_progression: 'slot_offered' },
      { human_contact: 'yes', viewing_progression: 'booked' },
      { human_contact: 'yes', seller_recognition: 'asked_position' },
      { human_contact: 'yes', seller_recognition: 'valuation_offered' },
      { human_contact: 'yes', seller_recognition: 'valuation_booked' },
      { human_contact: 'yes', buyer_questions_asked: 'budget; timescale' },
    ]) assert.strictEqual(agencyMadeNextStepAttempt(genuine), true, `real progression attempt: ${JSON.stringify(genuine)}`);
    // human_contact still gates everything: no genuine human contact means no
    // next-step attempt however the rest of the row reads.
    assert.strictEqual(
      agencyMadeNextStepAttempt({ human_contact: 'automated_only', viewing_progression: 'invited' }),
      false, 'an automated-only acknowledgement never counts, even if it happens to carry a viewing state');
    assert.strictEqual(agencyMadeNextStepAttempt({ human_contact: 'none' }), false);

    // End to end, on a probe where a real person DID come back: the line is
    // rejected, and because it is not true it is never banked either — a
    // repair that repeats it leaves the field blank rather than sending it.
    const { row, calls } = await run({
      findings: ordered(F.positive, F.noFollowUp, F.sellerMissed),
      reply: () => answer({ email_commercial_hook: "That's 1 buyer enquiry and 1 potential seller, with neither properly progressed." }),
    });
    assert.strictEqual(calls, 2, 'the repair is attempted');
    assert.strictEqual(row.email_commercial_hook, '',
      'blaming us for our own silence is never persisted, repaired or not');
    ok('19. a line that blames the agency for an outcome needing my reply is rejected and never persisted');
  }
  {
    // And it is repairable inside the normal budget.
    const { row, calls } = await run({
      findings: ordered(F.positive, F.noFollowUp, F.sellerMissed),
      reply: (call) => (call === 1
        ? answer({ email_observation: 'You called me back the same morning, but the viewing never got booked and the enquiry never moved forward.' })
        : { email_observation: answer().email_observation }),
    });
    assert.strictEqual(calls, 2);
    assert.ok(has(row.email_observation));
    assert.strictEqual(readsAsUnfairOutcomeCriticism(row.email_observation), false);
    ok('19b. and one bounded correction turns it into something the agency could actually have done');
  }
  {
    // THE OTHER HALF OF THE RULE. On a probe where nobody ever came back, the
    // same sentence is simply what happened, and it must survive untouched.
    const { row, calls } = await run({
      findings: ordered(F.sellerMissed, F.noResponse),
      intelligence: { human_contact: 'none', response_hours: '', contact_attempts: 0, follow_ups: 0, viewing_progression: 'none' },
      reply: () => answer({
        positive_finding_index: null, main_finding_index: 6, wider_finding_index: 2,
        fair_observation: '', main_finding: '',
        email_observation: "We didn't hear anything back at all in four days, and nobody picked up that I'd also said I had a property to sell.",
        email_commercial_hook: "That's 1 buyer enquiry and 1 potential seller, with neither ever becoming a conversation.",
        email_commercial_hook_email_2: 'The part worth knowing is that the message you never answered had already told you why I was worth calling twice.',
      }),
    });
    assert.strictEqual(calls, 1, 'nothing to repair — nobody put the ball back in my court');
    assert.match(row.email_commercial_hook, /neither ever becoming a conversation/);
    ok('19c. the same sentence stays valid on a probe that got no genuine response at all');
  }

  // ══ 20: EMAIL 2 adds the thing Email 1 did not say ════════════════════════
  {
    const observation = "You replied within 10 hours and pushed straight for a viewing, but nobody acknowledged that I'd also said I had a property to sell.";
    const hook = "That seller wasn't a cold database record — they were already actively engaging with your agency as a buyer.";

    // The brief's own Email 2 hooks, verbatim.
    for (const good of [
      "The interesting part is that speed wasn't the problem here — the missed value was sitting inside the same enquiry you already responded to.",
      "You handled the viewing side well; the part worth looking at is that the same person had already given you a second reason to engage.",
      'Five follow-ups shows good persistence; the gap is that every touch was still working the same side of an enquiry that contained two opportunities.',
      'The speed was fine — what got lost was the actual context of the enquiry and the second reason that person was worth speaking to.',
      "In this case the issue wasn't qualification or follow-up quality — the enquiry never got a genuine human response in the first place.",
      "The buyer side worked exactly as you'd expect; the overlooked value was that the buyer had already volunteered seller intent in the same message.",
    ]) assert.strictEqual(secondHookFailure(good, observation, hook), null, `must pass: ${good}`);

    assert.strictEqual(secondHookFailure('', observation, hook), 'blank');
    assert.strictEqual(secondHookFailure(observation, observation, hook), 'restates_observation');
    assert.strictEqual(secondHookFailure(hook, observation, hook), 'restates_hook');
    assert.strictEqual(
      secondHookFailure('That is the kind of lead leakage a branch never sees in its funnel.', observation, hook),
      'consultant_speak');
    assert.strictEqual(
      secondHookFailure(`${'a real point about the enquiry '.repeat(6)}and one more clause on top of it.`, observation, hook),
      'too_long');
    // Same honesty boundary as the first hook: whether a well-formed second
    // line genuinely REFRAMES anything is the prompt's job, not a heuristic.
    assert.ok(_internal.SYSTEM_PROMPT.includes('email_commercial_hook_email_2'),
      'so the prompt must carry the Email 2 rule');
    assert.ok(_internal.SYSTEM_PROMPT.includes("The issue wasn't X — it was Y."),
      'and the shapes that make it land');
    ok('20. the Email 2 hook must add something both Email 1 lines did not say');
  }
  {
    // End to end: an Email 2 that is the first hook again is repaired, and the
    // three persisted lines end up genuinely different from each other.
    const good = answer();
    const { row, calls } = await run({
      findings: ordered(F.positive, F.noFollowUp, F.sellerMissed),
      reply: (call) => (call === 1
        ? answer({ email_commercial_hook_email_2: good.email_commercial_hook })
        : { email_commercial_hook_email_2: good.email_commercial_hook_email_2 }),
    });
    assert.strictEqual(calls, 2);
    assert.ok(has(row.email_commercial_hook_email_2));
    assert.notStrictEqual(row.email_commercial_hook_email_2, row.email_commercial_hook);
    for (const [a, b] of [
      [row.email_observation, row.email_commercial_hook],
      [row.email_observation, row.email_commercial_hook_email_2],
      [row.email_commercial_hook, row.email_commercial_hook_email_2],
    ]) assert.strictEqual(isDistinctText(a, b), true, 'the three email fields do not repeat each other');
    ok('20b. a repeated Email 2 hook is repaired, and the three persisted lines stay three different jobs');
  }

  // ══ 22: automated-only acknowledgements never count as a human reply,
  //        genuine or otherwise — unchanged upstream behaviour, re-asserted
  //        at the point PERSONALISATION consumes it ═══════════════════════
  {
    // "Thanks for your enquiry, someone will be in touch" is the canonical
    // auto-ack. It is INTELLIGENCE's job to classify it as automated_only
    // (lib/intelligence-fields.mjs — untouched here); this only proves
    // Personalisation still treats that classification as "nobody genuine
    // replied" rather than upgrading it to a next-step attempt.
    assert.strictEqual(
      agencyMadeNextStepAttempt({ human_contact: 'automated_only', viewing_progression: 'invited', seller_recognition: 'valuation_offered' }),
      false, 'an automated-only acknowledgement is never a genuine human next-step attempt, however it reads');
    // And the fairness guard is therefore inert on such a probe: criticism
    // that would be unfair after a genuine human reply stays sayable here,
    // because no human ever actually replied.
    const { row, calls } = await run({
      findings: ordered(F.sellerMissed, F.noResponse),
      intelligence: {
        human_contact: 'automated_only', response_hours: '', contact_attempts: 0, follow_ups: 0,
        viewing_progression: 'none', seller_recognition: 'none',
      },
      reply: () => answer({
        positive_finding_index: null, main_finding_index: 6, wider_finding_index: 2,
        fair_observation: '',
        main_finding: 'nobody genuine ever got back to me — the auto-reply was the only thing that came through.',
        email_observation: 'Thanks for your enquiry, someone will be in touch was the only reply, and nobody picked up that I\'d also said I had a property to sell.',
        email_commercial_hook: "That's 1 buyer enquiry and 1 potential seller, with neither ever becoming a conversation.",
        email_commercial_hook_email_2: 'The auto-reply looked like an acknowledgement, but no person had actually seen the second half of the message yet.',
      }),
    });
    assert.strictEqual(calls, 1, 'nothing here trips the fairness guard');
    assert.match(row.email_commercial_hook, /neither ever becoming a conversation/);
    ok('22. an automated "someone will be in touch" acknowledgement is never treated as a genuine reply or a next-step attempt');
  }

  // ══ 23: voicemail uncertainty — unknown content stays unknown ═════════════
  {
    const badVoicemail = { finding_index: 7, finding_type: 'problem', finding: 'The voicemail left for the buyer cut off mid-sentence with no availability request or callback instruction given.', evidence: 'Voicemail transcript: "Hi it\'s Terry, just calling about your enq—" (cuts off).', significance_note: 'Transcript is incomplete.' };
    const cleanVoicemail = { finding_index: 7, finding_type: 'problem', finding: 'The voicemail never mentioned the property or offered a viewing.', evidence: 'Full transcript: "Hi, thanks for enquiring, give me a call back when you can." Nothing else was said.', significance_note: 'A complete, legible transcript.' };

    assert.strictEqual(hasUnreliableVoicemailEvidence([badVoicemail]), true, 'a cut-off voicemail finding is flagged unreliable');
    assert.strictEqual(hasUnreliableVoicemailEvidence([cleanVoicemail]), false, 'a complete, legible voicemail transcript is not');
    assert.strictEqual(
      makesUnsupportedVoicemailClaim('the voicemail cut off mid-sentence with no availability request or callback instruction given.'),
      true);
    assert.strictEqual(
      makesUnsupportedVoicemailClaim('the voicemail never mentioned the property or offered a viewing.'), true);
    assert.strictEqual(
      makesUnsupportedVoicemailClaim('nobody ever called back after leaving that voicemail.'), false,
      'a claim about what happened AFTER the voicemail, not about its content, is untouched');

    // End to end: a finding whose OWN evidence shows the voicemail is
    // unreliable cannot license copy that says what it didn't contain — the
    // claim is rejected and, being ungroundable, never banked.
    const { row, calls } = await run({
      findings: ordered(F.positive, badVoicemail, F.sellerMissed),
      reply: () => answer({
        main_finding_index: 7,
        main_finding: 'the voicemail left for the buyer cut off mid-sentence with no availability request or callback instruction given.',
        email_observation: "You called within the hour, but the voicemail cut off mid-sentence with no availability request or callback instruction given, and nobody picked up that I'd also said I had a property to sell.",
      }),
    });
    assert.strictEqual(calls, 2, 'the repair is attempted');
    assert.strictEqual(row.main_finding, '', 'an unsupported claim about the voicemail\'s missing content is never persisted');
    assert.strictEqual(row.email_observation, '', 'neither is the same claim in the Instantly observation');
    ok('23. a bad voicemail transcript never creates unsupported claims about its content, and the claim is not bankable');
  }

  // ══ 24: seller-miss stays valid even when the only related evidence is an
  //        unreliable voicemail, provided the FULL record shows no reliable
  //        acknowledgement anywhere ═════════════════════════════════════════
  {
    const badVoicemail = { finding_index: 7, finding_type: 'opportunity', finding: 'The voicemail left for the buyer cut off mid-sentence, and no other contact ever acknowledged the declared property to sell.', evidence: 'Voicemail transcript: "Hi it\'s Terry, just calling about your enq—" (cuts off). No other communications exist.', significance_note: 'Seller side never acknowledged anywhere in the record.' };
    assert.strictEqual(hasUnreliableVoicemailEvidence([badVoicemail]), true);
    // The seller-miss claim itself makes no assertion about the voicemail's
    // CONTENT — it says the declared property was never acknowledged ANYWHERE
    // — so it is not a voicemail-content claim and must pass untouched.
    assert.strictEqual(
      makesUnsupportedVoicemailClaim("nobody picked up that I'd also said I had a property to sell."), false);
    const { row, calls } = await run({
      findings: ordered(F.positive, badVoicemail),
      reply: () => answer({
        main_finding_index: 7, wider_finding_index: null,
        main_finding: 'the declared property to sell was never acknowledged anywhere in the record.',
        email_observation: "You called within the hour, but nobody picked up that I'd also said I had a property to sell.",
        email_commercial_hook: "That seller wasn't a cold database record — they were already actively engaging with your agency as a buyer.",
      }),
    });
    assert.strictEqual(calls, 1, 'a seller-miss claim grounded in the full record costs nothing extra');
    assert.ok(has(row.main_finding), 'seller-miss wording survives when no reliable acknowledgement exists anywhere');
    assert.ok(has(row.email_observation));
    ok('24. seller-missed wording remains valid when no reliable acknowledgement exists anywhere in the record, even alongside an unreliable voicemail');
  }

  // ══ 21: regenerating the existing rows onto the three-field contract ══════
  {
    const complete = {
      primary_narrative: 'n', email_observation: 'o', email_commercial_hook: 'h',
      email_commercial_hook_email_2: 'h2',
    };
    const { email_commercial_hook_email_2: _dropped, ...legacy } = complete;
    const withColumn = new Set([...Object.keys(complete), 'probe_id']);
    const withoutColumn = new Set([...Object.keys(legacy), 'probe_id']);

    assert.strictEqual(needsPersonalisation({ obj: legacy }, withColumn), true,
      'a row written before Email 2 existed is regenerated, on the pass after the column is added');
    assert.strictEqual(needsPersonalisation({ obj: complete }, withColumn), false,
      'and once it carries all three lines it is frozen again — no second regeneration');
    // THE LOOP THIS PREVENTS: with no column on the sheet, the value written
    // for it goes nowhere, so it would read back blank on every subsequent
    // pass and re-personalise every probe for ever.
    assert.strictEqual(needsPersonalisation({ obj: legacy }, withoutColumn), false,
      'a workbook that has not had the column added yet behaves exactly as it did before the field existed');
    assert.strictEqual(needsPersonalisation(null, withColumn), true, 'a probe with no row at all is always personalised');
    ok('21. existing rows regenerate once onto the three-field contract, and a workbook missing the column never loops');
  }

  // ══ 15: no structured-output / tool markup can persist ════════════════════
  {
    const tool = _internal.TOOL;
    // Verbatim from prb_hist_0001 / 0009 / 0011 / 0013.
    const leaked = normaliseToolInput({
      ...answer(),
      primary_narrative: 'This enquiry received zero human contact across four days.</primary_narrative>\n<parameter name="supporting_findings">Finding 3 notes the response was templated.',
      supporting_findings: '',
    }, tool, { requireComplete: true });
    assert.strictEqual(leaked.primary_narrative, 'This enquiry received zero human contact across four days.');
    assert.strictEqual(leaked.supporting_findings, 'Finding 3 notes the response was templated.',
      'the swallowed parameter is RECOVERED into its own key, not just stripped');
    assert.strictEqual(containsToolMarkup(leaked.primary_narrative, Object.keys(tool.input_schema.properties)), false);

    const { head, recovered } = splitLeakedValue('primary_narrative',
      'A.</primary_narrative><parameter name="fair_observation">b.</parameter>', ['primary_narrative', 'fair_observation']);
    assert.strictEqual(head, 'A.');
    assert.strictEqual(recovered.get('fair_observation'), 'b.');

    // A truncated response is an error, never a half record.
    assert.throws(() => normaliseToolInput(answer(), tool, { truncated: true }), AiStructuredOutputError);
    // prb_hist_0005's exact shape: everything after supporting_findings lost.
    assert.throws(() => normaliseToolInput({
      story_reasoning: 'x', positive_finding_index: 4, main_finding_index: 1, wider_finding_index: 2,
      primary_narrative: 'A narrative.', supporting_findings: 'Some support.',
    }, tool, { requireComplete: true }), /missing required fields/);

    // End to end: markup in, nothing markup-ish out, on every persisted field.
    const { row } = await run({
      findings: ordered(F.positive, F.noFollowUp, F.sellerMissed),
      reply: () => ({
        ...answer(),
        primary_narrative: 'The buying side moved and the selling side never did.</primary_narrative>\n<parameter name="supporting_findings">',
      }),
    });
    for (const [field, value] of Object.entries(row)) {
      assert.strictEqual(containsToolMarkup(value, Object.keys(tool.input_schema.properties)), false,
        `${field} carries no tool markup`);
    }
    ok('15. leaked tool markup is recovered into the right key, scrubbed everywhere, and a truncated result is an error rather than a half record');
  }
  {
    // The truncation is spent on the remaining attempt, not on the probe.
    let calls = 0;
    __setAiCallerForTests(async ({ tool }) => {
      calls += 1;
      if (calls === 1) throw new AiStructuredOutputError('Model response hit max_tokens', { truncated: true });
      return tool.name === 'record_probe_personalisation' ? answer() : {};
    });
    const row = await personaliseProbe(PROBE, INTEL,
      { diagnosis_summary: 'final', novus_opportunity: 'Core (front desk)' },
      ordered(F.positive, F.noFollowUp, F.sellerMissed), { agency_name: 'Example Estates' });
    assert.strictEqual(calls, 2);
    assert.ok(has(row.email_observation) && has(row.fair_observation));
    ok('15b. a truncated first call is retried inside the same two-call budget instead of persisting prb_hist_0005 all over again');
  }

  // ══ the £450,000.00 bug that deleted grounded sentences ═══════════════════
  {
    assert.strictEqual(normalizeCurrencyFigure('£450,000.00'), normalizeCurrencyFigure('£450,000'),
      'a trailing .00 is the same figure, not a hundred times it');
    const { row } = await run({
      findings: ordered(F.positive, F.sellerMissed),
      reply: () => answer({
        main_finding_index: 2, wider_finding_index: null,
        commercial_consequence: 'a £450,000 property to sell was never valued or even mentioned.',
      }),
    });
    assert.match(row.commercial_consequence, /£450,000/,
      "the probe's own property value survives the currency allow-list");
    ok('the currency allow-list recognises the probe\'s own price in its persisted "£450,000.00" form');
  }

  // ══ the counts the hook is built from ═════════════════════════════════════
  {
    const shape = buildOpportunityShape(PROBE, { ...INTEL, contact_attempts: 3, follow_ups: 2, viewing_progression: 'booked', seller_recognition: 'none', response_hours: 14.5 });
    assert.match(shape, /1 buyer enquiry \+ 1 potential seller/);
    assert.match(shape, /real next step: 1 of 2/);
    assert.match(shape, /Contact attempts: 3/);
    assert.match(shape, /First reply: 14\.5 hours/);
    // The block must speak the agency's language, because it is where the hook
    // gets its vocabulary. An earlier version called these "commercial
    // opportunities" and the hooks came back sounding like a consultant.
    assert.doesNotMatch(shape, /commercial opportunit/i, 'the counts block never teaches deck language');
    assert.strictEqual(readsAsConsultantSpeak(shape), false);
    const buyerOnly = buildOpportunityShape(BUYER_ONLY_PROBE, INTEL);
    assert.match(buyerOnly, /1 buyer enquiry \(no property to sell was declared\)/,
      'a buyer-only enquiry is one side, not two');
    assert.doesNotMatch(buyerOnly, /Seller \/ valuation side/);
    const silent = buildOpportunityShape(PROBE, { human_contact: 'none' });
    assert.match(silent, /Conversations created: 0/);
    // And it states which side of the probe rule this enquiry sits on, which
    // is what stops the model criticising us for our own deliberate silence.
    assert.match(shape, /ball back in my court\? YES/);
    assert.match(silent, /ball back in my court\? NO/);
    ok('the counts block is code-computed from this enquiry alone, speaks in buyer/seller terms, and never invents a seller side');
  }

  // ══ 16-18: the 14 historical probes ══════════════════════════════════════
  {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const probes = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'historical-probes.json'), 'utf8'));
    assert.strictEqual(probes.length, 14);

    let unexplained = 0;
    let notReady = 0;
    let maxCalls = 0;
    for (const fixture of probes) {
      let calls = 0;
      __setAiCallerForTests(async ({ tool }) => {
        calls += 1;
        if (tool.name === 'record_probe_personalisation') return fixture.recorded_model_output;
        // A compliant correction: the shape counts, from the same selection.
        const counts = buildOpportunityShape(fixture.probe, fixture.intelligence);
        const opportunities = Number(counts.match(/enquiry: (\d+)/)[1]);
        return Object.fromEntries(tool.input_schema.required.map((field) => [field,
          field === 'email_commercial_hook'
            ? (opportunities === 2
              ? 'That seller was not a name on a cold list — they were already talking to you as a buyer.'
              : 'So a buyer already in front of you stayed a name in the inbox rather than someone you knew anything about.')
            : field === 'email_commercial_hook_email_2'
              ? 'Worth a second look: the part that went unworked was sitting inside a message you had already opened.'
              : field === 'email_observation'
                ? "You came back to me, but nobody picked up that I'd also said I had a property to sell."
                : 'you picked the enquiry up and came back with the right property details.']));
      });
      const row = await personaliseProbe(fixture.probe, fixture.intelligence, fixture.diagnosis,
        fixture.findings, { agency_name: fixture.agency_name });
      maxCalls = Math.max(maxCalls, calls);

      const noContact = String(fixture.intelligence.human_contact) === 'none';
      const positive = fixture.selection.positive_finding_index;
      const main = fixture.selection.main_finding_index;

      // 10-11 across every real probe.
      assert.ok(has(row.email_observation), `${fixture.probe_id}: email_observation`);
      assert.ok(has(row.email_commercial_hook), `${fixture.probe_id}: email_commercial_hook`);
      assert.ok(has(row.email_commercial_hook_email_2), `${fixture.probe_id}: email_commercial_hook_email_2`);
      // 9 across every real probe: a blank must have an evidence reason.
      if (positive !== null && !has(row.fair_observation)) unexplained += 1;
      if (main !== null && !noContact && !has(row.main_finding)) unexplained += 1;
      if (main !== null && !has(row.commercial_consequence)) unexplained += 1;
      // 15 across every real probe.
      for (const value of Object.values(row)) {
        assert.strictEqual(containsToolMarkup(value, Object.keys(_internal.TOOL.input_schema.properties)), false,
          `${fixture.probe_id}: no tool markup persists`);
      }
      // 14 across every real probe.
      assert.strictEqual(readsAsThirdPersonProspect(row.email_observation), false, `${fixture.probe_id}: first-person observation`);
      assert.strictEqual(readsAsThirdPersonProspect(row.email_commercial_hook), false, `${fixture.probe_id}: first-person hook`);
      assert.strictEqual(readsAsThirdPersonProspect(row.email_commercial_hook_email_2), false, `${fixture.probe_id}: first-person Email 2 hook`);
      // THE PROBE RULE across every real probe: no persisted line blames the
      // agency for an outcome that needed a reply we deliberately withheld.
      if (agencyMadeNextStepAttempt(fixture.intelligence)) {
        for (const field of ['email_observation', 'email_commercial_hook', 'email_commercial_hook_email_2']) {
          assert.strictEqual(readsAsUnfairOutcomeCriticism(row[field]), false,
            `${fixture.probe_id}: ${field} criticises an outcome that needed my reply`);
        }
      }

      // 17-18: the demo compiles, and compiles READY wherever the evidence
      // supports every beat.
      const compiled = buildDemoRow({
        probe: fixture.probe, agency: { agency_name: fixture.agency_name },
        intelligence: fixture.intelligence, findings: fixture.findings,
        personalisation: { personalisation_id: `psn_${fixture.probe_id}`, ...row },
        communications: [], now: '2026-08-25T12:00:00.000Z',
      });
      assert.ok(compiled.row.hero_journey, `${fixture.probe_id}: the demo compiles`);
      if (compiled.status !== 'ready') { notReady += 1; console.log(`     ${fixture.probe_id}: ${compiled.reasons.join(' · ')}`); }
    }
    assert.strictEqual(unexplained, 0, 'no mandatory field is blank without an evidence reason');
    assert.ok(maxCalls <= 2, 'no historical probe exceeds two AI calls');
    ok('16. all 14 historical probes reach a valid state — mandatory fields present, no markup, first-person email, <= 2 AI calls');
    assert.strictEqual(notReady, 0, 'every historical demo with sufficient evidence compiles ready');
    ok('17-18. every one of the 14 historical demos compiles, and all 14 compile ready (was 6 of 14)');
  }

  // ══ the demo gate no longer demands praise the evidence cannot support ════
  {
    const noPositive = { agency_name: 'A', property_address: 'B', commercial_consequence: 'c',
      human_contact: 'yes', positive_observation: '',
      novus_detected_json: '[{"label":"x"}]', observed_events_json: '[{"label":"a"},{"label":"b"}]' };
    assert.deepStrictEqual(reviewReasonsFor(noPositive, { positiveAvailable: false }), [],
      'a probe whose findings hold no positive is a legitimately credit-free demo');
    assert.deepStrictEqual(reviewReasonsFor(noPositive, { positiveAvailable: true }).length, 1,
      'but a probe that DID have a positive to credit still flags when it is missing');
    ok('the demo review gate asks the findings whether a positive was ever available');
  }

  console.log(`\n${passed} checks passed.`);
}

main().catch((error) => { console.error(error); process.exit(1); });
