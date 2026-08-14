// lib/grading.mjs — official, deterministic A-E grading engine.
//
// Verbatim from the NOVUS Project Source Master §10. This is a rules engine
// ONLY — AI never determines the official grade (§29: "A-E grade | Rules
// engine | Commercial methodology must be stable"). Evidence combinations the
// Source Master does not explicitly define resolve to 'ungraded' — never
// invented or folded into the nearest grade (approved resolution #1).

export const ONE_HOUR_MS = 60 * 60 * 1000;
export const SIXTEEN_HOUR_MS = 16 * 60 * 60 * 1000; // Source Master §10 "working speed threshold"
export const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

// { probe, observation, now } -> { grade, grade_reason }
// probe: PROBES row (needs probe_timestamp, observation_deadline)
// observation: output of lib/observation.mjs computeObservation()
export function gradeObservation({ probe, observation, now = new Date() }) {
  const probeTimestamp = probe.probe_timestamp ? new Date(probe.probe_timestamp) : null;
  const deadline = probe.observation_deadline
    ? new Date(probe.observation_deadline)
    : (probeTimestamp ? new Date(probeTimestamp.getTime() + SEVEN_DAY_MS) : null);
  const windowClosed = Boolean(deadline && now.getTime() >= deadline.getTime());

  const hasHumanContact = observation.first_human_touch === 'yes';
  const hasAnyEvidence = Boolean(observation.last_touch_at) || observation.auto_acknowledgement === true;
  const followUpCount = observation.follow_up_count || 0;
  const lagHours = observation.human_lag_hours;

  // E — nothing on any channel after 7 days (§10).
  if (windowClosed && !hasAnyEvidence) {
    return { grade: 'E', grade_reason: 'Observation window closed after 7 days with no communication on any channel.' };
  }

  if (hasHumanContact) {
    if (typeof lagHours !== 'number') {
      return { grade: 'ungraded', grade_reason: 'Human contact recorded but human_lag_hours could not be computed (missing probe_timestamp).' };
    }
    if (lagHours <= 1 && followUpCount >= 2) {
      return { grade: 'A', grade_reason: 'Human contact inside 1 hour with 2+ unprompted follow-ups (Source Master S10).' };
    }
    if (lagHours <= 16 && followUpCount === 0) {
      return { grade: 'B', grade_reason: 'Fast human contact (<=16h working-speed threshold) with zero follow-up (Source Master S10).' };
    }
    if (lagHours > 16 && followUpCount === 0) {
      return { grade: 'D', grade_reason: 'Slow human contact (>16h working-speed threshold) with zero follow-up (Source Master S10).' };
    }
    // Evidence combination not defined by the Source Master, e.g. contact
    // between 1h and 16h with 2+ follow-ups, or slow contact with follow-up
    // activity. Do not guess which grade this "should" be.
    return {
      grade: 'ungraded',
      grade_reason: `Human contact at ${lagHours.toFixed(2)}h with ${followUpCount} follow-up(s) does not match a defined A/B/D combination.`,
    };
  }

  if (observation.auto_acknowledgement === true) {
    // C — automated acknowledgement only; no human contact (§10).
    return { grade: 'C', grade_reason: 'Automated acknowledgement only; no human contact observed.' };
  }

  if (!windowClosed) {
    return { grade: 'ungraded', grade_reason: 'Observation window still open; no grading evidence yet.' };
  }

  // Window closed, some evidence exists, but neither human contact nor
  // auto-acknowledgement resolved (e.g. only 'unknown'-classified evidence).
  return { grade: 'ungraded', grade_reason: 'Observation window closed with evidence present but no defined grade combination matched.' };
}
