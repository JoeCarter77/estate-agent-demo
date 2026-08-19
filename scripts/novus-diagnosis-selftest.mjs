// scripts/novus-diagnosis-selftest.mjs — hermetic test (no network, no
// creds) for the full-rebuild path lib/diagnosis-rebuild.mjs (V2 schema §4/§6).
//
// Same in-memory fake-Sheets pattern as scripts/novus-rebuild-all-selftest.mjs.
// The AI half of the pipeline is stubbed; this suite checks:
//   - only CLOSED observations get diagnosed; open ones are skipped
//   - AI diagnosis runs exactly once per probe that has never been diagnosed
//     (diagnosis_summary blank) — a probe already diagnosed is left alone
//   - a second rebuild makes ZERO further AI calls
//   - a diagnosed probe is FINALISED/FROZEN: force_ai has no effect on it
//     (probe lifecycle requirement — Diagnosis is generated once, ever)
//
// Run: npm run novus:probe-diagnosis-selftest -- covers the unit; this one
// covers the batch-rebuild orchestration: npm run novus:diagnosis-selftest

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';
import { rebuildAllDiagnosis } from '../lib/diagnosis-rebuild.mjs';

const INTELLIGENCE_HEADER = [
  'intelligence_id', 'agency_id', 'probe_id', 'observation_status',
  'grade', 'grade_reason', 'human_contact', 'response_hours', 'contact_attempts', 'follow_ups',
  'channels_used', 'viewing_progression', 'buyer_qualification', 'buyer_questions_asked',
  'seller_recognition', 'communication_quality', 'did_well', 'missed', 'evidence',
  'created_at', 'updated_at',
];
const DIAGNOSIS_HEADER = [
  'diagnosis_id', 'agency_id', 'probe_id',
  'primary_problem', 'primary_evidence', 'secondary_problem', 'secondary_evidence',
  'strengths', 'missed_opportunities', 'commercial_implication', 'novus_opportunity',
  'diagnosis_summary', 'created_at', 'updated_at',
];

function makeFakeSheet() {
  const store = {
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

async function run() {
  console.log('lib/diagnosis-rebuild.mjs — hermetic selftest\n');

  const { store, repo } = makeFakeSheet();
  __setRepoForTests(repo);

  // Closed, never diagnosed.
  store.INTELLIGENCE.push(row(INTELLIGENCE_HEADER, {
    intelligence_id: 'itl_a', agency_id: 'agc_a', probe_id: 'prb_a', observation_status: 'closed',
    grade: 'F', human_contact: 'yes', response_hours: 63.6,
  }));
  // Still observing — must be skipped entirely.
  store.INTELLIGENCE.push(row(INTELLIGENCE_HEADER, {
    intelligence_id: 'itl_b', agency_id: 'agc_b', probe_id: 'prb_b', observation_status: 'observing',
    grade: 'pending', human_contact: 'none',
  }));
  // Closed, already diagnosed on a prior run.
  store.INTELLIGENCE.push(row(INTELLIGENCE_HEADER, {
    intelligence_id: 'itl_c', agency_id: 'agc_c', probe_id: 'prb_c', observation_status: 'closed',
    grade: 'A', human_contact: 'yes', response_hours: 0.5,
  }));
  store.DIAGNOSIS.push(row(DIAGNOSIS_HEADER, {
    diagnosis_id: 'dgn_c', agency_id: 'agc_c', probe_id: 'prb_c',
    diagnosis_summary: 'Already diagnosed on a prior run.', novus_opportunity: 'None evidenced',
    created_at: '2026-08-01T00:00:00.000Z',
  }));

  let aiCallCount = 0;
  __setAiCallerForTests(async () => {
    aiCallCount += 1;
    return {
      primary_problem: '63.6 hours to first contact.', primary_evidence: '63.6h response time.',
      secondary_problem: '', secondary_evidence: '',
      strengths: '', missed_opportunities: 'Both opportunities left untaken.',
      commercial_implication: 'Specific to this agency.', novus_opportunity: 'Core (front desk)',
      diagnosis_summary: 'Slow and generic.',
    };
  });

  const probesById = new Map();
  const first = await rebuildAllDiagnosis(repo, probesById);
  assert.strictEqual(first.skipped_not_closed, 1, 'the still-observing probe is skipped');
  assert.strictEqual(first.ai_diagnoses_run, 1, 'only prb_a (closed, never diagnosed) triggers an AI call');
  assert.strictEqual(aiCallCount, 1);
  ok('only closed, never-diagnosed probes are diagnosed on a routine rebuild');

  const diagRecords = store.DIAGNOSIS.slice(2).map((r) => toObj(DIAGNOSIS_HEADER, r));
  const a = diagRecords.find((r) => r.probe_id === 'prb_a');
  const c = diagRecords.find((r) => r.probe_id === 'prb_c');
  assert.strictEqual(a.primary_problem, '63.6 hours to first contact.');
  assert.strictEqual(c.diagnosis_summary, 'Already diagnosed on a prior run.', 'prb_c keeps its prior diagnosis untouched');
  assert.strictEqual(diagRecords.find((r) => r.probe_id === 'prb_b'), undefined, 'no DIAGNOSIS row is ever created for an open observation');
  ok('a newly-diagnosed probe is written correctly and a prior diagnosis is never overwritten by a routine rebuild');

  // ── Second rebuild: zero further AI calls ──
  aiCallCount = 0;
  const second = await rebuildAllDiagnosis(repo, probesById);
  assert.strictEqual(second.ai_diagnoses_run, 0, 'a second rebuild makes no further AI calls');
  assert.strictEqual(aiCallCount, 0);
  ok('a second rebuild is fully idempotent: zero AI calls');

  // ── Diagnosis is finalised/frozen: opts.forceAi has no effect on a probe
  // that already has a diagnosis_summary, unlike INTELLIGENCE's forceAi
  // (probe lifecycle requirement — a Diagnosis is generated exactly once and
  // never regenerated, forced or not). Both prb_a and prb_c are diagnosed by
  // this point.
  const forced = await rebuildAllDiagnosis(repo, probesById, { forceAi: true });
  assert.strictEqual(forced.ai_diagnoses_run, 0, 'forceAi does not re-diagnose an already-finalised probe — Diagnosis is frozen once written');
  ok('opts.forceAi has no effect once a probe is diagnosed — Diagnosis is frozen for good');

  console.log(`\n${passed} checks passed.`);
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
