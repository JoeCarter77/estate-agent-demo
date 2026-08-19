// scripts/novus-rebuild-batching-selftest.mjs — hermetic test (no network,
// no creds) proving the AI-call batching added to lib/intelligence-rebuild.mjs
// and lib/diagnosis-rebuild.mjs (maxAiCalls) can rebuild a dataset LARGER
// than a single bounded call/invocation, across several calls, exactly like
// api/novus/intelligence/rebuild-all.js now drives it in production
// (batch_size per request; google-apps-script/RebuildIntelligence.gs loops
// the endpoint until `complete: true`).
//
// This is what actually fixes the 504 FUNCTION_INVOCATION_TIMEOUT: a single
// call no longer has to await an AI call for every probe in the sheet, only
// up to maxAiCalls of them, so a historical dataset of any size can be
// rebuilt as a sequence of bounded requests instead of one unbounded one.
//
// Checks:
//   - a dataset of 25 never-interpreted probes, rebuilt in batches of 10,
//     takes exactly 3 calls (10 + 10 + 5) to reach remaining_interpretations: 0
//   - every batch call only ever runs <= the budget's worth of AI calls
//   - after all batches, every probe has exactly one INTELLIGENCE row (no
//     duplicates) and every row is fully AI-interpreted
//   - the identical pattern holds for DIAGNOSIS off the resulting closed
//     INTELLIGENCE rows
//   - a probe already interpreted/diagnosed before batching started is
//     never re-sent to the AI and its stored fields are never overwritten
//     (manual/prior work survives batching)
//   - once complete, further calls (simulating a rerun / the button clicked
//     again) make zero further AI calls and change nothing
//   - a batch that fails outright (thrown before its write) loses no
//     already-committed progress from earlier batches — rerunning it alone
//     completes the dataset
//
// Run: node scripts/novus-rebuild-batching-selftest.mjs

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';
import { rebuildAllIntelligence } from '../lib/intelligence-rebuild.mjs';
import { rebuildAllDiagnosis } from '../lib/diagnosis-rebuild.mjs';

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
const INTELLIGENCE_HEADER = [
  'intelligence_id', 'agency_id', 'probe_id', 'observation_status', 'observation_deadline',
  'observation_closed_at', 'human_contact', 'response_hours', 'first_human_response_at',
  'contact_attempts', 'follow_ups', 'channels_used',
  'viewing_progression', 'buyer_qualification', 'buyer_questions_asked', 'seller_recognition',
  'communication_quality', 'did_well', 'missed', 'evidence',
  'grade', 'grade_reason', 'created_at', 'updated_at',
];
const DIAGNOSIS_HEADER = [
  'diagnosis_id', 'agency_id', 'probe_id',
  'primary_problem', 'primary_evidence', 'secondary_problem', 'secondary_evidence',
  'strengths', 'missed_opportunities', 'commercial_implication', 'novus_opportunity',
  'diagnosis_summary', 'created_at', 'updated_at',
];

function makeFakeSheet() {
  const store = {
    PROBES: [PROBES_HEADER.slice(), ['SCHEMA NOTE', 'Fixture']],
    COMMUNICATIONS: [COMMUNICATIONS_HEADER.slice(), ['SCHEMA NOTE', 'Fixture']],
    INTELLIGENCE: [INTELLIGENCE_HEADER.slice(), ['SCHEMA NOTE', 'Fixture']],
    DIAGNOSIS: [DIAGNOSIS_HEADER.slice(), ['SCHEMA NOTE', 'Fixture']],
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

const PROBE_COUNT = 25;
const BATCH_SIZE = 10;
// Far enough in the past that resolveObservationDeadline()'s 4-day window
// has always closed, regardless of when this test runs.
const OLD_TIMESTAMP = '2020-01-01T09:00:00.000Z';

async function run() {
  console.log('AI-call batching across multiple bounded rebuild-all calls — hermetic selftest\n');

  const { store, repo } = makeFakeSheet();
  __setRepoForTests(repo);

  for (let i = 0; i < PROBE_COUNT; i++) {
    const probeId = `prb_${String(i).padStart(3, '0')}`;
    store.PROBES.push(row(PROBES_HEADER, {
      probe_id: probeId, probe_reference: `RM-${i}`, agency_id: 'agc_bulk',
      property_address: `${i} Batch Street`, property_price: '£300,000',
      enquiry_text: 'Interested in viewing this property.',
      probe_timestamp: OLD_TIMESTAMP,
    }));
    store.COMMUNICATIONS.push(row(COMMUNICATIONS_HEADER, {
      communication_id: `com_${i}`, agency_id: 'agc_bulk', probe_id: probeId,
      occurred_at: '2020-01-01T09:30:00.000Z', channel: 'email',
      body_text: 'Happy to show you round, when suits?', match_status: 'matched',
    }));
  }

  // One probe already interpreted before batching started — must survive
  // untouched, and must never cost an AI call during the batched rebuild.
  store.PROBES.push(row(PROBES_HEADER, {
    probe_id: 'prb_pre', probe_reference: 'RM-PRE', agency_id: 'agc_bulk',
    property_address: 'Pre-interpreted House', property_price: '£400,000',
    enquiry_text: 'Interested.', probe_timestamp: OLD_TIMESTAMP,
  }));
  store.INTELLIGENCE.push(row(INTELLIGENCE_HEADER, {
    intelligence_id: 'itl_pre', agency_id: 'agc_bulk', probe_id: 'prb_pre',
    communication_quality: 'generic', evidence: 'stubbed from before batching began',
    created_at: '2019-01-01T00:00:00.000Z',
  }));

  const totalProbes = PROBE_COUNT + 1; // + prb_pre

  let aiCallCount = 0;
  __setAiCallerForTests(async () => {
    aiCallCount += 1;
    return {
      viewing_progression: 'invited',
      buyer_qualification: 'minimal',
      buyer_questions_asked: [{ topic: 'availability', quote: 'when suits?', communication_id: 'com_0' }],
      seller_recognition: 'none',
      communication_quality: 'competent',
      did_well: 'Responded and offered a viewing.',
      missed: '',
      evidence: [{ quote: 'when suits?', communication_id: 'com_0' }],
    };
  });

  // ── Drive intelligence rebuild in bounded batches, exactly like
  // repeated calls to POST /api/novus/intelligence/rebuild-all would ──
  let batchCalls = 0;
  let totalInterpretationsRun = 0;
  let remaining = Infinity;
  while (remaining !== 0) {
    const summary = await rebuildAllIntelligence(repo, { maxAiCalls: BATCH_SIZE });
    batchCalls += 1;
    assert.ok(summary.ai_interpretations_run <= BATCH_SIZE, `batch ${batchCalls} must not exceed the ${BATCH_SIZE}-call budget`);
    totalInterpretationsRun += summary.ai_interpretations_run;
    remaining = summary.remaining_interpretations;
    if (batchCalls > 20) throw new Error('runaway loop — batching never completed');
  }
  assert.strictEqual(batchCalls, 3, '25 never-interpreted probes at a budget of 10 takes exactly 3 calls (10 + 10 + 5)');
  assert.strictEqual(totalInterpretationsRun, PROBE_COUNT, 'every never-interpreted probe gets exactly one AI interpretation across all batches');
  assert.strictEqual(aiCallCount, PROBE_COUNT, 'prb_pre never triggers an AI call across the whole batched run');
  ok('a dataset larger than one bounded call completes in the expected number of budget-sized calls, each respecting the budget');

  const intelRecords = store.INTELLIGENCE.slice(2).map((r) => toObj(INTELLIGENCE_HEADER, r));
  assert.strictEqual(intelRecords.length, totalProbes, 'exactly one INTELLIGENCE row per probe — no duplicates from running multiple batches');
  assert.ok(intelRecords.every((r) => String(r.communication_quality || '').trim()), 'every probe ends up fully AI-interpreted once batching completes');
  const pre = intelRecords.find((r) => r.probe_id === 'prb_pre');
  assert.strictEqual(pre.evidence, 'stubbed from before batching began', 'a probe already interpreted before batching started is never overwritten by a later batch');
  ok('batching produces exactly one row per probe, with pre-existing interpretations preserved verbatim');

  // ── Rerun after completion: fully idempotent, zero further AI calls ──
  aiCallCount = 0;
  const rerun = await rebuildAllIntelligence(repo, { maxAiCalls: BATCH_SIZE });
  assert.strictEqual(rerun.ai_interpretations_run, 0);
  assert.strictEqual(rerun.remaining_interpretations, 0);
  assert.strictEqual(aiCallCount, 0);
  ok('rerunning the batched rebuild (e.g. clicking the button again) after completion makes zero further AI calls');

  // ── Diagnosis: same batching pattern off the now-closed INTELLIGENCE rows ──
  const probeRecords = await repo.getRecords('PROBES', 'probe_id');
  const probesById = new Map(probeRecords.map((r) => [r.obj.probe_id, r.obj]));

  let diagnosisAiCallCount = 0;
  __setAiCallerForTests(async () => {
    diagnosisAiCallCount += 1;
    return {
      primary_problem: '', primary_evidence: '', secondary_problem: '', secondary_evidence: '',
      strengths: 'Fast, warm response.', missed_opportunities: '',
      commercial_implication: 'Specific to this agency.', novus_opportunity: 'None evidenced',
      diagnosis_summary: 'Good outcome, nothing to flag.',
    };
  });

  let diagBatchCalls = 0;
  let totalDiagnosesRun = 0;
  let remainingDiag = Infinity;
  while (remainingDiag !== 0) {
    const summary = await rebuildAllDiagnosis(repo, probesById, { maxAiCalls: BATCH_SIZE });
    diagBatchCalls += 1;
    assert.ok(summary.ai_diagnoses_run <= BATCH_SIZE, `diagnosis batch ${diagBatchCalls} must not exceed the ${BATCH_SIZE}-call budget`);
    totalDiagnosesRun += summary.ai_diagnoses_run;
    remainingDiag = summary.remaining_diagnoses;
    if (diagBatchCalls > 20) throw new Error('runaway loop — diagnosis batching never completed');
  }
  assert.strictEqual(totalDiagnosesRun, totalProbes, 'every closed probe (including prb_pre, once its INTELLIGENCE closed) gets exactly one diagnosis across all batches');

  const diagRecords = store.DIAGNOSIS.slice(2).map((r) => toObj(DIAGNOSIS_HEADER, r));
  assert.strictEqual(diagRecords.length, totalProbes, 'exactly one DIAGNOSIS row per probe — no duplicates from running multiple batches');
  ok('DIAGNOSIS batches the same way and produces exactly one row per eligible probe, no duplicates');

  diagnosisAiCallCount = 0;
  const diagRerun = await rebuildAllDiagnosis(repo, probesById, { maxAiCalls: BATCH_SIZE });
  assert.strictEqual(diagRerun.ai_diagnoses_run, 0);
  assert.strictEqual(diagRerun.remaining_diagnoses, 0);
  assert.strictEqual(diagnosisAiCallCount, 0);
  ok('rerunning the batched diagnosis rebuild after completion makes zero further AI calls');

  // ── A batch that fails outright before it can write loses no progress
  // already committed by earlier batches ──
  {
    const { store: store2, repo: repo2 } = makeFakeSheet();
    __setRepoForTests(repo2);
    for (let i = 0; i < 15; i++) {
      const probeId = `prb2_${i}`;
      store2.PROBES.push(row(PROBES_HEADER, {
        probe_id: probeId, probe_reference: `RM2-${i}`, agency_id: 'agc_fail',
        property_address: `${i} Fail Street`, property_price: '£250,000',
        enquiry_text: 'Interested.', probe_timestamp: OLD_TIMESTAMP,
      }));
      store2.COMMUNICATIONS.push(row(COMMUNICATIONS_HEADER, {
        communication_id: `com2_${i}`, agency_id: 'agc_fail', probe_id: probeId,
        occurred_at: '2020-01-01T09:30:00.000Z', channel: 'email',
        body_text: 'Happy to show you round.', match_status: 'matched',
      }));
    }
    __setAiCallerForTests(async () => ({
      viewing_progression: 'invited', buyer_qualification: 'minimal',
      buyer_questions_asked: [], seller_recognition: 'none',
      communication_quality: 'competent', did_well: 'Responded promptly.', missed: '', evidence: [],
    }));

    // Batch 1 (budget 5) succeeds and commits 5 rows.
    const b1 = await rebuildAllIntelligence(repo2, { maxAiCalls: 5 });
    assert.strictEqual(b1.ai_interpretations_run, 5);
    assert.strictEqual(store2.INTELLIGENCE.slice(2).length, 5, 'batch 1 commits its 5 rows');

    // Batch 2 completes its 5 AI calls successfully but then the write
    // itself fails (simulating the Sheets API erroring, or the invocation
    // being killed between finishing its AI calls and its single batched
    // write) — the whole call rejects, and because the write is one atomic
    // batchUpdate, nothing from this batch lands: batch 1's already-
    // committed 5 rows are untouched, and none of batch 2's 5 are half-written.
    const realWriteRowsBatch = repo2.writeRowsBatch.bind(repo2);
    repo2.writeRowsBatch = async () => { throw new Error('simulated Sheets API failure mid-write'); };
    await assert.rejects(() => rebuildAllIntelligence(repo2, { maxAiCalls: 5 }));
    assert.strictEqual(store2.INTELLIGENCE.slice(2).length, 5, 'a batch whose write fails commits nothing and does not lose batch 1\'s committed rows');
    repo2.writeRowsBatch = realWriteRowsBatch;

    // Batch 2, retried now that writes succeed again, resumes from exactly
    // where batch 1 left off (the 5 already-interpreted probes are untouched,
    // and the 5 AI calls the failed attempt made are simply redone).
    const b2 = await rebuildAllIntelligence(repo2, { maxAiCalls: 5 });
    assert.strictEqual(b2.ai_interpretations_run, 5, 'retrying the crashed batch processes the next 5 probes, not the already-done 5');
    const b3 = await rebuildAllIntelligence(repo2, { maxAiCalls: 5 });
    assert.strictEqual(b3.ai_interpretations_run, 5);
    assert.strictEqual(b3.remaining_interpretations, 0, 'all 15 probes are done after resuming past the crashed batch');
    assert.strictEqual(store2.INTELLIGENCE.slice(2).length, 15, 'exactly 15 rows total — the crash never produced a duplicate or a lost probe');
  }
  ok('a batch that crashes before writing loses no already-committed progress, and resuming completes the rest with no duplicates');

  console.log(`\n${passed} checks passed.`);
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
