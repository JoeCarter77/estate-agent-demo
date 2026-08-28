// lib/probe-personalisation.mjs — one findings-grounded AI pass that selects
// the strongest story for both the demo and Instantly variables.
//
// The model receives PROBES facts plus structured DIAGNOSIS_FINDINGS only. It
// never receives raw COMMUNICATIONS, INTELLIGENCE prose or DIAGNOSIS prose.
// positive_finding_index + main_finding_index + optional wider_finding_index
// are the single authoritative selection. email_observation,
// email_commercial_hook and email_commercial_hook_email_2 must all describe
// that same selection; code rejects invalid indexes, ungrounded copy and any
// hook that introduces an unselected diagnosis finding.
//
// THE THREE EMAIL FIELDS DO THREE DIFFERENT JOBS, and the guards below exist
// to keep them apart:
//   email_observation              what objectively happened in the probe;
//   email_commercial_hook          why that observed behaviour matters
//                                  commercially;
//   email_commercial_hook_email_2  the one extra fact or implication that
//                                  makes the reader reassess the enquiry.
//
// Instantly owns the fixed email templates. This layer supplies only
// property_reference (deterministic), email_observation,
// email_commercial_hook and email_commercial_hook_email_2. The demo-required
// fair_observation, main_finding and commercial_consequence remain
// AI-generated but are not assembled into an email here.

import { callAi } from './ai-client.mjs';
import { AiStructuredOutputError } from './ai-structured-output.mjs';
import { ONE_HOUR_MS, SIXTEEN_HOUR_MS } from './grading.mjs';
import {
  formatFindingsForPrompt, isPositiveFinding, isStoryFinding, normaliseFindingType,
} from './diagnosis-findings.mjs';
import { hasVendorDeclaration } from './vendor-intent.mjs';
// The relationship/provenance layer (contract rules 41-48). It asks the one
// question every other guard here skips: not "is this fact true?" but "is this
// RELATIONSHIP between the facts true?" — the join, the timing, the
// co-occurrence, the certainty level. Support-relative, so the same words pass
// or fail depending on what this probe's findings and enquiry actually carry.
import {
  buildSupportContext, findUnsupportedRelationship, RELATIONSHIP_REASONS,
} from './factual-relationships.mjs';

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

// ── Seller-value provenance ─────────────────────────────────────────────────
//
// PROBES.property_price means exactly ONE thing: the asking price of the
// property the prospect enquired about AS A BUYER. The probe carries no figure
// at all for whatever property that same prospect declared they have to SELL,
// so attaching the enquiry price to the seller opportunity asserts a valuation
// nobody ever gave us.
//
// This is a PROVENANCE rule, not a phrase blacklist. The first version of this
// guard matched a fixed list ("property to sell", "valuation", "instruction")
// and every paraphrase walked straight through it: "a £450k seller
// conversation", "a seller with a £215,000 property", "a seller opportunity
// worth around £225k". So the test is structural instead: does a price token
// sit in the SAME CLAUSE as a seller-side term?
//
// Clause-bounded on purpose. One sentence may legitimately carry both the
// buyer price and a seller mention in different clauses — "You replied fast on
// the £450,000 property I asked about, but nobody picked up that I'd also said
// I had a property to sell" — and that attributes nothing. Splitting at clause
// boundaries is what separates ATTRIBUTION from mere co-occurrence.
//
// Deliberately NOT in the lexicon: bare "listing" and "on the market", which
// far more often describe the property being enquired ABOUT than the one being
// sold, and would strip a legitimate buyer-side price.
// The FIRST-PERSON selling forms are here alongside the nouns because they
// carry exactly the same attribution with none of the same words: "the
// property I was selling" claims the property as mine to sell just as plainly
// as "the property I had to sell", and only the second was recognised. It is
// deliberately first-person: a bare "selling" would flag the agency's own
// side of the transaction ("you were selling it at £425,000"), which is the
// buyer property being marketed and is a perfectly ordinary thing to say.
const SELLER_CONTEXT_RE = /\b(?:sellers?|vendors?|valuations?|instructions?|to\s+sell|to\s+list)\b|\b(?:I|we)\s*(?:'m|’m|'re|’re)?\s*(?:am|are|was|were|had\s+been|have\s+been)?\s*(?:already\s+|still\s+)?selling\b/i;

// The comma is guarded on both sides: the one in "£450,000" is a thousands
// separator, not a clause boundary. Without that guard every clause was cut in
// half mid-figure, which hid the seller term sitting just past it.
const CLAUSE_BOUNDARY_SOURCE = String.raw`\s*(?:(?<!\d),(?!\d)|[;:()]|—|–|\s\b(?:but|and|while|whereas|though|although|yet)\b\s)\s*`;

// The clause of `text` that contains `offset`.
function clauseAt(text, offset) {
  const re = new RegExp(CLAUSE_BOUNDARY_SOURCE, 'gi');
  let start = 0;
  let end = text.length;
  let match = re.exec(text);
  while (match !== null) {
    if (match.index + match[0].length <= offset) start = match.index + match[0].length;
    else if (match.index >= offset) { end = match.index; break; }
    if (match.index === re.lastIndex) re.lastIndex += 1;
    match = re.exec(text);
  }
  return text.slice(start, end);
}

// Detection and removal must agree, so both anchor on the same character: the
// first non-space of the price reference.
function priceSitsInSellerClause(whole, matchOffset, match) {
  const anchor = matchOffset + (match.length - match.trimStart().length);
  return SELLER_CONTEXT_RE.test(clauseAt(whole, anchor));
}

// True when any clause puts a price — a figure, or a bare "priced" modifier —
// in seller context.
export function attributesEnquiryPriceToSeller(text) {
  const raw = String(text || '');
  if (!raw.trim()) return false;
  const re = new RegExp(`${CURRENCY_TOKEN_RE.source}|\\bpriced\\b`, 'gi');
  let match = re.exec(raw);
  while (match !== null) {
    if (priceSitsInSellerClause(raw, match.index, match[0])) return true;
    match = re.exec(raw);
  }
  return false;
}

// The price and the words that exist only to carry it ("worth around £225k",
// "valued at £450,000"), so removing it does not leave dangling glue.
const PRICE_WITH_CARRIER_RE = new RegExp(
  String.raw`\s*\b(?:worth|valued|priced)\b\s+(?:at\s+|around\s+|about\s+|roughly\s+|approximately\s+)?${CURRENCY_TOKEN_RE.source}`
  + `|\\s*${CURRENCY_TOKEN_RE.source}`,
  'gi',
);

// "priced seller opportunity" — implies a value with no figure to strip.
const PRICED_MODIFIER_RE = /\bpriced\s+(?=\w)/gi;

// SURGICAL, NOT SENTENCE-LEVEL. Dropping the whole sentence is what emptied
// mandatory email fields: these three lines are one sentence each, so a single
// bad price reference deleted the entire field and the commercial point with
// it. Only the price reference goes; the sentence around it survives.
export function stripSellerPriceAttribution(text) {
  const raw = String(text || '');
  if (!raw.trim()) return raw;
  // A single space, not an empty string: the match eats the whitespace on both
  // sides of the figure, so collapsing it to nothing welds the surrounding
  // words together ("declared £450,000 property" -> "declaredproperty").
  // tidyAfterPriceRemoval() then absorbs the space before punctuation.
  const inSellerClause = (match, offset, whole) => {
    if (!priceSitsInSellerClause(whole, offset, match)) return match;
    // CURRENCY_TOKEN_RE's [\d,.]* swallows a sentence-final full stop along
    // with the figure ("...worth £450,000."), so hand it back.
    const terminator = match.match(/[.!?]+$/);
    return terminator ? terminator[0] : ' ';
  };
  const stripped = raw
    .replace(PRICE_WITH_CARRIER_RE, inSellerClause)
    .replace(PRICED_MODIFIER_RE, inSellerClause);
  return stripped === raw ? raw : tidyAfterPriceRemoval(stripped);
}

// Mechanical cleanup of the hole the price left — spacing, punctuation and
// article agreement ("a instruction" -> "an instruction"). Runs ONLY when
// something was actually removed, so untouched copy is never rewritten.
// Sound, not spelling: the vowel set stops at [aeio] so "a unique" survives,
// and "one" is excluded so "a one-bed flat" does too.
const ARTICLE_FIX_RE = /\b(a)(\s+)(?=[aeio])(?!one\b|once\b)/gi;

function tidyAfterPriceRemoval(text) {
  return String(text || '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(ARTICLE_FIX_RE, (match, article, gap) => `${article === 'A' ? 'An' : 'an'}${gap}`)
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── Buyer-address provenance ────────────────────────────────────────────────
//
// PROBES.property_address means exactly ONE thing, and it is the same shape of
// rule as PROBES.property_price above: it is the address of the property the
// prospect enquired about AS A BUYER. There is NO seller-property address in
// the data model at all — no seller_address, no property_to_sell_address — so
// stating or implying that the enquiry address IS the property the prospect
// has to sell asserts a fact nobody ever gave us.
//
// Same PROVENANCE test as the price, and deliberately so: does the address
// sit in the SAME CLAUSE as a seller-side term? Clause-bounded for the
// identical reason — "You replied fast about Grey Lady Place, but nobody
// picked up that I'd also said I had a property to sell" carries the buyer
// address and a seller mention in DIFFERENT clauses and attributes nothing.
//
// SELLER_CONTEXT_RE alone is not sufficient here, and that is the one way this
// differs from the price rule. "My property on Grey Lady Place..." contains no
// seller/vendor/valuation word at all — the attribution is carried purely by
// the prospect claiming OWNERSHIP of it. So a second lexicon covers
// first-person ownership of a dwelling. Deliberately restricted to dwelling
// nouns: "my enquiry about Grey Lady Place" is the enquiry, not the property,
// and must pass through untouched.
const PROSPECT_OWNERSHIP_RE = /\b(?:my|our)\s+(?:own\s+)?(?:property|place|home|house|flat|apartment|bungalow|maisonette)\b/i;

const REGEX_SPECIALS = /[-[\]{}()*+?.,\\^$|#\s]/g;

// The address as it would appear in prospect-facing copy — analyst brackets
// already dropped, so the stored field is never what we match on.
//
// AND ITS DISTINCTIVE PARTS, NOT ONLY THE WHOLE STRING. A stored address is
// usually multi-part — "Flat 702, Riverside Court" — and nobody writes it out
// in full in an email. They write "Flat 702", or "Riverside Court". Matching
// only the complete string meant "my property at Flat 702" carried the buyer
// property into a seller clause and passed every guard, while the identical
// claim written out in full was caught: the leak survived purely by being
// phrased the way a person would actually phrase it.
//
// So the pattern is the whole address OR any of its distinctive comma-
// separated components, longest first (so a full mention still matches as one
// unit and strips cleanly). "Distinctive" is deliberately conservative: a
// component qualifies only if it carries a digit or is at least two words.
// That keeps "Flat 702" and "Riverside Court" and drops the parts that
// identify nothing on their own — a town, a county, a bare "London" — which
// would otherwise flag every ordinary sentence that happened to name the area.
const ADDRESS_COMPONENT_MIN_WORDS = 2;

function isDistinctiveAddressComponent(part) {
  if (/\d/.test(part)) return true;
  return part.split(/\s+/).filter(Boolean).length >= ADDRESS_COMPONENT_MIN_WORDS;
}

function enquiryAddressPattern(address) {
  const clean = cleanAddressForEmail(address);
  if (!clean || isUnknownAddress(clean) || hasUnresolvedPlaceholder(clean)) return null;
  const components = clean.split(',')
    .map((part) => part.trim())
    .filter((part) => part && part !== clean && isDistinctiveAddressComponent(part));
  const alternatives = [clean, ...components]
    .sort((a, b) => b.length - a.length)
    .map((value) => value.replace(REGEX_SPECIALS, '\\$&'));
  return alternatives.length === 1 ? alternatives[0] : `(?:${alternatives.join('|')})`;
}

// AN ADDRESS IS NEVER ITS OWN SELLER EVIDENCE. Real addresses contain the
// lexicon's own words — "Vendor Lane", "Valuation Road", "Sellers Close" —
// and a naive clause scan reads the street name itself as proof that the
// clause is about the seller side, flagging every correct buyer-side mention
// of that probe's address. So the address occurrences are removed from the
// clause before it is tested: the seller context has to come from some OTHER
// word in the sentence.
function addressSitsInSellerClause(whole, matchOffset, match, addressSource) {
  const anchor = matchOffset + (match.length - match.trimStart().length);
  const clause = clauseAt(whole, anchor).replace(new RegExp(addressSource, 'gi'), ' ');
  return SELLER_CONTEXT_RE.test(clause) || PROSPECT_OWNERSHIP_RE.test(clause);
}

// True when any clause puts the buyer-enquiry address in seller context — as
// the prospect's own property, the property to sell, the instruction, or the
// valuation property.
export function attributesEnquiryAddressToSeller(text, address) {
  const raw = String(text || '');
  const source = enquiryAddressPattern(address);
  if (!raw.trim() || !source) return false;
  const re = new RegExp(source, 'gi');
  let match = re.exec(raw);
  while (match !== null) {
    if (addressSitsInSellerClause(raw, match.index, match[0], source)) return true;
    match = re.exec(raw);
  }
  return false;
}

// SURGICAL, exactly like stripSellerPriceAttribution: only the misattributed
// address reference goes, never the sentence. The commercial point survives
// with the address removed — "My property on Grey Lady Place was never valued"
// becomes "My property was never valued." A locative preposition that exists
// only to carry the address is matched WITH it so no dangling "on" is left
// behind, and the clause anchor is taken from the ADDRESS itself rather than
// the start of the match, so detection and removal always agree.
export function stripEnquiryAddressAttribution(text, address) {
  const raw = String(text || '');
  const source = enquiryAddressPattern(address);
  if (!raw.trim() || !source) return raw;
  const withCarrier = new RegExp('(\\s+(?:on|at|in))?(\\s*)(' + source + ')', 'gi');
  let changed = false;
  const stripped = raw.replace(withCarrier, (match, carrier, gap, addr, offset) => {
    const addressOffset = offset + (carrier || '').length + (gap || '').length;
    if (!addressSitsInSellerClause(raw, addressOffset, addr, source)) return match;
    changed = true;
    return ' ';
  });
  return changed ? tidyAfterPriceRemoval(stripped) : raw;
}

// Drops any sentence containing a currency figure that isn't the allowed one.
// Sentence-level so a legitimate qualitative sentence in the same field
// survives — the same shape as the previous blanket guard, just with an
// allow-list. allowedFigure is the probe's property_price (or null when the
// probe has none on file, in which case NO currency figure may appear at all).
export function stripUnbackedCurrency(text, allowedFigure) {
  const allowed = normalizeCurrencyFigure(allowedFigure);
  // PROVENANCE FIRST, then the allow-list. A figure standing in seller context
  // is unsupported whatever its value, so it is removed surgically before the
  // sentence filter below ever sees it. Order matters: dropping the sentence
  // instead is what emptied email_observation and both hooks, and a seller
  // figure that happens NOT to match the allowed one would otherwise still
  // take the whole mandatory line down with it.
  const sentences = stripSellerPriceAttribution(String(text || ''))
    .split(/(?<=[.!?])\s+/).filter(Boolean);
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
  lines.push(agencyMadeNextStepAttempt(intelligence)
    ? 'Did the agency put the ball back in my court? YES — a real human came back on this enquiry.'
      + ' I deliberately did not reply after that, so NOTHING that needed my answer may be held against them.'
    : 'Did the agency put the ball back in my court? NO — no genuine human response came back at all.');
  return lines.join('\n');
}

// ── The probe rule: I never reply ───────────────────────────────────────────
//
// The enquiry is a probe. We deliberately stay silent for the whole four-day
// observation period, whatever the agency does. So the moment a real person
// comes back on the enquiry — a call, an email that genuinely answers it, a
// viewing offer, an "give me a ring and we'll sort a time" — every remaining
// outcome needed OUR answer to happen, and we withheld it. Criticising the
// agency for one of those outcomes ("the viewing never got booked", "the
// enquiry never moved forward", "neither side ever became a conversation") is
// criticising them for our own silence, and any agent who knows their own CRM
// will spot it immediately and stop reading.
//
// Everything genuinely inside the agency's control stays fully criticisable
// and is what the email is FOR: no response, a slow first response, no
// follow-up, no viewing offer, no qualifying questions, generic handling, a
// declared seller ignored, weak persistence.
//
// human_contact is the tri-state lib/intelligence-fields.mjs derives: 'yes'
// means a real person came back, 'automated_only' and 'none' mean nobody did.
// human_contact = 'yes' is NECESSARY but not SUFFICIENT: a normal human reply
// or a brochure with nothing to act on does not, by itself, put the ball back
// in my court — the agency still owns everything it never asked or offered.
// Only a concrete ask that genuinely needed MY answer does that:
//   - a viewing offered, a slot offered, or my availability asked for
//     (INTELLIGENCE.viewing_progression);
//   - a direct question about my selling position, or a valuation
//     offered/booked (INTELLIGENCE.seller_recognition);
//   - a qualifying question actually put to me
//     (INTELLIGENCE.buyer_questions_asked).
// These are the same deterministic fields buildOpportunityShape() already
// reads — no new upstream computation, no change to how INTELLIGENCE derives
// them.
const VIEWING_NEXT_STEP_STATES = new Set(['invited', 'availability_requested', 'slot_offered', 'booked']);
const SELLER_NEXT_STEP_STATES = new Set(['asked_position', 'valuation_offered', 'valuation_booked']);

function hasQualifyingQuestionOnRecord(intelligence) {
  const raw = intelligence?.buyer_questions_asked;
  if (Array.isArray(raw)) return raw.some((q) => String(q || '').trim());
  return String(raw || '').trim().length > 0;
}

export function agencyMadeNextStepAttempt(intelligence) {
  if (String(intelligence?.human_contact || '').trim() !== 'yes') return false;
  const viewing = String(intelligence?.viewing_progression || '').trim();
  const seller = String(intelligence?.seller_recognition || '').trim();
  return VIEWING_NEXT_STEP_STATES.has(viewing)
    || SELLER_NEXT_STEP_STATES.has(seller)
    || hasQualifyingQuestionOnRecord(intelligence);
}

// The criticisms that are only true because WE went quiet. Each one describes
// a COMPLETION — booked, arranged, became a conversation, moved forward — that
// no agency can reach on its own once it has responded and is waiting on the
// enquirer. Only checked when agencyMadeNextStepAttempt() is true; on a probe
// that got no genuine reply at all these same sentences are accurate and
// stay allowed.
//
// Deliberately narrow. It does NOT match the agency-controlled phrasings the
// email actually wants — "no viewing was ever offered", "no follow-up was
// sent", "nobody picked up that I'd also said I had a property to sell",
// "the seller side was never acknowledged" — because those name something the
// agency could have done alone, on the day, without hearing another word
// from us.
const UNFAIR_OUTCOME_CRITICISM = [
  // "neither opportunity became a conversation", "neither side was ever
  // converted", "neither lead went anywhere".
  //
  // These are the TWO-WAY completions: becoming a conversation, converting,
  // being booked, going anywhere. None of them can happen while one side has
  // stopped answering, so blaming the agency for them is blaming them for our
  // silence. "went anywhere/nowhere" is here because it was missing — the verb
  // list knew every completion except the one people actually write.
  /\bneither\b[^.!?]{0,48}\b(?:becom(?:e|ing)|became|convert(?:ed|ing)?|reach(?:ed|ing)?|happen(?:ed|ing)?|book(?:ed|ing)?|went\s+(?:anywhere|nowhere)|got\s+going|moved\s+(?:forward|on))\b/i,
  // PROGRESSION IS THE EXCEPTION, exactly as in the entity rule below: it is
  // something the agency does TO an opportunity, alone, so the passive form
  // names their own inaction and is fair. "neither side was ever progressed"
  // is a criticism they can act on; "neither side never progressed" (active)
  // is the same unfair completion claim as the rest of this list. The
  // lookbehind spans the auxiliary and any never/ever between it and the verb.
  /\bneither\b[^.!?]{0,48}(?<!\b(?:was|were|been|being)\s)(?<!\b(?:was|were|been|being)\s(?:ever|never|yet)\s)\bprogress(?:ed|ing)?\b/i,
  // "the viewing never got booked", "no viewing was ever booked", "the
  // valuation was never arranged"
  /\b(?:viewing|valuation|appointment|meeting)s?\b[^.!?]{0,40}\b(?:never|not|wasn['’]?t|weren['’]?t|didn['’]?t)\b[^.!?]{0,24}\b(?:booked|arranged|confirmed|happened|took place|went ahead)\b/i,
  /\b(?:never|not|no)\b[^.!?]{0,24}\b(?:booked|arranged|confirmed)\b[^.!?]{0,24}\b(?:viewing|valuation|appointment|meeting)s?\b/i,
  // "the buyer side never progressed", "the enquiry never moved forward"
  //
  // VOICE IS THE WHOLE DISTINCTION HERE, and reading the entity alone got it
  // wrong. Two sentences share every word that matters and mean opposite
  // things:
  //
  //   "the enquiry never MOVED FORWARD"        — active, intransitive. An
  //     enquiry moves forward when BOTH sides keep going, and we deliberately
  //     went silent, so this blames the agency for our own choice. Unfair.
  //
  //   "the seller side WAS NEVER PROGRESSED"   — passive, and the implied
  //     actor is the agency: "you never progressed it". Progressing the seller
  //     side is offering a valuation, asking a qualifying question, booking an
  //     appraisal — every one of which they could have done alone, on the day,
  //     without another word from us. Entirely fair, and one of the most
  //     useful things the email can say.
  //
  // The `[^.!?]{0,28}` gap was swallowing the passive auxiliary, so `was`/
  // `were` never reached the match and the second sentence was rejected along
  // with the first. The lookbehind puts the auxiliary back in view.
  //
  // Two-way entities are the exception and keep the old behaviour in BOTH
  // voices: a conversation or a thread is not something one party can progress
  // by itself, so "the conversation was never progressed" is still a
  // completion that needed my reply.
  /\b(?:enquiry|enquiries|opportunit(?:y|ies)|side|sides|lead|leads|it|this)\b[^.!?]{0,28}(?<!\b(?:was|were|been|being)\s)\bnever\s+(?:really\s+|actually\s+|properly\s+|fully\s+)?(?:progress(?:ed)?|moved(?:\s+forward|\s+on)?|went anywhere|develop(?:ed)?|advanced|got going)\b/i,
  // The two-way entities, in either voice — see the note above.
  /\b(?:conversation|thread)s?\b[^.!?]{0,28}\bnever\s+(?:really\s+|actually\s+|properly\s+|fully\s+)?(?:progress(?:ed)?|moved(?:\s+forward|\s+on)?|went anywhere|develop(?:ed)?|advanced|got going)\b/i,
  /\b(?:conversation|thread)s?\b[^.!?]{0,28}\b(?:was|were)\s+never\s+(?:really\s+|actually\s+|properly\s+|fully\s+)?(?:progress(?:ed)?|moved(?:\s+forward|\s+on)?|develop(?:ed)?|advanced)\b/i,
  // "neither opportunity became a conversation" without the word neither:
  // "no conversation ever started", "never became a conversation".
  //
  // The quantifier is open and the adjective slot takes only the GENERIC
  // intensifiers, because the claim is the same one however it is counted or
  // dressed: "four attempts NEVER became a REAL conversation", "NONE OF THEM
  // became a conversation", "NOT ONE turned into a genuine conversation". The
  // slot is deliberately not \w+: "it never became a VALUATION conversation"
  // names a specific thing the agency alone could have offered, and stays
  // fully sayable. Every generic version blames the agency for the
  // silence WE chose — the probe never replies, so no number of correct,
  // well-made attempts could have become a conversation. The agency is judged
  // on what it sent, asked, progressed and recognised, never on whether the
  // enquirer carried on talking.
  // The quantifier also has to survive being COUNTED. "None of the four
  // attempts became a real conversation" is the same claim as "none of them
  // became a conversation" with the number spelled out, and it was slipping
  // through: the alternation only knew the pronoun forms.
  /\b(?:never|none\s+of\s+(?:them|these|those|it)|none\s+of\s+the\s+\w+\s+\w+|not\s+one(?:\s+of\s+(?:them|the\s+\w+\s+\w+))?)\s+(?:really\s+|actually\s+|ever\s+)?(?:became|turned\s+into|grew\s+into|developed\s+into)\s+(?:a|an|any)\s+(?:real|genuine|proper|actual|meaningful|two[- ]way|true)?\s*conversation\b/i,
  // "Nothing progressed." / "none of it moved forward" — the same unfair
  // criticism stated as a flat absolute. Only ever reached on a probe where
  // the agency DID make a genuine next-step attempt (see
  // agencyMadeNextStepAttempt), which is exactly the case where the absolute
  // is false: something did progress, and the honest line names which side
  // moved and which did not. Deliberately narrow — "none progressed the
  // seller side" names a side and stays fully sayable.
  /\b(?:nothing|none\s+of\s+it)\b[^.!?]{0,24}\b(?:progress(?:ed)?|moved(?:\s+forward|\s+on)?|advanced|went\s+anywhere|came\s+of\s+it)\b/i,
  /\b(?:no|zero|0)\s+conversations?\b[^.!?]{0,24}\b(?:created|started|happened|came out of it|ever began)\b/i,
  // "the viewing was left hanging", "the enquiry was left dangling"
  /\bleft\s+(?:it\s+|them\s+|me\s+|the\s+\w+\s+)?(?:hanging|dangling|in the air|unresolved|where it started|where they started)\b/i,
  // The "both" phrasing of the same claim — and it carried the identical
  // false positive the entity rule above did, for the identical reason: it
  // triggered on a bare `never` without ever looking at what followed, so
  // "both leads WERE NEVER PROGRESSED" was rejected alongside "both sides
  // never went anywhere". Progressing two opportunities is two things the
  // agency could have done on the day, on its own; the passive says so, and
  // the lookbehind now lets it through.
  /\bboth\s+(?:sides|opportunit(?:y|ies)|leads)\b[^.!?]{0,32}(?<!\b(?:was|were|been|being)\s)\bnever\b/i,
  // The non-`never` forms of the same claim, untouched: "both opportunities
  // were left hanging", "both sides stayed where they started".
  /\bboth\s+(?:sides|opportunit(?:y|ies)|leads)\b[^.!?]{0,32}\b(?:were left|stayed|remained)\b/i,
  // "both conversations went nowhere" — a two-way entity reaching a two-way
  // outcome, with no `never` anywhere in it to trip the patterns above.
  /\b(?:both|all|the)\s+(?:conversations?|threads?|exchanges?)\b[^.!?]{0,32}\bwent\s+nowhere\b/i,
  /\b(?:conversations?|threads?)\b[^.!?]{0,24}\bwent\s+nowhere\b/i,
];

// Pure text test. The caller decides whether it applies to this probe — see
// agencyMadeNextStepAttempt() above.
export function readsAsUnfairOutcomeCriticism(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return UNFAIR_OUTCOME_CRITICISM.some((re) => re.test(t));
}

// ── Prospect-side contact provenance ────────────────────────────────────────
//
// THE PROBE NEVER REPLIES. We send one enquiry and then deliberately say
// nothing for the whole observation period — that is the entire method, and
// agencyMadeNextStepAttempt() above already builds the fairness rule on top of
// it. So any copy asserting that I replied, responded, called back, was
// already replying, that we were speaking, or that the agency "already had me
// engaged" states something that did not happen. It is the mirror image of the
// seller-price rule: a fact nobody ever gave us, asserted as though they had.
//
// This is a PROVENANCE rule, not a phrase blacklist. The test is structural —
// a first-person subject attached to a CONTACT/ENGAGEMENT verb — so paraphrases
// are caught without enumerating them.
//
// The verb lexicon is deliberately narrow, and excludes every verb that
// describes THE ENQUIRY ITSELF: enquired, said, mentioned, asked for, wrote,
// declared, told you. Those are probe facts and the email is built from them
// ("I said I had a property to sell", "I'd mentioned...", "I enquired about
// X"), so they must pass through untouched.
const PROSPECT_CONTACT_VERBS = String.raw`repl(?:y|ied|ying)|respond(?:ed|ing)?|call(?:ed|ing)?\s+(?:you\s+)?back|r(?:i|a)ng\s+(?:you\s+)?back|got\s+back\s+to\s+you|came\s+back\s+to\s+you|chas(?:ed|ing)|follow(?:ed)?\s+up|spoke|speaking|talk(?:ed|ing)|convers(?:ed|ing)|engag(?:ed|ing)\s+with\s+you`;

const PROSPECT_REPLY_CLAIMS = [
  // "I replied", "we responded", "I had already called back", "I was replying"
  new RegExp(String.raw`\b(?:I|we)\b(?:\s+(?:had|have|has|was|were|been|already|just|even|also|still|then|since|kept|by)){0,3}\s+(?:${PROSPECT_CONTACT_VERBS})\b`, 'i'),
  // "we were speaking", "we had a conversation", "we were in dialogue"
  /\bwe\s+(?:had|were\s+having|were\s+in|have\s+had)\s+(?:a\s+|an\s+|any\s+)?(?:conversation|dialogue|discussion|exchange|back[- ]and[- ]forth)\b/i,
  // The same claim made about me from the agency's side: "you already had me
  // engaged", "you had me talking", "you'd got me replying".
  /\byou\b[^.!?]{0,24}\bhad\s+me\b[^.!?]{0,16}\b(?:engaged|talking|replying|responding|interested\s+enough\s+to\s+reply|in\s+conversation)\b/i,
  /\bme\s+(?:already\s+)?(?:engaged|in\s+conversation)\s+with\s+(?:you|your)\b/i,
];

// A negated form is a TRUE statement about the probe and must survive: "I
// never replied", "I didn't call back", "I was not responding". So a match is
// only a claim when the matched span carries no negator.
const NEGATOR_RE = /\b(?:never|not|no|n['’]t|without|nor)\b/i;

export function claimsProspectReply(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return PROSPECT_REPLY_CLAIMS.some((re) => {
    const match = t.match(re);
    return match ? !NEGATOR_RE.test(match[0]) : false;
  });
}

// UNLESS THE EVIDENCE EXPLICITLY SAYS OTHERWISE. The rule is "do not invent a
// prospect-side action", not "the prospect can never have acted" — a probe
// whose own selected findings record a reply from the enquirer may say so.
// Scanned over the SELECTED findings only, exactly like the voicemail
// uncertainty gate, so an unselected finding cannot license the claim.
const EVIDENCED_PROSPECT_REPLY = new RegExp(
  String.raw`\b(?:buyer|prospect|enquirer|applicant|vendor|they|he|she|I|we)\b[^.!?]{0,40}\b(?:${PROSPECT_CONTACT_VERBS})\b`,
  'i',
);

export function evidenceShowsProspectReply(findings) {
  return (findings || []).some((finding) => {
    const text = `${finding?.finding || ''} ${finding?.evidence || ''} ${finding?.significance_note || ''}`;
    const match = text.match(EVIDENCED_PROSPECT_REPLY);
    return match ? !NEGATOR_RE.test(match[0]) : false;
  });
}

// ── Chronology provenance ───────────────────────────────────────────────────
//
// TRUE FACTS, RECOMBINED INTO A FALSE ORDER. This is the failure that gets
// past every guard above, because every individual fact in it is real.
//
// The enquiry declares the seller position UP FRONT, in the original message.
// Some agencies then ask, days later, "do you have a property to sell?" —
// which is itself the point worth making, because they were asking for
// something they had already been told. Both facts are on file. Put them in
// the wrong order and the email says:
//
//     "You asked if I was selling, and then I said yes."
//
// That did not happen. It reverses the provenance of the declaration (mine,
// unprompted, in the original enquiry) into a reply I never sent, and it hands
// the agency back a version of events their own inbox disproves — the same
// class of damage as the seller-price and prospect-reply rules, arrived at by
// re-sequencing rather than by invention. The true version is stronger anyway:
//
//     "You later asked whether I was selling, despite that already being
//      stated in my original enquiry."
//
// STRUCTURAL, NOT A PHRASE LIST. The test is a first-person DECLARATION verb
// placed AFTER an agency ASK by a sequencing marker ("after you asked... I
// said", "you asked..., then I told you"), or framed as answering one ("I
// answered your question"). Chronology is exactly what makes it false, so
// chronology is what is matched.
//
// AND THE ORIGINALITY MARKER IS THE ESCAPE HATCH — the reason this does not
// eat the correct sentence. Copy that keeps the declaration where it belongs
// says so explicitly: "already", "in my original enquiry", "from the start",
// "up front", "in the first place". A sentence carrying one of those is
// asserting the true order, however it arranges its clauses, so it passes
// untouched. A sentence without one, that puts my declaration after their
// question, is asserting the false one.
const AGENCY_ASK = String.raw`you(?:'|’)?(?:d|ve)?\s+(?:\w+\s+){0,3}?(?:ask(?:ed|ing)?|question(?:ed)?|enquir(?:ed|ing)|check(?:ed)?|want(?:ed)?\s+to\s+know)`;
const MY_DECLARATION = String.raw`(?:I|we)\s+(?:then\s+|finally\s+|duly\s+|later\s+|eventually\s+|did\s+|had\s+to\s+)?(?:said|told\s+you|confirmed|mentioned|explained|answered|replied|let\s+you\s+know|came\s+back|responded|disclosed)`;

const FALSE_CHRONOLOGY_PATTERNS = [
  // "After you asked, I said yes." / "Once you'd checked, I told you."
  new RegExp(String.raw`\b(?:after|once|when|only\s+after|only\s+when)\b[^.!?]{0,40}\b${AGENCY_ASK}\b[^.!?]{0,40}\b${MY_DECLARATION}\b`, 'i'),
  // "You asked whether I was selling, then I said yes." — the same claim with
  // the sequencing marker between the clauses instead of in front of them, and
  // the bare-coordination form ("..., and I confirmed it"), where the sequence
  // is carried by the clause order alone.
  new RegExp(String.raw`\b${AGENCY_ASK}\b[^.!?]{0,60}?[,;]?\s*(?:and\s+)?(?:then|so|at\s+which\s+point|after\s+that|only\s+then)\b[^.!?]{0,16}\b${MY_DECLARATION}\b`, 'i'),
  new RegExp(String.raw`\b${AGENCY_ASK}\b[^.!?]{0,60}?[,;]\s*(?:and\s+|but\s+|so\s+)?${MY_DECLARATION}\b`, 'i'),
  // The declaration framed as an answer to their question, in any order:
  // "I answered your question", "in reply to your question I confirmed".
  new RegExp(String.raw`\b${MY_DECLARATION}\b[^.!?]{0,24}\byour\s+(?:question|query|ask|enquiry\s+about)\b`, 'i'),
  new RegExp(String.raw`\bin\s+(?:answer|reply|response)\s+to\s+your\b[^.!?]{0,40}\b${MY_DECLARATION}\b`, 'i'),
  // "only then did I say", "it was only after that that I told you"
  new RegExp(String.raw`\bonly\s+(?:then|after\s+that|at\s+that\s+point)\b[^.!?]{0,24}\bdid\s+(?:I|we)\s+(?:say|tell|mention|confirm|explain|disclose)\b`, 'i'),
];

// The wording that asserts the TRUE order. Any of these in the sentence means
// the copy is making the "you asked for something you had already been told"
// point correctly, and the guard stands down.
const ORIGINAL_DECLARATION_MARKERS = /\balready\b|\boriginal\s+(?:enquiry|message|email)\b|\bfirst\s+(?:enquiry|message|email)\b|\binitial\s+(?:enquiry|message|email)\b|\bopening\s+(?:enquiry|message|email)\b|\bfrom\s+the\s+(?:start|outset|off)\b|\bup\s?front\b|\bin\s+the\s+first\s+place\b|\bat\s+the\s+outset\b|\bbefore\s+you\s+(?:ever\s+)?asked\b|\bwithout\s+being\s+asked\b|\bunprompted\b|\bmy\s+(?:own\s+)?enquiry\s+(?:had|said|declared|stated|already)\b/i;

// Pure text test, same shape as readsAsUnfairOutcomeCriticism(): the caller
// decides where it applies. Deliberately probe-agnostic — this is a general
// provenance class (Rule 33/34), never a fix aimed at one probe_id.
export function readsAsFalseChronology(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (ORIGINAL_DECLARATION_MARKERS.test(t)) return false;
  return FALSE_CHRONOLOGY_PATTERNS.some((re) => re.test(t));
}

// ── Voicemail uncertainty ───────────────────────────────────────────────────
//
// A voicemail transcript can cut off, garble or drop words. When a SELECTED
// finding's own text already shows that — "cut off mid-sentence", "hard to
// make out" — nothing built on top of it may then claim what the voicemail
// did NOT contain: unknown content stays unknown, it is never read as
// "vague", "generic" or "didn't mention/ask/offer X". This does not touch how
// COMMUNICATIONS/INTELLIGENCE transcribe or classify a voicemail; it only
// stops PERSONALISATION's own prose overclaiming from an unreliable finding.
//
// Seller-missed wording is NOT affected by this guard on its own: it is only
// blocked when it is specifically a claim about what a known-unreliable
// voicemail did or didn't contain. "The declared property to sell was never
// acknowledged" judged across the whole record (calls, emails, everything)
// stays fully valid — the brief is explicit that a seller miss remains
// sayable wherever no RELIABLE acknowledgement exists anywhere.
const VOICEMAIL_UNRELIABLE_MARKERS = /\bcuts?\s+off\b|\bcut\s+off\b|\bgarbled\b|\binaudible\b|\bunclear\b|\bhard\s+to\s+(?:hear|make\s+out)\b|\bcouldn['’]t\s+(?:hear|make\s+out)\b|\bbreak(?:s|ing)?\s+up\b|\bbroke\s+up\b|\btrail(?:s|ed)?\s+off\b|\bindistinct\b|\btoo\s+quiet\b|\bstatic\b|\bmid[- ]sentence\b/i;

// ABSENT EVIDENCE IS NOT EVIDENCE OF ABSENCE — the second half of the same
// rule. The markers above describe a call record that EXISTS but is damaged
// (cut off, garbled, indistinct). These describe one that was never captured
// at all: no transcript, no recording, nothing logged. Both leave the call's
// content UNKNOWN, and unknown content may not be reported as empty content —
// "no transcript exists" and "the call contained nothing of substance" are
// completely different claims, and only the first is on file.
//
// Kept as its own marker list, and matched against a broader entity than
// `voicemail` alone, because a missing transcript is recorded against the CALL
// record rather than against the voicemail specifically.
const CONTENT_UNAVAILABLE_MARKERS = /\bno\s+(?:transcript|recording|recorded\s+content|audio|call\s+notes?)\b|\b(?:transcript|recording|content|audio)\s+(?:is\s+|was\s+)?(?:unavailable|missing|not\s+available|not\s+captured|never\s+captured|not\s+recorded|never\s+recorded)\b|\b(?:no|nothing)\s+\w{0,12}\s?(?:was\s+)?(?:captured|logged|transcribed)\b|\bwithout\s+a\s+(?:transcript|recording)\b/i;

const CALL_RECORD_ENTITY = /\bvoicemail\b|\bcalls?\b|\bcalled\b|\btranscripts?\b|\brecordings?\b/i;

// findings: the SELECTED findings only — an unrelated finding elsewhere in
// the probe saying nothing about this voicemail cannot license overclaiming
// about it, so this deliberately does not scan every unselected finding.
//
// Now true for BOTH uncertainty states: a damaged record (the original case,
// unchanged) and a record that was never captured (the new one). Downstream is
// identical either way — the call's content is unknown, so nothing may claim
// what it did or did not contain.
export function hasUnreliableVoicemailEvidence(findings) {
  return (findings || []).some((finding) => {
    const text = `${finding?.finding || ''} ${finding?.evidence || ''} ${finding?.significance_note || ''}`;
    if (/\bvoicemail\b/i.test(text) && VOICEMAIL_UNRELIABLE_MARKERS.test(text)) return true;
    return CALL_RECORD_ENTITY.test(text) && CONTENT_UNAVAILABLE_MARKERS.test(text);
  });
}

// A NEGATIVE claim about what a voicemail's content was or lacked — the thing
// an unreliable transcript cannot support. Praising what a voicemail DID
// contain, or an ordinary criticism unrelated to voicemail content (no
// follow-up call was ever made), is untouched.
const VOICEMAIL_NEGATIVE_CONTENT_CLAIMS = [
  /\bvoicemail\b[^.!?]{0,60}\b(?:no|not|never|didn['’]t|wasn['’]t|weren['’]t)\b[^.!?]{0,40}\b(?:mention(?:ed)?|offer(?:ed)?|ask(?:ed)?|personalis(?:ed|e|ation)?|personaliz(?:ed|e|ation)?|viewing|question|next\s+step|instruction|callback|availability|request)\b/i,
  /\b(?:no|not|never|didn['’]t|wasn['’]t|weren['’]t)\b[^.!?]{0,40}\b(?:mention(?:ed)?|offer(?:ed)?|ask(?:ed)?|personalis(?:ed|e|ation)?|personaliz(?:ed|e|ation)?|viewing|question|next\s+step|instruction|callback|availability|request)\b[^.!?]{0,40}\bvoicemail\b/i,
  /\bvoicemail\b[^.!?]{0,40}\b(?:generic|vague|impersonal)\b/i,
  /\b(?:generic|vague|impersonal)\b[^.!?]{0,40}\bvoicemail\b/i,
];

// EVIDENCE-BOUNDED WORDING IS ALWAYS SAYABLE, and this is the distinction the
// whole rule turns on. "There is no recorded content showing seller
// progression" and "there is no evidenced progression from the available call
// record" describe OUR RECORD, truthfully, and assert nothing about what was
// actually said on the call. "The call had no real content" asserts the call
// itself was empty, which a missing transcript can never establish. The first
// is what the copy should say; only the second is blocked.
const EVIDENCE_BOUNDED_RE = /\bthere\s+(?:is|was)\s+no\s+(?:recorded|evidenced|available|logged)\b|\bno\s+(?:recorded|evidenced|logged)\b[^.!?]{0,32}\bshow(?:s|ing|n)?\b|\bfrom\s+the\s+available\s+(?:call\s+)?record\b|\bno\s+evidenced\b|\b(?:call\s+)?record\s+does\s+not\s+show\b/i;

// A claim that the call/voicemail CONTAINED nothing — the thing an absent or
// damaged transcript can never support. Gated on the broader call-record
// entity, because a missing transcript belongs to the call, not specifically
// to the voicemail.
const CALL_CONTENT_ABSENCE_CLAIMS = [
  /\b(?:voicemail|calls?|called|message)\b[^.!?]{0,40}\b(?:had|contained|included|held|was)\b[^.!?]{0,24}\bno\b[^.!?]{0,24}(?:real\s+|meaningful\s+|substantive\s+|actual\s+)?(?:content|substance|information|detail)\b/i,
  /\bnothing\s+(?:substantive|meaningful|of\s+substance|of\s+note|useful)\b[^.!?]{0,24}\b(?:was\s+)?(?:said|discussed|mentioned|covered|communicated|conveyed)\b/i,
  /\bno\s+(?:real|meaningful|substantive|actual)\s+(?:content|substance)\b/i,
  // THE SAME CLAIM MADE ABOUT A PERSON RATHER THAN ABOUT CONTENT, which is
  // how it actually gets written: "nobody on that call asked about the
  // property I still need to sell." Every pattern above describes the call as
  // empty; this one describes a participant as silent, and both assert the
  // same thing an uncaptured transcript cannot support — knowledge of what
  // was said. It needs an explicit CALL LOCATOR ("on that call", "during the
  // call"), because the identical wording judged across the WHOLE record —
  // "nobody picked up that I'd also said I had a property to sell" — is
  // correct, evidenced, and used verbatim throughout the existing suites.
  /\b(?:on|in|during)\s+(?:that|the|either|both|those)\s+calls?\b[^.!?]{0,48}\b(?:nobody|no[- ]one|neither|never|nothing)\b/i,
  /\b(?:nobody|no[- ]one|neither|never|nothing)\b[^.!?]{0,48}\b(?:on|in|during)\s+(?:that|the|either|both|those)\s+calls?\b/i,
];

export function makesUnsupportedVoicemailClaim(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  // Evidence-bounded phrasing first: it is the correct way to say this, so it
  // is never a rejection however the rest of the sentence reads.
  if (EVIDENCE_BOUNDED_RE.test(t)) return false;
  if (/\bvoicemail\b/i.test(t) && VOICEMAIL_NEGATIVE_CONTENT_CLAIMS.some((re) => re.test(t))) return true;
  return CALL_RECORD_ENTITY.test(t) && CALL_CONTENT_ABSENCE_CLAIMS.some((re) => re.test(t));
}

// ── The single AI call ───────────────────────────────────────────────────────

const TOOL = {
  name: 'record_probe_personalisation',
  description: 'Select one findings-grounded story and write the demo prose plus the three Instantly variables from that same selection.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'story_reasoning',
      'positive_finding_index', 'main_finding_index', 'wider_finding_index',
      'primary_narrative', 'supporting_findings',
      'fair_observation', 'main_finding', 'commercial_consequence',
      'email_observation', 'email_commercial_hook', 'email_commercial_hook_email_2',
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
        description: 'INSTANTLY VARIABLE, EMAIL 1. WHAT OBJECTIVELY HAPPENED. One conversational first-person sentence of 30 words or fewer, from ALL AND ONLY the selected indexes: one genuine positive where there is one, one main problem, at most one tightly connected second problem. Credit what was genuinely done well — it makes the rest credible. State the specific, defensible behaviour and stop; drawing the commercial conclusion is the hook\'s job and makes this line soft. If there was no meaningful reply, state that absence. Never criticise an outcome that needed ME to reply once a real person had come back on the enquiry. No CTA or NOVUS explanation, no deck language, never the enquirer in the third person, and never claim questions were asked that the enquiry never put.',
      },
      email_commercial_hook: {
        type: 'string',
        description: 'INSTANTLY VARIABLE, EMAIL 1. WHY THAT BEHAVIOUR MATTERS COMMERCIALLY. One concise sentence that ADDS MEANING to email_observation rather than saying it again: warm seller intent, a prospect already engaging with the agency, a second opportunity sitting inside one enquiry, a qualification gap, a persistence gap, declared intent that went unrecognised, existing demand worth more than it first looked. e.g. "That seller wasn\'t a cold database record — they were already actively engaging with your agency as a buyer." Do not default to "1 buyer enquiry and 1 potential seller" unless that genuinely adds context. Use concrete estate-agency terms; quantify only where a number reads naturally. Never rely on an outcome that needed ME to reply. NEVER deck language such as "commercial opportunity", "revenue leakage" or "process failure". It must not introduce an unselected problem, invented value, fee or definite-loss claim.',
      },
      email_commercial_hook_email_2: {
        type: 'string',
        description: 'INSTANTLY VARIABLE, EMAIL 2. THE ONE ADDITIONAL FACT OR IMPLICATION THAT MAKES THE READER RE-ASSESS THE ENQUIRY — the line that earns "ah, that\'s actually a good point". Preferably 15-30 words, one sentence, same selected findings. It is NOT a summary of Email 1, NOT the observation again, NOT the first hook again, and never a second problem invented to make Email 2 interesting. Prefer a contrast the evidence already supports: what was done well against what was still sitting in the same enquiry, speed against recognition, activity against actual understanding of the enquiry, the fact that the prospect was already warm, the fact that one interaction held two opportunities. e.g. "The interesting part is that speed wasn\'t the problem here — the missed value was sitting inside the same enquiry you already responded to." Where the evidence holds no distinct second insight, reframe the strongest finding from a new angle instead of manufacturing one. Same bans as the first hook: no deck language, no third person, no outcome that needed ME to reply.',
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

THE PROBE RULE — READ THIS BEFORE WRITING ANY LINE
I sent this enquiry and then deliberately said nothing for the whole observation period, whatever the agency did.
So the moment a real person came back to me — a call, an email that genuinely answers the enquiry, a viewing offer,
an "give me a ring and we'll sort a time" — everything after that needed MY answer, and I never gave one.
NEVER criticise them for one of those outcomes. All of these are banned in that case, and an agent spots them instantly:
  "the viewing never got booked" / "the buyer side never progressed" / "neither opportunity became a conversation"
  "the viewing was left hanging" / "the enquiry never moved forward" / "with neither properly progressed"
DO criticise anything that was entirely theirs to do, on the day, without hearing another word from me:
  no response at all / a slow first response / no genuine follow-up / no viewing offer / no qualifying questions
  generic or passive handling / a declared property to sell never acknowledged / a stated opportunity never explored
  weak personalisation / weak persistence.
A REPLY ALONE DOES NOT COUNT. A human reply that offers nothing to act on — a brochure, "thanks, here are the details" —
never puts the ball in my court. Only a concrete ask that genuinely needed MY answer does that: a viewing offered, my
availability requested, a specific slot offered, a direct question about my selling position, a valuation offered or
booked, or a real qualifying question actually put to me. The OPPORTUNITY SHAPE block tells you which of these this
probe has, and therefore which case it is.

VOICEMAIL EVIDENCE. A voicemail transcript can cut off, be unclear, or drop words. If a finding's own evidence already
shows that, its content beyond what is actually quoted is UNKNOWN — never claim what that voicemail did NOT contain
(not personalised, no viewing offered, no question asked, generic, vague). A seller opportunity going unacknowledged
stays fully sayable when the FULL communication record shows no reliable acknowledgement anywhere; only a claim
specifically about the unreliable voicemail's own missing content is off limits.

INSTANTLY VARIABLES
Three lines, three different jobs, and they must not do each other's:
  OBSERVATION  = what objectively happened.
  HOOK         = why that behaviour matters commercially.
  EMAIL 2 HOOK = the one extra fact or implication that makes them reassess the enquiry.
Short. Specific. Concrete. Written by the person who sent the enquiry, to the agency. Never consultant language.

email_observation — one sentence, 30 words or fewer, answering: "what actually happened?"
- State specific, defensible behaviour. Credit a genuine strength where there is one — it is what makes the rest land.
- Do not explain, do not qualify, do not draw the commercial conclusion — the hook does that.
- One genuine positive where there is one, one main problem, and at most one tightly connected second problem. Never a list.
- With no meaningful reply, state the absence plus any connected opportunity the findings support.
  LANDS:     "You replied within 10 hours and pushed straight for a viewing, but nobody acknowledged that I'd also said I had a property to sell."
  LANDS:     "It took nearly 19 hours to get back to the enquiry, and even then nobody picked up that I'd also said I had a property to sell."
  TOO SOFT:  "It took nearly 19 hours to get a call, and the enquiry still wasn't properly progressed beyond that initial contact, while nobody picked up that I also had a property to sell."
             (explains instead of stating, and steals the hook's job)
  LANDS:     "We didn't receive any response 4 days after the enquiry, and nobody picked up that I'd also mentioned I had a property to sell."
  LANDS:     "You picked up that I had a property to sell, but nothing came back about actually valuing it."

email_commercial_hook — one sentence answering: "why does that matter commercially?"
- ADD MEANING. If it could be swapped with the observation and read the same, it has done nothing.
- Reach for the concrete commercial meaning the evidence supports: warm seller intent; a prospect already engaging with
  the agency; a second opportunity sitting inside one enquiry; a qualification gap; a persistence gap; a handling-quality
  gap; declared intent that went unrecognised; existing demand worth more than it first looked.
- Do NOT default to "1 buyer enquiry and 1 potential seller" — use counts only where a number genuinely adds something.
  LANDS:  "That seller wasn't a cold database record — they were already actively engaging with your agency as a buyer."
  LANDS:  "So the buyer side moved forward, while the potential seller was missed entirely."
  LANDS:  "So the seller lead was spotted, but it still never became a valuation conversation."
  FLAT:   "A potential seller went unengaged, meaning no valuation conversation had the chance to start."
          (says the observation again in longer words)

email_commercial_hook_email_2 — preferably 15-30 words, one sentence, answering:
"what is the one thing that, once pointed out, makes them see this enquiry differently?"
- It must not summarise Email 1, restate the observation, or restate the first hook.
- Never invent a second problem to make it interesting. If there is no distinct second insight, take the strongest
  finding and reframe it — a new angle, a contrast, why that prospect was commercially worth more than they looked.
- Useful shapes: "You did X well, but Y was sitting there too." / "The issue wasn't X — it was Y."
  / "The interesting part is that X was fine; Y is where the value was."
  LANDS:  "The interesting part is that speed wasn't the problem here — the missed value was sitting inside the same enquiry you already responded to."
  LANDS:  "You handled the viewing side well; the part worth looking at is that the same person had already given you a second reason to engage."
  LANDS:  "Five follow-ups shows good persistence; the gap is that every touch was still working the same side of an enquiry that contained two opportunities."
  LANDS:  "The speed was fine — what got lost was the actual context of the enquiry and the second reason that person was worth speaking to."
  LANDS:  "In this case the issue wasn't qualification or follow-up quality — the enquiry never got a genuine human response in the first place."
  LANDS:  "The buyer side worked exactly as you'd expect; the overlooked value was that the buyer had already volunteered seller intent in the same message."

BANNED IN ALL THREE LINES — this is deck language and it kills the email:
  commercial opportunity / commercial opportunities / commercial value / revenue leakage / lost revenue
  pipeline leakage / lead leakage / process failure / optimisation opportunity / conversion issue / conversion rate
  funnel / touchpoint / operational inefficiency / costing you thousands / invisible money
Say buyer enquiry, potential seller, vendor, valuation lead, viewing, conversation, next step instead.
Never invent revenue, fees, conversion rates or annual losses.

STAY LITERAL TO THE EVIDENCE
The enquiry asked for more details about the property. It did NOT put specific questions to the agent, so
"nobody answered my questions" claims something that never happened. Grounded wording: "got back to the enquiry",
"I'd also said I had a property to sell", "the viewing side moved forward", "the seller side was never acknowledged".

All three lines must use ALL AND ONLY the selected findings. Neither hook may introduce a problem the observation did not tell.

DEMO FIELDS
- fair_observation, main_finding and commercial_consequence remain for the current demo. Keep them concise and grounded in the relevant selected indexes. Leave fair_observation empty when no genuine positive exists.
- primary_narrative, supporting_findings and novus_counterfactual are internal/demo prose, never substitutes for the three Instantly variables.

VOICE
Write to the agency as "you" and from the enquirer as "I"/"me"/"my"/"we". The prospect must read both emails as coming directly from the person who sent the enquiry.
- In email_observation, email_commercial_hook and email_commercial_hook_email_2 NEVER refer to the enquirer in the third person: no "Joe", no "Joe's enquiry", no "the enquirer", no "the buyer", no "the prospect". It is "I" and "my enquiry".
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
// Instantly owns the email body. These helpers sanitise the three Instantly
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
  /\blead\s+leakage\b/i,
  /\bprocess\s+(?:failure|breakdown)\b/i,
  /\bcosting\s+you\s+thousands\b/i,
  /\binvisible\s+money\b/i,
  /\bconversion\s+(?:rate|issue)\b/i,
  /\boptimisation\s+opportunit(?:y|ies)\b/i,
  /\boptimization\s+opportunit(?:y|ies)\b/i,
  /\bfunnel\b/i,
  /\btouch\s?points?\b/i,
  /\boperational\s+inefficienc(?:y|ies)\b/i,
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

// EMAIL 2 EXISTS TO ADD THE ONE THING EMAIL 1 DID NOT SAY.
//
// Its failure mode is not deck language or a wrong fact — it is being a third
// wording of the same point. Email 1 already carries two lines about this
// enquiry, so the only way this one earns its place is by saying something
// neither of them said: the contrast between what was done well and what was
// still sitting there, the difference between speed and recognition, the fact
// that the prospect was already warm.
//
// What this function CAN decide is the mechanical half: it is not blank, not
// deck language, not a lexical restatement of EITHER Email 1 line, and not so
// long that it has stopped being one point. Whether a well-formed second hook
// genuinely reframes anything is the prompt's job — same honesty boundary as
// hookFailureAgainstObservation() above, and for the same reason. Do not add a
// heuristic here that pretends to make that judgement.
//
// null when it does its job; otherwise the rejection reason.
export function secondHookFailure(secondHook, observation, hook) {
  const h2 = comparable(secondHook);
  if (!h2) return 'blank';
  if (readsAsConsultantSpeak(secondHook)) return 'consultant_speak';
  if (!isDistinctText(secondHook, observation)) return 'restates_observation';
  if (!isDistinctText(secondHook, hook)) return 'restates_hook';
  if (wordCount(secondHook) > EMAIL_2_HOOK_MAX_WORDS) return 'too_long';
  return null;
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
function emailVariable(text, allowedFigure, enquiryAddress) {
  // Order matters: strip the figures that were never ours to state, then the
  // buyer-enquiry address wherever it has been lent to the seller side, then
  // the sentences that turn the one allowed figure into the agency's loss,
  // then drop the whole value if what is left reads as a note to ourselves.
  const raw = String(text || '').trim();
  if (hasUnresolvedPlaceholder(raw)) return '';
  const cleaned = stripInventedLoss(
    stripEnquiryAddressAttribution(stripUnbackedCurrency(raw, allowedFigure), enquiryAddress),
  );
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
  'email_observation', 'email_commercial_hook', 'email_commercial_hook_email_2',
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
  // Blaming the agency for an outcome that needed MY reply, on a probe where a
  // real person had already come back to me. This is not a wording preference
  // — the sentence is not true, because the reason it did not happen is that
  // we deliberately went silent. A blank line beats a line an agent can
  // disprove from their own CRM in ten seconds, so this one never banks.
  'unfair_outcome_criticism',
  // A negative claim about what an unreliable voicemail did or didn't
  // contain. The transcript cannot support it either way, so this is an
  // evidentiary gap, not a wording one — it never banks.
  'unsupported_voicemail_claim',
  // A prospect-side action that never happened. The probe deliberately stays
  // silent for the whole observation period, so "I replied" / "we were
  // speaking" is not a wording preference — it is a false fact, and an agent
  // can disprove it from their own inbox instantly. Never banks.
  //
  // NOTE: seller_address_attribution is deliberately NOT here. Like
  // seller_price_attribution, the offending reference is removed SURGICALLY
  // and the de-addressed sentence is banked, so a mandatory field is never
  // emptied by this guard.
  'unsupported_prospect_reply',
  // A chronology that reverses where my seller declaration came from — their
  // question first, my answer second, when the declaration was in the original
  // enquiry and I never answered anything. Every fact in it is true and the
  // order is false, which makes it exactly as disprovable from the agency's own
  // inbox as an invented reply. Same tier, same reason: never banks.
  'false_chronology',
  // THE RELATIONSHIP FAILURES (rules 41-48). Each one asserts a join between
  // facts that the evidence does not carry — a declaration relocated into a
  // call, a co-occurrence that never co-occurred, certainty drawn from an
  // uncaptured record, a comparison nobody made, knowledge nobody has. Every
  // fact in such a sentence can be true while the sentence is false, which is
  // exactly what makes it disprovable by the agent reading it. Same tier as
  // an invented reply: repaired once, and never banked if the repair misses.
  ...RELATIONSHIP_REASONS,
]);

const canPersistAfterRepair = (reason) => !NEVER_PERSIST_REASONS.has(reason);

// The property value on file is the price of the property I enquired about as
// a BUYER. Nothing tells us what the property I said I have to SELL is worth,
// so the correction is told to drop the figure from that side and keep the
// point — never to drop the line.
const SELLER_PRICE_REPAIR_NOTE = (field) =>
  `${field} attaches the enquiry property's price to my SELLER opportunity. That figure is the asking price of the property I enquired about as a buyer; nothing on file says what the property I have to sell is worth. Keep the same commercial point and remove the figure from the seller side — "a seller conversation", "a potential seller instruction", "a valuation opportunity". The figure may still be used for the buyer enquiry itself.`;

const SELLER_ADDRESS_REPAIR_NOTE = (field) =>
  `${field} treats the enquiry property's address as the property I have to SELL. That address is the property I enquired about as a BUYER; nothing on file says where the property I have to sell is, or what it is called. Keep the same commercial point and stop attributing that address to my seller side — "a property I said I had to sell", "a potential seller instruction". The address may still be used for the buyer enquiry itself.`;

const FALSE_CHRONOLOGY_REPAIR_NOTE = (field) =>
  `${field} puts my seller declaration AFTER your question, as though I answered it. I declared the property to sell in my ORIGINAL enquiry, before you asked anything, and I never replied at any point. If the point is that you asked for something you had already been told, say exactly that: "you later asked whether I was selling, despite that already being stated in my original enquiry".`;

const PROSPECT_REPLY_REPAIR_NOTE = (field) =>
  `${field} claims I replied, responded, called back, or was already in conversation with the agency. I sent one enquiry and then deliberately said nothing for the whole observation period, and nothing in the evidence shows otherwise — so that did not happen. State only what the AGENCY did or did not do, and describe my side using the enquiry itself ("I enquired about...", "I'd said I had a property to sell").`;

// One note per relationship failure, written as the correction the model has
// to make rather than as a restatement of the rule. Each names the SUPPORTED
// alternative, because in every one of these cases there is a true version of
// the same commercial point and it is usually the stronger line.
const RELATIONSHIP_REPAIR_NOTES = {
  unknown_call_certainty: 'claims what was or was not said on a call whose content was never captured. No transcript exists, so what was discussed is UNKNOWN — not empty. Say what the record shows instead: "there is no recorded evidence showing the seller opportunity was addressed".',
  unsupported_declaration_timing: 'places my seller declaration inside a call or a reply. I declared it once, in my ORIGINAL ENQUIRY, and I never spoke to anyone after that. Keep the declaration where it happened: "the seller declaration I\'d already included in my original enquiry was never progressed".',
  unsupported_co_occurrence: 'puts two facts from different moments into one message. Only my original enquiry carried both the viewing request and the seller declaration; anything the agency sent later is a separate event. Say "the seller declaration was already present in my original enquiry".',
  unsupported_causal_link: 'invents a cause-and-effect exchange in which the agency did something and I responded. I never responded. State what the agency did and what it did not do, with no reaction from me.',
  certainty_upgrade: 'upgrades a possibility into an accomplished fact — a potential seller opportunity is not an "instruction" or a "listing", which are things you would already have won. Keep the evidence\'s level: "a potential seller instruction", "a valuation opportunity", "a property to sell".',
  unsupported_comparative: 'ranks one opportunity above the other. Nothing on file measures the seller opportunity against the buyer one — there is no figure, no probability and no finding that compares them. Make the point without the comparison.',
  third_party_knowledge: 'claims what someone else knew, saw or believed — another agent, the market, or the agency privately. We only know what the agency actually sent. Say what is on the record instead.',
};

const RELATIONSHIP_REPAIR_NOTE = (field, reason) =>
  `${field} ${RELATIONSHIP_REPAIR_NOTES[reason] || 'asserts a relationship between facts that the evidence does not support. Restate it using only what the selected findings and my enquiry actually establish.'}`;

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
    unsupported_voicemail_claim: 'main_finding claims what an unreliable voicemail did or did not contain. This finding\'s own voicemail evidence is unclear/cut off, so its content is unknown — do not claim what it did or didn\'t say, offer or ask.',
    unsupported_prospect_reply: PROSPECT_REPLY_REPAIR_NOTE('main_finding'),
    false_chronology: FALSE_CHRONOLOGY_REPAIR_NOTE('main_finding'),
  },
  commercial_consequence: {
    blank: 'A [PROBLEM]/[OPPORTUNITY] finding was selected, so commercial_consequence is required: say what that finding COST commercially.',
    restates_finding: 'commercial_consequence repeats main_finding in other words. Say what the agency failed to find out, progress or capture as a result — not the same event again.',
    speculative: 'commercial_consequence invents what the prospect went on to do (viewed elsewhere, lost interest, instructed someone else). Say instead what remained unqualified, unbooked or unexplored.',
    internal_reasoning: 'commercial_consequence referred to the machinery behind the email. State the commercial cost plainly.',
    unsupported_voicemail_claim: 'commercial_consequence claims what an unreliable voicemail did or did not contain. This finding\'s own voicemail evidence is unclear/cut off, so its content is unknown — do not claim what it did or didn\'t say, offer or ask.',
    unsupported_prospect_reply: PROSPECT_REPLY_REPAIR_NOTE('commercial_consequence'),
    false_chronology: FALSE_CHRONOLOGY_REPAIR_NOTE('commercial_consequence'),
  },
  email_observation: {
    blank: 'email_observation is required and must be one concise standalone sentence from the selected findings.',
    too_long: 'email_observation is too long, or lists too many things. Keep one positive, one main problem and at most one connected second problem, in 40 words or fewer.',
    unselected_finding: 'email_observation introduced a diagnosis finding outside the selected indexes. Rewrite it from the selected findings only.',
    fake_positive: 'There was no meaningful human response. Remove praise and state only the supported no-response story.',
    third_person_prospect: 'email_observation refers to the enquirer in the third person ("Joe", "Joe\'s enquiry", "the enquirer", "the buyer"). Email 1 is written BY the person who enquired: use "I", "me", "my".',
    unasked_questions: 'The enquiry asked for more details; it did not put specific questions to the agent, so "nobody answered my questions" is not supported. Say what IS supported: "got back to the enquiry", "the enquiry wasn\'t progressed".',
    consultant_speak: 'email_observation uses deck language ("commercial opportunity", "process failure"). Write it the way the enquirer would say it, in plain estate-agency terms.',
    unfair_outcome_criticism: 'email_observation blames the agency for something that needed ME to reply (a viewing not booked, the enquiry not moving forward, neither side progressing) after a real person had already come back on the enquiry. I deliberately did not reply during the observation period. State only what they did or did not do themselves.',
    unsupported_voicemail_claim: 'email_observation claims what an unreliable voicemail did or did not contain. This finding\'s own voicemail evidence is unclear/cut off, so its content is unknown — do not claim what it did or didn\'t say, offer or ask.',
    seller_price_attribution: SELLER_PRICE_REPAIR_NOTE('email_observation'),
    seller_address_attribution: SELLER_ADDRESS_REPAIR_NOTE('email_observation'),
    unsupported_prospect_reply: PROSPECT_REPLY_REPAIR_NOTE('email_observation'),
    false_chronology: FALSE_CHRONOLOGY_REPAIR_NOTE('email_observation'),
  },
  email_commercial_hook_email_2: {
    blank: 'email_commercial_hook_email_2 is required: one sentence, preferably 15-30 words, giving the ONE extra fact or implication that makes the reader see this enquiry differently.',
    unselected_finding: 'email_commercial_hook_email_2 introduced a diagnosis finding outside the selected indexes. Reframe the SAME selected story instead.',
    restates_observation: 'email_commercial_hook_email_2 says email_observation again in different words. Email 2 must add the thing Email 1 did not say — the contrast, the second layer, why that prospect was worth more than they looked.',
    restates_hook: 'email_commercial_hook_email_2 says email_commercial_hook again in different words. Give a genuinely different angle on the same selected story: "You did X well, but Y was sitting there too", or "The issue wasn\'t X — it was Y".',
    too_long: 'email_commercial_hook_email_2 has become a paragraph. One sentence, preferably 15-30 words, one point.',
    consultant_speak: 'email_commercial_hook_email_2 uses deck language. Say the actual thing that happened, in plain estate-agency terms.',
    third_person_prospect: 'email_commercial_hook_email_2 refers to the enquirer in the third person. It is written BY the person who enquired: use "I", "me", "my".',
    unfair_outcome_criticism: 'email_commercial_hook_email_2 blames the agency for something that needed ME to reply (a viewing not booked, the enquiry not moving forward, neither side progressing) after a real person had already come back on the enquiry. I deliberately did not reply. Point at what was theirs alone to do instead.',
    unsupported_voicemail_claim: 'email_commercial_hook_email_2 claims what an unreliable voicemail did or did not contain. This finding\'s own voicemail evidence is unclear/cut off, so its content is unknown — do not claim what it did or didn\'t say, offer or ask.',
    seller_price_attribution: SELLER_PRICE_REPAIR_NOTE('email_commercial_hook_email_2'),
    seller_address_attribution: SELLER_ADDRESS_REPAIR_NOTE('email_commercial_hook_email_2'),
    unsupported_prospect_reply: PROSPECT_REPLY_REPAIR_NOTE('email_commercial_hook_email_2'),
    false_chronology: FALSE_CHRONOLOGY_REPAIR_NOTE('email_commercial_hook_email_2'),
  },
  email_commercial_hook: {
    blank: 'email_commercial_hook is required and must sharpen the exact selected story.',
    unselected_finding: 'email_commercial_hook introduced a diagnosis finding outside the selected indexes. Quantify or sharpen only the selected story.',
    restates_observation: 'email_commercial_hook says the observation again in different words. State why that behaviour MATTERS commercially instead — warm seller intent, a prospect already engaging with you as a buyer, a second opportunity inside one enquiry, a qualification or persistence gap.',
    no_quantification: 'email_commercial_hook does not name what was actually missed. Say it in the agency\'s own terms — the buyer enquiry, the potential seller, the viewing, the valuation, the conversation that never happened — using the counts above where a number reads naturally.',
    consultant_speak: 'email_commercial_hook uses deck language ("commercial opportunity", "revenue leakage", "process failure"). Rewrite it in concrete estate-agency terms: 1 buyer enquiry, 1 potential seller, a viewing, a valuation, a conversation.',
    third_person_prospect: 'email_commercial_hook refers to the enquirer in the third person. Email 1 is written BY the person who enquired: use "I", "me", "my".',
    unfair_outcome_criticism: 'email_commercial_hook blames the agency for something that needed ME to reply (a viewing not booked, the enquiry not moving forward, neither side progressing) after a real person had already come back on the enquiry. I deliberately did not reply, so that is not their failure. Say why the behaviour you DID observe matters commercially instead.',
    unsupported_voicemail_claim: 'email_commercial_hook claims what an unreliable voicemail did or did not contain. This finding\'s own voicemail evidence is unclear/cut off, so its content is unknown — do not claim what it did or didn\'t say, offer or ask.',
    seller_price_attribution: SELLER_PRICE_REPAIR_NOTE('email_commercial_hook'),
    seller_address_attribution: SELLER_ADDRESS_REPAIR_NOTE('email_commercial_hook'),
    unsupported_prospect_reply: PROSPECT_REPLY_REPAIR_NOTE('email_commercial_hook'),
    false_chronology: FALSE_CHRONOLOGY_REPAIR_NOTE('email_commercial_hook'),
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

// The brief asks for 15-30 words in Email 2's hook, which is a preference
// rather than a boundary — a 32-word line that lands is worth more than a
// 30-word one that does not. So the cap sits above the preferred range and
// catches only the shape that has stopped being one point: a second hook long
// enough to be a paragraph is a summary of Email 1 again, which is exactly
// what this field must never be. Repairable, and bankable if the repair
// misses.
const EMAIL_2_HOOK_MAX_WORDS = 36;

function readsAsFakePositiveWithoutResponse(value) {
  const text = String(value || '').toLowerCase();
  return /\b(?:quick(?:ly)?|prompt(?:ly)?|properly|helpful|well handled|responded|replied|followed up|called me|got back)\b/.test(text)
    && !/\b(?:no|not|never|didn['’]t|without)\b[^.!?]{0,32}\b(?:response|reply|respond|replied|follow(?:ed)? up|call|got back)\b/.test(text);
}

function normaliseEmailSentence(value, allowedFigure, enquiryAddress) {
  return asStandaloneSentence(emailVariable(value, allowedFigure, enquiryAddress));
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
  // A relationship failure (rules 41-48) resolves through its own note rather
  // than the per-field table: the correction is identical whichever field
  // carried the bad join, so adding a detector never means adding six notes.
  const notes = rejections
    .map(({ field, reason }) => `- ${REPAIR_NOTES[field]?.[reason]
      || (RELATIONSHIP_REASONS.includes(reason) ? RELATIONSHIP_REPAIR_NOTE(field, reason) : `${field} is invalid.`)}`)
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
    `Previous email_commercial_hook_email_2: ${String(previousResult?.email_commercial_hook_email_2 || '(empty)').trim()}`,
    'All three Instantly variables must describe all and only the same selected findings,',
    'and must not repeat each other: what happened / why it matters commercially / the one extra thing that changes how the enquiry reads.',
  ].join('\n');
}

// ── Entry point ──────────────────────────────────────────────────────────────
//
// probe: PROBES row. intelligence: the finalised INTELLIGENCE row — used for
// the deterministic, code-owned decisions (which email variant this is, which
// hero journey the demo routes to, and the countable opportunity shape the
// hook quantifies); no INTELLIGENCE prose ever reaches the model. diagnosis:
// a DIAGNOSIS-shaped object from which EXACTLY ONE field is read —
// novus_opportunity, a three-value enum, for the deterministic hero-journey
// lookup. findings: that probe's DIAGNOSIS_FINDINGS list (see
// lib/diagnosis-findings.mjs), already ordered by finding_index, and the ONLY
// account of what happened the model is given. agency: AGENCIES row, for the
// scale fact and the protected proper nouns.
//
// THE DIAGNOSIS ROW IS NOT AN INPUT TO THIS LAYER, AND NOW CANNOT BECOME ONE.
// The prompt already excluded the DIAGNOSIS prose, but the whole row was still
// carried into ctx, where any later edit could reach for diagnosis_summary,
// strengths, missed_opportunities or commercial_implication and quietly put a
// second, differently-worded account of the probe back into the email. So the
// row is narrowed HERE, at the boundary, to the single enum the hero-journey
// lookup needs: whatever a caller passes, nothing past this line can read a
// DIAGNOSIS prose field, because no DIAGNOSIS prose field survives the call.
// DIAGNOSIS_FINDINGS is the authoritative commercial interpretation layer;
// DIAGNOSIS prose is non-authoritative downstream, and this is what makes that
// structural rather than conventional.
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
  // The ONE field that crosses the boundary. Not the row.
  const novusOpportunity = String(diagnosis?.novus_opportunity || '').trim();
  const ctx = {
    probe, intelligence, novusOpportunity, noHumanContact, orderedFindings,
    allowedFigure: probe?.property_price || null,
    enquiryAddress: probe?.property_address || null,
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
      //
      // A FAILED CORRECTION IS NOT A FAILED PROBE. Once attempt 1 has produced
      // a complete, gated candidate, the correction call is an IMPROVEMENT on
      // an answer we already hold, not a precondition for having one — so an
      // error raised by the correction call itself (the wire's required-field
      // contract, a transport failure) must fall through to the same
      // soft-fallback return a correction that came back and still missed
      // would take. Throwing here instead discarded a usable row and left the
      // probe with no PERSONALISATION and therefore no DEMO, while
      // ai_personalisations_run reported none of the calls it had just spent.
      if (attempt === MAX_PERSONALISATION_ATTEMPTS && best) break;
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
    'email_commercial_hook_email_2',
    'fair_observation', 'main_finding', 'commercial_consequence']
    .filter((field) => String(value.row[field] || '').trim()
      || String(value.softFallbacks[field] || '').trim()).length;
  return score(candidate) > score(best);
}

function buildCandidate(result, ctx) {
  const {
    probe, intelligence, novusOpportunity, noHumanContact,
    orderedFindings, allowedFigure, enquiryAddress, protectedWords,
  } = ctx;
  // The same two provenance rules on the internal/demo prose fields: the
  // figure that was never ours to state, and the buyer address that was never
  // the seller's property.
  const clean = (value) => stripEnquiryAddressAttribution(
    stripUnbackedCurrency(String(value || '').trim(), allowedFigure), enquiryAddress,
  );
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
  // VOICEMAIL UNCERTAINTY. Computed once, from the SELECTED findings only, and
  // applied to every AI-authored prose field below — see
  // hasUnreliableVoicemailEvidence()/makesUnsupportedVoicemailClaim() for why.
  const unreliableVoicemail = hasUnreliableVoicemailEvidence(selectedFindings);
  const voicemailFailure = (text) => unreliableVoicemail && makesUnsupportedVoicemailClaim(text);
  // PROSPECT-SIDE CONTACT. Same shape as the voicemail gate: computed once
  // from the SELECTED findings, and inert on the probes whose own evidence
  // genuinely records a reply from the enquirer.
  const prospectReplyEvidenced = evidenceShowsProspectReply(selectedFindings);
  const prospectReplyFailure = (text) => !prospectReplyEvidenced && claimsProspectReply(text);
  // RELATIONSHIP SUPPORT, built once from the same SELECTED findings every
  // other guard here reads, plus the probe's own enquiry. The two booleans are
  // handed over rather than recomputed so the relationship layer and the
  // guards above can never disagree about whether this probe evidences a
  // prospect reply or an unknown call record.
  const relationshipSupport = buildSupportContext({
    probe,
    findings: selectedFindings,
    // The deterministic contact counts, for the one-authoritative-count rule.
    // Same row buildOpportunityShape() already prints into the prompt as "the
    // only counts you may cite", so the guard and the brief cannot disagree
    // about how many times the agency came back.
    intelligence,
    prospectContactEvidenced: prospectReplyEvidenced,
    callContentUnknown: unreliableVoicemail,
  });
  const relationshipFailure = (text) => findUnsupportedRelationship(text, relationshipSupport);
  // One check object per field. The reason is the detector's own verdict, so
  // the correction names the actual join that was invented rather than a
  // generic "unsupported" — same shape hookFailure already uses.
  const relationshipCheck = (text) => {
    const reason = relationshipFailure(text);
    return { reason: reason || 'unsupported_relationship', failed: Boolean(reason) };
  };
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
    asContinuation(emailVariable(result.fair_observation, allowedFigure, enquiryAddress), FIXED_PREFIX_PATTERNS.fairObservation, protectedWords),
    [
      { reason: 'snuck_criticism', failed: readsAsSnuckCriticism(result.fair_observation) },
      { reason: 'detached_third_person', failed: readsAsDetachedThirdPerson(result.fair_observation) },
      { reason: 'perspective_inversion', failed: readsAsPerspectiveInversion(result.fair_observation) },
      relationshipCheck(emailVariable(result.fair_observation, allowedFigure, enquiryAddress)),
    ],
  );

  // main_finding stays blank on a no-response probe by design: the demo's
  // complete_miss shell tells that story itself and has no beat to put it in.
  const mainFindingText = asContinuation(emailVariable(result.main_finding, allowedFigure, enquiryAddress), FIXED_PREFIX_PATTERNS.mainFinding, protectedWords);
  const mainFinding = mainIndex === null || noHumanContact ? '' : gate(
    'main_finding', mainFindingText,
    [
      { reason: 'perspective_inversion', failed: readsAsPerspectiveInversion(result.main_finding) },
      { reason: 'unsupported_prospect_reply', failed: prospectReplyFailure(mainFindingText) },
      { reason: 'false_chronology', failed: readsAsFalseChronology(mainFindingText) },
      { reason: 'unsupported_voicemail_claim', failed: voicemailFailure(mainFindingText) },
      relationshipCheck(mainFindingText),
    ],
  );

  const consequenceText = stripThatMeantPrefix(emailVariable(result.commercial_consequence, allowedFigure, enquiryAddress), protectedWords);
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
      { reason: 'unsupported_prospect_reply', failed: prospectReplyFailure(consequenceText) },
      { reason: 'false_chronology', failed: readsAsFalseChronology(consequenceText) },
      { reason: 'unsupported_voicemail_claim', failed: voicemailFailure(consequenceText) },
      relationshipCheck(consequenceText),
    ],
  );

  // ── Instantly variables ──
  //
  // THE PROBE RULE, applied to all three lines. Once a real person came back
  // on this enquiry, the next move was ours and we deliberately never made it,
  // so an outcome that needed our reply is not the agency's failure — see
  // agencyMadeNextStepAttempt(). On a probe that got no genuine response the
  // same sentences are accurate and stay allowed.
  const nextStepWasOurs = agencyMadeNextStepAttempt(intelligence);
  const unfairCriticism = (text) => nextStepWasOurs && readsAsUnfairOutcomeCriticism(text);

  // SELLER-PRICE PROVENANCE, on the three gates below. Each is tested against
  // the model's RAW text, because the sanitised text has already had the price
  // surgically removed — and that de-priced text is exactly what gate() banks
  // as the soft fallback. So the bounded correction gets one chance to rewrite
  // the line properly, and if it misses, the de-priced line is persisted
  // rather than the blank the old sentence-level guard left behind.
  const observationText = normaliseEmailSentence(result.email_observation, allowedFigure, enquiryAddress);
  const emailObservation = gate('email_observation', observationText, [
    { reason: 'fake_positive', failed: noHumanContact && readsAsFakePositiveWithoutResponse(observationText) },
    { reason: 'seller_price_attribution', failed: attributesEnquiryPriceToSeller(result.email_observation) },
    { reason: 'unfair_outcome_criticism', failed: unfairCriticism(observationText) },
    { reason: 'seller_address_attribution', failed: attributesEnquiryAddressToSeller(result.email_observation, enquiryAddress) },
    { reason: 'unsupported_prospect_reply', failed: prospectReplyFailure(observationText) },
    { reason: 'false_chronology', failed: readsAsFalseChronology(observationText) },
    { reason: 'unsupported_voicemail_claim', failed: voicemailFailure(observationText) },
    relationshipCheck(observationText),
    { reason: 'unselected_finding', failed: introducesUnselectedFinding(observationText, selectedFindings, orderedFindings, probe) },
    { reason: 'unasked_questions', failed: claimsUnaskedQuestions(observationText) },
    { reason: 'consultant_speak', failed: readsAsConsultantSpeak(observationText) },
    { reason: 'third_person_prospect', failed: readsAsThirdPersonProspect(observationText) },
    { reason: 'too_long', failed: wordCount(observationText) > EMAIL_OBSERVATION_MAX_WORDS },
  ]);

  const hookText = normaliseEmailSentence(result.email_commercial_hook, allowedFigure, enquiryAddress);
  const hookFailure = hookFailureAgainstObservation(hookText, observationText);
  const emailCommercialHook = gate('email_commercial_hook', hookText, [
    { reason: 'seller_price_attribution', failed: attributesEnquiryPriceToSeller(result.email_commercial_hook) },
    { reason: 'unfair_outcome_criticism', failed: unfairCriticism(hookText) },
    { reason: 'seller_address_attribution', failed: attributesEnquiryAddressToSeller(result.email_commercial_hook, enquiryAddress) },
    { reason: 'unsupported_prospect_reply', failed: prospectReplyFailure(hookText) },
    { reason: 'false_chronology', failed: readsAsFalseChronology(hookText) },
    { reason: 'unsupported_voicemail_claim', failed: voicemailFailure(hookText) },
    relationshipCheck(hookText),
    { reason: 'unselected_finding', failed: introducesUnselectedFinding(hookText, selectedFindings, orderedFindings, probe) },
    { reason: 'third_person_prospect', failed: readsAsThirdPersonProspect(hookText) },
    { reason: hookFailure || 'restates_observation', failed: Boolean(hookFailure) && hookFailure !== 'blank' },
  ]);

  // EMAIL 2. Judged against BOTH Email 1 lines — the observation it must not
  // repeat and the hook it must not repeat either — using the model's own
  // sanitised text rather than the gated values, so a rejected Email 1 line
  // cannot make a repetitive second hook look original.
  const secondHookText = normaliseEmailSentence(result.email_commercial_hook_email_2, allowedFigure, enquiryAddress);
  const secondFailure = secondHookFailure(secondHookText, observationText, hookText);
  const emailCommercialHookEmail2 = gate('email_commercial_hook_email_2', secondHookText, [
    { reason: 'seller_price_attribution', failed: attributesEnquiryPriceToSeller(result.email_commercial_hook_email_2) },
    { reason: 'unfair_outcome_criticism', failed: unfairCriticism(secondHookText) },
    { reason: 'seller_address_attribution', failed: attributesEnquiryAddressToSeller(result.email_commercial_hook_email_2, enquiryAddress) },
    { reason: 'unsupported_prospect_reply', failed: prospectReplyFailure(secondHookText) },
    { reason: 'false_chronology', failed: readsAsFalseChronology(secondHookText) },
    { reason: 'unsupported_voicemail_claim', failed: voicemailFailure(secondHookText) },
    relationshipCheck(secondHookText),
    { reason: 'unselected_finding', failed: introducesUnselectedFinding(secondHookText, selectedFindings, orderedFindings, probe) },
    { reason: 'third_person_prospect', failed: readsAsThirdPersonProspect(secondHookText) },
    { reason: secondFailure || 'restates_observation', failed: Boolean(secondFailure) && secondFailure !== 'blank' },
  ]);

  // pickHeroJourney's own contract is unchanged — it still reads
  // novus_opportunity off the object it is given. It is simply given an object
  // that holds nothing else.
  const heroJourney = pickHeroJourney(intelligence, orderedFindings, { novus_opportunity: novusOpportunity });
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
      email_commercial_hook_email_2: emailCommercialHookEmail2,
    },
  };
}

export const _internal = {
  TOOL, SYSTEM_PROMPT, MAX_PERSONALISATION_ATTEMPTS, MODEL_FIXABLE_FIELDS, REPAIR_NOTES,
  NEVER_PERSIST_REASONS, SELECTION_FIELDS, EMAIL_OBSERVATION_MAX_WORDS,
  EMAIL_2_HOOK_MAX_WORDS, UNFAIR_OUTCOME_CRITICISM,
  ENQUIRY_VOCABULARY,
  PROSPECT_REPLY_CLAIMS, CALL_CONTENT_ABSENCE_CLAIMS, CONTENT_UNAVAILABLE_MARKERS,
  PROSPECT_OWNERSHIP_RE, EVIDENCE_BOUNDED_RE,
  buildCandidate, buildPrompt, normalize, computeScaleFact, isUnknownAddress, cleanAddressForEmail,
  emailVariable, ensureSentenceEnd, asStandaloneSentence, wordCount, findingTokens,
  readsAsFakePositiveWithoutResponse, HERO_JOURNEYS, INTERNAL_REASONING_PATTERNS,
  FALSE_CHRONOLOGY_PATTERNS, ORIGINAL_DECLARATION_MARKERS,
  RELATIONSHIP_REPAIR_NOTES,
  CONSULTANT_SPEAK, AGENCY_OUTCOME_NOUNS,
  DETACHED_THIRD_PERSON_PATTERNS, THIRD_PERSON_PROSPECT_PATTERNS,
};
