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
import { AiStructuredOutputError } from './ai-structured-output.mjs';
import { ONE_HOUR_MS, SIXTEEN_HOUR_MS } from './grading.mjs';
import {
  formatFindingsForPrompt, isPositiveFinding, isStoryFinding, normaliseFindingType,
} from './diagnosis-findings.mjs';
import { hasVendorDeclaration } from './vendor-intent.mjs';

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
  // '£450,000.00' and '£450,000' are the SAME figure. Stripping every
  // separator alike made the first of those 45000000 — a hundred times the
  // second — so the allow-list stopped recognising the probe's own property
  // value and stripUnbackedCurrency() deleted any sentence that cited it.
  // Every historical probe except prb_hist_0001 carries the trailing '.00'
  // form, which is why so many of them lost the sentence that quantified the
  // opportunity. Thousands separators are dropped; a trailing group of one or
  // two digits after a dot is read as a decimal fraction instead.
  const numeric = match[1].replace(/,/g, '');
  const parts = numeric.split('.');
  const digits = parts.length > 1 && parts[parts.length - 1].length <= 2
    ? `${parts.slice(0, -1).join('')}.${parts[parts.length - 1]}`
    : parts.join('');
  if (!digits || !/\d/.test(digits)) return null;
  const suffix = (match[2] || '').toLowerCase();
  const multiplier = suffix === 'k' || suffix === 'thousand' ? 1000
    : suffix === 'm' || suffix === 'million' ? 1000000
      : suffix === 'bn' ? 1000000000
        : 1;
  const n = Math.round(Number(digits) * multiplier);
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

// ── What this one enquiry actually contained ────────────────────────────────
//
// THE HOOK'S MISSING INPUT. email_commercial_hook exists to make the missed
// outcome obvious — "That's 1 buyer enquiry and 1 potential seller, with
// neither properly progressed." That needs facts to point at, and the prompt
// used to hand the model none: findings prose, a property value and nothing
// else. With nothing concrete to name, the model restated the observation in
// different words.
//
// The wording here matters as much as the numbers. An earlier version of this
// block called them "commercial opportunities", and the hooks came back
// talking like a consultant's deck. An estate agent counts buyer enquiries,
// potential sellers, viewings and valuations — so that is what this block
// counts, and the hook has the agency's own words to reach for.
//
// So the countable facts are computed HERE, in code, from INTELLIGENCE and the
// probe's own declaration — never inferred by the model, never invented, and
// never money. These are process facts the probe genuinely establishes:
// how many commercial opportunities the enquiry contained, how many reached a
// concrete next step, how many contact attempts and follow-ups were made, and
// how fast the first human response was. lib/vendor-intent.mjs owns whether a
// seller opportunity was declared at all, so a buyer-only enquiry correctly
// reports one opportunity rather than two.

const BUYER_PROGRESSED_STATES = new Set(['booked', 'slot_offered', 'availability_requested']);
const SELLER_PROGRESSED_STATES = new Set(['valuation_offered', 'valuation_booked']);

const VIEWING_STATE_LABELS = {
  none: 'never progressed',
  mentioned: 'mentioned, but no next step offered',
  invited: 'invited to arrange a viewing',
  availability_requested: 'availability requested',
  slot_offered: 'a specific slot offered',
  booked: 'booked',
};

const SELLER_STATE_LABELS = {
  none: 'never raised',
  acknowledged: 'acknowledged only',
  asked_position: 'position asked about, never taken further',
  valuation_offered: 'a valuation offered',
  valuation_booked: 'a valuation booked',
};

export function buildOpportunityShape(probe, intelligence) {
  const sellerDeclared = hasVendorDeclaration(probe);
  const viewing = String(intelligence?.viewing_progression || '').trim() || 'none';
  const seller = String(intelligence?.seller_recognition || '').trim() || 'none';
  const attempts = Number.parseInt(intelligence?.contact_attempts, 10);
  const followUps = Number.parseInt(intelligence?.follow_ups, 10);
  const hours = Number.parseFloat(intelligence?.response_hours);
  const noContact = String(intelligence?.human_contact || '').trim() === 'none';

  const sides = sellerDeclared ? 2 : 1;
  const worked = (BUYER_PROGRESSED_STATES.has(viewing) ? 1 : 0)
    + (sellerDeclared && SELLER_PROGRESSED_STATES.has(seller) ? 1 : 0);

  const lines = [
    sellerDeclared
      ? 'Inside this single enquiry: 1 buyer enquiry + 1 potential seller (a property to sell was declared)'
      : 'Inside this single enquiry: 1 buyer enquiry (no property to sell was declared)',
    `Sides taken to a real next step: ${worked} of ${sides}`,
    `Buyer / viewing side: ${VIEWING_STATE_LABELS[viewing] || viewing}`,
  ];
  if (sellerDeclared) lines.push(`Seller / valuation side: ${SELLER_STATE_LABELS[seller] || seller}`);
  lines.push(noContact
    ? 'Contact attempts: 0 (follow-ups: 0) — no reply at all during the four-day observation period'
    : `Contact attempts: ${Number.isFinite(attempts) ? attempts : 'not recorded'}`
      + ` (follow-ups after the first: ${Number.isFinite(followUps) ? followUps : 'not recorded'})`);
  if (!noContact && Number.isFinite(hours)) {
    lines.push(`First reply: ${hours >= 24 ? `${(hours / 24).toFixed(1)} days` : `${hours.toFixed(1)} hours`} after the enquiry`);
  }
  lines.push(`Conversations created: ${noContact ? 0 : worked}`);
  return lines.join('\n');
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
        description: 'INSTANTLY VARIABLE. WHAT HAPPENED. One conversational first-person sentence of 30 words or fewer, from ALL AND ONLY the selected indexes: one genuine positive, one main problem, at most one tightly connected second problem. State the pattern and stop — explaining it, or adding the consequence, is the hook\'s job and makes this line soft. Never a list of every finding. If there was no meaningful reply, state the absence. No CTA or NOVUS explanation, no deck language, never the enquirer in the third person, and never claim questions were asked that the enquiry never put.',
      },
      email_commercial_hook: {
        type: 'string',
        description: 'INSTANTLY VARIABLE. WHAT GOT MISSED. One concise sentence naming what actually failed to progress, from the SAME selected findings email_observation used — e.g. "That\'s 1 buyer enquiry and 1 potential seller, with neither properly progressed." or "So the buyer side moved forward, while the potential seller was missed entirely." Use concrete estate-agency terms (buyer enquiry, potential seller, vendor, viewing, valuation, conversation, next step); quantify only where a number reads naturally. NEVER deck language such as "commercial opportunity", "revenue leakage" or "process failure". Restating the observation in different words is a failure. It must not introduce an unselected problem, invented value, fee or definite-loss claim.',
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
The two lines are one pair, and they have different jobs.
  OBSERVATION = what happened.   HOOK = what actually got missed.
Short. Specific. Concrete. Written by the person who sent the enquiry, to the agency. Never consultant language.

email_observation — one sentence, 30 words or fewer.
- State the strongest factual pattern and stop. Do not explain, do not qualify, do not add the consequence — the hook does that.
- One genuine positive where there is one, one main problem, and at most one tightly connected second problem. Never a list.
- With no meaningful reply, state the absence plus any connected opportunity the findings support.
  LANDS:     "It took nearly 19 hours to get back to the enquiry, and even then nobody picked up that I'd also said I had a property to sell."
  TOO SOFT:  "It took nearly 19 hours to get a call, and the enquiry still wasn't properly progressed beyond that initial contact, while nobody picked up that I also had a property to sell."
             (explains instead of stating, and steals the hook's job)
  LANDS:     "You got back to the enquiry quickly, but nobody picked up that I'd also said I had a property to sell."
  LANDS:     "You handled the viewing side well, but nobody picked up that I'd also said I had a property to sell."
  LANDS:     "We didn't receive any response 4 days after the enquiry, and nobody picked up that I'd also mentioned I had a property to sell."
  LANDS:     "You picked up that I had a property to sell, but that side of the enquiry never progressed beyond the initial acknowledgement."

email_commercial_hook — one sentence answering: "what actually got missed or failed to progress here?"
- Make the missed buyer, seller, viewing, valuation or conversation obvious without the reader translating anything.
- Quantify only where a number reads naturally and the counts above support it. A hook can land with no number at all.
- Never repeat the observation in different words.
  "That's 1 buyer enquiry and 1 potential seller, with neither properly progressed."
  "So 1 enquiry contained both a buyer and a potential vendor, but only one side was ever worked."
  "That's 1 buyer enquiry and 1 potential seller, with neither ever becoming a conversation."
  "So the buyer side moved forward, while the potential seller was missed entirely."
  "So the seller lead was spotted, but it still never became a valuation conversation."

BANNED IN BOTH LINES — this is deck language and it kills the email:
  commercial opportunity / commercial opportunities / commercial value / revenue leakage / lost revenue
  pipeline leakage / process failure / conversion rate / costing you thousands / invisible money
Say buyer enquiry, potential seller, vendor, valuation lead, viewing, conversation, next step instead.
Never invent revenue, fees, conversion rates or annual losses.

STAY LITERAL TO THE EVIDENCE
The enquiry asked for more details about the property. It did NOT put specific questions to the agent, so
"nobody answered my questions" claims something that never happened. Grounded wording: "got back to the enquiry",
"the enquiry wasn't progressed", "I'd also said I had a property to sell", "the viewing side moved forward",
"the seller side was missed".

Both lines must use ALL AND ONLY the selected findings. The hook may not introduce a problem the observation did not tell.

DEMO FIELDS
- fair_observation, main_finding and commercial_consequence remain for the current demo. Keep them concise and grounded in the relevant selected indexes. Leave fair_observation empty when no genuine positive exists.
- primary_narrative, supporting_findings and novus_counterfactual are internal/demo prose, never substitutes for the two Instantly variables.

VOICE
Write to the agency as "you" and from the enquirer as "I"/"me"/"my"/"we". The prospect must read Email 1 as coming directly from the person who sent the enquiry.
- In email_observation and email_commercial_hook NEVER refer to the enquirer in the third person: no "Joe", no "Joe's enquiry", no "the enquirer", no "the buyer", no "the prospect". It is "I" and "my enquiry".
- Naming one of the AGENCY's own people is fine and often good ("Terry's callback was well personalised").
Describe this enquiry only. Never mention a probe, diagnosis, findings, evidence, analysis or this system.`;

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
function buildPrompt(probe, intelligence, findings, noHumanContact, scaleFact) {
  const price = String(probe?.property_price || '').trim();

  return [
    '=== ENQUIRY CONTEXT (not a second findings source) ===',
    `Probe id: ${probe?.probe_id || '(unknown)'}`,
    `Property value: ${price || 'not on file — you may not state ANY monetary figure at all'}`,
    `What the enquiry said: ${probe?.enquiry_text || '(none)'}`,
    '',
    '=== WHAT THIS ONE ENQUIRY CONTAINED (code-computed — the only counts you may cite) ===',
    buildOpportunityShape(probe, intelligence),
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

// CONSULTANT-SPEAK. These are the phrases that make a cold email read as a
// deck rather than as a note from someone who actually enquired. An estate
// agent does not lose "commercial opportunities" — they miss a buyer, a
// vendor, a viewing or a valuation, and they should not have to translate the
// sentence to feel it.
//
// Applied to BOTH Instantly variables. Repairable, never fatal: the point is
// to rewrite the sentence in the agency's own words, not to delete it.
const CONSULTANT_SPEAK = [
  /\bcommercial\s+(?:opportunit(?:y|ies)|value|outcome)\b/i,
  /\brevenue\s+leakage\b/i,
  /\blost\s+revenue\b/i,
  /\bpipeline\s+leakage\b/i,
  /\bprocess\s+(?:failure|breakdown)\b/i,
  /\bcosting\s+you\s+thousands\b/i,
  /\binvisible\s+money\b/i,
  /\bconversion\s+rate\b/i,
];

export function readsAsConsultantSpeak(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return CONSULTANT_SPEAK.some((re) => re.test(t));
}

// The concrete nouns an estate agent already thinks in. A hook earns its line
// by naming one of these outcomes, whether or not it also counts them.
const AGENCY_OUTCOME_NOUNS = String.raw`buyer|buyers|seller|sellers|vendor|vendors|viewing|viewings|valuation|valuations|enquir(?:y|ies)|conversations?|lead|leads|next steps?|appointments?|callbacks?|instructions?`;

const NUMBER_WORD = String.raw`\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|zero|neither|both|half`;

// A count attached to something an agent counts — "1 buyer enquiry and 1
// potential seller", "3 contact attempts", "0 conversations created". "no
// valuation conversation" is deliberately NOT a count: it describes an absence
// rather than counting one, and treating it as quantification let the worst
// hook of the first run through.
export function quantifiesOpportunityShape(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const nouns = String.raw`${AGENCY_OUTCOME_NOUNS}|attempts?|follow[- ]?ups?|contacts?|sides?|days?|hours?|replies|reply|messages?|emails?|calls?`;
  const forward = new RegExp(String.raw`\b(?:${NUMBER_WORD})\b[^.!?]{0,40}?\b(?:${nouns})\b`, 'i');
  const backward = new RegExp(String.raw`\b(?:${nouns})\b[^.!?]{0,24}?\b(?:${NUMBER_WORD})\b`, 'i');
  return forward.test(t) || backward.test(t);
}

// Does the hook name a concrete outcome in the agency's own terms — a buyer, a
// vendor, a viewing, a valuation, a conversation that did or did not happen?
// This is what lets a hook land WITHOUT a number:
//   "So the buyer side moved forward, while the potential seller was missed
//    entirely."
//   "So the seller lead was spotted, but it still never became a valuation
//    conversation."
// Both are exactly the target style, and a strict count requirement would have
// rejected both. Quantify where it is natural; name the outcome always.
export function namesConcreteOutcome(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return new RegExp(String.raw`\b(?:${AGENCY_OUTCOME_NOUNS})\b`, 'i').test(t);
}

// THE CENTRAL RULE OF THE HOOK, enforced rather than only prompted for.
//
// OBSERVATION = what happened. HOOK = what that means. A hook that says the
// same events back in different words has done nothing.
//
// What this function CAN decide, deterministically: that the hook is not a
// lexical restatement of the observation, that it is written in the agency's
// language rather than a consultant's, and that it names or counts a real
// outcome. What it CANNOT decide is whether a well-formed hook genuinely adds
// meaning — "A potential seller went completely unengaged, meaning no
// valuation conversation ever had the chance to start" passes every mechanical
// test here and is still flat. That judgement is carried by the prompt, which
// now shows the model the good and bad pairs side by side. Do not add a
// heuristic here that pretends to make it.
//
// null when the hook does its job; otherwise the rejection reason.
export function hookFailureAgainstObservation(hook, observation) {
  const h = comparable(hook);
  if (!h) return 'blank';
  if (readsAsConsultantSpeak(hook)) return 'consultant_speak';
  const o = comparable(observation);
  if (o && (h === o || h.includes(o) || o.includes(h) || isNearDuplicate(h, o))) {
    return 'restates_observation';
  }
  return (quantifiesOpportunityShape(hook) || namesConcreteOutcome(hook)) ? null : 'no_quantification';
}

// THE PROBE ASKED FOR DETAILS, NOT A LIST OF QUESTIONS. A Rightmove enquiry
// requests more information; it does not put specific questions to the agent.
// So "nobody answered my questions" claims something the evidence does not
// support, however natural it sounds. Grounded alternatives — "got back to the
// enquiry", "the enquiry wasn't progressed" — say the same thing truthfully.
const UNSUPPORTED_QUESTION_CLAIMS = [
  /\b(?:my|the)\s+questions?\b[^.!?]{0,24}\b(?:answer|answered|unanswered|ignored|addressed)\b/i,
  /\b(?:answer|answered|addressed|ignored)\b[^.!?]{0,24}\b(?:my|the)\s+questions?\b/i,
  /\bnobody\s+(?:answered|addressed)\b/i,
  /\bnone\s+of\s+my\s+questions\b/i,
  // "no answers were given to the questions I asked" — the claim is in the
  // relative clause, so the two patterns above walk straight past it.
  /\bquestions?\s+(?:I|we)\s+(?:asked|raised|put)\b/i,
  /\b(?:answers?|repl(?:y|ies))\b[^.!?]{0,30}\bquestions?\s+(?:I|we)\b/i,
];

export function claimsUnaskedQuestions(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return UNSUPPORTED_QUESTION_CLAIMS.some((re) => re.test(t));
}

// EMAIL 1 IS WRITTEN BY THE PERSON WHO SENT THE ENQUIRY. The moment it says
// "Joe's enquiry" or "the enquirer", the prospect is reading a report about
// themselves rather than a note from a real buyer, and the whole conceit
// collapses. Observed verbatim in the historical run: "Your initial email
// correctly personalised Joe's enquiry by name and property..."
//
// Deliberately narrow, and deliberately NOT applied to the demo fields:
// commercial_consequence legitimately says "the buyer has little reason to
// call back" to an agency reading a demo about their own process. This is an
// Email-1-only rule.
//
// Naming an AGENCY person stays valid — "Terry's callback was well
// personalised" is exactly the kind of specific credit the email wants — so
// only a name possessing the ENQUIRY, or a name making the enquirer's own
// declaration, is matched.
// A capitalised word is only a NAME if it is not simply an ordinary word that
// happened to start a sentence. Without this, "The declared property to sell
// was never acknowledged" matched the name-plus-declaration pattern ("The"
// + "declared") and a perfectly good observation was rejected as third
// person. Regression-tested.
const NOT_A_NAME = new Set([
  'the', 'this', 'that', 'these', 'those', 'a', 'an', 'and', 'but', 'so', 'it',
  'we', 'you', 'they', 'he', 'she', 'i', 'your', 'our', 'their', 'his', 'her',
  'my', 'no', 'nothing', 'nobody', 'someone', 'both', 'neither', 'either',
  'there', 'here', 'when', 'while', 'after', 'before', 'yet', 'still', 'also',
]);

const THIRD_PERSON_PROSPECT_PATTERNS = [
  /\b(?:the|this|that|a)\s+(?:enquirer|enquirer's|enquirer’s|prospect|applicant|lead)\b/i,
  // "the buyer" meaning ME is third person and wrong. "the buyer side", "the
  // buyer enquiry", "the buyer lead" name a SIDE OF THE ENQUIRY, which is
  // exactly the vocabulary the target hooks use — "So the buyer side moved
  // forward, while the potential seller was missed entirely." Without this
  // exclusion that hook was rejected and repaired on every probe.
  /\bthe\s+buyer(?:'s|’s)?\b(?!\s+(?:side|enquir|lead|opportunit|thread))/i,
  // <Name>'s enquiry / <Name> declared ... — the capitalised word is checked
  // against NOT_A_NAME before it counts, hence the capture group.
  /\b([A-Z][a-z]+)(?:'s|’s)\s+(?:enquiry|enquiries|message|interest)\b/,
  /\b([A-Z][a-z]+)\s+(?:explicitly\s+|clearly\s+)?(?:declared|flagged|stated that|mentioned that)\b/,
  /\b([A-Z][a-z]+)\s+(?:has|had|wants\s+to\s+sell|said\s+(?:he|she|they))\s+a\s+property\s+to\s+sell\b/,
  // The same slip without a name in it: "no acknowledgement of the property he
  // wants to sell". The enquirer is "I", so a third-person pronoun owning the
  // property to sell, or making the enquiry, is the same failure.
  /\b(?:he|she|they)\s+(?:wants?|needs?|has|had|intends?)\s+to\s+sell\b/i,
  /\bthe\s+property\s+(?:he|she|they)\s+(?:wants?|has|had|needs?|is)\b/i,
  /\b(?:he|she|they)\s+(?:declared|enquired|mentioned|flagged)\b/i,
];

export function readsAsThirdPersonProspect(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return THIRD_PERSON_PROSPECT_PATTERNS.some((re) => {
    const match = t.match(re);
    if (!match) return false;
    return match[1] === undefined || !NOT_A_NAME.has(match[1].toLowerCase());
  });
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

// ── Validation, repair and the persisted row ────────────────────────────────
//
// THE INVARIANT THIS SECTION EXISTS TO HOLD:
//   if the selected findings contain enough grounded evidence to populate a
//   mandatory field, the persisted row contains that field.
//   A blank must have an EVIDENCE reason (no positive finding exists; no
//   problem finding exists; there was no human response), never a formatting
//   one.
//
// The historical run broke that invariant 9 times out of 14 for
// fair_observation alone, because three separate things went wrong together:
//
//   1. fair_observation, main_finding and commercial_consequence were blanked
//      by their guards and NO REJECTION WAS RECORDED — so the correction call
//      was never told, and could not have fixed them if it had been: they were
//      not in MODEL_FIXABLE_FIELDS either. A stylistic guard silently deleted a
//      demo-mandatory field and the row was persisted half-empty.
//   2. Every guard was treated as fatal. "This consequence rewords the
//      finding" and "this praise hedges" are WORDING problems on copy that is
//      TRUE; deleting the field over them makes the demo un-sendable to fix a
//      sentence a human would have shipped.
//   3. The correction call re-asked the entire story, so a single bad sentence
//      cost a whole fresh selection and could come back different everywhere.
//
// So guards now carry a SEVERITY, and repair is SCOPED:
//
//   HARD  — the copy asserts something we cannot stand behind: a finding that
//           was never selected, our own internal reasoning, an unresolved
//           template placeholder, praise on a probe that got no response.
//           Repaired if there is budget; if repair fails the field stays
//           blank, and that blank is a real reason.
//   SOFT  — the copy is true, the wording is off: it restates, it hedges, it
//           runs long, it slips into third person, it does not quantify.
//           Repaired if there is budget; if repair fails, THE SANITISED
//           ORIGINAL IS PERSISTED rather than a blank.
//
// Bounded exactly as before: normally ONE call, never more than two.
const MAX_PERSONALISATION_ATTEMPTS = 2;

// Every field a correction call is allowed to fix. The three demo fields are
// here now — their absence is what let the demo contract rot while the email
// contract passed.
const MODEL_FIXABLE_FIELDS = new Set([
  'positive_finding_index', 'main_finding_index', 'wider_finding_index',
  'fair_observation', 'main_finding', 'commercial_consequence',
  'email_observation', 'email_commercial_hook',
]);

// The index fields. When only prose failed, these are already settled and the
// correction is scoped to the prose alone — see buildScopedRepairTool().
const SELECTION_FIELDS = new Set([
  'positive_finding_index', 'main_finding_index', 'wider_finding_index',
]);

// THE ONE TIER THAT MAY NEVER REACH A SHEET. Copy rejected for one of these
// reasons asserts something we cannot stand behind — praise for a probe that
// got no response at all, or (via emailVariable, which empties the value
// before the gate ever sees it) our own analytical vocabulary or an unresolved
// template placeholder. There is nothing here worth persisting, so a blank is
// the right outcome and the blank has a real reason.
//
// EVERYTHING ELSE IS BANKABLE. The old split treated any non-listed reason as
// fatal, which meant `unselected_finding` — a bag-of-words HEURISTIC about
// scope, not a claim about truth — could delete a grounded sentence twice and
// persist blank. That is what emptied email_observation on prb_hist_0002 and
// prb_hist_0005 in the live run. The copy was true, drawn from this probe's own
// findings; only a token overlap said otherwise.
//
// So the invariant is now structural rather than hoped for: a rejected value is
// repaired once, and if the repair still misses, the sanitised original is
// persisted unless it is ungroundable. Valid selected findings + sufficient
// evidence = a non-blank email_observation, full stop.
const NEVER_PERSIST_REASONS = new Set([
  'blank',            // nothing survived sanitisation — there is no text to keep
  'fake_positive',    // praise on a probe that received no human response
]);

const canPersistAfterRepair = (reason) => !NEVER_PERSIST_REASONS.has(reason);

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
  fair_observation: {
    blank: 'A genuine [POSITIVE] finding was selected, so fair_observation is required: state that one positive factually, in one short clause.',
    snuck_criticism: 'fair_observation withdraws the compliment inside the same sentence ("eventually", "although", "despite", "however", "finally", "at least", "albeit"). Give the credit cleanly and leave the problem to main_finding.',
    detached_third_person: 'fair_observation talks about the agency in the third person ("they", "the team"). Write it to them as "you".',
    perspective_inversion: 'fair_observation has the agency receiving its own follow-up. Write what YOU did and what I received.',
    internal_reasoning: 'fair_observation referred to the machinery behind the email (findings, evidence, diagnosis, analysis) or explained itself. State the positive plainly.',
  },
  main_finding: {
    blank: 'A [PROBLEM]/[OPPORTUNITY] finding was selected, so main_finding is required: state that finding in one concise sentence.',
    perspective_inversion: 'main_finding has the agency receiving its own follow-up. Write what YOU did and what I received.',
    internal_reasoning: 'main_finding referred to the machinery behind the email. State what happened plainly.',
  },
  commercial_consequence: {
    blank: 'A [PROBLEM]/[OPPORTUNITY] finding was selected, so commercial_consequence is required: say what that finding COST commercially.',
    restates_finding: 'commercial_consequence repeats main_finding in other words. Say what the agency failed to find out, progress or capture as a result — not the same event again.',
    speculative: 'commercial_consequence invents what the prospect went on to do (viewed elsewhere, lost interest, instructed someone else). Say instead what remained unqualified, unbooked or unexplored.',
    internal_reasoning: 'commercial_consequence referred to the machinery behind the email. State the commercial cost plainly.',
  },
  email_observation: {
    blank: 'email_observation is required and must be one concise standalone sentence from the selected findings.',
    too_long: 'email_observation is too long, or lists too many things. Keep one positive, one main problem and at most one connected second problem, in 40 words or fewer.',
    unselected_finding: 'email_observation introduced a diagnosis finding outside the selected indexes. Rewrite it from the selected findings only.',
    fake_positive: 'There was no meaningful human response. Remove praise and state only the supported no-response story.',
    third_person_prospect: 'email_observation refers to the enquirer in the third person ("Joe", "Joe\'s enquiry", "the enquirer", "the buyer"). Email 1 is written BY the person who enquired: use "I", "me", "my".',
    unasked_questions: 'The enquiry asked for more details; it did not put specific questions to the agent, so "nobody answered my questions" is not supported. Say what IS supported: "got back to the enquiry", "the enquiry wasn\'t progressed".',
    consultant_speak: 'email_observation uses deck language ("commercial opportunity", "process failure"). Write it the way the enquirer would say it, in plain estate-agency terms.',
  },
  email_commercial_hook: {
    blank: 'email_commercial_hook is required and must sharpen the exact selected story.',
    unselected_finding: 'email_commercial_hook introduced a diagnosis finding outside the selected indexes. Quantify or sharpen only the selected story.',
    restates_observation: 'email_commercial_hook says the observation again in different words. State what it MEANS instead, using the OPPORTUNITY SHAPE counts — e.g. "That is 2 commercial opportunities from 1 enquiry, with neither fully progressed."',
    no_quantification: 'email_commercial_hook does not name what was actually missed. Say it in the agency\'s own terms — the buyer enquiry, the potential seller, the viewing, the valuation, the conversation that never happened — using the counts above where a number reads naturally.',
    consultant_speak: 'email_commercial_hook uses deck language ("commercial opportunity", "revenue leakage", "process failure"). Rewrite it in concrete estate-agency terms: 1 buyer enquiry, 1 potential seller, a viewing, a valuation, a conversation.',
    third_person_prospect: 'email_commercial_hook refers to the enquirer in the third person. Email 1 is written BY the person who enquired: use "I", "me", "my".',
  },
};

const FINDING_TOKEN_STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'because', 'been', 'before', 'being', 'commercial',
  'could', 'enquiry', 'finding', 'from', 'into', 'never', 'opportunity', 'property',
  'same', 'that', 'their', 'there', 'these', 'they', 'this', 'those', 'through',
  'what', 'when', 'where', 'which', 'while', 'with', 'would', 'your',
]);

// THE ORDINARY VOCABULARY OF A PROPERTY ENQUIRY. These words belong to the
// SUBJECT, not to any one finding, so sharing them proves nothing about where
// a sentence came from.
//
// This list is why prb_hist_0002 and prb_hist_0005 persisted a blank
// email_observation in the live run. ParaBar's unselected finding 3 read
// "Viewing progression stayed passive with a generic call-us line rather than
// proactively offering times." A perfectly correct observation —
//   "You replied three times with brochures for me, but no viewing was ever
//    offered and nobody picked up that I'd also said I had a property to sell."
// — shares exactly two tokens with it: "viewing" and "times". Neither is that
// finding's content: "viewing" is what every enquiry is about, and "times" in
// "three times" is not the "times" in "offering times" at all. Two ordinary
// words, no shared meaning, and the sentence was deleted for importing a
// finding it never mentioned.
//
// A bag-of-words test cannot tell those senses apart, so the fix is to stop
// counting the words that carry no evidence either way.
const ENQUIRY_VOCABULARY = new Set([
  'viewing', 'viewings', 'valuation', 'valuations', 'seller', 'sellers', 'vendor',
  'vendors', 'buyer', 'buyers', 'buying', 'selling', 'market', 'agent', 'agents',
  'agency', 'branch', 'email', 'emails', 'emailed', 'phone', 'called', 'calls',
  'voicemail', 'message', 'messages', 'reply', 'replied', 'replies', 'response',
  'responded', 'contact', 'contacted', 'follow', 'times', 'hours', 'days',
  'asked', 'asking', 'questions', 'answer', 'answered', 'offered', 'offering',
  'mentioned', 'declared', 'progressed', 'progression', 'acknowledged',
  'personalised', 'personalized', 'details', 'address', 'brochure', 'brochures',
  'appointment', 'booked', 'booking', 'slot', 'availability', 'contained',
]);

function findingTokens(finding) {
  return new Set(String(finding?.finding || '').toLowerCase()
    .replace(/[^a-z0-9£]+/g, ' ').split(/\s+/)
    .filter((token) => token.length >= 5
      && !FINDING_TOKEN_STOP_WORDS.has(token)
      && !ENQUIRY_VOCABULARY.has(token)));
}

// Reject copy that names a problem belonging only to an unselected diagnosis
// row. Only vocabulary DISTINCTIVE to that one finding is compared: ordinary
// enquiry words are excluded above, and so is anything the selected findings
// or the probe's own enquiry text already use.
//
// Two distinctive words are now required. The old rule also fired on a SINGLE
// token of nine characters or more, which in this vocabulary is an everyday
// word ("progression", "acknowledged", "personalised") rather than evidence of
// anything — one long word is not a finding.
export function introducesUnselectedFinding(text, selectedFindings, allFindings, probe) {
  const tokenise = (value) => String(value || '').toLowerCase()
    .replace(/[^a-z0-9£]+/g, ' ').split(/\s+/).filter(Boolean);
  const copyTokens = new Set(tokenise(text));
  const shared = new Set([
    ...(selectedFindings || []).flatMap((finding) => [...findingTokens(finding)]),
    // The probe's own enquiry text and property are shared subject matter too:
    // a word we ourselves put in the enquiry cannot be evidence that the copy
    // was lifted from some other finding.
    ...tokenise(probe?.enquiry_text),
    ...tokenise(probe?.property_address),
  ]);
  return (allFindings || []).some((finding) => {
    if ((selectedFindings || []).includes(finding)) return false;
    const uniqueMatches = [...findingTokens(finding)]
      .filter((token) => !shared.has(token) && copyTokens.has(token));
    return uniqueMatches.length >= 2;
  });
}

function wordCount(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean).length;
}

// 30, down from 40. The two versions of the same 19-hour observation are what
// set this:
//   too soft, 32 words — "It took nearly 19 hours to get a call, and the
//     enquiry still wasn't properly progressed beyond that initial contact,
//     while nobody picked up that I also had a property to sell."
//   lands,    27 words — "It took nearly 19 hours to get back to the enquiry,
//     and even then nobody picked up that I'd also said I had a property to
//     sell."
// The soft one spends its extra five words explaining rather than stating, and
// takes the hook's job while it is at it. Length is the one mechanical proxy
// for that which does not need the model's cooperation to measure, and the cap
// sits between the two. Repairable, and bankable if the repair misses, so a
// long-but-true sentence is never deleted over it.
const EMAIL_OBSERVATION_MAX_WORDS = 30;

function readsAsFakePositiveWithoutResponse(value) {
  const text = String(value || '').toLowerCase();
  return /\b(?:quick(?:ly)?|prompt(?:ly)?|properly|helpful|well handled|responded|replied|followed up|called me|got back)\b/.test(text)
    && !/\b(?:no|not|never|didn['’]t|without)\b[^.!?]{0,32}\b(?:response|reply|respond|replied|follow(?:ed)? up|call|got back)\b/.test(text);
}

function normaliseEmailSentence(value, allowedFigure) {
  return asStandaloneSentence(emailVariable(value, allowedFigure));
}

// A correction that only has to fix prose asks for the prose ONLY, against the
// selection that already passed. The model cannot re-pick the story, so a
// stylistic miss on one sentence can no longer change the whole record — and
// the call still costs exactly one, keeping the worst case at two.
export function buildScopedRepairTool(fields) {
  const properties = {};
  for (const field of fields) properties[field] = TOOL.input_schema.properties[field];
  return {
    name: 'correct_probe_personalisation_fields',
    description: 'Rewrite only the named fields, against the selection and story already chosen. Do not change the selected findings.',
    input_schema: {
      type: 'object', additionalProperties: false, required: [...fields], properties,
    },
  };
}

export function buildRepairPrompt(previousResult, rejections, { scoped = false } = {}) {
  const notes = rejections
    .map(({ field, reason }) => `- ${REPAIR_NOTES[field]?.[reason] || `${field} is invalid.`}`)
    .join('\n');
  return [
    '', '=== CORRECTION REQUIRED ===',
    scoped
      ? 'The selected findings below are CORRECT and settled — do not change them. Return only the named fields, rewritten against that same selection:'
      : 'Return the complete tool result again. Keep the findings-only source boundary and fix only these failures:',
    notes, '',
    `Selected findings: positive=${previousResult?.positive_finding_index ?? 'null'}, main=${previousResult?.main_finding_index ?? 'null'}, second=${previousResult?.wider_finding_index ?? 'null'}`,
    `Previous email_observation: ${String(previousResult?.email_observation || '(empty)').trim()}`,
    `Previous email_commercial_hook: ${String(previousResult?.email_commercial_hook || '(empty)').trim()}`,
    'Both Instantly variables must describe all and only the same selected findings.',
  ].join('\n');
}

// ── Entry point ──────────────────────────────────────────────────────────────
//
// probe: PROBES row. intelligence: the finalised INTELLIGENCE row — used for
// the deterministic, code-owned decisions (which email variant this is, which
// hero journey the demo routes to, and the countable opportunity shape the
// hook quantifies); no INTELLIGENCE prose ever reaches the model. diagnosis:
// the DIAGNOSIS row — used ONLY for novus_opportunity, in the same
// deterministic hero-journey lookup; no DIAGNOSIS prose reaches the model
// either. findings: that probe's DIAGNOSIS_FINDINGS list (see
// lib/diagnosis-findings.mjs), already ordered by finding_index, and the ONLY
// account of what happened the model is given. agency: AGENCIES row, for the
// scale fact and the protected proper nouns.
//
// COMMUNICATIONS is deliberately NOT a parameter any more. The story is
// selected from findings, and every finding already carries the evidence it
// rests on — so the raw messages had nothing left to add except tokens and an
// invitation to re-diagnose. lib/personalisation-rebuild.mjs no longer loads
// that tab for this step at all.
//
// Makes ONE AI call for a valid selection and coherent copy, with at most
// MAX_PERSONALISATION_ATTEMPTS - 1 bounded correction — SCOPED to the failed
// prose when the selection itself was valid. It is still a single analytical
// pass: a correction re-asks a named gap; it never re-diagnoses, re-grades or
// adds a finding.
//
// Because a probe can cost more than one call, the returned row carries
// ai_calls_used: accounting for the caller's AI-call budget, NOT a stored
// column (no PERSONALISATION header holds it, so it never reaches the sheet).
export async function personaliseProbe(probe, intelligence, diagnosis, findings, agency) {
  const orderedFindings = Array.isArray(findings) ? findings : [];
  const noHumanContact = String(intelligence?.human_contact || '').trim() === 'none';
  const ctx = {
    probe, intelligence, diagnosis, noHumanContact, orderedFindings,
    allowedFigure: probe?.property_price || null,
    protectedWords: extractProtectedWords(probe, agency),
  };
  const basePrompt = buildPrompt(probe, intelligence, orderedFindings, noHumanContact, computeScaleFact(agency));

  // The one call an attempt makes. Attempt 1 asks the whole question. Attempt
  // 2 asks the whole question again when there is nothing to correct (the
  // first result was truncated or unparseable) or when the SELECTION itself
  // failed; otherwise it sends a correction SCOPED to the failed prose, since
  // the indexes are already settled and re-asking for them invites a
  // different story.
  const request = async (attempt, previousCandidate) => {
    if (attempt === 1 || previousCandidate === null) {
      return callAi({ system: SYSTEM_PROMPT, prompt: basePrompt, tool: TOOL });
    }
    const failedFields = [...new Set(previousCandidate.rejections.map((r) => r.field))];
    if (failedFields.some((field) => SELECTION_FIELDS.has(field))) {
      return callAi({
        system: SYSTEM_PROMPT,
        prompt: `${basePrompt}\n${buildRepairPrompt(previousCandidate.result, previousCandidate.rejections)}`,
        tool: TOOL,
      });
    }
    const patch = await callAi({
      system: SYSTEM_PROMPT,
      prompt: `${basePrompt}\n${buildRepairPrompt(previousCandidate.result, previousCandidate.rejections, { scoped: true })}`,
      tool: buildScopedRepairTool(failedFields),
    });
    return { ...previousCandidate.result, ...patch };
  };

  let previous = null;
  let best = null;
  for (let attempt = 1; attempt <= MAX_PERSONALISATION_ATTEMPTS; attempt += 1) {
    let result;
    try {
      result = await request(attempt, previous);
    } catch (error) {
      // A truncated or unrecoverable structured result is NOT a record, so
      // nothing from it may be persisted. Spend the remaining attempt asking
      // again — that is what the bounded second call is for. prb_hist_0005
      // lost its whole record to a max_tokens truncation the old client
      // returned as a normal object with the tail keys missing, and every
      // field after supporting_findings persisted blank.
      //
      // With no attempt left the error propagates and
      // lib/personalisation-rebuild.mjs records the probe as a problem with no
      // row written. That is deliberately better than a half row: a probe with
      // no row is retried by the next pass, whereas needsPersonalisation()
      // reads a half row's primary_narrative and treats the probe as done.
      if (!(error instanceof AiStructuredOutputError) || attempt === MAX_PERSONALISATION_ATTEMPTS) throw error;
      previous = null;
      best = null;
      continue;
    }
    const candidate = buildCandidate(result, ctx);
    if (candidate.rejections.length === 0) return { ...candidate.row, ai_calls_used: attempt };
    if (isBetterFallback(candidate, best)) best = candidate;
    previous = candidate;
  }

  // Last resort. Restore every field that only failed a WORDING guard — a true
  // sentence that reads slightly off is worth more than a blank that breaks
  // the demo. Fields that failed a truthfulness guard stay blank on purpose,
  // and so do fields with a genuine evidence reason (no positive selected, no
  // problem selected, no human response).
  return {
    ...best.row, ...best.softFallbacks,
    ai_calls_used: MAX_PERSONALISATION_ATTEMPTS,
  };
}

// Prefer fewer failures overall, then fewer HARD failures, then the candidate
// that kept the most mandatory prose.
function isBetterFallback(candidate, best) {
  if (!best) return true;
  const hard = (value) => value.rejections.filter(({ reason }) => !canPersistAfterRepair(reason)).length;
  if (hard(candidate) !== hard(best)) return hard(candidate) < hard(best);
  if (candidate.rejections.length !== best.rejections.length) {
    return candidate.rejections.length < best.rejections.length;
  }
  const score = (value) => ['email_observation', 'email_commercial_hook',
    'fair_observation', 'main_finding', 'commercial_consequence']
    .filter((field) => String(value.row[field] || '').trim()
      || String(value.softFallbacks[field] || '').trim()).length;
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
  const softFallbacks = {};
  const resolveIndex = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && byIndex.has(n) ? n : null;
  };

  // One gate per prose field. `checks` run in order against the sanitised
  // text; the first that fires decides the rejection. A SOFT rejection also
  // banks the sanitised text in softFallbacks, so the final fallback can put
  // it back rather than persisting a blank.
  const gate = (field, sanitised, checks) => {
    const value = String(sanitised || '').trim();
    if (!value) {
      rejections.push({ field, reason: 'blank' });
      return '';
    }
    for (const { reason, failed } of checks) {
      if (!failed) continue;
      rejections.push({ field, reason });
      if (canPersistAfterRepair(reason)) softFallbacks[field] = value;
      return '';
    }
    return value;
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

  // ── demo copy ──
  // Blank for an EVIDENCE reason (no positive was selected) is correct and
  // silent. Blank for any other reason is a rejection the correction is told
  // about — which is precisely what did not happen before.
  const fairObservation = positiveIndex === null ? '' : gate(
    'fair_observation',
    asContinuation(emailVariable(result.fair_observation, allowedFigure), FIXED_PREFIX_PATTERNS.fairObservation, protectedWords),
    [
      { reason: 'snuck_criticism', failed: readsAsSnuckCriticism(result.fair_observation) },
      { reason: 'detached_third_person', failed: readsAsDetachedThirdPerson(result.fair_observation) },
      { reason: 'perspective_inversion', failed: readsAsPerspectiveInversion(result.fair_observation) },
    ],
  );

  // main_finding stays blank on a no-response probe by design: the demo's
  // complete_miss shell tells that story itself and has no beat to put it in.
  const mainFinding = mainIndex === null || noHumanContact ? '' : gate(
    'main_finding',
    asContinuation(emailVariable(result.main_finding, allowedFigure), FIXED_PREFIX_PATTERNS.mainFinding, protectedWords),
    [{ reason: 'perspective_inversion', failed: readsAsPerspectiveInversion(result.main_finding) }],
  );

  const consequenceText = stripThatMeantPrefix(emailVariable(result.commercial_consequence, allowedFigure), protectedWords);
  const commercialConsequence = mainIndex === null ? '' : gate(
    'commercial_consequence', consequenceText,
    [
      { reason: 'speculative', failed: readsAsSpeculativeProspectBehaviour(consequenceText) },
      // Compared against the model's own main_finding, not the gated one: a
      // main_finding that was itself rejected would otherwise make every
      // consequence look like it "goes beyond" nothing.
      {
        reason: 'restates_finding',
        failed: !consequenceGoesBeyondFinding(consequenceText, clean(result.main_finding)),
      },
    ],
  );

  // ── Instantly variables ──
  const observationText = normaliseEmailSentence(result.email_observation, allowedFigure);
  const emailObservation = gate('email_observation', observationText, [
    { reason: 'fake_positive', failed: noHumanContact && readsAsFakePositiveWithoutResponse(observationText) },
    { reason: 'unselected_finding', failed: introducesUnselectedFinding(observationText, selectedFindings, orderedFindings, probe) },
    { reason: 'unasked_questions', failed: claimsUnaskedQuestions(observationText) },
    { reason: 'consultant_speak', failed: readsAsConsultantSpeak(observationText) },
    { reason: 'third_person_prospect', failed: readsAsThirdPersonProspect(observationText) },
    { reason: 'too_long', failed: wordCount(observationText) > EMAIL_OBSERVATION_MAX_WORDS },
  ]);

  const hookText = normaliseEmailSentence(result.email_commercial_hook, allowedFigure);
  const hookFailure = hookFailureAgainstObservation(hookText, observationText);
  const emailCommercialHook = gate('email_commercial_hook', hookText, [
    { reason: 'unselected_finding', failed: introducesUnselectedFinding(hookText, selectedFindings, orderedFindings, probe) },
    { reason: 'third_person_prospect', failed: readsAsThirdPersonProspect(hookText) },
    { reason: hookFailure || 'restates_observation', failed: Boolean(hookFailure) && hookFailure !== 'blank' },
  ]);

  const heroJourney = pickHeroJourney(intelligence, orderedFindings, diagnosis);
  return {
    result,
    rejections: rejections.filter(({ field }) => MODEL_FIXABLE_FIELDS.has(field)),
    softFallbacks,
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
  NEVER_PERSIST_REASONS, SELECTION_FIELDS, EMAIL_OBSERVATION_MAX_WORDS,
  ENQUIRY_VOCABULARY,
  buildCandidate, buildPrompt, normalize, computeScaleFact, isUnknownAddress, cleanAddressForEmail,
  emailVariable, ensureSentenceEnd, asStandaloneSentence, wordCount, findingTokens,
  readsAsFakePositiveWithoutResponse, HERO_JOURNEYS, INTERNAL_REASONING_PATTERNS,
  CONSULTANT_SPEAK, AGENCY_OUTCOME_NOUNS,
  DETACHED_THIRD_PERSON_PATTERNS, THIRD_PERSON_PROSPECT_PATTERNS,
};
