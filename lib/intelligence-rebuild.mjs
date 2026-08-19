// lib/intelligence-rebuild.mjs — the canonical full-rebuild path for
// INTELLIGENCE, per PROBES + COMMUNICATIONS -> EVIDENCE -> INTELLIGENCE
// (V2 schema, docs/V2_COMMS_INTELLIGENCE_DIAGNOSIS_SCHEMA.md §6).
//
// PERFORMANCE NOTE (unchanged from V1 — same Sheets API read-quota
// constraint): batch-loads PROBES, COMMUNICATIONS and INTELLIGENCE exactly
// ONCE (repo.getTable(), not repo.getRecords(), so the header comes back in
// the same read), runs the full per-probe pipeline entirely in memory, then
// writes everything in one batched call via repo.writeRowsBatch() — never a
// read per write.
//
// The deterministic half of the pipeline — lib/classification.mjs (hard-signal
// human/automated), lib/intelligence-fields.mjs (which itself reuses
// lib/observation.mjs's §9 30-minute grouping and lib/grading.mjs's unchanged
// A-H rules) — runs for EVERY probe on EVERY rebuild, so it self-heals and a
// probe's grade/counts are always current.
//
// The AI interpretation half (lib/probe-interpretation.mjs) is the one part
// that costs real API calls, so it runs only when it actually needs to:
//   - the probe's INTELLIGENCE row has never been AI-interpreted (the row is
//     new, or is one of the historical rows this rebuild exists to fill in
//     — its communication_quality field is blank), or
//   - opts.forceAi is set (e.g. after a prompt change).
// A rebuild over an already-interpreted, unchanged sheet therefore makes
// ZERO AI calls — it only re-confirms the deterministic fields.
//
// Idempotent: INTELLIGENCE is still upserted exactly one row per probe_id —
// running rebuildAll twice in a row produces the same rows both times.

import { newIntelligenceId } from './ids.mjs';
import { interpretCommunication } from './classification.mjs';
import { computeDeterministicIntelligence } from './intelligence-fields.mjs';
import { interpretProbe } from './probe-interpretation.mjs';

function isOverridden(comm) {
  return comm.manual_override === 'TRUE' || comm.manual_override === true;
}

// Same row-filtering rule as repo.getRecords(): skip any row whose id column
// is empty or the literal "SCHEMA NOTE" (row 1 = header, row 2 = schema
// note, row 3+ = data). Duplicated here because the batch load below reads
// each tab via getTable() directly, once, instead of through getRecords().
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

// A row counts as "already AI-interpreted" once communication_quality is
// set — every AI interpretation, including the zero-communications case,
// always writes a non-empty value there. A never-interpreted row (new, or
// one of the pre-V2 historical rows this rebuild exists to fill in) leaves
// it blank.
function needsAiInterpretation(existingRecord, forceAi) {
  if (forceAi) return true;
  if (!existingRecord) return true;
  return !String(existingRecord.obj.communication_quality || '').trim();
}

// repo, opts?: { forceAi?: boolean } -> { probes_processed,
//   probes_with_communications, probes_with_zero_communications,
//   intelligence_created, intelligence_updated, ai_interpretations_run,
//   problems, results }
export async function rebuildAllIntelligence(repo, opts = {}) {
  const forceAi = Boolean(opts.forceAi);

  // 1) BATCH LOAD — exactly one read of each table for the whole rebuild.
  const [probesTable, communicationsTable, intelligenceTable] = await Promise.all([
    repo.getTable('PROBES'),
    repo.getTable('COMMUNICATIONS'),
    repo.getTable('INTELLIGENCE'),
  ]);

  const probeRecords = recordsFromTable(probesTable, 'probe_id');
  const communicationRecords = recordsFromTable(communicationsTable, 'communication_id');
  const intelligenceRecords = recordsFromTable(intelligenceTable, 'intelligence_id');

  const communicationsByProbe = new Map();
  const communicationRowById = new Map();
  for (const rec of communicationRecords) {
    communicationRowById.set(rec.obj.communication_id, rec);
    const probeId = rec.obj.probe_id;
    if (!probeId) continue;
    if (!communicationsByProbe.has(probeId)) communicationsByProbe.set(probeId, []);
    communicationsByProbe.get(probeId).push(rec.obj);
  }

  const intelligenceByProbe = new Map(intelligenceRecords.map((r) => [r.obj.probe_id, r]));

  // 2) COMPUTE — the full pipeline, in memory, for every probe. AI calls are
  // awaited sequentially (probe counts here are small — dozens, not
  // thousands — and this keeps the module simple with no concurrency limiter).
  const now = new Date();
  let probesWithCommunications = 0;
  let probesWithZeroCommunications = 0;
  let aiInterpretationsRun = 0;
  const problems = [];
  const results = [];
  const communicationPatchesById = new Map();
  const intelligenceUpsertsByProbe = new Map();

  for (const rec of probeRecords) {
    const probe = rec.obj;
    const probeId = probe.probe_id;
    const probeCommunications = communicationsByProbe.get(probeId) || [];
    if (probeCommunications.length > 0) probesWithCommunications += 1; else probesWithZeroCommunications += 1;

    try {
      // 2a) Deterministic per-message classification — automated_or_human only.
      const classified = [];
      for (const comm of probeCommunications) {
        if (isOverridden(comm)) {
          classified.push(comm);
          continue;
        }
        // See lib/observation-recompute.mjs's identical comment: the SHEET
        // write is trimmed to automated_or_human, but computeDeterministicIntelligence()
        // below still needs communication_classification in memory (auto-ack
        // detection lives in lib/observation.mjs, unchanged by this schema).
        const patch = interpretCommunication(comm, { probeTimestamp: probe.probe_timestamp });
        const automatedOrHuman = patch.automated_or_human;
        if (String(comm.automated_or_human || '') !== automatedOrHuman) {
          communicationPatchesById.set(comm.communication_id, { automated_or_human: automatedOrHuman });
        }
        classified.push({ ...comm, ...patch });
      }

      // 2b) Deterministic rollup — unchanged A-H engine underneath.
      const det = computeDeterministicIntelligence(probe, classified, now);

      // 2c) AI interpretation — only when it hasn't run before, or forced.
      const existingRecord = intelligenceByProbe.get(probeId) || null;
      let aiFields;
      if (needsAiInterpretation(existingRecord, forceAi)) {
        aiFields = await interpretProbe(probe, classified);
        aiInterpretationsRun += 1;
      } else {
        const stored = existingRecord.obj;
        aiFields = {
          viewing_progression: stored.viewing_progression || '',
          buyer_qualification: stored.buyer_qualification || '',
          buyer_questions_asked: stored.buyer_questions_asked || '',
          seller_recognition: stored.seller_recognition || '',
          communication_quality: stored.communication_quality || '',
          did_well: stored.did_well || '',
          missed: stored.missed || '',
          evidence: stored.evidence || '',
        };
      }

      const intelligenceId = existingRecord ? existingRecord.obj.intelligence_id : newIntelligenceId();
      const intelligencePatch = {
        agency_id: probe.agency_id || '',
        probe_id: probeId,
        ...det,
        ...aiFields,
        updated_at: now.toISOString(),
      };

      intelligenceUpsertsByProbe.set(probeId, {
        intelligenceId,
        existingRecord,
        patch: existingRecord ? intelligencePatch : { intelligence_id: intelligenceId, ...intelligencePatch, created_at: now.toISOString() },
      });

      results.push({ probe_id: probeId, intelligence_id: intelligenceId, grade: det.grade, communications_matched: probeCommunications.length });
    } catch (err) {
      problems.push({ probe_id: probeId, error: err.message || String(err) });
    }
  }

  // 3) BUILD FULLY-FORMED ROWS — merge each patch onto its already-loaded
  // row (or, for new INTELLIGENCE rows, onto an empty row). No sheet access.
  const writes = [];

  for (const [communicationId, patch] of communicationPatchesById) {
    const existing = communicationRowById.get(communicationId);
    if (!existing) continue;
    const merged = { ...existing.obj, ...patch };
    const row = communicationsTable.header.map((key) => (merged[key] ?? ''));
    writes.push({ tab: 'COMMUNICATIONS', rowNumber: existing.rowNumber, row });
  }

  let nextIntelligenceRow = intelligenceTable.rows.length + 2;
  let intelligenceCreated = 0;
  let intelligenceUpdated = 0;

  for (const { existingRecord, patch } of intelligenceUpsertsByProbe.values()) {
    let rowNumber;
    let merged;
    if (existingRecord) {
      rowNumber = existingRecord.rowNumber;
      merged = { ...existingRecord.obj, ...patch };
      intelligenceUpdated += 1;
    } else {
      rowNumber = nextIntelligenceRow;
      nextIntelligenceRow += 1;
      merged = patch;
      intelligenceCreated += 1;
    }
    const row = intelligenceTable.header.map((key) => (merged[key] ?? ''));
    writes.push({ tab: 'INTELLIGENCE', rowNumber, row });
  }

  // 4) WRITE — one batched call, zero reads.
  await repo.writeRowsBatch(writes);

  return {
    probes_processed: probeRecords.length,
    probes_with_communications: probesWithCommunications,
    probes_with_zero_communications: probesWithZeroCommunications,
    intelligence_created: intelligenceCreated,
    intelligence_updated: intelligenceUpdated,
    ai_interpretations_run: aiInterpretationsRun,
    problems,
    results,
  };
}
