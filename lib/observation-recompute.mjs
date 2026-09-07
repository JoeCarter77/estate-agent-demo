// lib/observation-recompute.mjs — single-probe evidence recompute.
//
// Communications can arrive many times during a four-day observation window.
// Re-running a full model interpretation after every email/call/SMS was both
// expensive and unnecessary for acquisition: the final commercial assessment
// is only consumed once the observation is complete. While a probe is open we
// therefore keep the rolling fields deterministic (classification, timings,
// attempts, grade) and defer semantic AI interpretation until closure.
//
// Once closed, the existing interpretation -> diagnosis contracts run exactly
// once and the probe is frozen by diagnosis_summary as before.

import { newIntelligenceId, newDiagnosisId } from './ids.mjs';
import { interpretCommunication } from './classification.mjs';
import { computeDeterministicIntelligence } from './intelligence-fields.mjs';
import { interpretProbe } from './probe-interpretation.mjs';
import { diagnoseProbe, parseDiagnosisFindings } from './probe-diagnosis.mjs';
import { loadFindingsTable, createFindingsWriter } from './diagnosis-findings.mjs';
import { isDeletedCommunication } from './communication-status.mjs';
import { createCachedRepo } from './cached-repo.mjs';

function isOverridden(comm) {
  return comm.manual_override === 'TRUE' || comm.manual_override === true;
}

function storedAiFields(record) {
  const stored = record?.obj || {};
  return {
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

// Returns the recompute result, or null if probeId doesn't exist in PROBES.
export async function recomputeProbeObservation(repo, probeId) {
  const workRepo = createCachedRepo(repo);
  const probeRecord = await workRepo.findById('PROBES', 'probe_id', probeId);
  if (!probeRecord) return null;
  const probe = probeRecord.obj;

  // Frozen check: a completed diagnosis locks both final Intelligence and
  // Diagnosis. No model call and no write can occur afterwards.
  const existingDiagnosisRecord = await workRepo.findById('DIAGNOSIS', 'probe_id', probeId);
  if (existingDiagnosisRecord && String(existingDiagnosisRecord.obj.diagnosis_summary || '').trim()) {
    const existingIntelligenceRecord = await workRepo.findById('INTELLIGENCE', 'probe_id', probeId);
    const intelligence = existingIntelligenceRecord ? existingIntelligenceRecord.obj : {};
    return {
      intelligence_id: intelligence.intelligence_id || '',
      diagnosis_id: existingDiagnosisRecord.obj.diagnosis_id || '',
      probe_id: probeId,
      grade: intelligence.grade || '',
      grade_reason: intelligence.grade_reason || '',
      observation_status: 'closed',
      communications_updated: 0,
      ai_interpretation_run: false,
      finalized: true,
      frozen: true,
    };
  }

  const allCommunications = await workRepo.getRecords('COMMUNICATIONS', 'communication_id');
  const probeCommunications = allCommunications.filter(
    (record) => record.obj.probe_id === probeId && !isDeletedCommunication(record.obj),
  );

  // Narrow deterministic classification. Only automated_or_human is persisted;
  // the other deterministic helper fields stay in memory for the rollup.
  let communicationsUpdated = 0;
  const classified = [];
  for (const record of probeCommunications) {
    const comm = record.obj;
    if (isOverridden(comm)) {
      classified.push(comm);
      continue;
    }

    const patch = interpretCommunication(comm, { probeTimestamp: probe.probe_timestamp });
    const automatedOrHuman = patch.automated_or_human;
    if (String(comm.automated_or_human || '') !== automatedOrHuman) {
      await workRepo.updateById('COMMUNICATIONS', 'communication_id', comm.communication_id, {
        automated_or_human: automatedOrHuman,
      });
      communicationsUpdated += 1;
    }
    classified.push({ ...comm, ...patch });
  }

  const now = new Date();
  const det = computeDeterministicIntelligence(probe, classified, now);

  const probePatch = {};
  if (!probe.observation_deadline && det.observation_deadline) {
    probePatch.observation_deadline = det.observation_deadline;
  }
  if (det.observation_status === 'closed' && probe.probe_status !== 'closed') {
    probePatch.probe_status = 'closed';
  }
  if (Object.keys(probePatch).length > 0) {
    await workRepo.updateById('PROBES', 'probe_id', probeId, probePatch);
  }

  // Find the existing row before deciding whether semantic interpretation is
  // needed. Open probes preserve any legacy AI fields that were produced under
  // the old eager behaviour, but never spend another model call while open.
  const existingIntelligence = await workRepo.getRecords('INTELLIGENCE', 'probe_id');
  const existingIntel = existingIntelligence.find((record) => record.obj.probe_id === probeId) || null;

  let aiInterpretationRun = false;
  let ai = storedAiFields(existingIntel);
  if (det.observation_status === 'closed') {
    ai = await interpretProbe(probe, classified);
    aiInterpretationRun = true;
  }

  const intelligencePatch = {
    agency_id: probe.agency_id || '',
    probe_id: probeId,
    ...det,
    ...ai,
    updated_at: now.toISOString(),
  };

  let intelligenceId;
  if (existingIntel) {
    intelligenceId = existingIntel.obj.intelligence_id;
    await workRepo.updateById('INTELLIGENCE', 'probe_id', probeId, intelligencePatch);
  } else {
    intelligenceId = newIntelligenceId();
    await workRepo.appendRecord('INTELLIGENCE', {
      intelligence_id: intelligenceId,
      ...intelligencePatch,
      created_at: now.toISOString(),
    });
  }

  // Diagnosis is terminal acquisition reasoning and only exists for a closed
  // observation. The final Intelligence above already contains the one semantic
  // interpretation made from the complete evidence window.
  let diagnosisId = null;
  let findingsWritten = 0;
  if (det.observation_status === 'closed') {
    const intelligenceRow = { ...intelligencePatch, intelligence_id: intelligenceId };
    const diagnosis = await diagnoseProbe(intelligenceRow, probe);

    const existingDiagnoses = await workRepo.getRecords('DIAGNOSIS', 'probe_id');
    const existingDiag = existingDiagnoses.find((record) => record.obj.probe_id === probeId);
    const diagnosisPatch = {
      agency_id: probe.agency_id || '',
      probe_id: probeId,
      ...diagnosis,
      updated_at: now.toISOString(),
    };

    if (existingDiag) {
      diagnosisId = existingDiag.obj.diagnosis_id;
      await workRepo.updateById('DIAGNOSIS', 'probe_id', probeId, diagnosisPatch);
    } else {
      diagnosisId = newDiagnosisId();
      await workRepo.appendRecord('DIAGNOSIS', {
        diagnosis_id: diagnosisId,
        ...diagnosisPatch,
        created_at: now.toISOString(),
      });
    }

    const findingsTable = await loadFindingsTable(workRepo);
    const findingsWriter = createFindingsWriter(findingsTable);
    findingsWriter.write(probeId, parseDiagnosisFindings(diagnosis));
    findingsWritten = findingsWriter.findingsWritten();
    const findingsWrites = findingsWriter.writes();
    if (findingsWrites.length > 0) await workRepo.writeRowsBatch(findingsWrites);
  }

  return {
    intelligence_id: intelligenceId,
    diagnosis_id: diagnosisId,
    findings_written: findingsWritten,
    probe_id: probeId,
    grade: det.grade,
    grade_reason: det.grade_reason,
    observation_status: det.observation_status,
    communications_updated: communicationsUpdated,
    ai_interpretation_run: aiInterpretationRun,
    finalized: Boolean(diagnosisId),
    frozen: false,
  };
}
