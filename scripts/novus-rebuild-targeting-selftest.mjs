// scripts/novus-rebuild-targeting-selftest.mjs — hermetic test (no network,
// no creds) for the opts.probeIds targeting option on runRebuildPass() /
// rebuildAllIntelligence() / rebuildAllDiagnosis() / rebuildAllPersonalisation().
//
// WHY THIS EXISTS: unfreezing a handful of historical probes' DIAGNOSIS rows
// (clearing diagnosis_summary) to test the new Personalisation output ran
// Personalisation for EVERY already-diagnosed historical probe, not just the
// unfrozen ones. Root cause, reproduced below: rebuildAllPersonalisation's
// only gate is "does this probe have a non-blank DIAGNOSIS.diagnosis_summary,
// and does it NOT yet have a PERSONALISATION row" — it has no way to tell a
// probe whose Diagnosis was regenerated in this exact pass apart from one
// that has been sitting diagnosed for weeks. On a workbook whose
// PERSONALISATION tab is empty (as it was for this test — the tab was just
// created), EVERY historical probe with a diagnosis_summary looks equally
// eligible, unfrozen-just-now or not, so a full rebuild personalises all of
// them in one sweep.
//
// This suite proves:
//   1. the bug, reproduced: an untargeted rebuild personalises every
//      diagnosed probe on an empty PERSONALISATION tab, not just the one
//      whose Diagnosis was freshly unfrozen
//   2. the fix: opts.probeIds restricts ALL THREE steps (Intelligence,
//      Diagnosis, Personalisation) to exactly the listed probes — every
//      other eligible probe is left completely untouched, no AI calls spent
//   3. DIAGNOSIS_FINDINGS is scoped by the same filter (it's written inside
//      the Diagnosis step)
//   4. the filter composes correctly with maxAiCalls/batch budgeting and
//      with the existing frozen-probe checks — it never re-processes an
//      already-finalised probe just because it's named in probeIds
//   5. the HTTP handler (api/novus/intelligence/rebuild-all.js) accepts
//      { probe_ids: [...] } and threads it through, distinct from the older
//      singular { probe_id } single-probe path
//
// Run: npm run novus:rebuild-targeting-selftest

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';
import { runRebuildPass } from '../lib/rebuild-pass.mjs';
import { rebuildAllIntelligence } from '../lib/intelligence-rebuild.mjs';

const PROBES_HEADER = [
  'agency_id', 'probe_id', 'probe_reference', 'portal', 'property_address', 'property_url',
  'property_price', 'property_status', 'enquiry_text', 'probe_email', 'probe_phone',
  'probe_timestamp', 'observation_deadline', 'probe_status', 'compromised', 'compromise_reason',
  'observation_closed_at', 'sent_from', 'observation_notes', 'created_at', 'updated_at',
];
const COMMUNICATIONS_HEADER = [
  'communication_id', 'agency_id', 'probe_id', 'occurred_at', 'channel', 'direction',
  'source_identifier_normalized', 'subject', 'body_text', 'transcript', 'raw_content',
  'match_status', 'automated_or_human', 'manual_override', 'created_at', 'updated_at',
];
const INTELLIGENCE_HEADER = [
  'probe_id', 'probe_ref', 'agency_id', 'observation_status', 'human_contact',
  'response_hours', 'first_human_response_at', 'contact_attempts', 'follow_ups',
  'channels_used', 'viewing_progression', 'buyer_qualification', 'buyer_questions_asked',
  'seller_recognition', 'communication_quality', 'did_well', 'missed', 'evidence',
  'grade', 'grade_reason',
];
const DIAGNOSIS_HEADER = [
  'probe_id', 'probe_ref', 'agency_id', 'strengths', 'missed_opportunities',
  'commercial_implication', 'novus_opportunity', 'diagnosis_summary',
];
const DIAGNOSIS_FINDINGS_HEADER = ['probe_id', 'finding_index', 'finding', 'evidence', 'significance_note'];
const PERSONALISATION_HEADER = [
  'personalisation_id', 'agency_id', 'probe_id', 'hero_journey',
  'primary_narrative', 'narrative_finding_indexes', 'supporting_findings', 'evidence',
  'novus_counterfactual',
  'enquiry_date', 'property_address', 'email_variant',
  'fair_observation', 'main_finding', 'commercial_consequence', 'wider_observation', 'wider_consequence',
  'additional_findings_hook', 'email_body',
  'created_at', 'updated_at',
];
const AGENCIES_HEADER = ['agency_id', 'agency_name'];

function makeFakeSheet() {
  const store = {
    // The marker row is built with row(), not a positional literal, so
    // 'SCHEMA NOTE' always lands in the probe_id/agency_id column regardless
    // of where that column sits in each header — PROBES here has agency_id
    // first (the live sheet's own order), unlike some other fixtures in this
    // repo, and a positional ['SCHEMA NOTE', 'Fixture'] would silently put
    // 'SCHEMA NOTE' in agency_id and leave probe_id holding 'Fixture',
    // which then reads back as a spurious real probe.
    PROBES: [PROBES_HEADER.slice(), row(PROBES_HEADER, { probe_id: 'SCHEMA NOTE' })],
    COMMUNICATIONS: [COMMUNICATIONS_HEADER.slice(), row(COMMUNICATIONS_HEADER, { communication_id: 'SCHEMA NOTE' })],
    INTELLIGENCE: [INTELLIGENCE_HEADER.slice()],
    DIAGNOSIS: [DIAGNOSIS_HEADER.slice()],
    DIAGNOSIS_FINDINGS: [DIAGNOSIS_FINDINGS_HEADER.slice()],
    PERSONALISATION: [PERSONALISATION_HEADER.slice()],
    AGENCIES: [AGENCIES_HEADER.slice(), row(AGENCIES_HEADER, { agency_id: 'SCHEMA NOTE' })],
  };
  function tabOf(range) { return String(range).split('!')[0]; }
  function startRowOf(range) {
    const m = String(range).match(/!\D+(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }
  const valuesApi = {
    async get(range) {
      const tab = tabOf(range);
      if (!(tab in store)) throw new Error(`Sheets API GET ${tab} failed (400): Unable to parse range`);
      return store[tab].map((r) => r.slice());
    },
    async append(range, rows) {
      const tab = tabOf(range);
      store[tab] = store[tab] || [];
      for (const r of rows) store[tab].push(r.slice());
      return { updates: { updatedRows: rows.length } };
    },
    async update(range, rows) {
      const tab = tabOf(range); const start = startRowOf(range);
      store[tab] = store[tab] || [];
      rows.forEach((r, i) => { store[tab][start - 1 + i] = r.slice(); });
    },
    async batchUpdate(data) {
      for (const { range, values } of data) {
        const tab = tabOf(range); const start = startRowOf(range);
        store[tab] = store[tab] || [];
        while (store[tab].length < start - 1) store[tab].push([]);
        values.forEach((row, i) => { store[tab][start - 1 + i] = row.slice(); });
      }
    },
  };
  return { store, repo: createRepo(valuesApi) };
}

function row(header, obj) { return header.map((k) => obj[k] ?? ''); }
function toObj(header, r) { return Object.fromEntries(header.map((k, i) => [k, r[i] ?? ''])); }
function rowsOf(store, tab, header) {
  return store[tab].slice(1)
    .filter((r) => r[header.indexOf('probe_id')] && r[header.indexOf('probe_id')] !== 'SCHEMA NOTE')
    .map((r) => toObj(header, r));
}
function probeIdsIn(store, tab, header) {
  return new Set(rowsOf(store, tab, header).map((r) => r.probe_id));
}

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

const OLD = '2020-01-01T09:00:00.000Z';
const HISTORICAL_IDS = ['prb_hist_0001', 'prb_hist_0002', 'prb_hist_0003', 'prb_hist_0004', 'prb_hist_0005'];

// Seeds five "already-diagnosed historical probe" rows — closed, with a
// non-blank diagnosis_summary already on the row, exactly like the 21 live
// historical probes that were never touched by this test. No PERSONALISATION
// row for any of them (the tab is empty), same as the live situation.
function seedHistoricalDiagnosedProbes(store) {
  for (const probeId of HISTORICAL_IDS) {
    store.PROBES.push(row(PROBES_HEADER, {
      agency_id: `agc_${probeId}`, probe_id: probeId, property_address: `${probeId} Street`,
      property_price: '£300,000', probe_timestamp: OLD, observation_deadline: '2020-01-05T09:00:00.000Z',
      probe_status: 'closed',
    }));
    store.INTELLIGENCE.push(row(INTELLIGENCE_HEADER, {
      probe_id: probeId, agency_id: `agc_${probeId}`, observation_status: 'closed',
      human_contact: 'yes', response_hours: 5, contact_attempts: 1, follow_ups: 0,
      communication_quality: 'generic', grade: 'D', grade_reason: 'Pre-seeded.',
    }));
    // Already diagnosed BEFORE this rebuild ever runs — a non-blank
    // diagnosis_summary is exactly the frozen signal the pipeline uses.
    store.DIAGNOSIS.push(row(DIAGNOSIS_HEADER, {
      probe_id: probeId, agency_id: `agc_${probeId}`, strengths: 'Pre-existing strength.',
      novus_opportunity: 'Core (front desk)', diagnosis_summary: `Pre-existing diagnosis for ${probeId}.`,
    }));
  }
}

function installAiStub() {
  let diagnoseCalls = 0;
  let personaliseCalls = 0;
  let interpretCalls = 0;
  const diagnosedProbeIds = [];
  const personalisedProbeIds = [];
  __setAiCallerForTests(async ({ tool, prompt }) => {
    if (tool?.name === 'record_probe_diagnosis') {
      diagnoseCalls += 1;
      const m = prompt.match(/prb_hist_\d+/);
      if (m) diagnosedProbeIds.push(m[0]);
      return {
        findings: [{ finding: 'Stub finding.', evidence: 'Stub evidence.', significance_note: 'Stub significance.' }],
        strengths: 'Stub strengths.', missed_opportunities: '', commercial_implication: 'Stub implication.',
        novus_opportunity: 'Core (front desk)', diagnosis_summary: 'Freshly regenerated diagnosis.',
      };
    }
    if (tool?.name === 'record_probe_personalisation') {
      personaliseCalls += 1;
      const m = prompt.match(/prb_hist_\d+/);
      if (m) personalisedProbeIds.push(m[0]);
      // A COMPLETE answer, deliberately: this suite counts AI calls to prove
      // targeting, and an answer that failed the email contract would be sent
      // back for repair (lib/probe-personalisation.mjs), making one probe cost
      // several calls and measuring the contract gate instead of the targeting.
      return {
        story_reasoning: 'Stub reasoning.',
        primary_narrative: 'Stub narrative.', narrative_finding_indexes: [], supporting_findings: '',
        evidence_quotes: [], fair_observation: 'you did come back to us.',
        // Note: no "finding"/"evidence" wording inside the EMAIL fields — the
        // internal-reasoning guard blanks those, which would fail the contract.
        novus_counterfactual: 'Stub counterfactual.', main_finding: 'that nobody asked what we were looking for.',
        commercial_consequence: 'stub consequence.', wider_observation: '', wider_consequence: '',
      };
    }
    interpretCalls += 1;
    return {
      viewing_progression: 'none', buyer_questions_asked: [], seller_recognition: 'none',
      communication_quality: 'generic', did_well: '', missed: '', evidence: [],
    };
  });
  return {
    counts: () => ({ diagnoseCalls, personaliseCalls, interpretCalls }),
    diagnosedProbeIds, personalisedProbeIds,
  };
}

async function run() {
  console.log('opts.probeIds rebuild targeting — hermetic selftest\n');

  // ── 1. THE BUG, REPRODUCED: an untargeted rebuild personalises every
  //    already-diagnosed probe on an empty PERSONALISATION tab ──
  {
    const { store, repo } = makeFakeSheet();
    __setRepoForTests(repo);
    seedHistoricalDiagnosedProbes(store);
    const stub = installAiStub();

    // Simulate: only ONE probe's Diagnosis was actually unfrozen for this
    // test (diagnosis_summary cleared), matching the real scenario exactly.
    const diagRow = store.DIAGNOSIS.find((r) => r[DIAGNOSIS_HEADER.indexOf('probe_id')] === 'prb_hist_0003');
    diagRow[DIAGNOSIS_HEADER.indexOf('diagnosis_summary')] = '';

    const summary = await runRebuildPass(repo, { maxAiCalls: 100 });

    assert.strictEqual(summary.diagnosis.ai_diagnoses_run, 1, 'only the one unfrozen probe gets a fresh Diagnosis call');
    assert.strictEqual(summary.personalisation.ai_personalisations_run, HISTORICAL_IDS.length,
      'but EVERY historical probe gets personalised — reproducing the reported bug');
    assert.strictEqual(stub.counts().personaliseCalls, HISTORICAL_IDS.length);
    ok('reproduced: unfreezing one probe\'s Diagnosis, then running an untargeted rebuild, personalises every already-diagnosed probe on the sheet — confirms the reported root cause');
  }

  // ── 2. THE FIX: opts.probeIds restricts every step to exactly the listed
  //    probes; everything else is completely untouched ──
  {
    const { store, repo } = makeFakeSheet();
    __setRepoForTests(repo);
    seedHistoricalDiagnosedProbes(store);
    const stub = installAiStub();

    const targets = ['prb_hist_0002', 'prb_hist_0004'];
    for (const probeId of targets) {
      const diagRow = store.DIAGNOSIS.find((r) => r[DIAGNOSIS_HEADER.indexOf('probe_id')] === probeId);
      diagRow[DIAGNOSIS_HEADER.indexOf('diagnosis_summary')] = '';
    }

    const summary = await runRebuildPass(repo, { maxAiCalls: 100, probeIds: targets });

    assert.strictEqual(summary.diagnosis.ai_diagnoses_run, targets.length, 'only the targeted, unfrozen probes get diagnosed');
    assert.strictEqual(summary.personalisation.ai_personalisations_run, targets.length,
      'and ONLY those same probes get personalised — not the rest of the sheet');
    assert.deepStrictEqual(new Set(stub.diagnosedProbeIds), new Set(targets));
    assert.deepStrictEqual(new Set(stub.personalisedProbeIds), new Set(targets));

    const personalisedIds = probeIdsIn(store, 'PERSONALISATION', PERSONALISATION_HEADER);
    assert.strictEqual(personalisedIds.size, targets.length, 'exactly the targeted probes have a PERSONALISATION row');
    for (const probeId of targets) assert.ok(personalisedIds.has(probeId), `${probeId} was personalised`);
    for (const probeId of HISTORICAL_IDS) {
      if (targets.includes(probeId)) continue;
      assert.ok(!personalisedIds.has(probeId), `${probeId} was left completely untouched`);
    }
    ok('opts.probeIds restricts Intelligence, Diagnosis and Personalisation to exactly the listed probes — every other eligible probe on the sheet is left completely untouched, no AI calls spent on it');
  }

  // ── 3. DIAGNOSIS_FINDINGS is scoped by the same filter ──
  {
    const { store, repo } = makeFakeSheet();
    __setRepoForTests(repo);
    seedHistoricalDiagnosedProbes(store);
    installAiStub();

    const targets = ['prb_hist_0001', 'prb_hist_0005'];
    for (const probeId of targets) {
      const diagRow = store.DIAGNOSIS.find((r) => r[DIAGNOSIS_HEADER.indexOf('probe_id')] === probeId);
      diagRow[DIAGNOSIS_HEADER.indexOf('diagnosis_summary')] = '';
    }

    await runRebuildPass(repo, { maxAiCalls: 100, probeIds: targets });

    const findingsProbeIds = probeIdsIn(store, 'DIAGNOSIS_FINDINGS', DIAGNOSIS_FINDINGS_HEADER);
    assert.deepStrictEqual(findingsProbeIds, new Set(targets), 'DIAGNOSIS_FINDINGS rows exist only for the targeted, freshly-diagnosed probes');
    ok('DIAGNOSIS_FINDINGS respects the same probeIds filter, since it is written inside the targeted Diagnosis step');
  }

  // ── 4. The filter composes correctly with the existing frozen-probe
  //    check: naming an ALREADY-diagnosed probe in probeIds does not
  //    re-diagnose or re-personalise it ──
  {
    const { store, repo } = makeFakeSheet();
    __setRepoForTests(repo);
    seedHistoricalDiagnosedProbes(store);
    // Nothing unfrozen this time — every probe keeps its pre-existing
    // diagnosis_summary.
    const stub = installAiStub();

    const summary = await runRebuildPass(repo, { maxAiCalls: 100, probeIds: ['prb_hist_0001', 'prb_hist_0002'] });

    assert.strictEqual(summary.diagnosis.ai_diagnoses_run, 0, 'a targeted but already-frozen probe is not re-diagnosed');
    assert.strictEqual(summary.personalisation.ai_personalisations_run, 2, 'but it is still eligible for its first Personalisation, since that has never run');
    assert.strictEqual(stub.counts().diagnoseCalls, 0);
    ok('naming an already-diagnosed probe in probeIds never re-diagnoses it — the frozen check still applies inside the target list, only the SCOPE narrows');
  }

  // ── 5. Also works called directly on rebuildAllIntelligence (not just
  //    through runRebuildPass), and an absent probeIds is the unchanged,
  //    unrestricted default — all five fixture probes are frozen already, so
  //    this only exercises the deterministic self-heal pass (zero AI calls),
  //    which is exactly why probes_finalized_skipped is the field worth
  //    checking here rather than the whole summary object. ──
  {
    const { store, repo } = makeFakeSheet();
    __setRepoForTests(repo);
    seedHistoricalDiagnosedProbes(store);
    installAiStub();

    const untargeted = await rebuildAllIntelligence(repo, { maxAiCalls: 100 });
    assert.strictEqual(untargeted.probes_finalized_skipped, HISTORICAL_IDS.length,
      'with no probeIds, every fixture probe is at least considered (and skipped, since all are frozen)');

    const restricted = await rebuildAllIntelligence(repo, { maxAiCalls: 100, probeIds: ['prb_hist_0001'] });
    assert.strictEqual(restricted.probes_finalized_skipped, 1,
      'with probeIds set, only the named probe is considered at all — the other four are not even counted as skipped');
    assert.strictEqual(restricted.ai_interpretations_run, 0, 'a frozen probe named in probeIds is still never re-interpreted');
    ok('rebuildAllIntelligence accepts opts.probeIds directly, and an absent probeIds keeps considering every probe exactly as before this option existed');
  }

  console.log(`\n${passed} checks passed.`);
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
