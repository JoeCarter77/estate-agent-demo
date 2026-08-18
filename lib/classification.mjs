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
//
// HUMAN communication quality (communication_classification, extended):
// Inspected the 37 real historical human communications (16 email, 21 voice)
// in NOVUS_Data_V1_Master_v2. Two — and only two — distinct, repeatedly-
// evidenced behaviours emerged beyond "human vs automated":
//   'generic'  — bulk/impersonal content from a human sender: no reference to
//                the specific enquiry/property, reads as a template blast
//                (e.g. three near-identical "brochure" sends from one agency,
//                none naming the probe property). Evidence: com_hist_e0008/9/10.
//   'reactive' — a personal reply/callback that clearly references THIS
//                enquiry (names the property, or says "regarding your
//                enquiry"/"tried to call"/"give me a call back") but does not
//                itself constitute a booking offer. Evidence: the large
//                majority of the 21 voicemail transcripts, plus several
//                "we tried to call, let us know your availability" emails.
// Deliberately excluded (insufficient independent real-data support):
//   'booking attempt' — already a separate COMMUNICATIONS.booking_attempt
//     column with its own logic below; reusing it here would duplicate it.
//   'proactive' — every human touch in the historical data is a response to
//     an inbound enquiry; no genuine unprompted-outreach pattern exists to
//     distinguish it from 'reactive'. (Persistence/follow-up over time is
//     already tracked separately by COMMUNICATIONS.follow_up.)
//   'qualification' — the one candidate example ("confirm your position -
//     sold/selling/nothing to sell?") is a vendor-status question, already
//     lib/vendor-intent.mjs's territory; no independent qualification
//     pattern (budget/timeline/mortgage) exists in the data.
//   'information only' — the real "information only" pattern (automated
//     property-match mailshots) is exclusively AUTOMATED in the data, so it
//     collapses into 'generic' the moment it's restricted to human rows.
// Same conservative posture as the rest of this file: narrow literal phrase
// lists drawn from real recurring wording, never a guess, only ever applied
// to human_contact rows. A human row matching neither list keeps
// communication_classification = '' (no confident signal), same default as
// today — this is a strict extension, not a replacement.

const GENERIC_BULK_PHRASES = [
  'we think will interest you',
];

const REACTIVE_CONTACT_PHRASES = [
  'give me a call back',
  'give us a call back',
  'call me back',
  'return the call',
  'call back on',
  'call back number',
  'we tried to call',
  'we have tried to call',
  'i have tried to call',
  "i've tried to call",
  'tried to call you',
  'phoned you and left a message',
  'left a message',
  'leave a message',
  'regarding your enquiry',
  'regarding your inquiry',
  'regarding your request',
  'regarding an enquiry',
  'regarding an inquiry',
  'in regards to an enquiry',
  'in regards to an inquiry',
  'calling regarding your',
  'trying to catch up with you regarding',
  'received your enquiry',
  'received your inquiry',
  'you inquired on',
  'you sent us an inquiry',
  'you sent in to us',
  'you put in a request',
];

// Human-only, checked in this order: a genuine personal/callback reference to
// the enquiry (stronger, more actionable signal) takes priority over a bulk-
// template match, in the unlikely event a message contains both.
function classifyHumanCommunicationQuality(haystack) {
  if (REACTIVE_CONTACT_PHRASES.some((phrase) => haystack.includes(phrase))) return 'reactive';
  if (GENERIC_BULK_PHRASES.some((phrase) => haystack.includes(phrase))) return 'generic';
  return '';
}

// PROACTIVE BOOKING PUSH (COMMUNICATIONS.contact_quality, human rows only) —
// inspected all 14 real historical human viewing/booking-related messages
// (email + voicemail). 11 of the 14 actively push toward a concrete next
// step — a specific slot ("Saturday 15th August at 3pm", "10am Friday
// morning") or an explicit ask for the prospect's availability/days/times
// ("let me know your availability", "what days/times work best", "when
// would be a suitable date and time", "when are you free"). The remaining
// 3 are single generic invitations with no timing component at all, or are
// fully conditional on the prospect calling back first with nothing further
// offered ("would you like to arrange a viewing?", "we can make you an
// appointment to view [if you call back]"). Those 3 stay blank.
//
// Deliberately independent of BOOKING_PHRASES/hasBookingPhrase below: real
// data showed booking_attempt's literal phrase list misses several of the
// strongest examples here (e.g. "attend a viewing... at 3pm" and "available
// to view at 10am Friday morning" match neither 'book a viewing' nor
// 'arrange a viewing' nor 'available to view' exactly), so gating this
// signal on booking_attempt would inherit that blind spot. Same conservative
// posture as the rest of this file: narrow, literal, evidence-backed: never
// a guess, never touching booking_attempt, communication_classification,
// vendor intent, or A-H grading.
const PROACTIVE_TIME_PATTERN = /\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i;

const PROACTIVE_AVAILABILITY_PHRASES = [
  'suitable date and time',
  'suitable dates and times',
  'suitable dates/times',
  'your availability',
  'days and times',
  'days/times',
  'what days',
  'which days',
  'when would be a suitable',
  'when are you free',
  'when suits',
  'available to view saturday',
  'available to view sunday',
  'available to view monday',
  'available to view tuesday',
  'available to view wednesday',
  'available to view thursday',
  'available to view friday',
];

// Exported so the historical backfill (lib/communications-backfill.mjs) can
// apply the exact same detection logic to already-classified rows without
// re-running (or risking disturbing) automated_or_human/booking_attempt.
export function detectProactiveBookingPush(comm) {
  const haystack = haystackOf(comm);
  return PROACTIVE_TIME_PATTERN.test(haystack) || PROACTIVE_AVAILABILITY_PHRASES.some((phrase) => haystack.includes(phrase));
}

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

// Generic template/CRM-branding signals — content that reads as system-
// generated even without an exact AUTO_ACK_PHRASES match (e.g. an "Email
// Template" boilerplate acknowledgement, or a booking-bot signature/link).
// Same conservative posture: narrow and literal, extend only as real
// signatures are confirmed.
const TEMPLATE_SIGNAL_PHRASES = ['email template', 'greetings from'];
const BOT_BRANDING_PATTERNS = [
  /\bchatbot\b/i,
  /\bbot\.[a-z0-9-]+\.[a-z]{2,}/i, // e.g. bot.bridgeai.co.uk
  /powered by [a-z0-9 .-]*(ai|bot)\b/i,
];

// A first-person self-introduction ("it's Kareena from...", "this is Jane
// from...") is treated as strong evidence of genuinely human-written content
// — it overrides the timing-proximity signal below, per the NOVUS rule that
// timing alone must never make something automated.
const PERSONAL_INTRO_PATTERN = /\b(?:it'?s|this is|my name is)\s+[a-z][a-z'-]{1,30}\b/i;

// A communication landing within this many minutes of the probe being sent
// is, on its own, not evidence of anything — it only strengthens an existing
// non-human-content signal into a confident 'automated' call.
const TIMING_PROXIMITY_MINUTES = 4;

function minutesBetween(a, b) {
  const t1 = new Date(a).getTime();
  const t2 = new Date(b).getTime();
  if (Number.isNaN(t1) || Number.isNaN(t2)) return null;
  return Math.abs(t1 - t2) / 60000;
}

// No deterministic CRM signature registry exists yet (Source Master §9/§18
// require crm_detected/crm_name/crm_evidence, but supply no signature list).
// Left empty on purpose — populate only with confirmed signatures, never guesses.
const CRM_SIGNATURES = [];
// e.g. { name: 'Reapit', senderPattern: /@reapit\.com$/i }

function haystackOf(comm) {
  const subject = String(comm.subject || '').toLowerCase();
  const body = String(comm.body_text || comm.raw_content || comm.transcript || '').toLowerCase();
  return `${subject}\n${body}`;
}

function senderOf(comm) {
  return String(comm.source_identifier_normalized || comm.source_identifier_raw || '').trim().toLowerCase();
}

// Returns { automated_or_human, human_contact, communication_classification, booking_attempt, contact_quality }.
// communication_classification is the existing COMMUNICATIONS column, now
// carrying 'auto_acknowledgement' (automated rows), 'generic' or 'reactive'
// (human rows — see the human-quality block above), or '' when no confident
// signal exists — no new schema.
// contact_quality is a SEPARATE existing COMMUNICATIONS column (previously
// never written per-row — only INTELLIGENCE.contact_quality, a different,
// probe-level rollup, was ever set), now carrying 'proactive_booking_push'
// for human rows matching the detector above, or '' otherwise. Independent
// of booking_attempt, communication_classification and vendor intent — see
// the PROACTIVE BOOKING PUSH block above for why.
//
// channel-aware: the email-specific sender-pattern checks (AUTO_SENDER_PATTERNS,
// MAILER_PATTERNS) only apply to comm.channel === 'email'. A phone call or SMS
// has no mail-robot-equivalent sender header — a call/text is, on its face,
// made by a person dialling/texting a number — so voice/SMS default to
// 'human' unless a known auto-ack PHRASE appears in the body/transcript (e.g.
// a spoken or texted autoresponder message). This does not change the email
// path at all.
// context.probeTimestamp: the probe's probe_timestamp (ISO-ish), when this
// comm has been matched to a probe. Used ONLY as a secondary, auditable
// signal — see TIMING_PROXIMITY_MINUTES above. Never the sole determinant.
export function classifyCommunication(comm, context = {}) {
  const channel = String(comm.channel || 'email').toLowerCase();
  const sender = senderOf(comm);
  const subject = String(comm.subject || '').trim();
  const body = String(comm.body_text || comm.raw_content || comm.transcript || '').trim();

  if (!sender && !subject && !body) {
    return { automated_or_human: 'unknown', human_contact: false, communication_classification: '', booking_attempt: false, contact_quality: '' };
  }

  const haystack = haystackOf(comm);
  const isMailerDaemon = channel === 'email' && MAILER_PATTERNS.some((re) => re.test(sender));
  const isKnownAutoSender = channel === 'email' && AUTO_SENDER_PATTERNS.some((re) => re.test(sender));
  const hasAutoAckPhrase = AUTO_ACK_PHRASES.some((phrase) => haystack.includes(phrase));
  const hasTemplateSignal = TEMPLATE_SIGNAL_PHRASES.some((phrase) => haystack.includes(phrase))
    || BOT_BRANDING_PATTERNS.some((re) => re.test(haystack));
  const hasBookingPhrase = BOOKING_PHRASES.some((phrase) => haystack.includes(phrase));
  const hasPersonalIntro = PERSONAL_INTRO_PATTERN.test(haystack);

  // Timing-proximity signal: only ever strengthens a weak/absent content
  // signal into 'automated', and only when the content shows no sign of
  // being genuinely human-written (no self-introduction) AND already looks
  // at least somewhat generic/templated (a booking phrase or template/bot
  // signal). Close timing with no content signal at all, or with a personal
  // introduction present, never flips a communication to automated — timing
  // alone must never decide this (auditable: derived only from the already-
  // recorded occurred_at / probe_timestamp, never mutates either).
  let isTimingProximateAndGeneric = false;
  if (context.probeTimestamp && comm.occurred_at && !hasPersonalIntro) {
    const minutes = minutesBetween(comm.occurred_at, context.probeTimestamp);
    if (minutes !== null && minutes <= TIMING_PROXIMITY_MINUTES && (hasBookingPhrase || hasTemplateSignal)) {
      isTimingProximateAndGeneric = true;
    }
  }

  const isAutomated = isMailerDaemon || isKnownAutoSender || hasAutoAckPhrase || hasTemplateSignal || isTimingProximateAndGeneric;
  // A bounce/system mail is automated but is not an acknowledgement of the enquiry.
  const isAutoAcknowledgement = !isMailerDaemon && (isKnownAutoSender || hasAutoAckPhrase || hasTemplateSignal || isTimingProximateAndGeneric);

  const automatedOrHuman = isAutomated ? 'automated' : 'human';
  const humanContact = automatedOrHuman === 'human';

  // communication_classification: 'auto_acknowledgement' for automated rows
  // (unchanged); for human rows, the quality signal above — independent of,
  // and never overriding, booking_attempt (computed separately just below)
  // or vendor intent (lib/vendor-intent.mjs, a different column entirely).
  const communicationClassification = isAutoAcknowledgement
    ? 'auto_acknowledgement'
    : (humanContact ? classifyHumanCommunicationQuality(haystack) : '');

  // contact_quality: independent of booking_attempt (see above) and of
  // communication_classification — a message can be both 'reactive' and a
  // proactive booking push at once (they live in different columns).
  const contactQuality = humanContact && detectProactiveBookingPush(comm) ? 'proactive_booking_push' : '';

  return {
    automated_or_human: automatedOrHuman,
    human_contact: humanContact,
    communication_classification: communicationClassification,
    booking_attempt: hasBookingPhrase,
    contact_quality: contactQuality,
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
