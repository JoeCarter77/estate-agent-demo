// lib/email-assembly.mjs — the deterministic assembler that turns ONE
// finalised PERSONALISATION row into the final outreach email.
//
// Pipeline position: COMMUNICATIONS -> INTELLIGENCE -> DIAGNOSIS ->
// DIAGNOSIS_FINDINGS -> PERSONALISATION + PROBE -> **EMAIL (here)** ->
// personalised breakdown / demo journey.
//
// NOTHING IN THIS FILE CHANGED when Personalisation was refactored onto
// findings-only input. The email contract, the two variants, the fixed
// prefixes, propertyReference(), the price rules and the sendability gate are
// all exactly as they were — the layer above now CHOOSES its sentences
// differently, and this layer still just puts them in order.
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
// THE STRUCTURE IS LOCKED, AND THERE ARE EXACTLY TWO VARIANTS.
//
// VARIANT 2 — NORMAL (every case where a human made any contact)
//
//   Hi {{first_name}},
//
//   We sent your team an enquiry on {enquiry_date} about {property_address}.
//
//   I want to say upfront that {fair_observation}       (MANDATORY)
//
//   What stood out, though, was {main_finding}          (MANDATORY)
//
//   That meant {commercial_consequence}                 (MANDATORY)
//
//   {wider_observation}                                 (optional)
//
//   That also meant {wider_consequence}                 (only with wider_observation)
//
//   There were a couple of other things from the enquiry that caught our attention too.
//
//   I've put together a personalised breakdown of what we found. Happy to
//   send it over if you'd like to see it.
//
//   Joe
//
// VARIANT 1 — NO RESPONSE (email_variant = 'no_response', used ONLY when
// INTELLIGENCE.human_contact === 'none')
//
//   A probe that was never replied to has no conversation to describe, so it
//   gets its own fixed shape rather than a normal email with empty slots.
//   The failure IS the silence: there is no fair observation to make and no
//   main finding to narrate, and inventing either would mean describing a
//   conversation that never happened.
//
//   Hi {{first_name}},
//
//   We sent your team an enquiry on {enquiry_date} about {property_address}.
//
//   We never received a reply.
//
//   That meant {commercial_consequence}                 (MANDATORY)
//
//   {wider_observation}                                 (optional)
//
//   That also meant {wider_consequence}                 (only with wider_observation)
//
//   We found a couple of things that may explain it, so we've put together a
//   short breakdown that might be useful.
//
//   Happy to send it over if you'd like to see it.
//
//   Joe
//
// THE FINAL TWO PARAGRAPHS OF EACH VARIANT ARE LOCKED AND APPEAR IN EVERY
// SENDABLE EMAIL OF THAT VARIANT, including when there is nothing beyond the
// primary narrative. "There were a couple of other things..." is NOT a promise
// of two more findings and is not conditional on any leftover finding: it is
// the curiosity transition into the personalised breakdown, and it is valid
// whenever we are about to offer that breakdown — which is always, because the
// offer is the only reason the email exists. The no-response variant makes the
// same offer in its own two lines, because there was no conversation to say
// "a couple of OTHER things" about. None of these lines is ever AI-written,
// and none is ever varied.
//
// THE WIDER BEAT is optional and comes as a pair: wider_consequence exists
// only where wider_observation does, because "That also meant ..." with
// nothing in front of it is a consequence of something the reader was never
// told. An orphan wider_consequence is dropped here as well as upstream.
//
// THE PROPERTY WORDING is decided here too, deterministically — see
// propertyReference(). We enquired about a HOUSE, not about a street, so a
// stored address that is only a road name reads as "about a house on Perry
// Street" and never "about Perry Street". A number is only ever printed when
// the stored address actually carries one; none is ever invented.
//
// MERGE FIELDS: enquiry_date and property_address are resolved here, from
// the probe's own facts. {{first_name}} is deliberately left as a literal
// merge token — it is the sending tool's own contact field, not something
// this pipeline knows.
//
// SENDABILITY IS A CONTRACT, NOT A BEST EFFORT. assembleEmail returns an
// EMPTY STRING for a row that cannot produce a complete, honest email, and
// emailContractViolations() says exactly why. A normal email needs ALL THREE
// of fair_observation, main_finding and commercial_consequence: a probe with
// human contact but no fair observation, or no commercial consequence, is NOT
// sendable and fails here rather than producing an incomplete email. A blank
// email_body is therefore the signal that a human needs to look at that probe.
// The commercial consequence is on that list deliberately: an email that
// describes a problem and never says what it cost is the exact failure mode
// this whole layer exists to prevent. So is the fair observation: an email
// that opens with criticism is the other one.

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

// LOCKED, never AI-authored, and never conditional. The curiosity transition
// into the offer of the breakdown — not a promise of exactly two more
// findings, and not a second paragraph of analysis: it must NOT reveal what
// else was found, or the email answers the question it exists to provoke.
// It appears in EVERY sendable email, in both variants.
export const ADDITIONAL_FINDINGS_HOOK_LINE = 'There were a couple of other things from the enquiry that caught our attention too.';

// LOCKED. Not an "audit" — a breakdown. One paragraph, two sentences. The
// model is never asked to write it.
export const CTA_LINE = "I've put together a personalised breakdown of what we found. Happy to send it over if you'd like to see it.";

// The no-response ending: the same offer, worded so it makes sense when there
// was no conversation to break down. Two paragraphs, and they replace BOTH of
// the normal variant's closing lines — a probe that was never replied to is
// not offered "a couple of other things we noticed" on top of a breakdown that
// already says there were a couple of things.
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

// "Was" can introduce either a noun phrase ("was the lack of a next step")
// or a finite clause ("was that I had already told you..."). Personalisation
// normally supplies the complementiser for the latter, but older/stored rows
// and occasional model output do not. Add it only for clear clause openings;
// noun phrases and participial continuations remain untouched.
function mainFindingNeedsThat(value) {
  if (/^that\b/i.test(value)) return false;
  if (/^(?:I(?:['’]\w+)?|you(?:['’]\w+)?|we(?:['’]\w+)?|they(?:['’]\w+)?|he|she|it(?:['’]\w+)?|there(?:['’]\w+)?|nobody|no one|nothing|everything|everyone|all\b|each\b|every\b)/i.test(value)) return true;
  if (/^(?:across|after|before|during|in|over|throughout)\b[^,]*,\s*(?:I|you|we|they|he|she|it|there|nobody|no one)\b/i.test(value)) return true;
  if (/^[^,.!?]+\b(?:was|were|is|are|has|had|did|took)\b/i.test(value)) return true;
  return false;
}

export function withMainFindingPrefix(continuation) {
  const value = text(continuation);
  if (!value) return '';
  const shaped = mainFindingNeedsThat(value) ? `that ${value}` : value;
  return withPrefix(MAIN_FINDING_PREFIX, shaped);
}

// Anything other than the explicit no-response marker is a normal email —
// an unrecognised or missing variant must never silently change the shape of
// the email, and 'normal' is the shape that describes a conversation.
export function normaliseVariant(variant) {
  return text(variant) === 'no_response' ? 'no_response' : 'normal';
}

// ── The property the email opens on ──────────────────────────────────────────
//
// "We sent your team an enquiry on 10 August about Perry Street." is wrong: we
// did not enquire about a street. The wording is decided HERE, deterministically
// from the stored address, and never by the model — and no number is ever
// invented for an address that does not carry one.
//
//   "14 Perry Street"            -> "about 14 Perry Street."
//   "Apt 16, Southwood Court..." -> "about Apt 16, Southwood Court."
//   "Fox Cottage"                -> "about Fox Cottage."
//   "Perry Street"               -> "about a house on Perry Street."
//
// Only the first part of the address is used. The agency knows its own stock,
// and "a house on Rayleigh Road, Basildon, SS14" is a database record where
// "a house on Rayleigh Road" is a sentence.

// The words a UK street name ends in. A first segment ending in one of these,
// with no number in front of it, is a ROAD and not a property — that is the
// case that needs "a house on" in front of it.
const ROAD_SUFFIXES = new Set([
  'street', 'road', 'lane', 'avenue', 'close', 'drive', 'way', 'court', 'place',
  'crescent', 'grove', 'terrace', 'hill', 'gardens', 'garden', 'park', 'mews',
  'row', 'walk', 'rise', 'view', 'green', 'square', 'parade', 'chase', 'end',
  'vale', 'field', 'fields', 'meadow', 'meadows', 'broadway', 'circus', 'hollow',
]);

// A first segment that is only a subdivision — "Flat 2", "Apt 16" — does not
// identify the property on its own, so it keeps the segment after it:
// "Apt 16, Southwood Court", never "Apt 16".
const SUBDIVISION_RE = /^(?:flat|apt|apartment|unit|suite|room|studio)\b/i;

// True when the segment names an actual property: a house number ("14 Perry
// Street", "1a Oak Road"), or a named building ("Fox Cottage", "The Old Barn").
// False for a bare road name.
function namesAProperty(segment) {
  const trimmed = text(segment);
  if (!trimmed) return false;
  if (/^\d/.test(trimmed)) return true;                       // 14 Perry Street
  if (SUBDIVISION_RE.test(trimmed)) return true;              // Apt 16
  const lastWord = trimmed.split(/\s+/).pop().replace(/[^A-Za-z]/g, '').toLowerCase();
  return !ROAD_SUFFIXES.has(lastWord);                        // Fox Cottage vs Perry Street
}

// The stored (already note-stripped) address -> the phrase after "about ".
// Returns '' for a blank address, which makes the row unsendable rather than
// producing "an enquiry on 10 August about ." — see emailContractViolations().
export function propertyReference(propertyAddress) {
  const segments = text(propertyAddress).split(',').map((part) => part.trim()).filter(Boolean);
  if (segments.length === 0) return '';

  const head = SUBDIVISION_RE.test(segments[0]) && segments[1]
    ? `${segments[0]}, ${segments[1]}`
    : segments[0];

  return namesAProperty(segments[0]) ? head : `a house on ${head}`;
}

export function openingLine(enquiryDate, propertyAddress) {
  return `We sent your team an enquiry on ${text(enquiryDate)} about ${propertyReference(propertyAddress)}.`;
}

// Every reason this row cannot produce a complete, honest email, as a list of
// short machine-readable codes ('' when it is sendable). This is the contract
// in CODE rather than in a prompt: a probe with human contact and no fair
// observation, or no commercial consequence, does not quietly send a shorter
// email — it fails here, and the blank email_body is the signal that a human
// should look at it.
export function emailContractViolations(personalisation) {
  const p = personalisation || {};
  const violations = [];
  if (!text(p.enquiry_date)) violations.push('missing_enquiry_date');
  if (!text(p.property_address)) violations.push('missing_property_address');
  if (!text(p.commercial_consequence)) violations.push('missing_commercial_consequence');
  if (normaliseVariant(p.email_variant) === 'normal') {
    // Both mandatory in variant 2. The no-response variant has neither by
    // design: there was no interaction to be fair about and no conversation
    // to narrate.
    if (!text(p.fair_observation)) violations.push('missing_fair_observation');
    if (!text(p.main_finding)) violations.push('missing_main_finding');
  }
  return violations;
}

// True when this row carries everything its structure needs. See SENDABILITY
// in the file header; emailContractViolations() gives the reasons.
export function isSendable(personalisation) {
  return emailContractViolations(personalisation).length === 0;
}

// personalisation: the email-facing fields of one PERSONALISATION row —
// email_variant, enquiry_date, property_address, fair_observation,
// main_finding, commercial_consequence, wider_observation, wider_consequence.
// Returns the complete email body, or '' when the row is not sendable.
export function assembleEmail(personalisation) {
  const p = personalisation || {};
  if (!isSendable(p)) return '';

  const variant = normaliseVariant(p.email_variant);
  const paragraphs = [
    `Hi ${FIRST_NAME_MERGE_FIELD},`,
    openingLine(p.enquiry_date, p.property_address),
  ];

  if (variant === 'no_response') {
    // No fair observation and no main finding: there was no interaction to be
    // fair about and no conversation to narrate, and manufacturing either
    // would be the single most obvious lie in the email.
    paragraphs.push(NO_REPLY_LINE);
  } else {
    paragraphs.push(withPrefix(FAIR_OBSERVATION_PREFIX, p.fair_observation));
    paragraphs.push(withMainFindingPrefix(p.main_finding));
  }

  paragraphs.push(withPrefix(THAT_MEANT_PREFIX, p.commercial_consequence));

  // The optional wider beat, in both variants. The consequence exists only
  // where the observation does — "That also meant ..." on its own is the
  // consequence of something the reader was never told.
  if (text(p.wider_observation)) {
    paragraphs.push(text(p.wider_observation));
    if (text(p.wider_consequence)) paragraphs.push(withPrefix(THAT_ALSO_MEANT_PREFIX, p.wider_consequence));
  }

  // LOCKED, per variant: the curiosity transition then the offer, or — when
  // there was no conversation at all — the two lines that make the same offer
  // in terms that still make sense. The stored additional_findings_hook is
  // deliberately NOT read: neither line is conditional, and neither is the
  // model's to write.
  if (variant === 'no_response') {
    paragraphs.push(NO_RESPONSE_BREAKDOWN_LINE);
    paragraphs.push(NO_RESPONSE_CTA_LINE);
  } else {
    paragraphs.push(ADDITIONAL_FINDINGS_HOOK_LINE);
    paragraphs.push(CTA_LINE);
  }

  paragraphs.push(SIGN_OFF);
  return paragraphs.join('\n\n');
}
