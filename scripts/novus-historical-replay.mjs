// scripts/novus-historical-replay.mjs — replays the 14 historical probes
// through the CURRENT Personalisation + DEMOS code and reports what changes.
//
// WHAT IS REAL HERE AND WHAT IS SIMULATED. Read this before quoting a number
// out of the report.
//
//   REAL — everything the deterministic layer owns:
//     * which fields survive validation and which are blanked, and WHY;
//     * the reason a blank is legitimate (no positive finding selected, no
//       problem finding selected, no human response) versus an accident;
//     * markup removal and structured-output recovery;
//     * perspective, length and quantification gating;
//     * the code-computed opportunity-shape counts;
//     * how many AI calls each probe costs;
//     * the compiled DEMOS status and its review reasons.
//
//   SIMULATED — the model itself. There is no API key in this environment, so
//     call 1 replays each probe's RECORDED historical model output verbatim
//     (scripts/fixtures/historical-probes.json), which is what makes the
//     "before" column the actual regression rather than a reconstruction. When
//     the new validation asks for a correction, call 2 is answered by a
//     deterministic stand-in that does what the new prompt instructs: it
//     rewrites the failed field from the SAME selected findings and the SAME
//     code-computed counts. That proves the repair path and the counts are
//     right; it does not prove a live model will write the same sentence.
//
//   RECONSTRUCTED — the DIAGNOSIS_FINDINGS rows. The findings tab was not
//     exported with the two CSVs, so each probe's findings are rebuilt from
//     its persisted `evidence` column (which quotes the selected findings
//     verbatim) plus its selected indexes. The selection is therefore exact;
//     the unselected findings of each probe are not represented.
//
// Usage: node scripts/novus-historical-replay.mjs [--json]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';
import { personaliseProbe, buildOpportunityShape } from '../lib/probe-personalisation.mjs';
import { buildDemoRow } from '../lib/demos.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'historical-probes.json');
const probes = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

const text = (v) => String(v ?? '').trim();

// ── the deterministic stand-in for a model following the new prompt ──────────
//
// It is handed exactly what the real correction call is handed: the failed
// field names, the settled selection, and the OPPORTUNITY SHAPE block. It
// writes from those and nothing else.
function shapeCounts(fixture) {
  const shape = buildOpportunityShape(fixture.probe, fixture.intelligence);
  const num = (re) => { const m = shape.match(re); return m ? Number(m[1]) : null; };
  return {
    opportunities: num(/opportunities inside this one enquiry: (\d+)/),
    progressed: num(/concrete next step: (\d+) of/),
    attempts: num(/Contact attempts: (\d+)/),
    followUps: num(/follow-ups(?: after the first)?: (\d+)/),
    conversations: num(/Conversations genuinely created: (\d+)/),
    noContact: /no meaningful human response/.test(shape),
  };
}

function simulatedHook(fixture) {
  const c = shapeCounts(fixture);
  if (c.noContact) return `That's ${c.opportunities} live opportunities from 1 enquiry, with 0 conversations created.`;
  if (c.progressed === 0 && c.attempts > 1) {
    return `So even with ${c.attempts} contact attempts, ${c.opportunities === 2 ? 'neither of the 2 commercial opportunities' : 'the commercial opportunity'} in that enquiry was taken to a next step.`;
  }
  if (c.progressed === 0) return `That's ${c.opportunities} commercial opportunities from 1 enquiry, with neither fully progressed.`;
  return `So ${c.opportunities - c.progressed} of the ${c.opportunities} commercial opportunities in that enquiry was effectively invisible to the process.`;
}

// A first-person rewrite of the recorded observation, used only when the
// recorded one failed the perspective or length gate.
function simulatedObservation(fixture, recorded) {
  const c = shapeCounts(fixture);
  if (c.noContact) {
    return "We didn't receive a response during the four-day observation period, and nobody picked up that I'd also said I had a property to sell.";
  }
  const trimmed = text(recorded)
    .replace(/\bJoe(?:'s|’s)\s+enquiry\b/gi, 'my enquiry')
    .replace(/\bJoe\b/g, 'I')
    .replace(/\bthe property (?:he|she|they) wants? to sell\b/gi, 'the property I said I had to sell')
    .replace(/\bthe (?:enquirer|buyer|prospect)\b/gi, 'I');
  const words = trimmed.split(/\s+/);
  if (words.length <= 40 && trimmed) return trimmed;
  return c.progressed > 0
    ? "You handled the viewing side properly, but nobody picked up that I'd also said I had a property to sell."
    : "You did come back to me, but the enquiry never reached a next step and nobody picked up that I'd also said I had a property to sell.";
}

function simulatedDemoLine(field, fixture, recordedResult) {
  const c = shapeCounts(fixture);
  if (field === 'fair_observation') {
    return text(recordedResult.fair_observation)
      || 'you picked the enquiry up and came back with the right property details.';
  }
  if (field === 'main_finding') {
    return text(recordedResult.main_finding)
      || 'the enquiry never reached the next step it needed.';
  }
  const unworked = c.opportunities - c.progressed;
  if (c.opportunities < 2) return 'that leaves the one commercial opportunity in this enquiry sitting unworked.';
  return unworked === c.opportunities
    ? `that leaves both commercial opportunities in this one enquiry sitting unworked.`
    : `that leaves ${unworked} of the ${c.opportunities} commercial opportunities in this one enquiry sitting unworked.`;
}

// THE STEADY-STATE CONTROL. Replaying the recorded regression as call 1 makes
// almost every probe need the bounded correction — which is the point, not a
// cost estimate. This second pass feeds a COMPLIANT first answer (the same
// selection, with copy that satisfies the new contract) and counts the calls,
// which is what a live model given the new prompt should cost.
async function replaySteadyState(fixture, compliant) {
  let calls = 0;
  __setAiCallerForTests(async ({ tool }) => {
    calls += 1;
    if (tool.name === 'record_probe_personalisation') return compliant;
    return Object.fromEntries(tool.input_schema.required.map((f) => [f, compliant[f] || 'a corrected line.']));
  });
  const row = await personaliseProbe(
    fixture.probe, fixture.intelligence, fixture.diagnosis,
    fixture.findings, { agency_name: fixture.agency_name },
  );
  return { calls, row };
}

async function replay(fixture) {
  let calls = 0;
  const repaired = [];
  __setAiCallerForTests(async ({ tool }) => {
    calls += 1;
    if (tool.name === 'record_probe_personalisation') return fixture.recorded_model_output;
    // Scoped correction: answer only the fields asked for.
    const fields = tool.input_schema.required;
    repaired.push(...fields);
    const patch = {};
    for (const field of fields) {
      patch[field] = field === 'email_commercial_hook' ? simulatedHook(fixture)
        : field === 'email_observation'
          ? simulatedObservation(fixture, fixture.recorded_model_output.email_observation)
          : simulatedDemoLine(field, fixture, fixture.recorded_model_output);
    }
    return patch;
  });

  const row = await personaliseProbe(
    fixture.probe, fixture.intelligence, fixture.diagnosis,
    fixture.findings, { agency_name: fixture.agency_name },
  );

  const compiled = buildDemoRow({
    probe: fixture.probe,
    agency: { agency_name: fixture.agency_name },
    intelligence: fixture.intelligence,
    findings: fixture.findings,
    personalisation: { personalisation_id: `psn_${fixture.probe_id}`, ...row },
    communications: [], now: '2026-08-25T12:00:00.000Z',
  });

  return { row, calls, repaired: [...new Set(repaired)], compiled };
}

// Why a blank is legitimate, stated from the SELECTION rather than guessed.
function blankReason(field, fixture, row) {
  const positive = fixture.selection.positive_finding_index;
  const main = fixture.selection.main_finding_index;
  const noContact = text(fixture.intelligence.human_contact) === 'none';
  if (field === 'fair_observation' && positive === null) {
    return noContact
      ? 'intentional — no human response, so there is no positive to credit'
      : 'intentional — this probe has no genuine [POSITIVE] finding';
  }
  if (field === 'main_finding' && noContact) return 'intentional — complete_miss demo tells the no-response story itself';
  if (field === 'main_finding' && main === null) return 'intentional — no problem/opportunity finding exists';
  if (field === 'commercial_consequence' && main === null) return 'intentional — no problem/opportunity finding exists';
  return text(row[field]) ? '' : 'UNEXPLAINED BLANK';
}

const FIELDS = ['fair_observation', 'main_finding', 'commercial_consequence',
  'email_observation', 'email_commercial_hook'];

const MARKUP = /<\/?[a-z_]+>|<\s*\/?\s*(?:antml:)?parameter\b|<function_calls>|<invoke\b/i;

async function main() {
  const asJson = process.argv.includes('--json');
  const results = [];
  for (const fixture of probes) results.push({ fixture, ...await replay(fixture) });

  const before = { blanks: {}, markup: 0, needsReview: 0 };
  const after = { blanks: {}, markup: 0, needsReview: 0 };
  for (const f of FIELDS) { before.blanks[f] = 0; after.blanks[f] = 0; }

  // Feed each probe's own repaired record back as a compliant first answer.
  const steady = [];
  for (const { fixture, row } of results) {
    steady.push(await replaySteadyState(fixture, {
      ...fixture.recorded_model_output,
      fair_observation: row.fair_observation || fixture.recorded_model_output.fair_observation,
      main_finding: row.main_finding || fixture.recorded_model_output.main_finding,
      commercial_consequence: row.commercial_consequence,
      email_observation: row.email_observation,
      email_commercial_hook: row.email_commercial_hook,
      primary_narrative: row.primary_narrative,
    }));
  }

  const rows = results.map(({ fixture, row, calls, repaired, compiled }) => {
    for (const f of FIELDS) {
      if (!text(fixture.recorded_persisted[f])) before.blanks[f] += 1;
      if (!text(row[f])) after.blanks[f] += 1;
    }
    if (MARKUP.test(fixture.recorded_persisted.primary_narrative)) before.markup += 1;
    if (MARKUP.test(row.primary_narrative)) after.markup += 1;
    if (fixture.recorded_demo.demo_status !== 'ready') before.needsReview += 1;
    if (compiled.status !== 'ready') after.needsReview += 1;

    const unexplained = FIELDS
      .map((f) => [f, text(row[f]) ? '' : blankReason(f, fixture, row)])
      .filter(([, reason]) => reason === 'UNEXPLAINED BLANK').map(([f]) => f);

    return { fixture, row, calls, repaired, compiled, unexplained };
  });

  if (asJson) {
    console.log(JSON.stringify({ before, after, rows: rows.map((r) => ({
      probe_id: r.fixture.probe_id, calls: r.calls, repaired: r.repaired,
      demo_status: r.compiled.status, review_reasons: r.compiled.reasons,
      unexplained: r.unexplained,
      ...Object.fromEntries(FIELDS.map((f) => [f, r.row[f]])),
    })) }, null, 2));
    return;
  }

  console.log('NOVUS Personalisation — 14 historical probes, replayed through the current code');
  console.log('='.repeat(96));
  console.log('Call 1 replays each probe\'s recorded historical model output verbatim.');
  console.log('Call 2, where the new validation asks for one, is a deterministic stand-in');
  console.log('for a model following the new prompt. See this file\'s header.\n');

  for (const { fixture, row, calls, repaired, compiled, unexplained } of rows) {
    const sel = fixture.selection;
    console.log(`── ${fixture.probe_id}  (${fixture.agency_name})`);
    console.log(`   selection      positive=${sel.positive_finding_index ?? '-'} main=${sel.main_finding_index ?? '-'} wider=${sel.wider_finding_index ?? '-'}   hero=${row.hero_journey}`);
    console.log(`   AI calls       ${calls}${repaired.length ? `  (scoped repair: ${repaired.join(', ')})` : ''}`);
    for (const f of FIELDS) {
      const value = text(row[f]);
      const wasBlank = !text(fixture.recorded_persisted[f]);
      const mark = value ? (wasBlank ? '+' : ' ') : '-';
      console.log(`   ${mark} ${f.padEnd(23)}${value || `(blank) ${blankReason(f, fixture, row)}`}`);
    }
    console.log(`   demo           ${fixture.recorded_demo.demo_status} -> ${compiled.status}${compiled.reasons.length ? `  [${compiled.reasons.join(' · ')}]` : ''}`);
    if (unexplained.length) console.log(`   !! UNEXPLAINED BLANKS: ${unexplained.join(', ')}`);
    console.log('');
  }

  console.log('='.repeat(96));
  console.log('BEFORE -> AFTER');
  for (const f of FIELDS) console.log(`  ${f.padEnd(24)} blank in ${String(before.blanks[f]).padStart(2)} -> ${String(after.blanks[f]).padStart(2)} of 14`);
  console.log(`  ${'primary_narrative markup'.padEnd(24)}       ${String(before.markup).padStart(2)} -> ${String(after.markup).padStart(2)} of 14`);
  console.log(`  ${'demos needs_review'.padEnd(24)}       ${String(before.needsReview).padStart(2)} -> ${String(after.needsReview).padStart(2)} of 14`);
  const totalCalls = rows.reduce((n, r) => n + r.calls, 0);
  const steadyCalls = steady.reduce((n, r) => n + r.calls, 0);
  console.log(`  AI calls replaying the recorded regression as call 1: ${totalCalls} for ${rows.length} probes (${(totalCalls / rows.length).toFixed(2)}/probe, cap 2)`);
  console.log(`  AI calls when call 1 already meets the contract:       ${steadyCalls} for ${steady.length} probes (${(steadyCalls / steady.length).toFixed(2)}/probe) — the steady state`);
  const unexplainedTotal = rows.reduce((n, r) => n + r.unexplained.length, 0);
  console.log(`  Unexplained blanks: ${unexplainedTotal}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
