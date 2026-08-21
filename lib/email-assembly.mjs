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
// structures to use, and the locked CTA. Nothing in this file rewrites an AI
// sentence — the ONE piece of grammar assembled here is the hard-coded
// "That meant " prefix in front of commercial_consequence.
//
// THE NORMAL STRUCTURE
//
//   Hi {{first_name}},
//
//   We sent your team an enquiry on {enquiry_date} about {property_address}.
//
//   {fair_observation}                  (optional)
//
//   {main_finding}
//
//   That meant {commercial_consequence}
//
//   {wider_consequence}                 (optional)
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
//   {wider_consequence}                 (optional)
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
// look at that probe, rather than a half-written email with a gap in it.

export const FIRST_NAME_MERGE_FIELD = '{{first_name}}';

// The fixed line that replaces the fair observation + main finding when
// nothing ever came back. Not AI-authored: there is nothing to describe.
export const NO_REPLY_LINE = 'We never received a reply.';

// The one piece of grammar assembled in code. Personalisation returns only
// the continuation, so this prefix and that continuation must read as one
// sentence: "That meant " + "the £425,000 enquiry was getting attention, but
// it wasn't really being progressed."
export const THAT_MEANT_PREFIX = 'That meant ';

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
// main_finding, commercial_consequence, wider_consequence,
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
    paragraphs.push(NO_REPLY_LINE);
  } else {
    if (text(p.fair_observation)) paragraphs.push(text(p.fair_observation));
    paragraphs.push(text(p.main_finding));
  }

  paragraphs.push(`${THAT_MEANT_PREFIX}${text(p.commercial_consequence)}`);

  if (text(p.wider_consequence)) paragraphs.push(text(p.wider_consequence));

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
