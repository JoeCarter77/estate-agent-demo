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
// SENTENCE-READY IS THE CONTRACT. Every email field returned here is already
// grammatically complete copy that drops straight into the email. Not labels
// ("Poor follow-up", "Weak qualification" — those are Diagnosis concepts, not
// email copy), not fragments the code has to repair. The ONE deliberate act
// of grammar downstream is the assembler's hard-coded "That meant " in front
// of commercial_consequence, which is why that ONE field is deliberately a
// bare continuation and everything else is a whole sentence.
//
// VOICE. The email is written TO the agency by the person who actually sent
// the enquiry. They are "you"; we are "I"/"we"/"me". Detached third-person
// commentary ("They didn't let this one go cold") is the failure mode — it
// reads as a system describing them behind their back rather than a person
// writing to them. readsAsDetachedThirdPerson() is the code backstop.
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
//     commercial_consequence, wider_consequence, additional_findings_hook,
//     and the assembled email_body.
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
//     strengths for, cannot be written in detached third person, and is
//     forced empty in the no-response case.
//   - main_finding: forced empty in the no-response case.
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
      'fair_observation', 'main_finding', 'commercial_consequence', 'wider_consequence',
      'novus_counterfactual',
    ],
    properties: {
      primary_narrative: {
        type: 'string',
        description: 'INTERNAL. The single strongest commercially consequential story this enquiry tells, in two to four sentences. Most enquiries contain more than one useful finding, so COMBINING several findings into one broader story is the normal answer, not the exception — do not simply narrate finding #1. If there are no findings at all, this is the story of handling that genuinely worked and what it would take to guarantee it every time.',
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
        description: 'EMAIL COPY, read by the prospect. A complete sentence or short paragraph acknowledging something the agency genuinely did well, drawn strictly from the Diagnosis strengths — e.g. "You got back to me quickly and followed up three times across phone and email." Write it TO them ("you") and describe our side as "I"/"me"/"we". NEVER detached third-person commentary such as "They did not let this one go cold." It should disarm, not flatter. If the Diagnosis records no strengths worth naming, return an EMPTY STRING — never a sentence explaining that there is nothing good to say.',
      },
      main_finding: {
        type: 'string',
        description: 'EMAIL COPY, read by the prospect. The actual failure, written as natural, grammatically complete, sentence-ready email copy — e.g. "What stood out, though, was that each follow-up essentially asked me to get back to you, rather than giving me a clear next step." One to three sentences; where several findings are really one story, weave them into this so it reads as one thing that happened, not a list. NEVER a diagnosis label like "Poor follow-up", "Weak qualification" or "Response gap" — those are internal concepts, not email copy. Address them as "you" and our side as "I"/"me"/"we".',
      },
      commercial_consequence: {
        type: 'string',
        description: 'EMAIL COPY, read by the prospect. CRITICAL: the email hard-codes the words "That meant " immediately before this text, so return ONLY the grammatically correct continuation, starting lower-case — e.g. "the £425,000 enquiry was getting attention, but it was not really being progressed." Make it land: explain why the failure actually mattered commercially, in terms of the viewing, the valuation, the seller instruction, progression or conversion, whichever the evidence supports. Use the property value where it genuinely strengthens the point. Never invent an outcome, never claim a lost sale or a lost fee, and never write vague filler like "there was a missed opportunity". Keep it simple and readable.',
      },
      wider_consequence: {
        type: 'string',
        description: 'EMAIL COPY, read by the prospect. OPTIONAL — return an EMPTY STRING unless there is a genuinely DISTINCT second commercial consequence, and never force one. A complete standalone sentence, e.g. "It also meant a potential seller instruction mentioned in the same enquiry was never explored." Do not restate commercial_consequence in other words. If our enquiry explicitly said we also had a property of our own to sell, the seller side is very often the genuine second consequence — but only when the enquiry actually said so.',
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
The email is not selling NOVUS. It is not an audit, a score, or a report. Its ONLY job is to make this agency curious enough to ask to see what we found. It should read like: we sent you an enquiry, here is what happened from our side, here is what that meant commercially, and we found some other interesting things too. When they finish reading it they should think "fair enough, I can see what they mean", and then "what else did they find?".

Hard rules:
1. MOST ENQUIRIES CONTAIN MORE THAN ONE USEFUL FINDING. Combining several findings into ONE coherent story is the normal answer here, not the exception. Look across the COMPLETE set — a slow response, generic or template replies, no follow-up, follow-ups that just ask us to get back to them, weak qualification, no real progression towards a viewing, the seller side never explored, a valuation or instruction never identified — and ask which COMBINATION tells the strongest, fairest and most commercially meaningful story about what happened to this enquiry. Findings 1 + 2 + 4 woven into one narrative with 3 in support is usually better than narrating finding #1. It must read as one story, not a list of problems. Name the finding numbers you combined.
2. Never state a finding, a fact, or an outcome the probe cannot establish. This enquiry is one observed interaction. It shows what happened to THIS enquiry. It does not prove what happens to every enquiry, and it does not prove a lost sale. Say what it shows, and stop.
3. Be fair. Where the agency genuinely did something well, say so plainly — a fair observation disarms, and it is the difference between a note worth reading and a scorecard nobody asked for. Never invent praise the Diagnosis does not support, and equally never manufacture a weakness: if the findings list is empty, the story is that the handling worked and the question is whether it happens every time.
4. Quote the agency's actual words from the RAW COMMUNICATIONS. Every quote must be copied verbatim with its communication_id; anything that is not a literal match is discarded.
5. Money: you may reference the property value you are given, where it genuinely sharpens the commercial point. You may NEVER state any other monetary figure — no fee, no commission, no percentage, no annual cost, no estimate of what this "costs" in pounds. If you are handed a scale fact, you may cite it exactly as written and draw no further arithmetic from it.
6. THE SELLER SIDE. Actively consider it. If our enquiry said we also had a property of our own we were thinking of selling, then this enquiry was not just a potential buyer — there was a potential valuation and instruction sitting inside it — and that is very often the sharpest part of the commercial story. But only when the enquiry actually said so. Never force seller language into an enquiry that did not contain it.

THE EMAIL FIELDS (fair_observation, main_finding, commercial_consequence, wider_consequence) are different from everything else you produce. They are dropped, verbatim and unedited, into a fixed email that a real estate agent will read. So:
  - SENTENCE-READY. Each one must already be grammatically complete, natural copy. The code does not rewrite your sentences. Never return a label or a heading like "Poor follow-up", "Weak qualification" or "Response gap" — those are internal diagnosis concepts, not email copy.
  - THE ONE EXCEPTION IS commercial_consequence. The email hard-codes the words "That meant " immediately before it, so write ONLY the continuation, starting lower-case, so that "That meant " + your text reads as one correct sentence.
  - VOICE. You are the person who actually sent that enquiry, writing to the agency. They are "you". Our side is "I", "me", "we". Never write about them in detached third person — "They didn't let this one go cold" is wrong; "You didn't let this one go cold" is the same observation written by a human to a human.
  - Conversational, commercially sharp, fair. No consultant language, no AI or technical terminology, no generic sales language, no exaggerated claims, no pressure, no jargon, no grading. Do not attack the team. Do not pretend to know anything about the agency beyond this one enquiry.
  - Write ONLY the content of each field. Never write a greeting, a sign-off, a call to action, a link, a transition into the next paragraph, or the offer of the breakdown. The email supplies all of that itself.
  - NEVER expose your own reasoning about the analysis. Sentences like "there is no strength to point to here", "the evidence does not support a fair observation", "no findings were recorded" are notes to ourselves. If a field has nothing genuine to say, return an empty string and say nothing at all.
  - Never refer to the probe, the diagnosis, the findings, the evidence, the analysis, or this system. From the reader's side this is simply one enquiry their team received, and a person who noticed what happened to it.
  - Read every field aloud in your head. If it sounds like a report, rewrite it until it sounds like a person talking.
  - Never turn one enquiry into a claim about the agency as a whole. "This enquiry sat overnight" is honest. "Your enquiries are sitting overnight" is not — you observed one.

IF THERE WAS NO REPLY AT ALL, the email is built from a different, fixed shape and it already says "We never received a reply." for you. Do not invent additional communication findings, and do not describe a conversation that never happened — the failure IS the silence. In that case fair_observation and main_finding are ignored entirely: put your effort into commercial_consequence (what the silence actually cost), and into wider_consequence only if our enquiry explicitly carried a seller or valuation opportunity as well.`;

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
export function stripThatMeantPrefix(text) {
  let t = String(text || '').trim();
  if (!t) return '';
  t = t.replace(/^that\s+mean(?:s|t)\b[\s,:-]*/i, '');
  if (!t) return '';
  // Keep an acronym or a proper noun capitalised; only de-capitalise an
  // ordinary opening word that was capitalised purely by sentence position.
  const firstWord = t.split(/\s+/)[0];
  const isAllCaps = firstWord === firstWord.toUpperCase() && /[A-Z]/.test(firstWord);
  if (!isAllCaps) t = `${t.charAt(0).toLowerCase()}${t.slice(1)}`;
  return ensureSentenceEnd(t);
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
  const a = normalize(w).replace(/[.!?]+$/, '');
  const b = normalize(primaryConsequence || '').replace(/[.!?]+$/, '');
  if (!b) return asStandaloneSentence(w);
  if (a === b || a.includes(b) || b.includes(a)) return '';
  return asStandaloneSentence(w);
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
const INTERNAL_REASONING_PATTERNS = [
  /\b(?:the\s+)?(?:diagnosis|intelligence layer|personalisation|probe|analysis|dataset)\b/i,
  /\bfindings?\b/i,
  /\bevidence\b/i,
  /\bno (?:strength|strengths|positives?|fair observation|genuine)\b/i,
  /\bnothing (?:to point to|positive|genuine|worth)\b/i,
  /\bthere (?:is|are) (?:no|nothing)\b/i,
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
  const fairObservationCandidate = (!noHumanContact && hasStrengths)
    ? emailVariable(result.fair_observation, allowedFigure)
    : '';
  const fairObservation = readsAsDetachedThirdPerson(fairObservationCandidate)
    ? ''
    : ensureSentenceEnd(fairObservationCandidate);

  const mainFinding = noHumanContact
    ? ''
    : ensureSentenceEnd(emailVariable(result.main_finding, allowedFigure));

  // The assembler supplies "That meant " — this is only the rest of the
  // sentence, never a repeat of the prefix.
  const commercialConsequence = stripThatMeantPrefix(emailVariable(result.commercial_consequence, allowedFigure));

  // Optional, and only when it is genuinely a SECOND consequence rather than
  // the first one reworded.
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
