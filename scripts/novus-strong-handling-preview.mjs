#!/usr/bin/env node

// Test-only synthetic preview. Reads one checked-in fixture, calls only the
// Diagnosis -> Personalisation path, and has no production repository imports
// or write operations.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hasAnthropicApiKey } from '../lib/anthropic-server.mjs';
import { diagnoseProbe, parseDiagnosisFindings } from '../lib/probe-diagnosis.mjs';
import { selectPersonalisationFacts } from '../lib/personalisation-facts.mjs';
import { personaliseProbeFromFacts } from '../lib/fact-constrained-personalisation.mjs';

if (!hasAnthropicApiKey()) {
  console.error('NOVUS_DEVELOPMENT_API is not configured. Preview stopped; Production was not used.');
  process.exitCode = 2;
} else {
  const path = fileURLToPath(new URL('./fixtures/strong-handling-probe.json', import.meta.url));
  const fixture = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (fixture.fixture_type !== 'test_only_synthetic') throw new Error('Strong-handling preview accepts only its test-only synthetic fixture.');

  const diagnosis = await diagnoseProbe(fixture.intelligence, fixture.probe);
  const findings = parseDiagnosisFindings(diagnosis).map((finding, index) => ({ ...finding, finding_index: index + 1 }));
  const facts = selectPersonalisationFacts({ findings, intelligence: fixture.intelligence, probe: fixture.probe });
  const surface = await personaliseProbeFromFacts(facts, { enabled: true });

  console.log(JSON.stringify({
    agency: fixture.agency_name,
    handling_quality: diagnosis.handling_quality,
    handling_summary: diagnosis.handling_summary,
    unresolved_context: JSON.parse(diagnosis.unresolved_context || '[]'),
    recommended_actions: JSON.parse(diagnosis.recommended_actions || '[]'),
    email_observation: surface.email_observation,
    email_commercial_hook: surface.email_commercial_hook,
  }, null, 2));
}
