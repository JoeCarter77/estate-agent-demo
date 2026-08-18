// lib/comm-assessment.mjs — what ONE communication actually is, judged with
// the probe's full context available.
//
// This is the layer the pipeline was missing. Previously every per-row
// decision was made by matching a literal phrase against the message body in
// isolation, with no knowledge of the enquiry, the probe property, or the
// other messages in the same conversation. That produces exactly the failures
// visible in the live data:
//
//   - Three identical "please find attached the brochure(s) for properties we
//     think will interest you" blasts, none naming the probe property, were
//     counted as a genuine response plus a genuine follow-up attempt (Grade B).
//     The row WAS classified 'generic' — the rollup simply ignored that.
//   - A voicemail transcribed as literally "Hello." was counted as the first
//     human contact, setting the response-speed band for the whole probe.
//   - "Please could you also confirm your position - sold/selling/nothing to
//     sell" — the agency explicitly qualifying the vendor opportunity — was
//     invisible, because it matched neither the vendor phrase list nor the
//     communication-quality list. It fell between the two detectors.
//
// The signals below are deliberately STRUCTURAL rather than lexical wherever
// possible — does this message name the probe property, is it byte-identical
// in shape to its siblings, is there any substance in the transcript at all,
// what does the row's own ai_summary assert — so the fix does not become
// another phrase list to maintain.
//
// ai_summary is treated as a first-class evidence source. It is an EXISTING,
// already-populated COMMUNICATIONS column (54 of 77 live rows carry an
// analyst-grade sentence such as "Bulk brochure send from a named mailbox.
// Does not reference the probe property and offers no appointment."). Nothing
// in the pipeline read it. It is never overwritten here — only read.

import { detectProactiveBookingPush, isHumanCommunication } from './classification.mjs';
import { addressTokens } from './enquiry.mjs';

// A message is non-substantive when, after removing pure greeting/sign-off
// filler, essentially nothing is left to interpret. Deliberately a content
// test rather than a length cut: a short reply ("Sorry for the delay, calling
// now.") is a real response, while a long automated footer is not made
// substantive by being long.
//
// Applies to text channels only — see assessCommunication() for why a phone
// call is judged by the act of calling rather than by its transcript.
//
// Calibrated against the live transcripts. Non-substantive in the data:
// "Hello." (0 meaningful words), "" (0), "[Unable to transcribe from
// recording." (caught by UNTRANSCRIBED below). Substantive: every genuine
// voicemail and reply, the shortest of which still carries 3+ meaningful
// words.
const SUBSTANCE_MIN_WORDS = 2;

// Pure salutation/sign-off tokens — these carry no information about whether
// the agency engaged with the enquiry, so they do not count toward substance.
const FILLER_WORDS = new Set([
  'hello', 'hi', 'hey', 'good', 'morning', 'afternoon', 'evening', 'thanks',
  'thank', 'cheers', 'regards', 'kind', 'best', 'bye', 'goodbye',
  'oh', 'um', 'uh', 'yeah', 'ok', 'okay',
]);

function meaningfulWordCount(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !FILLER_WORDS.has(w))
    .length;
}

// A recording the transcription service could not turn into words is evidence
// that a call happened, but not evidence of anything the agency said.
const UNTRANSCRIBED = /unable to transcribe|no transcript|transcription failed/i;

// Rightmove stamps the vendor opportunity into the subject line it sends the
// agency ("Potential valuation: Powell Road - Buyer from CM12"). When the
// agency replies ON that subject line, the opportunity was demonstrably in
// front of them — which is what makes ignoring it a finding rather than an
// unknown. Portal-generated, so matched literally.
const PORTAL_VALUATION_SUBJECT = /potential valuation:/i;

// The agency asking the enquirer to state their own sell-side position. This
// is the one genuinely lexical addition, and it is here because the live data
// contains the behaviour in a form neither existing detector could see:
// lib/classification.mjs explicitly documented 'qualification' as "already
// vendor-intent's territory", while lib/vendor-intent.mjs only looked for
// valuation offers — so a direct vendor qualification question matched
// neither.
const VENDOR_POSITION_QUESTION = /confirm your position|your position\s*[-–—:]\s*sold|sold\s*\/\s*selling|are you (?:currently )?selling|do you have (?:a )?propert(?:y|ies) to sell|nothing to sell/i;

// The agency deciding the lead is dead and saying so. In the live data:
// "I'm assuming you haven't replied, so you're not really particularly
// interested in looking..." — the single most commercially interesting thing
// any agency did across 39 probes, and the pipeline had no way to represent it.
const DISQUALIFIES_LEAD = /assuming you (?:haven'?t|have not) replied|not (?:really )?(?:particularly )?interested|take you off|remove you from|close(?:d)? (?:your|the) enquiry|presume you(?:'| a)re no longer/i;

// Pushing the enquirer to go and register themselves instead of the agency
// doing the work. "directing the enquirer to self-register rather than
// offering an appointment" in the live ai_summary data.
const REQUIRES_SELF_SERVICE = /register(?:ing)? (?:with us|on our|your details)|complete (?:the|our) (?:registration|form)|sign up (?:on|at|via)|create an account/i;

function textOf(comm) {
  return String(comm.body_text || comm.raw_content || comm.transcript || '').trim();
}
function haystackOf(comm) {
  return `${String(comm.subject || '')}\n${textOf(comm)}`.toLowerCase();
}
function summaryOf(comm) {
  return String(comm.ai_summary || '').trim();
}

// Does this message demonstrably concern THIS probe's property? Structural:
// the distinctive tokens of the recorded address appearing in subject or body.
// A blank result means "cannot tell from the address we recorded", NOT "no" —
// callers must treat it as unknown, which is why it is returned as a tri-state.
function referencesProbeProperty(comm, enquiry) {
  const tokens = addressTokens(enquiry.property_address);
  if (tokens.length === 0) return null; // unknowable: we never recorded a usable address
  const haystack = haystackOf(comm);
  return tokens.some((t) => haystack.includes(t));
}

// Is there enough content here to tell what the agency said? Uses the row's
// own recorded evidence, never timing.
function isSubstantive(comm) {
  const text = textOf(comm);
  if (!text) return false;
  if (UNTRANSCRIBED.test(text)) return false;
  return meaningfulWordCount(text) >= SUBSTANCE_MIN_WORDS;
}

// A bulk/template send rather than a reply to this enquirer. Two independent
// signals, either sufficient: the existing classifier already called it
// 'generic', or the row's own ai_summary says so in as many words.
function isBulk(comm) {
  if (String(comm.communication_classification || '').trim().toLowerCase() === 'generic') return true;
  const summary = summaryOf(comm).toLowerCase();
  return /\bbulk\b|mailshot|property-match|marketing email|not a response to the enquiry|does not reference the probe property/.test(summary);
}

// comm + parsed enquiry -> a structured assessment of this one message.
// Every field is a fact about the message, never a judgement about the agency
// overall — probe-level conclusions belong in lib/probe-intelligence.mjs.
export function assessCommunication(comm, enquiry) {
  const human = isHumanCommunication(comm);
  const channel = String(comm.channel || '').toLowerCase();

  // The substance test applies to TEXT channels only. For an email or SMS the
  // content IS the entire act — an empty one communicates nothing. For a phone
  // call the act of dialling is itself the response: the agency picked up the
  // phone and rang the enquirer, which is a real contact attempt whether or not
  // a transcript exists (a call may ring unanswered, leave no voicemail, or
  // simply not be transcribed yet when the webhook fires). Judging a call by
  // its transcript would mean an agency that phones promptly scores worse than
  // one that sends a templated email, which is the opposite of the truth.
  const isVoice = channel === 'voice';
  const substantive = isVoice ? true : isSubstantive(comm);
  const bulk = isBulk(comm);
  const referencesProperty = referencesProbeProperty(comm, enquiry);
  const haystack = haystackOf(comm);
  const summary = summaryOf(comm);

  // A GENUINE RESPONSE is a human message with real content that is actually
  // addressed to this enquiry — not a bulk blast, not an empty/untranscribable
  // touch. This is the definition the rollups and the A-H grade now use for
  // "the agency responded", and it is the single most consequential change in
  // this module: under the old definition, three brochure blasts that never
  // mentioned the property counted as a fast, persistent response.
  const genuineResponse = human && substantive && !bulk;

  // Did the agency put an appointment on the table at all? Prefers the row's
  // own booking_attempt (already computed upstream) and the proactive-push
  // detector, with ai_summary as a third independent witness.
  const offersAppointment = comm.booking_attempt === 'TRUE' || comm.booking_attempt === true
    || detectProactiveBookingPush(comm)
    || /offer(?:ed|s)? (?:to arrange |to book )?(?:a )?viewing|offered a viewing|book(?:ed)? (?:a|the) viewing/i.test(summary);

  return {
    communication_id: comm.communication_id,
    channel,
    occurred_at: comm.occurred_at,
    human,
    substantive,
    bulk,
    genuine_response: genuineResponse,
    references_probe_property: referencesProperty,
    offers_appointment: offersAppointment,
    pushes_specific_slot: human && detectProactiveBookingPush(comm),
    // Vendor-side behaviour, judged against what the enquiry actually declared.
    asks_vendor_position: human && VENDOR_POSITION_QUESTION.test(haystack),
    portal_flagged_valuation: PORTAL_VALUATION_SUBJECT.test(String(comm.subject || '')),
    disqualifies_lead: human && DISQUALIFIES_LEAD.test(haystack),
    requires_self_service: REQUIRES_SELF_SERVICE.test(haystack) || /self-register|register rather than/i.test(summary),
    ai_summary: summary,
  };
}

export const _internal = { SUBSTANCE_MIN_WORDS, meaningfulWordCount, isSubstantive, isBulk, referencesProbeProperty };
