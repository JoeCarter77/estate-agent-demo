#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';
import { selectPersonalisationFacts } from '../lib/personalisation-facts.mjs';
import {
  buildFactConstrainedPrompt,
  personaliseProbeFromFacts,
  renderCanonicalFactCopy,
  validateFactConstrainedOutput,
} from '../lib/fact-constrained-personalisation.mjs';

const fixturesPath = fileURLToPath(new URL('./fixtures/historical-probes.json', import.meta.url));
const fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));
let checks = 0;
const ok = (message) => { checks += 1; console.log(`  ✓ ${message}`); };

assert.equal(fixtures.length, 14);
let constrainedFieldCount = 0;

for (const fixture of fixtures) {
  const facts = selectPersonalisationFacts(fixture);
  const factsBefore = JSON.stringify(facts);
  const gold = renderCanonicalFactCopy(facts);
  constrainedFieldCount += Object.values(gold).filter(Boolean).length;
  assert.doesNotMatch(
    Object.values(gold).join(' '),
    /\b(?:supported facts|selected facts|declared seller opportunity|recorded progression|agency-controlled|commercial weakness)\b/i,
    `${fixture.probe_id}: constrained copy avoids internal system language`,
  );
  assert.match(gold.email_commercial_hook, /^That meant that\b/, `${fixture.probe_id}: Hook 1 uses the required opening`);
  assert.doesNotMatch(gold.email_commercial_hook_email_2, /^That meant that\b/, `${fixture.probe_id}: Hook 2 uses a distinct opening`);
  const calls = [];
  __setAiCallerForTests(async (request) => {
    calls.push(request);
    return gold;
  });

  const row = await personaliseProbeFromFacts(facts, { enabled: true });
  assert.deepEqual(Object.fromEntries(Object.keys(gold).map((field) => [field, row[field]])), gold, `${fixture.probe_id}: gold surface survives`);
  assert.equal(row.ai_calls_used, 1, `${fixture.probe_id}: valid constrained output costs one call`);
  assert.equal(row.used_canonical_fallback, false);
  assert.equal(JSON.stringify(facts), factsBefore, `${fixture.probe_id}: facts are not mutated`);
  assert.equal(calls.length, 1);

  const [{ system, prompt }] = calls;
  assert.ok(!prompt.includes(fixture.probe.property_address), `${fixture.probe_id}: buyer address never reaches constrained AI`);
  assert.ok(!prompt.includes(fixture.probe.property_price), `${fixture.probe_id}: buyer price never reaches constrained AI`);
  assert.doesNotMatch(prompt, /DIAGNOSIS_FINDINGS|INTELLIGENCE|PROBES/, `${fixture.probe_id}: provenance plumbing never reaches constrained AI`);
  assert.ok(!prompt.includes(String(fixture.diagnosis?.diagnosis_summary || '___missing___')), `${fixture.probe_id}: DIAGNOSIS prose never reaches constrained AI`);
  for (const finding of fixture.findings) {
    assert.ok(!prompt.includes(finding.finding), `${fixture.probe_id}: raw finding prose never reaches constrained AI`);
    assert.ok(!prompt.includes(finding.evidence), `${fixture.probe_id}: raw finding evidence never reaches constrained AI`);
  }
  assert.match(system, /constrained surface realiser/);
  assert.match(prompt, /OBSERVATION_FACTS:/);
  assert.ok(prompt.includes(`FINAL_EMAIL_OBSERVATION: ${gold.email_observation}`), `${fixture.probe_id}: hooks receive the final observation`);
  for (const fact of [...facts.consequences, ...facts.secondary_facts]) {
    assert.ok(!prompt.includes(fact.text), `${fixture.probe_id}: hook generation receives no consequence or secondary fact text`);
  }
  assert.match(prompt, /GOLD GRAMMAR SHAPES/);
  for (const line of Object.values(gold).filter(Boolean)) assert.ok(prompt.includes(line), `${fixture.probe_id}: gold examples contain only current supplied facts`);

  const validated = validateFactConstrainedOutput(facts, row);
  assert.deepEqual(validated.rejections, [], `${fixture.probe_id}: existing factual validators pass`);
}
ok('all 14 probes use only observation facts at the AI boundary and pass the factual validators');
assert.equal(constrainedFieldCount, 42, 'all 14 × 3 constrained outreach fields are populated');
ok('all 42 constrained outreach fields are populated from supplied facts');

{
  const facts = selectPersonalisationFacts(fixtures[8]);
  const gold = renderCanonicalFactCopy(facts);
  __setAiCallerForTests(async () => ({
    ...gold,
    email_commercial_hook: gold.email_commercial_hook.replace(/^That meant that /, ''),
    email_commercial_hook_email_2: `That meant that ${gold.email_commercial_hook_email_2.toLowerCase()}`,
  }));
  const worded = await personaliseProbeFromFacts(facts, { enabled: true });
  assert.equal(worded.email_commercial_hook, gold.email_commercial_hook);
  assert.equal(worded.email_commercial_hook_email_2, gold.email_commercial_hook_email_2);
}
ok('the hook wording layer guarantees the required distinct openings');

const persistentSellerMiss = renderCanonicalFactCopy(selectPersonalisationFacts(fixtures[8]));
assert.equal(
  persistentSellerMiss.email_observation,
  "Although your team made 2 follow-up attempts, nobody picked up on the property I'd said I had to sell, and there were no recorded questions about my position as a buyer.",
  'the valid prb_hist_0009/prb_hist_0022-style observation remains unchanged',
);
assert.equal(
  persistentSellerMiss.email_commercial_hook_email_2,
  'Persistence on the enquiry did not extend to the seller opportunity.',
  'the second hook is a distinct commercial framing of the same observation',
);
assert.equal(
  persistentSellerMiss.email_commercial_hook,
  'That meant that a potential valuation opportunity was left without any acknowledgement or next step.',
  'seller-miss Hook 1 prioritises the valuation opportunity in owner-facing language',
);
const slowSellerMiss = renderCanonicalFactCopy(selectPersonalisationFacts(fixtures[1]));
assert.equal(
  slowSellerMiss.email_commercial_hook,
  'That meant that the enquiry was sitting untouched for more than 16 hours; a potential valuation opportunity went unacknowledged.',
  'slow-response seller misses combine both observed issues naturally',
);
assert.deepEqual(validateFactConstrainedOutput(selectPersonalisationFacts(fixtures[8]), {
  ...persistentSellerMiss,
  email_observation: "Your team made 2 follow-up attempts, but nobody picked up on the property I'd said I had to sell, and there were no recorded questions about my position as a buyer.",
}).rejections, [], 'the requested prb_hist_0022 framing is accepted verbatim');
assert.equal(
  renderCanonicalFactCopy(selectPersonalisationFacts(fixtures[7])).email_observation,
  "Your team asked for my availability for a viewing, but nobody picked up on the property I'd said I had to sell.",
  'a valid existing availability-request observation remains unchanged',
);
ok('valid persistence, seller-opportunity, qualification-question and availability-request copy remains unchanged');

const noPositive = {
  positive: [],
  problems: [{ type: 'slow_human_response', text: 'The first human response was recorded more than 16 hours after the enquiry.', provenance: [] }],
  consequences: [],
  secondary_facts: [],
};
assert.equal(renderCanonicalFactCopy(noPositive).email_observation, 'The first human response came more than 16 hours after the enquiry.');
assert.doesNotMatch(renderCanonicalFactCopy(noPositive).email_observation, /^Although\b/);
ok('a positive is never manufactured when none was supplied');

const unknownFacts = {
  positive: [],
  problems: [{ type: 'slow_human_response', text: 'The first human response was recorded more than 16 hours after the enquiry.', provenance: [] }],
  consequences: [],
  secondary_facts: [{ type: 'communication_content_unknown', text: 'The recorded communication has no available content or transcript; what was discussed is unknown.', provenance: [] }],
};
assert.doesNotMatch(renderCanonicalFactCopy(unknownFacts).email_commercial_hook_email_2, /unknown|transcript|content/i);
assert.deepEqual(validateFactConstrainedOutput(unknownFacts, {
  ...renderCanonicalFactCopy(unknownFacts),
  email_commercial_hook_email_2: 'Nothing was mentioned on that call.',
}).rejections.map((item) => item.reason).some((reason) => /unknown_call_certainty|unsupported voicemail/i.test(reason)), true);
ok('secondary uncertainty facts cannot introduce a new hook claim, while certainty upgrades remain rejected');

{
  const facts = selectPersonalisationFacts(fixtures[8]);
  const gold = renderCanonicalFactCopy(facts);
  const paraphraseReasons = validateFactConstrainedOutput(facts, {
    ...gold,
    email_commercial_hook: gold.email_observation,
  }).rejections.filter((item) => item.field === 'email_commercial_hook').map((item) => item.reason).join('\n');
  assert.match(paraphraseReasons, /restates_observation/);

  for (const forbidden of [
    'That was £20,000 in lost revenue.',
    'That meant a lost instruction.',
    'That meant a lost fee.',
    'That was a lost valuation.',
    'That was a lost client.',
  ]) {
    const reasons = validateFactConstrainedOutput(facts, { ...gold, email_commercial_hook: forbidden })
      .rejections.filter((item) => item.field === 'email_commercial_hook').map((item) => item.reason).join('\n');
    assert.match(reasons, /forbidden commercial loss claim|numeric commercial impact|invented commercial loss/);
  }

  assert.deepEqual(validateFactConstrainedOutput(facts, {
    ...gold,
    email_commercial_hook: 'The seller opportunity was left untouched.',
  }).rejections, [], 'a conservative observation-implied seller frame remains allowed');
}
ok('hooks reject paraphrase, commercial loss and numeric impact while allowing conservative seller framing');

{
  const facts = selectPersonalisationFacts(fixtures[8]);
  const gold = renderCanonicalFactCopy(facts);
  const prompts = [];
  let call = 0;
  __setAiCallerForTests(async ({ prompt }) => {
    prompts.push(prompt);
    call += 1;
    return call === 1
      ? { ...gold, email_commercial_hook: 'That meant a lost instruction.' }
      : { ...gold, email_observation: 'A changed observation that must not survive.' };
  });
  const row = await personaliseProbeFromFacts(facts, { enabled: true });
  assert.equal(row.email_observation, gold.email_observation);
  assert.equal(row.ai_calls_used, 2);
  assert.match(prompts[1], /observation is locked/i);
  assert.match(prompts[1], new RegExp(`FINAL_EMAIL_OBSERVATION: ${gold.email_observation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
}
ok('a valid final observation is locked byte-for-byte during hook-only repair');

const completeMiss = selectPersonalisationFacts(fixtures[0]);
const malicious = {
  email_observation: 'After I replied, your branch ignored all three calls about a £900,000 seller instruction.',
  email_commercial_hook: 'That cost you £20,000 in commission.',
  email_commercial_hook_email_2: 'Every agent lost a listing.',
};
const maliciousReasons = validateFactConstrainedOutput(completeMiss, malicious).rejections.map((item) => item.reason).join('\n');
assert.match(maliciousReasons, /vocabulary absent|quantities absent/);
assert.match(maliciousReasons, /unsupported prospect reply|false chronology|invented commercial loss|certainty_upgrade|unsupported_universal/);
ok('new facts, quantities, replies, chronology, universal claims, values and seller instructions are rejected');

{
  const facts = selectPersonalisationFacts(fixtures[8]);
  const gold = renderCanonicalFactCopy(facts);
  for (const invalid of [
    'The buyer enquiry never progressed to an actual viewing time or booking.',
    'The viewing was never confirmed as an appointment.',
    'The buyer never reached a booked slot.',
    'Buyer qualification was never completed.',
    'The enquiry contained buyer and seller opportunities, without evidence that both were progressed.',
  ]) {
    const reasons = validateFactConstrainedOutput(facts, {
      ...gold,
      email_observation: invalid,
    }).rejections.filter((item) => item.field === 'email_observation').map((item) => item.reason);
    assert.ok(reasons.includes('response-dependent outcome criticism'), `response-dependent criticism is rejected: ${invalid}`);
  }
}
ok('viewing, appointment, booked-slot, qualification and generic progression outcomes are rejected');

{
  const facts = selectPersonalisationFacts(fixtures[8]);
  const gold = renderCanonicalFactCopy(facts);
  const prompts = [];
  let call = 0;
  __setAiCallerForTests(async ({ prompt }) => {
    prompts.push(prompt);
    call += 1;
    return call === 1
      ? { ...gold, email_observation: 'The buyer enquiry never progressed to an actual viewing time or booking.' }
      : gold;
  });
  const row = await personaliseProbeFromFacts(facts, { enabled: true });
  assert.equal(row.ai_calls_used, 2);
  assert.equal(row.email_observation, gold.email_observation);
  assert.match(prompts[1], /response-dependent outcome criticism/);
  assert.ok(!prompts[1].includes('never progressed to an actual viewing time or booking'));
}
ok('response-dependent criticism uses the existing bounded facts-only repair path');

// One bad result receives one facts-only repair. The invalid prose is not
// echoed into the repair prompt, so it cannot become a second factual source.
{
  const facts = selectPersonalisationFacts(fixtures[4]);
  const gold = renderCanonicalFactCopy(facts);
  const prompts = [];
  let call = 0;
  __setAiCallerForTests(async ({ prompt }) => {
    prompts.push(prompt);
    call += 1;
    return call === 1 ? { ...gold, email_observation: 'I replied and then you called me three times.' } : gold;
  });
  const row = await personaliseProbeFromFacts(facts, { enabled: true });
  assert.equal(row.ai_calls_used, 2);
  assert.equal(row.used_canonical_fallback, false);
  assert.ok(!prompts[1].includes('I replied and then you called me three times.'));
  assert.match(prompts[1], /CORRECTION REQUIRED/);
}
ok('repair remains facts-only and cannot promote rejected prose into evidence');

// Two invalid answers fall back to the deterministic canonical grammar.
{
  const facts = selectPersonalisationFacts(fixtures[8]);
  const gold = renderCanonicalFactCopy(facts);
  __setAiCallerForTests(async () => ({
    email_observation: 'A new invented conversation happened.',
    email_commercial_hook: 'This caused a sale.',
    email_commercial_hook_email_2: 'There were 99 replies.',
  }));
  const row = await personaliseProbeFromFacts(facts, { enabled: true });
  assert.equal(row.used_canonical_fallback, true);
  assert.deepEqual(Object.fromEntries(Object.keys(gold).map((field) => [field, row[field]])), gold);
}
ok('an invalid bounded repair falls back to canonical facts rather than banking an invention');

await assert.rejects(() => personaliseProbeFromFacts(noPositive), /requires \{ enabled: true \}/);
assert.throws(() => buildFactConstrainedPrompt({ ...noPositive, positive: [{ type: 'a', text: 'A.' }, { type: 'b', text: 'B.' }] }), /at most 1 positive/);
assert.throws(() => buildFactConstrainedPrompt({ ...noPositive, problems: [{ type: 'a', text: 'A.' }, { type: 'b', text: 'B.' }, { type: 'c', text: 'C.' }] }), /at most 2 problems/);
ok('the alternate path is opt-in and enforces the fact-selection cardinality contract');

console.log(`\n${checks} Phase 2 checks passed.`);
