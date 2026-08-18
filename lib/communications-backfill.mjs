// lib/communications-backfill.mjs — one-time historical backfill for
// COMMUNICATIONS.contact_quality ('proactive_booking_push' | ''), so
// existing rows carry the same signal newly-arriving rows get automatically
// via lib/classification.mjs (wired into lib/intelligence-rebuild.mjs and
// lib/observation-recompute.mjs).
//
// Deliberately narrow in scope — this ONLY ever writes contact_quality:
//   - Uses each row's ALREADY-STORED automated_or_human value (never
//     recomputes it) to decide whether a row is eligible ("only classify
//     human communications" — using what was already decided for that row,
//     not second-guessing it).
//   - Calls lib/classification.mjs's exported detectProactiveBookingPush()
//     directly — the exact same phrase/time-pattern logic the live pipeline
//     uses for new rows, so historical and future rows are classified
//     identically.
//   - Never touches automated_or_human, human_contact,
//     communication_classification, booking_attempt, intent, or any
//     INTELLIGENCE/DIAGNOSIS field. A-H grading depends on none of the
//     fields this module writes.
//   - Skips manual_override rows and rows that already carry a
//     contact_quality value (idempotent — safe to re-run).
//
// Same batch-load-once / single-batched-write shape as
// lib/intelligence-rebuild.mjs, for the same Sheets-API-quota reason.

import { detectProactiveBookingPush } from './classification.mjs';

function isOverridden(row) {
  return row.manual_override === 'TRUE' || row.manual_override === true;
}

// repo -> { rows_scanned, human_rows_scanned, already_set, skipped_overridden,
//   proactive_detected, cells_written }
export async function backfillContactQuality(repo) {
  const table = await repo.getTable('COMMUNICATIONS');
  const idIdx = table.header.indexOf('communication_id');

  const writes = [];
  let rowsScanned = 0;
  let humanRowsScanned = 0;
  let alreadySet = 0;
  let skippedOverridden = 0;
  let proactiveDetected = 0;

  table.rows.forEach((row, i) => {
    const idVal = idIdx >= 0 ? (row[idIdx] ?? '') : '';
    if (!idVal || idVal === 'SCHEMA NOTE') return;

    rowsScanned += 1;
    const obj = {};
    table.header.forEach((key, colIdx) => { obj[key] = row[colIdx] ?? ''; });

    if (isOverridden(obj)) { skippedOverridden += 1; return; }
    if (String(obj.contact_quality || '').trim() !== '') { alreadySet += 1; return; }
    if (obj.automated_or_human !== 'human') return; // only classify human communications
    humanRowsScanned += 1;

    if (!detectProactiveBookingPush(obj)) return; // stays blank — no write needed

    proactiveDetected += 1;
    const merged = { ...obj, contact_quality: 'proactive_booking_push' };
    const newRow = table.header.map((key) => (merged[key] ?? ''));
    writes.push({ tab: 'COMMUNICATIONS', rowNumber: i + 2, row: newRow });
  });

  if (writes.length > 0) await repo.writeRowsBatch(writes);

  return {
    rows_scanned: rowsScanned,
    human_rows_scanned: humanRowsScanned,
    already_set: alreadySet,
    skipped_overridden: skippedOverridden,
    proactive_detected: proactiveDetected,
    cells_written: writes.length,
  };
}
