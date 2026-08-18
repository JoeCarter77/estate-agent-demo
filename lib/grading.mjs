// lib/grading.mjs — official, deterministic A-H grading engine.
//
// Verbatim from the NOVUS Project Source Master (2026-08-14 FINAL) §10. This
// is a rules engine ONLY — AI never determines the official grade (§29:
// "A-H grade | Rules engine | Commercial methodology must be stable").
//
// §10 "Grade-rule completeness: A-H is exhaustive and mutually exclusive
// across human-contact speed and genuine persistence, with G reserved for
// automated acknowledgement only and H reserved for a four-day complete
// miss." There is deliberately no "ungraded" fallback for a defined
// evidence combination anymore — every (speed band x persistence) pair a
// human-contact probe can produce maps to exactly one of A-F, and every
// non-human-contact probe maps to exactly one of G or H, or is still
// 'pending' while the 4-day window remains open with no evidence at all
// (a temporal state, not an undefined evidence combination).
//
// Observation window: 4 days (Source Master 2026-08-14 FINAL methodology
// change — the window length is a probe-timing/commercial-methodology
// parameter, orthogonal to the A-H speed/persistence rules themselves,
// which are unchanged by this update).
//
// This engine reads ONLY the derived observation metrics it needs
// (first_human_touch, human_lag_hours, follow_up_count, auto_acknowledgement,
// last_touch_at) — never callback_attempts, persistence_profile,
// contact_quality, voicemail_count or booking_attempt. Those are separate
// intelligence fields (§11, §18) that must never redefine the official grade.

export const ONE_HOUR_MS = 60 * 60 * 1000;
export const SIXTEEN_HOUR_MS = 16 * 60 * 60 * 1000; // Source Master §10 "working speed threshold"
export const FOUR_DAY_MS = 4 * 24 * 60 * 60 * 1000; // Source Master §10 observation window (was 7 days)

// probe.observation_deadline when present; otherwise derived as
// probe_timestamp + 4 days (Source Master §10 observation window) — covers
// historical/imported probes whose PROBES row never got an explicit
// observation_deadline written. Returns null only when neither is available.
export function resolveObservationDeadline(probe) {
  if (probe.observation_deadline) return new Date(probe.observation_deadline);
  if (probe.probe_timestamp) {
    const probeTimestamp = new Date(probe.probe_timestamp);
    if (!Number.isNaN(probeTimestamp.getTime())) return new Date(probeTimestamp.getTime() + FOUR_DAY_MS);
  }
  return null;
}

// { probe, observation, now } -> { grade, grade_reason }
// probe: PROBES row (needs probe_timestamp, observation_deadline)
// observation: output of lib/observation.mjs computeObservation()
export function gradeObservation({ probe, observation, now = new Date() }) {
  const deadline = resolveObservationDeadline(probe);
  const windowClosed = Boolean(deadline && now.getTime() >= deadline.getTime());

  const hasHumanContact = observation.first_human_touch === 'yes';
  const hasAnyEvidence = Boolean(observation.last_touch_at) || observation.auto_acknowledgement === true;
  const followUpCount = observation.follow_up_count || 0;
  const lagHours = observation.human_lag_hours;

  // A-F — human contact occurred. Speed band x persistence is exhaustive and
  // mutually exclusive: every real lagHours value falls into exactly one of
  // the three speed bands, and followUpCount is either 0 (non-persistent) or
  // 1+ (persistent) — no third state, so no combination is left undefined.
  if (hasHumanContact) {
    if (typeof lagHours !== 'number') {
      return {
        grade: 'pending',
        grade_reason: 'Human contact recorded but human_lag_hours could not be computed (missing probe_timestamp).',
      };
    }
    const persistent = followUpCount >= 1;

    if (lagHours <= 1) {
      return persistent
        ? { grade: 'A', grade_reason: 'Very fast human contact (≤1h) with 1+ genuine follow-up attempt(s) (Source Master §10).' }
        : { grade: 'C', grade_reason: 'Very fast human contact (≤1h) with 0 genuine follow-up attempts (Source Master §10).' };
    }
    if (lagHours <= 16) {
      return persistent
        ? { grade: 'B', grade_reason: 'Fast human contact (>1h and ≤16h) with 1+ genuine follow-up attempt(s) (Source Master §10).' }
        : { grade: 'D', grade_reason: 'Fast human contact (>1h and ≤16h) with 0 genuine follow-up attempts (Source Master §10).' };
    }
    return persistent
      ? { grade: 'E', grade_reason: 'Slow human contact (>16h) with 1+ genuine follow-up attempt(s) (Source Master §10).' }
      : { grade: 'F', grade_reason: 'Slow human contact (>16h) with 0 genuine follow-up attempts (Source Master §10).' };
  }

  // G — automated acknowledgement, no human contact (§10). Assignable as
  // soon as it's true, same as A-F: it's a currently-known fact, not
  // something that requires the window to close (matches the pre-existing
  // architecture — it may still flip to A-F later if a human touch occurs
  // before the window closes).
  if (observation.auto_acknowledgement === true) {
    return { grade: 'G', grade_reason: 'Automated acknowledgement only; no human contact observed (Source Master §10).' };
  }

  // H — the four-day observation window closed with no meaningful response
  // (no human contact, no auto-acknowledgement) on any channel (§10).
  if (windowClosed) {
    return {
      grade: 'H',
      grade_reason: 'Observation window closed after 4 days with no meaningful response on any channel (Source Master §10).',
    };
  }

  // Not a gap in the A-H policy — the window is still open and there is no
  // evidence yet to grade. This is a temporal "nothing has happened yet"
  // state, not an evidence combination the Source Master leaves undefined:
  // once the window closes this resolves to H (or earlier, to A-G, the
  // moment real evidence arrives).
  return {
    grade: 'pending',
    grade_reason: hasAnyEvidence
      ? 'Observation window still open with evidence present but neither human contact nor automated acknowledgement resolved yet.'
      : 'Observation window still open; no evidence on any channel yet.',
  };
}
