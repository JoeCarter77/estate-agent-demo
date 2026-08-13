// lib/observation.mjs — deterministic Observation & Evidence Engine rollups.
//
// Pure functions only: given a PROBES row and its classified COMMUNICATIONS
// rows (already tagged by lib/classification.mjs), compute the evidence
// metrics defined in the NOVUS Project Source Master §9/§11/§18. No I/O, no
// AI, no grading — lib/grading.mjs consumes this module's output.
//
// Source Master correction: "days chased" / "days persisted" (§9, §11, §18)
// is the PERIOD from probe to last touch — a duration — NOT a count of
// distinct calendar dates on which contact occurred.

function toBool(v) {
  return v === true || v === 'TRUE' || v === 'true';
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Provisional persistence-profile thresholds (approved as provisional — the
// Source Master §11 gives the enum but not numeric cut points):
//   none = 0 follow-ups, low = 1, moderate = 2-3, high = 4+
//   multi-channel takes precedence whenever 2+ distinct channels were used.
function persistenceProfile(followUpCount, channelsUsed) {
  if (channelsUsed.length >= 2) return 'multi-channel';
  if (followUpCount >= 4) return 'high';
  if (followUpCount >= 2) return 'moderate';
  if (followUpCount >= 1) return 'low';
  return 'none';
}

// Provisional contact-quality rollup. Source Master §18 supplies the allowed
// enum (Proactive / Reactive / Qualification / Booking attempt / Generic
// acknowledgement / Information only / Persistent / multi-channel) but not the
// mapping rule from raw evidence to a value — this is a first deterministic
// pass, flagged as provisional, not verbatim Source Master text.
function contactQuality({ bookingAttempt, hasHumanContact, hasAutoAck, followUpCount, channelsUsed }) {
  if (bookingAttempt) return 'Booking attempt';
  if (followUpCount >= 1 && channelsUsed.length >= 2) return 'Persistent / multi-channel';
  if (hasHumanContact && followUpCount === 0) return 'Reactive';
  if (followUpCount >= 1) return 'Proactive';
  if (hasAutoAck && !hasHumanContact) return 'Generic acknowledgement';
  return '';
}

// communications: COMMUNICATIONS row objects already merged with
// classification tags (automated_or_human, human_contact,
// communication_classification, booking_attempt) from lib/classification.mjs.
export function computeObservation(probe, communications) {
  const sorted = communications
    .map((c) => ({ ...c, _occurredAt: parseDate(c.occurred_at) }))
    .filter((c) => c._occurredAt)
    .sort((a, b) => a._occurredAt - b._occurredAt);

  const probeTimestamp = parseDate(probe.probe_timestamp);

  // Auto acknowledgement — earliest communication flagged as one. Per Source
  // Master §9 this must never count as human contact.
  const autoAckTouches = sorted.filter((c) => c.communication_classification === 'auto_acknowledgement');
  const autoAcknowledgement = autoAckTouches.length > 0;
  const autoAckTimestamp = autoAcknowledgement ? autoAckTouches[0].occurred_at : '';

  // First human touch — first actual person, any channel (§9).
  const humanTouches = sorted.filter((c) => toBool(c.human_contact));
  const firstHumanTouch = humanTouches.length > 0 ? 'yes' : 'no';
  const firstHumanTouchAt = humanTouches.length > 0 ? humanTouches[0].occurred_at : '';

  let humanLagHours = '';
  if (probeTimestamp && humanTouches.length > 0) {
    humanLagHours = (humanTouches[0]._occurredAt - probeTimestamp) / HOUR_MS;
  }

  // Follow-up count — unprompted touches after first human contact (§9).
  // Every agency-initiated touch during the observation window is
  // structurally "unprompted": Joe never replies during the window (§7).
  const followUpTouches = humanTouches.slice(1);
  const followUpCount = followUpTouches.length;
  const followUpChannels = [...new Set(followUpTouches.map((c) => c.channel).filter(Boolean))];

  // Last touch — across ALL evidence, any channel, automated or human (§9).
  const lastTouchAt = sorted.length > 0 ? sorted[sorted.length - 1].occurred_at : '';

  // Days chased / days persisted — probe to last touch, a DURATION (§9 correction).
  let daysChased = '';
  if (probeTimestamp && lastTouchAt) {
    const lastTouchDate = parseDate(lastTouchAt);
    daysChased = Math.round(((lastTouchDate - probeTimestamp) / DAY_MS) * 100) / 100;
  }

  const callbackAttempts = sorted.filter((c) => toBool(c.callback_attempt)).length;
  const successfulConversations = sorted.filter((c) => toBool(c.successful_conversation)).length;
  const voicemailCount = sorted.filter((c) => toBool(c.voicemail_present)).length;
  const bookingAttempt = sorted.some((c) => toBool(c.booking_attempt));

  const channelsUsed = [...new Set(sorted.map((c) => c.channel).filter(Boolean))];

  const quality = contactQuality({
    bookingAttempt,
    hasHumanContact: humanTouches.length > 0,
    hasAutoAck: autoAcknowledgement,
    followUpCount,
    channelsUsed,
  });

  return {
    auto_acknowledgement: autoAcknowledgement,
    auto_ack_timestamp: autoAckTimestamp,
    first_human_touch: firstHumanTouch,
    first_human_touch_at: firstHumanTouchAt,
    human_lag_hours: humanLagHours,
    callback_attempts: callbackAttempts,
    successful_conversations: successfulConversations,
    voicemail_count: voicemailCount,
    follow_up_count: followUpCount,
    follow_up_channels: followUpChannels.join(','),
    last_touch_at: lastTouchAt,
    days_chased: daysChased,
    booking_attempt: bookingAttempt,
    contact_quality: quality,
    persistence_profile: persistenceProfile(followUpCount, channelsUsed),
    channels_used: channelsUsed.join(','),
  };
}

// Which of the given (already-sorted-by-occurred_at) human touches are
// follow-ups (the 2nd+ human touch). Used by the caller to write the
// per-communication COMMUNICATIONS.follow_up flag back to the sheet.
export function markFollowUps(humanTouchesSortedByTime) {
  return humanTouchesSortedByTime.map((c, i) => ({ ...c, is_follow_up: i > 0 }));
}
