// scripts/novus-master-personalisation-contract-selftest.mjs — the MASTER
// NOVUS Personalisation Contract audit suite (hermetic, AI-free).
//
// This file does NOT re-implement what scripts/novus-personalisation-contract-
// selftest.mjs, scripts/novus-diagnosis-seller-price-selftest.mjs and
// scripts/novus-probe-diagnosis-selftest.mjs already pin — see the contract
// matrix (delivered alongside this suite, not committed as a file per the
// audit brief) for exactly which rule each sibling suite already covers.
// What lives HERE is:
//
//   1. a single run of every sibling suite that already exercises a
//      deterministic contract rule, so "run the master suite" is one command
//      that proves the whole contract rather than five separately-remembered
//      ones;
//   2. the specific hermetic edge cases the audit brief asked for that are
//      NOT already covered anywhere — some of which pin CORRECT behaviour
//      that existed but had no dedicated test (financial-loss invention),
//      and some of which pin a GENUINE GAP: current, unenforced behaviour
//      that the audit found but this pass is explicitly forbidden from
//      fixing. Every GAP block is labelled '[GAP]' in its `ok()` line and
//      explains, in a comment, exactly what is missing.
//
// Per the audit brief: sections A and B change NO production logic. Every
// assertion in them either pins existing guard behaviour or documents, without
// silently accepting, a gap the matrix already lists.
//
//   3. SECTION C — THE ARCHITECTURE CONTRACT, added with the DIAGNOSIS-prose
//      simplification. The pipeline is now
//        PROBES + INTELLIGENCE -> DIAGNOSIS_FINDINGS -> PERSONALISATION -> DEMOS
//      with DIAGNOSIS_FINDINGS as the SINGLE authoritative commercial
//      interpretation layer and the broad DIAGNOSIS prose (diagnosis_summary,
//      strengths, missed_opportunities, commercial_implication) explicitly
//      NON-AUTHORITATIVE downstream. Section C proves that as an invariant
//      rather than a convention — a poisoned DIAGNOSIS row whose every prose
//      field contradicts the findings must change nothing, anywhere — and it
//      closes three of the gaps sections A/B could only document: false
//      chronology (rules 33/34), "nothing progressed" on a probe where
//      something did (rule 25), and an address FRAGMENT leaking into a seller
//      clause (rules 5/37).
//
// Run: node scripts/novus-master-personalisation-contract-selftest.mjs

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';
import {
  personaliseProbe, attributesEnquiryPriceToSeller, stripSellerPriceAttribution,
  readsAsInventedLoss, stripInventedLoss, hasUnreliableVoicemailEvidence,
  makesUnsupportedVoicemailClaim, agencyMadeNextStepAttempt, readsAsUnfairOutcomeCriticism,
  secondHookFailure, readsAsThirdPersonProspect, cleanAddressForEmail,
  attributesEnquiryAddressToSeller, stripEnquiryAddressAttribution,
  claimsProspectReply, evidenceShowsProspectReply,
  readsAsFalseChronology, pickHeroJourney,
} from '../lib/probe-personalisation.mjs';
import { needsPersonalisation, rebuildAllPersonalisation } from '../lib/personalisation-rebuild.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
const ok = (m) => { passed += 1; console.log(`  ✓ ${m}`); };
const has = (v) => Boolean(String(v ?? '').trim());
// A story finding (problem/opportunity) — a positive can never carry the main
// beat, which is what C4's per-fixture main_finding_index has to respect.
const isStory = (f) => f.finding_type !== 'positive';

const PROBE = {
  probe_id: 'prb_master_1', agency_id: 'agc_master', probe_reference: 'NOV-M-1',
  property_address: 'Grey Lady Place', property_price: '£450,000.00',
  portal: 'Rightmove', probe_timestamp: '2026-08-21T20:14:00Z',
  observation_deadline: '2026-08-25T20:14:00Z',
  enquiry_text: 'Interested in viewing this property. Also declared: has a property to sell — it is not yet on the market.',
};
const INTEL = {
  human_contact: 'yes', response_hours: 0.13, contact_attempts: 2, follow_ups: 1,
  channels_used: 'email', viewing_progression: 'invited', seller_recognition: 'none', grade: 'D',
};
const POSITIVE = { finding_index: 1, finding_type: 'positive', finding: 'The team replied quickly.', evidence: 'A human reply arrived in 8 minutes.', significance_note: 'Fast handling.' };
const SELLER_MISSED = { finding_index: 2, finding_type: 'opportunity', finding: 'The declared seller opportunity was missed completely.', evidence: 'The enquiry declared a property to sell; nobody mentioned it.', significance_note: 'A potential valuation was invisible.' };

function baseAnswer(overrides = {}) {
  return {
    story_reasoning: '1. positive 1. 2. main 2.',
    positive_finding_index: 1, main_finding_index: 2, wider_finding_index: null,
    primary_narrative: 'The buying side moved and the selling side never did.',
    supporting_findings: '',
    fair_observation: 'you replied quickly and progressed the viewing.',
    main_finding: 'the seller side was never raised.',
    commercial_consequence: 'a declared valuation opportunity was never opened at all.',
    email_observation: "You got back to me quickly, but nobody picked up that I'd also said I had a property to sell.",
    email_commercial_hook: "That seller wasn't a cold database record — they were already engaging with your branch as a buyer.",
    email_commercial_hook_email_2: 'You handled the buying side quickly; the part worth a look is that the same message had already given you a second reason to call.',
    novus_counterfactual: 'NOVUS would have opened both threads in the same conversation.',
    ...overrides,
  };
}

// diagnosis defaults to the same minimal, prose-free object the production
// caller now builds. Section C overrides it with deliberately contradictory
// DIAGNOSIS prose to prove that prose changes nothing.
const BARE_DIAGNOSIS = { diagnosis_summary: 'final', novus_opportunity: 'Core (front desk)' };

// seen: every { system, prompt } actually put in front of the model, so a test
// can assert what the AI layer was and was not told, rather than assuming it
// from the call site.
async function run({ probe = PROBE, findings, intelligence = {}, reply, diagnosis = BARE_DIAGNOSIS }) {
  let calls = 0;
  const seen = [];
  __setAiCallerForTests(async ({ tool, system, prompt }) => {
    calls += 1;
    seen.push({ system, prompt });
    return typeof reply === 'function' ? reply(calls, tool) : reply;
  });
  const row = await personaliseProbe(
    probe, { ...INTEL, ...intelligence },
    diagnosis, findings, { agency_name: 'Example Estates' },
  );
  return { row, calls, seen };
}

async function main() {
  console.log('NOVUS Personalisation Contract — MASTER regression suite\n');

  // ══ Section A: run every sibling suite that already pins a deterministic
  //    rule, so one command proves the whole contract ══════════════════════
  const SIBLING_SUITES = [
    'novus-personalisation-contract-selftest.mjs',   // rules 1,3-6,7-9,10-20,26,29,32(partial)
    'novus-diagnosis-seller-price-selftest.mjs',      // rules 3,4,27,28
    'novus-probe-diagnosis-selftest.mjs',             // rules 1,2,10,11,13,27,32(partial)
    'novus-diagnosis-findings-flow-selftest.mjs',     // rules 2,12,27,28
    'novus-findings-duplication-selftest.mjs',        // rule 13 (distinct rows, no dupes)
    'novus-email-personalisation-selftest.mjs',       // rules 14-18 (simplified email shape)
  ];
  for (const suite of SIBLING_SUITES) {
    const result = spawnSync(process.execPath, [path.join(here, suite)], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0, `${suite} must pass:\n${result.stdout}\n${result.stderr}`);
    ok(`sibling suite passes: ${suite}`);
  }

  // ══ Section B: hermetic edge cases the audit brief asked for that are NOT
  //    already covered elsewhere ═══════════════════════════════════════════

  // B1. Rule 21 — unsupported financial-loss claims. readsAsInventedLoss/
  // stripInventedLoss ARE wired into emailVariable() (called from
  // fair_observation, main_finding, commercial_consequence and all three
  // Instantly variables), but had NO dedicated test anywhere in the repo
  // before this suite. This pins that the guard actually fires end-to-end.
  {
    for (const invented of [
      'that missed valuation could have earned the branch a 1.5% commission.',
      'you lost out on thousands of pounds in fees by not calling back.',
      'this enquiry alone cost the agency real revenue.',
      'a follow-up call would have been worth £450,000 to the branch.',
    ]) {
      assert.strictEqual(readsAsInventedLoss(invented), true, `must be flagged as invented loss: "${invented}"`);
    }
    assert.strictEqual(readsAsInventedLoss('the £450,000 buyer enquiry was never followed up.'), false,
      'stating the probe\'s own property value is not, by itself, an invented-loss claim');

    const { row, calls } = await run({
      findings: [POSITIVE, SELLER_MISSED],
      reply: (call) => (call === 1
        ? baseAnswer({ email_commercial_hook: 'That missed seller conversation could have earned you a 1.5% commission on a £450,000 sale.' })
        : baseAnswer()),
    });
    assert.strictEqual(calls, 2, 'the invented-fee hook is rejected and one repair is attempted');
    assert.strictEqual(/commission|per ?cent|%/i.test(row.email_commercial_hook), false,
      'no invented fee/commission figure ever reaches the persisted row');
    ok('B1 [rule 21]: invented fees/commissions/percentages are rejected end-to-end, not just detectable in isolation');
  }

  // B2. Rule 5/6 — BUYER ADDRESS MUST NOT BECOME SELLER ADDRESS.
  //
  // PROBES.property_address is the property enquired about AS A BUYER, and the
  // data model carries no seller-property address at all. The guard is the
  // same provenance shape as the seller-price rule: does the address sit in a
  // clause that claims it as the prospect's own / the property to sell / the
  // instruction / the valuation property?
  {
    const A = 'Grey Lady Place';
    // Detection: attribution in the address's own clause.
    for (const leak of [
      'My property on Grey Lady Place was never valued.',
      'The Grey Lady Place property I had to sell was ignored.',
      'your team ignored my Grey Lady Place valuation opportunity.',
      'Nobody offered a valuation on Grey Lady Place, the property I have to sell.',
    ]) {
      assert.strictEqual(attributesEnquiryAddressToSeller(leak, A), true,
        `address attribution must be detected: "${leak}"`);
      const cleaned = stripEnquiryAddressAttribution(leak, A);
      assert.strictEqual(cleaned.includes(A), false, `the address must not survive in seller context: "${leak}"`);
      assert.ok(cleaned.trim(), `sanitising must not empty the field: "${leak}"`);
      assert.ok(cleaned.split(/\s+/).length >= leak.split(/\s+/).length - 4,
        `the commercial point must survive, not just a fragment: "${leak}" -> "${cleaned}"`);
    }

    // Legitimate buyer-side usage survives BYTE-IDENTICAL, including the
    // mixed-clause sentence where a seller mention sits in another clause.
    for (const fine of [
      'You replied about Grey Lady Place quickly.',
      'My enquiry about Grey Lady Place got a fast reply.',
      'The Grey Lady Place viewing was offered the same day.',
      "You replied fast about Grey Lady Place, but nobody picked up that I'd also said I had a property to sell.",
    ]) {
      assert.strictEqual(attributesEnquiryAddressToSeller(fine, A), false,
        `buyer-side use of the enquiry address is not an attribution: "${fine}"`);
      assert.strictEqual(stripEnquiryAddressAttribution(fine, A), fine,
        `correctly-scoped copy must pass through byte-identical: "${fine}"`);
    }

    // AN ADDRESS IS NEVER ITS OWN SELLER EVIDENCE. Real street names carry the
    // lexicon's own words, and a naive clause scan flags every correct mention.
    for (const addr of ['Vendor Lane', 'Valuation Road', 'Sellers Close']) {
      assert.strictEqual(
        attributesEnquiryAddressToSeller(`So the person enquiring about ${addr} was warmer than the enquiry looked.`, addr),
        false, `the street name itself must not read as seller context: ${addr}`);
      assert.strictEqual(
        attributesEnquiryAddressToSeller(`My property on ${addr} was never valued.`, addr),
        true, `but a genuine attribution on the same address is still caught: ${addr}`);
    }

    // End to end: rejected, repaired inside the existing budget, and the
    // mandatory field is never left blank.
    const { row, calls } = await run({
      findings: [POSITIVE, SELLER_MISSED],
      reply: (call) => (call === 1
        ? baseAnswer({ email_observation: 'You got back to me quickly, but you never mentioned that Grey Lady Place is actually the property I have to sell.' })
        : baseAnswer()),
    });
    assert.strictEqual(calls, 2, 'the address attribution is rejected and one bounded repair is attempted');
    assert.strictEqual(attributesEnquiryAddressToSeller(row.email_observation, A), false,
      'no address attribution reaches the persisted row');
    assert.ok(has(row.email_observation), 'and the mandatory field is never blanked by this guard');
    ok('B2 [rule 5/6]: buyer-enquiry address attributed to the seller property is caught as a provenance rule, stripped surgically, and legitimate buyer-side use survives verbatim');
  }

  // B3. Rule 23 — NO TRANSCRIPT DOES NOT MEAN NO CONTENT.
  //
  // The existing voicemail uncertainty mechanism is extended, not replaced: a
  // record that was never captured leaves content just as unknown as a record
  // that is damaged, so both raise the same flag and block the same claims.
  {
    const noTranscriptFinding = {
      finding_index: 3, finding_type: 'problem',
      finding: 'A call was made to the buyer but no transcript or recording exists for it.',
      evidence: 'Call log shows one outbound call of 42 seconds; no transcript was captured.',
      significance_note: 'Call content cannot be reviewed.',
    };
    const cutOffVoicemail = {
      finding_index: 4, finding_type: 'problem',
      finding: 'The voicemail cut off mid-sentence with no availability request given.',
      evidence: 'Voicemail transcript: "Hi it\'s Terry, just calling about your enq—" (cuts off).',
      significance_note: 'Transcript is incomplete.',
    };
    const cleanVoicemail = {
      finding_index: 5, finding_type: 'problem',
      finding: 'The voicemail never mentioned the property or offered a viewing.',
      evidence: 'Full transcript: "Hi, thanks for enquiring, give me a call back when you can." Nothing else was said.',
      significance_note: 'A complete, legible transcript.',
    };

    assert.strictEqual(hasUnreliableVoicemailEvidence([noTranscriptFinding]), true,
      '"no transcript was captured" leaves the content unknown, exactly like a damaged one');
    // EXISTING BEHAVIOUR UNCHANGED.
    assert.strictEqual(hasUnreliableVoicemailEvidence([cutOffVoicemail]), true,
      'the explicit cut-off case behaves exactly as before');
    assert.strictEqual(hasUnreliableVoicemailEvidence([cleanVoicemail]), false,
      'a complete, legible transcript is still not unreliable');

    // Claims about what the call CONTAINED are blocked.
    for (const claim of [
      'the call had no real content.',
      'nothing substantive was said on that call.',
      'the voicemail contained no meaningful content at all.',
    ]) assert.strictEqual(makesUnsupportedVoicemailClaim(claim), true, `content claim must be blocked: "${claim}"`);

    // Evidence-bounded wording stays fully sayable — this is what the copy
    // SHOULD say, so it must never be rejected.
    for (const bounded of [
      'there is no recorded content showing seller progression.',
      'there is no evidenced progression from the available call record.',
      'nobody ever called back after leaving that voicemail.',
    ]) assert.strictEqual(makesUnsupportedVoicemailClaim(bounded), false, `evidence-bounded wording must survive: "${bounded}"`);

    // End to end: the claim is ungroundable, so it never banks.
    const { row } = await run({
      findings: [POSITIVE, noTranscriptFinding],
      reply: () => baseAnswer({
        main_finding_index: 3, wider_finding_index: null,
        main_finding: 'the call had no real content.',
        email_observation: 'You called once, but the call had no real content and nothing substantive was said.',
      }),
    });
    assert.strictEqual(row.main_finding, '',
      'a claim about a never-captured call\'s content is never persisted');
    assert.strictEqual(row.email_observation, '', 'nor the same claim in the Instantly observation');
    ok('B3 [rule 23]: "no transcript captured" now raises the same uncertainty as a damaged one, content claims are blocked, evidence-bounded wording survives, and cut-off/garbled behaviour is unchanged');
  }

  // B4. Rule 24 — NO FALSE PROSPECT-REPLY CLAIMS.
  //
  // The probe sends one enquiry and then deliberately says nothing for the
  // whole observation window. A structural first-person-subject + contact-verb
  // test catches the invented action without enumerating phrasings, and
  // without touching the enquiry verbs the email is legitimately built from.
  {
    for (const invented of [
      'I replied to your email but heard nothing back.',
      'I was already replying to your outreach when it went quiet.',
      'I called back twice about this.',
      'we were speaking about the property that week.',
      'we had a conversation about the valuation.',
      'you already had me engaged as a buyer.',
      'I responded the same day.',
    ]) assert.strictEqual(claimsProspectReply(invented), true, `invented prospect action must be rejected: "${invented}"`);

    // PROBE FACTS SURVIVE — these are what the email is actually made of.
    for (const fact of [
      'I enquired about the property on 21 August.',
      'I said I had a property to sell.',
      "I'd mentioned that I had a place to sell too.",
      'I asked for more details about the property.',
      // Negated forms are TRUE statements about the probe.
      'I never replied during the observation period.',
      "I didn't call back, and nothing followed your first reply.",
      // Second-person copy about the AGENCY replying is the normal case.
      'You got back to me quickly, but nobody picked up that I had a property to sell.',
      'You replied within minutes of the enquiry landing.',
    ]) assert.strictEqual(claimsProspectReply(fact), false, `legitimate probe fact must survive: "${fact}"`);

    // End to end: unsupported, so it is rejected AND never banked.
    const { row, calls } = await run({
      findings: [POSITIVE, SELLER_MISSED],
      reply: () => baseAnswer({ email_observation: 'I replied to your email twice, but nobody picked up that I had a property to sell.' }),
    });
    assert.strictEqual(calls, 2, 'the repair is attempted');
    assert.strictEqual(row.email_observation, '',
      'a false prospect-reply claim is never persisted, repaired or not');

    // UNLESS THE EVIDENCE SAYS OTHERWISE. The rule is "do not invent", not
    // "the prospect can never have acted".
    const repliedFinding = {
      finding_index: 3, finding_type: 'problem',
      finding: 'The buyer replied to the first email asking for a viewing time, and nobody answered.',
      evidence: 'Inbound message from the enquirer at 09:14; no agency response followed.',
      significance_note: 'A live conversation was dropped.',
    };
    assert.strictEqual(evidenceShowsProspectReply([repliedFinding]), true,
      'a finding that records an inbound reply supports the claim');
    assert.strictEqual(evidenceShowsProspectReply([POSITIVE, SELLER_MISSED]), false,
      'the ordinary probe findings support no prospect-side action');
    const supported = await run({
      findings: [POSITIVE, repliedFinding],
      reply: () => baseAnswer({
        main_finding_index: 3, wider_finding_index: null,
        email_observation: 'I replied asking for a viewing time, and nothing came back after that.',
      }),
    });
    assert.strictEqual(supported.calls, 1, 'evidenced prospect contact costs no repair call');
    assert.ok(has(supported.row.email_observation),
      'and the evidenced claim is persisted rather than blocked');
    ok('B4 [rule 24]: invented prospect replies/calls/conversations are rejected and never banked, probe facts and negated forms survive, and an evidenced inbound reply stays sayable');
  }

  // B5. Rules 16/17 — Hook 1 vs Hook 2 distinctness, re-pinned at the master
  // level with a THIRD wording that is neither a lexical restatement nor a
  // near-duplicate token-for-token, but still says nothing Hook 1 didn't:
  // secondHookFailure only catches restatement/blank/too-long/consultant-
  // speak mechanically, exactly as its own doc comment says — whether a
  // well-formed Hook 2 genuinely reframes anything is the prompt's job. This
  // is intentional and not a gap; pinned here so the boundary is visible at
  // the contract level, not just inside probe-personalisation.mjs's comments.
  {
    const observation = "You replied within 10 hours, but nobody picked up that I'd also said I had a property to sell.";
    const hook = "That seller wasn't a cold database record — they were already engaging with your branch as a buyer.";
    const wellFormedButFlat = 'The seller opportunity sat there unacknowledged, which is worth noting given how quickly the buyer side moved.';
    assert.strictEqual(secondHookFailure(wellFormedButFlat, observation, hook), null,
      'mechanically distinct wording passes the deterministic gate even when it barely adds anything — semantic depth is deliberately the prompt\'s job, not the guard\'s');
    ok('B5 [rules 16/17]: Hook 1/Hook 2 mechanical distinctness is enforced; semantic added-value is confirmed as a documented, deliberate non-gap (prompt-owned)');
  }

  // B6. Rule 19/26 — sanitiser-caused blank field vs a genuine complete miss.
  // A complete-miss probe (no human contact at all) must never have a
  // positive manufactured, AND when the model tries anyway the sanitiser
  // must blank it silently rather than inventing a workaround — while a
  // seller-price sanitiser hit on a genuinely eligible probe must NOT leave
  // a mandatory field blank (BUG 2, already pinned in the sibling suite;
  // re-asserted here as the two cases side by side, since the audit brief
  // asks for them as one pair of edge cases).
  {
    const completeMiss = await run({
      findings: [{ finding_index: 1, finding_type: 'problem', finding: 'No meaningful human response arrived in the four-day observation period.', evidence: 'Human contact: none across four days.', significance_note: 'No conversation was created.' }],
      intelligence: { human_contact: 'none', response_hours: '', contact_attempts: 0, follow_ups: 0, viewing_progression: 'none' },
      reply: () => baseAnswer({
        positive_finding_index: 1, main_finding_index: null, wider_finding_index: null,
        fair_observation: 'you replied quickly and handled everything well.',
        email_observation: 'You replied quickly and handled everything well.',
      }),
    });
    assert.strictEqual(completeMiss.row.fair_observation, '', 'complete miss: no positive is manufactured, ever');
    assert.strictEqual(completeMiss.row.email_observation, '',
      'complete miss: the same fake-positive claim is blanked in the Instantly variable too, not worked around');

    const sanitiserHit = await run({
      findings: [POSITIVE, SELLER_MISSED],
      reply: () => baseAnswer({ email_observation: 'You never came back on my £450,000 seller enquiry at all.' }),
    });
    assert.ok(has(sanitiserHit.row.email_observation),
      'sanitiser-hit probe: the price is stripped surgically, the mandatory field is never left blank');
    ok('B6 [rules 19/26]: a complete miss blanks silently rather than inventing a positive; a sanitiser hit on an eligible probe never blanks a mandatory field');
  }

  // B7. Rule 6 — buying and selling opportunities stay distinct even when
  // BOTH progressed, so a genuine double-positive probe is not collapsed
  // into one undifferentiated "it went well" line.
  {
    const bothProgressed = await run({
      findings: [POSITIVE],
      intelligence: { viewing_progression: 'booked', seller_recognition: 'valuation_booked' },
      reply: () => baseAnswer({
        main_finding_index: null, wider_finding_index: null, main_finding: '', commercial_consequence: '',
        email_observation: 'You came back within minutes, booked the viewing and picked up that I had a place to sell too.',
        email_commercial_hook: 'So both the viewing and the valuation came out of that one enquiry.',
      }),
    });
    assert.match(bothProgressed.row.email_observation, /viewing/i);
    assert.match(bothProgressed.row.email_observation, /place to sell|property to sell/i);
    assert.doesNotMatch(bothProgressed.row.email_observation, /£/,
      'no figure is needed or used to distinguish the two sides');
    ok('B7 [rule 6]: buying and selling stay two distinct, separately named threads even when both progressed well');
  }


  // ══ Section C: THE ARCHITECTURE CONTRACT ═════════════════════════════════
  //
  //   PROBES + INTELLIGENCE -> DIAGNOSIS_FINDINGS -> PERSONALISATION -> DEMOS
  //
  // DIAGNOSIS_FINDINGS is the SINGLE authoritative commercial interpretation
  // layer (rule 39). INTELLIGENCE remains the factual state layer. The broad
  // DIAGNOSIS prose — diagnosis_summary, strengths, missed_opportunities,
  // commercial_implication — is NON-AUTHORITATIVE downstream (rule 38) and is
  // now structurally unable to reach the expression layer: personaliseProbe
  // narrows whatever DIAGNOSIS-shaped object it is handed to the single
  // novus_opportunity enum at its own boundary, so no later edit inside the
  // copy path can reach a prose field, because no prose field survives the
  // call. These blocks prove that, rather than trusting the convention.

  // THE POISONED DIAGNOSIS ROW. Every prose field carries a unique sentinel
  // and a claim that CONTRADICTS the findings and the probe facts: a priced
  // seller property (banned outright by rules 3/4), praise the findings do not
  // support, and a summary asserting the opposite of the intelligence.
  const POISONED_DIAGNOSIS = {
    diagnosis_summary: 'SENTINEL_SUMMARY Joe had a 450000 pound property to sell and no response was ever received.',
    strengths: 'SENTINEL_STRENGTHS Nothing at all was done well here.',
    missed_opportunities: 'SENTINEL_MISSED A 450k seller opportunity in the same price bracket was lost.',
    commercial_implication: 'SENTINEL_IMPLICATION This cost the branch about 6000 pounds in commission.',
    novus_opportunity: 'Core (front desk)',
  };
  const SENTINELS = ['SENTINEL_SUMMARY', 'SENTINEL_STRENGTHS', 'SENTINEL_MISSED', 'SENTINEL_IMPLICATION'];

  // C1 [test A, rules 38/39/40] — DIAGNOSIS PROSE IS IGNORED.
  // Same probe, same intelligence, same findings; one run gets the poisoned
  // prose row, the other a bare row. The two must be byte-identical, and no
  // sentinel may appear in anything the model was shown.
  {
    const findings = [POSITIVE, SELLER_MISSED];
    const answer = () => baseAnswer();
    const poisoned = await run({ findings, reply: answer, diagnosis: POISONED_DIAGNOSIS });
    const clean = await run({ findings, reply: answer, diagnosis: BARE_DIAGNOSIS });

    assert.deepStrictEqual(poisoned.row, clean.row,
      'DIAGNOSIS prose must have ZERO influence on the persisted Personalisation row');
    assert.strictEqual(poisoned.calls, clean.calls, 'and none on the AI-call budget either');

    const shown = poisoned.seen.map((c) => `${c.system}\n${c.prompt}`).join('\n');
    assert.ok(shown.length > 0, 'the model was actually called (guards against a vacuous pass)');
    for (const sentinel of SENTINELS) {
      assert.strictEqual(shown.includes(sentinel), false,
        `DIAGNOSIS prose reached the model: ${sentinel}`);
    }
    // The structured finding IS shown — this is what proves the prompt is
    // findings-grounded rather than simply empty.
    assert.ok(shown.includes(SELLER_MISSED.finding), 'the structured finding is what the model is given');
    for (const value of Object.values(poisoned.row)) {
      for (const sentinel of SENTINELS) {
        assert.strictEqual(String(value).includes(sentinel), false, `DIAGNOSIS prose reached the row: ${sentinel}`);
      }
    }
    ok('C1 [test A, rules 38/39]: DIAGNOSIS prose changes nothing — identical row, identical budget, and not one prose token reaches the model or the sheet');
  }

  // C2 [test B, rules 1/2/38] — CONFLICTING DIAGNOSIS SUMMARY.
  // DIAGNOSIS says "No response was received." INTELLIGENCE says human_contact
  // yes at 0.5h. DIAGNOSIS_FINDINGS say the agent replied within 30 minutes.
  // Downstream must follow INTELLIGENCE + findings, all the way through to the
  // hero journey and the positive the email is allowed to give credit for.
  {
    const REPLIED_FAST = {
      finding_index: 1, finding_type: 'positive',
      finding: 'The team replied within 30 minutes.',
      evidence: 'A human reply arrived 0.5 hours after the enquiry.',
      significance_note: 'Fast first contact.',
    };
    const conflicted = await run({
      findings: [REPLIED_FAST, SELLER_MISSED],
      intelligence: { human_contact: 'yes', response_hours: 0.5 },
      diagnosis: { ...POISONED_DIAGNOSIS, diagnosis_summary: 'SENTINEL_SUMMARY No response was received.' },
      reply: () => baseAnswer({
        email_observation: "You came back within half an hour, but nobody picked up that I'd also said I had a property to sell.",
      }),
    });

    // The prose said no response. The row credits the response.
    assert.match(conflicted.row.email_observation, /half an hour/i);
    assert.strictEqual(conflicted.row.positive_finding_index, 1,
      'the positive the FINDINGS evidence is selected, despite prose claiming no response');
    assert.notStrictEqual(conflicted.row.hero_journey, 'complete_miss',
      'hero journey follows INTELLIGENCE.human_contact, never the prose');
    assert.strictEqual(conflicted.row.hero_journey, 'weak_seller_qualification',
      'and lands on the journey the INTELLIGENCE state actually implies');
    ok('C2 [test B, rules 1/2/38]: where DIAGNOSIS prose contradicts INTELLIGENCE and the findings, downstream follows INTELLIGENCE and the findings');
  }

  // C3 [rules 38/39] — THE REBUILD STEP HANDS ACROSS ONE ENUM, NOT A ROW.
  // C1/C2 prove personaliseProbe ignores prose. This proves the production
  // caller never even offers it: an in-memory workbook whose DIAGNOSIS row is
  // stuffed with sentinels is personalised, and personaliseProbe's third
  // argument is captured and inspected.
  {
    const table = (header, rows) => ({ header, rows });
    const captured = [];
    const findingsHeader = ['probe_id', 'finding_index', 'finding_type', 'finding', 'evidence', 'significance_note'];
    const personalisationHeader = ['personalisation_id', 'agency_id', 'probe_id', 'hero_journey',
      'primary_narrative', 'narrative_finding_indexes', 'positive_finding_index', 'main_finding_index',
      'wider_finding_index', 'supporting_findings', 'evidence', 'novus_counterfactual', 'fair_observation',
      'main_finding', 'commercial_consequence', 'property_reference', 'email_observation',
      'email_commercial_hook', 'email_commercial_hook_email_2', 'created_at', 'updated_at'];
    const diagnosisHeader = ['diagnosis_id', 'agency_id', 'probe_id', 'strengths', 'missed_opportunities',
      'commercial_implication', 'novus_opportunity', 'diagnosis_summary'];

    const repo = {
      async getTable(tab) {
        if (tab === 'INTELLIGENCE') {
          return table(['intelligence_id', 'agency_id', 'probe_id', 'human_contact', 'response_hours',
            'viewing_progression', 'seller_recognition', 'observation_status'],
          [['int_1', 'agc_master', 'prb_arch_1', 'yes', '0.13', 'invited', 'none', 'closed']]);
        }
        if (tab === 'DIAGNOSIS') {
          return table(diagnosisHeader, [['dia_1', 'agc_master', 'prb_arch_1',
            POISONED_DIAGNOSIS.strengths, POISONED_DIAGNOSIS.missed_opportunities,
            POISONED_DIAGNOSIS.commercial_implication, 'Core (front desk)',
            POISONED_DIAGNOSIS.diagnosis_summary]]);
        }
        if (tab === 'PERSONALISATION') return table(personalisationHeader, []);
        if (tab === 'AGENCIES') return table(['agency_id', 'agency_name'], [['agc_master', 'Example Estates']]);
        if (tab === 'DIAGNOSIS_FINDINGS') {
          return table(findingsHeader, [
            ['prb_arch_1', '1', 'positive', POSITIVE.finding, POSITIVE.evidence, POSITIVE.significance_note],
            ['prb_arch_1', '2', 'opportunity', SELLER_MISSED.finding, SELLER_MISSED.evidence, SELLER_MISSED.significance_note],
          ]);
        }
        return table([], []);
      },
      async writeRowsBatch(writes) { captured.push(...writes); },
    };

    const seenPrompts = [];
    // The third argument personaliseProbe is handed, recorded through the AI
    // caller boundary — the prompt is what the model sees, and the assertion
    // below on the WRITTEN ROW is what the prospect eventually sees.
    __setAiCallerForTests(async ({ system, prompt }) => {
      seenPrompts.push(`${system}\n${prompt}`);
      return baseAnswer();
    });

    const summary = await rebuildAllPersonalisation(repo, new Map([['prb_arch_1', { ...PROBE, probe_id: 'prb_arch_1' }]]));
    assert.strictEqual(summary.personalisations_processed, 1, 'the probe was personalised');
    assert.deepStrictEqual(summary.problems, [], 'and without error');
    const shown = seenPrompts.join('\n');
    const written = captured.map((w) => w.row.join(' | ')).join('\n');
    for (const sentinel of SENTINELS) {
      assert.strictEqual(shown.includes(sentinel), false, `rebuild leaked DIAGNOSIS prose to the model: ${sentinel}`);
      assert.strictEqual(written.includes(sentinel), false, `rebuild leaked DIAGNOSIS prose to PERSONALISATION: ${sentinel}`);
    }
    ok('C3 [rules 38/39]: the production rebuild path hands Personalisation the findings and one enum — no DIAGNOSIS prose reaches the model or the written row');
  }

  // C4 [test M, rule 29] — NON-REGRESSION FOR EVERYTHING THIS DOES NOT TOUCH.
  // The legacy call shape (a full DIAGNOSIS row) and the new narrow shape must
  // produce byte-identical rows across a spread of fixtures: same selected
  // indexes, same hero journey, same deterministic copy, same guard outcomes.
  {
    const fixtures = [
      { name: 'positive + seller miss', findings: [POSITIVE, SELLER_MISSED], intelligence: {} },
      { name: 'complete miss', findings: [SELLER_MISSED], intelligence: { human_contact: 'none', response_hours: '' } },
      { name: 'strong handling, no story finding', findings: [POSITIVE], intelligence: { viewing_progression: 'booked', seller_recognition: 'valuation_booked' } },
      { name: 'slow response', findings: [POSITIVE, SELLER_MISSED], intelligence: { response_hours: 40 } },
    ];
    for (const fixture of fixtures) {
      for (const opportunity of ['Core (front desk)', 'Growth (valuation list / seller conversion)', 'None evidenced']) {
        const legacy = await run({
          findings: fixture.findings, intelligence: fixture.intelligence,
          diagnosis: { ...POISONED_DIAGNOSIS, novus_opportunity: opportunity },
          reply: () => baseAnswer({ main_finding_index: fixture.findings.some(isStory) ? 2 : null }),
        });
        const narrow = await run({
          findings: fixture.findings, intelligence: fixture.intelligence,
          diagnosis: { novus_opportunity: opportunity },
          reply: () => baseAnswer({ main_finding_index: fixture.findings.some(isStory) ? 2 : null }),
        });
        assert.deepStrictEqual(narrow.row, legacy.row,
          `${fixture.name} / ${opportunity}: narrowing the diagnosis argument changed the row`);
      }
    }
    // And the hero-journey lookup itself is untouched: the same enum still
    // routes the same way for a probe with no story finding.
    assert.strictEqual(
      pickHeroJourney({ human_contact: 'yes', response_hours: 0.1 }, [POSITIVE], { novus_opportunity: 'Growth (valuation list / seller conversion)' }),
      'strong_handling_database_opportunity');
    assert.strictEqual(
      pickHeroJourney({ human_contact: 'yes', response_hours: 0.1 }, [POSITIVE], { novus_opportunity: 'Core (front desk)' }),
      'strong_handling_no_opportunity');
    ok('C4 [test M, rule 29]: selected indexes, hero journey, deterministic copy and guard outcomes are identical before and after the architecture change, across every novus_opportunity value');
  }

  // C5 [test C, rules 33/34] — TRUE FACTS, FALSE ORDER.
  // The seller position was declared in the ORIGINAL enquiry. An agency that
  // later asks "are you selling?" is asking for something it already had —
  // that is the point. Reversing it into "you asked, then I answered" invents
  // a reply I never sent, out of two facts that are both true.
  {
    for (const bad of [
      'After you asked, I said yes.',
      'You asked if I was selling, then I said yes.',
      "After you asked, I told you my property wasn't on the market.",
      'You asked whether I had somewhere to sell, and I confirmed it.',
      'Only then did I say I had a property to sell.',
    ]) {
      assert.strictEqual(readsAsFalseChronology(bad), true, `false chronology must be caught: "${bad}"`);
    }
    for (const good of [
      'You asked whether I was selling despite that already being stated in my original enquiry.',
      "I'd already said in my original enquiry that my property wasn't on the market.",
      'You later asked whether I was selling, despite that already being stated in my original enquiry.',
      "You got back to me quickly, but nobody picked up that I'd also said I had a property to sell.",
      'You asked for my availability for a viewing.',
    ]) {
      assert.strictEqual(readsAsFalseChronology(good), false, `true chronology must survive: "${good}"`);
    }

    // End to end: the false version is rejected, one repair is spent, and the
    // false claim never reaches the row under any field.
    const chronology = await run({
      findings: [POSITIVE, SELLER_MISSED],
      reply: (call) => (call === 1
        ? baseAnswer({ email_observation: 'You asked if I was selling, then I said yes, which was three days too late.' })
        : baseAnswer({ email_observation: 'You later asked whether I was selling, despite that already being stated in my original enquiry.' })),
    });
    assert.strictEqual(chronology.calls, 2, 'the false chronology is rejected and one repair is attempted');
    assert.strictEqual(readsAsFalseChronology(chronology.row.email_observation), false,
      'no false chronology survives into the persisted row');
    assert.match(chronology.row.email_observation, /already being stated in my original enquiry/i,
      'and the TRUE version of the same point is exactly what persists');

    // It never banks, either: a false order is a false fact, not a wording
    // preference, so a repair that fails leaves the field blank rather than
    // persisting the disprovable sentence.
    const unrepaired = await run({
      findings: [POSITIVE, SELLER_MISSED],
      reply: () => baseAnswer({ email_observation: 'You asked if I was selling, then I said yes.' }),
    });
    assert.strictEqual(has(unrepaired.row.email_observation), false,
      'a false chronology is never banked as a soft fallback');
    ok('C5 [test C, rules 33/34]: a declaration re-sequenced behind the agency\'s question is rejected, never banked, and the true "you asked for what you already had" framing passes untouched');
  }

  // C6 [test D, rules 24/35] — NO INVENTED PROSPECT SIDE, IN ANY GRAMMAR.
  // The brief's three failing shapes, including the one that is a chronology
  // claim rather than a contact claim.
  {
    const rejects = (text) => claimsProspectReply(text) || readsAsFalseChronology(text);
    for (const bad of [
      'I was already replying to your enquiries.',
      'When I replied, nobody picked it up.',
      'I answered your question about the property I had to sell.',
      'We were speaking by then.',
      'You already had me engaged.',
    ]) {
      assert.strictEqual(rejects(bad), true, `invented prospect side must be caught: "${bad}"`);
    }
    for (const good of [
      'I had already stated in my original enquiry that I had a property to sell.',
      'I enquired about Riverside Court.',
      'I said in my original enquiry that I had a property to sell.',
      'I never replied, and nothing needed my answer to happen.',
    ]) {
      assert.strictEqual(rejects(good), false, `a probe fact must survive: "${good}"`);
    }
    ok('C6 [test D, rules 24/35]: invented replies, invented answers and invented two-way conversation are all rejected; original-enquiry declarations survive verbatim');
  }

  // C7 [test E, rules 35/36] — THE DELIBERATE NO-REPLY METHODOLOGY IS NOT AN
  // AGENCY FAILURE. Four attempts, zero replies: the agency is judged on what
  // it sent, asked, progressed and recognised, never on whether we carried on
  // talking.
  {
    const persistent = { ...INTEL, contact_attempts: 4, follow_ups: 3, viewing_progression: 'invited' };
    assert.strictEqual(agencyMadeNextStepAttempt(persistent), true,
      'a viewing invitation is a genuine next-step attempt, so the fairness rule applies');
    for (const bad of [
      'None of them became a real conversation.',
      'Four attempts never became a real conversation.',
      'Nothing progressed.',
      'None of it moved forward.',
    ]) {
      assert.strictEqual(readsAsUnfairOutcomeCriticism(bad), true,
        `punishing the agency for MY silence must be caught: "${bad}"`);
    }
    for (const good of [
      'Four attempts were made, but none progressed the seller side.',
      'Four attempts were made, but none included a concrete next step on the seller side.',
      'You followed up three times across phone and email.',
      'The viewing side progressed, but nothing on the seller side was ever acknowledged.',
    ]) {
      assert.strictEqual(readsAsUnfairOutcomeCriticism(good), false,
        `an agency-owned criticism must stay sayable: "${good}"`);
    }

    const unfair = await run({
      findings: [POSITIVE, SELLER_MISSED], intelligence: persistent,
      reply: () => baseAnswer({ email_commercial_hook: 'Four attempts, and none of them became a real conversation.' }),
    });
    assert.strictEqual(has(unfair.row.email_commercial_hook), false,
      'an unfair-outcome hook is never banked — the blank has a real reason');
    ok('C7 [test E, rules 35/36]: persistence with no reply is credited, not punished; "none of them became a conversation" and "nothing progressed" are rejected and never bank');
  }

  // C8 [test I, rule 25] — PROGRESSION FAIRNESS, THE OTHER WAY ROUND.
  // A viewing WAS offered and the seller side was ignored. "Nothing
  // progressed" is now false, and the honest line names which side moved.
  {
    const buyerMoved = { ...INTEL, viewing_progression: 'invited', seller_recognition: 'none' };
    const flat = await run({
      findings: [POSITIVE, SELLER_MISSED], intelligence: buyerMoved,
      reply: (call) => (call === 1
        ? baseAnswer({ email_observation: 'You came back quickly but nothing progressed.' })
        : baseAnswer({ email_observation: 'The buyer enquiry moved toward a viewing, but the seller declaration was never picked up.' })),
    });
    assert.strictEqual(flat.calls, 2, '"nothing progressed" is rejected when something did');
    assert.match(flat.row.email_observation, /moved toward a viewing/i);
    assert.match(flat.row.email_observation, /seller declaration was never picked up/i);
    ok('C8 [test I, rule 25]: with a viewing genuinely offered, "nothing progressed" is rejected and the two sides are reported separately');
  }

  // C9 [test F, rules 5/37] and [test G, rules 3/4] — PROVENANCE, IN THE
  // BRIEF'S OWN WORDS. Section B2 pins the general rule; these are the exact
  // buyer/seller pairs the architecture brief names.
  {
    const address = 'Flat 702, Riverside Court';
    for (const bad of ['My property at Flat 702 was never valued.', 'The Riverside Court property I was selling went unmentioned.']) {
      assert.strictEqual(attributesEnquiryAddressToSeller(bad, address), true, `seller-address leak: "${bad}"`);
      const cleaned = stripEnquiryAddressAttribution(bad, address);
      assert.ok(cleaned.trim(), `sanitising must not empty the field: "${bad}"`);
    }
    for (const good of ['I enquired about Flat 702, Riverside Court.', 'You replied about Flat 702.', 'My enquiry about Riverside Court went unanswered.']) {
      assert.strictEqual(attributesEnquiryAddressToSeller(good, address), false, `buyer-side use must survive: "${good}"`);
      assert.strictEqual(stripEnquiryAddressAttribution(good, address), good, 'and survive VERBATIM');
    }

    for (const bad of ['my £425,000 property to sell was never valued', 'a £425,000 valuation opportunity was left on the table', 'a £425,000 seller instruction sat there']) {
      assert.strictEqual(attributesEnquiryPriceToSeller(bad), true, `seller-price leak: "${bad}"`);
      const cleaned = stripSellerPriceAttribution(bad);
      assert.ok(cleaned.trim(), `sanitising must not empty the field: "${bad}"`);
      assert.strictEqual(/£\s?425/.test(cleaned), false, 'the figure is removed from the seller side');
    }
    for (const good of ['my £425,000 enquiry went unanswered for 17 hours', 'the £425,000 property I enquired about never got a viewing']) {
      assert.strictEqual(attributesEnquiryPriceToSeller(good), false, `buyer-side price use must survive: "${good}"`);
      assert.strictEqual(stripSellerPriceAttribution(good), good, 'and survive VERBATIM');
    }
    ok('C9 [tests F/G, rules 3/4/5/37]: the buyer property\'s address and price stay buyer-side facts — surgically stripped from any seller clause, untouched everywhere else');
  }

  // C10 [test H, rules 22/23] — UNKNOWN CALL CONTENT IN THE BRIEF'S WORDING.
  {
    const noTranscript = [{
      finding_index: 1, finding_type: 'problem',
      finding: 'The only contact was a voice call.',
      evidence: 'Voice call logged; no transcript/content captured.',
      significance_note: 'What was discussed is unknown.',
    }];
    assert.strictEqual(hasUnreliableVoicemailEvidence(noTranscript), true,
      '"no transcript captured" leaves the content unknown');
    assert.strictEqual(makesUnsupportedVoicemailClaim('The voicemail did not mention the seller opportunity at all.'), true,
      'claiming what the call did not contain is blocked');
    assert.strictEqual(makesUnsupportedVoicemailClaim('There is no recorded call content showing whether the seller opportunity was discussed.'), false,
      'an evidence-bounded statement about OUR RECORD stays fully sayable');
    ok('C10 [test H, rules 22/23]: an uncaptured call is unknown, not empty — content claims blocked, evidence-bounded wording allowed');
  }

  // C11 [test J, rule 12] — SELECTED FINDINGS ARE THE WHOLE PERMITTED WORLD.
  // Only the seller miss is selected. Personalisation may not wander into an
  // unselected response-speed, qualification or templating finding.
  {
    const TEMPLATED = {
      finding_index: 3, finding_type: 'problem',
      finding: 'Every message was an identical boilerplate autoresponder template.',
      evidence: 'Three messages shared identical boilerplate wording.',
      significance_note: 'Templated handling.',
    };
    const wandered = await run({
      findings: [POSITIVE, SELLER_MISSED, TEMPLATED],
      reply: (call) => (call === 1
        ? baseAnswer({ email_commercial_hook: 'Identical boilerplate went out three times from the same autoresponder template.' })
        : baseAnswer()),
    });
    assert.strictEqual(wandered.calls, 2, 'an unselected finding is rejected and repaired');
    assert.strictEqual(/boilerplate|autoresponder/i.test(wandered.row.email_commercial_hook), false,
      'the unselected finding never reaches the row');
    assert.deepStrictEqual(wandered.row.narrative_finding_indexes, '1,2',
      'and the selection itself is unchanged by the repair');
    ok('C11 [test J, rule 12]: copy that introduces an unselected finding is rejected, and repairing it leaves the authoritative selection untouched');
  }

  // C12 [test K, rules 16/17] — HOOK 2 MUST ADD, NOT RESTATE.
  // The brief's own pair, run through the deterministic gate, plus the same
  // boundary B5 pins: secondHookFailure is a MECHANICAL distinctness test
  // (blank / consultant-speak / restates the observation / restates Hook 1 /
  // too long). It rejects a lexical rewrite of Hook 1 and accepts a genuinely
  // different implication. It does not, and is not meant to, judge whether a
  // mechanically-distinct sentence is semantically new — that stays the
  // prompt's job, deliberately and unchanged by this architecture pass.
  {
    const observation = "You replied within 10 hours, but nobody picked up that I had a place to sell.";
    const hook1 = 'A seller opportunity sat untouched inside that enquiry.';

    assert.strictEqual(secondHookFailure('A seller opportunity sat untouched.', observation, hook1), 'restates_hook',
      'Hook 2 may not be Hook 1 again');
    assert.strictEqual(secondHookFailure('The seller opportunity inside that enquiry sat untouched.', observation, hook1), 'restates_hook',
      'nor Hook 1 with the clauses shuffled');
    assert.strictEqual(secondHookFailure(observation, observation, hook1), 'restates_observation',
      'nor the observation again');
    assert.strictEqual(secondHookFailure('', observation, hook1), 'blank',
      'and it is mandatory');

    // Rule 16's own example — a different fact from the SAME selected story.
    assert.strictEqual(
      secondHookFailure("The interesting part is that persistence wasn't the problem — three separate contacts still worked the same single angle.", observation, hook1),
      null, 'a genuinely different implication from the same story is accepted');

    // THE DOCUMENTED BOUNDARY, pinned so it stays visible rather than being
    // rediscovered: a short pronoun-swapped paraphrase clears the mechanical
    // gate. Same deliberate non-gap as B5 — the guard governs mechanics, the
    // prompt governs whether Hook 2 actually says something new.
    assert.strictEqual(secondHookFailure('That seller opportunity was untouched.', observation, hook1), null,
      'the mechanical gate does not claim to catch a semantic near-restatement — that is prompt-owned (see B5)');
    ok('C12 [test K, rules 16/17]: Hook 2 may not restate Hook 1 or the observation and may not be blank; a genuinely different implication passes, and the semantic residue stays the documented, prompt-owned boundary');
  }

  // C13 [test L, rules 18/20] — MANDATORY FIELD SAFETY.
  // Where a guard is a TRUTH guard and the correction cannot repair it, the
  // field stays blank on purpose — and a blank mandatory field is never a
  // finished Personalisation: needsPersonalisation() keeps the row open, so a
  // half-complete row can never freeze as the final one.
  {
    const MANDATORY = ['email_observation', 'email_commercial_hook', 'email_commercial_hook_email_2'];
    const complete = await run({ findings: [POSITIVE, SELLER_MISSED], reply: () => baseAnswer() });
    for (const field of MANDATORY) {
      assert.ok(has(complete.row[field]), `${field} must be present on an eligible row`);
    }
    const columns = new Set(['primary_narrative', ...MANDATORY]);
    assert.strictEqual(needsPersonalisation({ obj: complete.row }, columns), false,
      'a complete row is finished and freezes');

    const unrepairable = await run({
      findings: [POSITIVE, SELLER_MISSED],
      reply: () => baseAnswer({ email_commercial_hook_email_2: 'You asked if I was selling, then I said yes.' }),
    });
    assert.strictEqual(has(unrepairable.row.email_commercial_hook_email_2), false,
      'an unrepairable truth failure blanks the field rather than persisting a false claim');
    assert.strictEqual(needsPersonalisation({ obj: unrepairable.row }, columns), true,
      'and that row is NOT a finished Personalisation — it never freezes with a blank mandatory field');
    ok('C13 [test L, rules 18/20]: all three email variables are present on every eligible row; a mandatory field that cannot be validly repaired blanks and the row is never accepted as finished');
  }

  // C14 [rule 19] — SANITISATION MUST NOT DESTROY GOOD COPY.
  // The brief's exact example: the priced seller clause loses its figure, not
  // its sentence.
  {
    const sanitised = stripSellerPriceAttribution('a £450k seller conversation sat untouched');
    assert.notStrictEqual(sanitised.trim(), '', 'sanitisation must never return an empty string here');
    assert.strictEqual(/£\s?450/.test(sanitised), false, 'the invented seller valuation is gone');
    assert.match(sanitised, /seller conversation sat untouched/i, 'and the commercial point survives intact');
    ok('C14 [rule 19]: sanitisation removes the unsupported figure and keeps the sentence — never a blank where good copy stood');
  }

  // C15 [rules 21/40] — NO INVENTED COMMERCIAL FACT, AND NO NEW FINDING.
  // Rule 21 is pinned end-to-end in B1; this pins the wider rule-40 shape it
  // belongs to: Personalisation may phrase the selected findings and may not
  // manufacture a commercial fact none of them carries.
  {
    for (const invented of [
      'that missed valuation could have earned the branch a 1.5% commission.',
      'this enquiry alone cost the agency real revenue.',
      'you lost £6,000 in commission on that instruction.',
    ]) {
      assert.strictEqual(readsAsInventedLoss(invented), true, `invented commercial fact: "${invented}"`);
      assert.ok(stripInventedLoss(invented) !== invented, 'and it is removed rather than left standing');
    }
    assert.strictEqual(readsAsInventedLoss('the £425,000 enquiry went unanswered for 17 hours.'), false,
      'the probe\'s own enquiry price is a fact, not an invented loss');
    ok('C15 [rules 21/40]: fees, commissions, percentages and revenue losses are invented commercial facts and are stripped; the enquiry\'s own price is not');
  }

  console.log(`\n${passed} checks passed.`);
}

main().catch((error) => { console.error(error); process.exit(1); });
