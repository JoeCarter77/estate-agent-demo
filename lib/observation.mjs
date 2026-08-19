// lib/observation.mjs — deterministic Observation & Evidence Engine rollups.
//
// Pure functions only: given a PROBES row and its classified COMMUNICATIONS
// rows (already tagged by lib/classification.mjs), compute the evidence
// metrics defined in the NOVUS Project Source Master (2026-08-14 FINAL) §9/
// §11/§18. No I/O, no AI, no grading — lib/grading.mjs consumes this
// module's output.
//
// Source Master correction: "days chased" / "days persisted" (§9, §11, §18)
// is the PERIOD from probe to last touch — a duration — NOT a count of
// distinct calendar dates on which contact occurred.
//
// Contact-attempt / follow-up grouping (§9, §29 "Contact-attempt / follow-up
// grouping — 30-minute window anchored to attempt start; raw events remain
// immutable"): follow_up_count is NOT a count of communication events. A
// contact attempt begins with the first human touch after the probe; any
// further human touches within 30 minutes of the START of that attempt
// belong to the same attempt (the window does not reset per communication).
// follow_up_count = number of DISTINCT SUBSEQUENT attempts, not raw events.

import { isHumanCommunication } from './classification.mjs';

function toBool(v) {
  return v === true || v === 'TRUE' || v === 'true';
}

// A row counts as human contact when the pipeline decided so. Historical and
// imported rows frequently carry automated_or_human = 'human' with the
// human_contact cell left blank; reading human_contact alone silently dropped
// those touches out of every rollup below (first_human_touch, contact
// attempts, channel counts, and therefore the grade). isHumanCommunication()
// falls back to automated_or_human, then to the live classifier.
function isHumanTouch(comm) {
  return isHumanCommunication(comm);
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const THIRTY_MIN_MS = 30 * 60 * 1000;

// Groups touches (already sorted by occurred_at, each with a parsed
// _occurredAt Date) into contact attempts. A new attempt starts whenever a
// touch falls more than 30 minutes after the START of the current attempt —
// never reset by the previous communication within that attempt. Returns an
// array of attempts, each an array of the original touch objects, in order.
export function groupContactAttempts(touchesSortedByTime) {
  const attempts = [];
  let attemptStartMs = null;
  for (const touch of touchesSortedByTime) {
    const t = touch._occurredAt.getTime();
    if (attemptStartMs === null || t - attemptStartMs > THIRTY_MIN_MS) {
      attempts.push([]);
      attemptStartMs = t;
    }
    attempts[attempts.length - 1].push(touch);
  }
  return attempts;
}

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

// PROACTIVE vs REACTIVE contact (INTELLIGENCE.proactive_reactive) — Source
// Master §11 lists "Proactive vs reactive contact" as its own Observation &
// Evidence Engine output, and the INTELLIGENCE sheet has always carried the
// column; nothing ever wrote it, so it was blank on every row. Meanwhile
// contact_quality (a DIFFERENT §18 rollup, with its own enum) was carrying
// 'Proactive'/'Reactive' values — the concepts sat in the wrong field.
//
// Derived only from evidence already computed here, never from the grade:
//   'proactive' — the agency drove toward a concrete next step on its own:
//                 at least one human touch pushed a specific slot or asked for
//                 the prospect's availability (COMMUNICATIONS.contact_quality =
//                 'proactive_booking_push'), or it made 1+ genuine follow-up
//                 attempt(s) after the first contact rather than waiting.
//   'reactive'  — human contact happened, but only ever as a single responding
//                 attempt with no push toward a next step.
//   'none'      — no human contact at all (auto-ack only, or silence). Left as
//                 an explicit value rather than blank so a rebuilt row is
//                 distinguishable from a never-computed one.
function proactiveReactive({ hasHumanContact, hasProactiveBookingPush, followUpCount }) {
  if (!hasHumanContact) return 'none';
  if (hasProactiveBookingPush || followUpCount >= 1) return 'proactive';
  return 'reactive';
}

// communications: COMMUNICATIONS row objects already merged with
// classification tags (automated_or_human, human_contact,
// communication_classification, booking_attempt) from lib/classification.mjs.
export function computeObservation(probe, communications) {
  // occurred_at falls back to received_at when it's blank or unparseable —
  // historical/imported rows frequently only ever had received_at populated.
  // Without this fallback such a row's _occurredAt was null, so the
  // `.filter((c) => c._occurredAt)` below silently dropped it out of every
  // rollup (channels_used, contact attempts, grade, the lot) even though it
  // was correctly linked to the probe — the row simply never appeared to
  // have happened at any point in time.
  const sorted = communications
    .map((c) => {
      const occurredAt = parseDate(c.occurred_at) || parseDate(c.received_at);
      return { ...c, occurred_at: occurredAt ? c.occurred_at || c.received_at : c.occurred_at, _occurredAt: occurredAt };
    })
    .filter((c) => c._occurredAt)
    .sort((a, b) => a._occurredAt - b._occurredAt);

  const probeTimestamp = parseDate(probe.probe_timestamp);

  // Auto acknowledgement — earliest communication flagged as one. Per Source
  // Master §9 this must never count as human contact.
  const autoAckTouches = sorted.filter((c) => c.communication_classification === 'auto_acknowledgement');
  const autoAcknowledgement = autoAckTouches.length > 0;
  const autoAckTimestamp = autoAcknowledgement ? autoAckTouches[0].occurred_at : '';

  // First human touch — first actual person, any channel (§9).
  const humanTouches = sorted.filter(isHumanTouch);
  const firstHumanTouch = humanTouches.length > 0 ? 'yes' : 'no';
  const firstHumanTouchAt = humanTouches.length > 0 ? humanTouches[0].occurred_at : '';

  let humanLagHours = '';
  if (probeTimestamp && humanTouches.length > 0) {
    humanLagHours = (humanTouches[0]._occurredAt - probeTimestamp) / HOUR_MS;
  }

  // Contact-attempt grouping (§9, §29): distinct attempts among human touches
  // only — a contact attempt is, by definition, a human contacting the
  // prospect; auto-ack email is handled separately and never grouped in.
  const contactAttempts = groupContactAttempts(humanTouches);
  const contactAttemptCount = contactAttempts.length;
  const followUpAttempts = contactAttempts.slice(1);
  const followUpCount = followUpAttempts.length;
  const followUpChannels = [...new Set(followUpAttempts.flat().map((c) => c.channel).filter(Boolean))];

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

  // Inbound SMS / email human-contact touches (§9-style evidence count) —
  // automated/auto-ack rows never count, per the human-vs-automated split.
  //
  // No `direction === 'inbound'` check here (unlike an earlier version of
  // this line): every SMS COMMUNICATIONS row in this system already IS
  // inbound by construction — V1 has no outbound-SMS write path
  // (api/novus/webhooks/sms-inbound.js hardcodes direction: 'inbound', the
  // only place SMS rows are ever created) — so the check was redundant for
  // live data and actively harmful for historical/imported rows, where
  // `direction` is frequently left blank. A correctly probe-matched,
  // human-classified imported SMS with no `direction` value still counted
  // toward first_human_touch/grade/channels_used everywhere else, but
  // silently reported inbound_sms_count = 0 — the one field this exact
  // check gated. Matching emailTouchCount below (channel + human_contact
  // only, no direction check) fixes that without changing what "human
  // contact" or grading means.
  const inboundSmsCount = sorted.filter((c) => c.channel === 'sms' && isHumanTouch(c)).length;
  const emailTouchCount = sorted.filter((c) => c.channel === 'email' && isHumanTouch(c)).length;

  const channelsUsed = [...new Set(sorted.map((c) => c.channel).filter(Boolean))];

  const hasProactiveBookingPush = humanTouches.some((c) => String(c.contact_quality || '').trim() === 'proactive_booking_push');

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
    inbound_sms_count: inboundSmsCount,
    email_touch_count: emailTouchCount,
    contact_attempt_count: contactAttemptCount,
    follow_up_count: followUpCount,
    follow_up_channels: followUpChannels.join(','),
    last_touch_at: lastTouchAt,
    days_chased: daysChased,
    booking_attempt: bookingAttempt,
    contact_quality: quality,
    proactive_reactive: proactiveReactive({
      hasHumanContact: humanTouches.length > 0,
      hasProactiveBookingPush,
      followUpCount,
    }),
    persistence_profile: persistenceProfile(followUpCount, channelsUsed),
    channels_used: channelsUsed.join(','),
  };
}

// Which of the given (already-sorted-by-occurred_at, each with a parsed
// _occurredAt) human touches belong to a follow-up contact attempt (the 2nd+
// attempt under the 30-minute grouping rule) rather than the initial attempt.
// Used by the caller to write the per-communication COMMUNICATIONS.follow_up
// flag back to the sheet. A touch grouped into the FIRST attempt is never a
// follow-up, even if it isn't literally the first communication in that
// attempt (e.g. the SMS in "call, then SMS 5 minutes later" is part of
// attempt #1, not a follow-up) — matches follow_up_count exactly.
export function markFollowUps(humanTouchesSortedByTime) {
  const attempts = groupContactAttempts(humanTouchesSortedByTime);
  const out = [];
  attempts.forEach((attempt, attemptIndex) => {
    for (const touch of attempt) {
      out.push({ ...touch, is_follow_up: attemptIndex > 0 });
    }
  });
  return out;
}
