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
//   4. AI INTERPRETATION — lib/probe-interpretation.mjs reads the complete,
//      ordered communication content and produces the eight AI-derived
//      INTELLIGENCE fields. Always runs here: a communication just arrived,
//      so the evidence has definitely changed.
//   5. Upsert exactly one INTELLIGENCE row for this probe.
//   6. DIAGNOSIS — only once observation_status is 'closed': lib/probe-diagnosis.mjs
//      reads the just-written INTELLIGENCE row and produces the nine
//      DIAGNOSIS fields. Upserts exactly one DIAGNOSIS row.
//
// Callers: this module never touches req/res, auth, or Twilio/TwiML — it
// takes a repo + probe_id and returns a plain result object, or null if the
// probe doesn't exist.

import { newIntelligenceId, newDiagnosisId } from './ids.mjs';
import { interpretCommunication } from './classification.mjs';
import { computeDeterministicIntelligence } from './intelligence-fields.mjs';
import { interpretProbe } from './probe-interpretation.mjs';
import { diagnoseProbe } from './probe-diagnosis.mjs';

function isOverridden(comm) {
  return comm.manual_override === 'TRUE' || comm.manual_override === true;
}

// Returns the recompute result, or null if probeId doesn't exist in PROBES.
export async function recomputeProbeObservation(repo, probeId) {
  const probeRecord = await repo.findById('PROBES', 'probe_id', probeId);
  if (!probeRecord) return null;
  const probe = probeRecord.obj;

  // Only communications deterministically matched to THIS probe — never
  // agency-level guessing, never re-running the deterministic matching.
  const allCommunications = await repo.getRecords('COMMUNICATIONS', 'communication_id');
  const probeCommunications = allCommunications.filter((r) => r.obj.probe_id === probeId);

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

  // 4) AI INTERPRETATION — always runs: a communication just arrived.
  const ai = await interpretProbe(probe, classified);

  const intelligencePatch = {
    agency_id: probe.agency_id || '',
    probe_id: probeId,
    ...det,
    ...ai,
    updated_at: now.toISOString(),
  };

  // Upsert — idempotent: exactly one INTELLIGENCE row per probe, updated
  // in place on every recompute rather than duplicated. Matched (both the
  // read and the update-locate) by probe_id, NOT intelligence_id: probe_id
  // is the row's real identity (INTELLIGENCE is one row per probe_id by
  // construction) and is guaranteed to exist in the sheet header, unlike the
  // decorative intelligence_id column — a header that omits it (e.g. the V2
  // header) must not make every existing row read back as "doesn't exist".
  const existingIntelligence = await repo.getRecords('INTELLIGENCE', 'probe_id');
  const existingIntel = existingIntelligence.find((r) => r.obj.probe_id === probeId);

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

  // 6) DIAGNOSIS — only once the observation window has actually closed.
  let diagnosisId = null;
  if (det.observation_status === 'closed') {
    const intelligenceRow = { ...intelligencePatch, intelligence_id: intelligenceId };
    const diagnosis = await diagnoseProbe(intelligenceRow, probe);

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
  }

  return {
    intelligence_id: intelligenceId,
    diagnosis_id: diagnosisId,
    probe_id: probeId,
    grade: det.grade,
    grade_reason: det.grade_reason,
    observation_status: det.observation_status,
    communications_updated: communicationsUpdated,
  };
}
