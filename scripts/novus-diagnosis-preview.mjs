#!/usr/bin/env node

// Read-only five-probe preview. Uses the checked-in snapshots of real existing
// probes, calls only the development Anthropic key, and writes nowhere.

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
  const path = fileURLToPath(new URL('./fixtures/historical-probes.json', import.meta.url));
  const fixtures = JSON.parse(fs.readFileSync(path, 'utf8'));
  const representativeIds = ['prb_hist_0001', 'prb_hist_0002', 'prb_hist_0005', 'prb_hist_0009', 'prb_hist_0012'];
  const requestedIds = process.argv.slice(2);
  const ids = requestedIds.length ? requestedIds : representativeIds;
  if (ids.some((id) => !representativeIds.includes(id))) {
    throw new Error('Preview accepts only the five approved representative probe IDs.');
  }
  const targets = ids.map((id) => fixtures.find((item) => item.probe_id === id)).filter(Boolean);

  for (const fixture of targets) {
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
}
