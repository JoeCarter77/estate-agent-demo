// lib/intelligence-rebuild.mjs — the canonical full-rebuild path for
// INTELLIGENCE, per PROBES + COMMUNICATIONS -> EVIDENCE -> INTELLIGENCE.
//
// PERFORMANCE NOTE: this file intentionally does NOT call
// lib/observation-recompute.mjs's recomputeProbeObservation() in a loop.
// That function is correct but reads COMMUNICATIONS and INTELLIGENCE fresh
// from Google Sheets on every call — fine for a single probe (manual
// recompute, or a webhook reacting to one new communication), but for a
// full rebuild across every probe it meant O(probes) full-table reads of
// COMMUNICATIONS and INTELLIGENCE, which blew through the Sheets API read
// quota (HTTP 429) once there were more than a handful of probes.
//
// rebuildAllIntelligence() instead:
//   1. Batch-loads PROBES, COMMUNICATIONS and INTELLIGENCE exactly ONCE.
//   2. Runs the SAME per-probe pipeline recomputeProbeObservation() uses —
//      classification (lib/classification.mjs), the 30-minute contact-
//      attempt grouping + evidence rollup (lib/observation.mjs), and the
//      A-H grading engine (lib/grading.mjs) — entirely in memory, against
//      the batch-loaded data. No logic is duplicated or reimplemented; the
//      exact same pure functions are called, just orchestrated around
//      pre-loaded data instead of per-probe sheet reads.
//   3. Only then performs the writes: one COMMUNICATIONS patch per row that
//      actually needs (re)classification or a follow_up flag change, and
//      one INTELLIGENCE create/update per probe — decided from the
//      in-memory snapshot, never from a re-read.
//
// lib/observation-recompute.mjs itself is untouched: single-probe recompute
// (api/novus/observation/recompute.js) and the webhooks' auto-recompute
// keep behaving exactly as before.
//
// Idempotent: INTELLIGENCE is still upserted exactly one row per probe_id
// (looked up from the batch-loaded snapshot) — running rebuildAll twice in
// a row produces the same INTELLIGENCE rows both times, never duplicates.
//
// Zero-communication probes are valid intelligence (per spec) and are
// processed exactly like any other probe — computeObservation/
// gradeObservation already handle an empty communications list correctly
// (open -> pending/"observing", closed -> H). Nothing here special-cases them.

import { newIntelligenceId } from './ids.mjs';
import { classifyCommunication, detectCrm } from './classification.mjs';
import { computeObservation, markFollowUps } from './observation.mjs';
import { gradeObservation } from './grading.mjs';

function isOverridden(comm) {
  return comm.manual_override === 'TRUE' || comm.manual_override === true;
}

function isClassified(comm) {
  return comm.automated_or_human === 'automated' || comm.automated_or_human === 'human' || comm.automated_or_human === 'unknown';
}

// Runs the same interpretation -> evidence -> decision pipeline as
// recomputeProbeObservation(), against an in-memory probe + its already
// batch-loaded communications. No sheet I/O. Returns the computed result
// plus any COMMUNICATIONS row patches that still need writing.
function computeProbeIntelligence(probe, probeCommunications, now) {
  const communicationPatches = new Map(); // communication_id -> patch

  // 2) INTERPRETATION
  const classified = [];
  const crmResults = [];
  for (const comm of probeCommunications) {
    if (isOverridden(comm) || isClassified(comm)) {
      classified.push(comm);
      continue;
    }

    const tags = classifyCommunication(comm, { probeTimestamp: probe.probe_timestamp });
    const crm = detectCrm(comm);
    const patch = {
      automated_or_human: tags.automated_or_human,
      human_contact: tags.human_contact ? 'TRUE' : 'FALSE',
      communication_classification: tags.communication_classification,
      booking_attempt: tags.booking_attempt ? 'TRUE' : 'FALSE',
    };
    communicationPatches.set(comm.communication_id, { ...(communicationPatches.get(comm.communication_id) || {}), ...patch });
    classified.push({ ...comm, ...patch });
    crmResults.push(crm);
  }

  // Second pass: mark which human touches belong to a follow-up contact
  // attempt (2nd+ attempt under the 30-minute grouping rule).
  const humanSorted = classified
    .filter((c) => c.human_contact === 'TRUE' || c.human_contact === true)
    .map((c) => ({ ...c, _occurredAt: new Date(c.occurred_at) }))
    .filter((c) => !Number.isNaN(c._occurredAt.getTime()))
    .sort((a, b) => a._occurredAt - b._occurredAt);

  const withFollowUpFlags = markFollowUps(humanSorted);
  for (const comm of withFollowUpFlags) {
    if (isOverridden(comm)) continue;
    const desired = comm.is_follow_up ? 'TRUE' : 'FALSE';
    if (comm.follow_up !== desired) {
      communicationPatches.set(comm.communication_id, { ...(communicationPatches.get(comm.communication_id) || {}), follow_up: desired });
      comm.follow_up = desired;
    }
  }

  // 3) EVIDENCE ROLLUP
  const observation = computeObservation(probe, classified);

  // CRM detection rollup — 'unknown' unless a real signature matched.
  const crmResult = crmResults.find((c) => c && c.crm_detected !== 'unknown') || { crm_detected: 'unknown', crm_name: '', crm_evidence: '' };

  // 4) DECISION
  const deadline = probe.observation_deadline ? new Date(probe.observation_deadline) : null;
  const windowClosed = Boolean(deadline && now.getTime() >= deadline.getTime());
  const { grade, grade_reason } = gradeObservation({ probe, observation, now });

  const intelligencePatch = {
    agency_id: probe.agency_id || '',
    probe_id: probe.probe_id,
    observation_status: windowClosed ? 'closed' : 'observing',
    observation_deadline: probe.observation_deadline || '',
    auto_acknowledgement: observation.auto_acknowledgement ? 'TRUE' : 'FALSE',
    auto_ack_timestamp: observation.auto_ack_timestamp,
    crm_detected: crmResult.crm_detected === true ? 'TRUE' : crmResult.crm_detected === false ? 'FALSE' : 'unknown',
    crm_name: crmResult.crm_name,
    crm_evidence: crmResult.crm_evidence,
    first_human_touch: observation.first_human_touch,
    first_human_touch_at: observation.first_human_touch_at,
    human_lag_hours: observation.human_lag_hours,
    callback_attempts: observation.callback_attempts,
    successful_conversations: observation.successful_conversations,
    voicemail_count: observation.voicemail_count,
    contact_attempt_count: observation.contact_attempt_count,
    follow_up_count: observation.follow_up_count,
    follow_up_channels: observation.follow_up_channels,
    last_touch_at: observation.last_touch_at,
    days_chased: observation.days_chased,
    booking_attempt: observation.booking_attempt ? 'TRUE' : 'FALSE',
    contact_quality: observation.contact_quality,
    persistence_profile: observation.persistence_profile,
    channels_used: observation.channels_used,
    grade,
    grade_reason,
    observation_closed_at: windowClosed ? (probe.observation_deadline || now.toISOString()) : '',
    updated_at: now.toISOString(),
  };

  return { grade, grade_reason, observation, intelligencePatch, communicationPatches };
}

// repo -> { probes_processed, probes_with_communications,
//   probes_with_zero_communications, intelligence_created,
//   intelligence_updated, problems: [{probe_id, error}], results: [...] }
export async function rebuildAllIntelligence(repo) {
  // 1) BATCH LOAD — exactly one read of each table for the whole rebuild.
  const [probeRecords, communicationRecords, intelligenceRecords] = await Promise.all([
    repo.getRecords('PROBES', 'probe_id'),
    repo.getRecords('COMMUNICATIONS', 'communication_id'),
    repo.getRecords('INTELLIGENCE', 'intelligence_id'),
  ]);

  const communicationsByProbe = new Map();
  for (const { obj } of communicationRecords) {
    if (!obj.probe_id) continue;
    if (!communicationsByProbe.has(obj.probe_id)) communicationsByProbe.set(obj.probe_id, []);
    communicationsByProbe.get(obj.probe_id).push(obj);
  }

  const intelligenceByProbe = new Map(intelligenceRecords.map((r) => [r.obj.probe_id, r.obj]));

  // 2) COMPUTE — the full pipeline, entirely in memory, for every probe.
  const now = new Date();
  let probesWithCommunications = 0;
  let probesWithZeroCommunications = 0;
  const problems = [];
  const results = [];
  const communicationWrites = new Map(); // communication_id -> patch
  const intelligenceCreates = [];
  const intelligenceUpdates = [];

  for (const { obj: probe } of probeRecords) {
    const probeId = probe.probe_id;
    const probeCommunications = communicationsByProbe.get(probeId) || [];
    if (probeCommunications.length > 0) probesWithCommunications += 1; else probesWithZeroCommunications += 1;

    try {
      const { grade, intelligencePatch, communicationPatches } = computeProbeIntelligence(probe, probeCommunications, now);

      for (const [communicationId, patch] of communicationPatches) {
        communicationWrites.set(communicationId, { ...(communicationWrites.get(communicationId) || {}), ...patch });
      }

      const existing = intelligenceByProbe.get(probeId);
      let intelligenceId;
      if (existing) {
        intelligenceId = existing.intelligence_id;
        intelligenceUpdates.push({ intelligenceId, patch: intelligencePatch });
      } else {
        intelligenceId = newIntelligenceId();
        intelligenceCreates.push({ intelligence_id: intelligenceId, ...intelligencePatch, created_at: now.toISOString() });
      }

      results.push({
        probe_id: probeId,
        intelligence_id: intelligenceId,
        grade,
        communications_matched: probeCommunications.length,
      });
    } catch (err) {
      problems.push({ probe_id: probeId, error: err.message || String(err) });
    }
  }

  // 3) WRITE — only the rows that actually changed, decided above, never re-read first.
  for (const [communicationId, patch] of communicationWrites) {
    await repo.updateById('COMMUNICATIONS', 'communication_id', communicationId, patch);
  }
  for (const { intelligenceId, patch } of intelligenceUpdates) {
    await repo.updateById('INTELLIGENCE', 'intelligence_id', intelligenceId, patch);
  }
  for (const record of intelligenceCreates) {
    await repo.appendRecord('INTELLIGENCE', record);
  }

  return {
    probes_processed: probeRecords.length,
    probes_with_communications: probesWithCommunications,
    probes_with_zero_communications: probesWithZeroCommunications,
    intelligence_created: intelligenceCreates.length,
    intelligence_updated: intelligenceUpdates.length,
    problems,
    results,
  };
}
