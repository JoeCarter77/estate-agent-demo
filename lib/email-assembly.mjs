// lib/email-assembly.mjs — the deterministic assembler that turns ONE
// finalised PERSONALISATION row into the final outreach email.
//
// Pipeline position: PROBE -> DIAGNOSIS -> DIAGNOSIS_FINDINGS ->
// PERSONALISATION -> **EMAIL (here)** -> personalised breakdown / demo journey.
//
// The email is NOT trying to sell NOVUS. Its only job is to make the agency
// curious enough to ask to see what we found. So the structure is fixed, the
// call to action is fixed, and the only thing that varies between two probes
// is the handful of sentences Personalisation wrote about what actually
// happened to that enquiry.
//
// Because the structure is fixed, it lives HERE, in code, and not in the AI
// and not in a template someone edits in another product. Personalisation
// returns sentence-ready components; this file decides the intro, the
// paragraph order, which optional paragraphs appear, which of the two
// structures to use, the FIXED OPENING WORDS of each narrative paragraph, and
// the locked CTA. Nothing in this file rewrites an AI sentence.
//
// THE FIXED PREFIXES. Four paragraphs open with wording that never varies
// between two probes, so that wording lives here and the model supplies only
// the continuation after it:
//   "I want to say upfront that " + fair_observation
//   "What stood out, though, was " + main_finding
//   "That meant "                  + commercial_consequence
//   "That also meant "             + wider_consequence
// Each of those four fields is therefore a LOWER-CASE CONTINUATION, not a
// standalone sentence — lib/probe-personalisation.mjs enforces that contract
// on the way out of the model, and withPrefix() below is the backstop that
// stops a prefix being printed twice if a stored row ever carries one.
// wider_observation is the one narrative field that IS a standalone sentence
// ("I'd also mentioned that I had a property of my own..."), because it opens
// its own paragraph with no fixed wording in front of it.
//
// THE NORMAL STRUCTURE
//
//   Hi {{first_name}},
//
//   We sent your team an enquiry on {enquiry_date} about {property_address}.
//
//   I want to say upfront that {fair_observation}       (optional)
//
//   What stood out, though, was {main_finding}
//
//   That meant {commercial_consequence}
//
//   {wider_observation}                 (optional)
//
//   That also meant {wider_consequence} (optional)
//
//   {additional_findings_hook}          (optional)
//
//   I've put together a personalised breakdown of what we found. Happy to
//   send it over if you'd like to see it.
//
//   Joe
//
// THE NO-RESPONSE STRUCTURE (email_variant = 'no_response')
//
//   A probe that was never replied to has no conversation to describe, so it
//   gets its own fixed shape rather than a normal email with empty slots.
//   The failure IS the silence: there is no fair observation to make and no
//   main finding to narrate, and inventing either would mean describing a
//   conversation that never happened. The wider consequence still applies
//   (a seller/valuation opportunity that was explicitly in our enquiry is
//   still lost), and the closing lines are reworded so they make sense when
//   there was nothing to discuss:
//
//   Hi {{first_name}},
//
//   We sent your team an enquiry on {enquiry_date} about {property_address}.
//
//   We never received a reply.
//
//   That meant {commercial_consequence}
//
//   {wider_observation}                 (optional)
//
//   That also meant {wider_consequence} (optional)
//
//   We found a couple of things that may explain it, so we've put together a
//   short breakdown that might be useful.
//
//   Happy to send it over if you'd like to see it.
//
//   Joe
//
// MERGE FIELDS: enquiry_date and property_address are resolved here, from
// the probe's own facts. {{first_name}} is deliberately left as a literal
// merge token — it is the sending tool's own contact field, not something
// this pipeline knows.
//
// SENDABILITY: assembleEmail returns an EMPTY STRING for a row that cannot
// produce a complete, honest email — no enquiry date, no established property
// address, no commercial consequence, or (in the normal structure) no main
// finding. A blank email_body is therefore the signal that a human needs to
// look at that probe, rather than a half-written email with a gap in it. The
// commercial consequence is on that list deliberately: an email that describes
// a problem and never says what it cost is the exact failure mode this whole
// layer exists to prevent, so it is not sent at all rather than sent hollow.

export const FIRST_NAME_MERGE_FIELD = '{{first_name}}';

// The fixed line that replaces the fair observation + main finding when
// nothing ever came back. Not AI-authored: there is nothing to describe.
export const NO_REPLY_LINE = 'We never received a reply.';

// ── The fixed opening words (see THE FIXED PREFIXES in the header) ───────────
// Each of these is followed by a lower-case continuation, so prefix +
// continuation must read as one correct sentence.

// Paragraph 1 of the narrative: "we're fair". The opener is fixed because its
// job — disarming the reader before anything critical — depends on it sounding
// the same every time, not on the model's phrasing of the day.
export const FAIR_OBSERVATION_PREFIX = 'I want to say upfront that ';

// Paragraph 2: "but here's what actually happened."
export const MAIN_FINDING_PREFIX = 'What stood out, though, was ';

// Paragraph 3: "and here's why that mattered." The most important sentence in
// the email — the one that has to say what the agency failed to find out,
// progress, convert or uncover, not restate the finding.
// "That meant " + "you had a live buyer enquiry in front of you, but the
// conversation never really established where I was in the process."
export const THAT_MEANT_PREFIX = 'That meant ';

// The optional second consequence, when there is a genuinely separate
// commercial implication (most often the seller side sitting inside the same
// enquiry). "That also meant " + "a potential seller instruction sitting
// inside the same enquiry was never explored."
export const THAT_ALSO_MEANT_PREFIX = 'That also meant ';

// DET, never AI-authored. A tease, not a second paragraph of analysis: it
// must NOT reveal what the other findings were, or the email answers the
// question it exists to provoke. Shown only when a genuine finding really
// does sit outside the primary narrative.
export const ADDITIONAL_FINDINGS_HOOK_LINE = 'There were a couple of other things from the enquiry that caught our attention too.';

// LOCKED. Not an "audit" — a breakdown. One paragraph, two sentences.
export const CTA_LINE = "I've put together a personalised breakdown of what we found. Happy to send it over if you'd like to see it.";

// The no-response ending: the same offer, worded so it makes sense when
// there was no conversation to break down.
export const NO_RESPONSE_BREAKDOWN_LINE = "We found a couple of things that may explain it, so we've put together a short breakdown that might be useful.";
export const NO_RESPONSE_CTA_LINE = "Happy to send it over if you'd like to see it.";

export const SIGN_OFF = 'Joe';

export const EMAIL_VARIANTS = ['normal', 'no_response'];

function text(value) {
  return String(value ?? '').trim();
}

// prefix + continuation, without ever printing the prefix twice.
// lib/probe-personalisation.mjs already strips a repeated prefix on the way
// out of the model, so this is the backstop for the other direction: a
// PERSONALISATION row written before a prefix was moved into the assembler
// still carries it in the stored field, and "That meant That meant ..." must
// not be what the prospect reads. Matched case-insensitively on the prefix's
// own words; the continuation is otherwise left exactly as written.
export function withPrefix(prefix, continuation) {
  const value = text(continuation);
  if (!value) return '';
  const lower = value.toLowerCase();
  const prefixLower = prefix.toLowerCase();
  if (lower.startsWith(prefixLower)) return `${prefix}${value.slice(prefix.length)}`;
  // Also catches the prefix written with different trailing spacing.
  const trimmedPrefix = prefixLower.trim();
  if (lower.startsWith(trimmedPrefix)) {
    return `${prefix}${value.slice(trimmedPrefix.length).replace(/^[\s,:-]+/, '')}`;
  }
  return `${prefix}${value}`;
}

// Anything other than the explicit no-response marker is a normal email —
// an unrecognised or missing variant must never silently change the shape of
// the email, and 'normal' is the shape that describes a conversation.
export function normaliseVariant(variant) {
  return text(variant) === 'no_response' ? 'no_response' : 'normal';
}

export function openingLine(enquiryDate, propertyAddress) {
  return `We sent your team an enquiry on ${text(enquiryDate)} about ${text(propertyAddress)}.`;
}

// True when this row carries everything its structure needs. See SENDABILITY
// in the file header: the caller uses a blank email_body, not a flag, but
// this predicate is exported so tests and any future review UI can ask the
// question directly.
export function isSendable(personalisation) {
  const p = personalisation || {};
  if (!text(p.enquiry_date)) return false;
  if (!text(p.property_address)) return false;
  if (!text(p.commercial_consequence)) return false;
  if (normaliseVariant(p.email_variant) === 'normal' && !text(p.main_finding)) return false;
  return true;
}

// personalisation: the email-facing fields of one PERSONALISATION row —
// email_variant, enquiry_date, property_address, fair_observation,
// main_finding, commercial_consequence, wider_observation, wider_consequence,
// additional_findings_hook. Returns the complete email body, or '' when the
// row is not sendable.
export function assembleEmail(personalisation) {
  const p = personalisation || {};
  if (!isSendable(p)) return '';

  const variant = normaliseVariant(p.email_variant);
  const paragraphs = [
    `Hi ${FIRST_NAME_MERGE_FIELD},`,
    openingLine(p.enquiry_date, p.property_address),
  ];

  if (variant === 'no_response') {
    // No fair observation: there was no interaction to be fair about, and
    // manufacturing one would be the single most obvious lie in the email.
    paragraphs.push(NO_REPLY_LINE);
  } else {
    if (text(p.fair_observation)) paragraphs.push(withPrefix(FAIR_OBSERVATION_PREFIX, p.fair_observation));
    paragraphs.push(withPrefix(MAIN_FINDING_PREFIX, p.main_finding));
  }

  paragraphs.push(withPrefix(THAT_MEANT_PREFIX, p.commercial_consequence));

  // The wider beat is two paragraphs, either of which may be absent: the
  // observation that there was something else in the enquiry, and the separate
  // consequence of it never being picked up.
  if (text(p.wider_observation)) paragraphs.push(text(p.wider_observation));
  if (text(p.wider_consequence)) paragraphs.push(withPrefix(THAT_ALSO_MEANT_PREFIX, p.wider_consequence));

  if (variant === 'no_response') {
    // No additional_findings_hook here — the breakdown line below already
    // says there were a couple of things, so the hook would say it twice.
    paragraphs.push(NO_RESPONSE_BREAKDOWN_LINE);
    paragraphs.push(NO_RESPONSE_CTA_LINE);
  } else {
    if (text(p.additional_findings_hook)) paragraphs.push(text(p.additional_findings_hook));
    paragraphs.push(CTA_LINE);
  }

  paragraphs.push(SIGN_OFF);
  return paragraphs.join('\n\n');
}
