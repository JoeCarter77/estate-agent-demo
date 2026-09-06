#!/usr/bin/env node

// Hermetic Phase 1 contract for the additive PERSONALISATION_FACTS selector.
// No Sheets, AI, prompts, persistence, generation or production path is used.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { selectPersonalisationFacts } from '../lib/personalisation-facts.mjs';

const fixturesPath = fileURLToPath(new URL('./fixtures/historical-probes.json', import.meta.url));
const fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));

const EXPECTED_TYPES = {
  prb_hist_0001: { positive: [], problems: ['complete_miss'], consequences: ['buyer_received_no_further_progression'], secondary_facts: ['seller_context_unresolved_hook_only'] },
  prb_hist_0002: { positive: [], problems: ['slow_human_response'], consequences: ['enquiry_waited_before_human_handling'], secondary_facts: ['seller_context_unresolved_hook_only'] },
  prb_hist_0003: { positive: [], problems: ['complete_miss'], consequences: ['buyer_received_no_further_progression'], secondary_facts: ['seller_context_unresolved_hook_only'] },
  prb_hist_0004: { positive: [], problems: ['slow_human_response'], consequences: ['enquiry_waited_before_human_handling'], secondary_facts: ['communication_content_unknown'] },
  prb_hist_0005: { positive: ['human_response_within_16h'], problems: ['buyer_not_qualified'], consequences: ['response_speed_good_but_progression_weak'], secondary_facts: ['seller_context_unresolved_hook_only'] },
  prb_hist_0006: { positive: ['human_response_within_16h'], problems: ['seller_context_unresolved'], consequences: ['seller_context_needs_clarification'], secondary_facts: ['seller_intent_present_in_original_enquiry'] },
  prb_hist_0007: { positive: ['human_response_within_16h'], problems: ['seller_context_unresolved'], consequences: ['seller_context_needs_clarification'], secondary_facts: ['seller_intent_present_in_original_enquiry'] },
  prb_hist_0008: { positive: ['concrete_buyer_next_step'], problems: ['seller_context_unresolved'], consequences: ['seller_context_needs_clarification'], secondary_facts: ['seller_intent_present_in_original_enquiry'] },
  prb_hist_0009: { positive: ['persistent_follow_up'], problems: ['buyer_not_qualified'], consequences: [], secondary_facts: ['seller_context_unresolved_hook_only'] },
  prb_hist_0010: { positive: [], problems: ['buyer_not_qualified'], consequences: [], secondary_facts: ['seller_context_unresolved_hook_only'] },
  prb_hist_0011: { positive: ['concrete_buyer_next_step'], problems: ['buyer_not_qualified'], consequences: [], secondary_facts: ['seller_context_unresolved_hook_only'] },
  prb_hist_0012: { positive: ['concrete_buyer_next_step'], problems: ['seller_context_unresolved'], consequences: ['seller_context_needs_clarification'], secondary_facts: ['seller_intent_present_in_original_enquiry', 'seller_context_recognised_hook_only'] },
  prb_hist_0013: { positive: [], problems: ['slow_human_response'], consequences: ['enquiry_waited_before_human_handling'], secondary_facts: ['communication_content_incomplete'] },
  prb_hist_0014: { positive: ['human_response_within_16h'], problems: ['communication_record_incomplete'], consequences: ['communication_quality_not_determinable'], secondary_facts: ['communication_content_incomplete'] },
};

function typesOf(result) {
  return Object.fromEntries(Object.entries(result).map(([category, facts]) => [category, facts.map((item) => item.type)]));
}

function allFacts(result) {
  return Object.values(result).flat();
}

assert.equal(fixtures.length, 14, 'the production fixture still contains exactly 14 probes');
assert.deepEqual(fixtures.map((fixture) => fixture.probe_id), Object.keys(EXPECTED_TYPES), 'every production probe has an explicit expected selection');

const generated = [];
for (const fixture of fixtures) {
  const before = JSON.stringify(fixture);
  const first = selectPersonalisationFacts(fixture);
  const second = selectPersonalisationFacts(fixture);

  assert.deepEqual(first, second, `${fixture.probe_id}: selection is deterministic`);
  assert.equal(JSON.stringify(fixture), before, `${fixture.probe_id}: upstream fixture is not mutated`);
  assert.deepEqual(Object.keys(first), ['positive', 'problems', 'consequences', 'secondary_facts'], `${fixture.probe_id}: stable top-level shape`);
  assert.ok(first.positive.length <= 1, `${fixture.probe_id}: maximum one positive`);
  assert.ok(first.problems.length <= 2, `${fixture.probe_id}: maximum two primary problems`);
  assert.deepEqual(typesOf(first), EXPECTED_TYPES[fixture.probe_id], `${fixture.probe_id}: expected supported fact types`);

  const findingIndexes = new Set(fixture.findings.map((finding) => Number(finding.finding_index)));
  for (const selected of allFacts(first)) {
    assert.match(selected.type, /^[a-z][a-z0-9_]*$/, `${fixture.probe_id}: stable snake_case type`);
    assert.ok(selected.text && selected.text === selected.text.trim(), `${fixture.probe_id}: non-blank canonical text`);
    assert.ok(Array.isArray(selected.provenance) && selected.provenance.length > 0, `${fixture.probe_id}: provenance is present`);
    for (const source of selected.provenance) {
      if (source.record === 'DIAGNOSIS_FINDINGS') {
        assert.ok(findingIndexes.has(source.finding_index), `${fixture.probe_id}: finding provenance resolves upstream`);
      }
      if (source.record === 'INTELLIGENCE') {
        for (const field of source.fields) assert.ok(Object.hasOwn(fixture.intelligence, field), `${fixture.probe_id}: INTELLIGENCE.${field} provenance resolves upstream`);
      }
      if (source.record === 'PROBES') {
        for (const field of source.fields) assert.ok(Object.hasOwn(fixture.probe, field), `${fixture.probe_id}: PROBES.${field} provenance resolves upstream`);
      }
    }
  }

  // Buyer property facts are intentionally not selected into canonical copy;
  // they therefore cannot drift into seller-side claims in this phase.
  const canonicalText = allFacts(first).map((item) => item.text).join(' ');
  assert.ok(!canonicalText.includes(fixture.probe.property_address), `${fixture.probe_id}: buyer address is not emitted as a seller fact`);
  assert.ok(!canonicalText.includes(fixture.probe.property_price), `${fixture.probe_id}: buyer price is not emitted as a seller fact`);

  generated.push({ probe_id: fixture.probe_id, personalisation_facts: first });
}

// No positive finding means no praise, even when a structured speed metric is
// present. A blank-evidence finding is not support and is discarded.
assert.deepEqual(selectPersonalisationFacts({
  findings: [{ finding_index: 1, finding_type: 'positive', finding: 'Quick.', evidence: '' }],
  intelligence: { human_contact: 'yes', response_hours: 0.25 },
  probe: {},
}).positive, []);

// The exact fast boundary and the seller ordinal are selected from structured
// values, while their existence remains gated by evidence-backed findings.
assert.deepEqual(typesOf(selectPersonalisationFacts({
  findings: [{ finding_index: 1, finding_type: 'positive', finding: 'A quick human response.', evidence: 'Response at 30 minutes.' }],
  intelligence: { human_contact: 'yes', response_hours: 0.5 },
  probe: {},
})).positive, ['human_response_fast']);

assert.deepEqual(typesOf(selectPersonalisationFacts({
  findings: [
    { finding_index: 1, finding_type: 'opportunity', finding: 'The declared property to sell was only acknowledged.', evidence: 'Seller recognition: acknowledged.' },
    { finding_index: 2, finding_type: 'positive', finding: 'The buyer was asked for availability.', evidence: 'Viewing progression: availability requested.' },
  ],
  intelligence: { human_contact: 'yes', response_hours: 2, viewing_progression: 'availability_requested', seller_recognition: 'acknowledged' },
  probe: { enquiry_text: 'I have a property to sell.' },
})).problems, ['seller_context_unresolved']);

// Missing content keeps content-based negatives unknown, but deterministic
// timing remains selectable.
const unknown = selectPersonalisationFacts({
  findings: [
    { finding_index: 1, finding_type: 'problem', finding: 'Response time 20 hours; voice call with no content/transcript.', evidence: 'No transcript.' },
    { finding_index: 2, finding_type: 'opportunity', finding: 'Seller recognition none.', evidence: 'No valuation recorded.' },
  ],
  intelligence: { human_contact: 'yes', response_hours: 20, contact_attempts: 1, follow_ups: 0, viewing_progression: 'none', seller_recognition: 'none' },
  probe: { enquiry_text: 'I have a property to sell.' },
});
assert.deepEqual(typesOf(unknown), {
  positive: [],
  problems: ['slow_human_response'],
  consequences: ['enquiry_waited_before_human_handling'],
  secondary_facts: ['communication_content_unknown'],
});

console.log(`PERSONALISATION_FACTS Phase 1: ${fixtures.length} production probes passed\n`);
console.log(JSON.stringify(generated, null, 2));
