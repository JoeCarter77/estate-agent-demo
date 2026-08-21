// lib/personalisation-rebuild.mjs — the canonical full-rebuild path for
// PERSONALISATION, one step after DIAGNOSIS in the pipeline (COMMUNICATIONS
// = evidence, INTELLIGENCE = interpretation, DIAGNOSIS = commercial
// conclusion, PERSONALISATION = that evidence + conclusion turned into the
// agency-specific acquisition story). Same batch-load-once / no-per-write-
// read shape as lib/diagnosis-rebuild.mjs.
//
// Only runs for probes whose DIAGNOSIS is already finalised (non-blank
// diagnosis_summary) — Personalisation reads Diagnosis as settled, it never
// races ahead of it. Like DIAGNOSIS, once a probe's PERSONALISATION row has
// content (non-blank primary_narrative) it is FROZEN for good: nothing
// regenerates it, not even a forced rebuild — the story a prospect was sent
// should not silently change under them.
//
// IMPORTANT: "Diagnosis is finalised" is the ONLY gate here — this step has
// no way to tell a probe whose Diagnosis was JUST regenerated in this same
// pass apart from one that has carried a non-blank diagnosis_summary for
// weeks. So on a workbook with an empty PERSONALISATION tab (e.g. right
// after that tab is first created), unfreezing even one historical probe's
// DIAGNOSIS.diagnosis_summary makes EVERY OTHER already-diagnosed historical
// probe look identically eligible too — none of them has a PERSONALISATION
// row yet, so needsPersonalisation() is true for all of them, not just the
// one that was unfrozen. A full rebuild pass then personalises all of them
// in one go. Use opts.probeIds below to restrict a run to a known set of
// probes when that full sweep is not what you want (e.g. testing a handful
// of probes without spending AI on the rest).
//
// This step loads the COMPLETE Diagnosis picture for each probe and hands it
// all to the one AI call: the DIAGNOSIS row itself (strengths,
// missed_opportunities, commercial_implication, novus_opportunity,
// diagnosis_summary) AND that probe's DIAGNOSIS_FINDINGS rows, which are the
// findings[] array Diagnosis produced, persisted one row per finding
// (lib/diagnosis-findings.mjs). Personalisation is the layer that judges how
// those findings combine into one story; it never re-derives them.
//
// Idempotent: PERSONALISATION is upserted exactly one row per probe_id.

import { newPersonalisationId } from './ids.mjs';
import { personaliseProbe } from './probe-personalisation.mjs';
import { loadFindingsTable, groupFindingsByProbe } from './diagnosis-findings.mjs';
import { parseDiagnosisFindings } from './probe-diagnosis.mjs';

// idVal is TRIMMED and written back onto obj[idColumn] — a stray leading/
// trailing space typed into the sheet by hand must not make this row invisible
// to a later probe_id lookup (Map keys built from this obj must match exactly
// what INTELLIGENCE/DIAGNOSIS's own recordsFromTable produces for the same
// probe, or an existing PERSONALISATION row silently stops being found and a
// duplicate gets appended instead of updated in place).
function recordsFromTable({ header, rows }, idColumn) {
  const idIdx = header.indexOf(idColumn);
  const out = [];
  rows.forEach((row, i) => {
    const idVal = idIdx >= 0 ? String(row[idIdx] ?? '').trim() : '';
    if (!idVal || idVal === 'SCHEMA NOTE') return;
    const obj = {};
    header.forEach((key, colIdx) => { obj[key] = row[colIdx] ?? ''; });
    if (idIdx >= 0) obj[idColumn] = idVal;
    out.push({ rowNumber: i + 2, obj });
  });
  return out;
}

// A row counts as "already personalised" (finalised, frozen) once
// primary_narrative is set — every personalisation writes one, including the
// strong-handling case where the story is that nothing went wrong.
// Deliberately does not take forceAi — see the file header.
function needsPersonalisation(existingRecord) {
  if (!existingRecord) return true;
  return !String(existingRecord.obj.primary_narrative || '').trim();
}

// repo, probesById: Map(probe_id -> PROBES obj), opts?: { maxAiCalls?: number }
// -> { personalisations_processed, personalisation_created,
//      personalisation_updated, ai_personalisations_run,
//      remaining_personalisations, skipped_not_diagnosed, problems }
export async function rebuildAllPersonalisation(repo, probesById, opts = {}) {
  const maxAiCalls = Number.isFinite(opts.maxAiCalls) ? opts.maxAiCalls : Infinity;
  // opts.probeIds?: iterable of probe_id — restricts this rebuild to exactly
  // those probes, same targeting option as rebuildAllIntelligence and
  // rebuildAllDiagnosis. Absent (the default) processes every diagnosed,
  // unpersonalised probe, same as before this option existed — see the file
  // header for why that default swept up every already-diagnosed historical
  // probe the one time this mattered.
  const probeIdFilter = opts.probeIds ? new Set(opts.probeIds) : null;

  const [intelligenceTable, diagnosisTable, personalisationTable, communicationsTable, agenciesTable, findingsTable] = await Promise.all([
    repo.getTable('INTELLIGENCE'),
    repo.getTable('DIAGNOSIS'),
    repo.getTable('PERSONALISATION'),
    repo.getTable('COMMUNICATIONS'),
    repo.getTable('AGENCIES'),
    loadFindingsTable(repo),
  ]);

  // ONE PROBE = ONE VISIT, for the same reason lib/diagnosis-rebuild.mjs
  // dedupes: this loop walks INTELLIGENCE ROWS, and a workbook carrying two
  // rows for one probe_id would otherwise personalise it twice in a single
  // pass — the second visit sees the same stale personalisationByProbe map,
  // finds no existing row, and appends a SECOND PERSONALISATION row. The
  // invariant is one row per probe per rebuild, so it is enforced here rather
  // than assumed of the upstream table.
  const allIntelligenceRecords = recordsFromTable(intelligenceTable, 'probe_id');
  const seenProbeIds = new Set();
  let duplicateIntelligenceRowsSkipped = 0;
  const intelligenceRecords = allIntelligenceRecords.filter((rec) => {
    if (seenProbeIds.has(rec.obj.probe_id)) {
      duplicateIntelligenceRowsSkipped += 1;
      return false;
    }
    seenProbeIds.add(rec.obj.probe_id);
    return true;
  });
  const diagnosisRecords = recordsFromTable(diagnosisTable, 'probe_id');
  const personalisationRecords = recordsFromTable(personalisationTable, 'probe_id');
  const communicationRecords = recordsFromTable(communicationsTable, 'communication_id');
  const agencyRecords = recordsFromTable(agenciesTable, 'agency_id');

  const diagnosisByProbe = new Map(diagnosisRecords.map((r) => [r.obj.probe_id, r.obj]));
  const personalisationByProbe = new Map(personalisationRecords.map((r) => [r.obj.probe_id, r]));
  const agencyById = new Map(agencyRecords.map((r) => [r.obj.agency_id, r.obj]));
  const findingsByProbe = groupFindingsByProbe(findingsTable);

  const communicationsByProbe = new Map();
  for (const rec of communicationRecords) {
    const probeId = rec.obj.probe_id;
    if (!probeId) continue;
    if (!communicationsByProbe.has(probeId)) communicationsByProbe.set(probeId, []);
    communicationsByProbe.get(probeId).push(rec.obj);
  }

  const now = new Date();
  let skippedNotDiagnosed = 0;
  let aiPersonalisationsRun = 0;
  let remainingPersonalisations = 0;
  const problems = [];
  const writes = [];
  let personalisationCreated = 0;
  let personalisationUpdated = 0;
  let personalisationsWithFindings = 0;
  let findingsRecoveredFromDiagnosisRow = 0;
  let nextPersonalisationRow = personalisationTable.rows.length + 2;

  for (const rec of intelligenceRecords) {
    const intelligence = rec.obj;
    const probeId = intelligence.probe_id;

    // Targeting filter: skip silently, before anything else.
    if (probeIdFilter && !probeIdFilter.has(probeId)) continue;

    const diagnosis = diagnosisByProbe.get(probeId);
    if (!diagnosis || !String(diagnosis.diagnosis_summary || '').trim()) {
      skippedNotDiagnosed += 1;
      continue;
    }

    try {
      const existingRecord = personalisationByProbe.get(probeId) || null;
      if (!needsPersonalisation(existingRecord)) continue;

      if (aiPersonalisationsRun >= maxAiCalls) {
        remainingPersonalisations += 1;
        continue;
      }

      const probe = (probesById && probesById.get(probeId)) || {};
      const communications = communicationsByProbe.get(probeId) || [];
      const agency = agencyById.get(intelligence.agency_id) || {};
      // FINDINGS ARE THE INPUT, AND SILENCE IS NOT AN ACCEPTABLE ANSWER.
      // An empty findings list is a real, meaningful state — it means
      // Diagnosis found no genuine problem — and the prompt says exactly that
      // to the model. So "the DIAGNOSIS_FINDINGS rows are missing" must never
      // be allowed to look like it: that would quietly tell the model this
      // enquiry was handled perfectly and let it write the story off the
      // Diagnosis prose instead of the findings.
      //
      // The rows are the source of truth. Only when a diagnosed probe has NO
      // rows at all AND its own DIAGNOSIS.findings cell still holds the JSON
      // array Diagnosis produced do we read them back from there — the same
      // findings, from the other place the same step already wrote them, never
      // re-derived and never invented. (Reachable for any probe diagnosed
      // before DIAGNOSIS_FINDINGS existed, or by a path that did not yet write
      // it.) Counted, not silent, so a workbook drifting into that state shows
      // up in the summary instead of degrading the emails quietly.
      let findings = findingsByProbe.get(probeId) || [];
      if (findings.length === 0) {
        const fromDiagnosisRow = parseDiagnosisFindings(diagnosis)
          .map((f, i) => ({
            finding_index: i + 1,
            finding: String(f?.finding || '').trim(),
            evidence: String(f?.evidence || '').trim(),
            significance_note: String(f?.significance_note || '').trim(),
          }))
          .filter((f) => f.finding && f.evidence);
        if (fromDiagnosisRow.length > 0) {
          findings = fromDiagnosisRow;
          findingsRecoveredFromDiagnosisRow += 1;
        }
      }
      if (findings.length > 0) personalisationsWithFindings += 1;

      const personalisation = await personaliseProbe(probe, intelligence, diagnosis, findings, communications, agency);
      aiPersonalisationsRun += 1;

      const personalisationId = existingRecord ? existingRecord.obj.personalisation_id : newPersonalisationId();
      const patch = {
        agency_id: intelligence.agency_id || '',
        probe_id: probeId,
        ...personalisation,
        updated_at: now.toISOString(),
      };

      let rowNumber;
      let merged;
      if (existingRecord) {
        rowNumber = existingRecord.rowNumber;
        merged = { ...existingRecord.obj, ...patch };
        personalisationUpdated += 1;
      } else {
        rowNumber = nextPersonalisationRow;
        nextPersonalisationRow += 1;
        merged = { personalisation_id: personalisationId, ...patch, created_at: now.toISOString() };
        personalisationCreated += 1;
      }
      const row = personalisationTable.header.map((key) => (merged[key] ?? ''));
      writes.push({ tab: 'PERSONALISATION', rowNumber, row });
    } catch (err) {
      problems.push({ probe_id: probeId, error: err.message || String(err) });
    }
  }

  await repo.writeRowsBatch(writes);

  return {
    personalisations_processed: personalisationCreated + personalisationUpdated,
    personalisations_with_findings: personalisationsWithFindings,
    duplicate_intelligence_rows_skipped: duplicateIntelligenceRowsSkipped,
    findings_recovered_from_diagnosis_row: findingsRecoveredFromDiagnosisRow,
    personalisation_created: personalisationCreated,
    personalisation_updated: personalisationUpdated,
    ai_personalisations_run: aiPersonalisationsRun,
    remaining_personalisations: remainingPersonalisations,
    skipped_not_diagnosed: skippedNotDiagnosed,
    problems,
  };
}
