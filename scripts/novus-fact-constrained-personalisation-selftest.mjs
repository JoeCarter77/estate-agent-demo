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
    /\b(?:supported facts|selected facts|declared seller opportunity|recorded progression)\b/i,
    `${fixture.probe_id}: constrained copy avoids internal system language`,
  );
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
  assert.match(prompt, /GOLD GRAMMAR SHAPES/);
  for (const line of Object.values(gold).filter(Boolean)) assert.ok(prompt.includes(line), `${fixture.probe_id}: gold examples contain only current supplied facts`);

  const validated = validateFactConstrainedOutput(facts, row);
  assert.deepEqual(validated.rejections, [], `${fixture.probe_id}: existing factual validators pass`);
}
ok('all 14 probes use only PERSONALISATION_FACTS at the AI boundary and pass the factual validators');
assert.equal(constrainedFieldCount, 42, 'all 14 × 3 constrained outreach fields are populated');
ok('all 42 constrained outreach fields are populated from supplied facts');

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
assert.match(renderCanonicalFactCopy(unknownFacts).email_commercial_hook_email_2, /unknown/i);
assert.deepEqual(validateFactConstrainedOutput(unknownFacts, {
  ...renderCanonicalFactCopy(unknownFacts),
  email_commercial_hook_email_2: 'Nothing was mentioned on that call.',
}).rejections.map((item) => item.reason).some((reason) => /unknown_call_certainty|unsupported voicemail/i.test(reason)), true);
ok('unknown communication content remains unknown and certainty upgrades are rejected');

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
