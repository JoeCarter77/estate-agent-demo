// lib/intelligence-rebuild.mjs — the canonical full-rebuild path for
// INTELLIGENCE, per PROBES + COMMUNICATIONS -> EVIDENCE -> INTELLIGENCE
// (V2 schema, docs/V2_COMMS_INTELLIGENCE_DIAGNOSIS_SCHEMA.md §6).
//
// PERFORMANCE NOTE (unchanged from V1 — same Sheets API read-quota
// constraint): batch-loads PROBES, COMMUNICATIONS, INTELLIGENCE and DIAGNOSIS
// exactly ONCE (repo.getTable(), not repo.getRecords(), so the header comes
// back in the same read), runs the full per-probe pipeline entirely in
// memory, then writes everything in one batched call via
// repo.writeRowsBatch() — never a read per write. PROBES is only ever
// written back for two self-heal patches: backfilling a blank
// observation_deadline (probe_timestamp + 4 days, historical probes that
// predate that column ever being written) and flipping probe_status to
// 'closed' on the window elapsing. DIAGNOSIS is only ever read (to know
// which probes are finalised), never written here — that's
// lib/diagnosis-rebuild.mjs's job.
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
//
// FINALISED PROBES ARE FROZEN (probe lifecycle, docs/V2_COMMS_INTELLIGENCE_
// DIAGNOSIS_SCHEMA.md §6 + lib/probe-finalization concept): a probe is
// "finalised" once it has a DIAGNOSIS row with a non-blank diagnosis_summary
// — the same signal lib/diagnosis-rebuild.mjs already uses to mean "already
// diagnosed". A finalised probe is skipped here ENTIRELY (no deterministic
// recompute, no AI call, no write) — including under opts.forceAi. The final
// Intelligence a probe gets is the one computed at the moment its Diagnosis
// was generated; nothing after that, including a forced rebuild, may change
// it. A probe that's closed but not yet diagnosed (e.g. a prior Diagnosis
// attempt failed) is NOT finalised and keeps recomputing normally.

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

// repo, opts?: { forceAi?: boolean, maxAiCalls?: number } -> { probes_processed,
//   probes_with_communications, probes_with_zero_communications,
//   intelligence_created, intelligence_updated, ai_interpretations_run,
//   remaining_interpretations, probes_finalized_skipped, problems, results }
//
// maxAiCalls bounds how many AI interpretations this single call will run —
// the one part of the pipeline slow enough to risk a serverless function
// timeout on a large historical dataset. Once the budget is spent, remaining
// probes that still need AI interpretation are left untouched (their
// INTELLIGENCE row, if any, is not written this round) rather than forced
// through without AI. Because "needs interpretation" is defined by a blank
// communication_quality field (not a run counter or fingerprint), the next
// call with the same opts naturally picks up exactly where this one left
// off — no cursor to persist. Omit maxAiCalls (or pass Infinity) to process
// every probe in one call, as tests and single-shot callers may still want.
export async function rebuildAllIntelligence(repo, opts = {}) {
  const forceAi = Boolean(opts.forceAi);
  const maxAiCalls = Number.isFinite(opts.maxAiCalls) ? opts.maxAiCalls : Infinity;
  // opts.probeIds?: iterable of probe_id — when present, every other probe is
  // skipped entirely (not counted, not touched) before any other check. Used
  // to restrict a rebuild to a specific set of probes, e.g. for testing a
  // handful of historical probes without sweeping the whole sheet. Absent
  // (the default) processes every probe, unchanged from before this option.
  const probeIdFilter = opts.probeIds ? new Set(opts.probeIds) : null;

  // 1) BATCH LOAD — exactly one read of each table for the whole rebuild.
  // DIAGNOSIS is read too, ONLY to know which probes are already finalised
  // (frozen) — never written here.
  const [probesTable, communicationsTable, intelligenceTable, diagnosisTable] = await Promise.all([
    repo.getTable('PROBES'),
    repo.getTable('COMMUNICATIONS'),
    repo.getTable('INTELLIGENCE'),
    repo.getTable('DIAGNOSIS'),
  ]);

  const probeRecords = recordsFromTable(probesTable, 'probe_id');
  const communicationRecords = recordsFromTable(communicationsTable, 'communication_id');
  // 'probe_id', not 'intelligence_id': INTELLIGENCE is guaranteed exactly one
  // row per probe_id (see the upsert below), which is already the row's real
  // identity — intelligence_id is a decorative extra key, never required to
  // exist as a sheet column. Keying the read on it meant a live sheet whose
  // header simply doesn't carry that column (e.g. the V2 header, which lists
  // probe_id but not intelligence_id) had every existing row read back as
  // "doesn't exist", breaking both update-in-place (every rebuild re-created
  // every row) and anything downstream that reads this table by probe_id
  // (lib/diagnosis-rebuild.mjs's INTELLIGENCE read had the identical bug —
  // see that file).
  const intelligenceRecords = recordsFromTable(intelligenceTable, 'probe_id');
  const diagnosisRecords = recordsFromTable(diagnosisTable, 'probe_id');

  // Same "finalised" signal as lib/diagnosis-rebuild.mjs's needsDiagnosis():
  // a non-blank diagnosis_summary means this probe's Diagnosis (and the
  // Intelligence it was generated from) is frozen for good.
  const finalizedProbeIds = new Set(
    diagnosisRecords.filter((r) => String(r.obj.diagnosis_summary || '').trim()).map((r) => r.obj.probe_id)
  );

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
  let remainingInterpretations = 0;
  let probesFinalizedSkipped = 0;
  const problems = [];
  const results = [];
  const communicationPatchesById = new Map();
  const intelligenceUpsertsByProbe = new Map();
  const probePatchesById = new Map();

  for (const rec of probeRecords) {
    const probe = rec.obj;
    const probeId = probe.probe_id;

    // Targeting filter: skip silently, before anything else.
    if (probeIdFilter && !probeIdFilter.has(probeId)) continue;

    // Frozen: this probe already has its final Intelligence + Diagnosis.
    // Skip before touching anything else, forceAi included.
    if (finalizedProbeIds.has(probeId)) {
      probesFinalizedSkipped += 1;
      continue;
    }

    const probeCommunications = communicationsByProbe.get(probeId) || [];
    if (probeCommunications.length > 0) probesWithCommunications += 1; else probesWithZeroCommunications += 1;

    // Budget exhausted and this probe would need an AI call: skip it
    // entirely this round (no write), leave it for the next call. Its
    // communication_quality stays blank, so needsAiInterpretation() will
    // pick it up again next time.
    const existingRecordPeek = intelligenceByProbe.get(probeId) || null;
    if (aiInterpretationsRun >= maxAiCalls && needsAiInterpretation(existingRecordPeek, forceAi)) {
      remainingInterpretations += 1;
      continue;
    }

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

      // PROBES self-heal patch — deadline backfill and/or status close,
      // whichever apply this round. Built up in memory; written in the
      // batch pass below alongside everything else.
      const probePatch = {};

      // Historical probes never had observation_deadline written (it's a
      // PROBES column that predates this schema). computeDeterministicIntelligence
      // already derives it via lib/grading.mjs's resolveObservationDeadline()
      // (probe_timestamp + 4 days) whenever probe.observation_deadline is
      // blank — det.observation_deadline IS that derived value. Persist it
      // back onto PROBES exactly once so it stops being derived-on-the-fly
      // every rebuild; a probe that already HAS an observation_deadline is
      // never touched here (`!probe.observation_deadline` guards it).
      if (!probe.observation_deadline && det.observation_deadline) {
        probePatch.observation_deadline = det.observation_deadline;
      }

      // The probe itself closes the moment its 4-day window elapses — flip
      // the existing PROBES.probe_status lifecycle field (draft ->
      // observing -> closed) rather than adding a new column. This is
      // independent of whether Diagnosis succeeds this round: "the probe
      // closes" and "Diagnosis is generated" are two separate steps in the
      // lifecycle, and probe_status tracks the first one. Applies just as
      // much to a probe whose deadline was only just derived above — a
      // historical probe whose derived deadline has already passed closes
      // in this same pass.
      if (det.observation_status === 'closed' && probe.probe_status !== 'closed') {
        probePatch.probe_status = 'closed';
      }

      if (Object.keys(probePatch).length > 0) {
        probePatchesById.set(probeId, probePatch);
      }

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

  const probeRowById = new Map(probeRecords.map((rec) => [rec.obj.probe_id, rec]));
  for (const [probeId, patch] of probePatchesById) {
    const existing = probeRowById.get(probeId);
    if (!existing) continue;
    const merged = { ...existing.obj, ...patch };
    const row = probesTable.header.map((key) => (merged[key] ?? ''));
    writes.push({ tab: 'PROBES', rowNumber: existing.rowNumber, row });
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
    remaining_interpretations: remainingInterpretations,
    probes_finalized_skipped: probesFinalizedSkipped,
    problems,
    results,
  };
}
