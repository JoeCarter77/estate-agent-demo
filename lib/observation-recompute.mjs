// lib/observation-recompute.mjs — the Observation & Evidence Engine's core
// recompute logic, extracted so both the human-triggered HTTP endpoint
// (api/novus/observation/recompute.js) and the communications webhooks
// (api/novus/webhooks/*.js) can call the SAME code path in-process, with no
// HTTP round-trip and no duplicated logic to drift out of sync.
//
// Flow (NOVUS Project Source Master §19 evidence -> interpretation -> decision):
//   1. Read the PROBES row + every COMMUNICATIONS row already deterministically
//      matched to this probe_id (the matching itself is untouched — this
//      reads its output, never re-runs or second-guesses it).
//   2. INTERPRETATION — classify any not-yet-classified COMMUNICATIONS row
//      (lib/classification.mjs) and write the classification columns back.
//      Raw evidence and matching columns (source_identifier_*, matching_method,
//      match_score, match_status, subject, body_text, raw_content, ...) are
//      never touched. Rows with manual_override = TRUE are never overwritten
//      (Source Master §19 override rule).
//   3. EVIDENCE ROLLUP — lib/observation.mjs turns the classified
//      communications into the Source Master §9/§11/§18 metrics, including
//      the 30-minute contact-attempt grouping rule (§9/§29) — unchanged here.
//   4. DECISION — lib/grading.mjs applies the official, deterministic A-H
//      rules (§10) — unchanged here. AI never determines the grade.
//   5. Upsert exactly one INTELLIGENCE row for this probe — idempotent: a
//      second run updates the SAME row rather than duplicating it, and a
//      second run's classification pass is a no-op once rows are classified.
//
// Callers: this module never touches req/res, auth, or Twilio/TwiML — it
// takes a repo + probe_id and returns a plain result object, or null if the
// probe doesn't exist. Auth stays entirely with the caller (HTTP endpoint
// uses NOVUS_BASIC_AUTH; webhooks call this directly, in-process, after their
// own Twilio-signature/ingest-secret check already passed — there is no
// additional auth boundary to cross since it's a plain function call, not a
// network request).

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

// Returns the recompute result, or null if probeId doesn't exist in PROBES.
export async function recomputeProbeObservation(repo, probeId) {
  const probeRecord = await repo.findById('PROBES', 'probe_id', probeId);
  if (!probeRecord) return null;
  const probe = probeRecord.obj;

  // Only communications deterministically matched to THIS probe — never
  // agency-level guessing, never re-running the deterministic matching.
  const allCommunications = await repo.getRecords('COMMUNICATIONS', 'communication_id');
  const probeCommunications = allCommunications.filter((r) => r.obj.probe_id === probeId);

  // 2) INTERPRETATION
  let communicationsUpdated = 0;
  const classified = [];
  const crmResults = [];
  for (const record of probeCommunications) {
    const comm = record.obj;

    if (isOverridden(comm) || isClassified(comm)) {
      classified.push(comm);
      if (comm._crm) crmResults.push(comm._crm);
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
    await repo.updateById('COMMUNICATIONS', 'communication_id', comm.communication_id, patch);
    communicationsUpdated += 1;
    classified.push({ ...comm, ...patch });
    crmResults.push(crm);
  }

  // Second pass: mark which human touches belong to a follow-up contact
  // attempt (2nd+ attempt under the 30-minute grouping rule) now that the
  // full sequence for this probe is classified. Never touches rows a human
  // already overrode.
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
      await repo.updateById('COMMUNICATIONS', 'communication_id', comm.communication_id, { follow_up: desired });
      comm.follow_up = desired;
    }
  }

  // 3) EVIDENCE ROLLUP
  const observation = computeObservation(probe, classified);

  // CRM detection rollup — 'unknown' unless a real signature matched
  // (Source Master §18, resolution #3). No signature registry exists yet,
  // so this always resolves to unknown for now.
  const crmResult = crmResults.find((c) => c && c.crm_detected !== 'unknown') || { crm_detected: 'unknown', crm_name: '', crm_evidence: '' };

  // 4) DECISION
  const now = new Date();
  const deadline = probe.observation_deadline ? new Date(probe.observation_deadline) : null;
  const windowClosed = Boolean(deadline && now.getTime() >= deadline.getTime());
  const { grade, grade_reason } = gradeObservation({ probe, observation, now });

  const intelligencePatch = {
    agency_id: probe.agency_id || '',
    probe_id: probeId,
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
    inbound_sms_count: observation.inbound_sms_count,
    email_touch_count: observation.email_touch_count,
    // Not yet a column in the live INTELLIGENCE sheet — repo.appendRecord/
    // updateById silently drop keys the sheet header doesn't have, so this
    // is forward-compatible (starts persisting the moment the column is
    // added) without needing a code change or breaking anything today.
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

  // 5) Upsert — idempotent: exactly one INTELLIGENCE row per probe, updated
  // in place on every recompute (manual or automatic) rather than duplicated.
  const existingIntelligence = await repo.getRecords('INTELLIGENCE', 'intelligence_id');
  const existing = existingIntelligence.find((r) => r.obj.probe_id === probeId);

  let intelligenceId;
  if (existing) {
    intelligenceId = existing.obj.intelligence_id;
    await repo.updateById('INTELLIGENCE', 'intelligence_id', intelligenceId, intelligencePatch);
  } else {
    intelligenceId = newIntelligenceId();
    await repo.appendRecord('INTELLIGENCE', {
      intelligence_id: intelligenceId,
      ...intelligencePatch,
      created_at: now.toISOString(),
    });
  }

  return {
    intelligence_id: intelligenceId,
    probe_id: probeId,
    grade,
    grade_reason,
    observation,
    communications_updated: communicationsUpdated,
  };
}
