#!/usr/bin/env node

// Hermetic side-by-side replay. The current path runs in a child process via
// the existing historical replay; the alternate path runs in this process
// with a deterministic stand-in for constrained AI. Nothing is persisted.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';
import { selectPersonalisationFacts } from '../lib/personalisation-facts.mjs';
import { personaliseProbeFromFacts, renderCanonicalFactCopy } from '../lib/fact-constrained-personalisation.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/historical-probes.json'), 'utf8'));
const currentRun = spawnSync(process.execPath, [path.join(here, 'novus-historical-replay.mjs'), '--json'], { encoding: 'utf8' });
assert.equal(currentRun.status, 0, `current Personalisation replay failed:\n${currentRun.stdout}\n${currentRun.stderr}`);
const currentRows = new Map(JSON.parse(currentRun.stdout).rows.map((row) => [row.probe_id, row]));
const fields = ['email_observation', 'email_commercial_hook', 'email_commercial_hook_email_2'];
const output = [];

for (const fixture of fixtures) {
  const facts = selectPersonalisationFacts(fixture);
  const gold = renderCanonicalFactCopy(facts);
  __setAiCallerForTests(async () => gold);
  const constrained = await personaliseProbeFromFacts(facts, { enabled: true });
  const current = currentRows.get(fixture.probe_id);
  assert.ok(current, `${fixture.probe_id}: current-path row exists`);
  output.push({
    probe_id: fixture.probe_id,
    current_path: Object.fromEntries(fields.map((field) => [field, current[field] || ''])),
    fact_constrained_path: Object.fromEntries(fields.map((field) => [field, constrained[field] || ''])),
  });
}
assert.equal(output.length, 14);
console.log(JSON.stringify(output, null, 2));
