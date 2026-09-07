// lib/observation-recompute.mjs — the single-probe recompute path, shared
// by the human-triggered HTTP endpoint (api/novus/intelligence/rebuild-all.js,
// when body.probe_id is present) and the communications webhooks
// (api/novus/webhooks/*.js), so both call the SAME code path in-process.
//
// V2 flow (docs/V2_COMMS_INTELLIGENCE_DIAGNOSIS_SCHEMA.md §6):
//   1. Read the PROBES row + every COMMUNICATIONS row already deterministically
//      matched to this probe_id (matching itself is untouched — reads its
//      output, never re-runs or second-guesses it).
//   2. INTERPRETATION (deterministic) — classify any not-yet-classified
//      COMMUNICATIONS row (lib/classification.mjs) and write back ONLY
//      automated_or_human, the one per-message fact the deterministic
//      rollups need. The rest of what classification.mjs can produce
//      (communication_classification, booking_attempt, contact_quality,
//      follow_up) is no longer written to COMMUNICATIONS — those questions
//      are now the AI interpretation pass below, at the probe level, reading
//      real content instead of a phrase list.
//   3. DETERMINISTIC ROLLUP — lib/intelligence-fields.mjs (which itself
//      reuses lib/observation.mjs's §9 30-minute grouping and lib/grading.mjs's
//      unchanged A-H rules) turns the classified communications into the ten
//      deterministic INTELLIGENCE fields, including the grade.
//   4. NO AI CALL WHILE THE PROBE IS STILL OBSERVING. This step used to run a
//      full model interpretation on EVERY inbound communication — "a
//      communication just arrived, so the evidence has definitely changed" —
//      which meant a chatty agency cost one Anthropic call per message, every
//      one of them reading a conversation that had not finished and every one
//      of them overwritten by the next. An observing probe now writes only its
//      deterministic fields, and its semantic columns are left exactly as they
//      are (blank on a new row, preserved on an existing one).
//   5. Upsert exactly one INTELLIGENCE row for this probe.
//   6. FINAL ASSESSMENT — only once observation_status is 'closed', and only
//      once ever. lib/probe-assessment.mjs makes ONE model call that produces
//      BOTH the semantic INTELLIGENCE fields and the commercial DIAGNOSIS, then
//      upserts exactly one DIAGNOSIS row and — through the same writer the
//      batch path uses — exactly one DIAGNOSIS_FINDINGS row per finding. The
//      canonical structured record is the DIAGNOSIS row's own findings JSON;
//      the findings rows are the audit projection of it.
//
// Callers: this module never touches req/res, auth, or Twilio/TwiML — it
// takes a repo + probe_id and returns a plain result object, or null if the
// probe doesn't exist.
//
// FROZEN PROBES: once a probe has a DIAGNOSIS row with a non-blank
// diagnosis_summary it is finalised — its Intelligence and Diagnosis were
// already computed from everything received during its 4-day observation
// window, and step 6 above must never regenerate or overwrite them again
// (probe lifecycle requirement). In normal operation this path is never
// even reached for a finalised probe: lib/matching.mjs's matchProbe() only
// attaches new communications to a probe while probe_status is 'observing'
// AND now is still inside [probe_timestamp, observation_deadline], so a
// message arriving after the window closes comes back unmatched (probe_id
// '') and this function is never called for it from the webhooks. The guard
// below is defence-in-depth for the other caller — the human-triggered
// single-probe endpoint (api/novus/intelligence/rebuild-all.js body.probe_id)
// — which could otherwise be pointed at an already-finalised probe_id
// directly and would, without this check, silently re-spend an AI call and
// overwrite a supposedly-frozen Diagnosis.

import { newIntelligenceId, newDiagnosisId } from './ids.mjs';
import { interpretCommunication } from './classification.mjs';
import { computeDeterministicIntelligence } from './intelligence-fields.mjs';
import { assessProbe } from './probe-assessment.mjs';
import { ASSESSMENT_INTELLIGENCE_FIELDS } from './probe-assessment.mjs';
import { parseDiagnosisFindings } from './probe-diagnosis.mjs';
import { loadFindingsTable, createFindingsWriter } from './diagnosis-findings.mjs';
import { isDeletedCommunication } from './communication-status.mjs';

function isOverridden(comm) {
  return comm.manual_override === 'TRUE' || comm.manual_override === true;
}

// Returns the recompute result, or null if probeId doesn't exist in PROBES.
export async function recomputeProbeObservation(repo, probeId) {
  const probeRecord = await repo.findById('PROBES', 'probe_id', probeId);
  if (!probeRecord) return null;
  const probe = probeRecord.obj;

  // Frozen check — see the file header. No AI call, no write, if this
  // probe's Diagnosis was already finalised.
  const existingDiagnosisRecord = await repo.findById('DIAGNOSIS', 'probe_id', probeId);
  if (existingDiagnosisRecord && String(existingDiagnosisRecord.obj.diagnosis_summary || '').trim()) {
    const existingIntelligenceRecord = await repo.findById('INTELLIGENCE', 'probe_id', probeId);
    const intelligence = existingIntelligenceRecord ? existingIntelligenceRecord.obj : {};
    return {
      intelligence_id: intelligence.intelligence_id || '',
      diagnosis_id: existingDiagnosisRecord.obj.diagnosis_id || '',
      probe_id: probeId,
      grade: intelligence.grade || '',
      grade_reason: intelligence.grade_reason || '',
      observation_status: 'closed',
      communications_updated: 0,
      finalized: true,
      frozen: true,
    };
  }

  // Only communications deterministically matched to THIS probe — never
  // agency-level guessing, never re-running the deterministic matching.
  // Deleted communications (match_status = 'deleted') are tombstoned
  // evidence and must never re-enter this probe's calculations.
  const allCommunications = await repo.getRecords('COMMUNICATIONS', 'communication_id');
  const probeCommunications = allCommunications.filter((r) => r.obj.probe_id === probeId && !isDeletedCommunication(r.obj));

  // 2) INTERPRETATION (deterministic) — automated_or_human only.
  let communicationsUpdated = 0;
  const classified = [];
  for (const record of probeCommunications) {
    const comm = record.obj;

    if (isOverridden(comm)) {
      classified.push(comm);
      continue;
    }

    // interpretCommunication() also derives communication_classification
    // (needed in-memory by lib/observation.mjs to detect auto-acknowledgement
    // — see its computeObservation()) and booking_attempt. Neither is
    // persisted to COMMUNICATIONS any more (V2 schema §2.3 retires both as
    // sheet columns — that judgement now lives on INTELLIGENCE, AI-derived),
    // but computeObservation() below still needs them on the in-memory
    // object it's given, so only the SHEET WRITE is trimmed to
    // automated_or_human, not the object handed to the deterministic rollup.
    const patch = interpretCommunication(comm, { probeTimestamp: probe.probe_timestamp });
    const automatedOrHuman = patch.automated_or_human;

    if (String(comm.automated_or_human || '') !== automatedOrHuman) {
      await repo.updateById('COMMUNICATIONS', 'communication_id', comm.communication_id, { automated_or_human: automatedOrHuman });
      communicationsUpdated += 1;
    }
    classified.push({ ...comm, ...patch });
  }

  // 3) DETERMINISTIC ROLLUP — unchanged A-H engine underneath.
  const now = new Date();
  const det = computeDeterministicIntelligence(probe, classified, now);

  // PROBES self-heal patch, same as the batch path (lib/intelligence-
  // rebuild.mjs): backfill a blank observation_deadline (probe_timestamp +
  // 4 days — det.observation_deadline already IS that derived value, since
  // computeDeterministicIntelligence falls back to it whenever
  // probe.observation_deadline is blank), and flip probe_status to 'closed'
  // once the window elapses. A probe that already has an observation_deadline
  // is never touched.
  const probePatch = {};
  if (!probe.observation_deadline && det.observation_deadline) {
    probePatch.observation_deadline = det.observation_deadline;
  }
  if (det.observation_status === 'closed' && probe.probe_status !== 'closed') {
    probePatch.probe_status = 'closed';
  }
  if (Object.keys(probePatch).length > 0) {
    await repo.updateById('PROBES', 'probe_id', probeId, probePatch);
  }

  // 4) SEMANTIC FIELDS — carried forward untouched. Nothing here calls a model:
  // see step 4 in the file header.
  const existingIntelligenceRecord = await repo.findById('INTELLIGENCE', 'probe_id', probeId);
  const carriedSemantic = Object.fromEntries(
    ASSESSMENT_INTELLIGENCE_FIELDS.map((field) => [field, existingIntelligenceRecord?.obj?.[field] || '']),
  );

  const intelligencePatch = {
    agency_id: probe.agency_id || '',
    probe_id: probeId,
    ...det,
    ...carriedSemantic,
    updated_at: now.toISOString(),
  };

  // Upsert — idempotent: exactly one INTELLIGENCE row per probe, updated
  // in place on every recompute rather than duplicated. Matched (both the
  // read and the update-locate) by probe_id, NOT intelligence_id: probe_id
  // is the row's real identity (INTELLIGENCE is one row per probe_id by
  // construction) and is guaranteed to exist in the sheet header, unlike the
  // decorative intelligence_id column — a header that omits it (e.g. the V2
  // header) must not make every existing row read back as "doesn't exist".
  const existingIntel = existingIntelligenceRecord;

  let intelligenceId;
  if (existingIntel) {
    intelligenceId = existingIntel.obj.intelligence_id;
    await repo.updateById('INTELLIGENCE', 'probe_id', probeId, intelligencePatch);
  } else {
    intelligenceId = newIntelligenceId();
    await repo.appendRecord('INTELLIGENCE', {
      intelligence_id: intelligenceId,
      ...intelligencePatch,
      created_at: now.toISOString(),
    });
  }

  // 6) FINAL ASSESSMENT — only once the observation window has actually
  // closed, and exactly one AI call when it does.
  let diagnosisId = null;
  let findingsWritten = 0;
  let aiCallsUsed = 0;
  if (det.observation_status === 'closed') {
    const { intelligence: semantic, diagnosis, ai_calls_used: used = 1 } = await assessProbe(probe, classified, {
      ...intelligencePatch,
      intelligence_id: intelligenceId,
    });
    aiCallsUsed = used;

    // The assessment's semantic fields are patched back onto the INTELLIGENCE
    // row written above — the deterministic columns it just wrote are left
    // exactly as they are.
    const semanticPatch = Object.fromEntries(
      ASSESSMENT_INTELLIGENCE_FIELDS.map((field) => [field, semantic?.[field] ?? '']),
    );
    await repo.updateById('INTELLIGENCE', 'probe_id', probeId, { ...semanticPatch, updated_at: now.toISOString() });

    // Same probe_id-keyed matching as INTELLIGENCE above, for the same reason.
    const existingDiagnoses = await repo.getRecords('DIAGNOSIS', 'probe_id');
    const existingDiag = existingDiagnoses.find((r) => r.obj.probe_id === probeId);

    const diagnosisPatch = {
      agency_id: probe.agency_id || '',
      probe_id: probeId,
      ...diagnosis,
      updated_at: now.toISOString(),
    };

    if (existingDiag) {
      diagnosisId = existingDiag.obj.diagnosis_id;
      await repo.updateById('DIAGNOSIS', 'probe_id', probeId, diagnosisPatch);
    } else {
      diagnosisId = newDiagnosisId();
      await repo.appendRecord('DIAGNOSIS', {
        diagnosis_id: diagnosisId,
        ...diagnosisPatch,
        created_at: now.toISOString(),
      });
    }

    // 6b) DIAGNOSIS_FINDINGS — the audit projection of the canonical findings
    // JSON this assessment just wrote onto the DIAGNOSIS row. Written through
    // the same stateful writer the batch path uses, so the
    // one-row-per-(probe_id, finding_index) invariant holds identically here.
    const findingsTable = await loadFindingsTable(repo);
    const findingsWriter = createFindingsWriter(findingsTable);
    findingsWriter.write(probeId, parseDiagnosisFindings(diagnosis));
    findingsWritten = findingsWriter.findingsWritten();
    const findingsWrites = findingsWriter.writes();
    if (findingsWrites.length > 0) await repo.writeRowsBatch(findingsWrites);
  }

  return {
    intelligence_id: intelligenceId,
    diagnosis_id: diagnosisId,
    findings_written: findingsWritten,
    ai_calls_used: aiCallsUsed,
    probe_id: probeId,
    grade: det.grade,
    grade_reason: det.grade_reason,
    observation_status: det.observation_status,
    communications_updated: communicationsUpdated,
    finalized: Boolean(diagnosisId),
    frozen: false,
  };
}
