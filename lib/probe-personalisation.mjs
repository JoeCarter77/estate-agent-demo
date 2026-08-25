// lib/probe-personalisation.mjs — one findings-grounded AI pass that selects
// the strongest story for both the demo and Instantly variables.
//
// The model receives PROBES facts plus structured DIAGNOSIS_FINDINGS only. It
// never receives raw COMMUNICATIONS, INTELLIGENCE prose or DIAGNOSIS prose.
// positive_finding_index + main_finding_index + optional wider_finding_index
// are the single authoritative selection. email_observation and
// email_commercial_hook must both describe that same selection; code rejects
// invalid indexes, ungrounded copy and any hook that introduces an unselected
// diagnosis finding.
//
// Instantly owns the fixed email template. This layer supplies only
// property_reference (deterministic), email_observation and
// email_commercial_hook. The demo-required fair_observation, main_finding and
// commercial_consequence remain AI-generated but are not assembled into an
// email here.

import { callAi } from './ai-client.mjs';
import { ONE_HOUR_MS, SIXTEEN_HOUR_MS } from './grading.mjs';
import {
  formatFindingsForPrompt, isPositiveFinding, isStoryFinding, normaliseFindingType,
} from './diagnosis-findings.mjs';

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

export function hasUnresolvedPlaceholder(value) {
  const candidate = String(value ?? '').trim();
  if (!candidate) return false;
  const bare = candidate.replace(/^[\s<[{(]+|[\s>\]})\-—–.,;:!?]+$/g, '').trim();
  return /<\s*[^<>]+\s*>/.test(candidate)
    || /\{\{\s*[^{}]+\s*\}\}/.test(candidate)
    || /\b(?:UNKNOWN|UNRESOLVED|PLACEHOLDER|TBD|TBC|NULL|N\/?A)\b/i.test(candidate)
    || /^(?:unknown|unresolved|not (?:known|provided|available|established)|none|null|n\/?a|tbd|tbc|missing)$/i.test(bare)
    || /^(?:-|—|–|\.{2,})$/.test(candidate);
}

// PROBES facts -> the Instantly property reference. No model sees or creates
// this value. formatToParts keeps the exact human wording stable across Node
// versions while Europe/London handles both GMT and BST correctly.
export function formatPropertyReference(probe) {
  const address = cleanAddressForEmail(probe?.property_address);
  const d = new Date(probe?.probe_timestamp);
  if (!address || isUnknownAddress(address) || hasUnresolvedPlaceholder(address) || Number.isNaN(d.getTime())) return '';

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const value = (type) => parts.find((part) => part.type === type)?.value || '';
  const day = value('day');
  const month = value('month');
  const hour = value('hour');
  const minute = value('minute');
  if (!day || !month || !hour || !minute) return '';
  return `${address} on ${day} ${month} at ${hour}:${minute}`;
}

// ── The single AI call ───────────────────────────────────────────────────────

const TOOL = {
  name: 'record_probe_personalisation',
  description: 'Select one findings-grounded story and write the demo prose plus the two Instantly variables from that same selection.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'story_reasoning',
      'positive_finding_index', 'main_finding_index', 'wider_finding_index',
      'primary_narrative', 'supporting_findings',
      'fair_observation', 'main_finding', 'commercial_consequence',
      'email_observation', 'email_commercial_hook',
      'novus_counterfactual',
    ],
    properties: {
      story_reasoning: {
        type: 'string',
        description: 'INTERNAL. In one short numbered list, name the strongest genuine positive finding or none, the strongest problem/opportunity, an optional second CONNECTED problem/opportunity, and the shared commercial meaning. Cite every selected finding number before writing any prose.',
      },
      positive_finding_index: {
        type: ['integer', 'null'],
        description: 'The strongest genuine [POSITIVE] finding used in the story. Null when there is no positive or no meaningful human response. Never select a problem/opportunity here and never invent praise.',
      },
      main_finding_index: {
        type: ['integer', 'null'],
        description: 'The strongest [PROBLEM] or [OPPORTUNITY] in the email story. Never a positive. Null only when no problem/opportunity finding exists.',
      },
      wider_finding_index: {
        type: ['integer', 'null'],
        description: 'An optional second [PROBLEM] or [OPPORTUNITY] that connects naturally to main_finding_index in one story. Null when unrelated, repetitive or unnecessary. Never select the same underlying event twice.',
      },
      primary_narrative: {
        type: 'string',
        description: 'INTERNAL demo working note. Summarise the selected story in two to four sentences without adding a finding.',
      },
      supporting_findings: {
        type: 'string',
        description: 'INTERNAL. Unselected genuine problem/opportunity findings, in one or two sentences. Empty when none remain. Never pad.',
      },
      fair_observation: {
        type: 'string',
        description: 'DEMO COPY. One concise factual positive from positive_finding_index, or empty when none/no response. Lower-case continuation retained for the current demo. Never invent praise.',
      },
      main_finding: {
        type: 'string',
        description: 'DEMO COPY. One concise sentence grounded in main_finding_index. Lower-case continuation retained for the current demo.',
      },
      commercial_consequence: {
        type: 'string',
        description: 'DEMO COPY. One concise sentence stating the commercial consequence of main_finding_index. Lower-case continuation retained for the current demo. No invented values or definite-loss claims.',
      },
      email_observation: {
        type: 'string',
        description: 'INSTANTLY VARIABLE. One concise standalone sentence, normally 35–40 words or fewer, written from ALL AND ONLY the selected indexes. Prefer one genuine positive plus one or two connected problems/opportunities. If there was no meaningful human response, omit praise and simply state what happened. No CTA or NOVUS explanation.',
      },
      email_commercial_hook: {
        type: 'string',
        description: 'INSTANTLY VARIABLE. One concise standalone sentence that quantifies or sharpens the commercial meaning of ALL AND ONLY the same selected findings used by email_observation. It must not introduce any unselected problem. No CTA, generic sales language, invented value, fee or definite-loss claim.',
      },
      novus_counterfactual: {
        type: 'string',
        description: 'INTERNAL demo copy. What NOVUS would have done differently at this specific moment, grounded in the selected findings.',
      },
    },
  },
};

const SYSTEM_PROMPT = `Select one email story from the structured DIAGNOSIS_FINDINGS supplied for a real property enquiry.

SOURCE BOUNDARY
- The findings list is the only source for what happened. Do not re-diagnose, infer from raw fields, or add a finding.
- Probe facts may supply the property, time and the enquirer's declared context, but cannot create a new performance finding.

SELECTION
- Choose one genuine [POSITIVE] where one exists, except in the no-response case.
- Choose one main [PROBLEM] or [OPPORTUNITY]. Optionally choose one second problem/opportunity only when it is connected and makes the same story stronger.
- Cite the selected numbers in story_reasoning first. The three index fields are the authoritative selection for every output.

INSTANTLY VARIABLES
- email_observation is one conversational sentence, normally no more than 35–40 words. Use one genuine positive plus one or two connected problems/opportunities where supported. With no meaningful human response, omit praise and say what happened.
- email_commercial_hook is one concise sentence that quantifies or sharpens the meaning of those exact same selected findings. It must not introduce another diagnosis finding.
- Both lines must use ALL AND ONLY the selected story. No CTA, NOVUS explanation, generic sales language, invented money, fee/commission arithmetic, or definite lost-sale/instruction claim.

DEMO FIELDS
- fair_observation, main_finding and commercial_consequence remain for the current demo. Keep them concise and grounded in the relevant selected indexes. Leave fair_observation empty when no genuine positive exists.
- primary_narrative, supporting_findings and novus_counterfactual are internal/demo prose, never substitutes for the two Instantly variables.

VOICE
Write to the agency as "you" and from the enquirer as "I"/"we". Describe this enquiry only. Never mention a probe, diagnosis, findings, evidence, analysis or this system.`;

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
function buildPrompt(probe, findings, noHumanContact, scaleFact) {
  const price = String(probe?.property_price || '').trim();

  return [
    '=== ENQUIRY CONTEXT (not a second findings source) ===',
    `Probe id: ${probe?.probe_id || '(unknown)'}`,
    `Property value: ${price || 'not on file — you may not state ANY monetary figure at all'}`,
    `What the enquiry said: ${probe?.enquiry_text || '(none)'}`,
    '',
    noHumanContact
      ? '=== RESPONSE CASE: NO MEANINGFUL HUMAN RESPONSE ===\npositive_finding_index must be null. Do not invent praise; state the evidenced absence of response and any connected opportunity the findings support.'
      : '=== RESPONSE CASE: HUMAN CONTACT OCCURRED ===\nUse a genuine positive only where a [POSITIVE] finding supports it.',
    '',
    '=== FINDINGS (the complete, settled set — your ONLY source for what happened; select by number) ===',
    formatFindingsForPrompt(findings),
    '',
    scaleFact
      ? `=== SCALE FACT (the only number about this agency you may cite; draw no arithmetic from it) ===\n${scaleFact}`
      : '=== SCALE FACT ===\n(none available — any wider point must stay qualitative, with no numbers)',
  ].join('\n');
}

// ── Prospect-facing copy guards ─────────────────────────────────────────────
//
// Instantly owns the email body. These helpers sanitise the two Instantly
// variables plus the legacy sentence-ready fields that the demo still reads.
// The demo currently joins commercial_consequence after "That meant", so that
// retained field remains a lower-case continuation rather than a full sentence.
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

function asStandaloneSentence(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  return ensureSentenceEnd(`${value.charAt(0).toUpperCase()}${value.slice(1)}`);
}

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

// A probe establishes what the agency did (or did not) progress. It cannot
// establish a future action the prospect might have taken. These are the
// recurring speculative constructions that turn a grounded consequence into
// an invented outcome; reject them so the normal repair pass can rewrite the
// point in terms of what remained unqualified, unbooked or unexplored.
export function readsAsSpeculativeProspectBehaviour(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  return /\b(?:lose|losing|lost)\s+(?:my|our|their|the\s+(?:buyer|prospect)(?:'s)?)?\s*interest\b/i.test(value)
    || /\b(?:go|going)\s+(?:and\s+)?(?:view|see|look at)\b[^.!?]*\b(?:elsewhere|another|other)\b/i.test(value)
    || /\b(?:choose|buy|purchase|instruct)\b[^.!?]*\b(?:elsewhere|another|someone else)\b/i.test(value);
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

// The agency is "you", but it is not the recipient of its own follow-up.
// This deliberately targets the observed inversion and its close variants;
// ordinary second-person copy such as "you sent me alternatives" or "you
// received my enquiry" remains valid.
export function readsAsPerspectiveInversion(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const objects = String.raw`(?:alternative|similar|other)\s+(?:property|properties|listing|listings|home|homes|house|houses|option|options)|(?:property|properties|listing|listings|brochure|brochures|option|options)`;
  return new RegExp(String.raw`\byou\s+(?:were|have been|had been|got)\s+(?:sent|shown|offered|given)\b[^.!?]*\b(?:${objects})\b`, 'i').test(t);
}

// One gate for every prospect-facing string: strip any currency figure that
// isn't this probe's own property value, then drop the whole value if it
// reads as internal reasoning rather than something a person would say.
function emailVariable(text, allowedFigure) {
  // Order matters: strip the figures that were never ours to state, then the
  // sentences that turn the one allowed figure into the agency's loss, then
  // drop the whole value if what is left reads as a note to ourselves.
  const raw = String(text || '').trim();
  if (hasUnresolvedPlaceholder(raw)) return '';
  const cleaned = stripInventedLoss(stripUnbackedCurrency(raw, allowedFigure));
  if (!cleaned) return '';
  return readsAsInternalReasoning(cleaned) ? '' : cleaned;
}

// Only selection/coherence failures justify another model call. The retired
// full-email sendability and consequence-only repair paths are intentionally
// absent: Instantly owns the body, and demo prose never gates an email.
const MAX_PERSONALISATION_ATTEMPTS = 2;

const MODEL_FIXABLE_FIELDS = new Set([
  'positive_finding_index', 'main_finding_index', 'wider_finding_index',
  'email_observation', 'email_commercial_hook',
]);

const REPAIR_NOTES = {
  positive_finding_index: {
    blank: 'Select the genuine [POSITIVE] finding used by the story, or null only when none exists.',
    not_positive: 'positive_finding_index must name a [POSITIVE] finding.',
  },
  main_finding_index: {
    blank: 'Select the strongest [PROBLEM] or [OPPORTUNITY] finding.',
    not_a_story_finding: 'main_finding_index must name a [PROBLEM] or [OPPORTUNITY].',
  },
  wider_finding_index: {
    not_a_story_finding: 'wider_finding_index must name a [PROBLEM] or [OPPORTUNITY], or be null.',
    duplicates_main: 'The optional second finding repeats the main event. Return null or select a genuinely connected, distinct problem/opportunity.',
  },
  email_observation: {
    blank: 'email_observation is required and must be one concise standalone sentence from the selected findings.',
    too_long: 'email_observation is too long. Compress it to no more than 45 words without dropping a selected problem/opportunity.',
    unselected_finding: 'email_observation introduced a diagnosis finding outside the selected indexes. Rewrite it from the selected findings only.',
    fake_positive: 'There was no meaningful human response. Remove praise and state only the supported no-response story.',
  },
  email_commercial_hook: {
    blank: 'email_commercial_hook is required and must sharpen the exact selected story.',
    unselected_finding: 'email_commercial_hook introduced a diagnosis finding outside the selected indexes. Quantify or sharpen only the selected story.',
  },
};

const FINDING_TOKEN_STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'because', 'been', 'before', 'being', 'commercial',
  'could', 'enquiry', 'finding', 'from', 'into', 'never', 'opportunity', 'property',
  'same', 'that', 'their', 'there', 'these', 'they', 'this', 'those', 'through',
  'what', 'when', 'where', 'which', 'while', 'with', 'would', 'your',
]);

function findingTokens(finding) {
  return new Set(String(finding?.finding || '').toLowerCase()
    .replace(/[^a-z0-9£]+/g, ' ').split(/\s+/)
    .filter((token) => token.length >= 5 && !FINDING_TOKEN_STOP_WORDS.has(token)));
}

// Reject copy that names a problem belonging only to an unselected diagnosis
// row. Distinctive vocabulary is compared; generic commercial words are not.
export function introducesUnselectedFinding(text, selectedFindings, allFindings) {
  const copyTokens = new Set(String(text || '').toLowerCase()
    .replace(/[^a-z0-9£]+/g, ' ').split(/\s+/).filter(Boolean));
  const selectedTokens = new Set((selectedFindings || [])
    .flatMap((finding) => [...findingTokens(finding)]));
  return (allFindings || []).some((finding) => {
    if ((selectedFindings || []).includes(finding)) return false;
    const uniqueMatches = [...findingTokens(finding)]
      .filter((token) => !selectedTokens.has(token) && copyTokens.has(token));
    return uniqueMatches.length >= 2 || uniqueMatches.some((token) => token.length >= 9);
  });
}

function wordCount(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean).length;
}

function readsAsFakePositiveWithoutResponse(value) {
  const text = String(value || '').toLowerCase();
  return /\b(?:quick(?:ly)?|prompt(?:ly)?|properly|helpful|well handled|responded|replied|followed up|called me|got back)\b/.test(text)
    && !/\b(?:no|not|never|didn['’]t|without)\b[^.!?]{0,32}\b(?:response|reply|respond|replied|follow(?:ed)? up|call|got back)\b/.test(text);
}

function normaliseEmailSentence(value, allowedFigure) {
  return asStandaloneSentence(emailVariable(value, allowedFigure));
}

export function buildRepairPrompt(previousResult, rejections) {
  const notes = rejections
    .map(({ field, reason }) => `- ${REPAIR_NOTES[field]?.[reason] || `${field} is invalid.`}`)
    .join('\n');
  return [
    '', '=== CORRECTION REQUIRED ===',
    'Return the complete tool result again. Keep the findings-only source boundary and fix only these failures:',
    notes, '',
    `Previous selection: positive=${previousResult?.positive_finding_index ?? 'null'}, main=${previousResult?.main_finding_index ?? 'null'}, second=${previousResult?.wider_finding_index ?? 'null'}`,
    `Previous email_observation: ${String(previousResult?.email_observation || '(empty)').trim()}`,
    `Previous email_commercial_hook: ${String(previousResult?.email_commercial_hook || '(empty)').trim()}`,
    'Both Instantly variables must describe all and only the same selected findings.',
  ].join('\n');
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
// Makes ONE AI call for a valid selection and coherent Instantly variables,
// with at most MAX_PERSONALISATION_ATTEMPTS - 1 bounded correction. It is
// still a single analytical pass: a correction re-asks the same question with
// the selection/coherence gap named; it never re-diagnoses, re-grades or adds
// a finding.
//
// Because a probe can now cost more than one call, the returned row carries
// ai_calls_used: accounting for the caller's AI-call budget, NOT a stored
// column (no PERSONALISATION header holds it, so it never reaches the sheet).
// lib/personalisation-rebuild.mjs bills the budget by that number, so a
// request capped at N AI calls still makes at most N.
export async function personaliseProbe(probe, intelligence, diagnosis, findings, agency) {
  const orderedFindings = Array.isArray(findings) ? findings : [];
  const noHumanContact = String(intelligence?.human_contact || '').trim() === 'none';
  const ctx = {
    probe, intelligence, diagnosis, noHumanContact, orderedFindings,
    allowedFigure: probe?.property_price || null,
    protectedWords: extractProtectedWords(probe, agency),
  };
  const basePrompt = buildPrompt(probe, orderedFindings, noHumanContact, computeScaleFact(agency));

  let previous = null;
  let best = null;
  for (let attempt = 1; attempt <= MAX_PERSONALISATION_ATTEMPTS; attempt += 1) {
    const result = await callAi({
      system: SYSTEM_PROMPT,
      prompt: attempt === 1
        ? basePrompt
        : `${basePrompt}\n${buildRepairPrompt(previous.result, previous.rejections)}`,
      tool: TOOL,
    });
    const candidate = buildCandidate(result, ctx);
    if (candidate.rejections.length === 0) return { ...candidate.row, ai_calls_used: attempt };
    if (isBetterFallback(candidate, best)) best = candidate;
    previous = candidate;
  }
  return { ...best.row, ai_calls_used: MAX_PERSONALISATION_ATTEMPTS };
}

// Prefer fewer selection/coherence failures. On a tie, retain the candidate
// that kept both Instantly variables.
function isBetterFallback(candidate, best) {
  if (!best) return true;
  if (candidate.rejections.length !== best.rejections.length) {
    return candidate.rejections.length < best.rejections.length;
  }
  const score = (value) => Number(Boolean(value.row.email_observation))
    + Number(Boolean(value.row.email_commercial_hook));
  return score(candidate) > score(best);
}

function buildCandidate(result, ctx) {
  const {
    probe, intelligence, diagnosis, noHumanContact,
    orderedFindings, allowedFigure, protectedWords,
  } = ctx;
  const clean = (value) => stripUnbackedCurrency(String(value || '').trim(), allowedFigure);
  const byIndex = new Map(orderedFindings.map((finding, i) => [finding.finding_index || i + 1, finding]));
  const positivesExist = orderedFindings.some(isPositiveFinding);
  const storyFindingsExist = orderedFindings.some(isStoryFinding);
  const rejections = [];
  const resolveIndex = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && byIndex.has(n) ? n : null;
  };

  let positiveIndex = null;
  if (!noHumanContact) {
    positiveIndex = resolveIndex(result.positive_finding_index);
    if (positiveIndex === null && positivesExist) {
      rejections.push({ field: 'positive_finding_index', reason: 'blank' });
    } else if (positiveIndex !== null && !isPositiveFinding(byIndex.get(positiveIndex))) {
      positiveIndex = null;
      rejections.push({ field: 'positive_finding_index', reason: 'not_positive' });
    }
  }

  let mainIndex = resolveIndex(result.main_finding_index);
  if (mainIndex === null && storyFindingsExist) {
    rejections.push({ field: 'main_finding_index', reason: 'blank' });
  } else if (mainIndex !== null && !isStoryFinding(byIndex.get(mainIndex))) {
    mainIndex = null;
    rejections.push({ field: 'main_finding_index', reason: 'not_a_story_finding' });
  }

  let widerIndex = resolveIndex(result.wider_finding_index);
  if (widerIndex !== null) {
    if (!isStoryFinding(byIndex.get(widerIndex))) {
      widerIndex = null;
      rejections.push({ field: 'wider_finding_index', reason: 'not_a_story_finding' });
    } else if (mainIndex !== null
      && (widerIndex === mainIndex || !findingsAreDistinct(byIndex.get(widerIndex), byIndex.get(mainIndex)))) {
      widerIndex = null;
      rejections.push({ field: 'wider_finding_index', reason: 'duplicates_main' });
    }
  }

  const selectedIndexes = [...new Set([positiveIndex, mainIndex, widerIndex]
    .filter((n) => n !== null))].sort((x, y) => x - y);
  const selectedFindings = selectedIndexes.map((n) => byIndex.get(n));
  const evidence = selectedIndexes.map((n) => `Finding ${n}: ${byIndex.get(n).evidence}`).join('; ');
  const hasUncoveredFindings = orderedFindings.some((finding, i) =>
    isStoryFinding(finding) && !selectedIndexes.includes(finding.finding_index || i + 1));
  const supportingFindings = hasUncoveredFindings ? clean(result.supporting_findings) : '';

  const rawFairObservation = String(result.fair_observation || '').trim();
  let fairObservation = positiveIndex === null ? ''
    : asContinuation(emailVariable(rawFairObservation, allowedFigure), FIXED_PREFIX_PATTERNS.fairObservation, protectedWords);
  if (readsAsDetachedThirdPerson(fairObservation)
    || readsAsSnuckCriticism(fairObservation)
    || readsAsPerspectiveInversion(fairObservation)) fairObservation = '';

  let mainFinding = mainIndex === null || noHumanContact ? ''
    : asContinuation(emailVariable(result.main_finding, allowedFigure), FIXED_PREFIX_PATTERNS.mainFinding, protectedWords);
  if (readsAsPerspectiveInversion(mainFinding)) mainFinding = '';

  let commercialConsequence = mainIndex === null ? ''
    : stripThatMeantPrefix(emailVariable(result.commercial_consequence, allowedFigure), protectedWords);
  if (readsAsSpeculativeProspectBehaviour(commercialConsequence)
    || !consequenceGoesBeyondFinding(commercialConsequence, mainFinding)) commercialConsequence = '';

  let emailObservation = normaliseEmailSentence(result.email_observation, allowedFigure);
  if (!emailObservation) {
    rejections.push({ field: 'email_observation', reason: 'blank' });
  } else if (wordCount(emailObservation) > 45) {
    emailObservation = '';
    rejections.push({ field: 'email_observation', reason: 'too_long' });
  } else if (noHumanContact && readsAsFakePositiveWithoutResponse(emailObservation)) {
    emailObservation = '';
    rejections.push({ field: 'email_observation', reason: 'fake_positive' });
  } else if (introducesUnselectedFinding(emailObservation, selectedFindings, orderedFindings)) {
    emailObservation = '';
    rejections.push({ field: 'email_observation', reason: 'unselected_finding' });
  }

  let emailCommercialHook = normaliseEmailSentence(result.email_commercial_hook, allowedFigure);
  if (!emailCommercialHook) {
    rejections.push({ field: 'email_commercial_hook', reason: 'blank' });
  } else if (introducesUnselectedFinding(emailCommercialHook, selectedFindings, orderedFindings)) {
    emailCommercialHook = '';
    rejections.push({ field: 'email_commercial_hook', reason: 'unselected_finding' });
  }

  const heroJourney = pickHeroJourney(intelligence, orderedFindings, diagnosis);
  return {
    result,
    rejections: rejections.filter(({ field }) => MODEL_FIXABLE_FIELDS.has(field)),
    row: {
      hero_journey: HERO_JOURNEYS.includes(heroJourney) ? heroJourney : 'slow_response_gap',
      primary_narrative: clean(result.primary_narrative),
      narrative_finding_indexes: selectedIndexes.join(','),
      positive_finding_index: positiveIndex === null ? '' : positiveIndex,
      main_finding_index: mainIndex === null ? '' : mainIndex,
      wider_finding_index: widerIndex === null ? '' : widerIndex,
      supporting_findings: supportingFindings,
      evidence,
      novus_counterfactual: clean(result.novus_counterfactual),
      fair_observation: fairObservation,
      main_finding: mainFinding,
      commercial_consequence: commercialConsequence,
      property_reference: formatPropertyReference(probe),
      email_observation: emailObservation,
      email_commercial_hook: emailCommercialHook,
    },
  };
}

export const _internal = {
  TOOL, SYSTEM_PROMPT, MAX_PERSONALISATION_ATTEMPTS, MODEL_FIXABLE_FIELDS, REPAIR_NOTES,
  buildCandidate, buildPrompt, normalize, computeScaleFact, isUnknownAddress, cleanAddressForEmail,
  emailVariable, ensureSentenceEnd, asStandaloneSentence, wordCount, findingTokens,
  readsAsFakePositiveWithoutResponse, HERO_JOURNEYS, INTERNAL_REASONING_PATTERNS,
  DETACHED_THIRD_PERSON_PATTERNS,
};
