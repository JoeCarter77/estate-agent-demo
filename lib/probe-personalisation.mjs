// lib/probe-personalisation.mjs — the ONE AI call that turns a probe's
// already-settled INTELLIGENCE + DIAGNOSIS + DIAGNOSIS_FINDINGS into the
// story, and into the sentence-ready copy the outreach email is built from.
//
// Pipeline position: PROBE -> DIAGNOSIS -> DIAGNOSIS_FINDINGS ->
// PERSONALISATION -> EMAIL -> personalised breakdown / demo journey.
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
// questions first, in story_reasoning, and only then writes the email fields:
// what did the agency genuinely do well; what is the strongest primary missed
// opportunity; because that happened what did they fail to establish, progress
// or capture; is there a genuinely separate wider opportunity; and what did
// missing that mean. Filling the variables first is what produces
// finding -> finding -> blank consequence, which is the failure mode this
// layer exists to prevent.
//
// The output splits in two:
//   INTERNAL (breakdown / demo / our own reasoning) — primary_narrative,
//     narrative_finding_indexes, supporting_findings, evidence,
//     novus_counterfactual, hero_journey.
//   EMAIL COPY (what the prospect actually reads) — enquiry_date,
//     property_address, email_variant, fair_observation, main_finding,
//     commercial_consequence, wider_observation, wider_consequence,
//     additional_findings_hook, and the assembled email_body.
// Nothing internal is ever merged into the email, so our own reasoning
// language can never leak into it.
//
// Guards enforced in CODE, not merely prompted for:
//   - evidence quotes: every quote must be a literal substring of the raw
//     communication it cites; one that isn't is dropped (same discipline as
//     lib/probe-interpretation.mjs and lib/probe-diagnosis.mjs).
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
//   - main_finding: MANDATORY in variant 2, forced empty in variant 1.
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
import { formatFindingsForPrompt } from './diagnosis-findings.mjs';
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
export function pickHeroJourney(intelligence, findings, diagnosis) {
  const humanContact = String(intelligence.human_contact || '').trim();
  if (humanContact === 'none') return 'complete_miss';
  if (humanContact === 'automated_only') return 'automated_ack_only';

  if (!findings || findings.length === 0) {
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

function contentOf(comm) {
  return [comm.subject, comm.body_text, comm.transcript, comm.raw_content]
    .filter(Boolean)
    .join('\n');
}

function quoteIsGenuine(quote, comm) {
  if (!quote || !comm) return false;
  const haystack = normalize(contentOf(comm));
  const needle = normalize(quote);
  return needle.length > 0 && haystack.includes(needle);
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
      'primary_narrative', 'narrative_finding_indexes', 'supporting_findings', 'evidence_quotes',
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
        description: 'INTERNAL, written FIRST, before any other field. Answer these five questions in order, in one short numbered list: (1) What did the agency genuinely do well? Name the specific evidence for it — even a weak interaction has something factual: they replied, they acknowledged the enquiry, they called, they asked a question, they followed up, they used my name or the property correctly. (2) What is the strongest primary missed opportunity? (3) BECAUSE that happened, what did the agency fail to establish, progress, capture, qualify, convert or uncover? This is the "so what?" and it must move the story forward, not restate (2). (4) Is there a genuinely SEPARATE wider opportunity in this enquiry — most often a seller/valuation opportunity, or a separate progression opportunity — or is there not? Say "none" if there is not. (5) If there is one, what did missing it mean commercially? Only after answering these do you write the email fields.',
      },
      primary_narrative: {
        type: 'string',
        description: 'INTERNAL ONLY — our own working note, for the breakdown and the demo. IT IS NOT AN EMAIL FIELD AND IT IS NOT A SUBSTITUTE FOR THE STRUCTURED FIELDS. No prospect ever reads it, so a point that exists only here is a point the email does not make: whatever you write here, the finding and its consequence must ALSO be written into main_finding and commercial_consequence, in their own words. The single strongest commercially consequential story this enquiry tells, in two to four sentences. Most enquiries contain more than one useful finding, so COMBINING several findings into one broader story is the normal answer, not the exception — do not simply narrate finding #1. Do not describe the problems: say what the agency failed to find out, progress, convert or uncover because of them. If there are no findings at all, this is the story of handling that genuinely worked and what it would take to guarantee it every time.',
      },
      narrative_finding_indexes: {
        type: 'array',
        description: 'INTERNAL. The finding numbers (as shown in the FINDINGS list) that combine into primary_narrative — usually several, one only if the story really is a single finding. Empty array only when there are no findings at all.',
        items: { type: 'integer' },
      },
      supporting_findings: {
        type: 'string',
        description: 'INTERNAL. The genuine findings NOT already inside primary_narrative, stated plainly in one or two sentences. Empty string when the narrative already covers every finding, or when there are no findings. Never pad this.',
      },
      evidence_quotes: {
        type: 'array',
        description: 'INTERNAL. Verbatim quotes from the RAW COMMUNICATIONS shown (copied exactly, never paraphrased) that the narrative and the email rest on. A quote that is not a literal match to its source is discarded. Empty array is correct when nothing was ever said — for example when there was no reply at all.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['quote', 'communication_id'],
          properties: {
            quote: { type: 'string' },
            communication_id: { type: 'string' },
          },
        },
      },
      fair_observation: {
        type: 'string',
        description: 'EMAIL COPY, read by the prospect. MANDATORY whenever there was any human response or contact at all — there is no case where this is optional, and an email without it is not sent. CONTINUATION ONLY: the email hard-codes "I want to say upfront that " immediately before this text, so write only what follows it, starting lower-case. Examples of the exact register: "you did get back to me, with an email asking what I was looking for."; "you did get back to me within the same day and acknowledged the enquiry."; "you did follow up with me and tried to get me on the phone." Even a weak interaction has something factual that can be acknowledged: they replied, they acknowledged the enquiry, they called, they asked a question, they followed up, they referenced my name or the property correctly. Pick the strongest one the communications actually evidence, and STOP THERE — one or two sentences. This paragraph establishes fairness; it is not half the email. It must be GENUINELY SUPPORTED by the communications — never invent praise. It must be entirely positive: never slip criticism in with eventually, although, despite, however, finally, at least or any similar word that turns the compliment into a complaint, and never hint at what comes next. Write it TO them ("you") and describe our side as "I"/"me"/"we"; never detached third person such as "They did not let this one go cold."',
      },
      main_finding: {
        type: 'string',
        description: 'EMAIL COPY, read by the prospect. The PRIMARY thing the agency failed to do. CONTINUATION ONLY: the email hard-codes "What stood out, though, was " immediately before this text, so write only what follows it, starting lower-case — e.g. "that the conversation never really established my position or timescale", or "that I had told you I was considering selling my own property, but the conversation stayed entirely around the purchase." It must be ONE COHERENT FINDING even where it combines several related findings into one thing that happened. It must NOT contain its commercial consequence and must NOT explain what the failure cost — that is the next paragraph\'s job, and saying it here leaves that paragraph with nothing to add. Specific, grounded in what actually happened in this enquiry, understandable without seeing any underlying analysis, written from the perspective of the person who sent it, and about BEHAVIOUR rather than an abstract business judgement. "Your qualification process was weak" is wrong. NEVER a label like "Poor follow-up", "Weak qualification" or "Response gap". Address them as "you" and our side as "I"/"me"/"we".',
      },
      commercial_consequence: {
        type: 'string',
        description: 'EMAIL COPY, read by the prospect. MANDATORY for every sendable email in both variants, and NEVER LEFT BLANK — an answer without it is rejected and sent back to you, not stored. THE MOST IMPORTANT FIELD IN THE EMAIL. If you have written the consequence into primary_narrative or story_reasoning, you have not written it into the email: distil it into THIS field, in a sentence the agency can read. The email hard-codes "That meant " immediately before this text, so return ONLY the grammatically correct continuation, starting lower-case. It must answer the actual "so what?": what opportunity the agency failed to CAPTURE, PROGRESS, QUALIFY, CONVERT or UNCOVER because of the main finding. It must MOVE THE STORY FORWARD rather than repeat the finding, and it must NOT restate main_finding in different words. If the main finding is that the enquiry was never qualified, this says what that meant commercially — that nobody established whether I was a serious buyer, whether I was ready to move, whether I was finance-ready, or what the next step was, depending on what the evidence actually supports. Where a confirmed property price is given, consider using it to make the scale obvious — "you had a £225,000 buyer enquiry in front of you without establishing whether I was ready to move, what I needed from the property, or what should happen next" — but never in every email, never more than once, and never turned into what it cost them. Weak: "the response was generic." Strong: "you had a live buyer enquiry in front of you, but the conversation never really established where I was in the process — or what else the enquiry could lead to." Never invent lost revenue, never state a fee, a commission or a percentage, never claim a sale or an instruction was definitely lost, and never write vague filler like "there was a missed opportunity". One or two sentences — say what it meant and stop.',
      },
      wider_observation: {
        type: 'string',
        description: 'EMAIL COPY, read by the prospect. OPTIONAL — a genuinely SEPARATE observation, most commonly a seller-side opportunity or a separate progression opportunity, never the main finding again. A COMPLETE STANDALONE SENTENCE (capital letter, full stop), because no fixed wording runs in front of it, and ONE sentence only: "I\'d also said in the enquiry that I had a property of my own to sell that wasn\'t yet on the market." Return an EMPTY STRING unless there genuinely was such a thing; never invent one to fill the field.',
      },
      wider_consequence: {
        type: 'string',
        description: 'EMAIL COPY, read by the prospect. OPTIONAL, and ONLY where wider_observation exists — with no observation in front of it, this is the consequence of something the reader was never told, and it is discarded. The email hard-codes "That also meant " immediately before this text, so return ONLY the continuation, starting lower-case, e.g. "a potential seller instruction sitting inside the same enquiry was never explored." — one sentence, and never a claim that it would definitely have become an instruction. It must explain the COMMERCIAL CONSEQUENCE of the wider observation and must NOT repeat the observation, and it must be genuinely distinct from commercial_consequence rather than the same point reworded. If the wider observation has no genuine separate consequence, leave this empty; never force one.',
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

REASON ABOUT THE STORY BEFORE YOU FILL ANY VARIABLE. This is the most important rule here. In story_reasoning, first answer, in order:
  1. What did the agency genuinely do well?
  2. What is the strongest primary missed opportunity?
  3. Because that happened, what did the agency fail to establish, progress, capture, qualify, convert or uncover?
  4. Is there a genuinely SEPARATE wider opportunity in this enquiry?
  5. If so, what did missing that mean commercially?
Only then write the email fields. A model that writes the fields first produces finding -> finding -> a blank or empty consequence, which is exactly what this layer exists to prevent.

PRIMARY_NARRATIVE AND STORY_REASONING ARE INTERNAL. They are working notes for us. No agency ever reads either of them. The ONLY sentences the agency reads are fair_observation, main_finding, commercial_consequence, wider_observation and wider_consequence — so a point that exists only in your narrative is a point the email never makes, and a consequence you explain beautifully in primary_narrative while leaving commercial_consequence blank is a consequence the agency never sees. That answer is rejected and handed back to you; it is not stored.

DERIVE THE STRUCTURED FIELDS FROM YOUR REASONING. Once you have reasoned the story out, map it across, one to one:
  main_finding          = what happened / what was missed
  commercial_consequence = what that meant commercially
  wider_observation     = the separate second opportunity, if there is one
  wider_consequence     = what that second opportunity meant
Every one of those sentences must appear in its own field, written as email copy. Writing it once in the narrative does not count.

Never allow: finding -> finding -> blank consequence.
Never allow: a consequence that merely repeats the finding in other words.
Never allow: a fair observation that is disguised criticism.
Never allow: a seller observation repeated back as its own consequence.

THE EMAIL STRUCTURE IS LOCKED AND YOU DO NOT WRITE IT. The assembler owns every fixed word, the paragraph order, the closing transition and the call to action. You write ONLY the content of the variables below. There are exactly two variants.

VARIANT 1 — NO RESPONSE (used only when there was no human contact at all):
  We never received a reply.
  That meant {commercial_consequence}
  {wider_observation}                (only if applicable)
  That also meant {wider_consequence} (only if wider_observation exists)
  ...then the locked closing lines.
There was no conversation, so fair_observation and main_finding are IGNORED — do not invent replies, and do not describe a conversation that never happened. The failure IS the silence. Put your effort into commercial_consequence: what the silence meant the agency never got the chance to find out, progress or convert.

VARIANT 2 — EVERY OTHER CASE (any human response or contact at all):
  I want to say upfront that {fair_observation}
  What stood out, though, was {main_finding}
  That meant {commercial_consequence}
  {wider_observation}                (only if there is a genuinely separate one)
  That also meant {wider_consequence} (only if wider_observation exists and has a genuine consequence)
  ...then the locked closing lines.
fair_observation, main_finding and commercial_consequence are ALL MANDATORY here. There is no case where the fair observation is optional: if a human made any contact at all, something factual can be acknowledged — they replied, they acknowledged the enquiry, they called, they asked a question, they followed up, they used my name or the property correctly. Find the one the communications genuinely evidence. Do NOT invent praise. An email missing any of these three is not sent at all.

THE VARIABLE CONTRACT
- fair_observation: a genuine positive/fair acknowledgement, based on actual communication evidence. It can be very small. It must NEVER contain criticism and must never be hedged with eventually, although, despite, however, finally, at least or anything similar that turns the compliment into a complaint.
- main_finding: the primary thing the agency failed to do. ONE coherent finding, even when it combines several related findings. It must NOT contain its commercial consequence and must NOT explain what the failure cost — that is the very next paragraph, and taking its job here leaves it with nothing to say.
- commercial_consequence: the actual "so what?". What opportunity the agency failed to capture, progress, qualify, convert or uncover because of the main finding. It must MOVE THE STORY FORWARD, never restate the finding in different words. If the finding is that the enquiry was never qualified, this says what that meant: nobody established whether I was serious, whether I was ready to move, whether I was finance-ready, what the next step was — whichever the evidence actually supports. Never invent lost revenue and never claim an instruction or a sale was definitely lost.
- wider_observation: optional, a genuinely SEPARATE observation — most commonly a seller-side opportunity or a separate progression opportunity. A complete standalone sentence, because nothing fixed runs in front of it.
- wider_consequence: only where wider_observation exists. The commercial consequence OF that observation, never the observation again.
- You never write the closing transition or the call to action. Those two paragraphs are locked copy in the email itself and appear every time, whether or not anything else was found. Do not hint at them, do not write your own version, and do not treat "a couple of other things" as a promise you must fill.

Hard rules:
1. MOST ENQUIRIES CONTAIN MORE THAN ONE USEFUL FINDING. Combining several findings into ONE coherent story is the normal answer here, not the exception. Look across the COMPLETE set — a slow response, generic or template replies, no follow-up, follow-ups that just ask us to get back to them, weak qualification, no real progression towards a viewing, the seller side never explored, a valuation or instruction never identified — and ask which COMBINATION tells the strongest, fairest and most commercially meaningful story. It must read as one story, not a list. Name the finding numbers you combined.
2. Never state a finding, a fact, or an outcome the probe cannot establish. This enquiry is one observed interaction. It shows what happened to THIS enquiry. It does not prove what happens to every enquiry, and it does not prove a lost sale. Say what it shows, and stop.
3. Be fair, and mean it. Never invent praise the communications do not support, and equally never manufacture a weakness: if the findings list is empty, the story is that the handling worked and the question is whether it happens every time.
4. Quote the agency's actual words from the RAW COMMUNICATIONS. Every quote must be copied verbatim with its communication_id; anything that is not a literal match is discarded.
5. MONEY: LET THE PROPERTY VALUE SPEAK, AND NEVER DO THE ARITHMETIC FOR THEM. Where a confirmed property price is given, consider using it to make the scale of the opportunity obvious — most often inside commercial_consequence: "you had a £225,000 buyer enquiry in front of you without establishing whether I was ready to move", or "a potential £650,000 seller instruction sitting inside the same enquiry was never explored". The agency works out what that is worth to them; you never tell them. So NEVER state or imply what this cost THEM: no fee, no commission, no percentage, no annual cost, no "this could have cost you £X", no "you may have lost £X". Never state any monetary figure other than the property price you are given, and if you are handed a scale fact, cite it exactly as written and draw no arithmetic from it. Do not force the price into every email — use it only where it materially strengthens the point, and never more than once.
6. THE SELLER SIDE. Actively consider it. If our enquiry said we also had a property of our own we were thinking of selling, then this enquiry was not just a potential buyer — there was a potential valuation and instruction sitting inside it — and that is very often the sharpest part of the commercial story. Keep it to two short sentences, in the wider beat, in this shape: "I'd also said in the enquiry that I had a property of my own to sell that wasn't yet on the market." then "a potential seller instruction sitting inside the same enquiry was never explored." Never claim it would definitely have become an instruction. And only ever when the enquiry actually said so — never force seller language into an enquiry that did not contain it.

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

function contentBlock(c, i) {
  const content = contentOf(c) || '(no content)';
  return `--- Message ${i + 1} | communication_id: ${c.communication_id} | channel: ${c.channel || 'unknown'} | occurred_at: ${c.occurred_at} ---\n${content}`;
}

function buildPrompt(probe, intelligence, diagnosis, findings, communications, scaleFact) {
  const ordered = communications
    .map((c) => ({ ...c, _at: new Date(c.occurred_at) }))
    .filter((c) => !Number.isNaN(c._at.getTime()))
    .sort((a, b) => a._at - b._at);

  const price = String(probe?.property_price || '').trim();

  return [
    '=== THE ENQUIRY (probe facts — these are the facts the email opens with) ===',
    `Property address: ${isUnknownAddress(probe?.property_address) ? 'not established from the replies' : probe.property_address}`,
    `Property value: ${price || 'not on file — you may not state ANY monetary figure at all'}`,
    `Enquiry sent: ${probe?.probe_timestamp || 'unknown'} (${formatEnquiryDate(probe?.probe_timestamp) || 'date unknown'})`,
    `What the enquiry said: ${probe?.enquiry_text || '(none)'}`,
    '',
    '=== INTELLIGENCE (settled interpretation — do not re-derive) ===',
    `Grade (reference only): ${intelligence.grade || 'unknown'} — ${intelligence.grade_reason || ''}`,
    `Response: ${intelligence.human_contact || 'unknown'}, ${intelligence.response_hours !== '' && intelligence.response_hours != null ? `${intelligence.response_hours} hours to first human contact` : 'no human contact'}`,
    `Contact attempts: ${intelligence.contact_attempts ?? 0}, follow-ups after the first: ${intelligence.follow_ups ?? 0}, channels: ${intelligence.channels_used || 'none'}`,
    `Viewing progression: ${intelligence.viewing_progression || 'none'}; buyer qualification: ${intelligence.buyer_qualification || 'none'} (${intelligence.buyer_questions_asked || 'no questions recorded'})`,
    `Seller/vendor recognition: ${intelligence.seller_recognition === '' ? 'n/a — no property declared for sale' : (intelligence.seller_recognition || 'none')}`,
    `Communication quality: ${intelligence.communication_quality || 'unknown'}`,
    `What they did well: ${intelligence.did_well || '(nothing recorded)'}`,
    `What they missed: ${intelligence.missed || '(nothing recorded)'}`,
    '',
    '=== DIAGNOSIS FINDINGS (every genuine, independently evidence-backed finding — this is the complete set; decide which of these combine into the story) ===',
    formatFindingsForPrompt(findings),
    '',
    '=== DIAGNOSIS (the rest of the settled commercial conclusion — do not re-derive) ===',
    `Strengths: ${diagnosis.strengths || '(none recorded)'}`,
    `Missed opportunities: ${diagnosis.missed_opportunities || '(none — both taken)'}`,
    `Commercial implication: ${diagnosis.commercial_implication || '(none)'}`,
    `NOVUS opportunity: ${diagnosis.novus_opportunity || 'None evidenced'}`,
    `Diagnosis summary: ${diagnosis.diagnosis_summary || ''}`,
    '',
    scaleFact
      ? `=== SCALE FACT (the only number about this agency you may cite; draw no arithmetic from it) ===\n${scaleFact}`
      : '=== SCALE FACT ===\n(none available — any wider point must stay qualitative, with no numbers)',
    '',
    '=== RAW COMMUNICATIONS (quote from here, verbatim) ===',
    ordered.length > 0 ? ordered.map(contentBlock).join('\n\n') : '(No communications were ever received for this probe — the enquiry was never replied to.)',
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
const MODEL_FIXABLE_VIOLATIONS = new Set([
  'missing_fair_observation',
  'missing_main_finding',
  'missing_commercial_consequence',
]);

// What the repair pass is told about each way a mandatory field went missing.
// Deliberately specific: "commercial_consequence was blank" and
// "commercial_consequence was your main_finding again" need opposite fixes,
// and a model asked simply to "try again" will reproduce the same output.
const REPAIR_NOTES = {
  fair_observation: {
    blank: 'fair_observation came back EMPTY. There was human contact on this enquiry, so this field is mandatory and something factual can always be acknowledged — they replied, they acknowledged the enquiry, they called, they asked a question, they followed up, they used the name or the property correctly. Read the communications again and name the strongest one that is genuinely there.',
    hedged_criticism: 'fair_observation was rejected because it hedged the compliment (eventually / although / despite / however / finally / at least / albeit). Paragraph 1 is entirely positive or it is not sent. Write the same acknowledgement with the criticism removed completely — the criticism belongs in main_finding, which is the next paragraph.',
    detached_third_person: 'fair_observation was rejected because it was written ABOUT the agency in the third person ("they", "the team"). You are the person who sent the enquiry, writing to them: say "you".',
  },
  main_finding: {
    blank: 'main_finding came back EMPTY. Name the primary thing the agency failed to do, as one coherent finding, without its commercial consequence.',
  },
  commercial_consequence: {
    blank: 'commercial_consequence came back EMPTY. This is the single most important sentence in the email and it is mandatory. You have already reasoned the consequence out above — distil it into this field. Do NOT leave the consequence sitting only inside primary_narrative or story_reasoning: those are internal notes that no prospect ever reads, so a consequence written only there is a consequence the agency never sees.',
    restates_main_finding: 'commercial_consequence was rejected because it restated main_finding in different words. It must MOVE THE STORY FORWARD: because that finding happened, what did the agency fail to establish, progress, capture, qualify, convert or uncover? Answer that question instead of describing the failure again.',
  },
};

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
    `Your primary_narrative was: ${String(previousResult?.primary_narrative || '(none)').trim()}`,
    `Your fair_observation was: ${String(previousResult?.fair_observation || '(empty)').trim()}`,
    `Your main_finding was: ${String(previousResult?.main_finding || '(empty)').trim()}`,
    `Your commercial_consequence was: ${String(previousResult?.commercial_consequence || '(empty)').trim()}`,
    '',
    'WHAT TO FIX:',
    notes,
    '',
    'REMEMBER: primary_narrative and story_reasoning are INTERNAL. They are never shown to the agency. Every sentence the agency actually reads comes from fair_observation, main_finding, commercial_consequence, wider_observation and wider_consequence, so a point that exists only in your narrative is a point the email does not make. Derive the structured fields FROM your reasoning: main_finding = what happened / what was missed; commercial_consequence = what that meant commercially; wider_observation = the separate second opportunity, if there is one; wider_consequence = what that second opportunity meant.',
  ].join('\n');
}

// ── Entry point ──────────────────────────────────────────────────────────────
//
// probe: PROBES row. intelligence: the finalised INTELLIGENCE row. diagnosis:
// the DIAGNOSIS row for the same probe. findings: that probe's
// DIAGNOSIS_FINDINGS list (see lib/diagnosis-findings.mjs), already ordered
// by finding_index. communications: this probe's COMMUNICATIONS rows. agency:
// AGENCIES row, for the scale fact only.
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
export async function personaliseProbe(probe, intelligence, diagnosis, findings, communications, agency) {
  const ctx = {
    probe,
    intelligence,
    diagnosis,
    byId: new Map(communications.map((c) => [c.communication_id, c])),
    orderedFindings: Array.isArray(findings) ? findings : [],
    allowedFigure: probe?.property_price || null,
    // Words this probe's own address/agency established as proper nouns —
    // never forced to lower case when they open a continuation. See
    // extractProtectedWords() for why this can't be a global dictionary:
    // "Fox" is a name here and an ordinary word on someone else's probe.
    protectedWords: extractProtectedWords(probe, agency),
  };

  const basePrompt = buildPrompt(probe, intelligence, diagnosis, ctx.orderedFindings, communications, computeScaleFact(agency));

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

    // Otherwise keep the closest attempt so far. Ties go to the earlier one:
    // attempt 1 is the model's own unprompted judgement, and a repair pass
    // that fixed one field while losing another is not an improvement.
    if (!best || candidate.rejections.length < best.rejections.length) best = candidate;
    previous = candidate;
  }

  // Nothing satisfied the contract. The row is still stored with its full
  // internal story — a human now has a probe to look at, with a blank
  // email_body saying so, rather than an email with a hole in it.
  return { ...best.row, ai_calls_used: MAX_PERSONALISATION_ATTEMPTS };
}

// One model answer -> the stored row, plus the mandatory fields that did not
// survive and why. Pure: no AI call, so the retry loop above is the only place
// that decides whether to ask again.
function buildCandidate(result, ctx) {
  const { probe, intelligence, diagnosis, byId, orderedFindings, allowedFigure, protectedWords } = ctx;
  const clean = (value) => stripUnbackedCurrency(String(value || '').trim(), allowedFigure);

  // Quotes: literal-substring gate, exactly as elsewhere in the pipeline.
  const evidence = (result.evidence_quotes || [])
    .filter((q) => q && quoteIsGenuine(q.quote, byId.get(q.communication_id)))
    .map((q) => {
      const comm = byId.get(q.communication_id);
      return `"${q.quote.trim()}" (${comm.channel || 'unknown channel'}, ${comm.occurred_at})`;
    });

  // Only finding numbers that actually exist can be claimed as part of the
  // narrative — a hallucinated index would otherwise make the audit trail lie
  // about which findings the story rests on.
  const validIndexes = new Set(orderedFindings.map((f, i) => f.finding_index || i + 1));
  const narrativeIndexes = [...new Set((result.narrative_finding_indexes || [])
    .map((n) => Number(n))
    .filter((n) => validIndexes.has(n)))].sort((a, b) => a - b);

  // If every genuine finding is already inside the narrative there is nothing
  // left to be a separate second thing, so the INTERNAL supporting_findings is
  // forced empty rather than padded. This no longer gates the email's closing
  // transition: that line is locked copy that appears every time, because it
  // is the hand-off into the breakdown rather than a claim about how many
  // other findings exist (see lib/email-assembly.mjs).
  const hasUncoveredFindings = orderedFindings
    .some((f, i) => !narrativeIndexes.includes(f.finding_index || i + 1));
  const supportingFindings = hasUncoveredFindings ? clean(result.supporting_findings) : '';

  // ── EMAIL COPY ────────────────────────────────────────────────────────────
  // Everything below is read by a real person, so each value goes through
  // emailVariable(): the currency allow-list, then the internal-reasoning
  // backstop. lib/email-assembly.mjs then puts these sentences in order — it
  // never rewrites one.
  //
  // Each mandatory field that does not survive is RECORDED with the reason it
  // did not, so the repair pass can be told what actually went wrong instead
  // of being asked the same question again.
  const rejections = [];

  // A probe that was never replied to has no conversation to describe, so it
  // gets the assembler's own no-response structure (see its header). The
  // failure IS the silence: there is nothing fair to observe about handling
  // that never happened, and no main finding to narrate, so both are forced
  // empty here rather than left to the model to invent — and neither is asked
  // for again, because neither is missing.
  const noHumanContact = String(intelligence.human_contact || '').trim() === 'none';
  const emailVariant = noHumanContact ? 'no_response' : 'normal';

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
    : asContinuation(emailVariable(result.main_finding, allowedFigure), FIXED_PREFIX_PATTERNS.mainFinding, protectedWords);
  if (!noHumanContact && !mainFinding) rejections.push({ field: 'main_finding', reason: 'blank' });

  // The assembler supplies "That meant " — this is only the rest of the
  // sentence, never a repeat of the prefix. MANDATORY in BOTH variants: an
  // email that describes a problem and never says what it cost is the exact
  // failure mode this whole layer exists to prevent.
  const consequenceCandidate = stripThatMeantPrefix(emailVariable(result.commercial_consequence, allowedFigure), protectedWords);

  // ...and it has to be a consequence, not the finding again.
  let commercialConsequence = consequenceCandidate;
  if (!consequenceCandidate) {
    rejections.push({ field: 'commercial_consequence', reason: 'blank' });
  } else if (!consequenceGoesBeyondFinding(consequenceCandidate, mainFinding)) {
    commercialConsequence = '';
    rejections.push({ field: 'commercial_consequence', reason: 'restates_main_finding' });
  }

  // The optional wider beat, and it is a PAIR. The observation is its own
  // sentence; the consequence is a continuation of "That also meant " and
  // survives only when (a) there is an observation for it to be the
  // consequence OF, and (b) it is genuinely a SECOND consequence rather than
  // the first one reworded. An orphan wider_consequence would print as the
  // consequence of something the reader was never told. Neither is ever
  // rejected: the whole beat is optional, so a missing one is an answer.
  const widerObservation = asStandaloneSentence(emailVariable(result.wider_observation, allowedFigure));
  const widerConsequence = widerObservation
    ? distinctWiderConsequence(
      emailVariable(result.wider_consequence, allowedFigure),
      commercialConsequence,
      protectedWords,
    )
    : '';

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
    rejections: rejections.filter(({ field }) => MODEL_FIXABLE_VIOLATIONS.has(`missing_${field}`)),
    row: {
      // ── Internal: the breakdown / demo / our own reasoning. Never part of
      // the email.
      hero_journey: HERO_JOURNEYS.includes(heroJourney) ? heroJourney : 'slow_response_gap',
      primary_narrative: clean(result.primary_narrative),
      narrative_finding_indexes: narrativeIndexes.join(','),
      supporting_findings: supportingFindings,
      evidence: evidence.join('; '),
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
  TOOL, SYSTEM_PROMPT, MAX_PERSONALISATION_ATTEMPTS, MODEL_FIXABLE_VIOLATIONS, REPAIR_NOTES,
  buildCandidate,
  quoteIsGenuine, normalize, contentOf, computeScaleFact, isUnknownAddress, cleanAddressForEmail,
  emailVariable, ensureSentenceEnd, asStandaloneSentence,
  HERO_JOURNEYS, INTERNAL_REASONING_PATTERNS, DETACHED_THIRD_PERSON_PATTERNS,
};
