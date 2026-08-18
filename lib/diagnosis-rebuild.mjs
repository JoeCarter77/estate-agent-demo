// lib/diagnosis-rebuild.mjs — the canonical full-rebuild path for DIAGNOSIS,
// per INTELLIGENCE -> DIAGNOSIS. Same batch-load-once / no-per-write-read
// shape as lib/intelligence-rebuild.mjs (see that file's header comment for
// why — the same Sheets API read-quota constraint applies here).
//
// Only closed observations get a Diagnosis (observation_status === 'closed')
// — an open probe hasn't produced a final grade yet, so there's nothing
// stable to diagnose. No new evidence or grading logic lives here: it's a
// pure commercial read of the already-graded INTELLIGENCE row
// (lib/diagnosis.mjs).
//
// Idempotent: DIAGNOSIS is upserted exactly one row per probe_id — rebuilding
// updates the existing row rather than creating a duplicate, same convention
// as INTELLIGENCE.

import { newDiagnosisId } from './ids.mjs';
import { computeDiagnosis } from './diagnosis.mjs';

// Same row-filtering rule as repo.getRecords() — duplicated here because the
// batch load below reads the tab via getTable() directly, once, instead of
// through getRecords() (which would call getTable() a second time).
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

// repo -> { diagnoses_processed, diagnosis_created, diagnosis_updated, skipped_not_closed, problems }
export async function rebuildAllDiagnosis(repo) {
  const [intelligenceTable, diagnosisTable] = await Promise.all([
    repo.getTable('INTELLIGENCE'),
    repo.getTable('DIAGNOSIS'),
  ]);

  const intelligenceRecords = recordsFromTable(intelligenceTable, 'intelligence_id');
  const diagnosisRecords = recordsFromTable(diagnosisTable, 'diagnosis_id');
  const diagnosisByProbe = new Map(diagnosisRecords.map((r) => [r.obj.probe_id, r]));

  const now = new Date();
  let skippedNotClosed = 0;
  const problems = [];
  const writes = [];
  let diagnosisCreated = 0;
  let diagnosisUpdated = 0;
  let diagnosisCleared = 0;
  let nextDiagnosisRow = diagnosisTable.rows.length + 2;

  for (const rec of intelligenceRecords) {
    const intelligence = rec.obj;
    const probeId = intelligence.probe_id;

    // Sheet-sourced values can carry incidental whitespace/case (manual
    // edits, copy/paste) that a strict === against the literal 'closed'
    // silently fails on — the exact failure mode that was making every
    // otherwise-eligible row skip with no error. Normalize before comparing.
    if (String(intelligence.observation_status || '').trim().toLowerCase() !== 'closed') {
      skippedNotClosed += 1;
      continue;
    }

    try {
      const diagnosis = computeDiagnosis(intelligence);
      const existingRecord = diagnosisByProbe.get(probeId) || null;

      if (!diagnosis) {
        // Not diagnosable: no routing entry for this grade (e.g. still
        // 'pending'), or the probe is compromised and must not be routed to a
        // commercial tier. Creating nothing is right — but LEAVING an existing
        // row untouched is not: it would go on asserting a commercial
        // conclusion this probe no longer supports. Clear the conclusion
        // fields in place, keeping the row and its id.
        if (existingRecord) {
          const cleared = {
            ...existingRecord.obj,
            tier: '', primary_problem: '', commercial_implication: '',
            recommended_solution: '', sales_angle: '',
            evidence_summary: String(intelligence.override_reason || '').startsWith('COMPROMISED PROBE')
              ? `Not diagnosed — ${intelligence.override_reason}`
              : 'Not diagnosed — the observation has not produced a routable grade.',
            updated_at: now.toISOString(),
          };
          writes.push({ tab: 'DIAGNOSIS', rowNumber: existingRecord.rowNumber, row: diagnosisTable.header.map((k) => (cleared[k] ?? '')) });
          diagnosisCleared += 1;
        }
        continue;
      }

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
    diagnosis_cleared: diagnosisCleared,
    skipped_not_closed: skippedNotClosed,
    problems,
  };
}
