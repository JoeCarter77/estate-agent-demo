// lib/intelligence-fields.mjs — the deterministic half of an INTELLIGENCE
// row (V2 schema §3), shared by the single-probe path
// (lib/observation-recompute.mjs) and the batch path
// (lib/intelligence-rebuild.mjs) so they can never drift apart.
//
// Reuses lib/observation.mjs and lib/grading.mjs completely unchanged — the
// 30-minute contact-attempt grouping rule and the A-H grading engine are
// exactly as they were before this schema change. This module only renames/
// selects the subset of computeObservation()'s output the V2 INTELLIGENCE
// row actually keeps, and derives the new `human_contact` tri-state.
//
// Pure function, no I/O.

import { computeObservation } from './observation.mjs';
import { gradeObservation, resolveObservationDeadline } from './grading.mjs';

// observation.first_human_touch / auto_acknowledgement -> the V2 tri-state.
function humanContactState(observation) {
  if (observation.first_human_touch === 'yes') return 'yes';
  if (observation.auto_acknowledgement === true) return 'automated_only';
  return 'none';
}

// probe: PROBES row. classifiedCommunications: this probe's COMMUNICATIONS
// rows, already carrying automated_or_human (lib/classification.mjs).
// now: Date, for window-closed / grade evaluation.
// -> { observation_status, observation_deadline, observation_closed_at,
//      human_contact, response_hours, first_human_response_at,
//      contact_attempts, follow_ups, channels_used, grade, grade_reason }
export function computeDeterministicIntelligence(probe, classifiedCommunications, now = new Date()) {
  const observation = computeObservation(probe, classifiedCommunications);
  const deadline = resolveObservationDeadline(probe);
  const windowClosed = Boolean(deadline && now.getTime() >= deadline.getTime());
  const { grade, grade_reason } = gradeObservation({ probe, observation, now });

  const humanContact = humanContactState(observation);

  return {
    observation_status: windowClosed ? 'closed' : 'observing',
    observation_deadline: deadline ? deadline.toISOString() : (probe.observation_deadline || ''),
    observation_closed_at: windowClosed ? (deadline ? deadline.toISOString() : now.toISOString()) : '',
    human_contact: humanContact,
    response_hours: humanContact === 'yes' ? observation.human_lag_hours : '',
    first_human_response_at: humanContact === 'yes' ? observation.first_human_touch_at : '',
    contact_attempts: observation.contact_attempt_count,
    follow_ups: observation.follow_up_count,
    channels_used: observation.channels_used,
    grade,
    grade_reason,
  };
}
