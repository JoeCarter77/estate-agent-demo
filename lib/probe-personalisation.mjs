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
// invents a finding, or second-guesses novus_opportunity. It adds no AI call
// beyond the single one below. Intelligence and Diagnosis are inputs, treated
// as settled.
//
// THE NO-RESPONSE CASE is genuinely different and is handled as its own
// variant (email_variant = 'no_response') rather than as a normal email with
// empty slots. There was no conversation, so there is nothing fair to observe
// about how it was handled and no main finding to narrate — the failure IS
// the silence. fair_observation and main_finding are forced empty, the
// assembler supplies the fixed "We never received a reply." line, and the
// closing lines are reworded so the offer makes sense when there was nothing
// to discuss. What survives is the commercial consequence, and a wider
// consequence when the enquiry itself explicitly carried one (a seller /
// valuation opportunity we actually declared). Nothing is invented to fill
// the gap: no imagined replies, no imagined conversation.
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
//   - fair_observation: cannot praise handling Diagnosis recorded no
//     strengths for, cannot be written in detached third person, cannot
//     hedge the praise with the words the brief names (eventually, although,
//     despite, however — see readsAsSnuckCriticism()), and is forced empty in
//     the no-response case.
//   - main_finding: forced empty in the no-response case.
//   - commercial_consequence: must go BEYOND main_finding. One that restates
//     it is dropped, which makes the row unsendable rather than sending an
//     email that describes a problem and never says what it cost — see
//     consequenceGoesBeyondFinding() and the central rule below.
//   - supporting_findings / additional_findings_hook: both forced empty when
//     every genuine finding is already inside the primary narrative, so the
//     email's optional tease cannot appear with nothing behind it. The hook
//     is never free text — it is one fixed line (assembler) or blank.
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
      'primary_narrative', 'narrative_finding_indexes', 'supporting_findings', 'evidence_quotes',
      'fair_observation', 'main_finding', 'commercial_consequence',
      'wider_observation', 'wider_consequence',
      'novus_counterfactual',
    ],
    properties: {
      primary_narrative: {
        type: 'string',
        description: 'INTERNAL. The single strongest commercially consequential story this enquiry tells, in two to four sentences. Most enquiries contain more than one useful finding, so COMBINING several findings into one broader story is the normal answer, not the exception — do not simply narrate finding #1. Do not describe the problems: say what the agency failed to find out, progress, convert or uncover because of them. If there are no findings at all, this is the story of handling that genuinely worked and what it would take to guarantee it every time.',
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
        description: 'EMAIL COPY, read by the prospect. CONTINUATION ONLY: the email hard-codes "I want to say upfront that " immediately before this text, so write only what follows it, starting lower-case — e.g. "you followed up properly — three attempts across phone and email inside 14.5 hours, with my name and Fox Cottage referenced correctly and a clear way to get back in touch." Its job is to DISARM: something the agency genuinely did well, drawn strictly from the Diagnosis strengths, supported by the STRONGEST specific evidence available (a real count, a real time, what they actually referenced) — specific, but not a dump of every positive detail. It must be entirely positive and factual: NEVER slip criticism into it with words like eventually, although, despite or however, and never hint at what comes next. Write it TO them ("you") and describe our side as "I"/"me"/"we"; never detached third person such as "They did not let this one go cold." If the Diagnosis records no strengths worth naming, return an EMPTY STRING — never a sentence explaining that there is nothing good to say.',
      },
      main_finding: {
        type: 'string',
        description: 'EMAIL COPY, read by the prospect. CONTINUATION ONLY: the email hard-codes "What stood out, though, was " immediately before this text, so write only what follows it, starting lower-case — e.g. "that the conversation never really established my position or timescale", or, where the evidence allows something sharper, "that I had told you I was considering selling my own property, but the conversation stayed entirely around the purchase." The most important thing that was not handled well: specific, grounded in what actually happened in this enquiry, understandable without seeing any underlying analysis, written from the perspective of the person who sent it, and about BEHAVIOUR rather than an abstract business judgement. "Your qualification process was weak" is wrong. One to three sentences; where several findings are really one story, weave them into this so it reads as one thing that happened, not a list. NEVER a label like "Poor follow-up", "Weak qualification" or "Response gap". Address them as "you" and our side as "I"/"me"/"we".',
      },
      commercial_consequence: {
        type: 'string',
        description: 'EMAIL COPY, read by the prospect. THE MOST IMPORTANT FIELD IN THE EMAIL. The email hard-codes the words "That meant " immediately before this text, so return ONLY the grammatically correct continuation, starting lower-case. It must answer "so what did this actually mean for the agency?" and it must NOT paraphrase the finding. Reason it through: what happened -> what opportunity should have been captured -> what was not captured or progressed -> why that matters. Weak: "the response was generic." Strong: "you had a live buyer enquiry in front of you, but the conversation never really established where I was in the process — or what else the enquiry could lead to." Seller shape: "a buyer enquiry that had already landed with the agency also contained a potential valuation opportunity, but nobody explored it." Progression shape: "the team had already done the work of getting a buyer into a conversation, but the enquiry still had not been converted into a clear next step." Use the property value where it genuinely sharpens the point. Never invent an outcome, never claim a lost sale or a lost fee, never write vague filler like "there was a missed opportunity".',
      },
      wider_observation: {
        type: 'string',
        description: 'EMAIL COPY, read by the prospect. OPTIONAL — a COMPLETE STANDALONE SENTENCE (capital letter, full stop) naming a second thing that was in the enquiry and never came into the conversation, e.g. "I\'d also mentioned that I had a property of my own that I was considering selling, but that never really came into the conversation." Return an EMPTY STRING unless there genuinely was such a thing; never invent one to fill the field. This is the set-up for wider_consequence, so the two go together.',
      },
      wider_consequence: {
        type: 'string',
        description: 'EMAIL COPY, read by the prospect. OPTIONAL — the email hard-codes "That also meant " immediately before this text, so return ONLY the continuation, starting lower-case, e.g. "a potential seller instruction sitting inside the same enquiry was never explored." Return an EMPTY STRING unless there is a genuinely DISTINCT second commercial consequence — one level beyond the primary one, not the same point reworded. If the main consequence tells the whole story, leave this empty; never force one. Where our enquiry explicitly said we also had a property of our own to sell, the seller side is very often the genuine second consequence — but only when the enquiry actually said so.',
      },
      novus_counterfactual: {
        type: 'string',
        description: 'INTERNAL. What NOVUS would have done differently at THIS specific moment — anchored to the actual delay, the actual questions asked or not asked, the actual channel. If the handling was strong, say plainly that NOVUS would have matched it and name what it adds on top. A sentence that would read identically for any other agency is wrong.',
      },
    },
  },
};

const SYSTEM_PROMPT = `You are writing the Personalisation layer for one NOVUS probe: an estate agency was sent a genuine property enquiry, everything that happened next was recorded, and a commercial Diagnosis has already been completed.

Diagnosis has already listed every genuine, evidence-backed finding and why each one matters. Your job is NOT to re-analyse, re-grade, or add findings. Your job is to decide WHAT THE STORY IS, and to write it as copy that can be dropped straight into an email with no editing.

WHAT THE EMAIL IS FOR
The email should make the agency think: "They actually tested us, they were fair about what we did well, but they've found things we genuinely wouldn't have seen ourselves. I want to see the rest."
It is NOT there to lecture them, tell them how to run their agency, make sweeping claims about lost revenue, dump every finding, sound like an AI-generated audit, or sell NOVUS. It should feel like a sharp, evidence-based observation from someone who genuinely went through the enquiry.
The narrative it is built from is: fairness -> specific finding -> "so what?" -> additional opportunity -> curiosity -> low-friction offer.

THE SINGLE RULE AT THE CENTRE OF THIS LAYER
Do not optimise for describing problems. Optimise for revealing missed opportunities.
For every finding, ask: BECAUSE THIS HAPPENED, WHAT DID THE AGENCY FAIL TO FIND OUT, PROGRESS, CONVERT, OR UNCOVER?
That question is what turns this email from an AI-generated critique into something that makes an agency owner think "that's actually a good point." If a field you have written only describes what happened, it is not finished.

Hard rules:
1. MOST ENQUIRIES CONTAIN MORE THAN ONE USEFUL FINDING. Combining several findings into ONE coherent story is the normal answer here, not the exception. Look across the COMPLETE set — a slow response, generic or template replies, no follow-up, follow-ups that just ask us to get back to them, weak qualification, no real progression towards a viewing, the seller side never explored, a valuation or instruction never identified — and ask which COMBINATION tells the strongest, fairest and most commercially meaningful story about what happened to this enquiry. Findings 1 + 2 + 4 woven into one narrative with 3 in support is usually better than narrating finding #1. It must read as one story, not a list of problems. Name the finding numbers you combined.
2. Never state a finding, a fact, or an outcome the probe cannot establish. This enquiry is one observed interaction. It shows what happened to THIS enquiry. It does not prove what happens to every enquiry, and it does not prove a lost sale. Say what it shows, and stop.
3. Be fair, and mean it. Where the agency genuinely did something well, say so plainly and back it with the strongest specific evidence you have. Never invent praise the Diagnosis does not support, and equally never manufacture a weakness: if the findings list is empty, the story is that the handling worked and the question is whether it happens every time.
4. Quote the agency's actual words from the RAW COMMUNICATIONS. Every quote must be copied verbatim with its communication_id; anything that is not a literal match is discarded.
5. Money: you may reference the property value you are given, where it genuinely sharpens the commercial point. You may NEVER state any other monetary figure — no fee, no commission, no percentage, no annual cost, no estimate of what this "costs" in pounds. If you are handed a scale fact, you may cite it exactly as written and draw no further arithmetic from it.
6. THE SELLER SIDE. Actively consider it. If our enquiry said we also had a property of our own we were thinking of selling, then this enquiry was not just a potential buyer — there was a potential valuation and instruction sitting inside it — and that is very often the sharpest part of the commercial story. But only when the enquiry actually said so. Never force seller language into an enquiry that did not contain it.

THE EMAIL FIELDS (fair_observation, main_finding, commercial_consequence, wider_observation, wider_consequence) are different from everything else you produce. They are dropped, verbatim and unedited, into a fixed email that a real estate agent will read. The email supplies the fixed opening words of each paragraph and you supply the rest, so the GRAMMAR CONTRACT is absolute:

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
  - Write ONLY the content of each field. Never write a greeting, a sign-off, a call to action, a link, a transition into the next paragraph, or the offer of the breakdown. The email supplies all of that itself, including the line that teases the other findings — so never hint at them yourself.
  - NEVER expose your own reasoning about the analysis. Sentences like "there is no strength to point to here", "the evidence does not support a fair observation", "no findings were recorded" are notes to ourselves. If a field has nothing genuine to say, return an empty string and say nothing at all.
  - Never refer to the probe, the diagnosis, the findings, the evidence, the analysis, or this system. From the reader's side this is simply one enquiry their team received, and a person who noticed what happened to it.
  - Read every field aloud in your head. If it sounds like a report, rewrite it until it sounds like a person talking.
  - Never turn one enquiry into a claim about the agency as a whole. "This enquiry sat overnight" is honest. "Your enquiries are sitting overnight" is not — you observed one.

IF THERE WAS NO REPLY AT ALL, the email is built from a different, fixed shape: there is no fair observation because there was no interaction to praise, so it simply says "We never received a reply." and goes straight into the consequence. Do not invent additional communication findings, and do not describe a conversation that never happened — the failure IS the silence. In that case fair_observation and main_finding are ignored entirely: put your effort into commercial_consequence (what the silence actually cost — what the agency never got the chance to find out, progress or convert), and into wider_observation/wider_consequence only if our enquiry explicitly carried a seller or valuation opportunity as well.`;

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

// Keep an acronym capitalised, and never lower-case the pronoun "I"; only
// de-capitalise an ordinary opening word that was capitalised purely by
// sentence position.
//
// The length check matters: a bare "A" is all-capitals by every naive test,
// so a continuation opening "A potential seller instruction..." used to
// survive capitalised and print as "That also meant A potential seller
// instruction...". An acronym worth protecting (NOVUS, EPC, RICS) has at
// least two letters; a one-letter capital is the article, not an acronym.
function lowerFirstWord(t) {
  const firstWord = t.split(/\s+/)[0];
  if (/^I(?:['’]|$)/.test(firstWord)) return t;             // I, I'd, I've, I'm
  const letters = firstWord.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 2 && letters === letters.toUpperCase()) return t;
  return `${t.charAt(0).toLowerCase()}${t.slice(1)}`;
}

// One fixed-prefix field -> the continuation the assembler can print after
// the prefix: prefix removed if the model wrote it, lower-cased, terminated.
export function asContinuation(text, prefixPattern) {
  let t = String(text || '').trim();
  if (!t) return '';
  if (prefixPattern) t = t.replace(prefixPattern, '').trim();
  if (!t) return '';
  return ensureSentenceEnd(lowerFirstWord(t));
}

export function stripThatMeantPrefix(text) {
  return asContinuation(text, FIXED_PREFIX_PATTERNS.commercialConsequence);
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
export function distinctWiderConsequence(wider, primaryConsequence) {
  const w = String(wider || '').trim();
  if (!w) return '';
  const continuation = asContinuation(w, FIXED_PREFIX_PATTERNS.widerConsequence);
  if (!continuation) return '';
  const a = comparable(continuation);
  const b = comparable(primaryConsequence);
  if (!b) return continuation;
  if (a === b || a.includes(b) || b.includes(a)) return '';
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

// THE CENTRAL RULE OF THE EMAIL, enforced rather than only prompted for:
// "That meant ..." exists to say what the agency failed to find out,
// progress, convert or uncover. A consequence that is the finding again in
// other words answers nothing — it is the single most common way this email
// turns back into a critique — so it is rejected rather than printed. Strict
// containment only: two sentences that merely share vocabulary are a normal,
// correct pairing (the consequence usually reuses the finding's nouns), and
// only an outright restatement is caught.
export function consequenceGoesBeyondFinding(consequence, mainFinding) {
  const c = comparable(consequence);
  if (!c) return false;
  const f = comparable(mainFinding);
  if (!f) return true;
  return !(c === f || c.includes(f) || f.includes(c));
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
  /\bfindings?\b/i,
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
  const cleaned = stripUnbackedCurrency(String(text || '').trim(), allowedFigure);
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

// ── Entry point ──────────────────────────────────────────────────────────────
//
// probe: PROBES row. intelligence: the finalised INTELLIGENCE row. diagnosis:
// the DIAGNOSIS row for the same probe. findings: that probe's
// DIAGNOSIS_FINDINGS list (see lib/diagnosis-findings.mjs), already ordered
// by finding_index. communications: this probe's COMMUNICATIONS rows. agency:
// AGENCIES row, for the scale fact only.
export async function personaliseProbe(probe, intelligence, diagnosis, findings, communications, agency) {
  const byId = new Map(communications.map((c) => [c.communication_id, c]));
  const scaleFact = computeScaleFact(agency);
  const orderedFindings = Array.isArray(findings) ? findings : [];
  const allowedFigure = probe?.property_price || null;

  const result = await callAi({
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(probe, intelligence, diagnosis, orderedFindings, communications, scaleFact),
    tool: TOOL,
  });

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
  // left to be a separate second thing — both the internal supporting_findings
  // and the email's optional "a couple of other things" hook are forced empty,
  // so that beat of the email can never appear with nothing genuine behind it.
  const hasUncoveredFindings = orderedFindings
    .some((f, i) => !narrativeIndexes.includes(f.finding_index || i + 1));
  const supportingFindings = hasUncoveredFindings ? clean(result.supporting_findings) : '';

  // ── EMAIL COPY ────────────────────────────────────────────────────────────
  // Everything below is read by a real person, so each value goes through
  // emailVariable(): the currency allow-list, then the internal-reasoning
  // backstop. lib/email-assembly.mjs then puts these sentences in order — it
  // never rewrites one.

  // A probe that was never replied to has no conversation to describe, so it
  // gets the assembler's own no-response structure (see its header). The
  // failure IS the silence: there is nothing fair to observe about handling
  // that never happened, and no main finding to narrate, so both are forced
  // empty here rather than left to the model to invent.
  const noHumanContact = String(intelligence.human_contact || '').trim() === 'none';
  const emailVariant = noHumanContact ? 'no_response' : 'normal';

  // Fair observation: only what Diagnosis actually recorded strengths for.
  // Praise the evidence does not support is never printed — and neither is a
  // sentence explaining why there is no praise, nor one written as detached
  // commentary about the agency instead of to them. It is optional copy, so
  // dropping it costs the email a paragraph and nothing else.
  const hasStrengths = Boolean(String(diagnosis.strengths || '').trim());
  // The assembler supplies "I want to say upfront that " — this is only the
  // continuation, lower-cased so the two read as one sentence. Dropped
  // entirely if it hedges the praise with the words the brief names, or if it
  // is written about the agency rather than to them: paragraph 1 is either
  // genuinely fair or it is not printed.
  const fairObservationCandidate = (!noHumanContact && hasStrengths)
    ? asContinuation(emailVariable(result.fair_observation, allowedFigure), FIXED_PREFIX_PATTERNS.fairObservation)
    : '';
  const fairObservation = (readsAsDetachedThirdPerson(fairObservationCandidate)
    || readsAsSnuckCriticism(fairObservationCandidate))
    ? ''
    : fairObservationCandidate;

  // The assembler supplies "What stood out, though, was ".
  const mainFinding = noHumanContact
    ? ''
    : asContinuation(emailVariable(result.main_finding, allowedFigure), FIXED_PREFIX_PATTERNS.mainFinding);

  // The assembler supplies "That meant " — this is only the rest of the
  // sentence, never a repeat of the prefix.
  const consequenceCandidate = stripThatMeantPrefix(emailVariable(result.commercial_consequence, allowedFigure));

  // ...and it has to be a consequence, not the finding again. A restatement is
  // dropped, which makes the row unsendable (see SENDABILITY in
  // lib/email-assembly.mjs) rather than sending an email that describes a
  // problem and never says what it cost.
  const commercialConsequence = consequenceGoesBeyondFinding(consequenceCandidate, mainFinding)
    ? consequenceCandidate
    : '';

  // The optional wider beat: the observation is its own sentence, the
  // consequence is a continuation of the assembler's "That also meant ", and
  // the consequence only survives when it is genuinely a SECOND consequence
  // rather than the first one reworded.
  const widerObservation = asStandaloneSentence(emailVariable(result.wider_observation, allowedFigure));
  const widerConsequence = distinctWiderConsequence(
    emailVariable(result.wider_consequence, allowedFigure),
    commercialConsequence,
  );

  // DET — not asked of the model. A short tease, not another paragraph of
  // analysis: the model was previously trusted to write this sentence itself
  // and would sometimes turn it into a restatement of the finding (or of its
  // own reasoning), which answers the very question the email exists to
  // provoke. It is one fixed line, shown only when a genuine finding sits
  // outside the primary narrative — and never in the no-response structure,
  // whose closing lines already say there were a couple of things.
  const additionalFindingsHook = (!noHumanContact && hasUncoveredFindings)
    ? ADDITIONAL_FINDINGS_HOOK_LINE
    : '';

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

    // ── The assembled email, built deterministically from exactly the fields
    // above. Blank when this row cannot produce a complete, honest email —
    // see SENDABILITY in lib/email-assembly.mjs.
    email_body: assembleEmail(emailCopy),
  };
}

export const _internal = {
  quoteIsGenuine, normalize, contentOf, computeScaleFact, isUnknownAddress, cleanAddressForEmail,
  emailVariable, ensureSentenceEnd, asStandaloneSentence,
  HERO_JOURNEYS, INTERNAL_REASONING_PATTERNS, DETACHED_THIRD_PERSON_PATTERNS,
};
