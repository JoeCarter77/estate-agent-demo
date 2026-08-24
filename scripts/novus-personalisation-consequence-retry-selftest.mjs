// scripts/novus-personalisation-consequence-retry-selftest.mjs — hermetic
// test (no network, no creds) for the structured-output validation/retry
// boundary in lib/probe-personalisation.mjs: commercial_consequence.
//
// THE BUG THIS GUARDS. A real run over prb_hist_0005/0006/0007-shaped probes
// showed commercial_consequence stored BLANK even though main_finding_index
// was populated. The per-attempt validation in buildCandidate was never the
// problem — a genuinely blank/whitespace consequence is rejected and sent
// back for repair on every attempt, every time (see tests 1-3 below). The
// bug was one level up, in personaliseProbe's fallback: when no attempt ever
// satisfies the FULL contract, the retry loop keeps whichever attempt has the
// FEWEST total violations, and a genuine TIE always favoured the earlier
// attempt. That meant a LATER attempt that fixed commercial_consequence
// specifically — trading it for a different, unrelated violation of equal
// weight — lost to an earlier attempt that still had it blank, and the row
// that got stored showed the one field this whole layer exists to protect
// sitting empty, with main_finding_index perfectly populated beside it.
//
// The fix (isBetterFallback in lib/probe-personalisation.mjs) breaks a tie in
// favour of whichever attempt actually resolved commercial_consequence;
// fewer total violations still wins outright, and a tie where both agree on
// consequence-presence still goes to the earlier attempt, exactly as before.
//
// Run: npm run novus:personalisation-consequence-retry-selftest

import assert from 'node:assert';
import { personaliseProbe, _internal } from '../lib/probe-personalisation.mjs';
import { THAT_MEANT_PREFIX, THAT_ALSO_MEANT_PREFIX } from '../lib/email-assembly.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

const PROBE = {
  probe_id: 'prb_hist_0006',
  property_address: 'Fox Cottage, Chevington',
  property_price: '£425,000',
  probe_timestamp: '2026-08-11T10:14:00Z',
  enquiry_text: 'Interested in viewing. Declared: has a property of my own to sell, not yet on the market.',
};
const INTEL = { human_contact: 'yes', response_hours: 3.2 };
const DIAG = { novus_opportunity: 'Core (front desk)' };
const FINDINGS = [
  { finding_index: 1, finding_type: 'problem', finding: "The conversation did not establish the buyer's position.", evidence: 'No questions about budget or timescale.', significance_note: 'The enquiry was not properly qualified.' },
  { finding_index: 2, finding_type: 'opportunity', finding: 'The prospect disclosed a property of their own to sell.', evidence: 'The enquiry declared a property to sell; no valuation was ever offered.', significance_note: 'Potential valuation/seller instruction was not explored.' },
  { finding_index: 3, finding_type: 'positive', finding: 'The team followed up quickly.', evidence: 'Three attempts across phone and email within one day.', significance_note: 'Shows strong persistence.' },
];

// A COMPLETE otherwise-valid answer, so tests can override just the field
// under test without every other beat also failing the contract.
function answer(overrides = {}) {
  return {
    story_reasoning: '1. Finding 3. 2. Finding 1. 3. Nobody found out whether I could proceed. 4. Finding 2. 5. The valuation was never reached.',
    positive_finding_index: 3,
    main_finding_index: 1,
    wider_finding_index: 2,
    primary_narrative: 'Three attempts went into pushing a viewing while neither side of the enquiry was ever qualified.',
    supporting_findings: '',
    fair_observation: 'you followed up with me three times across phone and email inside a day.',
    main_finding: "that the conversation never established my position — nothing about budget, funding or timescale came up.",
    commercial_consequence: 'you had a £425,000 buyer enquiry in front of you without establishing whether I was ready to move.',
    wider_observation: "I'd also said in the enquiry that I had a property of my own to sell that wasn't yet on the market.",
    wider_consequence: 'a potential seller instruction sitting inside the same enquiry was never explored.',
    novus_counterfactual: 'NOVUS would have made the same three attempts and qualified both sides on the first one.',
    ...overrides,
  };
}

// personaliseProbe over a caller the test drives attempt-by-attempt.
// resultForAttempt(n, prompt) returns the tool-call answer for attempt n.
async function personalise(resultForAttempt, { findings = FINDINGS } = {}) {
  const prompts = [];
  __setAiCallerForTests(async ({ prompt }) => {
    prompts.push(prompt);
    return resultForAttempt(prompts.length, prompt);
  });
  const row = await personaliseProbe(PROBE, INTEL, DIAG, findings, {});
  return { row, calls: prompts.length, prompts };
}

async function run() {
  console.log('Personalisation commercial_consequence — the validation/retry boundary\n');

  // ── 1. BLANK CONSEQUENCE -> REJECTED AND REPAIRED ─────────────────────────
  for (const [label, blankValue] of [['empty string', ''], ['whitespace only', '   ']]) {
    const { row, calls, prompts } = await personalise((n) =>
      n === 1 ? answer({ commercial_consequence: blankValue }) : answer());

    assert.strictEqual(calls, 2, `${label}: rejected once and repaired once, not accepted on attempt 1`);
    assert.ok(prompts[1].includes('YOUR PREVIOUS ANSWER WAS REJECTED'), `${label}: the repair turn is appended to the prompt`);
    assert.ok(prompts[1].includes('commercial_consequence came back EMPTY'),
      `${label}: the repair note names commercial_consequence specifically as missing`);
    assert.ok(prompts[1].includes('You have already reasoned the consequence out above — distil it'),
      `${label}: the repair tells the model to distil from its own reasoning, not invent one`);
    // The model's own prior reasoning and narrative are hand back, verbatim.
    assert.ok(prompts[1].includes(answer().story_reasoning), `${label}: the model's own story_reasoning is echoed back`);
    assert.ok(prompts[1].includes(answer().primary_narrative), `${label}: and its primary_narrative too, so it has something to distil from`);
    assert.ok(prompts[1].includes('main_finding_index: 1'), `${label}: the repair also echoes back the selection it made`);
    assert.strictEqual(row.commercial_consequence, answer().commercial_consequence, `${label}: the repaired consequence is stored`);
    assert.strictEqual(row.main_finding_index, 1, `${label}: main_finding_index stays populated throughout`);
    assert.ok(row.email_body.includes(`${THAT_MEANT_PREFIX}${answer().commercial_consequence}`), `${label}: and the email carries a valid "That meant..." beat`);
    ok(`1. BLANK CONSEQUENCE (${label}) — rejected on attempt 1, repaired on attempt 2, with the repair note naming the field and handing back the model's own reasoning to distil from`);
  }

  // ── 2. VALID CONSEQUENCE -> ACCEPTED FIRST TIME ───────────────────────────
  {
    const { row, calls } = await personalise(() => answer());
    assert.strictEqual(calls, 1, 'a complete, valid answer costs exactly one AI call — no repair triggered');
    assert.strictEqual(row.commercial_consequence, answer().commercial_consequence);
    assert.ok(row.email_body.includes(THAT_MEANT_PREFIX + answer().commercial_consequence));
    ok('2. VALID CONSEQUENCE — accepted on the first attempt, no retry spent');
  }

  // ── 3. PERSISTENT BLANK -> UNSENDABLE, BOUNDED AT THE RETRY LIMIT ─────────
  {
    const { row, calls } = await personalise(() => answer({ commercial_consequence: '' }));
    assert.strictEqual(calls, _internal.MAX_PERSONALISATION_ATTEMPTS, 'a consequence that never resolves is retried up to the bound, then stops');
    assert.strictEqual(row.commercial_consequence, '', 'commercial_consequence is stored blank — never invented to force a sendable row');
    assert.strictEqual(row.email_body, '', 'and the email is left unsendable — the signal that a human needs to look at this probe');
    assert.strictEqual(row.main_finding_index, 1, 'the rest of the row, including the selection, is still stored so a human has something to look at');
    ok('3. PERSISTENT BLANK — bounded at the existing retry limit, then left genuinely unsendable rather than invented or forced through');
  }

  // ── ...and the same guarantee for a MECHANICAL REPEAT of the finding,
  //    which the brief also names as something never to invent ──
  {
    const finding = answer().main_finding;
    const { row, calls } = await personalise(() => answer({ commercial_consequence: finding.replace(/^that\s+/i, '') }));
    assert.strictEqual(calls, _internal.MAX_PERSONALISATION_ATTEMPTS, 'a mechanical repeat of the finding is rejected on every attempt, same as blank');
    assert.strictEqual(row.commercial_consequence, '', 'and never stored — restating the finding is not a consequence');
    assert.strictEqual(row.email_body, '', 'so the row stays unsendable rather than shipping a "That meant" that just repeats "What stood out"');
    ok('3b. MECHANICAL REPEAT OF THE FINDING — refused exactly like blank, bounded at the retry limit, left unsendable');
  }

  // ── 4. THE TIE-BREAK BUG (prb_hist_0006 shape): a LATER attempt that fixes
  //    commercial_consequence must never lose to an EARLIER attempt that
  //    still has it blank, just because they tie on total violation count ──
  {
    const { row, calls } = await personalise((n) => {
      if (n === 1) return answer({ commercial_consequence: '' });          // 1 violation: consequence
      if (n === 2) return answer({ commercial_consequence: '' });          // repair didn't help; still 1
      // attempt 3: consequence now genuinely fixed, but the model trades it
      // for an unrelated slip of EQUAL weight — the wider beat duplicating
      // the main finding's own index (also 1 violation).
      return answer({ wider_finding_index: 1 });
    });

    assert.strictEqual(calls, _internal.MAX_PERSONALISATION_ATTEMPTS, 'still bounded at 3 — the fix does not add extra attempts');
    assert.strictEqual(row.main_finding_index, 1, 'main_finding_index is populated, exactly as reported');
    assert.notStrictEqual(row.commercial_consequence, '', 'and commercial_consequence is NOT left blank — the fixed attempt is kept over the earlier blank one');
    assert.strictEqual(row.commercial_consequence, answer().commercial_consequence, 'it is exactly the consequence the model produced once it got it right');
    assert.ok(row.email_body.includes(THAT_MEANT_PREFIX + answer().commercial_consequence),
      'and it reads correctly in a "That meant..." beat, even though the overall row is still not fully sendable');
    ok('4. THE TIE-BREAK BUG — a later attempt that fixes commercial_consequence is no longer discarded in favour of an earlier attempt that still has it blank, when the two tie on total violations');
  }

  // ── ...and the ORIGINAL rule survives: on a genuine tie where BOTH attempts
  //    agree on consequence-presence (both blank, or both fine), the earlier
  //    attempt still wins — a repair that fixes one field while losing
  //    another is still not an improvement in that case. ──
  {
    const { row, calls } = await personalise((n) => {
      if (n === 1) return answer({ commercial_consequence: 'you had a live buyer enquiry in front of you without establishing whether I was ready to move.' }); // main_finding_index fine, this is the FIRST valid consequence
      if (n === 2) return answer({ commercial_consequence: '' }); // consequence now blank; something else must break to keep this attempt from winning outright — but with consequence blank this can only tie or lose, never win
      return answer({ commercial_consequence: '' });
    });
    // Attempt 1 is fully valid (0 rejections) so it is accepted immediately —
    // this proves an early clean answer is never displaced by a later one.
    assert.strictEqual(calls, 1, 'a fully valid first attempt is accepted immediately and never reconsidered');
    assert.ok(row.commercial_consequence, 'and its consequence is what gets stored');
    ok('4b. UNCHANGED BEHAVIOUR — a fully valid attempt is still accepted immediately; the tie-break only ever matters once every attempt has failed');
  }

  // ── 5. 0005/0006/0007-STYLE: a valid "That meant..." beat, and the
  //    0007 seller-duplication guard still holds through the fixed retry ──
  {
    // 0005: no wider beat at all — a plain single-problem probe.
    const singleProblem = [FINDINGS[0], FINDINGS[2]];
    const { row: r5 } = await personalise(() => answer({ wider_finding_index: null, wider_observation: '', wider_consequence: '' }), { findings: singleProblem });
    assert.ok(r5.email_body.includes(THAT_MEANT_PREFIX + answer().commercial_consequence), '0005: a valid "That meant..." beat is produced');
    assert.ok(!r5.email_body.includes(THAT_ALSO_MEANT_PREFIX), '0005: and no wider beat is invented when there is nothing distinct to add');

    // 0006: main + a genuinely distinct wider beat (the seller opportunity).
    const { row: r6 } = await personalise(() => answer());
    assert.ok(r6.email_body.includes(THAT_MEANT_PREFIX + answer().commercial_consequence), '0006: a valid "That meant..." beat is produced');
    assert.ok(r6.email_body.includes(THAT_ALSO_MEANT_PREFIX + answer().wider_consequence), '0006: and a genuinely distinct "That also meant..." follows it');

    // 0007: the seller opportunity picked as BOTH the main story and the
    // wider beat — the duplication this pipeline exists to prevent — run
    // through the SAME retry path this fix touches, to prove the fix for
    // commercial_consequence has not reopened it.
    const { row: r7, calls: c7 } = await personalise((n) => {
      if (n === 1) {
        return answer({
          main_finding_index: 2, wider_finding_index: 2,
          main_finding: 'that I had told you I had a property of my own to sell, and the conversation stayed entirely on the purchase.',
          commercial_consequence: 'a valuation that was sitting inside this enquiry was never even discussed.',
        });
      }
      // Repaired: the model drops the duplicate wider selection, and the
      // consequence still stands on its own.
      return answer({
        main_finding_index: 2, wider_finding_index: null, wider_observation: '', wider_consequence: '',
        main_finding: 'that I had told you I had a property of my own to sell, and the conversation stayed entirely on the purchase.',
        commercial_consequence: 'a valuation that was sitting inside this enquiry was never even discussed.',
      });
    });
    assert.strictEqual(c7, 2, '0007: the duplicate wider selection is rejected and repaired');
    assert.strictEqual(r7.wider_finding_index, '', '0007: the wider beat is never the main story again');
    assert.ok(r7.email_body.includes(`${THAT_MEANT_PREFIX}a valuation that was sitting inside this enquiry was never even discussed.`),
      '0007: a valid "That meant..." beat still lands');
    assert.strictEqual((r7.email_body.match(/property of my own to sell/g) || []).length, 1,
      '0007: the seller story appears exactly once — the duplication guard still holds through this fix');
    assert.ok(!r7.email_body.includes(THAT_ALSO_MEANT_PREFIX), '0007: and the wider paragraph never appears at all');

    ok('5. 0005/0006/0007 — each produces a valid "That meant..." beat, and 0007\'s seller-duplication guard is intact through the fixed retry path');
  }

  console.log(`\n${passed} checks passed.`);
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
