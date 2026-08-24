// lib/probe-personalisation.mjs — the ONE AI call that turns a probe's own
// facts plus its already-settled DIAGNOSIS_FINDINGS into the story, and into
// the sentence-ready copy the outreach email is built from.
//
// Pipeline position: COMMUNICATIONS -> INTELLIGENCE -> DIAGNOSIS ->
// DIAGNOSIS_FINDINGS -> PERSONALISATION + PROBE -> EMAIL -> personalised
// breakdown / demo journey.
//
// TWO INPUTS, AND ONLY TWO. The story-generation call receives the PROBE's
// factual context (property, value, enquiry date, what our enquiry said) and
// the probe's DIAGNOSIS_FINDINGS rows (index, type, finding, evidence,
// significance_note). It does NOT receive the DIAGNOSIS prose, the
// INTELLIGENCE prose, or the raw COMMUNICATIONS — those layers still run,
// unchanged, upstream; they are simply no longer read here. Everything the
// email is allowed to say now has to exist as a structured finding, which is
// why Diagnosis's strengths are also findings now (typed 'positive') rather
// than a paragraph this layer had to distil.
//
// THE STORY IS SELECTED, NOT COMPOSED. Three indexes into that findings list
// — positive_finding_index, main_finding_index, wider_finding_index — decide
// which finding each email beat is written from, and the code validates every
// one of them against the findings that exist and the type each beat requires.
// The wider beat is refused when it is the main story again, by index OR by
// wording, which is what stops one enquiry's seller opportunity being told
// twice in the same email.
//
// WHAT THE EMAIL IS FOR. It is not selling NOVUS. Its ONLY job is to make the
// agency curious enough to ask to see what we found. It reads like: we sent
// you an enquiry, here is what happened from our side, here is what that cost
// commercially, and we found some other interesting things too. Fair, sharp,
// specific — never an audit, never a grading, never a consultant's report.
// The reader should think "fair enough, I can see what they mean", and then
// "what else did they find?".
//
// THIS LAYER WRITES THE SENTENCES; lib/email-assembly.mjs PUTS THEM IN ORDER.
// That split is the point. What is TRUE about this probe is a judgement, and
// it belongs here. The SHAPE of the email — intro, paragraph order, which
// optional paragraphs appear, the no-response structure, the locked CTA, the
// merge fields — is fixed, so it belongs in code where a human controls it,
// not in an AI that rewrites it slightly every time. Nothing here assembles a
// body, and nothing in the assembler rewrites an AI sentence.
//
// SENTENCE-READY IS THE CONTRACT. Every email field returned here is copy that
// drops straight into the email with no repair. Not labels ("Poor follow-up",
// "Weak qualification" — those are Diagnosis concepts, not email copy), not
// fragments the code has to fix up.
//
// The assembler owns the FIXED OPENING WORDS of four paragraphs, so those four
// fields are LOWER-CASE CONTINUATIONS and the rest are whole sentences:
//   "I want to say upfront that " + fair_observation
//   "What stood out, though, was " + main_finding
//   "That meant "                  + commercial_consequence
//   "That also meant "             + wider_consequence
//   wider_observation              — its own sentence, no prefix
// asContinuation() enforces the first four (prefix stripped if the model
// wrote it, first letter lower-cased, terminal punctuation guaranteed) and
// asStandaloneSentence() the last, so what the assembler prints is correct
// English whatever the model returned.
//
// VOICE. The email is written TO the agency by the person who actually sent
// the enquiry. They are "you"; we are "I"/"we"/"me". Detached third-person
// commentary ("They didn't let this one go cold") is the failure mode — it
// reads as a system describing them behind their back rather than a person
// writing to them. readsAsDetachedThirdPerson() is the code backstop.
//
// THE SINGLE RULE AT THE CENTRE OF THIS LAYER: do not optimise for describing
// problems, optimise for revealing missed opportunities. For every finding,
// the question is "because this happened, what did the agency fail to find
// out, progress, convert, or uncover?" — the answer to THAT is what the email
// is made of, and it is why commercial_consequence, not main_finding, is the
// field this whole module exists to get right.
//
// MOST ENQUIRIES CONTAIN MORE THAN ONE USEFUL FINDING, and that is the
// default here, not the exception. Diagnosis lists every genuine,
// independently evidence-backed finding and why each matters. It does NOT
// decide which of them is the story. That judgement is this file's entire
// job: look across the COMPLETE set — slow response, generic replies, no
// follow-up, follow-ups that just ask the prospect to come back, weak
// qualification, no progression to a viewing, the seller side never explored,
// a valuation never identified — and ask which COMBINATION tells the
// strongest, fairest, most commercially meaningful story about what happened
// to this enquiry. Findings 1 + 2 + 4 combining into one narrative with 3 in
// support is a better answer than narrating finding #1. The result must read
// as one story, not a list of problems.
//
// It is NOT a second Diagnosis engine. It never re-grades, re-diagnoses,
// invents a finding, or second-guesses novus_opportunity. Intelligence and
// Diagnosis are inputs, treated as settled.
//
// THE MODEL DOES NOT GET THE LAST WORD ON A MANDATORY FIELD. A probe whose
// answer satisfies the email contract costs exactly one AI call, as before.
// One whose answer does not is REJECTED and asked again — with the specific
// gap named and its own reasoning handed back to distil from — up to
// MAX_PERSONALISATION_ATTEMPTS times. See THE CONTRACT GATE further down for
// why: the live failure was never bad reasoning, it was a model that wrote
// the commercial consequence perfectly inside primary_narrative and left
// commercial_consequence blank, throwing the whole email away. A repair pass
// re-asks the same question; it never re-diagnoses or adds a finding.
//
// ...and the rejection tells the model WHAT ACTUALLY HAPPENED to the field.
// commercial_consequence is sanitised before it is validated (the currency
// allow-list, the invented-loss guard, the internal-reasoning backstop), so a
// sentence the model DID write can be deleted by our own code — and reporting
// that as "you left it blank" makes the field unrepairable by construction:
// the model rewrites the same kind of sentence and loses it the same way on
// every attempt. That is the shape the live 0005/0006/0007 rows came back in
// (main_finding populated, consequence and email_body blank), and it is the
// one failure a tie-break between attempts can never reach. See
// classifyConsequenceLoss().
//
// AND THE ONE MANDATORY FIELD HAS ITS OWN LAST RESORT. When every full-story
// attempt is spent and commercial_consequence is the ONLY thing still
// outstanding, it is asked for on its own — one small structured call for that
// single sentence, grounded in the finding already selected — instead of a
// fourth twelve-field story that can lose it again. See THE DEDICATED
// CONSEQUENCE REPAIR further down.
//
// THE EMAIL STRUCTURE IS LOCKED AND THERE ARE EXACTLY TWO VARIANTS (the shapes
// themselves live in lib/email-assembly.mjs):
//   VARIANT 1 — NO RESPONSE, used ONLY when INTELLIGENCE.human_contact is
//     'none'. There was no conversation, so there is nothing fair to observe
//     about handling that never happened and no main finding to narrate — the
//     failure IS the silence. fair_observation and main_finding are forced
//     empty here rather than left to the model to invent, and what survives is
//     the commercial consequence of the silence, plus the wider beat when the
//     enquiry itself explicitly carried one (a seller / valuation opportunity
//     we actually declared). Nothing is invented to fill the gap, and the
//     email closes with its own two lines rather than the normal variant's
//     curiosity tease — there was no conversation to say "a couple of OTHER
//     things" about.
//   VARIANT 2 — EVERY OTHER CASE. fair_observation, main_finding and
//     commercial_consequence are ALL MANDATORY. There is no such thing as a
//     probe with human contact and no fair observation: even a weak
//     interaction has something factual to acknowledge — they replied, they
//     acknowledged the enquiry, they called, they asked a question, they
//     followed up, they used the name or the property correctly. If one of the
//     three is missing or is rejected by the guards below, the row is NOT
//     SENDABLE and email_body comes back blank, rather than an email going out
//     with a hole in it.
// The final two paragraphs — the curiosity transition and the CTA — are locked
// copy in the assembler, appear in BOTH variants every time, and are never
// asked of the model.
//
// REASON ABOUT THE STORY BEFORE FILLING THE VARIABLES. The model answers five
// questions first, in story_reasoning, each one naming the finding number
// behind it: which positive finding is the strongest; which problem or
// opportunity is the main story; because that happened what did they fail to
// establish, progress or capture; is there a genuinely separate wider FINDING
// (or none); and what did missing that mean. Filling the variables first is
// what produces finding -> finding -> blank consequence, which is the failure
// mode this layer exists to prevent.
//
// The output splits in two:
//   INTERNAL (breakdown / demo / our own reasoning) — primary_narrative,
//     narrative_finding_indexes, positive_finding_index, main_finding_index,
//     wider_finding_index, supporting_findings, evidence,
//     novus_counterfactual, hero_journey.
//   EMAIL COPY (what the prospect actually reads) — enquiry_date,
//     property_address, email_variant, fair_observation, main_finding,
//     commercial_consequence, wider_observation, wider_consequence,
//     additional_findings_hook, and the assembled email_body.
// Nothing internal is ever merged into the email, so our own reasoning
// language can never leak into it.
//
// Guards enforced in CODE, not merely prompted for:
//   - the selection: an index that names no finding, a positive picked as the
//     main story, a problem picked as the fair observation's positive, or a
//     wider finding that is the main story again (same index, or the same
//     event reworded) is refused and asked for again.
//   - evidence: no longer asked of the model at all. The stored evidence is
//     the evidence of the findings the story selected, so it is grounded by
//     construction — there are no raw messages in the prompt for a quote to
//     be fabricated from.
//   - currency: the ONLY currency figure allowed anywhere in the output is
//     this probe's own property value, taken from PROBES. Any sentence
//     carrying a different figure is stripped, whatever the model wrote —
//     no fee assumption, no commission estimate, no "this costs you £X a
//     year" is ever AI-invented. See stripUnbackedCurrency().
//   - invented loss: the property value is there to make the SCALE of the
//     opportunity obvious ("you had a £225,000 buyer enquiry in front of
//     you..."), and the agency draws its own conclusion. A sentence that takes
//     even the allowed figure and turns it into their loss — a fee, a
//     commission, a percentage, "this could have cost you" — is stripped too.
//     See stripInventedLoss().
//   - fair_observation: MANDATORY in variant 2 and forced empty in variant 1.
//     It cannot be written in detached third person, and cannot hedge the
//     praise with the words the brief names (eventually, although, despite,
//     however, finally, at least, albeit — see readsAsSnuckCriticism()). A
//     rejected one is never repaired IN CODE — rewriting a compliment is not
//     the assembler's job — it is sent back to the model with the reason, and
//     an answer that still fails after every attempt leaves the row
//     unsendable. Better a probe a human looks at than an email that opens
//     with a backhanded compliment.
//   - main_finding: MANDATORY in variant 2, forced empty in variant 1. It is
//     also the one field the code adds a WORD to: the assembler's "...was "
//     needs a complementiser in front of a clause, and a model writing a
//     fragment drops it often enough that "was it took over 63 hours" reached
//     live emails. withComplementiser() puts it back, and only where a "that"
//     is grammatical — never in front of a wh-clause or a noun phrase.
//   - commercial_consequence (and the optional wider_consequence) may not
//     speculate about what the person who enquired then did — losing
//     interest, going elsewhere, viewing something similar. The enquiry
//     evidences what the agency did and did not do, nothing more. See
//     readsAsSpeculation(): the primary consequence is sent back for repair,
//     the optional wider one is simply dropped.
//   - commercial_consequence: MANDATORY in both variants, never accepted
//     blank, and must go BEYOND main_finding. One that restates it is
//     rejected — see consequenceGoesBeyondFinding() and the central rule
//     below. A blank or restated consequence is not quietly stored as an
//     unsendable row: it is sent back to the model to distil from its own
//     reasoning, and only an answer that still fails after every attempt is
//     stored unsendable.
//   - supporting_findings: forced empty when every genuine finding is already
//     inside the primary narrative, so our internal note is never padded. It
//     does NOT gate the email's closing transition, which is locked copy that
//     appears every time.
//   - additional_findings_hook: never free text and never conditional — one
//     locked line, printed by the assembler in both variants.
//   - wider_consequence: exists only where wider_observation exists, and must
//     be a genuinely DISTINCT second consequence; an orphan one, or one that
//     merely restates the commercial consequence, is dropped rather than
//     printed. Optional — never forced.
//   - commercial_consequence never repeats the assembler's own "That meant".
//   - wider_consequence must be a genuinely DISTINCT second consequence; one
//     that merely restates the commercial consequence is dropped rather than
//     printed twice. Optional — never forced.
//   - no email field may contain our internal reasoning about the analysis
//     ("there is no strength to point to here", "the evidence does not
//     support...") — see readsAsInternalReasoning(). Those are notes to
//     ourselves; a prospect must never be shown one.
//   - the CTA is not asked of the model at all: it is locked copy in
//     lib/email-assembly.mjs.

import { callAi } from './ai-client.mjs';
import { ONE_HOUR_MS, SIXTEEN_HOUR_MS } from './grading.mjs';
import {
  formatFindingsForPrompt, isPositiveFinding, isStoryFinding, normaliseFindingType,
} from './diagnosis-findings.mjs';
import { assembleEmail, ADDITIONAL_FINDINGS_HOOK_LINE } from './email-assembly.mjs';

const HERO_JOURNEYS = [
  'complete_miss',
  'automated_ack_only',
  'slow_response_gap',
  'fast_response_stalled_follow_up',
  'weak_seller_qualification',
  'strong_handling_database_opportunity',
  'strong_handling_no_opportunity',
];

// The same "Fast" boundary lib/grading.mjs's A-H engine uses (Source Master
// §10: >1h and <=16h = Fast, >16h = Slow) — derived from its exported
// constant, never a second hardcoded threshold, so hero_journey can never
// disagree with the grade about whether a given response_hours counted as
// fast or slow.
const FAST_RESPONSE_HOURS_MAX = SIXTEEN_HOUR_MS / ONE_HOUR_MS;

// Deterministic — no AI. Mirrors the Demo doc's grade/problem-shape ->
// hero-journey table (NOVUS_Demo_System_Reference §7/§8). This is the audit /
// demo journey the prospect is routed to, so it stays a lookup rather than a
// fresh AI judgement every time the page renders.
//
// findings is the probe's DIAGNOSIS_FINDINGS list (see
// lib/diagnosis-findings.mjs) — passed explicitly rather than parsed out of
// the diagnosis row, because the findings now live in their own tab.
//
// Only STORY findings (problem/opportunity) count towards "does this probe
// have a real problem?". The list now also carries positives, and a probe
// handled perfectly can legitimately have two of them — reading those as
// findings would route a strong probe to slow_response_gap.
export function pickHeroJourney(intelligence, findings, diagnosis) {
  const humanContact = String(intelligence.human_contact || '').trim();
  if (humanContact === 'none') return 'complete_miss';
  if (humanContact === 'automated_only') return 'automated_ack_only';

  const storyFindings = (findings || []).filter(isStoryFinding);
  if (storyFindings.length === 0) {
    return diagnosis.novus_opportunity === 'Growth (valuation list / seller conversion)'
      ? 'strong_handling_database_opportunity'
      : 'strong_handling_no_opportunity';
  }

  const responseHours = parseFloat(intelligence.response_hours);
  const isFast = Number.isFinite(responseHours) && responseHours <= FAST_RESPONSE_HOURS_MAX;

  // >16h (or no parseable response_hours despite human contact) is a genuine
  // response-speed gap, full stop — matches grade E/F's own ">16h" band.
  if (!isFast) return 'slow_response_gap';

  // Fast to first contact (<=16h, grade B/D territory) but the evidence still
  // shows a real problem: distinguish a stalled/shallow seller thread from
  // fast-but-shallow handling in general, rather than mislabelling either as
  // a speed gap it never had.
  const sellerRecognition = String(intelligence.seller_recognition || '').trim();
  const viewingProgression = String(intelligence.viewing_progression || '').trim();
  const buyingMovedButSellingDidnt = sellerRecognition
    && sellerRecognition !== 'valuation_offered'
    && sellerRecognition !== 'valuation_booked'
    && viewingProgression !== 'none';

  if (buyingMovedButSellingDidnt) return 'weak_seller_qualification';
  return 'fast_response_stalled_follow_up';
}

function normalize(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// ── Currency discipline ──────────────────────────────────────────────────────
// The brief allows the property VALUE to be used where it genuinely sharpens
// the commercial point, and forbids invented fee assumptions. So this is no
// longer a blanket "no currency ever" rule: it is an allow-list of exactly
// one figure — the probe's own property_price — and everything else goes.

const CURRENCY_TOKEN_RE = /[£$€]\s?[\d][\d,.]*\s*(?:k|m|bn|million|thousand)?/gi;

// '£375,000' / '375000' / '£375k' -> a comparable digit string, or null.
export function normalizeCurrencyFigure(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const match = raw.match(/([\d][\d,.]*)\s*(k|m|bn|million|thousand)?/i);
  if (!match) return null;
  const digits = match[1].replace(/[,.]/g, '');
  if (!digits) return null;
  const suffix = (match[2] || '').toLowerCase();
  const multiplier = suffix === 'k' || suffix === 'thousand' ? 1000
    : suffix === 'm' || suffix === 'million' ? 1000000
      : suffix === 'bn' ? 1000000000
        : 1;
  const n = Number(digits) * multiplier;
  return Number.isFinite(n) && n > 0 ? String(n) : null;
}

// Drops any sentence containing a currency figure that isn't the allowed one.
// Sentence-level so a legitimate qualitative sentence in the same field
// survives — the same shape as the previous blanket guard, just with an
// allow-list. allowedFigure is the probe's property_price (or null when the
// probe has none on file, in which case NO currency figure may appear at all).
export function stripUnbackedCurrency(text, allowedFigure) {
  const allowed = normalizeCurrencyFigure(allowedFigure);
  const sentences = String(text || '').split(/(?<=[.!?])\s+/).filter(Boolean);
  const kept = sentences.filter((sentence) => {
    const tokens = sentence.match(CURRENCY_TOKEN_RE);
    if (!tokens) return true;
    return tokens.every((token) => allowed !== null && normalizeCurrencyFigure(token) === allowed);
  });
  return kept.join(' ').trim();
}

// THE PROPERTY VALUE IS ALLOWED TO SPEAK; WE NEVER DO THE ARITHMETIC FOR THEM.
// The value makes the scale of the opportunity obvious on its own — "you had a
// £225,000 buyer enquiry in front of you without establishing whether I was
// ready to move" — and the agency infers what that is worth to them. What we
// must never do is state or imply the money THEY lost: a fee, a commission, a
// percentage, an annual cost, "this could have cost you". Those figures are
// invented (we do not know their fee scale, and one enquiry does not prove a
// lost instruction), and they turn a fair observation into a sales pitch.
//
// stripUnbackedCurrency() already removes any figure that is not this probe's
// own property price. This is the other half: the sentence that takes the
// ALLOWED figure and turns it into their loss anyway.
const INVENTED_LOSS_PATTERNS = [
  /\bfees?\b/i,
  /\bcommission\b/i,
  /\brevenue\b/i,
  /\bcost(?:s|ing)? (?:you|the agency|your)\b/i,
  /\b(?:lost|losing|missed out on|forfeited) (?:you|the agency|your)?\s*[£$€]/i,
  /\bworth [£$€]/i,
  /\bper cent\b|\b\d+\s?%/i,
];

export function readsAsInventedLoss(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return INVENTED_LOSS_PATTERNS.some((re) => re.test(t));
}

// Sentence-level, exactly like stripUnbackedCurrency: a legitimate sentence
// beside the offending one survives.
export function stripInventedLoss(text) {
  const sentences = String(text || '').split(/(?<=[.!?])\s+/).filter(Boolean);
  return sentences.filter((sentence) => !readsAsInventedLoss(sentence)).join(' ').trim();
}

// AGENCIES row -> a single defensible, code-computed scale fact the AI may
// cite verbatim, or null when nothing usable is available. Deliberately not
// an estimate itself (no multiplication, no assumed conversion rate, no
// revenue figure) — just the raw count the wider-consequence sentence is
// allowed to reference when it generalises beyond this one enquiry.
function computeScaleFact(agency) {
  const liveListings = Number(agency?.live_listing_count);
  if (Number.isFinite(liveListings) && liveListings > 0) {
    return `${liveListings} live listing${liveListings === 1 ? '' : 's'} currently on the market`;
  }
  const branches = Number(agency?.branch_count);
  if (Number.isFinite(branches) && branches > 0) {
    return `${branches} branch${branches === 1 ? '' : 'es'}`;
  }
  return null;
}

// ── Probe facts the email itself is built from ───────────────────────────────

function isUnknownAddress(address) {
  const a = String(address || '').trim();
  return !a || /^unknown/i.test(a);
}

// PROBES.property_address is an analyst's field, and several live rows carry
// a trailing note in brackets meant for us, not for the prospect — e.g.
// "Fox Cottage (relationship to 'Church Road' UNCONFIRMED)",
// "Rayleigh Road (exact property not evidenced)", or
// "Whitmore Way, Basildon, SS14 (2 bed terraced, £285,000)", which would put
// a stray price into the email as well. The bracketed note is dropped for
// display; the stored field is untouched.
export function cleanAddressForEmail(address) {
  return String(address || '').trim().replace(/\s*\([^)]*\)\s*$/, '').trim();
}

// '2026-08-11T21:21:04Z' -> '11 August'. Europe/London so an evening probe
// keeps the date the agency would recognise, not the UTC one.
export function formatEnquiryDate(probeTimestamp) {
  const d = new Date(probeTimestamp);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: 'Europe/London' }).format(d);
}

// ── The single AI call ───────────────────────────────────────────────────────

const TOOL = {
  name: 'record_probe_personalisation',
  description: 'Record the commercial story for one probe: which of its diagnosed findings combine into the strongest narrative, the evidence behind it, and the sentence-ready copy the outreach email is assembled from.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'story_reasoning',
      'positive_finding_index', 'main_finding_index', 'wider_finding_index',
      'primary_narrative', 'supporting_findings',
      'fair_observation', 'main_finding', 'commercial_consequence',
      'wider_observation', 'wider_consequence',
      'novus_counterfactual',
    ],
    properties: {
      // FIRST, deliberately: the story is reasoned through BEFORE any email
      // variable is written. A model that fills the variables first writes
      // finding -> finding -> blank consequence; one that answers these five
      // questions first has already worked out what the consequence IS.
      story_reasoning: {
        type: 'string',
        description: 'INTERNAL, written FIRST, before any other field. Answer these five questions in order, in one short numbered list, CITING THE FINDING NUMBER behind each answer: (1) Which POSITIVE finding is the strongest genuine thing to acknowledge? Give its number, or say "none" if there is no positive finding. (2) Which single PROBLEM or OPPORTUNITY finding is the strongest main story? Give its number. (3) BECAUSE that finding happened, what did the agency fail to establish, progress, capture, qualify, convert or uncover? This is the "so what?" and it must move the story forward, not restate (2). (4) Is there a genuinely SEPARATE wider finding — a DIFFERENT underlying event from (2), most often a seller/valuation opportunity — or is there not? Give its number, or say "none". If (2) is already the seller opportunity, the answer here is "none". (5) If there is one, what did missing it mean commercially? Only after answering these do you write the selection fields and the email fields.',
      },
      // ── THE SELECTION. Three indexes into the FINDINGS list, chosen before
      // any sentence is written. The email's three beats each come from ONE
      // finding, and the code validates every one of them: an index that does
      // not exist, a positive picked for the main story, or a wider finding
      // that is really the main story again, is refused and asked for again.
      // This is what stops the same underlying event being told twice.
      positive_finding_index: {
        type: ['integer', 'null'],
        description: 'The finding number of the STRONGEST GENUINE POSITIVE — the one the fair observation is written from. It MUST be a finding typed [POSITIVE] in the list. Use null ONLY when the list contains no positive finding at all, or when there was no human contact. Never pick a problem or an opportunity here.',
      },
      main_finding_index: {
        type: ['integer', 'null'],
        description: 'The finding number of the ONE strongest [PROBLEM] or [OPPORTUNITY] that is the main story. It MUST be typed [PROBLEM] or [OPPORTUNITY] — never a positive. Required in BOTH email variants: in the no-response variant the main_finding paragraph is not printed, but the commercial consequence still rests on this finding. Use null only when the list contains no problem or opportunity at all (handling that genuinely worked).',
      },
      wider_finding_index: {
        type: ['integer', 'null'],
        description: 'The finding number of the wider beat, or null. Pick one ONLY if it is a GENUINELY DIFFERENT underlying event from main_finding_index — a separate thing that happened, not the same thing described from another angle. If the main story IS the seller/valuation opportunity, this MUST be null: repeating it as the wider beat tells the agency the same story twice, one paragraph apart. If there is no genuinely distinct second finding, return null. Never return the same number as main_finding_index.',
      },
      primary_narrative: {
        type: 'string',
        description: 'INTERNAL ONLY — our own working note, for the breakdown and the demo. IT IS NOT AN EMAIL FIELD AND IT IS NOT A SUBSTITUTE FOR THE STRUCTURED FIELDS. No prospect ever reads it, so a point that exists only here is a point the email does not make: whatever you write here, the finding and its consequence must ALSO be written into main_finding and commercial_consequence, in their own words. The single strongest commercially consequential story this enquiry tells, in two to four sentences. Most enquiries contain more than one useful finding, so COMBINING several findings into one broader story is the normal answer, not the exception — do not simply narrate finding #1. Do not describe the problems: say what the agency failed to find out, progress, convert or uncover because of them. If there are no findings at all, this is the story of handling that genuinely worked and what it would take to guarantee it every time.',
      },
      supporting_findings: {
        type: 'string',
        description: 'INTERNAL. The genuine problem/opportunity findings you did NOT select as the main or wider story, stated plainly in one or two sentences. Empty string when your selection already covers every one of them, or when there are none. Never pad this.',
      },
      fair_observation: {
        type: 'string',
        description: 'EMAIL COPY, read by the prospect. WRITTEN FROM THE FINDING AT positive_finding_index (or, where the list carries no positive finding, from the plainest factual thing the findings themselves establish about the contact). MANDATORY whenever there was any human response or contact at all — there is no case where this is optional, and an email without it is not sent. CONTINUATION ONLY: the email hard-codes "I want to say upfront that " immediately before this text, so write only what follows it, starting lower-case. Examples of the exact register: "you did get back to me, with an email asking what I was looking for."; "you did get back to me within the same day and acknowledged the enquiry."; "you did follow up with me and tried to get me on the phone." Even a weak interaction has something factual that can be acknowledged: they replied, they acknowledged the enquiry, they called, they asked a question, they followed up, they referenced my name or the property correctly. Pick the strongest one the communications actually evidence, and STOP THERE — one or two sentences. This paragraph establishes fairness; it is not half the email. It must be GENUINELY SUPPORTED by a finding you were given — never invent praise. It must be entirely positive: never slip criticism in with eventually, although, despite, however, finally, at least or any similar word that turns the compliment into a complaint, and never hint at what comes next. Write it TO them ("you") and describe our side as "I"/"me"/"we"; never detached third person such as "They did not let this one go cold."',
      },
      main_finding: {
        type: 'string',
        description: 'EMAIL COPY, read by the prospect. WRITTEN FROM THE FINDING AT main_finding_index, and from no other. The PRIMARY thing the agency failed to do. CONTINUATION ONLY: the email hard-codes "What stood out, though, was " immediately before this text, so write only what follows it, starting lower-case, and START IT WITH "that" whenever what follows is a clause, so the sentence reads correctly after the opener ("was that it took over 63 hours for anything to come back", not "was it took over 63 hours") — e.g. "that the conversation never really established my position or timescale", or "that I had told you I was considering selling my own property, but the conversation stayed entirely around the purchase." It must be ONE COHERENT FINDING even where it combines several related findings into one thing that happened. It must NOT contain its commercial consequence and must NOT explain what the failure cost — that is the next paragraph\'s job, and saying it here leaves that paragraph with nothing to add. Specific, grounded in what actually happened in this enquiry, understandable without seeing any underlying analysis, written from the perspective of the person who sent it, and about BEHAVIOUR rather than an abstract business judgement. "Your qualification process was weak" is wrong. NEVER a label like "Poor follow-up", "Weak qualification" or "Response gap". Address them as "you" and our side as "I"/"me"/"we".',
      },
      commercial_consequence: {
        type: 'string',
        description: 'EMAIL COPY, read by the prospect. MANDATORY for every sendable email in both variants, and NEVER LEFT BLANK — an answer without it is rejected and sent back to you, not stored. THE MOST IMPORTANT FIELD IN THE EMAIL. If you have written the consequence into primary_narrative or story_reasoning, you have not written it into the email: distil it into THIS field, in a sentence the agency can read. The email hard-codes "That meant " immediately before this text, so return ONLY the grammatically correct continuation, starting lower-case. It must answer the actual "so what?": what opportunity the agency failed to CAPTURE, PROGRESS, QUALIFY, CONVERT or UNCOVER because of the main finding. It must MOVE THE STORY FORWARD rather than repeat the finding, and it must NOT restate main_finding in different words. If the main finding is that the enquiry was never qualified, this says what that meant commercially — that nobody established whether I was a serious buyer, whether I was ready to move, whether I was finance-ready, or what the next step was, depending on what the evidence actually supports. Where a confirmed property price is given, consider using it to make the scale obvious — "you had a £225,000 buyer enquiry in front of you without establishing whether I was ready to move, what I needed from the property, or what should happen next" — but never in every email, never more than once, and never turned into what it cost them. Weak: "the response was generic." Strong: "you had a live buyer enquiry in front of you, but the conversation never really established where I was in the process — or what else the enquiry could lead to." Never invent lost revenue, never state a fee, a commission or a percentage, never claim a sale or an instruction was definitely lost, and never write vague filler like "there was a missed opportunity". NEVER SPECULATE ABOUT WHAT I WOULD HAVE DONE NEXT: not that I lost interest, cooled off, moved on, gave up, went elsewhere, went to another agent, or viewed or bought something similar somewhere else. None of that is established by the enquiry, and an answer containing it is rejected and sent back to you. Stay on what the enquiry itself proves was left undone — it stayed unqualified, the viewing was never booked or progressed, the seller opportunity was never explored, nothing established what should happen next. One or two sentences — say what it meant and stop.',
      },
      wider_observation: {
        type: 'string',
        description: 'EMAIL COPY, read by the prospect. OPTIONAL, and WRITTEN FROM THE FINDING AT wider_finding_index — empty whenever that is null. A genuinely SEPARATE observation, most commonly a seller-side opportunity or a separate progression opportunity, never the main finding again in other words. A COMPLETE STANDALONE SENTENCE (capital letter, full stop), because no fixed wording runs in front of it, and ONE sentence only: "I\'d also said in the enquiry that I had a property of my own to sell that wasn\'t yet on the market." Return an EMPTY STRING unless there genuinely was such a thing; never invent one to fill the field.',
      },
      wider_consequence: {
        type: 'string',
        description: 'EMAIL COPY, read by the prospect. OPTIONAL, and ONLY where wider_observation exists — with no observation in front of it, this is the consequence of something the reader was never told, and it is discarded. The email hard-codes "That also meant " immediately before this text, so return ONLY the continuation, starting lower-case, e.g. "a potential seller instruction sitting inside the same enquiry was never explored." — one sentence, never a claim that it would definitely have become an instruction, and never speculation about what I would have done next (losing interest, going elsewhere, viewing something similar). It is dropped from the email if it speculates. It must explain the COMMERCIAL CONSEQUENCE of the wider observation and must NOT repeat the observation, and it must be genuinely distinct from commercial_consequence rather than the same point reworded. If the wider observation has no genuine separate consequence, leave this empty; never force one.',
      },
      novus_counterfactual: {
        type: 'string',
        description: 'INTERNAL. What NOVUS would have done differently at THIS specific moment — anchored to the actual delay, the actual questions asked or not asked, the actual channel. If the handling was strong, say plainly that NOVUS would have matched it and name what it adds on top. A sentence that would read identically for any other agency is wrong.',
      },
    },
  },
};

const SYSTEM_PROMPT = `You are writing the Personalisation layer for one NOVUS probe: an estate agency was sent a genuine property enquiry, everything that happened next was recorded, and a commercial Diagnosis has already been completed.

Diagnosis has already listed every genuine, evidence-backed finding and why each one matters. Your job is NOT to re-analyse, re-grade, or add findings. Your job is to decide WHAT THE STORY IS, and to write it as copy that drops straight into a FIXED email with no editing.

WHAT THE EMAIL IS FOR
It should read like: "We actually looked at what happened. We're being fair about what you did well. Here's what stood out. Here's why it mattered. There's more in the breakdown. Want to see it?"
It is NOT there to lecture them, tell them how to run their agency, make sweeping claims about lost revenue, dump every finding, sound like an AI-generated audit, or sell NOVUS. It must never feel like a LIST OF PROBLEMS.

YOUR ONLY SOURCE IS THE FINDINGS LIST. You are given the probe's own facts (the property, its value, the date we enquired, what our enquiry said) and the complete list of findings Diagnosis produced, each one typed [POSITIVE], [PROBLEM] or [OPPORTUNITY], each with its own evidence and its own note on why it matters. That is everything. There is no transcript to read, no diagnosis prose to summarise, and nothing else to reason from. If something is not in the findings or the probe facts, IT DID NOT HAPPEN as far as this email is concerned — never infer it, never assume it, never invent it.

REASON ABOUT THE STORY BEFORE YOU FILL ANY VARIABLE. This is the most important rule here. In story_reasoning, first answer, in order, naming the finding number behind each answer:
  1. Which [POSITIVE] finding is the strongest genuine thing to acknowledge? (number, or "none")
  2. Which single [PROBLEM] or [OPPORTUNITY] finding is the strongest main story? (number)
  3. Because that finding happened, what did the agency fail to establish, progress, capture, qualify, convert or uncover?
  4. Is there a genuinely SEPARATE wider finding — a DIFFERENT underlying event from (2)? (number, or "none")
  5. If so, what did missing that mean commercially?
Only then write the selection fields and the email fields. A model that writes the fields first produces finding -> finding -> a blank or empty consequence, which is exactly what this layer exists to prevent.

THE SELECTION RULES, which the code checks and will send back to you:
  1. positive_finding_index must be a finding typed [POSITIVE]. Null only when the list has no positive at all, or there was no human contact.
  2. main_finding_index must be a finding typed [PROBLEM] or [OPPORTUNITY]. Never a positive.
  3. wider_finding_index is null unless a second finding is a GENUINELY DIFFERENT underlying event. Different wording about the same event is NOT a different finding.
  4. NEVER USE THE SAME UNDERLYING EVENT TWICE. If the seller/valuation opportunity is your main story, wider_finding_index is null and wider_observation is empty — do not tell the agency the same thing again one paragraph later.
  5. If there is no distinct wider finding, that is a complete and correct answer: null, and an empty wider beat. Never reach for one to fill the space.
  6. Never invent a finding, an event or a piece of evidence that is not in the list you were given.

PRIMARY_NARRATIVE AND STORY_REASONING ARE INTERNAL — working notes no agency ever reads. The ONLY sentences the agency reads are fair_observation, main_finding, commercial_consequence, wider_observation and wider_consequence, so a consequence you explain beautifully in primary_narrative while leaving commercial_consequence blank is a consequence the agency never sees. That answer is rejected and handed back to you; it is not stored. Once you have reasoned the story out, map it across one to one — main_finding = what happened; commercial_consequence = what that meant commercially; wider_observation = the separate second finding, if there is one; wider_consequence = what that one meant. Writing a point once in the narrative does not count.

Never allow: finding -> finding -> blank consequence.
Never allow: a consequence that merely repeats the finding in other words.
Never allow: a fair observation that is disguised criticism.
Never allow: a seller observation repeated back as its own consequence.
Never allow: the same underlying finding used as both the main story and the wider beat.

THE EMAIL STRUCTURE IS LOCKED AND YOU DO NOT WRITE IT. The assembler owns every fixed word, the paragraph order, the closing transition and the call to action. You write ONLY the content of the variables below. There are exactly two variants.

VARIANT 1 — NO RESPONSE (used only when there was no human contact at all):
  We never received a reply.
  That meant {commercial_consequence}
  {wider_observation}                (only if applicable)
  That also meant {wider_consequence} (only if wider_observation exists)
  ...then the locked closing lines.
There was no conversation, so fair_observation and main_finding are IGNORED and positive_finding_index is null — do not invent replies. The failure IS the silence: put your effort into commercial_consequence.

VARIANT 2 — EVERY OTHER CASE (any human response or contact at all):
  I want to say upfront that {fair_observation}
  What stood out, though, was {main_finding}
  That meant {commercial_consequence}
  {wider_observation}                (only if there is a genuinely separate one)
  That also meant {wider_consequence} (only if wider_observation exists and has a genuine consequence)
  ...then the locked closing lines.
fair_observation, main_finding and commercial_consequence are ALL MANDATORY here, and an email missing any of the three is not sent at all. The fair observation is never optional: write it from the [POSITIVE] finding you selected, and where the list carries no positive, from the plainest factual thing the findings establish about the contact. Do NOT invent praise.

THE VARIABLE CONTRACT
- fair_observation: a genuine acknowledgement, never hedged with eventually, although, despite, however, finally, at least or anything similar that turns a compliment into a complaint.
- main_finding: the primary thing the agency failed to do, as ONE coherent finding. It must NOT contain its commercial consequence — that is the very next paragraph, and taking its job here leaves it with nothing to say.
- commercial_consequence: the actual "so what?" — what opportunity the agency failed to capture, progress, qualify, convert or uncover because of the main finding. It must MOVE THE STORY FORWARD, never restate the finding in other words. Never invent lost revenue and never claim an instruction or a sale was definitely lost.
- wider_observation / wider_consequence: the optional pair, written from wider_finding_index. The consequence is of THAT observation, never the observation again.
- You never write the closing transition or the call to action. Both are locked copy in the email itself and appear every time. Do not hint at them, and do not treat "a couple of other things" as a promise you must fill.

Hard rules:
1. MOST ENQUIRIES CONTAIN MORE THAN ONE USEFUL FINDING, and the email tells ONE story about them. Where several findings really are one thing that happened, weave them into main_finding so it reads as one thing — never as a list. The findings you did not select are covered by the breakdown, not by this email.
2. Never state a finding, a fact, or an outcome the probe cannot establish. This enquiry is one observed interaction. It shows what happened to THIS enquiry. It does not prove what happens to every enquiry, and it does not prove a lost sale. Say what it shows, and stop.
3. Be fair, and mean it. Never invent praise no [POSITIVE] finding supports, and equally never manufacture a weakness: if the findings list is empty, the story is that the handling worked and the question is whether it happens every time.
4. GROUND EVERY SENTENCE IN A FINDING'S OWN EVIDENCE. The evidence line under each finding is the fact that finding rests on — the hours, the count of attempts, the questions asked or not asked, the words that were actually used. Write from it, and never state a fact no finding's evidence supports. You are not given the raw messages, so a quote you cannot see is a quote you must not write.
4b. NEVER SPECULATE ABOUT WHAT THE PERSON WHO ENQUIRED WOULD HAVE DONE NEXT. "leaving it open for me to lose interest or go and view something similar elsewhere" is invented: the enquiry records what the agency did and did not do, and establishes nothing about my state of mind, my patience, or where I went afterwards. Never write that I lost interest, cooled off, moved on, gave up, went elsewhere, went to another agent, or viewed or bought something similar. A consequence containing any of that is rejected and handed back to you. The grounded version is at least as hard: the enquiry stayed unqualified, the viewing was never booked or progressed, the seller opportunity was never explored, nothing established what should happen next.
5. MONEY: LET THE PROPERTY VALUE SPEAK, AND NEVER DO THE ARITHMETIC FOR THEM. Where a confirmed property price is given, consider using it to make the scale of the opportunity obvious — most often inside commercial_consequence: "you had a £225,000 buyer enquiry in front of you without establishing whether I was ready to move", or "a potential £650,000 seller instruction sitting inside the same enquiry was never explored". The agency works out what that is worth to them; you never tell them. So NEVER state or imply what this cost THEM: no fee, no commission, no percentage, no annual cost, no "this could have cost you £X", no "you may have lost £X". Never state any monetary figure other than the property price you are given, and if you are handed a scale fact, cite it exactly as written and draw no arithmetic from it. Do not force the price into every email — use it only where it materially strengthens the point, and never more than once.
6. THE SELLER SIDE. Actively consider it. If our enquiry said we also had a property of our own we were thinking of selling, then this enquiry was not just a potential buyer — there was a potential valuation and instruction sitting inside it — and that is very often the sharpest part of the commercial story. Keep it to two short sentences, in the wider beat, in this shape: "I'd also said in the enquiry that I had a property of my own to sell that wasn't yet on the market." then "a potential seller instruction sitting inside the same enquiry was never explored." Never claim it would definitely have become an instruction. And only ever when the enquiry actually said so — never force seller language into an enquiry that did not contain it. AND SAY IT ONCE: if the seller opportunity is your MAIN finding, it does NOT also become the wider beat. That is the same story printed twice, and it is the single most obvious way this email stops sounding like a person and starts sounding like a template.

EVERY SENTENCE NEEDS A JOB. The email is short, and each paragraph does one thing. Say it once, in the field that owns it, and stop:
  - No filler, no throat-clearing, no explaining the same point twice in two fields.
  - The fair observation establishes fairness. It is not there to spend half the email praising them — one specific, genuine thing, and move on.
  - The main finding is what happened. The consequence is what it meant. Never both in one field, and never the same point in both.
  - No sales language, no consultant language, no exaggerated criticism, no invented money.
  - Never soften a compliment into a complaint: eventually, although, despite, however, finally, at least, albeit are all banned from the fair observation. If you cannot say something positive without one of them, you have picked the wrong positive — pick a smaller, factual one instead.

THE GRAMMAR CONTRACT is absolute, because the email supplies the fixed opening words of each paragraph and you supply the rest:

  "I want to say upfront that " + fair_observation
  "What stood out, though, was " + main_finding
  "That meant "                  + commercial_consequence
  {wider_observation}            (its own sentence, nothing in front of it)
  "That also meant "             + wider_consequence

  - Those four prefixed fields are CONTINUATIONS. Start each one LOWER-CASE and write nothing that repeats the prefix, so prefix + your text reads as one correct sentence.
  - wider_observation is the one that is a whole sentence on its own: capital letter, full stop.
  - Never return a label or a heading like "Poor follow-up", "Weak qualification" or "Response gap" — those are internal diagnosis concepts, not email copy.
  - VOICE. You are the person who actually sent that enquiry, writing to the agency. They are "you". Our side is "I", "me", "we". Never write about them in detached third person — "They didn't let this one go cold" is wrong; "You didn't let this one go cold" is the same observation written by a human to a human.
  - Conversational, commercially sharp, fair. No consultant language, no AI or technical terminology, no generic sales language, no exaggerated claims, no pressure, no jargon, no grading. Do not attack the team. Do not pretend to know anything about the agency beyond this one enquiry.
  - Write ONLY the content of each field. Never write a greeting, a sign-off, a call to action, a link, a transition into the next paragraph, or the offer of the breakdown.
  - NEVER expose your own reasoning about the analysis. Sentences like "there is no strength to point to here", "the evidence does not support a fair observation", "no findings were recorded" are notes to ourselves. story_reasoning is where your reasoning goes, and it is never shown to anyone.
  - Never refer to the probe, the diagnosis, the findings, the evidence, the analysis, or this system. From the reader's side this is simply one enquiry their team received, and a person who noticed what happened to it.
  - Read every field aloud in your head. If it sounds like a report, rewrite it until it sounds like a person talking.
  - Never turn one enquiry into a claim about the agency as a whole. "This enquiry sat overnight" is honest. "Your enquiries are sitting overnight" is not — you observed one.`;

// THE PERSONALISATION INPUT, AND NOTHING ELSE.
//
// This prompt used to carry the whole upstream stack: the INTELLIGENCE row's
// interpretation prose, the DIAGNOSIS row's strengths / missed_opportunities /
// commercial_implication / diagnosis_summary, and every raw COMMUNICATIONS
// message in full. All three are now gone from it.
//
// They were REDUNDANT, not useful: DIAGNOSIS_FINDINGS already carries every
// genuine, evidence-backed thing that happened — including, since this change,
// the positives — so the prose layers restated in paragraphs what the findings
// state as structured facts, and the raw messages restated in full what each
// finding's own evidence line already quotes. Feeding all three back in gave
// the model three differently-worded versions of the same probe and invited it
// to re-diagnose from the transcript instead of selecting from the findings —
// which is exactly how the same underlying event ended up told twice in one
// email.
//
// What is left is the minimum a correct email actually needs:
//   - the probe facts the email itself prints or reasons about (the property,
//     its value — the only currency figure that may ever appear — the date we
//     enquired, and what our enquiry said, which is what makes a seller beat
//     legitimate at all);
//   - the email variant, computed in CODE from INTELLIGENCE.human_contact, so
//     the model knows which of the two locked structures it is writing for
//     without being handed the interpretation layer to infer it from;
//   - the complete findings list, typed and numbered;
//   - the one code-computed scale fact, when the agency has one.
// Nothing here is prose to be summarised, and nothing here is a second
// description of something already stated.
function buildPrompt(probe, findings, emailVariant, scaleFact) {
  const price = String(probe?.property_price || '').trim();

  return [
    '=== THE ENQUIRY (probe facts — these are the facts the email opens with) ===',
    `Property address: ${isUnknownAddress(probe?.property_address) ? 'not established from the replies' : probe.property_address}`,
    `Property value: ${price || 'not on file — you may not state ANY monetary figure at all'}`,
    `Enquiry sent: ${probe?.probe_timestamp || 'unknown'} (${formatEnquiryDate(probe?.probe_timestamp) || 'date unknown'})`,
    `What the enquiry said: ${probe?.enquiry_text || '(none)'}`,
    '',
    emailVariant === 'no_response'
      ? '=== EMAIL VARIANT: NO RESPONSE ===\nNobody ever made human contact with this enquiry. You are writing VARIANT 1: there is no conversation to be fair about and no conversation to narrate, so fair_observation and main_finding are ignored and positive_finding_index is null. Still select main_finding_index: the silence itself is a finding, and the commercial consequence is mandatory here and must rest on it.'
      : '=== EMAIL VARIANT: NORMAL ===\nA human made contact, so you are writing VARIANT 2: fair_observation, main_finding and commercial_consequence are all mandatory.',
    '',
    '=== FINDINGS (the complete, settled set — your ONLY source for what happened; select by number) ===',
    formatFindingsForPrompt(findings),
    '',
    scaleFact
      ? `=== SCALE FACT (the only number about this agency you may cite; draw no arithmetic from it) ===\n${scaleFact}`
      : '=== SCALE FACT ===\n(none available — any wider point must stay qualitative, with no numbers)',
  ].join('\n');
}

// ── The email copy ───────────────────────────────────────────────────────────
//
// The SHAPE of the email lives in lib/email-assembly.mjs (see its header for
// both structures and the locked CTA). Nothing here builds a body, a greeting,
// a transition or a sign-off — this section only sanitises the individual
// sentences the assembler then puts in order.

// The assembler hard-codes "That meant " immediately before
// commercial_consequence, so the field must be the CONTINUATION, not a whole
// sentence that repeats the prefix. A model that writes "That meant the
// enquiry went cold." would otherwise render as "That meant That meant the
// enquiry went cold." Strips the prefix and restores lower-case, so the
// sentence still reads correctly after the assembler's own words. Accepts
// either tense, since a model told "That meant " will still sometimes write
// "That means".
// The assembler owns the opening words of four paragraphs, so those four
// fields must come back as LOWER-CASE CONTINUATIONS that read correctly after
// them. A model told "the email already says That meant" will still sometimes
// write the prefix itself — which would render as "That meant That meant the
// enquiry went cold." — so each prefix is stripped here if present (in either
// tense, and in the near-miss phrasings a model actually produces), and the
// first letter is restored to lower case.
const FIXED_PREFIX_PATTERNS = {
  fairObservation: /^i(?:'d| would| just)?\s*(?:want|wanted)\s+to\s+say\s+upfront\s+that\b[\s,:-]*/i,
  mainFinding: /^what\s+stood\s+out\s*,?\s*(?:though)?\s*,?\s*(?:was|is)\b[\s,:-]*/i,
  commercialConsequence: /^that\s+mean(?:s|t)\b[\s,:-]*/i,
  widerConsequence: /^(?:that|it|this)\s+also\s+mean(?:s|t)\b[\s,:-]*/i,
};

// Words this probe is allowed to open a continuation with UNCHANGED — never
// forced to lower case. Built from the probe's own property address and the
// agency's name (extractProtectedWords, below), because those are the two
// sources of a genuine proper noun a continuation can legitimately start
// with: "Fox Cottage was mentioned in the same call" must not become "fox
// Cottage was mentioned...". Matched on the word's letters only, case
// -insensitively, so "Fox" protects "Fox" however the model capitalised it.
export function extractProtectedWords(probe, agency) {
  const words = new Set();
  const address = cleanAddressForEmail(probe?.property_address);
  const agencyName = String(agency?.agency_name || '').trim();
  for (const source of [address, agencyName]) {
    if (!source) continue;
    for (const word of source.split(/\s+/)) {
      const letters = word.replace(/[^A-Za-z]/g, '');
      // Only words that were THEMSELVES capitalised in the source count as
      // proper-noun evidence — "the Old Barn" protects "Old"/"Barn", not
      // "the". A single letter is too weak to trust (an initial, not a name).
      if (letters.length >= 2 && /^[A-Z]/.test(letters)) words.add(letters.toLowerCase());
    }
  }
  return words;
}

// Keep an acronym capitalised, never lower-case the pronoun "I", and never
// lower-case a word this probe's own address/agency established as a proper
// noun; only de-capitalise an ordinary opening word that was capitalised
// purely by sentence position.
//
// The length check on the acronym test matters: a bare "A" is all-capitals by
// every naive test, so a continuation opening "A potential seller
// instruction..." used to survive capitalised and print as "That also meant
// A potential seller instruction...". An acronym worth protecting (NOVUS,
// EPC, RICS) has at least two letters; a one-letter capital is the article,
// not an acronym.
function lowerFirstWord(t, protectedWords) {
  const firstWord = t.split(/\s+/)[0];
  if (/^I(?:['’]|$)/.test(firstWord)) return t;             // I, I'd, I've, I'm
  const letters = firstWord.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 2 && letters === letters.toUpperCase()) return t;
  if (protectedWords && protectedWords.has(letters.toLowerCase())) return t;
  return `${t.charAt(0).toLowerCase()}${t.slice(1)}`;
}

// One fixed-prefix field -> the continuation the assembler can print after
// the prefix: prefix removed if the model wrote it, lower-cased, terminated.
// protectedWords (optional): words from THIS probe's own address/agency that
// must survive capitalised — see extractProtectedWords().
export function asContinuation(text, prefixPattern, protectedWords) {
  let t = String(text || '').trim();
  if (!t) return '';
  if (prefixPattern) t = t.replace(prefixPattern, '').trim();
  if (!t) return '';
  return ensureSentenceEnd(lowerFirstWord(t, protectedWords));
}

// ── "What stood out, though, was ___" ────────────────────────────────────────
//
// The assembler prints that prefix and the model supplies the rest, and a
// clause dropped straight after "was" reads as a dropped word:
//   "What stood out, though, was it took over 63 hours..."
//   "What stood out, though, was I'd also told you..."
//   "What stood out, though, was across all three emails, nobody asked..."
// Each of those needs the complementiser: "was THAT it took over 63 hours".
//
// Prompting alone will not hold this — the field is written as a fragment, and
// a model told to start lower-case drops "that" perhaps one time in three — so
// it is repaired here, deterministically, once the continuation is shaped.
//
// IT IS NOT A BLANKET "PREPEND THAT". "was" also takes a predicate that must
// NOT have one, and inserting it there would break copy that is currently
// correct:
//   nominal   — "was the speed of the reply, and nothing else."   (no "that")
//   wh-clause — "was how quickly the viewing was offered."        (no "that")
// So the insertion is driven by an ALLOW-LIST of openings that can only begin
// a finite clause: a subject pronoun ("it", "I", "you", "they", "nobody",
// "there"), or an adverbial/prepositional phrase that must be followed by one
// ("across all three emails, ...", "at no point ...", "after two days ...").
// Anything else — a determiner, a wh-word, a gerund, an adjective — is left
// exactly as the model wrote it, because there the right answer depends on
// words this cannot see, and a wrong "that" is worse than a missing one.

// Openings that are a clause SUBJECT: "it took...", "I'd also told you...",
// "nobody asked...". Possessives are deliberately absent ("your team never
// asked" is a clause, but "your fastest reply" is a noun phrase, and only the
// rest of the sentence tells them apart).
const CLAUSE_SUBJECT_OPENERS = [
  'i', 'we', 'you', 'they', 'he', 'she', 'it', 'there',
  'nobody', 'nothing', 'none', 'neither', 'everyone', 'everything',
  'someone', 'something', 'anyone', 'anything', 'no-one',
];

// Openings that are an ADVERBIAL running in front of the clause, so the clause
// itself — and the "that" it needs — comes after them.
const CLAUSE_ADVERBIAL_OPENERS = [
  'across', 'after', 'against', 'along', 'amid', 'among', 'at', 'before',
  'behind', 'below', 'beneath', 'beside', 'besides', 'between', 'beyond', 'by',
  'despite', 'during', 'following', 'from', 'in', 'inside', 'into', 'on',
  'once', 'over', 'past', 'since', 'then', 'throughout', 'under', 'until',
  'upon', 'via', 'while', 'with', 'within', 'without',
];

// A continuation already carrying its own complementiser, or one that cannot
// take one at all. "that ..." is the common case (never "that that"); the
// wh-words and "whether"/"how" head a nominal clause that "was" takes
// directly; "no one" is the two-word spelling handled alongside the list.
const COMPLEMENTISER_ALREADY_PRESENT = /^(?:that|how|what|whatever|when|whenever|where|wherever|which|whichever|who|whoever|whom|whose|why|whether|if)\b/i;

// The finite verbs (and the adverbs that sit in front of one) that prove a
// PROPER-NOUN opening is a clause rather than a noun phrase: "Barn Field WAS
// mentioned twice..." is a clause and needs "that"; "Barn Field, mentioned
// twice and never offered" is a noun phrase and must not have one.
const FINITE_VERB_MARKERS = new Set([
  'was', 'were', 'is', 'are', 'had', 'has', 'did', 'does', 'went', 'came',
  'took', 'sat', 'stayed', 'stopped', 'arrived', 'got', 'never', 'only',
  'still', 'then',
]);

// One shaped continuation -> the same continuation, with "that " in front of
// it when the fixed prefix "…was " needs one and it is missing. Pure and
// idempotent: running it twice never produces "that that".
//
// protectedWords (optional): this probe's own proper nouns, from
// extractProtectedWords(). A continuation opening with the property's own name
// only counts as a clause when a finite verb follows the name — see
// FINITE_VERB_MARKERS above.
export function withComplementiser(continuation, protectedWords) {
  const t = String(continuation || '').trim();
  if (!t) return '';
  if (COMPLEMENTISER_ALREADY_PRESENT.test(t)) return t;
  if (/^no\s+one\b/i.test(t)) return `that ${t}`;

  const words = t.split(/\s+/).map((w) => w.replace(/[^A-Za-z'’-]/g, '').toLowerCase());
  // "I'd", "I've", "it's", "they're" — the apostrophe form of the same subject.
  const first = (words[0] || '').split(/['’]/)[0];
  if (!first) return t;
  if (CLAUSE_SUBJECT_OPENERS.includes(first)) return `that ${t}`;
  if (CLAUSE_ADVERBIAL_OPENERS.includes(first)) return `that ${t}`;

  // A proper noun this probe established — "Barn Field was mentioned twice..."
  // Skip the whole name, then require a finite verb immediately after it, so a
  // noun phrase built on the same name is left alone.
  if (protectedWords && protectedWords.has(first)) {
    let i = 0;
    while (i < words.length && words[i] && protectedWords.has(words[i])) i += 1;
    // Only when the NAME itself runs uninterrupted into the verb: a comma
    // after the name ends the run and makes it a noun phrase, not a clause.
    const nameRun = t.split(/\s+/).slice(0, i).join(' ');
    if (!/[,;:—-]$/.test(nameRun) && FINITE_VERB_MARKERS.has(words[i] || '')) return `that ${t}`;
  }
  return t;
}

export function stripThatMeantPrefix(text, protectedWords) {
  return asContinuation(text, FIXED_PREFIX_PATTERNS.commercialConsequence, protectedWords);
}

// wider_consequence is a STANDALONE paragraph, not a continuation, so it
// reads as its own sentence: capital letter, full stop.
function asStandaloneSentence(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  return ensureSentenceEnd(`${t.charAt(0).toUpperCase()}${t.slice(1)}`);
}

// wider_consequence exists only when there is a genuinely DISTINCT second
// commercial consequence. Asked for an optional field, a model will often
// fill it with the same point reworded — which in the email prints the same
// consequence twice, one paragraph apart, and reads as padding. So a value
// that is really the primary consequence again is dropped rather than
// printed: same text, or either one wholly contained in the other.
export function distinctWiderConsequence(wider, primaryConsequence, protectedWords) {
  const w = String(wider || '').trim();
  if (!w) return '';
  const continuation = asContinuation(w, FIXED_PREFIX_PATTERNS.widerConsequence, protectedWords);
  if (!continuation) return '';
  const a = comparable(continuation);
  const b = comparable(primaryConsequence);
  if (!b) return continuation;
  if (a === b || a.includes(b) || b.includes(a)) return '';
  if (isNearDuplicate(a, b)) return '';
  return continuation;
}

// Normalised form used for the "is this really a second thing?" comparisons:
// case and spacing flattened, terminal punctuation and a leading "that "
// dropped, so a finding written as a continuation ("that the conversation
// never established my timescale") compares like the same words written any
// other way.
function comparable(text) {
  return normalize(text).replace(/[.!?]+$/, '').replace(/^that\s+/, '');
}

function tokensOf(comparableText) {
  return comparableText.split(/[^a-z0-9']+/).filter(Boolean);
}

// shared / smaller side's size — deliberately NOT Jaccard (shared / union):
// a restatement is "one sentence is basically the other's words," which a
// min-size ratio catches even when the longer side pads it with extra
// clauses; Jaccard would dilute that same overlap and miss it. Only judged
// once BOTH sides clear a minimum token count — two short sentences can
// share most of their words by coincidence, so there is nothing safe to
// conclude below that floor.
const NEAR_DUPLICATE_MIN_TOKENS = 5;
const NEAR_DUPLICATE_OVERLAP = 0.8;

function isNearDuplicate(aComparable, bComparable) {
  const aTokens = tokensOf(aComparable);
  const bTokens = tokensOf(bComparable);
  if (aTokens.length < NEAR_DUPLICATE_MIN_TOKENS || bTokens.length < NEAR_DUPLICATE_MIN_TOKENS) return false;
  const setA = new Set(aTokens);
  const setB = new Set(bTokens);
  let shared = 0;
  for (const w of setA) if (setB.has(w)) shared += 1;
  return shared / Math.min(setA.size, setB.size) >= NEAR_DUPLICATE_OVERLAP;
}

// "Are these two pieces of text the same point?" — the shared comparison the
// email's three anti-duplication guards all sit on. True when they are
// genuinely different: not identical, neither wholly inside the other, and not
// the same handful of substantive words lightly reworded. Either side blank
// means there is nothing to duplicate, so they count as distinct.
export function isDistinctText(a, b) {
  const x = comparable(a);
  const y = comparable(b);
  if (!x || !y) return true;
  if (x === y || x.includes(y) || y.includes(x)) return false;
  return !isNearDuplicate(x, y);
}

// Two FINDINGS, compared as events rather than as sentences. Selecting the
// wider beat by index makes this possible at all: the old code could only
// compare the two paragraphs the model wrote, so a seller opportunity told as
// the main story and again as the wider beat looked like two different
// sentences. Comparing the findings themselves catches it whichever way the
// model words the paragraphs.
export function findingsAreDistinct(a, b) {
  if (!a || !b) return true;
  return isDistinctText(a.finding, b.finding);
}

// THE CENTRAL RULE OF THE EMAIL, enforced rather than only prompted for:
// "That meant ..." exists to say what the agency failed to find out,
// progress, convert or uncover. A consequence that is the finding again in
// other words answers nothing — it is the single most common way this email
// turns back into a critique — so it is rejected rather than printed.
// Two checks, deliberately different in strength:
//   1. outright containment — one sentence is wholly inside the other;
//   2. a NEAR-duplicate — not a substring, but the same handful of
//      substantive words lightly reworded ("before inviting me to view" vs
//      "before I was invited to view"), via isNearDuplicate() above.
// Sharing a few nouns is normal and correct (the consequence usually reuses
// the finding's own vocabulary) and is NOT caught by either check — only an
// outright or near-outright restatement is.
export function consequenceGoesBeyondFinding(consequence, mainFinding) {
  const c = comparable(consequence);
  if (!c) return false;
  const f = comparable(mainFinding);
  if (!f) return true;
  if (c === f || c.includes(f) || f.includes(c)) return false;
  if (isNearDuplicate(c, f)) return false;
  return true;
}

// ── SPECULATION ABOUT WHAT THE PROSPECT WOULD HAVE DONE ─────────────────────
//
// "That meant ..." has to be commercially hard, and the tempting way to make
// it harder is to invent what happened next in the buyer's head:
//   "...leaving it open for me to lose interest or go and view something
//    similar elsewhere."
// Nothing in the findings evidences that. The enquiry establishes what the
// agency did and did not do; it never establishes that the buyer cooled off,
// went to a competitor, or bought anywhere at all — and a prospect who spots
// one invented claim stops believing the evidenced ones next to it.
//
// What the consequence CAN say is what the enquiry itself proves: it stayed
// unqualified, the viewing stayed unbooked, the seller opportunity stayed
// unexplored, nothing established what should happen next. Those are just as
// hard-hitting and they are all defensible, so a consequence that speculates
// about the prospect's behaviour or state of mind is rejected and asked for
// again rather than printed.
//
// Deliberately narrow. It catches invented BUYER behaviour and outcome
// claims — not ordinary counterfactual language about the agency's own
// process, which the email legitimately uses ("nobody established whether I
// was ready to move").
const SPECULATION_PATTERNS = [
  // The buyer's interest / attention / state of mind.
  /\b(?:lose|losing|lost)\s+(?:interest|patience|confidence)\b/i,
  // "cold" is deliberately NOT here: "the enquiry went cold overnight"
  // describes the enquiry's own state, which the timeline evidences, rather
  // than claiming anything about what the person who sent it then did.
  /\b(?:go|going|gone|went)\s+(?:and\s+)?(?:elsewhere|somewhere)\b/i,
  /\b(?:move|moved|moving)\s+on\b/i,
  /\b(?:walk|walked|walking)\s+away\b/i,
  /\b(?:give|gave|given)\s+up\b/i,
  // The buyer taking their business somewhere else — never evidenced by an
  // enquiry we sent ourselves.
  /\belsewhere\b/i,
  /\banother\s+(?:agent|agency|branch)\b/i,
  /\b(?:a\s+)?competitor(?:'s|s)?\b/i,
  /\b(?:view|viewed|viewing|book|booked|buy|bought|purchase[d]?)\s+(?:something|somewhere|a\s+property)\s+(?:else|similar)\b/i,
  // Explicit hedged speculation about what the prospect might have done.
  /\b(?:I|we|the\s+buyer|a\s+buyer|the\s+enquirer|the\s+applicant)\s+(?:might|may|could|would)\s+(?:well\s+)?(?:have\b|be\b)/i,
  /\bleaving\s+(?:it|the\s+door|things)\s+open\s+for\b/i,
];

// True when a consequence rests on invented prospect behaviour rather than on
// what the enquiry actually establishes. Blank is not speculation.
export function readsAsSpeculation(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return SPECULATION_PATTERNS.some((re) => re.test(t));
}

// The fair observation's whole job is to disarm. A hedge word smuggles the
// criticism forward into the one paragraph that is supposed to be entirely
// fair, and the reader feels it immediately — "I want to say upfront that you
// eventually got back to me" is not a compliment. The paragraph is optional,
// so a hedged one is dropped rather than repaired: better no fair observation
// than a fake one. These four words are named in the brief itself.
const SNUCK_CRITICISM_PATTERNS = [
  /\beventually\b/i,
  /\balthough\b/i,
  /\bdespite\b/i,
  /\bhowever\b/i,
  // Same move, different word: "you finally came back to me", "at least you
  // acknowledged it", "albeit a day later" are all the compliment being
  // withdrawn inside the sentence that is supposed to give it.
  /\bfinally\b/i,
  /\bat least\b/i,
  /\balbeit\b/i,
];

export function readsAsSnuckCriticism(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return SNUCK_CRITICISM_PATTERNS.some((re) => re.test(t));
}

function ensureSentenceEnd(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

// Our own analytical language must never reach a prospect. A model asked for
// a fair observation when there is nothing fair to say will often explain
// ITSELF ("there is no strength to point to here") rather than return the
// empty string it was asked for — and that sentence would be merged into a
// real email verbatim. This is the deterministic backstop for rule 6 of the
// system prompt: any email variable that reads as a note to ourselves, or
// that refers to the machinery behind the email, is blanked instead of sent.
// NOTE: there is no generic "there is/are no ..." pattern here, deliberately.
// An earlier version had one, and it blanked ordinary prospect-facing copy —
// "There is no question asked about your budget" is exactly the kind of
// sentence main_finding and commercial_consequence are SUPPOSED to contain,
// not a note to ourselves. The specific self-referential phrasings below
// ("no strength to point to", "nothing to point to") already catch the
// actual failure mode without also catching every honest description of an
// absence. Don't re-add a broad "there is/are no" match without a concrete
// reproduction, per the regression test guarding this.
const INTERNAL_REASONING_PATTERNS = [
  /\b(?:the\s+)?(?:diagnosis|intelligence layer|personalisation|probe|analysis|dataset)\b/i,
  // "findings" is always our own concept; the SINGULAR only counts as one when
  // it is used as a noun with a determiner ("the finding that...", "no
  // finding"). Bare "finding" is ordinary English that legitimate email copy
  // needs — "without anyone finding out whether I was ready to view" is a
  // commercial consequence, not a note to ourselves, and an earlier blanket
  // /\bfindings?\b/ blanked exactly that sentence. Regression-tested.
  /\bfindings\b/i,
  /\b(?:the|a|any|no|this|that|each|our|these|those)\s+finding\b/i,
  /\bevidence\b/i,
  /\bno (?:strength|strengths|positives?|fair observation|genuine)\b/i,
  /\bnothing (?:to point to|positive|genuine|worth)\b/i,
  /\b(?:not applicable|n\/a|none recorded|placeholder)\b/i,
  /\bcannot (?:be|say|make|offer)\b/i,
  /\bdoes not support\b/i,
];

export function readsAsInternalReasoning(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return INTERNAL_REASONING_PATTERNS.some((re) => re.test(t));
}

// The email is written TO the agency by the person who sent the enquiry, so
// the agency is "you". A model asked to be fair will sometimes slip into
// commentary ABOUT them instead — "They didn't let this one go cold", "The
// team responded quickly" — which reads as a system describing them behind
// their back rather than a person writing to them, and it is the single
// tell that gives the whole email away. Sentence-initial third person is the
// reliable signal; "their" alone is not (the enquiry's own subject matter
// legitimately involves other people).
const DETACHED_THIRD_PERSON_PATTERNS = [
  /(?:^|[.!?]\s+)they\b/i,
  /(?:^|[.!?]\s+)the (?:team|agency|branch|office|agent)\b/i,
  /\btheir (?:team|agency|branch|office)\b/i,
];

export function readsAsDetachedThirdPerson(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return DETACHED_THIRD_PERSON_PATTERNS.some((re) => re.test(t));
}

// One gate for every prospect-facing string: strip any currency figure that
// isn't this probe's own property value, then drop the whole value if it
// reads as internal reasoning rather than something a person would say.
function emailVariable(text, allowedFigure) {
  // Order matters: strip the figures that were never ours to state, then the
  // sentences that turn the one allowed figure into the agency's loss, then
  // drop the whole value if what is left reads as a note to ourselves.
  const cleaned = stripInventedLoss(stripUnbackedCurrency(String(text || '').trim(), allowedFigure));
  if (!cleaned) return '';
  return readsAsInternalReasoning(cleaned) ? '' : cleaned;
}

// The template renders "... about {{property_address}}." with no way to drop
// the clause, so an address we never actually established must come back
// EMPTY rather than as "UNKNOWN — ..." — a probe whose address is blank is a
// probe that is not safe to send, and that is a data-quality decision for a
// human, not something to paper over with invented wording here.
export function emailPropertyAddress(probe) {
  if (isUnknownAddress(probe?.property_address)) return '';
  return cleanAddressForEmail(probe?.property_address);
}

// ── The contract gate: accept the output, or send it back ────────────────────
//
// THE MODEL DOES NOT GET THE LAST WORD ON A MANDATORY FIELD.
//
// The failure this exists to stop was seen on live probes (prb_hist_0004,
// prb_hist_0009): a strong story, a strong fair_observation, a strong
// main_finding, a strong wider beat — and a BLANK commercial_consequence, so
// the whole email was thrown away as unsendable. The model had not failed to
// work the consequence out. It had already written it, in primary_narrative:
// "the persistence went entirely into pushing a viewing, while the two things
// that would have told them who they were dealing with — his buying readiness
// and his selling potential — were left completely unexplored."
//
// That is exactly the sentence commercial_consequence needed. So the remaining
// problem was never diagnosis or reasoning quality — it was the STRUCTURED
// OUTPUT CONTRACT, and the fix is to refuse that output rather than store it.
// A row whose mandatory fields are incomplete is sent back to the model with
// the gap named and its own reasoning handed back to distil from, up to
// MAX_PERSONALISATION_ATTEMPTS times, before anything is accepted.

const MAX_PERSONALISATION_ATTEMPTS = 3;

// Only the violations a REGENERATION can actually fix. A probe with no
// established property address, or no parseable enquiry date, has a DATA
// problem: no number of AI calls will invent one, and retrying would burn
// three calls per probe on every rebuild for a row that can never send. Those
// stay unsendable after the first attempt, exactly as before.
const MODEL_FIXABLE_FIELDS = new Set([
  'fair_observation',
  'main_finding',
  'commercial_consequence',
  // The selection itself is model-fixable too: an index that does not exist,
  // a positive picked as the main story, or a wider finding that is the main
  // story again are all things asking again can genuinely correct.
  'positive_finding_index',
  'main_finding_index',
  'wider_finding_index',
  // ...and the paragraph-level half of the same check: a wider observation
  // that restates main_finding off an otherwise-valid selection.
  'wider_observation',
]);

// What the repair pass is told about each way a mandatory field went missing.
// Deliberately specific: "commercial_consequence was blank" and
// "commercial_consequence was your main_finding again" need opposite fixes,
// and a model asked simply to "try again" will reproduce the same output.
const REPAIR_NOTES = {
  fair_observation: {
    blank: 'fair_observation came back EMPTY. There was human contact on this enquiry, so this field is mandatory. Write it from the [POSITIVE] finding you selected; where the list carries no positive, name the plainest factual thing the findings establish about the contact — they replied, they called, they asked a question, they followed up, they used the name or the property correctly.',
    hedged_criticism: 'fair_observation was rejected because it hedged the compliment (eventually / although / despite / however / finally / at least / albeit). Paragraph 1 is entirely positive or it is not sent. Write the same acknowledgement with the criticism removed completely — the criticism belongs in main_finding, which is the next paragraph.',
    detached_third_person: 'fair_observation was rejected because it was written ABOUT the agency in the third person ("they", "the team"). You are the person who sent the enquiry, writing to them: say "you".',
  },
  main_finding: {
    blank: 'main_finding came back EMPTY. Name the primary thing the agency failed to do, as one coherent finding, without its commercial consequence.',
  },
  positive_finding_index: {
    blank: 'positive_finding_index was not a finding number that exists. The list contains at least one finding typed [POSITIVE] — pick the number of the strongest one, exactly as it is printed in the list.',
    not_positive: 'positive_finding_index pointed at a finding that is NOT typed [POSITIVE]. The fair observation can only be written from a positive finding. Pick the number of a [POSITIVE] finding, or null if there genuinely is not one.',
  },
  main_finding_index: {
    blank: 'main_finding_index was not a finding number that exists. Pick the number of the single strongest [PROBLEM] or [OPPORTUNITY] finding, exactly as it is printed in the list.',
    not_a_story_finding: 'main_finding_index pointed at a [POSITIVE] finding. The main story is what the agency failed to do — it must be a [PROBLEM] or an [OPPORTUNITY].',
  },
  wider_finding_index: {
    not_a_story_finding: 'wider_finding_index pointed at a [POSITIVE] finding. The wider beat is a second thing that was missed, not a compliment. Pick a [PROBLEM] or [OPPORTUNITY] finding, or null.',
    duplicates_main: 'wider_finding_index was the SAME UNDERLYING EVENT as main_finding_index — either the same number, or a finding that describes the same thing in other words. The email would then tell the agency the same story twice, one paragraph apart. Either pick a genuinely DIFFERENT finding, or return null and leave the wider beat empty. Null is a complete and correct answer.',
  },
  wider_observation: {
    duplicates_main_finding: 'wider_observation said the same thing as main_finding in different words. The wider beat is a SEPARATE observation or it does not appear at all — return an empty wider_observation and a null wider_finding_index.',
  },
  commercial_consequence: {
    blank: 'commercial_consequence came back EMPTY. This is the single most important sentence in the email and it is mandatory. You have already reasoned the consequence out above — distil it into this field. Do NOT leave the consequence sitting only inside primary_narrative or story_reasoning: those are internal notes that no prospect ever reads, so a consequence written only there is a consequence the agency never sees.',
    speculative: 'commercial_consequence was rejected because it speculated about what I would have done next — losing interest, going elsewhere, viewing something similar, moving on. The enquiry establishes what the agency did and did not do; it establishes nothing about my state of mind or where I went afterwards, and an invented claim like that costs you the evidenced ones beside it. Say instead what the enquiry itself proves was left undone: it stayed unqualified, the viewing was never booked or progressed, the seller opportunity was never explored, nothing established what should happen next.',
    restates_main_finding: 'commercial_consequence was rejected because it restated main_finding in different words. It must MOVE THE STORY FORWARD: because that finding happened, what did the agency fail to establish, progress, capture, qualify, convert or uncover? Answer that question instead of describing the failure again.',
    // THE THREE NOTES THAT USED TO BE REPORTED AS "blank". Each of these is a
    // sentence the model DID write and our own gates then deleted, so telling
    // it the field "came back EMPTY" describes something that never happened
    // and gives it nothing to change — see classifyConsequenceLoss() below.
    currency_stripped: 'commercial_consequence WAS written, but it was deleted because it contained a monetary figure that is not this probe\'s own confirmed property price — a rounded or approximated version of it ("£400,000+", "around £430,000") counts as a different figure and is deleted too. Write the same consequence again with NO monetary figure in it at all. The point does not need one.',
    invented_loss: 'commercial_consequence WAS written, but it was deleted because it turned the enquiry into money the agency lost — a fee, a commission, revenue, a percentage, or what it "cost you". We never state or imply that. Write the same consequence again in terms of what was not established, progressed, qualified, converted or uncovered, with no money in it at all.',
    internal_reasoning: 'commercial_consequence WAS written, but it was deleted because it used our own analytical vocabulary ("finding", "findings", "evidence", "diagnosis", "analysis") — words that give away that this came out of a system rather than from the person who sent the enquiry. Write the same consequence again in plain language, as the person who made the enquiry would say it to you.',
  },
};

// WHY A SANITISED-AWAY CONSEQUENCE MUST NOT BE CALLED "blank".
//
// commercial_consequence goes through emailVariable() before it is validated:
// stripUnbackedCurrency() drops any SENTENCE carrying a figure that is not
// this probe's own property price, stripInventedLoss() drops one that turns
// the allowed figure into the agency's loss, and readsAsInternalReasoning()
// drops the whole value if it reads as a note to ourselves. The consequence is
// usually ONE sentence, and the brief itself pushes the property price into
// this field, so any of those three deletes the entire field — and the
// rejection recorded for it was 'blank', i.e. "you wrote nothing".
//
// That is the loop this fix breaks: the model writes a perfectly good
// consequence, is told it wrote nothing, writes the same kind of sentence
// again, and has it deleted again — three attempts, then a row stored with
// main_finding and main_finding_index populated beside a blank
// commercial_consequence and a blank email_body, which is exactly how the live
// 0005/0006/0007 rows came back. No tie-break between attempts can help when
// every attempt loses the field to the same deterministic filter, which is why
// the fallback fix did not change what those probes stored.
//
// raw: the model's own commercial_consequence, before emailVariable().
// -> the REPAIR_NOTES reason describing what actually happened to it.
export function classifyConsequenceLoss(raw, allowedFigure) {
  const text = String(raw || '').trim();
  if (!text) return 'blank';
  // Same three gates, in the same order emailVariable() applies them, so the
  // reason reported is the one that actually emptied the field.
  const afterCurrency = stripUnbackedCurrency(text, allowedFigure);
  if (!afterCurrency) return 'currency_stripped';
  const afterLoss = stripInventedLoss(afterCurrency);
  if (!afterLoss) return 'invented_loss';
  if (readsAsInternalReasoning(afterLoss)) return 'internal_reasoning';
  // Whatever survived all three was emptied by the continuation shaping (a
  // value that was nothing but the "That meant" prefix), which is a model that
  // wrote no consequence.
  return 'blank';
}

// The repair turn, appended to the same prompt. The model is handed its own
// previous answer — including the reasoning it already did — because the whole
// point is that the missing sentence is usually already there in prose and
// needs distilling, not re-deriving from scratch.
export function buildRepairPrompt(previousResult, rejections) {
  const notes = rejections
    .map(({ field, reason }) => `- ${REPAIR_NOTES[field]?.[reason] || `${field} is mandatory and is missing.`}`)
    .join('\n');

  return [
    '',
    '=== YOUR PREVIOUS ANSWER WAS REJECTED — WRITE IT AGAIN ===',
    'The email cannot be sent as you answered it, so nothing has been stored. What follows is your own previous answer. Return the COMPLETE tool call again: keep everything that was right, and fix only what is named below.',
    '',
    `Your reasoning was: ${String(previousResult?.story_reasoning || '(none)').trim()}`,
    `You selected positive_finding_index: ${previousResult?.positive_finding_index ?? 'null'}, main_finding_index: ${previousResult?.main_finding_index ?? 'null'}, wider_finding_index: ${previousResult?.wider_finding_index ?? 'null'}`,
    `Your primary_narrative was: ${String(previousResult?.primary_narrative || '(none)').trim()}`,
    `Your fair_observation was: ${String(previousResult?.fair_observation || '(empty)').trim()}`,
    `Your main_finding was: ${String(previousResult?.main_finding || '(empty)').trim()}`,
    `Your commercial_consequence was: ${String(previousResult?.commercial_consequence || '(empty)').trim()}`,
    '',
    'WHAT TO FIX:',
    notes,
    '',
    'REMEMBER: the findings list you were given is the only source there is — never invent a finding or a piece of evidence to satisfy a correction, and if the honest answer to the wider beat is null, answer null. primary_narrative and story_reasoning are INTERNAL. They are never shown to the agency. Every sentence the agency actually reads comes from fair_observation, main_finding, commercial_consequence, wider_observation and wider_consequence, so a point that exists only in your narrative is a point the email does not make. Derive the structured fields FROM your reasoning: main_finding = what happened / what was missed; commercial_consequence = what that meant commercially; wider_observation = the separate second opportunity, if there is one; wider_consequence = what that second opportunity meant.',
  ].join('\n');
}

// ── The dedicated consequence repair ─────────────────────────────────────────
//
// THE LAST RESORT FOR THE ONE FIELD THE EMAIL CANNOT BE SENT WITHOUT.
//
// Every attempt above regenerates the WHOLE story to recover one sentence, and
// that is a lottery the sentence keeps losing: the full-story call has eleven
// other fields to satisfy, so an attempt that finally gets the consequence
// right can lose it again to an unrelated slip, and an attempt that keeps
// putting the property price into it keeps having it deleted. When the ONLY
// thing standing between this row and a sendable email is that one field, it
// is asked for on its own instead — one small structured call, one field, the
// selected finding in front of it, and the two rules that actually delete this
// field (no monetary figures at all, no analytical vocabulary) stated as hard
// constraints rather than left to survive a twelve-field brief.
//
// It runs at most ONCE per probe, only after every full-story attempt has been
// spent, and only when a valid answer would make the row sendable — a row that
// is also missing its fair observation is not saved by a consequence, so it is
// not worth an extra AI call.

const CONSEQUENCE_TOOL = {
  name: 'record_commercial_consequence',
  description: 'Record the single "That meant ..." sentence for one probe\'s outreach email.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['commercial_consequence'],
    properties: {
      commercial_consequence: {
        type: 'string',
        description: 'EMAIL COPY, read by the prospect. The email hard-codes "That meant " immediately before this text, so return ONLY the continuation, starting lower-case, e.g. "nobody established whether I was ready to move, or what should happen next." One or two sentences. It must say what the agency failed to establish, progress, capture, qualify, convert or uncover BECAUSE of the finding — never the finding again in other words. NO monetary figures of any kind. No fee, commission, percentage or lost revenue. No analytical vocabulary (finding, findings, evidence, diagnosis, analysis). Never claim a sale or an instruction was definitely lost, and never speculate about what the person who enquired would have done next — losing interest, going elsewhere, viewing something similar. Say what the enquiry proves was left undone.',
      },
    },
  },
};

const CONSEQUENCE_SYSTEM_PROMPT = `You are writing ONE sentence of an outreach email to an estate agency, from the person who sent them a property enquiry.

The email already says what happened. Your only job is the sentence that comes immediately after it, introduced by the fixed words "That meant ".

RULES, all of which are enforced in code and will delete your answer if broken:
1. Say what the agency failed to ESTABLISH, PROGRESS, CAPTURE, QUALIFY, CONVERT or UNCOVER because of what happened. Do not describe what happened again — that sentence is already in the email, and repeating it is rejected.
2. NO MONETARY FIGURES AT ALL. Not the property price, not a fee, not a commission, not a percentage, not lost revenue, not "this could have cost you". The point does not need a number.
3. Never claim a sale, a viewing or an instruction was definitely lost, and NEVER SPECULATE ABOUT WHAT THE PERSON WHO ENQUIRED WOULD HAVE DONE NEXT — not losing interest, not cooling off, not moving on, not going elsewhere, not going to another agent, not viewing or buying something similar somewhere else. The enquiry establishes what the agency did and did not do, and nothing about the enquirer's state of mind or where they went afterwards. Say what was never established, never qualified, never booked, never progressed or never explored — that is both defensible and harder-hitting.
4. Plain language, written by the person who made the enquiry: "you" is the agency, "I"/"me" is them. Never our own vocabulary — no "finding", "findings", "evidence", "diagnosis", "analysis".
5. Write only the continuation of "That meant ", starting lower-case. One or two sentences, then stop.
6. Ground it in what you are given. Never invent anything that is not there.`;

export function buildConsequencePrompt({ mainFinding, finding, primaryNarrative, storyReasoning }) {
  return [
    '=== WHAT THE EMAIL HAS ALREADY SAID ===',
    mainFinding
      ? `"What stood out, though, was ${mainFinding}"`
      : 'Nobody ever replied to the enquiry at all, so the email says only that we never received a reply.',
    '',
    '=== THE FINDING THIS RESTS ON ===',
    finding
      ? [
        `Finding: ${finding.finding}`,
        `Evidence: ${finding.evidence}`,
        `Why it matters: ${finding.significance_note || '(not recorded)'}`,
      ].join('\n')
      : '(none recorded)',
    '',
    '=== YOUR OWN EARLIER REASONING ABOUT THIS ENQUIRY ===',
    String(primaryNarrative || storyReasoning || '(none)').trim(),
    '',
    '=== WRITE THE SENTENCE ===',
    'Return the continuation of "That meant " only.',
  ].join('\n');
}

// Is this the ONE field standing between the row and a sendable email? Only
// then is the extra call worth making: anything else still outstanding is not
// fixed by a consequence, so the row would stay unsendable either way. Shared
// with the caller's AI-call accounting, so the number of calls billed is
// always the number actually made.
export function consequenceRepairIsWorthACall(best) {
  if (!best || best.row.commercial_consequence) return false;
  if (best.rejections.length === 0) return false;
  return best.rejections.every(({ field }) => field === 'commercial_consequence');
}

// best: the closest full-story candidate. -> the accepted continuation, or ''
// when the dedicated call is not worth making or its answer fails the same
// gates the full-story answer had to pass.
async function repairConsequence(best, ctx) {
  const { allowedFigure, orderedFindings } = ctx;
  const row = best.row;

  if (!consequenceRepairIsWorthACall(best)) return '';

  const mainIndex = Number(row.main_finding_index);
  const finding = Number.isInteger(mainIndex) && mainIndex > 0
    ? orderedFindings.find((f, i) => (f.finding_index || i + 1) === mainIndex) || null
    : null;

  const result = await callAi({
    system: CONSEQUENCE_SYSTEM_PROMPT,
    prompt: buildConsequencePrompt({
      mainFinding: row.main_finding,
      finding,
      primaryNarrative: best.result?.primary_narrative,
      storyReasoning: best.result?.story_reasoning,
    }),
    tool: CONSEQUENCE_TOOL,
  });

  // The same gates, in the same order, as the full-story answer: an answer
  // that is only acceptable because it skipped validation would put exactly
  // the sentence this layer refuses in front of a prospect.
  const consequence = stripThatMeantPrefix(
    emailVariable(result?.commercial_consequence, allowedFigure),
    ctx.protectedWords,
  );
  if (!consequence) return '';
  if (!consequenceGoesBeyondFinding(consequence, row.main_finding)) return '';
  if (readsAsSpeculation(consequence)) return '';
  return consequence;
}

// The repaired sentence back into the row — and the two things downstream of
// it re-derived, never left stale: the wider consequence's distinctness is
// judged against the NEW primary consequence, and the email is re-assembled
// from the same fields the assembler would have been given the first time.
function withRepairedConsequence(row, consequence, protectedWords) {
  const widerConsequence = row.wider_observation
    ? distinctWiderConsequence(row.wider_consequence, consequence, protectedWords)
    : '';
  const emailCopy = {
    enquiry_date: row.enquiry_date,
    property_address: row.property_address,
    email_variant: row.email_variant,
    fair_observation: row.fair_observation,
    main_finding: row.main_finding,
    commercial_consequence: consequence,
    wider_observation: row.wider_observation,
    wider_consequence: widerConsequence,
    additional_findings_hook: row.additional_findings_hook,
  };
  return { ...row, ...emailCopy, email_body: assembleEmail(emailCopy) };
}

// ── Entry point ──────────────────────────────────────────────────────────────
//
// probe: PROBES row. intelligence: the finalised INTELLIGENCE row — used ONLY
// for the two deterministic, code-owned decisions (which email variant this
// is, and which hero journey the demo routes to); no INTELLIGENCE prose ever
// reaches the model. diagnosis: the DIAGNOSIS row — used ONLY for
// novus_opportunity, in the same deterministic hero-journey lookup; no
// DIAGNOSIS prose reaches the model either. findings: that probe's
// DIAGNOSIS_FINDINGS list (see lib/diagnosis-findings.mjs), already ordered by
// finding_index, and the ONLY account of what happened the model is given.
// agency: AGENCIES row, for the scale fact and the protected proper nouns.
//
// COMMUNICATIONS is deliberately NOT a parameter any more. The story is
// selected from findings, and every finding already carries the evidence it
// rests on — so the raw messages had nothing left to add except tokens and an
// invitation to re-diagnose. lib/personalisation-rebuild.mjs no longer loads
// that tab for this step at all.
//
// Makes ONE AI call for a probe whose answer satisfies the email contract,
// and up to MAX_PERSONALISATION_ATTEMPTS - 1 further REPAIR calls for one
// whose answer does not — see THE CONTRACT GATE above. It is still a single
// analytical pass: a repair call re-asks the same question with the gap named,
// it never re-diagnoses, re-grades or adds a finding.
//
// Because a probe can now cost more than one call, the returned row carries
// ai_calls_used: accounting for the caller's AI-call budget, NOT a stored
// column (no PERSONALISATION header holds it, so it never reaches the sheet).
// lib/personalisation-rebuild.mjs bills the budget by that number, so a
// request capped at N AI calls still makes at most N.
export async function personaliseProbe(probe, intelligence, diagnosis, findings, agency) {
  const orderedFindings = Array.isArray(findings) ? findings : [];
  // The variant is a CODE decision, not a model one — it selects which of the
  // two locked email structures is being written, and the model is told which
  // rather than left to infer it from an interpretation layer it no longer
  // sees.
  const emailVariant = String(intelligence?.human_contact || '').trim() === 'none' ? 'no_response' : 'normal';

  const ctx = {
    probe,
    intelligence,
    diagnosis,
    emailVariant,
    orderedFindings,
    allowedFigure: probe?.property_price || null,
    // Words this probe's own address/agency established as proper nouns —
    // never forced to lower case when they open a continuation. See
    // extractProtectedWords() for why this can't be a global dictionary:
    // "Fox" is a name here and an ordinary word on someone else's probe.
    protectedWords: extractProtectedWords(probe, agency),
  };

  const basePrompt = buildPrompt(probe, orderedFindings, emailVariant, computeScaleFact(agency));

  let previous = null;   // the attempt the next repair pass is built from
  let best = null;       // the attempt returned if none ever satisfies the contract

  for (let attempt = 1; attempt <= MAX_PERSONALISATION_ATTEMPTS; attempt += 1) {
    const result = await callAi({
      system: SYSTEM_PROMPT,
      prompt: attempt === 1
        ? basePrompt
        : `${basePrompt}\n${buildRepairPrompt(previous.result, previous.rejections)}`,
      tool: TOOL,
    });

    const candidate = buildCandidate(result, ctx);

    // Accepted: every mandatory field this row's variant needs is present.
    if (candidate.rejections.length === 0) return { ...candidate.row, ai_calls_used: attempt };

    // Otherwise keep the closest attempt so far.
    if (isBetterFallback(candidate, best)) best = candidate;
    previous = candidate;
  }

  // Nothing satisfied the contract. Before storing an unsendable row, the ONE
  // case worth one more call: every outstanding violation is
  // commercial_consequence itself, so a single valid sentence turns this row
  // into a complete email. Asked for on its own, not as a fourth full story —
  // see THE DEDICATED CONSEQUENCE REPAIR above.
  const repaired = await repairConsequence(best, ctx);
  if (repaired) {
    return {
      ...withRepairedConsequence(best.row, repaired, ctx.protectedWords),
      ai_calls_used: MAX_PERSONALISATION_ATTEMPTS + 1,
    };
  }

  // The row is still stored with its full internal story — a human now has a
  // probe to look at, with a blank email_body saying so, rather than an email
  // with a hole in it.
  return {
    ...best.row,
    ai_calls_used: MAX_PERSONALISATION_ATTEMPTS + (consequenceRepairIsWorthACall(best) ? 1 : 0),
  };
}

// THE FALLBACK TIE-BREAK, when no attempt ever satisfies the contract.
//
// Fewer total violations wins outright. A genuine TIE previously always went
// to the earlier attempt ("a repair pass that fixed one field while losing
// another is not an improvement") — but that rule silently discarded a later
// attempt that fixed commercial_consequence specifically, in favour of an
// earlier one that still had it blank, whenever the later attempt happened
// to trade it for a different, unrelated violation of equal weight. The
// stored row then showed commercial_consequence blank with main_finding_index
// perfectly populated — the single field this whole retry mechanism exists
// to protect (see THE CONTRACT GATE above), lost to an incidental tie.
//
// So a tie is now broken in favour of whichever attempt actually resolved
// commercial_consequence; only when both agree on that does the earlier
// attempt still win, exactly as before.
function isBetterFallback(candidate, best) {
  if (!best) return true;
  if (candidate.rejections.length < best.rejections.length) return true;
  if (candidate.rejections.length > best.rejections.length) return false;
  const candidateHasConsequence = Boolean(candidate.row.commercial_consequence);
  const bestHasConsequence = Boolean(best.row.commercial_consequence);
  return candidateHasConsequence && !bestHasConsequence;
}

// One model answer -> the stored row, plus the mandatory fields that did not
// survive and why. Pure: no AI call, so the retry loop above is the only place
// that decides whether to ask again.
function buildCandidate(result, ctx) {
  const { probe, intelligence, diagnosis, emailVariant, orderedFindings, allowedFigure, protectedWords } = ctx;
  const clean = (value) => stripUnbackedCurrency(String(value || '').trim(), allowedFigure);

  // A probe that was never replied to has no conversation to describe, so it
  // gets the assembler's own no-response structure (see its header). The
  // failure IS the silence: there is nothing fair to observe about handling
  // that never happened, and no main finding to narrate, so both are forced
  // empty here rather than left to the model to invent — and neither is asked
  // for again, because neither is missing.
  const noHumanContact = emailVariant === 'no_response';

  // ── THE SELECTION ─────────────────────────────────────────────────────────
  //
  // The email's three beats each come from ONE finding, chosen by index. This
  // block is the code half of that contract: every index is resolved against
  // the findings that actually exist, checked against the TYPE the beat
  // requires, and — for the wider beat — checked against the main story so the
  // same underlying event cannot be told twice.
  //
  // THE DUPLICATION THIS CLOSES (the prb_hist_0007 shape). The seller /
  // valuation opportunity was the strongest thing in the enquiry, so the model
  // made it the main story — and then, asked for an optional wider beat,
  // reached for the strongest thing in the enquiry again and printed it a
  // second time, one paragraph later, in slightly different words. Nothing in
  // the old code could see that: the two paragraphs were different SENTENCES
  // about the same EVENT, and only the sentences were compared. Selecting by
  // index makes the event itself comparable, so "same number" and "same
  // finding reworded" are both catchable — and both are refused.
  const byIndex = new Map(orderedFindings.map((f, i) => [f.finding_index || i + 1, f]));
  const positivesExist = orderedFindings.some(isPositiveFinding);
  const storyFindingsExist = orderedFindings.some(isStoryFinding);

  const rejections = [];

  // -> the index, when it names a finding that genuinely exists; null otherwise.
  // A hallucinated index is never silently kept: it would make the audit trail
  // back to DIAGNOSIS_FINDINGS lie about which finding the email rests on.
  const resolveIndex = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && byIndex.has(n) ? n : null;
  };

  // THE POSITIVE. Mandatory only when the findings list actually carries a
  // positive to select — a probe diagnosed before positives were structured
  // has none, and its fair observation is still written and still validated
  // the same way, it simply is not index-backed. Forced null in the
  // no-response variant: there was no contact, so there is no positive, and a
  // model that picks one anyway is not asked again, it is overruled.
  let positiveIndex = null;
  if (!noHumanContact) {
    positiveIndex = resolveIndex(result.positive_finding_index);
    if (positiveIndex === null) {
      if (positivesExist) rejections.push({ field: 'positive_finding_index', reason: 'blank' });
    } else if (!isPositiveFinding(byIndex.get(positiveIndex))) {
      positiveIndex = null;
      rejections.push({ field: 'positive_finding_index', reason: 'not_positive' });
    }
  }

  // THE MAIN STORY. Mandatory whenever any problem/opportunity finding exists —
  // in BOTH variants. The no-response email prints no main_finding paragraph,
  // but its commercial_consequence is still mandatory and still has to rest on
  // a finding: the silence is the finding, and this is what grounds the
  // consequence of it. What variant 1 suppresses is the COPY, not the
  // grounding.
  //
  // A probe whose findings are all positives (handling that genuinely worked)
  // has no main story to select, and that is a correct answer — the email's
  // own main_finding validation below still applies.
  let mainIndex = resolveIndex(result.main_finding_index);
  if (mainIndex === null) {
    if (storyFindingsExist) rejections.push({ field: 'main_finding_index', reason: 'blank' });
  } else if (isPositiveFinding(byIndex.get(mainIndex))) {
    mainIndex = null;
    rejections.push({ field: 'main_finding_index', reason: 'not_a_story_finding' });
  }

  // THE WIDER BEAT. Always optional — null is a complete answer and is never
  // rejected. What IS rejected is a wider finding that is the main story
  // again: the same index, or a different index whose finding text is the same
  // event lightly reworded. Either way the beat is dropped from this
  // candidate, so even an answer that never gets the selection right stores an
  // email that says the thing once rather than twice.
  let widerIndex = resolveIndex(result.wider_finding_index);
  if (widerIndex !== null) {
    if (isPositiveFinding(byIndex.get(widerIndex))) {
      widerIndex = null;
      rejections.push({ field: 'wider_finding_index', reason: 'not_a_story_finding' });
    } else if (mainIndex !== null && widerIndex === mainIndex) {
      widerIndex = null;
      rejections.push({ field: 'wider_finding_index', reason: 'duplicates_main' });
    } else if (mainIndex !== null && !findingsAreDistinct(byIndex.get(widerIndex), byIndex.get(mainIndex))) {
      widerIndex = null;
      rejections.push({ field: 'wider_finding_index', reason: 'duplicates_main' });
    }
  }

  // The selection, as the finding numbers the story rests on. This is the
  // existing narrative-finding structure, now populated from the explicit
  // selection rather than from a free list the model returned alongside it.
  const selectedIndexes = [positiveIndex, mainIndex, widerIndex].filter((n) => n !== null);
  const narrativeIndexes = [...new Set(selectedIndexes)].sort((a, b) => a - b);

  // EVIDENCE IS NO LONGER ASKED FOR — IT IS DERIVED. Every finding already
  // carries the evidence it rests on, checked by Diagnosis's own evidence gate
  // and re-checked on the way back out of the tab, so the evidence behind this
  // email is exactly the evidence behind the findings it selected. There is
  // nothing left for the model to get wrong here, and no quote it could
  // fabricate: it never sees the raw messages at all.
  const evidence = narrativeIndexes
    .map((n) => `Finding ${n}: ${byIndex.get(n).evidence}`)
    .join('; ');

  // If every genuine problem/opportunity finding is already part of the
  // selection there is nothing left to be a separate second thing, so the
  // INTERNAL supporting_findings is forced empty rather than padded. Positives
  // are excluded: an unselected positive is not an outstanding finding. This
  // no longer gates the email's closing transition: that line is locked copy
  // that appears every time, because it is the hand-off into the breakdown
  // rather than a claim about how many other findings exist (see
  // lib/email-assembly.mjs).
  const hasUncoveredFindings = orderedFindings
    .some((f, i) => isStoryFinding(f) && !narrativeIndexes.includes(f.finding_index || i + 1));
  const supportingFindings = hasUncoveredFindings ? clean(result.supporting_findings) : '';

  // ── EMAIL COPY ────────────────────────────────────────────────────────────
  // Everything below is read by a real person, so each value goes through
  // emailVariable(): the currency allow-list, then the internal-reasoning
  // backstop. lib/email-assembly.mjs then puts these sentences in order — it
  // never rewrites one.
  //
  // Each mandatory field that does not survive is RECORDED with the reason it
  // did not (into the same rejections list the selection above uses), so the
  // repair pass can be told what actually went wrong instead of being asked
  // the same question again.

  // Fair observation: MANDATORY in the normal variant (see the email contract
  // in lib/email-assembly.mjs). It is not gated on Diagnosis having recorded a
  // "strength": Diagnosis records strengths worth writing up commercially, and
  // the email's bar is far lower — any human contact at all leaves something
  // factual to acknowledge (they replied, they called, they asked a question,
  // they used the address correctly). What it IS gated on is honesty: a fair
  // observation written as detached commentary about the agency, or one that
  // smuggles the criticism forward with "eventually"/"although"/"at least", is
  // never repaired in code and never printed. It is rejected, and the model is
  // asked for an honest one instead.
  const fairObservationCandidate = noHumanContact
    ? ''
    : asContinuation(emailVariable(result.fair_observation, allowedFigure), FIXED_PREFIX_PATTERNS.fairObservation, protectedWords);
  let fairObservation = fairObservationCandidate;
  if (!noHumanContact) {
    if (!fairObservationCandidate) {
      fairObservation = '';
      rejections.push({ field: 'fair_observation', reason: 'blank' });
    } else if (readsAsDetachedThirdPerson(fairObservationCandidate)) {
      fairObservation = '';
      rejections.push({ field: 'fair_observation', reason: 'detached_third_person' });
    } else if (readsAsSnuckCriticism(fairObservationCandidate)) {
      fairObservation = '';
      rejections.push({ field: 'fair_observation', reason: 'hedged_criticism' });
    }
  }

  // The assembler supplies "What stood out, though, was ".
  const mainFinding = noHumanContact
    ? ''
    // ...and the complementiser the fixed prefix needs, where the model left
    // it out: "was it took over 63 hours" -> "was that it took over 63 hours".
    // See withComplementiser() for why this is an allow-list and not a blanket
    // prepend.
    : withComplementiser(
      asContinuation(emailVariable(result.main_finding, allowedFigure), FIXED_PREFIX_PATTERNS.mainFinding, protectedWords),
      protectedWords,
    );
  if (!noHumanContact && !mainFinding) rejections.push({ field: 'main_finding', reason: 'blank' });

  // The assembler supplies "That meant " — this is only the rest of the
  // sentence, never a repeat of the prefix. MANDATORY in BOTH variants: an
  // email that describes a problem and never says what it cost is the exact
  // failure mode this whole layer exists to prevent.
  const consequenceCandidate = stripThatMeantPrefix(emailVariable(result.commercial_consequence, allowedFigure), protectedWords);

  // ...and it has to be a consequence, not the finding again.
  let commercialConsequence = consequenceCandidate;
  if (!consequenceCandidate) {
    // ...and the reason is the one that ACTUALLY applies: a consequence the
    // model never wrote, or one it wrote and our own gates deleted. See
    // classifyConsequenceLoss() for why calling all four cases 'blank' is what
    // made this field unrepairable.
    rejections.push({
      field: 'commercial_consequence',
      reason: classifyConsequenceLoss(result.commercial_consequence, allowedFigure),
    });
  } else if (!consequenceGoesBeyondFinding(consequenceCandidate, mainFinding)) {
    commercialConsequence = '';
    rejections.push({ field: 'commercial_consequence', reason: 'restates_main_finding' });
  } else if (readsAsSpeculation(consequenceCandidate)) {
    // ...and it has to rest on what the enquiry establishes, not on invented
    // buyer behaviour — see SPECULATION ABOUT WHAT THE PROSPECT WOULD HAVE
    // DONE above.
    commercialConsequence = '';
    rejections.push({ field: 'commercial_consequence', reason: 'speculative' });
  }

  // The optional wider beat, and it is a PAIR. The observation is its own
  // sentence; the consequence is a continuation of "That also meant " and
  // survives only when (a) there is an observation for it to be the
  // consequence OF, and (b) it is genuinely a SECOND consequence rather than
  // the first one reworded. An orphan wider_consequence would print as the
  // consequence of something the reader was never told. A MISSING beat is
  // never rejected — the whole thing is optional, so an empty one is a
  // complete answer.
  //
  // What IS refused is the beat that says the main story again — and THE BEAT
  // ONLY EXISTS WHERE A WIDER FINDING WAS ACTUALLY SELECTED. That gate comes
  // first, and it does two jobs at once:
  //   1. it grounds the paragraph. A wider observation with no finding behind
  //      it is an invented finding, whatever it says, and the whole point of
  //      this layer is that it never invents one.
  //   2. it makes the duplicate rejection above STICK. Without it, refusing a
  //      wider INDEX that duplicated the main story would drop the index and
  //      then print the duplicate paragraph anyway — the 0007 email, one
  //      validation later.
  // Not itself a rejection: the beat is optional, so an ungrounded one is
  // simply not printed. Where the index was refused, the rejection recorded
  // above is what asks the model again.
  let widerObservation = widerIndex === null
    ? ''
    : asStandaloneSentence(emailVariable(result.wider_observation, allowedFigure));
  // Two things have to hold, and this is the second of them: the selection
  // proved the wider FINDING is a different event, and this proves the
  // SENTENCE is too. A model can select finding 3 correctly and still write
  // main_finding's point into wider_observation in other words, and the
  // reader only ever sees the sentences.
  if (widerObservation && mainFinding && !isDistinctText(widerObservation, mainFinding)) {
    widerObservation = '';
    rejections.push({ field: 'wider_observation', reason: 'duplicates_main_finding' });
  }
  const widerConsequenceCandidate = widerObservation
    ? distinctWiderConsequence(
      emailVariable(result.wider_consequence, allowedFigure),
      commercialConsequence,
      protectedWords,
    )
    : '';
  // The same evidence rule as the primary consequence, but this beat is
  // OPTIONAL — so a speculative one is dropped rather than sent back, exactly
  // like one that merely restates the first consequence.
  const widerConsequence = readsAsSpeculation(widerConsequenceCandidate) ? '' : widerConsequenceCandidate;

  // DET, never AI-authored, and never conditional. The curiosity transition
  // into the offer of the breakdown, in both variants: it is not a promise of
  // two more findings, so it does not depend on a finding being left over
  // (see THE FINAL TWO PARAGRAPHS in lib/email-assembly.mjs). The assembler
  // prints the locked line itself; the row carries it so the stored
  // PERSONALISATION row shows what the prospect actually read.
  // ...and only in the normal variant: the no-response email closes with its
  // own two lines, which already say there were a couple of things, so the
  // tease would say it twice.
  const additionalFindingsHook = noHumanContact ? '' : ADDITIONAL_FINDINGS_HOOK_LINE;

  const heroJourney = pickHeroJourney(intelligence, orderedFindings, diagnosis);

  // The email-facing half of the row, kept together so the assembler is
  // handed exactly what a stored PERSONALISATION row would give it later.
  const emailCopy = {
    enquiry_date: formatEnquiryDate(probe?.probe_timestamp),
    property_address: emailPropertyAddress(probe),
    email_variant: emailVariant,
    fair_observation: fairObservation,
    main_finding: mainFinding,
    commercial_consequence: commercialConsequence,
    wider_observation: widerObservation,
    wider_consequence: widerConsequence,
    additional_findings_hook: additionalFindingsHook,
  };

  return {
    result,
    // Only what asking again could actually change. A missing property address
    // is a data problem, not an answer the model got wrong, so it is not a
    // reason to spend two more AI calls on this probe.
    rejections: rejections.filter(({ field }) => MODEL_FIXABLE_FIELDS.has(field)),
    row: {
      // ── Internal: the breakdown / demo / our own reasoning. Never part of
      // the email.
      hero_journey: HERO_JOURNEYS.includes(heroJourney) ? heroJourney : 'slow_response_gap',
      primary_narrative: clean(result.primary_narrative),
      // The existing narrative-finding structure, now written from the
      // explicit selection: exactly the findings the three email beats rest
      // on, in ascending order.
      narrative_finding_indexes: narrativeIndexes.join(','),
      // ...and the selection itself, beat by beat, so a row can be audited
      // without re-deriving which index was which. These three are optional
      // columns: a PERSONALISATION tab that does not carry them yet simply
      // drops the values, exactly like wider_observation before it.
      positive_finding_index: positiveIndex === null ? '' : positiveIndex,
      main_finding_index: mainIndex === null ? '' : mainIndex,
      wider_finding_index: widerIndex === null ? '' : widerIndex,
      supporting_findings: supportingFindings,
      evidence,
      novus_counterfactual: clean(result.novus_counterfactual),

      // ── Email copy: sentence-ready, read by the prospect.
      ...emailCopy,

      // ── The assembled email, built deterministically from exactly the
      // fields above. Blank when this row cannot produce a complete, honest
      // email — see SENDABILITY in lib/email-assembly.mjs.
      email_body: assembleEmail(emailCopy),
    },
  };
}

export const _internal = {
  TOOL, SYSTEM_PROMPT, MAX_PERSONALISATION_ATTEMPTS, MODEL_FIXABLE_FIELDS, REPAIR_NOTES,
  CONSEQUENCE_TOOL, CONSEQUENCE_SYSTEM_PROMPT, classifyConsequenceLoss,
  buildCandidate, buildPrompt,
  normalize, computeScaleFact, isUnknownAddress, cleanAddressForEmail,
  emailVariable, ensureSentenceEnd, asStandaloneSentence,
  HERO_JOURNEYS, INTERNAL_REASONING_PATTERNS, DETACHED_THIRD_PERSON_PATTERNS,
};
