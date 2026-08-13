// lib/classification.mjs — deterministic per-COMMUNICATIONS-row interpretation.
//
// NOVUS Project Source Master §29: "Human vs automated — AI + sender/domain
// rules; use hard signals first, AI second." No AI classifier exists in this
// milestone (it is a separate, later roadmap item — §33), so this module
// implements the hard-signal half only. Everything here is a narrow, explicit,
// extensible pattern list — never a guess.
//
// Conservative defaults (per the approved plan):
//   - Only messages matching a KNOWN automated signal are tagged 'automated'.
//     Everything else defaults to 'human' — there is no positive AI "human"
//     signal to require instead in this milestone.
//   - A row with no sender, subject or body at all (degenerate/malformed) is
//     'unknown' rather than guessed either way.
//   - Auto-acknowledgement detection (communication_classification =
//     'auto_acknowledgement') uses the SAME narrow known-string/sender/domain
//     rule set — extend AUTO_SENDER_PATTERNS / AUTO_ACK_PHRASES as real
//     signatures are confirmed. Do not widen this by guessing.
//   - CRM detection (detectCrm) has NO known signature registry yet (none
//     exists in the Source Master or the live data) — it always resolves to
//     'unknown' until a real signature is supplied. Do not invent one.

// Confirmed system/automated sender local-parts — narrow and literal.
const AUTO_SENDER_PATTERNS = [
  /^no-?reply@/i,
  /^donotreply@/i,
  /^do-not-reply@/i,
  /^auto-?reply@/i,
  /^notifications?@/i,
];

// Bounces/system mail — automated, but never an "acknowledgement" of the enquiry.
const MAILER_PATTERNS = [/^mailer-daemon@/i, /^postmaster@/i];

// Known boilerplate phrases indicating an autoresponder. Starter list only —
// extend as real agency auto-reply text is confirmed; do not infer new ones.
const AUTO_ACK_PHRASES = [
  'this is an automated message',
  'this is an automated response',
  'automated reply',
  'auto-reply',
  'auto reply',
  'out of office',
  'we have received your enquiry',
  'thank you for your enquiry, a member of our team will',
  'thanks for your enquiry, one of our team will',
];

// Booking-attempt keyword list — provisional, same conservative posture as
// auto-ack detection. Governs COMMUNICATIONS.booking_attempt only.
const BOOKING_PHRASES = [
  'book a viewing',
  'arrange a viewing',
  'schedule a viewing',
  'book an appointment',
  'arrange an appointment',
  'would you like to view',
  'available to view',
  'book a valuation',
  'arrange a valuation',
];

// No deterministic CRM signature registry exists yet (Source Master §9/§18
// require crm_detected/crm_name/crm_evidence, but supply no signature list).
// Left empty on purpose — populate only with confirmed signatures, never guesses.
const CRM_SIGNATURES = [];
// e.g. { name: 'Reapit', senderPattern: /@reapit\.com$/i }

function haystackOf(comm) {
  const subject = String(comm.subject || '').toLowerCase();
  const body = String(comm.body_text || comm.raw_content || '').toLowerCase();
  return `${subject}\n${body}`;
}

function senderOf(comm) {
  return String(comm.source_identifier_normalized || comm.source_identifier_raw || '').trim().toLowerCase();
}

// Returns { automated_or_human, human_contact, communication_classification, booking_attempt }.
// communication_classification is the existing COMMUNICATIONS column reused to
// carry 'auto_acknowledgement' (or '' when not detected) — no new schema.
export function classifyCommunication(comm) {
  const sender = senderOf(comm);
  const subject = String(comm.subject || '').trim();
  const body = String(comm.body_text || comm.raw_content || '').trim();

  if (!sender && !subject && !body) {
    return { automated_or_human: 'unknown', human_contact: false, communication_classification: '', booking_attempt: false };
  }

  const haystack = haystackOf(comm);
  const isMailerDaemon = MAILER_PATTERNS.some((re) => re.test(sender));
  const isKnownAutoSender = AUTO_SENDER_PATTERNS.some((re) => re.test(sender));
  const hasAutoAckPhrase = AUTO_ACK_PHRASES.some((phrase) => haystack.includes(phrase));

  const isAutomated = isMailerDaemon || isKnownAutoSender || hasAutoAckPhrase;
  // A bounce/system mail is automated but is not an acknowledgement of the enquiry.
  const isAutoAcknowledgement = !isMailerDaemon && (isKnownAutoSender || hasAutoAckPhrase);

  const automatedOrHuman = isAutomated ? 'automated' : 'human';
  const humanContact = automatedOrHuman === 'human';

  const hasBookingPhrase = BOOKING_PHRASES.some((phrase) => haystack.includes(phrase));

  return {
    automated_or_human: automatedOrHuman,
    human_contact: humanContact,
    communication_classification: isAutoAcknowledgement ? 'auto_acknowledgement' : '',
    booking_attempt: hasBookingPhrase,
  };
}

// Returns { crm_detected: true|false|'unknown', crm_name, crm_evidence }.
export function detectCrm(comm) {
  const sender = senderOf(comm);
  for (const sig of CRM_SIGNATURES) {
    if (sig.senderPattern && sig.senderPattern.test(sender)) {
      return { crm_detected: true, crm_name: sig.name, crm_evidence: comm.source_identifier_raw || sender };
    }
  }
  return { crm_detected: 'unknown', crm_name: '', crm_evidence: '' };
}
