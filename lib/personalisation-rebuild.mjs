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

  const [intelligenceTable, diagnosisTable, personalisationTable, communicationsTable, agenciesTable, findingsTable] = await Promise.all([
    repo.getTable('INTELLIGENCE'),
    repo.getTable('DIAGNOSIS'),
    repo.getTable('PERSONALISATION'),
    repo.getTable('COMMUNICATIONS'),
    repo.getTable('AGENCIES'),
    loadFindingsTable(repo),
  ]);

  const intelligenceRecords = recordsFromTable(intelligenceTable, 'probe_id');
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
  let nextPersonalisationRow = personalisationTable.rows.length + 2;

  for (const rec of intelligenceRecords) {
    const intelligence = rec.obj;
    const probeId = intelligence.probe_id;

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
      const findings = findingsByProbe.get(probeId) || [];
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
    personalisation_created: personalisationCreated,
    personalisation_updated: personalisationUpdated,
    ai_personalisations_run: aiPersonalisationsRun,
    remaining_personalisations: remainingPersonalisations,
    skipped_not_diagnosed: skippedNotDiagnosed,
    problems,
  };
}
