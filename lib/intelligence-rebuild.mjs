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
// THIS STEP MAKES ZERO AI CALLS. It used to run lib/probe-interpretation.mjs
// against any probe whose INTELLIGENCE row had never been interpreted —
// including probes still inside their observation window, whose evidence was
// by definition incomplete and still arriving. That is money spent reading a
// conversation that has not finished, and it consumed the shared budget the
// later stages needed.
//
// Semantic interpretation now happens exactly once, at the moment the probe
// CLOSES, inside the single final assessment call (lib/probe-assessment.mjs,
// driven by lib/assessment-rebuild.mjs). Until then a probe's INTELLIGENCE row
// carries only what can be objectively derived — response timing, response
// hours, contact attempts, follow-ups, channels, human/automated
// classification, grade, observation status — and its semantic columns
// (viewing_progression, buyer_qualification, buyer_questions_asked,
// seller_recognition, communication_quality, did_well, missed, evidence) stay
// exactly as they are: BLANK on a new row, and PRESERVED verbatim on a row that
// already carries them, so a historical interpretation is never erased by a
// deterministic recompute.
//
// opts.forceAi is accepted and ignored here; it survives only so existing
// callers and tests keep working. There is nothing left in this step for it to
// force.
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
import { ASSESSMENT_INTELLIGENCE_FIELDS } from './probe-assessment.mjs';
import { derivePropertyStreetFromAddress } from './property-reference.mjs';
import { isDeletedCommunication } from './communication-status.mjs';

function isOverridden(comm) {
  return comm.manual_override === 'TRUE' || comm.manual_override === true;
}

// Same row-filtering rule as repo.getRecords(): skip any row whose id column
// is empty or the literal "SCHEMA NOTE" (row 1 = header, row 2 = schema
// note, row 3+ = data). Duplicated here because the batch load below reads
// each tab via getTable() directly, once, instead of through getRecords().
// idVal is TRIMMED and written back onto obj[idColumn] — the same fix as
// lib/diagnosis-rebuild.mjs's and lib/personalisation-rebuild.mjs's own
// recordsFromTable, applied here too because this is where `probeId` first
// gets sourced for the whole rebuild pass: if INTELLIGENCE's own probe_id
// carries a stray leading/trailing space and this function left it
// untrimmed while the other two now trim theirs, the downstream
// diagnosisByProbe.get(probeId) / personalisationByProbe.get(probeId)
// lookups would go from "might accidentally match" to "guaranteed to miss"
// — trimming all three consistently is what actually closes this off.
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

// The semantic columns this step must NEVER touch. It preserves whatever the
// row already holds (a historical interpretation, or the assessment's own
// output) and writes '' only on a brand-new row that has never had one.
function preservedSemanticFields(existingRecord) {
  const stored = existingRecord?.obj || {};
  return Object.fromEntries(ASSESSMENT_INTELLIGENCE_FIELDS.map((field) => [field, stored[field] || '']));
}

// repo, opts?: { forceAi?: boolean, maxAiCalls?: number } -> { probes_processed,
//   probes_with_communications, probes_with_zero_communications,
//   intelligence_created, intelligence_updated, ai_interpretations_run,
//   remaining_interpretations, probes_finalized_skipped, problems, results }
//
// maxAiCalls is accepted and ignored: this step no longer makes AI calls, so
// there is nothing here for a budget to bound. It stays in the signature
// because every other rebuild step takes the same options object.
//
// ai_interpretations_run and remaining_interpretations are still reported, and
// are now always 0 — kept so existing dashboards and self-tests that read the
// summary keep working while the number itself proves the saving.
export async function rebuildAllIntelligence(repo, opts = {}) {
  // Accepted and ignored — see the file header. No AI call remains to force.
  void opts.forceAi;
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

  // PROPERTY_STREET SELF-HEAL — runs over EVERY probe, before the skip
  // filters, because the probes that need it most are exactly the finalised
  // historical ones the loop below never visits. New probes store
  // property_address only (api/novus/probe.js writes no property_street), which
  // used to strand them at the last OUTBOUND gate with "missing
  // property_street". Filling the blank cell from the address here is a
  // one-way, one-time repair: a NONBLANK stored value is never overwritten,
  // and a probe with no derivable address is left alone rather than given an
  // invented street. See lib/property-reference.mjs — OUTBOUND no longer
  // depends on this having run, so it is a tidy-up, not a prerequisite.
  const probeStreetPatches = new Map();
  if (probesTable.header.includes('property_street')) {
    for (const rec of probeRecords) {
      if (String(rec.obj.property_street || '').trim()) continue;
      const derived = derivePropertyStreetFromAddress(rec.obj.property_address);
      if (derived) probeStreetPatches.set(rec.obj.probe_id, { property_street: derived });
    }
  }

  const communicationsByProbe = new Map();
  const communicationRowById = new Map();
  for (const rec of communicationRecords) {
    communicationRowById.set(rec.obj.communication_id, rec);
    const probeId = rec.obj.probe_id;
    if (!probeId || isDeletedCommunication(rec.obj)) continue;
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

      // 2c) SEMANTIC FIELDS — carried forward, never recomputed and never
      // blanked. They are written once, by the final assessment, at close.
      const existingRecord = intelligenceByProbe.get(probeId) || null;
      const aiFields = preservedSemanticFields(existingRecord);

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
  // Merge the street self-heal into the same per-probe patch map, so a probe
  // that also needs a deadline backfill or a status close leaves ONE write
  // behind rather than two writes to the same range (writeRowsBatch collapses
  // those last-one-wins, which would silently drop whichever patch lost).
  let propertyStreetBackfilled = 0;
  for (const [probeId, patch] of probeStreetPatches) {
    probePatchesById.set(probeId, { ...(probePatchesById.get(probeId) || {}), ...patch });
    propertyStreetBackfilled += 1;
  }
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
    // Structurally zero: this step contains no AI call at all.
    ai_interpretations_run: 0,
    remaining_interpretations: 0,
    probes_finalized_skipped: probesFinalizedSkipped,
    property_street_backfilled: propertyStreetBackfilled,
    problems,
    results,
  };
}
