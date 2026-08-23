// scripts/novus-diagnosis-persistence-selftest.mjs — regression test for the
// bug reported after the V2 rollout: DIAGNOSIS stayed completely empty after
// Rebuild Intelligence, even though INTELLIGENCE was populating correctly.
//
// Root cause: lib/diagnosis-rebuild.mjs (and lib/intelligence-rebuild.mjs,
// and the single-probe path in lib/observation-recompute.mjs) located
// existing INTELLIGENCE/DIAGNOSIS rows by their decorative intelligence_id/
// diagnosis_id column. The live workbook's actual V2 header — the one the
// user added by hand, matching docs/V2_COMMS_INTELLIGENCE_DIAGNOSIS_SCHEMA.md's
// field list literally — carries probe_id but NOT intelligence_id/
// diagnosis_id/created_at/updated_at at all. recordsFromTable()/getRecords()
// filter out every row whose id-COLUMN they can't find in the header, so
// against that real header EVERY existing INTELLIGENCE row read back as "no
// such row exists" — which meant rebuildAllDiagnosis's main loop (`for (const
// rec of intelligenceRecords)`) never executed for a single probe, no matter
// how many closed, evidence-complete probes existed. Nothing to do with
// DIAGNOSIS being pre-populated or not — it never got as far as looking at
// DIAGNOSIS at all.
//
// The fix: match INTELLIGENCE/DIAGNOSIS rows by probe_id everywhere — the
// row's REAL identity (one row per probe_id, by construction), guaranteed to
// exist in the header, unlike the decorative *_id columns.
//
// This suite seeds the EXACT header the user's live sheet actually has (no
// intelligence_id/diagnosis_id/created_at/updated_at columns at all) with 24
// closed probes and 15 observing probes — the live numbers reported — and an
// EMPTY DIAGNOSIS tab, then proves:
//
// Dates below are relative to Date.now() at run time, not hardcoded absolute
// timestamps — an earlier version pinned them to specific 2026 dates, and
// once the wall clock passed those dates the "still observing" probes'
// observation_deadline was also in the past, so the library correctly (and
// misleadingly) started reporting them as closed too. Relative offsets keep
// this suite meaningful indefinitely.
//   1. all 24 closed probes get a DIAGNOSIS row; none of the 15 observing ones do
//   2. a second rebuild is idempotent — no duplicates, no further AI calls
//   3. the same probe_id-matching fix keeps INTELLIGENCE itself idempotent
//      under this header (a related instance of the identical bug)
//   4. the single-probe recompute path (webhooks) is idempotent under this
//      header too
//
// Run: npm run novus:diagnosis-persistence-selftest

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';
import { rebuildAllIntelligence } from '../lib/intelligence-rebuild.mjs';
import { rebuildAllDiagnosis } from '../lib/diagnosis-rebuild.mjs';
import { recomputeProbeObservation } from '../lib/observation-recompute.mjs';

const NOW_MS = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
// n days before/after "now" (this run's wall-clock time), as an ISO string.
function daysAgo(n) { return new Date(NOW_MS - n * DAY_MS).toISOString(); }
function daysFromNow(n) { return new Date(NOW_MS + n * DAY_MS).toISOString(); }

// The user's actual live-sheet header, verbatim from the exported CSVs —
// deliberately WITHOUT intelligence_id/diagnosis_id/created_at/updated_at.
const INTELLIGENCE_HEADER = [
  'probe_id', 'probe_ref', 'agency_id', 'observation_status', 'human_contact',
  'response_hours', 'first_human_response_at', 'contact_attempts', 'follow_ups',
  'channels_used', 'viewing_progression', 'buyer_qualification', 'buyer_questions_asked',
  'seller_recognition', 'communication_quality', 'did_well', 'missed', 'evidence',
  'grade', 'grade_reason',
];
const DIAGNOSIS_HEADER = [
  'probe_id', 'probe_ref', 'agency_id', 'findings', 'strengths', 'missed_opportunities',
  'commercial_implication', 'novus_opportunity', 'diagnosis_summary',
];
const PROBES_HEADER = [
  'probe_id', 'probe_reference', 'agency_id', 'portal', 'property_address', 'property_url',
  'property_price', 'property_status', 'enquiry_text', 'probe_email', 'probe_phone',
  'probe_timestamp', 'observation_deadline', 'probe_status', 'compromised', 'compromise_reason',
  'observation_closed_at', 'sent_from', 'observation_notes', 'created_at', 'updated_at',
];
const COMMUNICATIONS_HEADER = [
  'communication_id', 'agency_id', 'probe_id', 'occurred_at', 'channel', 'direction',
  'source_identifier_normalized', 'subject', 'body_text', 'transcript', 'raw_content',
  'match_status', 'automated_or_human', 'manual_override', 'created_at', 'updated_at',
];

function makeFakeSheet() {
  const store = {
    PROBES: [PROBES_HEADER.slice(), ['SCHEMA NOTE', 'Fixture']],
    COMMUNICATIONS: [COMMUNICATIONS_HEADER.slice(), ['SCHEMA NOTE', 'Fixture']],
    INTELLIGENCE: [INTELLIGENCE_HEADER.slice()], // no SCHEMA NOTE row either — matches the user's export
    DIAGNOSIS: [DIAGNOSIS_HEADER.slice()], // completely empty: header only, exactly as reported
  };
  function tabOf(range) { return String(range).split('!')[0]; }
  function startRowOf(range) {
    const m = String(range).match(/!\D+(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }
  const valuesApi = {
    async get(range) { return (store[tabOf(range)] || []).map((r) => r.slice()); },
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
        values.forEach((row, i) => { store[tab][start - 1 + i] = row.slice(); });
      }
    },
  };
  return { store, repo: createRepo(valuesApi) };
}

function row(header, obj) { return header.map((k) => obj[k] ?? ''); }
function toObj(header, r) { return Object.fromEntries(header.map((k, i) => [k, r[i]])); }

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

async function run() {
  console.log('DIAGNOSIS persistence regression (empty DIAGNOSIS tab, no *_id columns)\n');

  const { store, repo } = makeFakeSheet();
  __setRepoForTests(repo);

  __setAiCallerForTests(async ({ tool }) => {
    if (tool.name === 'record_probe_diagnosis') {
      return {
        findings: [{ finding: 'Stubbed problem.', evidence: 'Stubbed evidence.', significance_note: 'Stubbed significance.' }],
        strengths: '', missed_opportunities: 'Stubbed.', commercial_implication: 'Stubbed.',
        novus_opportunity: 'Core (front desk)', diagnosis_summary: 'Stubbed diagnosis.',
      };
    }
    return {
      viewing_progression: 'none', buyer_questions_asked: [], seller_recognition: 'none',
      communication_quality: 'generic', did_well: '', missed: 'Stubbed.', evidence: [],
    };
  });

  // 24 closed probes + 15 observing probes — the exact live numbers reported.
  const CLOSED_COUNT = 24;
  const OBSERVING_COUNT = 15;
  for (let i = 1; i <= CLOSED_COUNT; i += 1) {
    const probeId = `prb_closed_${i}`;
    store.PROBES.push(row(PROBES_HEADER, {
      probe_id: probeId, agency_id: `agc_${i}`, property_address: `${i} Closed Street`,
      probe_timestamp: daysAgo(10), observation_deadline: daysAgo(6), // well past the 4-day window: closed
    }));
    store.COMMUNICATIONS.push(row(COMMUNICATIONS_HEADER, {
      communication_id: `com_closed_${i}`, agency_id: `agc_${i}`, probe_id: probeId,
      occurred_at: daysAgo(10), channel: 'email',
      body_text: 'Thanks for your enquiry, please call us back.', match_status: 'matched',
    }));
  }
  for (let i = 1; i <= OBSERVING_COUNT; i += 1) {
    const probeId = `prb_observing_${i}`;
    store.PROBES.push(row(PROBES_HEADER, {
      probe_id: probeId, agency_id: `agc_obs_${i}`, property_address: `${i} Observing Street`,
      probe_timestamp: daysAgo(1), observation_deadline: daysFromNow(3), // window still open: observing
    }));
  }

  // Deadlines above are set relative to the real current date so the library
  // (which uses the real clock internally) puts CLOSED_COUNT probes past
  // their deadline and OBSERVING_COUNT probes still inside the window.
  const intelligenceSummary = await rebuildAllIntelligence(repo);
  assert.strictEqual(intelligenceSummary.probes_processed, CLOSED_COUNT + OBSERVING_COUNT);
  const intelRows1 = store.INTELLIGENCE.slice(1).map((r) => toObj(INTELLIGENCE_HEADER, r));
  assert.strictEqual(intelRows1.filter((r) => r.observation_status === 'closed').length, CLOSED_COUNT);
  assert.strictEqual(intelRows1.filter((r) => r.observation_status === 'observing').length, OBSERVING_COUNT);
  ok(`INTELLIGENCE rebuild against the real (no intelligence_id column) header produces exactly ${CLOSED_COUNT} closed + ${OBSERVING_COUNT} observing rows`);

  const probesById = new Map(store.PROBES.slice(2).map((r) => toObj(PROBES_HEADER, r)).map((p) => [p.probe_id, p]));
  const diagnosisSummary = await rebuildAllDiagnosis(repo, probesById);

  assert.strictEqual(diagnosisSummary.skipped_not_closed, OBSERVING_COUNT, `all ${OBSERVING_COUNT} observing probes are skipped`);
  assert.strictEqual(diagnosisSummary.diagnosis_created, CLOSED_COUNT, `all ${CLOSED_COUNT} closed probes get a NEW diagnosis row from an EMPTY DIAGNOSIS tab — the reported bug`);
  assert.strictEqual(diagnosisSummary.ai_diagnoses_run, CLOSED_COUNT);

  const diagRows1 = store.DIAGNOSIS.slice(1).map((r) => toObj(DIAGNOSIS_HEADER, r));
  assert.strictEqual(diagRows1.length, CLOSED_COUNT, `DIAGNOSIS tab actually contains ${CLOSED_COUNT} rows, not the 0 it did before the fix`);
  assert.ok(diagRows1.every((r) => r.probe_id.startsWith('prb_closed_')), 'every DIAGNOSIS row belongs to a closed probe');
  assert.ok(diagRows1.every((r) => r.diagnosis_summary === 'Stubbed diagnosis.'), 'every closed probe actually got diagnosed, not left blank');
  ok(`from a genuinely empty DIAGNOSIS tab: ${CLOSED_COUNT} closed probes -> ${CLOSED_COUNT} diagnosis rows, ${OBSERVING_COUNT} observing probes -> 0`);

  // ── Idempotency: re-run both rebuilds. No duplicates, no further AI calls. ──
  const intelligenceSummary2 = await rebuildAllIntelligence(repo);
  assert.strictEqual(intelligenceSummary2.ai_interpretations_run, 0, 'INTELLIGENCE: second rebuild makes no further AI calls');
  const intelRows2 = store.INTELLIGENCE.slice(1);
  assert.strictEqual(intelRows2.length, CLOSED_COUNT + OBSERVING_COUNT, 'INTELLIGENCE: still exactly one row per probe — no duplicates from the probe_id-keyed upsert');
  ok('INTELLIGENCE rebuild is idempotent under the real header: no duplicate rows, no repeat AI calls');

  const diagnosisSummary2 = await rebuildAllDiagnosis(repo, probesById);
  assert.strictEqual(diagnosisSummary2.ai_diagnoses_run, 0, 'DIAGNOSIS: second rebuild makes no further AI calls');
  assert.strictEqual(diagnosisSummary2.diagnosis_created, 0, 'DIAGNOSIS: second rebuild creates no new rows');
  const diagRows2 = store.DIAGNOSIS.slice(1);
  assert.strictEqual(diagRows2.length, CLOSED_COUNT, 'DIAGNOSIS: still exactly one row per closed probe — no duplicates');
  ok('DIAGNOSIS rebuild is idempotent under the real header: no duplicate rows, no repeat AI calls, updates the SAME row in place');

  // ── A probe crosses from observing to closed between rebuilds: it must
  // pick up a diagnosis on the next run, and existing rows must be untouched. ──
  const beforeCrossing = store.DIAGNOSIS.slice(1).length;
  store.PROBES = store.PROBES.map((r) => {
    if (r[0] === 'prb_observing_1') {
      const obj = toObj(PROBES_HEADER, r);
      obj.probe_timestamp = daysAgo(6);
      obj.observation_deadline = daysAgo(2); // now closed
      return row(PROBES_HEADER, obj);
    }
    return r;
  });
  await rebuildAllIntelligence(repo);
  const probesById2 = new Map(store.PROBES.slice(2).map((r) => toObj(PROBES_HEADER, r)).map((p) => [p.probe_id, p]));
  const diagnosisSummary3 = await rebuildAllDiagnosis(repo, probesById2);
  assert.strictEqual(diagnosisSummary3.diagnosis_created, 1, 'exactly the one newly-closed probe gets its first diagnosis row');
  assert.strictEqual(store.DIAGNOSIS.slice(1).length, beforeCrossing + 1, 'DIAGNOSIS grows by exactly one row, the rest untouched');
  ok('a probe that closes between rebuilds is picked up on the next run without disturbing any existing diagnosis row');

  // ── Single-probe recompute path (webhooks) is also idempotent under this header ──
  {
    const probeId = 'prb_closed_1';
    const res1 = await recomputeProbeObservation(repo, probeId);
    const res2 = await recomputeProbeObservation(repo, probeId);
    assert.strictEqual(res1.intelligence_id, res2.intelligence_id, 'same INTELLIGENCE row reused across two single-probe recomputes');
    assert.strictEqual(res1.diagnosis_id, res2.diagnosis_id, 'same DIAGNOSIS row reused across two single-probe recomputes');
    const intelForProbe = store.INTELLIGENCE.slice(1).filter((r) => r[0] === probeId);
    const diagForProbe = store.DIAGNOSIS.slice(1).filter((r) => r[0] === probeId);
    assert.strictEqual(intelForProbe.length, 1, 'exactly one INTELLIGENCE row for this probe after two single-probe recomputes');
    assert.strictEqual(diagForProbe.length, 1, 'exactly one DIAGNOSIS row for this probe after two single-probe recomputes');
    ok('the webhook-triggered single-probe recompute path is also idempotent under the real (no *_id column) header');
  }

  console.log(`\n${passed} checks passed.`);
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
