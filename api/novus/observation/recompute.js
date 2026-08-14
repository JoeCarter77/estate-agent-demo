// api/novus/observation/recompute.js — POST /api/novus/observation/recompute
//
// Manual, on-demand recomputation of the Observation & Evidence Engine for one
// probe. Deliberately NOT wired into the Communications Milestone 1 webhook
// (api/novus/webhooks/email-inbound.js) — that file is untouched by this
// milestone. Human-triggered, so it uses the same NOVUS_BASIC_AUTH as the
// rest of the internal /api/novus/* surface (requireAuth), not the webhook's
// ingest secret.
//
// Body: { probe_id }
//
// Flow (NOVUS Project Source Master §19 evidence -> interpretation -> decision):
//   1. Read the PROBES row + every COMMUNICATIONS row already deterministically
//      matched to this probe_id (Milestone 1's matching is untouched — this
//      reads its output, never re-runs or second-guesses it).
//   2. INTERPRETATION — classify any not-yet-classified COMMUNICATIONS row
//      (lib/classification.mjs) and write the classification columns back.
//      Raw evidence and matching columns (source_identifier_*, matching_method,
//      match_score, match_status, subject, body_text, raw_content, ...) are
//      never touched. Rows with manual_override = TRUE are never overwritten
//      (Source Master §19 override rule).
//   3. EVIDENCE ROLLUP — lib/observation.mjs turns the classified
//      communications into the Source Master §9/§11/§18 metrics.
//   4. DECISION — lib/grading.mjs applies the official, deterministic A-H
//      rules (§10). AI never determines the grade.
//   5. Upsert exactly one INTELLIGENCE row for this probe — idempotent: a
//      second run updates the same row rather than duplicating it, and a
//      second run's classification pass is a no-op once rows are classified.

import { getRepo } from '../../../lib/sheets.mjs';
import { newIntelligenceId } from '../../../lib/ids.mjs';
import { classifyCommunication, detectCrm } from '../../../lib/classification.mjs';
import { computeObservation, markFollowUps } from '../../../lib/observation.mjs';
import { gradeObservation } from '../../../lib/grading.mjs';
import { requireAuth } from '../_auth.mjs';

export const maxDuration = 20;

function isOverridden(comm) {
  return comm.manual_override === 'TRUE' || comm.manual_override === true;
}

function isClassified(comm) {
  return comm.automated_or_human === 'automated' || comm.automated_or_human === 'human' || comm.automated_or_human === 'unknown';
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const probeId = String(body.probe_id || '').trim();
  if (!probeId) return res.status(400).json({ error: 'Missing probe_id' });

  try {
    const repo = getRepo();

    const probeRecord = await repo.findById('PROBES', 'probe_id', probeId);
    if (!probeRecord) return res.status(404).json({ error: `Probe ${probeId} not found` });
    const probe = probeRecord.obj;

    // Only communications deterministically matched to THIS probe — never
    // agency-level guessing, never re-running Milestone 1's matching.
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

      const tags = classifyCommunication(comm);
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

    // Second pass: mark which human touches are follow-ups (2nd+ human touch)
    // now that the full sequence for this probe is classified. Never touches
    // rows a human already overrode.
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

    // 5) Upsert — idempotent: exactly one INTELLIGENCE row per probe.
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

    return res.status(200).json({
      intelligence_id: intelligenceId,
      probe_id: probeId,
      grade,
      grade_reason,
      observation,
      communications_updated: communicationsUpdated,
    });
  } catch (err) {
    console.error('observation recompute error:', err);
    return res.status(500).json({ error: err.message || 'Failed to recompute observation' });
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
