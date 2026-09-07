// Acquisition INTELLIGENCE rebuild.
//
// The sales acquisition path only needs semantic model interpretation once the
// four-day evidence window is complete. Open probes remain fully deterministic.
// Closed probes with communications receive exactly one final interpretation
// from the complete evidence set; zero-communication probes are handled by
// interpretProbe's deterministic branch and consume no AI budget.
//
// Model calls are run with bounded concurrency so a daily cron can finalise a
// realistic day's probe volume without serially waiting on every request.

import { newIntelligenceId } from './ids.mjs';
import { interpretCommunication } from './classification.mjs';
import { computeDeterministicIntelligence } from './intelligence-fields.mjs';
import { interpretProbe } from './probe-interpretation.mjs';
import { isDeletedCommunication } from './communication-status.mjs';

function recordsFromTable({ header, rows }, idColumn) {
  const idIdx = header.indexOf(idColumn);
  const out = [];
  (rows || []).forEach((row, index) => {
    const idVal = idIdx >= 0 ? String(row[idIdx] ?? '').trim() : '';
    if (!idVal || idVal === 'SCHEMA NOTE') return;
    const obj = {};
    header.forEach((key, colIdx) => { obj[key] = row[colIdx] ?? ''; });
    if (idIdx >= 0) obj[idColumn] = idVal;
    out.push({ rowNumber: index + 2, obj });
  });
  return out;
}

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

async function mapWithConcurrency(items, concurrency, worker) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let cursor = 0;
  const count = Math.max(1, Math.min(items.length, Math.floor(Number(concurrency)) || 1));
  await Promise.all(Array.from({ length: count }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

export async function rebuildAcquisitionIntelligence(repo, opts = {}) {
  const maxAiCalls = Number.isFinite(opts.maxAiCalls) ? Math.max(0, Math.floor(opts.maxAiCalls)) : Infinity;
  const aiConcurrency = Number.isFinite(Number(opts.aiConcurrency))
    ? Math.max(1, Math.min(10, Math.floor(Number(opts.aiConcurrency))))
    : Math.max(1, Math.min(10, Number(process.env.NOVUS_REBUILD_AI_CONCURRENCY) || 6));
  const probeIdFilter = opts.probeIds ? new Set(opts.probeIds) : null;

  const [probesTable, communicationsTable, intelligenceTable, diagnosisTable] = await Promise.all([
    repo.getTable('PROBES'),
    repo.getTable('COMMUNICATIONS'),
    repo.getTable('INTELLIGENCE'),
    repo.getTable('DIAGNOSIS'),
  ]);

  const probeRecords = recordsFromTable(probesTable, 'probe_id');
  const communicationRecords = recordsFromTable(communicationsTable, 'communication_id');
  const intelligenceRecords = recordsFromTable(intelligenceTable, 'probe_id');
  const diagnosisRecords = recordsFromTable(diagnosisTable, 'probe_id');

  const finalizedProbeIds = new Set(
    diagnosisRecords
      .filter((record) => String(record.obj.diagnosis_summary || '').trim())
      .map((record) => record.obj.probe_id),
  );
  const intelligenceByProbe = new Map(intelligenceRecords.map((record) => [record.obj.probe_id, record]));

  const communicationsByProbe = new Map();
  for (const record of communicationRecords) {
    const comm = record.obj;
    if (!comm.probe_id || isDeletedCommunication(comm)) continue;
    if (!communicationsByProbe.has(comm.probe_id)) communicationsByProbe.set(comm.probe_id, []);
    communicationsByProbe.get(comm.probe_id).push(comm);
  }

  const now = new Date();
  const communicationWrites = [];
  const probeWrites = [];
  const immediate = [];
  const aiCandidates = [];
  const problems = [];
  let probesFinalizedSkipped = 0;
  let skippedOpen = 0;
  let remainingInterpretations = 0;
  let probesWithCommunications = 0;
  let probesWithZeroCommunications = 0;

  for (const record of probeRecords) {
    const probe = record.obj;
    const probeId = probe.probe_id;
    if (probeIdFilter && !probeIdFilter.has(probeId)) continue;
    if (finalizedProbeIds.has(probeId)) {
      probesFinalizedSkipped += 1;
      continue;
    }

    try {
      const sourceCommunications = communicationsByProbe.get(probeId) || [];
      if (sourceCommunications.length) probesWithCommunications += 1;
      else probesWithZeroCommunications += 1;

      const classified = [];
      for (const comm of sourceCommunications) {
        if (isOverridden(comm)) {
          classified.push(comm);
          continue;
        }
        const patch = interpretCommunication(comm, { probeTimestamp: probe.probe_timestamp });
        if (String(comm.automated_or_human || '') !== patch.automated_or_human) {
          const commRecord = communicationRecords.find((candidate) => candidate.obj.communication_id === comm.communication_id);
          if (commRecord) {
            const merged = { ...commRecord.obj, automated_or_human: patch.automated_or_human };
            communicationWrites.push({
              tab: 'COMMUNICATIONS',
              rowNumber: commRecord.rowNumber,
              row: communicationsTable.header.map((key) => merged[key] ?? ''),
            });
          }
        }
        classified.push({ ...comm, ...patch });
      }

      const det = computeDeterministicIntelligence(probe, classified, now);
      const probePatch = {};
      if (!probe.observation_deadline && det.observation_deadline) probePatch.observation_deadline = det.observation_deadline;
      if (det.observation_status === 'closed' && probe.probe_status !== 'closed') probePatch.probe_status = 'closed';
      if (Object.keys(probePatch).length) {
        const mergedProbe = { ...probe, ...probePatch, updated_at: now.toISOString() };
        probeWrites.push({
          tab: 'PROBES',
          rowNumber: record.rowNumber,
          row: probesTable.header.map((key) => mergedProbe[key] ?? ''),
        });
      }

      const existingRecord = intelligenceByProbe.get(probeId) || null;
      if (det.observation_status !== 'closed') {
        skippedOpen += 1;
        immediate.push({
          probe,
          probeId,
          existingRecord,
          det,
          ai: storedAiFields(existingRecord),
          finalInterpretation: false,
        });
        continue;
      }

      // No communications is a deterministic interpretation path inside
      // interpretProbe and does not call Anthropic at all. Never make a
      // zero-response probe compete for the model-call budget.
      if (classified.length === 0) {
        immediate.push({
          probe,
          probeId,
          existingRecord,
          det,
          ai: await interpretProbe(probe, classified),
          finalInterpretation: true,
        });
        continue;
      }

      aiCandidates.push({ probe, probeId, existingRecord, det, classified });
    } catch (error) {
      problems.push({ probe_id: probeId, error: error?.message || String(error) });
    }
  }

  const allowedAiCandidates = Number.isFinite(maxAiCalls) ? aiCandidates.slice(0, maxAiCalls) : aiCandidates;
  remainingInterpretations = Math.max(0, aiCandidates.length - allowedAiCandidates.length);

  const interpreted = await mapWithConcurrency(allowedAiCandidates, aiConcurrency, async (candidate) => {
    try {
      return {
        ...candidate,
        ai: await interpretProbe(candidate.probe, candidate.classified),
        finalInterpretation: true,
      };
    } catch (error) {
      problems.push({ probe_id: candidate.probeId, error: error?.message || String(error) });
      remainingInterpretations += 1;
      return null;
    }
  });

  const completed = [...immediate, ...interpreted.filter(Boolean)];
  const intelligenceWrites = [];
  const finalizedIntelligenceProbeIds = [];
  let intelligenceCreated = 0;
  let intelligenceUpdated = 0;
  let nextIntelligenceRow = intelligenceTable.rows.length + 2;

  for (const item of completed) {
    // A closed probe with communications only reaches this list after the final
    // semantic call succeeds. Budget-starved closed probes are deliberately not
    // written closed with stale partial AI fields.
    const intelligenceId = item.existingRecord?.obj?.intelligence_id || newIntelligenceId();
    const patch = {
      agency_id: item.probe.agency_id || '',
      probe_id: item.probeId,
      ...item.det,
      ...item.ai,
      updated_at: now.toISOString(),
    };
    let rowNumber;
    let merged;
    if (item.existingRecord) {
      rowNumber = item.existingRecord.rowNumber;
      merged = { ...item.existingRecord.obj, ...patch };
      intelligenceUpdated += 1;
    } else {
      rowNumber = nextIntelligenceRow;
      nextIntelligenceRow += 1;
      merged = { intelligence_id: intelligenceId, ...patch, created_at: now.toISOString() };
      intelligenceCreated += 1;
    }
    intelligenceWrites.push({
      tab: 'INTELLIGENCE',
      rowNumber,
      row: intelligenceTable.header.map((key) => merged[key] ?? ''),
    });
    if (item.finalInterpretation && item.det.observation_status === 'closed') {
      finalizedIntelligenceProbeIds.push(item.probeId);
    }
  }

  await repo.writeRowsBatch([...communicationWrites, ...probeWrites, ...intelligenceWrites]);

  return {
    probes_processed: completed.length,
    probes_with_communications: probesWithCommunications,
    probes_with_zero_communications: probesWithZeroCommunications,
    intelligence_created: intelligenceCreated,
    intelligence_updated: intelligenceUpdated,
    ai_interpretations_run: allowedAiCandidates.length - interpreted.filter((item) => item === null).length,
    remaining_interpretations: remainingInterpretations,
    probes_finalized_skipped: probesFinalizedSkipped,
    skipped_open: skippedOpen,
    ai_concurrency: aiConcurrency,
    finalized_intelligence_probe_ids: finalizedIntelligenceProbeIds,
    problems,
    results: completed.map((item) => ({
      probe_id: item.probeId,
      grade: item.det.grade,
      communications_matched: (communicationsByProbe.get(item.probeId) || []).length,
      final_interpretation: item.finalInterpretation,
    })),
  };
}
