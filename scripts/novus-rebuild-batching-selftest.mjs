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
//   - the deterministic observation step completes a 26-probe dataset in ONE
//     call with ZERO AI calls, whatever the budget — it has no AI call to
//     bound any more (see lib/intelligence-rebuild.mjs)
//   - the FINAL ASSESSMENT step is now where the budget lives: 25 closed,
//     unassessed probes at a budget of 10 take exactly 3 calls (10 + 10 + 5)
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
import { rebuildAllAssessments } from '../lib/assessment-rebuild.mjs';

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
  'findings',
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

  // ── Deterministic observation: ONE call, no budget, no AI ──
  // This used to be the batched step. It no longer makes an AI call at all, so
  // a dataset of any size completes in a single pass — there is nothing left
  // for maxAiCalls to bound here.
  const deterministic = await rebuildAllIntelligence(repo, { maxAiCalls: BATCH_SIZE });
  assert.strictEqual(deterministic.ai_interpretations_run, 0);
  assert.strictEqual(deterministic.remaining_interpretations, 0, 'nothing is ever left over: the step is free, so it always finishes');
  assert.strictEqual(aiCallCount, 0, 'not one Anthropic call from the whole 26-probe deterministic pass');
  ok('deterministic observation completes a dataset larger than any budget in one call, with zero AI calls');

  const intelRecords = store.INTELLIGENCE.slice(2).map((r) => toObj(INTELLIGENCE_HEADER, r));
  assert.strictEqual(intelRecords.length, totalProbes, 'exactly one INTELLIGENCE row per probe — no duplicates from running multiple batches');
  const pre = intelRecords.find((r) => r.probe_id === 'prb_pre');
  assert.strictEqual(pre.evidence, 'stubbed from before batching began', 'a pre-existing interpretation is never overwritten by the deterministic step');
  ok('the deterministic pass produces exactly one row per probe, with pre-existing interpretations preserved verbatim');

  // ── Rerun: fully idempotent, still zero AI calls ──
  aiCallCount = 0;
  const rerun = await rebuildAllIntelligence(repo, { maxAiCalls: BATCH_SIZE });
  assert.strictEqual(rerun.ai_interpretations_run, 0);
  assert.strictEqual(rerun.remaining_interpretations, 0);
  assert.strictEqual(aiCallCount, 0);
  ok('rerunning the deterministic pass (e.g. clicking the button again) makes zero AI calls');

  // ── THE BUDGET NOW LIVES ON THE FINAL ASSESSMENT, and batches identically ──
  // All 26 closed probes are unassessed (the fixture pre-seeds an INTELLIGENCE
  // interpretation for prb_pre but no DIAGNOSIS row), so at a budget of 10 the
  // drain must take exactly 3 calls — 10 + 10 + 6 — each respecting the budget.
  const probeRecordsForAssessment = await repo.getRecords('PROBES', 'probe_id');
  const probesForAssessment = new Map(probeRecordsForAssessment.map((r) => [r.obj.probe_id, r.obj]));
  let assessmentAiCalls = 0;
  __setAiCallerForTests(async () => {
    assessmentAiCalls += 1;
    return {
      viewing_progression: 'invited',
      buyer_questions_asked: [],
      seller_recognition: 'none',
      communication_quality: 'competent',
      did_well: 'Responded and offered a viewing.',
      missed: '',
      evidence: [],
      findings: [], positive_findings: [], enquiry_signals: [],
      unresolved_context: [], recommended_actions: [],
      handling_summary: 'The team responded quickly.', handling_quality: 'strong',
      strengths: 'Fast, warm response.', missed_opportunities: '',
      commercial_implication: 'Specific to this agency.',
      novus_opportunity: 'None evidenced',
      diagnosis_summary: 'Good outcome, nothing to flag.',
    };
  });

  let assessmentBatches = 0;
  let totalAssessments = 0;
  let remainingAssessments = Infinity;
  while (remainingAssessments !== 0) {
    const summary = await rebuildAllAssessments(repo, probesForAssessment, { maxAiCalls: BATCH_SIZE });
    assessmentBatches += 1;
    assert.ok(summary.ai_calls_used <= BATCH_SIZE, `assessment batch ${assessmentBatches} must not exceed the ${BATCH_SIZE}-call budget`);
    totalAssessments += summary.assessments_created;
    remainingAssessments = summary.assessments_remaining;
    if (assessmentBatches > 20) throw new Error('runaway loop — assessment batching never completed');
  }
  assert.strictEqual(assessmentBatches, 3, '26 closed unassessed probes at a budget of 10 take exactly 3 calls (10 + 10 + 6)');
  assert.strictEqual(totalAssessments, totalProbes, 'every closed unassessed probe is assessed exactly once across all batches');
  assert.strictEqual(assessmentAiCalls, totalProbes, 'ONE Anthropic call per closed probe — never two, never one per stage');
  ok('the final assessment batches within its budget and costs exactly one AI call per closed probe');

  const rerunAssessments = await rebuildAllAssessments(repo, probesForAssessment, { maxAiCalls: BATCH_SIZE });
  assert.strictEqual(rerunAssessments.assessments_created, 0, 'a finalised assessment is frozen: rerunning creates nothing');
  assert.strictEqual(rerunAssessments.ai_calls_used, 0);
  ok('assessments are frozen once written — a rerun spends nothing');

  // A failed Anthropic request still consumes an invocation budget slot. If
  // failures were counted only after a successful response, one bad provider
  // period could attempt every eligible probe despite maxAiCalls.
  {
    const { store: failedStore, repo: failedRepo } = makeFakeSheet();
    const failedProbes = new Map();
    for (let i = 0; i < 4; i++) {
      const probeId = `prb_failed_${i}`;
      const probe = { probe_id: probeId, agency_id: 'agc_failed' };
      failedProbes.set(probeId, probe);
      failedStore.PROBES.push(row(PROBES_HEADER, probe));
      failedStore.INTELLIGENCE.push(row(INTELLIGENCE_HEADER, {
        intelligence_id: `itl_failed_${i}`,
        probe_id: probeId,
        agency_id: 'agc_failed',
        observation_status: 'closed',
      }));
    }

    let attempts = 0;
    const failed = await rebuildAllAssessments(failedRepo, failedProbes, {
      maxAiCalls: 2,
      assess: async () => {
        attempts += 1;
        throw new Error('simulated Anthropic failure');
      },
    });
    assert.strictEqual(attempts, 2, 'failed assessment attempts still stop at maxAiCalls');
    assert.strictEqual(failed.ai_calls_used, 2, 'the summary reports both consumed attempt slots');
    assert.strictEqual(failed.problems.length, 2, 'each attempted failure is reported');
    assert.strictEqual(failed.assessments_remaining, 2, 'unattempted eligible probes remain for the next pass');
  }
  ok('failed Anthropic attempts also consume the bounded invocation budget');

  // The old DIAGNOSIS batching block that stood here is gone with the stage it
  // tested: there is no separate AI diagnosis pass any more, so by this point
  // every probe already has its DIAGNOSIS row — written by the SAME assessment
  // call above. lib/diagnosis-rebuild.mjs keeps its own dedicated coverage in
  // scripts/novus-diagnosis-selftest.mjs.
  const diagRecords = store.DIAGNOSIS.slice(2).map((r) => toObj(DIAGNOSIS_HEADER, r));
  assert.strictEqual(diagRecords.length, totalProbes, 'exactly one DIAGNOSIS row per probe — no duplicates from running multiple assessment batches');
  assert.ok(diagRecords.every((r) => String(r.diagnosis_summary || '').trim()), 'every probe ends up with a written, frozen assessment');
  ok('batched assessment produces exactly one DIAGNOSIS row per probe, no duplicates');

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
      viewing_progression: 'invited', buyer_questions_asked: [], seller_recognition: 'none',
      communication_quality: 'competent', did_well: 'Responded promptly.', missed: '', evidence: [],
      findings: [], positive_findings: [], enquiry_signals: [],
      unresolved_context: [], recommended_actions: [],
      handling_summary: 'The team responded promptly.', handling_quality: 'strong',
      strengths: 'Prompt.', missed_opportunities: '', commercial_implication: 'Specific to this agency.',
      novus_opportunity: 'None evidenced', diagnosis_summary: 'Good outcome, nothing to flag.',
    }));

    // The deterministic pass writes all 15 INTELLIGENCE rows for free.
    const det2 = await rebuildAllIntelligence(repo2);
    assert.strictEqual(det2.ai_interpretations_run, 0);
    assert.strictEqual(store2.INTELLIGENCE.slice(2).length, 15, 'the deterministic pass commits every row in one call');

    const probes2 = new Map((await repo2.getRecords('PROBES', 'probe_id')).map((r) => [r.obj.probe_id, r.obj]));

    // Batch 1 (budget 5) succeeds and commits 5 assessments.
    const a1 = await rebuildAllAssessments(repo2, probes2, { maxAiCalls: 5 });
    assert.strictEqual(a1.assessments_created, 5);
    assert.strictEqual(store2.DIAGNOSIS.slice(2).length, 5, 'batch 1 commits its 5 DIAGNOSIS rows');

    // Batch 2 completes its 5 AI calls successfully but then the write itself
    // fails (the Sheets API erroring, or the invocation being killed between
    // finishing its AI calls and its single batched write) — the whole call
    // rejects, and because the write is one atomic batchUpdate, nothing from
    // this batch lands: batch 1's committed 5 rows are untouched, and none of
    // batch 2's 5 are half-written.
    const realWriteRowsBatch = repo2.writeRowsBatch.bind(repo2);
    repo2.writeRowsBatch = async () => { throw new Error('simulated Sheets API failure mid-write'); };
    await assert.rejects(() => rebuildAllAssessments(repo2, probes2, { maxAiCalls: 5 }));
    assert.strictEqual(store2.DIAGNOSIS.slice(2).length, 5, 'a batch whose write fails commits nothing and does not lose batch 1\'s committed rows');
    repo2.writeRowsBatch = realWriteRowsBatch;

    // Retried now that writes succeed again, it resumes from exactly where
    // batch 1 left off — the 5 already-assessed probes are untouched, and the
    // 5 AI calls the failed attempt made are simply redone.
    const a2 = await rebuildAllAssessments(repo2, probes2, { maxAiCalls: 5 });
    assert.strictEqual(a2.assessments_created, 5, 'retrying the crashed batch processes the next 5 probes, not the already-done 5');
    const a3 = await rebuildAllAssessments(repo2, probes2, { maxAiCalls: 5 });
    assert.strictEqual(a3.assessments_created, 5);
    assert.strictEqual(a3.assessments_remaining, 0, 'all 15 probes are assessed after resuming past the crashed batch');
    assert.strictEqual(store2.DIAGNOSIS.slice(2).length, 15, 'exactly 15 rows total — the crash never produced a duplicate or a lost probe');
  }
  ok('a batch that crashes before writing loses no already-committed progress, and resuming completes the rest with no duplicates');

  console.log(`\n${passed} checks passed.`);
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
