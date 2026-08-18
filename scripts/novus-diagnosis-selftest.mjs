// scripts/novus-diagnosis-selftest.mjs — hermetic test for the Diagnosis
// layer (lib/diagnosis.mjs + lib/diagnosis-rebuild.mjs), no network, no creds.
//
// Same in-memory fake-Sheets pattern as scripts/novus-rebuild-all-selftest.mjs.
//
// Run: npm run novus:diagnosis-selftest

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';

const INTELLIGENCE_HEADER = [
  'intelligence_id', 'agency_id', 'probe_id', 'observation_status', 'observation_deadline',
  'grade', 'grade_reason', 'human_lag_hours', 'follow_up_count', 'channels_used', 'days_chased',
  'created_at', 'updated_at',
];
const DIAGNOSIS_HEADER = [
  'diagnosis_id', 'agency_id', 'probe_id', 'grade', 'tier', 'primary_problem',
  'evidence_summary', 'commercial_implication', 'recommended_solution', 'sales_angle',
  'created_at', 'updated_at',
];

function makeFakeSheet() {
  const store = {
    INTELLIGENCE: [INTELLIGENCE_HEADER.slice(), ['SCHEMA NOTE', 'Derived behaviour and official decisions.']],
    DIAGNOSIS: [DIAGNOSIS_HEADER.slice(), ['SCHEMA NOTE', 'Commercial read of a closed Intelligence record.']],
  };
  const calls = { get: 0, append: 0, update: 0, batchUpdate: 0 };
  function tabOf(range) { return String(range).split('!')[0]; }
  function startRowOf(range) {
    const m = String(range).match(/!\D+(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }
  const valuesApi = {
    async get(range) {
      calls.get += 1;
      const tab = tabOf(range);
      return (store[tab] || []).map((r) => r.slice());
    },
    async append(range, rows) {
      calls.append += 1;
      const tab = tabOf(range);
      store[tab] = store[tab] || [];
      for (const r of rows) store[tab].push(r.slice());
      return { updates: { updatedRows: rows.length } };
    },
    async update(range, rows) {
      calls.update += 1;
      const tab = tabOf(range);
      const start = startRowOf(range);
      store[tab] = store[tab] || [];
      rows.forEach((r, i) => { store[tab][start - 1 + i] = r.slice(); });
      return { updatedRows: rows.length };
    },
    async batchUpdate(data) {
      calls.batchUpdate += 1;
      for (const { range, values } of data) {
        const tab = tabOf(range);
        const start = startRowOf(range);
        store[tab] = store[tab] || [];
        values.forEach((row, i) => { store[tab][start - 1 + i] = row.slice(); });
      }
      return { totalUpdatedCells: data.reduce((n, d) => n + d.values[0].length, 0) };
    },
  };
  return { store, valuesApi, calls };
}

function seedIntelligence(store, { probe_id, agency_id = 'ag_1', observation_status, grade, grade_reason = 'test reason.' }) {
  const row = INTELLIGENCE_HEADER.map((key) => {
    if (key === 'intelligence_id') return `itl_${probe_id}`;
    if (key === 'agency_id') return agency_id;
    if (key === 'probe_id') return probe_id;
    if (key === 'observation_status') return observation_status;
    if (key === 'grade') return grade;
    if (key === 'grade_reason') return grade_reason;
    if (key === 'follow_up_count') return 0;
    return '';
  });
  store.INTELLIGENCE.push(row);
}

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

async function run() {
  const { rebuildAllDiagnosis } = await import('../lib/diagnosis-rebuild.mjs');

  console.log('\nDiagnosis rebuild: mixed grade/status set');
  const { store, valuesApi, calls } = makeFakeSheet();
  __setRepoForTests(createRepo(valuesApi));
  const repo = createRepo(valuesApi);

  seedIntelligence(store, { probe_id: 'prb_open', observation_status: 'observing', grade: 'pending' });
  seedIntelligence(store, { probe_id: 'prb_closed_h', observation_status: 'closed', grade: 'H' });
  seedIntelligence(store, { probe_id: 'prb_closed_a', observation_status: 'closed', grade: 'A' });
  seedIntelligence(store, { probe_id: 'prb_closed_c', observation_status: 'closed', grade: 'C' });

  const summary1 = await rebuildAllDiagnosis(repo);

  assert.strictEqual(calls.get, 2, 'exactly one read per table (INTELLIGENCE, DIAGNOSIS)');
  assert.strictEqual(calls.update, 0, 'no legacy per-row update() calls');
  assert.strictEqual(calls.append, 0, 'no legacy per-row append() calls');
  ok('diagnosis rebuild reads each table exactly once and writes only via batchUpdate');

  assert.strictEqual(summary1.skipped_not_closed, 1, 'open observation skipped (no Diagnosis for it)');
  assert.strictEqual(summary1.diagnosis_created, 3, 'one Diagnosis created per closed observation');
  assert.strictEqual(summary1.diagnosis_updated, 0);
  ok('only closed observations get a Diagnosis');

  const rows = await repo.getRecords('DIAGNOSIS', 'diagnosis_id');
  const byProbe = Object.fromEntries(rows.map((r) => [r.obj.probe_id, r.obj]));

  assert.strictEqual(byProbe.prb_open, undefined, 'no Diagnosis row exists for the still-open probe');
  assert.strictEqual(byProbe.prb_closed_h.tier, 'Core', 'grade H routes to Core');
  assert.strictEqual(byProbe.prb_closed_a.tier, 'Growth', 'grade A routes to Growth');
  assert.strictEqual(byProbe.prb_closed_c.tier, 'Core', 'grade C routes to Core');
  assert.ok(byProbe.prb_closed_h.primary_problem.length > 0);
  assert.ok(byProbe.prb_closed_h.evidence_summary.includes('test reason.'), 'evidence_summary reuses the existing grade_reason, invents nothing new');
  assert.ok(byProbe.prb_closed_h.commercial_implication.length > 0);
  assert.ok(byProbe.prb_closed_h.recommended_solution.length > 0);
  assert.ok(byProbe.prb_closed_h.sales_angle.length > 0);
  ok('Diagnosis fields populated correctly per grade -> tier routing table');

  // ── Idempotency: rebuilding again updates in place, never duplicates ──
  const summary2 = await rebuildAllDiagnosis(repo);
  assert.strictEqual(summary2.diagnosis_created, 0, 'second run creates nothing new');
  assert.strictEqual(summary2.diagnosis_updated, 3, 'second run updates the existing 3 rows in place');
  const rowsAfter = await repo.getRecords('DIAGNOSIS', 'diagnosis_id');
  assert.strictEqual(rowsAfter.length, 3, 'still exactly 3 Diagnosis rows — no duplicates');
  ok('rebuilding Diagnosis twice is idempotent — one row per probe_id, updated not duplicated');

  // ── Grade change on re-close must update the existing Diagnosis row ──
  const idx = store.INTELLIGENCE.findIndex((r) => r[2] === 'prb_closed_c');
  store.INTELLIGENCE[idx][INTELLIGENCE_HEADER.indexOf('grade')] = 'A';
  const summary3 = await rebuildAllDiagnosis(repo);
  assert.strictEqual(summary3.diagnosis_updated, 3);
  const rowsAfter3 = await repo.getRecords('DIAGNOSIS', 'diagnosis_id');
  const updatedC = rowsAfter3.find((r) => r.obj.probe_id === 'prb_closed_c').obj;
  assert.strictEqual(updatedC.tier, 'Growth', 'Diagnosis reflects the recomputed grade after another Intelligence rebuild');
  ok('rebuilding Diagnosis after Intelligence changes updates the SAME row with the new grade/tier');

  console.log(`\n✅ All ${passed} checks passed.\n`);
}

run().catch((err) => { console.error('\n❌ SELFTEST FAILED:\n', err); process.exit(1); });
