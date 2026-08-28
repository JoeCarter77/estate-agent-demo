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
import { readFileSync } from 'node:fs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';
import {
  personaliseProbe, attributesEnquiryPriceToSeller, stripSellerPriceAttribution,
  readsAsInventedLoss, stripInventedLoss, hasUnreliableVoicemailEvidence,
  makesUnsupportedVoicemailClaim, agencyMadeNextStepAttempt, readsAsUnfairOutcomeCriticism,
  secondHookFailure, readsAsThirdPersonProspect, cleanAddressForEmail,
  attributesEnquiryAddressToSeller, stripEnquiryAddressAttribution,
  claimsProspectReply, evidenceShowsProspectReply,
  readsAsFalseChronology, pickHeroJourney, _internal as _personalisationInternal,
} from '../lib/probe-personalisation.mjs';
import {
  needsPersonalisation, rebuildAllPersonalisation, blankMandatoryEmailFields,
} from '../lib/personalisation-rebuild.mjs';
import {
  buildSupportContext, findUnsupportedRelationship, RELATIONSHIP_REASONS,
  findingInventsProspectResponse,
} from '../lib/factual-relationships.mjs';
import { _internal as _diagnosisInternal } from '../lib/probe-diagnosis.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
const ok = (m) => { passed += 1; console.log(`  ✓ ${m}`); };
const has = (v) => Boolean(String(v ?? '').trim());
// A story finding (problem/opportunity) — a positive can never carry the main
// beat, which is what C4's per-fixture main_finding_index has to respect.
const isStory = (f) => f.finding_type !== 'positive';
const { NEVER_PERSIST_REASONS } = _personalisationInternal;

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


  // ══ Section D: RELATIONSHIP & PROVENANCE (contract rules 41-48) ═══════════
  //
  // Every guard in sections A-C asks whether a FACT is true. These ask whether
  // the RELATIONSHIP BETWEEN the facts is true — and that is a different
  // failure, because each individual fact in the sentence can be correct while
  // the sentence is false:
  //
  //   TRUE  the enquiry declared a property to sell
  //   TRUE  the agency called twice
  //   FALSE "I was already on the phone with you twice, and still told you
  //          I had a property to sell"
  //
  // The invention is the JOIN. Nothing was fabricated; a declaration was
  // relocated out of the only message it ever occupied.
  //
  // SUPPORT-RELATIVE, NOT A BLACKLIST — and D1 is the block that proves it,
  // because the identical sentence has to pass on one probe and fail on
  // another. Four pinned-good strings in the existing suites say "in the same
  // message", and they are correct: those probes' enquiries really did carry
  // the viewing request and the seller declaration together. A phrase list
  // would delete all four.
  const REL_PROBE = {
    ...PROBE,
    enquiry_text: 'Interested in viewing this property. Also declared: has a property to sell — it is not yet on the market.',
  };
  const BUYER_ONLY_PROBE = { ...PROBE, enquiry_text: 'Interested in viewing this property.' };
  const relSupport = (over = {}) => buildSupportContext({
    probe: REL_PROBE, findings: [POSITIVE, SELLER_MISSED], ...over,
  });

  // D1 [rule 41] — THE SAME WORDS, TRUE ON ONE PROBE AND FALSE ON ANOTHER.
  {
    const sameMessage = 'The vendor had already volunteered themselves in the same message.';
    assert.strictEqual(findUnsupportedRelationship(sameMessage, relSupport()), null,
      'co-occurrence is CORRECT when the enquiry genuinely carried both — this exact wording is pinned copy');
    assert.strictEqual(
      findUnsupportedRelationship(sameMessage, buildSupportContext({ probe: BUYER_ONLY_PROBE, findings: [POSITIVE, SELLER_MISSED] })),
      'unsupported_co_occurrence',
      'and UNSUPPORTED on a probe whose enquiry declared no seller position — same sentence, different verdict');

    // The agency-anchored form is the real failure: an enquiry fact welded
    // onto something the agency sent days later.
    assert.strictEqual(findUnsupportedRelationship('Your reply and my seller declaration were in the same message.', relSupport()),
      'unsupported_co_occurrence', 'binding an enquiry fact to an agency message is a false co-occurrence');

    // The other three pinned-good "same message" strings, unchanged.
    for (const good of [
      'the second reason to call was sitting in the same message.',
      'the same message had already given you a second reason to call.',
      'The interesting part is the £450,000 vendor you already had in the same message.',
    ]) {
      assert.strictEqual(findUnsupportedRelationship(good, relSupport()), null, `pinned-good copy must survive: "${good}"`);
    }
    // A co-occurrence claim with no seller content is not this rule's business.
    assert.strictEqual(
      findUnsupportedRelationship('You answered the price question but ignored the availability question in the same message.',
        buildSupportContext({ probe: BUYER_ONLY_PROBE, findings: [POSITIVE] })),
      null, 'the rule is scoped to seller-declaration provenance, not to every co-occurrence');
    ok('D1 [rule 41, test C]: co-occurrence is judged against the probe\'s own enquiry — the same "same message" wording passes where the enquiry carried both and fails where it did not');
  }

  // D2 [rules 42/47, test D] — A DECLARATION KEEPS THE MOMENT IT WAS MADE IN.
  // prb_hist_0006: the seller position came from the original enquiry and was
  // never mentioned on either call.
  {
    for (const bad of [
      'I was already on the phone with you twice, and still told you I had a property to sell.',
      'I told you on those calls I had a property to sell.',
      'During the call I mentioned I had a place to sell.',
      'When you called I said I had a property to sell.',
    ]) {
      assert.strictEqual(findUnsupportedRelationship(bad, relSupport()), 'unsupported_declaration_timing',
        `a declaration relocated into an agency contact event must be caught: "${bad}"`);
    }
    for (const good of [
      "You called twice, but the seller declaration I'd already included in my original enquiry was never progressed.",
      "You got back to me quickly, but nobody picked up that I'd also said I had a property to sell.",
      "I'd already said in my original enquiry that my property wasn't on the market.",
      'I never told you on the call that I was selling.',
    ]) {
      assert.strictEqual(findUnsupportedRelationship(good, relSupport()), null,
        `correct provenance and negated forms must survive: "${good}"`);
    }
    // Evidenced prospect contact licenses it — the rule is "do not invent",
    // not "the prospect can never have spoken".
    assert.strictEqual(
      findUnsupportedRelationship('I told you on those calls I had a property to sell.', relSupport({ prospectContactEvidenced: true })),
      null, 'a probe whose findings evidence a prospect-side exchange may say so');
    ok('D2 [rules 42/47, test D]: a seller declaration pinned to a call or a reply is rejected; the original-enquiry provenance, negated forms and genuinely evidenced contact all survive');
  }

  // D2a [rules 41/43/47] — NOMINAL RESPONSES AND ELLIPTICAL CO-OCCURRENCE.
  // These are the exact two production forms that escaped the existing
  // subject+verb reply detector and explicit seller-anchor co-occurrence rule.
  {
    assert.strictEqual(
      findUnsupportedRelationship('no valuation was offered off the back of that answer', relSupport()),
      'unsupported_prospect_reply',
      'a nominal reference to a prospect answer still requires prospect-side response evidence');
    assert.strictEqual(
      findUnsupportedRelationship('the seller question never progressed to a valuation offer.', relSupport()),
      null,
      'the same supported agency-side progression point must remain sayable without inventing a prospect answer');
    for (const unsupportedResponse of [
      'following my response, no valuation was offered.',
      'after my answer, the seller side went no further.',
      'once I confirmed, the valuation opportunity was left untouched.',
      'when I replied, nobody progressed the seller question.',
    ]) {
      assert.strictEqual(
        findUnsupportedRelationship(unsupportedResponse, relSupport()),
        'unsupported_prospect_reply',
        `a prospect response construction must require evidence: "${unsupportedResponse}"`);
    }
    for (const originalEnquiryFact of [
      "I'd already said in my original enquiry that I had a property to sell.",
      'I mentioned in my enquiry that I had a property to sell.',
      'I declared a property to sell in the original enquiry.',
    ]) {
      assert.strictEqual(
        findUnsupportedRelationship(originalEnquiryFact, relSupport()),
        null,
        `an original-enquiry declaration must remain valid: "${originalEnquiryFact}"`);
    }
    assert.strictEqual(
      findUnsupportedRelationship(
        'no valuation was offered off the back of that answer',
        relSupport({ prospectContactEvidenced: true }),
      ),
      null,
      'explicit prospect-side response evidence licenses the same response wording');

    const crossEventSupport = buildSupportContext({
      probe: REL_PROBE,
      findings: [
        {
          finding_index: 1,
          finding_type: 'positive',
          finding: 'A later agency email asked when would be convenient to view.',
          evidence: 'The agency email asked: "When would be convenient for you to view?"',
          significance_note: 'The buying side progressed in the agency reply.',
        },
        {
          ...SELLER_MISSED,
          finding: 'The original enquiry declared a property to sell, but it was not acknowledged.',
          evidence: 'The seller declaration appeared in the original enquiry.',
        },
      ],
    });
    const sameEnquirySupport = buildSupportContext({
      probe: REL_PROBE,
      findings: [{
        finding_index: 1,
        finding_type: 'opportunity',
        finding: 'The original enquiry contained both a viewing request and a declared property to sell.',
        evidence: 'Both facts appeared together in the original enquiry.',
        significance_note: 'One enquiry carried buyer and potential seller opportunities.',
      }],
    });
    const sameMessageClaim = 'the second opportunity sitting in the very same message';
    assert.strictEqual(
      findUnsupportedRelationship(sameMessageClaim, crossEventSupport),
      'unsupported_co_occurrence',
      'an elliptical same-message claim must fail when the selected facts come from different events');
    assert.strictEqual(
      findUnsupportedRelationship('The seller declaration and viewing offer were in the same reply.', crossEventSupport),
      'unsupported_co_occurrence',
      'same-reply wording is governed by the same event-provenance rule');
    assert.strictEqual(
      findUnsupportedRelationship(sameMessageClaim, sameEnquirySupport),
      null,
      'the same wording must pass when both selected facts genuinely came from the original enquiry');
    ok('D2a [rules 41/43/47]: nominal prospect responses require evidence and elliptical same-message claims are support-relative');
  }

  // D3 [rules 45/48, test A/G] — KEEP THE EVIDENCE'S EPISTEMIC LEVEL.
  // prb_mt0ptc0o: unknown call content turned into certainty about what was
  // NOT said. prb_hist_0003: a potential opportunity turned into a won
  // instruction.
  {
    const UNKNOWN_CALL = {
      finding_index: 2, finding_type: 'problem',
      finding: 'The seller opportunity was not evidenced as addressed.',
      evidence: 'Call logged, no transcript/content captured; seller opportunity not evidenced as addressed.',
      significance_note: 'What was discussed is unknown.',
    };
    assert.strictEqual(hasUnreliableVoicemailEvidence([UNKNOWN_CALL]), true,
      'an uncaptured call leaves its content unknown');
    // The exact live failure, through the guard that owns this rule.
    assert.strictEqual(makesUnsupportedVoicemailClaim('nobody on that call asked about the property I still need to sell.'), true,
      'a definite claim about who said what on an uncaptured call is blocked');
    assert.strictEqual(makesUnsupportedVoicemailClaim('There is no recorded evidence showing the seller opportunity was addressed.'), false,
      'the evidence-bounded statement of the SAME point is exactly what should be said');
    // The whole-record wording is unaffected — it has no call locator.
    assert.strictEqual(makesUnsupportedVoicemailClaim("You called within the hour, but nobody picked up that I'd also said I had a property to sell."), false,
      'a seller miss judged across the whole record stays fully sayable');

    // Possibility -> certainty.
    assert.strictEqual(findUnsupportedRelationship('a seller instruction nobody even looked at.', relSupport()), 'certainty_upgrade',
      'a potential opportunity may not be reported as a won instruction');
    for (const good of [
      'a potential seller instruction was never explored.',
      'a valuation opportunity was left on the table.',
      'the declared property to sell was never progressed into a valuation.',
      'the voicemail cut off with no availability request or callback instruction given.',
    ]) {
      assert.strictEqual(findUnsupportedRelationship(good, relSupport()), null,
        `hedged, opportunity-level and non-seller wording must survive: "${good}"`);
    }
    ok('D3 [rules 45/48, tests A/G]: unknown call content stays unknown and a potential opportunity stays potential — evidence-bounded and hedged wording pass untouched');
  }

  // D4 [rules 44/46, tests E/F] — NO INVENTED COMPARISONS OR MIND-READING.
  {
    for (const bad of [
      'the seller side was arguably more valuable than the viewing.',
      'the bigger opportunity of the two was never touched.',
      'that seller lead was worth far more than the viewing.',
    ]) {
      assert.strictEqual(findUnsupportedRelationship(bad, relSupport()), 'unsupported_comparative',
        `nothing on file ranks the two opportunities: "${bad}"`);
    }
    for (const bad of [
      'before anyone else even knew it was coming to market.',
      'no other agent knew about it yet.',
      'the agency probably thought it was just a viewing request.',
    ]) {
      assert.strictEqual(findUnsupportedRelationship(bad, relSupport()), 'third_party_knowledge',
        `a mind-state nobody evidenced must be caught: "${bad}"`);
    }
    // THE MUST-PASS. A statement of general market PRACTICE is not a claim
    // about who knew about this property, and it is pinned-good copy.
    assert.strictEqual(
      findUnsupportedRelationship('Worth knowing how rare that is: most branches work the buying side of a message like mine and never notice the second half.', relSupport()),
      null, 'a general market-practice observation is not a third-party knowledge claim');
    ok('D4 [rules 44/46, tests E/F]: invented value comparisons and third-party/internal mind-states are rejected, while a general market-practice observation stays valid');
  }

  // D5 [rule 43] — A CAUSAL JOIN MAY NOT MANUFACTURE AN EXCHANGE.
  // Scoped deliberately: ordinary commercial implication is the email's job
  // and is untouched. What is rejected is "you did X, so I did Y".
  {
    assert.strictEqual(findUnsupportedRelationship('You asked, so I replied confirming I had a property to sell.', relSupport()),
      'unsupported_causal_link', 'a cause-and-effect exchange with a prospect action is invented');
    for (const good of [
      'That meant the valuation was never booked and the seller side never opened.',
      'So the buyer side moved forward, while the potential seller was missed entirely.',
      'So 1 enquiry got a fast first reply and 0 follow-ups after it.',
    ]) {
      assert.strictEqual(findUnsupportedRelationship(good, relSupport()), null,
        `agency-side commercial implication is the email's job and must survive: "${good}"`);
    }
    ok('D5 [rule 43]: a causal join that manufactures a prospect response is rejected; agency-side commercial implication is untouched');
  }

  // D6 [rules 41-48] — END TO END, AND NEVER BANKED.
  // A relationship failure is a truth failure: repaired once, and if the
  // repair misses the field blanks rather than persisting a sentence the agent
  // can disprove.
  {
    const repaired = await run({
      probe: REL_PROBE, findings: [POSITIVE, SELLER_MISSED],
      reply: (call) => (call === 1
        ? baseAnswer({ email_observation: 'I was already on the phone with you twice, and still told you I had a property to sell.' })
        : baseAnswer({ email_observation: "You called twice, but the seller declaration from my original enquiry was never picked up." })),
    });
    assert.strictEqual(repaired.calls, 2, 'the relocated declaration is rejected and one repair is attempted');
    assert.match(repaired.row.email_observation, /from my original enquiry/i,
      'and the provenance-correct version is what persists');

    // The wording D10 restored. Both guards are now happy with it, which is
    // what makes the brief's own suggested repair sentence usable end to end.
    assert.strictEqual(
      readsAsUnfairOutcomeCriticism('the seller declaration in my original enquiry was never progressed.'), false,
      'the passive, agency-owned criticism is no longer claimed by the unfair-outcome guard (see D10)');
    assert.strictEqual(
      findUnsupportedRelationship('the seller declaration in my original enquiry was never progressed.', relSupport()), null,
      'and the relationship layer is happy with it too');

    const unrepaired = await run({
      probe: REL_PROBE, findings: [POSITIVE, SELLER_MISSED],
      reply: () => baseAnswer({ email_commercial_hook: 'the seller side was arguably more valuable than the viewing.' }),
    });
    assert.strictEqual(has(unrepaired.row.email_commercial_hook), false,
      'an unrepaired relationship failure is never banked as a soft fallback');
    for (const reason of RELATIONSHIP_REASONS) {
      assert.strictEqual(NEVER_PERSIST_REASONS.has(reason), true,
        `${reason} must be a never-persist reason, not a bankable wording preference`);
    }
    ok('D6 [rules 41-48]: relationship failures flow through the existing correction budget, repair into the supported wording, and never bank when the repair misses');
  }

  // D7 [rule 27 + 41/47 upstream] — THE FINDINGS LAYER OBEYS THE RULES ITSELF.
  // prb_mt0puwtj_1r7vrh's finding CONTAINED "once he confirmed it" while its
  // evidence showed only that the agency asked. Personalisation rewriting that
  // into something plausible would leave the false finding persisted and still
  // authoritative, so it is cleaned where it is written.
  {
    const contaminated = {
      finding_type: 'problem',
      finding: 'The agency asked whether he was selling once he confirmed it.',
      evidence: 'Agency message: "Do you have a property to sell?"',
      significance_note: 'They asked for something already on file.',
    };
    assert.strictEqual(findingInventsProspectResponse(contaminated), true,
      'a finding asserting a prospect confirmation its own evidence does not record is contaminated');

    const cleaned = _diagnosisInternal.sanitizeFindings([contaminated], { max: 3 });
    assert.strictEqual(cleaned.length, 1, 'the finding survives — the real commercial point is not thrown away');
    assert.strictEqual(/once he confirmed/i.test(cleaned[0].finding), false,
      'but the invented confirmation is gone from what gets persisted');
    assert.match(cleaned[0].finding, /asked whether he was selling/i,
      'and what remains is the genuine finding: they asked for something already declared');

    // Third-person analytic wording that is CORRECT must survive untouched —
    // and note the asymmetry this pins: the downstream prospect-reply guard is
    // first-person only, precisely so this analytic voice is never flagged.
    const fine = {
      finding_type: 'problem',
      finding: 'The agency asked whether he was selling, despite the enquiry already declaring it.',
      evidence: 'Agency message: "Do you have a property to sell?"',
      significance_note: 'They asked for something already on file.',
    };
    assert.strictEqual(findingInventsProspectResponse(fine), false, 'correct analytic wording is not contaminated');
    assert.deepStrictEqual(_diagnosisInternal.sanitizeFindings([fine], { max: 3 })[0].finding, fine.finding,
      'and passes through byte-identical');
    assert.strictEqual(claimsProspectReply('That seller was already engaging with your agency as a buyer.'), false,
      'the downstream guard stays first-person, so analytic third-person copy is never caught by it');
    ok('D7 [rule 27 + 41/47]: an invented prospect confirmation is stripped from the finding AT SOURCE, the genuine finding survives, and correct analytic wording is untouched');
  }

  // D8 [test H] — GOOD COPY NON-REGRESSION, AT SCALE.
  //
  // Every distinct piece of gated prose across the suites that actually drive
  // personaliseProbe(), checked against the whole relationship layer under the
  // support set most likely to produce a false positive. This is the block
  // that makes "support-relative, not a blacklist" a measured claim rather
  // than an intention: if any detector were really a phrase list, this corpus
  // is where it would show.
  //
  // The master suite itself is excluded — it is full of deliberate violations,
  // and scanning it would be circular. novus-demo-selftest is excluded for a
  // different and more interesting reason, pinned separately below.
  {
    const GATED_PATH_SUITES = SIBLING_SUITES.filter((suite) => suite !== 'novus-demo-selftest.mjs');
    const prose = (suite) => {
      const source = readFileSync(path.join(here, suite), 'utf8');
      const matches = source.match(/(?:email_observation|email_commercial_hook|email_commercial_hook_email_2|fair_observation|main_finding|commercial_consequence): (?:'[^']{15,}'|"[^"]{15,}")/g) || [];
      return matches.map((m) => m.replace(/^[a-z_0-9]+: ['"]/, '').replace(/['"]$/, ''));
    };
    const corpus = [...new Set(GATED_PATH_SUITES.flatMap(prose))];
    assert.ok(corpus.length >= 40, `the corpus must be substantial, got ${corpus.length}`);
    const flagged = corpus
      .map((line) => [line, findUnsupportedRelationship(line, relSupport())])
      .filter(([, reason]) => reason);
    assert.deepStrictEqual(flagged, [],
      `existing gated prose must be untouched by the relationship layer:\n${flagged.map(([l, r]) => `  [${r}] ${l}`).join('\n')}`);
    ok(`D8 [test H]: all ${corpus.length} distinct gated prose fixtures across the gate-driving suites pass the relationship layer unchanged`);
  }

  // D9 [rule 45] — A REAL VIOLATION IN FIXTURE DATA, REPORTED RATHER THAN
  // QUIETLY PASSED OR QUIETLY EDITED.
  //
  // Two commercial_consequence strings in novus-demo-selftest call a merely
  // POTENTIAL seller opportunity "the instruction", which is exactly the
  // certainty upgrade rule 45 forbids. They are not a production regression:
  // they are pre-built PERSONALISATION SHEET ROWS handed straight to the demo
  // compiler, so they never traverse personaliseProbe's gates and this layer
  // never sees them. Had they come through the gate they would be rejected —
  // which is precisely what this block asserts.
  //
  // Left in place deliberately. Rewriting another suite's demo fixtures is an
  // unrelated change, and silently excluding them would hide the finding. This
  // pins the truth: the rule works, the fixtures are wrong, and the two facts
  // are recorded rather than reconciled by fudging either.
  {
    const demoFixtures = (readFileSync(path.join(here, 'novus-demo-selftest.mjs'), 'utf8')
      .match(/commercial_consequence: '[^']{15,}'/g) || [])
      .map((m) => m.replace(/^[a-z_0-9]+: '/, '').replace(/'$/, ''))
      .filter((line) => /\binstruction\b/i.test(line));
    assert.ok(demoFixtures.length >= 1, 'the fixtures this block documents must still exist');
    for (const fixture of demoFixtures) {
      assert.strictEqual(findUnsupportedRelationship(fixture, relSupport()), 'certainty_upgrade',
        `this demo fixture upgrades a potential opportunity into a won instruction: "${fixture}"`);
    }
    ok(`D9 [rule 45]: ${demoFixtures.length} ungated demo fixtures genuinely violate the certainty rule and are recorded as such — they bypass the gate, so no production copy regresses`);
  }


  // ══ Section D10: THE UNFAIR-OUTCOME FALSE POSITIVE ═══════════════════════
  //
  // The guard exists to stop the email blaming the agency for OUR silence. It
  // was reading the entity and the verb and ignoring the VOICE, and voice is
  // the entire distinction:
  //
  //   "the enquiry never MOVED FORWARD"      active, intransitive. An enquiry
  //     moves forward only while both sides keep going, and we deliberately
  //     stopped. Blaming them for that is unfair, and stays rejected.
  //
  //   "the seller side WAS NEVER PROGRESSED" passive; the implied actor is the
  //     agency. Offering a valuation, asking a qualifying question, booking an
  //     appraisal — all things they could do alone, on the day, with no reply
  //     from us. Fair, useful, and it was being deleted.
  //
  // The `[^.!?]{0,28}` gap swallowed the passive auxiliary, so `was`/`were`
  // never reached the match and both sentences looked identical to the guard.
  {
    for (const fair of [
      'the seller declaration in my original enquiry was never progressed',
      'the seller side was never progressed',
      'the seller opportunity was never progressed into a valuation',
      'the declared property to sell was never progressed',
      "You called twice, but the seller declaration in my original enquiry was never progressed.",
    ]) {
      assert.strictEqual(readsAsUnfairOutcomeCriticism(fair), false,
        `agency-owned criticism in the passive must be sayable: "${fair}"`);
    }

    // THE ACTIVE FORMS ARE UNCHANGED. Nothing below is newly allowed.
    for (const unfair of [
      'nothing progressed',
      'the enquiry never moved forward',
      'the buyer side never progressed',
      'the opportunity never went anywhere',
      'the viewing never got booked',
      'neither opportunity became a conversation',
      'None of it moved forward.',
    ]) {
      assert.strictEqual(readsAsUnfairOutcomeCriticism(unfair), true,
        `criticism that needed MY reply must stay rejected: "${unfair}"`);
    }

    // TWO-WAY ENTITIES ARE THE EXCEPTION, IN BOTH VOICES. A conversation is
    // not something one party can progress alone, so the passive gets it no
    // exemption — this is what stops the fix becoming a loophole.
    for (const twoWay of [
      'the conversation was never progressed',
      'the thread was never progressed',
      'the conversation never went anywhere',
    ]) {
      assert.strictEqual(readsAsUnfairOutcomeCriticism(twoWay), true,
        `a two-way entity cannot be progressed by the agency alone: "${twoWay}"`);
    }

    // A REQUIRED-FAIL CASE THAT WAS SILENTLY PASSING. The quantifier
    // alternation knew the pronoun forms only, so the same claim with the
    // number spelled out went straight through.
    for (const counted of [
      'none of the four attempts became a real conversation',
      'not one of the three attempts became a conversation',
    ]) {
      assert.strictEqual(readsAsUnfairOutcomeCriticism(counted), true,
        `a counted quantifier is the same unfair claim: "${counted}"`);
    }
    assert.strictEqual(readsAsUnfairOutcomeCriticism('none of them became a real conversation'), true,
      'and the pronoun form it already caught is unchanged');

    // THE SAME FALSE POSITIVE IN THE QUANTIFIER RULES. "both leads were never
    // progressed" and "neither side was ever progressed" belong to exactly the
    // class above — passive, agency-owned — but were rejected by the separate
    // "both …"/"neither …" patterns, which triggered on a bare `never`/verb
    // without looking at voice at all. Progressing two opportunities is two
    // things the agency could have done on the day, on its own.
    for (const fair of [
      'both leads were never progressed',
      'both sides were never progressed',
      'both opportunities were never progressed',
      'neither side was ever progressed',
      'neither lead was ever progressed',
      'neither opportunity was progressed',
    ]) {
      assert.strictEqual(readsAsUnfairOutcomeCriticism(fair), false,
        `agency-owned progression in the passive must be sayable under any quantifier: "${fair}"`);
    }

    // AND THE TWO-WAY COMPLETIONS UNDER THE SAME QUANTIFIERS STAY REJECTED.
    // This is the boundary that stops the exemption becoming a loophole:
    // going anywhere, becoming a conversation, being converted or booked are
    // all outcomes that needed us to keep talking.
    for (const unfair of [
      'neither lead went anywhere',
      'both conversations went nowhere',
      'neither side became a real conversation',
      'neither opportunity became a conversation',
      'neither side was ever converted',
      'neither lead was ever booked',
      'both sides never went anywhere',
      'both opportunities were left hanging',
      'both sides stayed where they started',
      'both sides remained unprogressed',
      'the conversation went nowhere',
    ]) {
      assert.strictEqual(readsAsUnfairOutcomeCriticism(unfair), true,
        `a completion that depended on my participation must stay rejected: "${unfair}"`);
    }

    // The fairness GATE itself is untouched: this is still only ever applied
    // on a probe where the agency genuinely put the ball back in our court.
    assert.strictEqual(agencyMadeNextStepAttempt({ human_contact: 'yes', viewing_progression: 'invited' }), true,
      'agencyMadeNextStepAttempt is unchanged');
    assert.strictEqual(agencyMadeNextStepAttempt({ human_contact: 'none' }), false,
      'and still false where nobody came back at all');
    ok('D10 [rules 25/35/36]: passive, agency-owned "was never progressed" is sayable again under every quantifier (the, both, neither); active self-motion claims, two-way entities and counted quantifiers all stay rejected');
  }


  // ══ Section E: THE TERMINAL PERSISTENCE INVARIANT ════════════════════════
  //
  // The three email variables were mandatory everywhere except at the write.
  // personaliseProbe() can legitimately return one blank — its last resort is
  // `{ ...best.row, ...best.softFallbacks }`, and a NEVER_PERSIST reason banks
  // no fallback on purpose, because a sentence asserting something untrue is
  // worth less than nothing. That blank is a REFUSAL. Nothing downstream
  // treated it as one: it flowed into the patch, spread over the existing row
  // in the update branch (overwriting a good Hook 2 with an empty cell), and
  // was written.
  //
  // These blocks drive the REAL persistence path — rebuildAllPersonalisation
  // against a repo that records what would actually reach the sheet — rather
  // than asserting on personaliseProbe's return value.
  {
    const P_HEADER = ['personalisation_id', 'agency_id', 'probe_id', 'hero_journey',
      'primary_narrative', 'narrative_finding_indexes', 'positive_finding_index', 'main_finding_index',
      'wider_finding_index', 'supporting_findings', 'evidence', 'novus_counterfactual', 'fair_observation',
      'main_finding', 'commercial_consequence', 'property_reference', 'email_observation',
      'email_commercial_hook', 'email_commercial_hook_email_2', 'created_at', 'updated_at'];
    const D_HEADER = ['diagnosis_id', 'agency_id', 'probe_id', 'strengths', 'missed_opportunities',
      'commercial_implication', 'novus_opportunity', 'diagnosis_summary'];
    const F_HEADER = ['probe_id', 'finding_index', 'finding_type', 'finding', 'evidence', 'significance_note'];
    const PROBE_ID = 'prb_persist_1';

    // existingPersonalisationRow: null for the append path, or an object for
    // the update path. header: overridable, to prove the column mapping.
    const makeRepo = ({ existingRow = null, header = P_HEADER } = {}) => {
      const written = [];
      const table = (h, rows) => ({ header: h, rows });
      return {
        written,
        async getTable(tab) {
          if (tab === 'INTELLIGENCE') {
            return table(['intelligence_id', 'agency_id', 'probe_id', 'human_contact', 'response_hours',
              'viewing_progression', 'seller_recognition', 'observation_status'],
            [['int_1', 'agc_master', PROBE_ID, 'yes', '0.13', 'invited', 'none', 'closed']]);
          }
          if (tab === 'DIAGNOSIS') {
            return table(D_HEADER, [['dia_1', 'agc_master', PROBE_ID, '', '', '', 'Core (front desk)', 'final']]);
          }
          if (tab === 'PERSONALISATION') {
            return table(header, existingRow ? [header.map((k) => existingRow[k] ?? '')] : []);
          }
          if (tab === 'AGENCIES') return table(['agency_id', 'agency_name'], [['agc_master', 'Example Estates']]);
          if (tab === 'DIAGNOSIS_FINDINGS') {
            return table(F_HEADER, [
              [PROBE_ID, '1', 'positive', POSITIVE.finding, POSITIVE.evidence, POSITIVE.significance_note],
              [PROBE_ID, '2', 'opportunity', SELLER_MISSED.finding, SELLER_MISSED.evidence, SELLER_MISSED.significance_note],
            ]);
          }
          return table([], []);
        },
        async writeRowsBatch(writes) { written.push(...writes); },
      };
    };

    const rebuild = async (repo, answer) => {
      __setAiCallerForTests(async () => answer);
      return rebuildAllPersonalisation(repo, new Map([[PROBE_ID, { ...PROBE, probe_id: PROBE_ID }]]));
    };
    const cell = (row, header, field) => row[header.indexOf(field)];

    // E1-E4 — a blank in ANY mandatory field refuses the write, and
    // whitespace is blank.
    for (const [label, blanked] of [
      ['Hook 2', 'email_commercial_hook_email_2'],
      ['Hook 1', 'email_commercial_hook'],
      ['observation', 'email_observation'],
    ]) {
      const repo = makeRepo();
      const summary = await rebuild(repo, baseAnswer({ [blanked]: '' }));
      assert.deepStrictEqual(repo.written, [], `a blank ${label} must reach no write at all`);
      assert.strictEqual(summary.personalisation_created, 0, `and must not be counted as created (${label})`);
      assert.strictEqual(summary.personalisations_processed, 0, `nor as processed (${label})`);
      assert.deepStrictEqual(summary.personalised_probe_ids, [],
        `nor handed to the demo compile step (${label})`);
      assert.strictEqual(summary.mandatory_field_refusals, 1, `and the refusal is counted (${label})`);
      assert.strictEqual(summary.problems.length, 1, `and reported (${label})`);
      assert.strictEqual(summary.problems[0].reason, 'mandatory_email_field_blank');
      assert.deepStrictEqual(summary.problems[0].blank_fields, [blanked]);
      assert.strictEqual(summary.problems[0].probe_id, PROBE_ID);
    }
    ok('E1-E3 [blank Hook 2 / Hook 1 / observation]: none can persist — no write, no counters, not handed to demo compile, and problems[] names the reason and the exact field');

    {
      const repo = makeRepo();
      const summary = await rebuild(repo, baseAnswer({ email_commercial_hook_email_2: '   \n\t  ' }));
      assert.deepStrictEqual(repo.written, [], 'whitespace-only is blank and must not persist');
      assert.deepStrictEqual(summary.problems[0].blank_fields, ['email_commercial_hook_email_2']);
      ok('E4 [whitespace]: a whitespace-only mandatory field counts as blank — it would satisfy every truthiness check between here and the sheet');
    }

    // E5 — the valid row still persists, byte-identically.
    let validRowObject = null;
    {
      const repo = makeRepo();
      const summary = await rebuild(repo, baseAnswer());
      assert.strictEqual(repo.written.length, 1, 'a complete row is written exactly once');
      assert.strictEqual(summary.personalisation_created, 1);
      assert.strictEqual(summary.mandatory_field_refusals, 0);
      assert.deepStrictEqual(summary.problems, []);
      assert.deepStrictEqual(summary.personalised_probe_ids, [PROBE_ID]);
      const row = repo.written[0].row;
      assert.strictEqual(repo.written[0].tab, 'PERSONALISATION');
      assert.strictEqual(cell(row, P_HEADER, 'email_observation'), baseAnswer().email_observation,
        'email_observation persists byte-identically');
      assert.strictEqual(cell(row, P_HEADER, 'email_commercial_hook'), baseAnswer().email_commercial_hook,
        'email_commercial_hook persists byte-identically');
      assert.strictEqual(cell(row, P_HEADER, 'email_commercial_hook_email_2'), baseAnswer().email_commercial_hook_email_2,
        'email_commercial_hook_email_2 persists byte-identically');
      validRowObject = Object.fromEntries(P_HEADER.map((k, i) => [k, row[i]]));
      ok('E5 [valid row]: a complete row is written unchanged — the invariant refuses, it never rewrites');
    }

    // E6 — THE ONE THAT MATTERED MOST. An existing valid row must survive an
    // invalid regeneration. This is the update branch, where the blank used to
    // spread over the good value and empty the cell in place.
    {
      const repo = makeRepo({ existingRow: { ...validRowObject, email_commercial_hook_email_2: '' } });
      // The stored row is missing Hook 2, so needsPersonalisation() re-runs it;
      // the regeneration comes back blank again.
      const summary = await rebuild(repo, baseAnswer({ email_commercial_hook_email_2: '' }));
      assert.deepStrictEqual(repo.written, [], 'the update path refuses too — it is the same single write site');
      assert.strictEqual(summary.personalisation_updated, 0, 'and counts no update');
      assert.strictEqual(summary.problems[0].reason, 'mandatory_email_field_blank');

      // And with a GOOD stored Hook 2 that a bad regeneration would overwrite:
      // needsPersonalisation() leaves a complete row alone entirely, which is
      // the outer half of the same protection.
      const intact = makeRepo({ existingRow: validRowObject });
      const untouched = await rebuild(intact, baseAnswer({ email_commercial_hook_email_2: '' }));
      assert.deepStrictEqual(intact.written, [], 'a complete existing row is never rewritten at all');
      assert.strictEqual(untouched.personalisations_processed, 0);
      ok('E6 [no destructive overwrite]: an existing valid row cannot be emptied by an invalid regeneration — the merged result is what the invariant tests, so the update branch cannot spread a blank over a good value');
    }

    // E7 — the column mapping for the field that was going missing.
    {
      assert.strictEqual(P_HEADER.indexOf('email_commercial_hook_email_2'), 18,
        'the header carries the column at a stable index');
      const repo = makeRepo();
      await rebuild(repo, baseAnswer());
      const row = repo.written[0].row;
      assert.strictEqual(row.length, P_HEADER.length, 'the written row matches the header width');
      assert.strictEqual(row[P_HEADER.indexOf('email_commercial_hook_email_2')],
        baseAnswer().email_commercial_hook_email_2,
        'and the value lands in its own column, not a neighbouring one');

      // A WORKBOOK WHOSE HEADER PREDATES THE FIELD behaves exactly as it did
      // before the field existed, rather than being refused for ever. Same
      // column-scoping needsPersonalisation() already uses — without this the
      // invariant would deadlock every legacy sheet.
      const legacyHeader = P_HEADER.filter((k) => k !== 'email_commercial_hook_email_2');
      const legacyRepo = makeRepo({ header: legacyHeader });
      const legacy = await rebuild(legacyRepo, baseAnswer({ email_commercial_hook_email_2: '' }));
      assert.strictEqual(legacyRepo.written.length, 1,
        'a sheet with no such column cannot store the field, so it is not demanded');
      assert.deepStrictEqual(legacy.problems, []);
      assert.strictEqual(blankMandatoryEmailFields({ email_observation: 'a', email_commercial_hook: 'b' },
        new Set(legacyHeader)).length, 0, 'and the helper agrees directly');
      ok('E7 [column mapping]: email_commercial_hook_email_2 maps to its own column and persists there; a legacy sheet without the column is unaffected rather than deadlocked');
    }

    // E8 — the report is usable on its own.
    {
      const repo = makeRepo();
      const summary = await rebuild(repo, baseAnswer({ email_observation: '', email_commercial_hook_email_2: '' }));
      const problem = summary.problems[0];
      assert.strictEqual(problem.reason, 'mandatory_email_field_blank');
      assert.deepStrictEqual(problem.blank_fields, ['email_observation', 'email_commercial_hook_email_2'],
        'every blank field is listed, in the contract order, not just the first');
      assert.match(problem.error, /mandatory email field/i, 'and the message says what happened in words');
      assert.strictEqual(summary.mandatory_field_refusals, 1);
      assert.strictEqual(summary.remaining_personalisations, 0,
        'a refusal is not a budget skip — it is a completed decision');
      ok('E8 [reporting]: problems[] carries reason, probe_id, every blank field and a readable message, and the pass counts its refusals');
    }

    // E9 — the invariant is exactly one gate, and it is the only write site.
    {
      const source = readFileSync(path.join(here, '..', 'lib', 'personalisation-rebuild.mjs'), 'utf8');
      const writeSites = source.match(/writes\.push\(\{\s*tab: 'PERSONALISATION'/g) || [];
      assert.strictEqual(writeSites.length, 1,
        'PERSONALISATION must have exactly ONE write site — append, update, regeneration, fallback, correction and partial merge all funnel through it');
      const repoSource = readFileSync(path.join(here, '..', 'lib', 'personalisation-rebuild.mjs'), 'utf8');
      const guardIndex = repoSource.indexOf('blankMandatoryEmailFields(merged, personalisationColumns)');
      const writeIndex = repoSource.indexOf("writes.push({ tab: 'PERSONALISATION'");
      assert.ok(guardIndex > 0 && guardIndex < writeIndex,
        'and the invariant runs immediately BEFORE that write, not after it');
      ok('E9 [single gate]: PERSONALISATION has exactly one write site and the invariant sits immediately before it, so every path — append, update, regeneration, fallback, correction, partial merge — is covered by one check');
    }
  }


  // ══ Section F: THE FOUR CLASSES FROM THE LATEST PRODUCTION BATCH ══════════
  //
  // Four more ways to assert a relationship the evidence does not carry. Same
  // support-relative discipline as Section D: each is judged against the
  // selected findings and the structured INTELLIGENCE state, never against a
  // list of forbidden phrases.
  const UNKNOWN_CALL_FINDING = {
    finding_index: 2, finding_type: 'problem',
    finding: 'The seller opportunity was not evidenced as addressed.',
    evidence: 'Call logged, no transcript/content captured.',
    significance_note: 'What was discussed is unknown.',
  };

  // F1 [class 1] — A UNIVERSAL CLAIM NEEDS EVIDENCE ACROSS EVERY ITEM.
  //
  // "Each time you called, nobody mentioned it" asserts something about ALL
  // the calls. The evidence covers the record, not each item in it, so the
  // quantifier is doing work nothing supports. The honest version drops the
  // enumeration and says what IS on file.
  {
    const support = relSupport({ intelligence: { contact_attempts: 3, follow_ups: 2 } });
    for (const bad of [
      'Each time you called, nobody mentioned the property I had to sell.',
      'All three attempts ignored the seller side completely.',
      'None of them acknowledged the property I said I had to sell.',
      'Every one of your messages skipped the seller declaration.',
    ]) {
      assert.strictEqual(findUnsupportedRelationship(bad, support), 'unsupported_universal',
        `a universal over the contact set needs evidence across every item: "${bad}"`);
    }

    // PAIRED MUST-PASS. A whole-record claim makes no per-item assertion, and
    // a universal the FINDINGS themselves state is supported by definition.
    for (const good of [
      'The property I said I had to sell was never acknowledged.',
      "You got back to me quickly, but nobody picked up that I'd also said I had a property to sell.",
      // Counted, but the count matches this probe's structured state (3
      // attempts, 2 follow-ups after the first) — the count rule is F4's, and
      // it must not fire here.
      'You followed up twice across phone and email.',
    ]) {
      assert.strictEqual(findUnsupportedRelationship(good, support), null,
        `a whole-record claim asserts nothing per-item and must survive: "${good}"`);
    }
    const statedByFindings = relSupport({
      intelligence: { contact_attempts: 3 },
      findings: [{
        finding_index: 1, finding_type: 'problem',
        finding: 'None of the three messages mentioned the seller position.',
        evidence: 'All three agency emails were reviewed; none references the declared property to sell.',
        significance_note: 'Consistently missed.',
      }],
    });
    assert.strictEqual(
      findUnsupportedRelationship('None of them mentioned the seller position.', statedByFindings), null,
      'a universal the findings established across the whole set is supported');

    const oneNamedContact = relSupport({
      intelligence: { contact_attempts: 2 },
      findings: [{
        finding_index: 1, finding_type: 'positive',
        finding: 'One agency email named the specific property.',
        evidence: 'The first email referenced Grey Lady Place.',
        significance_note: 'At least one contact was property-specific.',
      }],
    });
    for (const unsupportedUniversal of [
      'naming the specific property each time',
      'the seller point was raised each time',
      'they mentioned the property every time',
    ]) {
      assert.strictEqual(
        findUnsupportedRelationship(unsupportedUniversal, oneNamedContact),
        'unsupported_universal',
        `one evidenced contact cannot support a claim about every contact: "${unsupportedUniversal}"`);
    }
    for (const nonAssertiveUniversal of [
      'the question is whether it happens every time, not just this time',
      'does this happen every time?',
      'it may not happen every time',
    ]) {
      assert.strictEqual(
        findUnsupportedRelationship(nonAssertiveUniversal, oneNamedContact),
        null,
        `rhetorical or uncertain wording is not an asserted universal fact: "${nonAssertiveUniversal}"`);
    }
    const everyNamedContact = relSupport({
      intelligence: { contact_attempts: 2 },
      findings: [{
        finding_index: 1, finding_type: 'positive',
        finding: 'Every contact named the specific property.',
        evidence: 'Both agency contacts referenced Grey Lady Place.',
        significance_note: 'Property naming was consistent across the full contact set.',
      }],
    });
    assert.strictEqual(
      findUnsupportedRelationship('naming the specific property each time', everyNamedContact),
      null,
      'the same universal wording is valid when every contact genuinely supports it');
    ok('F1 [class 1]: a universal quantifier over the contact set is rejected unless the findings evidence it across every item; whole-record claims are untouched');
  }

  // F2 [class 2] — UNKNOWN CONTENT BLOCKS A UNIVERSAL NEGATIVE ABOUT CONTENT.
  //
  // The existing gate needed an explicit call locator ("on that call"), which
  // is what kept whole-record wording sayable. "The seller opportunity was
  // never discussed" carries no locator and still asserts the content of a
  // call nobody captured.
  {
    const unknown = relSupport({ findings: [POSITIVE, UNKNOWN_CALL_FINDING], callContentUnknown: true });
    for (const bad of [
      'The seller opportunity was never discussed.',
      'My property to sell was never mentioned.',
      'Selling never came up at all.',
    ]) {
      assert.strictEqual(findUnsupportedRelationship(bad, unknown), 'unknown_call_certainty',
        `unknown content cannot support a universal negative about what was said: "${bad}"`);
    }

    // PAIRED MUST-PASS. Evidence-bounded wording states our RECORD and is the
    // correct way to make the same point; outcome verbs describe what the
    // agency did with the enquiry, not what was said on an uncaptured call;
    // and with the content KNOWN the same sentence is fine.
    for (const good of [
      'There is no recorded evidence showing the seller opportunity was discussed.',
      "You got back to me quickly, but nobody picked up that I'd also said I had a property to sell.",
      'The declared property to sell was never progressed into a valuation.',
    ]) {
      assert.strictEqual(findUnsupportedRelationship(good, unknown), null,
        `evidence-bounded and outcome wording must survive an unknown call record: "${good}"`);
    }
    assert.strictEqual(
      findUnsupportedRelationship('The seller opportunity was never discussed.', relSupport()), null,
      'with the call content on file, the same sentence is a supported claim');
    ok('F2 [class 2]: with call content unknown, a universal negative about what was discussed is blocked even without a call locator; evidence-bounded and outcome wording still pass');
  }

  // F3 [class 3] — A DEMONSTRATIVE ANCHOR NEEDS SHARED PROVENANCE.
  //
  // "That call also covered the property I had to sell" binds my enquiry's
  // declaration to an agency event. Same failure the "same message" rule
  // already catches, reached through a different anchor.
  {
    const support = relSupport();
    for (const bad of [
      'That call also covered the property I had to sell.',
      'That email contained both the viewing offer and my seller declaration.',
      'That reply dealt with the viewing and the property I had to sell.',
    ]) {
      assert.strictEqual(findUnsupportedRelationship(bad, support), 'unsupported_co_occurrence',
        `an agency event cannot be given my enquiry's declaration: "${bad}"`);
    }

    // PAIRED MUST-PASS — the pinned-good enquiry-anchored co-occurrence, and
    // a demonstrative that makes no co-occurrence claim at all.
    for (const good of [
      'The vendor had already volunteered themselves in the same message.',
      'the same message had already given you a second reason to call.',
      'That call came within the hour.',
      'You replied about Flat 702 the same day.',
    ]) {
      assert.strictEqual(findUnsupportedRelationship(good, support), null,
        `enquiry-anchored co-occurrence and plain demonstratives must survive: "${good}"`);
    }
    ok('F3 [class 3]: "that call/email/reply also contained X" is rejected where X came from my enquiry; enquiry-anchored co-occurrence is untouched');
  }

  // F4 [class 4] — ONE AUTHORITATIVE COUNT.
  //
  // INTELLIGENCE.contact_attempts is the structured count the whole pipeline
  // already reasons from. Prospect-facing copy citing a different number is
  // simply wrong, and it is the single easiest thing for an agent to check.
  {
    const twoAttempts = relSupport({ intelligence: { contact_attempts: 2, follow_ups: 1 } });
    for (const bad of [
      'You called three times and never mentioned the seller side.',
      'You followed up four times across phone and email.',
      'You came back to me five times.',
    ]) {
      assert.strictEqual(findUnsupportedRelationship(bad, twoAttempts), 'unsupported_contact_count',
        `a contact count must match the authoritative structured count of 2: "${bad}"`);
    }

    // PAIRED MUST-PASS — the true count in words or digits, the follow-up
    // count (a different authoritative field), and copy citing no count.
    for (const good of [
      'You called twice and never mentioned the seller side.',
      'You came back to me 2 times.',
      'You followed up once after the first reply.',
      'You got back to me quickly, but the seller side was never acknowledged.',
      'I enquired about a £425,000 property.',
    ]) {
      assert.strictEqual(findUnsupportedRelationship(good, twoAttempts), null,
        `the authoritative count and uncounted copy must survive: "${good}"`);
    }
    // THE TWO COUNTS ARE CHECKED INDEPENDENTLY, because they mean different
    // things: contact_attempts is every time they came back, follow_ups is
    // only the ones after the first. A probe with 4 attempts made 3 follow-ups,
    // and the pinned-good "you followed up three times" is correct there.
    const fourAttempts = relSupport({ intelligence: { contact_attempts: 4, follow_ups: 3 } });
    assert.strictEqual(
      findUnsupportedRelationship('You followed up three times across phone and email.', fourAttempts), null,
      'the follow-up count is checked against follow_ups, not against contact_attempts');
    assert.strictEqual(
      findUnsupportedRelationship('You called four times.', fourAttempts), null,
      'and the attempt count against contact_attempts on the same probe');
    assert.strictEqual(
      findUnsupportedRelationship('You followed up four times.', fourAttempts), 'unsupported_contact_count',
      'so citing the attempt total as the follow-up count is still a mismatch');
    assert.strictEqual(
      findUnsupportedRelationship('across four contact attempts and five communications', fourAttempts),
      'unsupported_contact_count',
      'raw communication count cannot be combined with the authoritative contact-attempt metric');
    assert.strictEqual(
      findUnsupportedRelationship('across four contact attempts', fourAttempts), null,
      'the authoritative contact-attempt metric remains valid on its own');
    for (const duration of [
      'replied within 2 hours',
      'called back in 36 minutes',
    ]) {
      assert.strictEqual(findUnsupportedRelationship(duration, fourAttempts), null,
        `duration wording is not a contact count: "${duration}"`);
    }
    ok('F4 [class 4]: a prospect-facing contact count is checked against INTELLIGENCE.contact_attempts, in words or digits; the true count and uncounted copy pass');
  }

  // F5 [class 3] — SAME-MESSAGE ANCHORS CAN INHERIT THEIR REFERENT.
  {
    const crossEvent = buildSupportContext({
      probe: REL_PROBE,
      findings: [
        {
          finding_index: 1, finding_type: 'positive',
          finding: 'The reply asked when would be convenient to view.',
          evidence: 'The later email asked when would be convenient to view.',
          significance_note: 'The viewing question progressed the buying side.',
        },
        {
          finding_index: 2, finding_type: 'opportunity',
          finding: 'The enquirer declared a property to sell, but no valuation was offered.',
          evidence: 'The enquiry declared a property to sell.',
          significance_note: 'The seller opportunity was not progressed.',
        },
      ],
    });
    const sameEvent = buildSupportContext({
      probe: REL_PROBE,
      findings: [{
        finding_index: 1, finding_type: 'opportunity',
        finding: 'The original enquiry contained both the viewing request and seller declaration.',
        evidence: 'Both facts appeared together in the original enquiry.',
        significance_note: 'One enquiry carried both opportunities.',
      }],
    });
    const inheritedMessage = 'The viewing question moved the buyer side forward, but the same message already gave you a second seller opportunity.';
    assert.strictEqual(findUnsupportedRelationship(inheritedMessage, crossEvent), 'unsupported_co_occurrence',
      'same-message wording inherits the later viewing-email referent and cannot absorb the enquiry seller declaration');
    assert.strictEqual(findUnsupportedRelationship(inheritedMessage, sameEvent), null,
      'the same wording remains valid when both linked facts genuinely share the original enquiry');
    ok('F5 [class 3]: inherited same-message referents are judged against selected-finding event provenance');
  }

  console.log(`\n${passed} checks passed.`);
}

main().catch((error) => { console.error(error); process.exit(1); });
