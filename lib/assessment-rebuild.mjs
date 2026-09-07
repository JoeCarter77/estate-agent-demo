// lib/assessment-rebuild.mjs — the FINAL ASSESSMENT step, and the only step in
// the acquisition pipeline that spends Anthropic budget.
//
// It replaces lib/diagnosis-rebuild.mjs's role in the pass. The difference is
// not where the diagnosis comes from — it is that ONE call now produces both
// halves at once:
//   - the semantic INTELLIGENCE fields that used to cost a separate
//     interpretation call, made repeatedly and prematurely while the probe was
//     still observing;
//   - the commercial DIAGNOSIS the acquisition system actually consumes.
// See lib/probe-assessment.mjs for why those were always one act, and for the
// guarantee that every factual guard is the SAME function both old paths used.
//
// WHO IS ELIGIBLE. Exactly one population: probes whose INTELLIGENCE row says
// observation_status === 'closed' and whose DIAGNOSIS row is missing or has a
// blank diagnosis_summary. An OBSERVING probe is never assessed — that is the
// whole point, and it is asserted by the self-tests.
//
// FROZEN MEANS FROZEN. A probe with a non-blank diagnosis_summary is skipped
// before anything else. There is no forced-refresh path, and adding one would
// let a rebuild rewrite a story a prospect has already been sent.
//
// WHAT IT WRITES, IN ONE BATCH:
//   INTELLIGENCE       — the eight semantic columns patched onto the existing
//                        row (the deterministic columns are left exactly as
//                        step 1 of the pass computed them).
//   DIAGNOSIS          — one row per probe, upserted by probe_id. Its
//                        `findings` cell is the CANONICAL structured record:
//                        the full JSON array, on the probe's own row.
//   DIAGNOSIS_FINDINGS — the same findings, one row each, as a COMPATIBILITY
//                        PROJECTION for audit/history and for anything still
//                        reading the tab. Nothing in the active pipeline
//                        depends on reading it back any more (see
//                        lib/personalisation-rebuild.mjs and
//                        lib/demo-compile.mjs, which now read the canonical
//                        JSON first). A workbook without the tab is fine.
//
// BUDGET. maxAiCalls bounds assessments and nothing else. Every downstream
// stage is deterministic and runs regardless — an assessment backlog can no
// longer starve Personalisation, DEMOS or OUTBOUND, which was the specific
// failure that made "Rebuild Intelligence" move DIAGNOSIS while everything
// after it stood still.

import { newDiagnosisId } from './ids.mjs';
import { assessProbe } from './probe-assessment.mjs';
import { parseDiagnosisFindings } from './probe-diagnosis.mjs';
import { ASSESSMENT_INTELLIGENCE_FIELDS } from './probe-assessment.mjs';
import { loadFindingsTable, findingsTabExists, createFindingsWriter } from './diagnosis-findings.mjs';
import { isDeletedCommunication } from './communication-status.mjs';

function recordsFromTable({ header, rows }, idColumn) {
  const idIdx = header.indexOf(idColumn);
  const out = [];
  (rows || []).forEach((row, i) => {
    const idVal = idIdx >= 0 ? String(row[idIdx] ?? '').trim() : '';
    if (!idVal || idVal === 'SCHEMA NOTE') return;
    const obj = {};
    header.forEach((key, colIdx) => { obj[key] = row[colIdx] ?? ''; });
    if (idIdx >= 0) obj[idColumn] = idVal;
    out.push({ rowNumber: i + 2, obj });
  });
  return out;
}

// Same freeze signal the whole pipeline uses: a non-blank diagnosis_summary.
export function needsAssessment(existingDiagnosisRecord) {
  if (!existingDiagnosisRecord) return true;
  return !String(existingDiagnosisRecord.obj.diagnosis_summary || '').trim();
}

// repo, probesById: Map(probe_id -> PROBES obj), opts?: {
//   maxAiCalls?: number, probeIds?: iterable, assess?: fn (TEST SEAM)
// }
// -> { assessments_existing, assessments_created, assessments_remaining,
//      ai_calls_used, probes_observing, findings_written,
//      findings_tab_available, assessed_probe_ids, problems }
export async function rebuildAllAssessments(repo, probesById, opts = {}) {
  const maxAiCalls = Number.isFinite(opts.maxAiCalls) ? opts.maxAiCalls : Infinity;
  const probeIdFilter = opts.probeIds ? new Set(opts.probeIds) : null;
  const assess = typeof opts.assess === 'function' ? opts.assess : assessProbe;

  const [intelligenceTable, diagnosisTable, communicationsTable, findingsTable] = await Promise.all([
    repo.getTable('INTELLIGENCE'),
    repo.getTable('DIAGNOSIS'),
    repo.getTable('COMMUNICATIONS'),
    loadFindingsTable(repo),
  ]);

  // ONE PROBE = ONE VISIT — a workbook carrying two INTELLIGENCE rows for one
  // probe_id must not be assessed (and charged for) twice in a single pass.
  const seen = new Set();
  let duplicateIntelligenceRowsSkipped = 0;
  const intelligenceRecords = recordsFromTable(intelligenceTable, 'probe_id').filter((rec) => {
    if (seen.has(rec.obj.probe_id)) { duplicateIntelligenceRowsSkipped += 1; return false; }
    seen.add(rec.obj.probe_id);
    return true;
  });

  const diagnosisByProbe = new Map(recordsFromTable(diagnosisTable, 'probe_id').map((r) => [r.obj.probe_id, r]));

  const communicationsByProbe = new Map();
  for (const rec of recordsFromTable(communicationsTable, 'communication_id')) {
    const probeId = String(rec.obj.probe_id || '').trim();
    if (!probeId || isDeletedCommunication(rec.obj)) continue;
    if (!communicationsByProbe.has(probeId)) communicationsByProbe.set(probeId, []);
    communicationsByProbe.get(probeId).push(rec.obj);
  }

  const now = new Date();
  const summary = {
    assessments_existing: 0,
    assessments_created: 0,
    assessments_remaining: 0,
    ai_calls_used: 0,
    probes_observing: 0,
    duplicate_intelligence_rows_skipped: duplicateIntelligenceRowsSkipped,
    findings_written: 0,
    findings_tab_available: findingsTabExists(findingsTable),
    assessed_probe_ids: [],
    problems: [],
  };

  const writes = [];
  const findingsWriter = createFindingsWriter(findingsTable);
  let nextDiagnosisRow = (diagnosisTable.rows?.length ?? 0) + 2;

  for (const rec of intelligenceRecords) {
    const intelligence = rec.obj;
    const probeId = intelligence.probe_id;
    if (probeIdFilter && !probeIdFilter.has(probeId)) continue;

    if (String(intelligence.observation_status || '').trim().toLowerCase() !== 'closed') {
      summary.probes_observing += 1;
      continue;
    }

    const existingRecord = diagnosisByProbe.get(probeId) || null;
    if (!needsAssessment(existingRecord)) {
      summary.assessments_existing += 1;
      continue;
    }

    // Budget is checked BEFORE the call and counted as remaining, so the
    // summary always explains a short run rather than silently under-delivering.
    if (summary.ai_calls_used >= maxAiCalls) {
      summary.assessments_remaining += 1;
      continue;
    }

    // Reserve the invocation budget before starting the assessment. A failed
    // Anthropic request is still a real call attempt and must not leave the
    // slot available for another probe, or repeated wire errors could make one
    // bounded pass exceed maxAiCalls.
    summary.ai_calls_used += 1;

    try {
      const probe = (probesById && probesById.get(probeId)) || {};
      const communications = communicationsByProbe.get(probeId) || [];
      const { intelligence: semantic, diagnosis } =
        await assess(probe, communications, intelligence);

      // 1) INTELLIGENCE — patch ONLY the semantic columns onto the row the
      // deterministic step already wrote. Nothing else on that row is touched.
      const semanticPatch = Object.fromEntries(
        ASSESSMENT_INTELLIGENCE_FIELDS.map((field) => [field, semantic?.[field] ?? '']),
      );
      const mergedIntelligence = { ...intelligence, ...semanticPatch, updated_at: now.toISOString() };
      writes.push({
        tab: 'INTELLIGENCE',
        rowNumber: rec.rowNumber,
        row: intelligenceTable.header.map((key) => (mergedIntelligence[key] ?? '')),
      });

      // 2) DIAGNOSIS — upsert by probe_id.
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
      } else {
        rowNumber = nextDiagnosisRow;
        nextDiagnosisRow += 1;
        merged = { diagnosis_id: newDiagnosisId(), ...patch, created_at: now.toISOString() };
      }
      writes.push({ tab: 'DIAGNOSIS', rowNumber, row: diagnosisTable.header.map((key) => (merged[key] ?? '')) });

      // 3) DIAGNOSIS_FINDINGS — the compatibility projection, read straight
      // back off the canonical JSON we just built. Never re-derived, never
      // invented, and never a source anything upstream has to wait for.
      findingsWriter.write(probeId, parseDiagnosisFindings(diagnosis));

      summary.assessments_created += 1;
      summary.assessed_probe_ids.push(probeId);
    } catch (err) {
      summary.problems.push({ probe_id: probeId, error: err?.message || String(err) });
    }
  }

  writes.push(...findingsWriter.writes());
  summary.findings_written = findingsWriter.findingsWritten();
  await repo.writeRowsBatch(writes);
  return summary;
}
