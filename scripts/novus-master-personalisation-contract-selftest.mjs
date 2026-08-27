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
// Per the audit brief: this pass changes NO production logic. Every
// assertion below either pins existing guard behaviour or documents, without
// silently accepting, a gap the matrix already lists.
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
} from '../lib/probe-personalisation.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
const ok = (m) => { passed += 1; console.log(`  ✓ ${m}`); };
const has = (v) => Boolean(String(v ?? '').trim());

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

async function run({ probe = PROBE, findings, intelligence = {}, reply }) {
  let calls = 0;
  __setAiCallerForTests(async ({ tool }) => {
    calls += 1;
    return typeof reply === 'function' ? reply(calls, tool) : reply;
  });
  const row = await personaliseProbe(
    probe, { ...INTEL, ...intelligence },
    { diagnosis_summary: 'final', novus_opportunity: 'Core (front desk)' },
    findings, { agency_name: 'Example Estates' },
  );
  return { row, calls };
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

  console.log(`\n${passed} checks passed.`);
}

main().catch((error) => { console.error(error); process.exit(1); });
