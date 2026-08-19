// lib/diagnosis-rebuild.mjs — the canonical full-rebuild path for DIAGNOSIS,
// per INTELLIGENCE -> DIAGNOSIS (V2 schema §4/§6). Same batch-load-once /
// no-per-write-read shape as lib/intelligence-rebuild.mjs.
//
// Only closed observations get a Diagnosis (observation_status === 'closed')
// — an open probe hasn't produced a final grade or a complete evidence read
// yet. lib/probe-diagnosis.mjs is a pure commercial read of the already-
// interpreted INTELLIGENCE row: no new evidence, no grading, and the grade
// is never used to select or template the result.
//
// The AI call (one per probe) runs only when it hasn't run before — once a
// probe has a DIAGNOSIS row with a non-blank diagnosis_summary, it is
// FINALISED and FROZEN for good: nothing regenerates it again, not even a
// forced rebuild (probe lifecycle requirement — Diagnosis is generated
// exactly once per probe, from everything received during its 4-day
// observation window, then never touched again). This is different from
// lib/intelligence-rebuild.mjs's INTELLIGENCE, which forceAi can still
// re-interpret while a probe isn't yet finalised; DIAGNOSIS never has an
// forced-refresh path once written, so opts.forceAi has no effect here.
//
// A closed probe whose Diagnosis attempt never actually produced content
// (row missing entirely, or diagnosis_summary blank — e.g. a prior AI call
// errored) is NOT finalised and keeps being retried on every rebuild until
// it succeeds — same "continue where a failed batch left off" guarantee as
// the rest of this pipeline.
//
// Idempotent: DIAGNOSIS is upserted exactly one row per probe_id.

import { newDiagnosisId } from './ids.mjs';
import { diagnoseProbe } from './probe-diagnosis.mjs';

function recordsFromTable({ header, rows }, idColumn) {
  const idIdx = header.indexOf(idColumn);
  const out = [];
  rows.forEach((row, i) => {
    const idVal = idIdx >= 0 ? (row[idIdx] ?? '') : '';
    if (!idVal || idVal === 'SCHEMA NOTE') return;
    const obj = {};
    header.forEach((key, colIdx) => { obj[key] = row[colIdx] ?? ''; });
    out.push({ rowNumber: i + 2, obj });
  });
  return out;
}

// A row counts as "already diagnosed" (finalised, frozen) once
// diagnosis_summary is set — every diagnosis, including the no-problem-found
// and zero-communications cases, always writes one. Deliberately does not
// take forceAi: once true, this never flips back — see the file header.
function needsDiagnosis(existingRecord) {
  if (!existingRecord) return true;
  return !String(existingRecord.obj.diagnosis_summary || '').trim();
}

// repo, probesById: Map(probe_id -> PROBES obj) for property context in the
// prompt, opts?: { maxAiCalls?: number }
// -> { diagnoses_processed, diagnosis_created, diagnosis_updated,
//      ai_diagnoses_run, remaining_diagnoses, skipped_not_closed, problems }
//
// maxAiCalls bounds how many diagnoses this call will run — see the
// identical comment on rebuildAllIntelligence's maxAiCalls in
// lib/intelligence-rebuild.mjs. Resumability works the same way: a probe
// skipped for budget keeps a blank diagnosis_summary, so the next call
// picks it up again.
//
// No forceAi here — see the file header: a finalised Diagnosis never has a
// forced-refresh path.
export async function rebuildAllDiagnosis(repo, probesById, opts = {}) {
  const maxAiCalls = Number.isFinite(opts.maxAiCalls) ? opts.maxAiCalls : Infinity;

  const [intelligenceTable, diagnosisTable] = await Promise.all([
    repo.getTable('INTELLIGENCE'),
    repo.getTable('DIAGNOSIS'),
  ]);

  // 'probe_id', not 'intelligence_id'/'diagnosis_id': both tables are exactly
  // one row per probe_id, which is already each row's real identity. Keying
  // the read on the decorative *_id column meant a live sheet whose header
  // doesn't carry that column (e.g. the V2 header, which lists probe_id but
  // not intelligence_id/diagnosis_id) read back as having ZERO existing rows
  // in either table — recordsFromTable() filters out every row whose
  // id-column cell it can't find, and an absent column means every row's
  // "cell" is treated as blank. For INTELLIGENCE that emptied out
  // intelligenceRecords entirely, so the loop below never ran for any probe:
  // this was the exact cause of DIAGNOSIS staying empty after a rebuild.
  const intelligenceRecords = recordsFromTable(intelligenceTable, 'probe_id');
  const diagnosisRecords = recordsFromTable(diagnosisTable, 'probe_id');
  const diagnosisByProbe = new Map(diagnosisRecords.map((r) => [r.obj.probe_id, r]));

  const now = new Date();
  let skippedNotClosed = 0;
  let aiDiagnosesRun = 0;
  let remainingDiagnoses = 0;
  const problems = [];
  const writes = [];
  let diagnosisCreated = 0;
  let diagnosisUpdated = 0;
  let nextDiagnosisRow = diagnosisTable.rows.length + 2;

  for (const rec of intelligenceRecords) {
    const intelligence = rec.obj;
    const probeId = intelligence.probe_id;

    if (String(intelligence.observation_status || '').trim().toLowerCase() !== 'closed') {
      skippedNotClosed += 1;
      continue;
    }

    try {
      const existingRecord = diagnosisByProbe.get(probeId) || null;
      if (!needsDiagnosis(existingRecord)) continue;

      if (aiDiagnosesRun >= maxAiCalls) {
        remainingDiagnoses += 1;
        continue;
      }

      const probe = (probesById && probesById.get(probeId)) || {};
      const diagnosis = await diagnoseProbe(intelligence, probe);
      aiDiagnosesRun += 1;

      const diagnosisId = existingRecord ? existingRecord.obj.diagnosis_id : newDiagnosisId();
      const patch = {
        agency_id: intelligence.agency_id || '',
        probe_id: probeId,
        ...diagnosis,
        updated_at: now.toISOString(),
      };

      let rowNumber;
      let merged;
      if (existingRecord) {
        rowNumber = existingRecord.rowNumber;
        merged = { ...existingRecord.obj, ...patch };
        diagnosisUpdated += 1;
      } else {
        rowNumber = nextDiagnosisRow;
        nextDiagnosisRow += 1;
        merged = { diagnosis_id: diagnosisId, ...patch, created_at: now.toISOString() };
        diagnosisCreated += 1;
      }
      const row = diagnosisTable.header.map((key) => (merged[key] ?? ''));
      writes.push({ tab: 'DIAGNOSIS', rowNumber, row });
    } catch (err) {
      problems.push({ probe_id: probeId, error: err.message || String(err) });
    }
  }

  await repo.writeRowsBatch(writes);

  return {
    diagnoses_processed: diagnosisCreated + diagnosisUpdated,
    diagnosis_created: diagnosisCreated,
    diagnosis_updated: diagnosisUpdated,
    ai_diagnoses_run: aiDiagnosesRun,
    remaining_diagnoses: remainingDiagnoses,
    skipped_not_closed: skippedNotClosed,
    problems,
  };
}
