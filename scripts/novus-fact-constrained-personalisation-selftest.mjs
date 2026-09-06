#!/usr/bin/env node

import assert from 'node:assert/strict';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';
import {
  buildFactConstrainedPrompt,
  personaliseProbeFromFacts,
  renderCanonicalFactCopy,
  validateFactConstrainedOutput,
} from '../lib/fact-constrained-personalisation.mjs';
import { containsInternalProspectLanguage, wordCount } from '../lib/prospect-language.mjs';
import { toRenderReady } from '../lib/demos.mjs';

const shapes = [
  ['complete miss', [], [{ type: 'complete_miss', text: "In the four days after I sent the enquiry, I didn't record a human response or any follow-up attempt." }], [{ type: 'seller_context_unresolved_hook_only', text: 'The original enquiry said there was a property to sell, but its relevance to the move was not established.' }]],
  ['fast but shallow', [{ type: 'human_response_fast', text: 'The team sent a human response within 12 minutes.' }], [{ type: 'buyer_not_qualified', text: 'No buyer qualification was recorded.' }], []],
  ['persistent with context unresolved', [{ type: 'persistent_follow_up', text: 'The agency made 2 follow-up attempts.' }], [{ type: 'seller_context_unresolved', text: 'The declared seller context was not clarified.' }], [{ type: 'viewing_progression_hook_only', text: 'The buyer side had also progressed to a viewing invitation.' }]],
  ['strong handling', [{ type: 'concrete_buyer_next_step', text: 'The agency offered the buyer a specific viewing slot.' }], [], []],
];

for (const [name, positive, problems, secondary = []] of shapes) {
  const facts = { positive, problems, consequences: [], secondary_facts: secondary };
  const gold = renderCanonicalFactCopy(facts);
  assert.deepEqual(Object.keys(gold), ['email_observation', 'email_commercial_hook']);
  assert.ok(gold.email_observation, `${name}: observation`);
  assert.ok(gold.email_commercial_hook, `${name}: hook`);
  assert.equal('email_commercial_hook_email_2' in gold, false);
  assert.doesNotMatch(`${gold.email_observation} ${gold.email_commercial_hook}`, /valuation opportunity|lost revenue|instruction|fee/i);
  assert.equal(containsInternalProspectLanguage(`${gold.email_observation} ${gold.email_commercial_hook}`), false);
  assert.ok(wordCount(gold.email_observation) <= 25);
  assert.deepEqual(validateFactConstrainedOutput(facts, gold).rejections, []);
  assert.doesNotMatch(buildFactConstrainedPrompt(facts), /HOOK_2|Hook 2|email_commercial_hook_email_2/);

  __setAiCallerForTests(async ({ tool }) => {
    assert.deepEqual(tool.input_schema.required, ['email_observation', 'email_commercial_hook']);
    return gold;
  });
  const result = await personaliseProbeFromFacts(facts, { enabled: true });
  assert.equal(result.email_observation, gold.email_observation);
  assert.equal(result.email_commercial_hook, gold.email_commercial_hook);
  assert.equal('email_commercial_hook_email_2' in result, false);
}

{
  const facts = { positive: [], problems: [{ type: 'complete_miss', text: "In the four days after I sent the enquiry, I didn't record a human response." }], consequences: [], secondary_facts: [] };
  const rejected = validateFactConstrainedOutput(facts, {
    email_observation: 'No human response was recorded during the observation window.',
    email_commercial_hook: 'The enquiry contained several signals, but no human conversation began.',
  }).rejections;
  assert.ok(rejected.some((item) => item.reason === 'uses internal NOVUS language'));
}

{
  const ready = toRenderReady({
    handling_summary: 'No reply arrived during the observation window.',
    enquiry_signals: JSON.stringify([{ label: 'Structured signal', value: 'Known', context: 'From the intelligence row', source_type: 'intelligence' }]),
    unresolved_context: JSON.stringify([{ question: 'What unresolved context remains?', why_it_matters: 'It changes the next step.' }]),
    recommended_actions: JSON.stringify([{ title: 'Review the finding', detail: 'Keep it out of the pipeline.' }]),
  });
  assert.equal(containsInternalProspectLanguage(JSON.stringify({
    handling_summary: ready.handling_summary,
    enquiry_signals: ready.enquiry_signals,
    unresolved_context: ready.unresolved_context,
    recommended_actions: ready.recommended_actions,
  })), false, 'the demo boundary rewrites legacy internal terminology');
}

__setAiCallerForTests(null);
console.log('✅ novus-fact-constrained-personalisation-selftest: two-field evidence-led contract passes');
