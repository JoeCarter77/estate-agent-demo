// lib/demos.mjs — the DEMOS tab: one row = one personalised demo.
//
// THE LAST STEP OF THE PIPELINE:
//   PROBE -> COMMUNICATIONS -> INTELLIGENCE -> DIAGNOSIS ->
//   DIAGNOSIS_FINDINGS -> PERSONALISATION -> DEMOS
//
// A DEMOS row is a SELF-CONTAINED, RENDER-READY SNAPSHOT, compiled
// automatically the moment PERSONALISATION completes for a probe
// (lib/demo-compile.mjs, called from lib/rebuild-pass.mjs). Opening
// /demo/{demo_slug} is therefore: find slug in DEMOS -> load that one row ->
// render. No AI, no multi-sheet join, no Rightmove request, no compilation of
// any kind happens at prospect page-load time.
//
// DUPLICATION HERE IS THE POINT. Fields are copied down from PROBES,
// AGENCIES, INTELLIGENCE, DIAGNOSIS_FINDINGS and PERSONALISATION so that one
// row answers everything the page needs to render AND everything a human
// needs to debug why a demo says what it says. The only fields deliberately
// absent are ones that would be derivable from another column on the same row
// with no added meaning.
//
// STRICTLY DOWNSTREAM. Nothing in this file, or in anything that calls it,
// writes back into the pipeline. A demo can be recompiled, re-slugged or
// archived without touching a single upstream row.
//
// THE SHELL IS ONE DEMO, NOT FOUR. hero_journey selects which content is
// written into this row; the renderer (demo.html) knows nothing about journeys
// and simply renders whatever the row carries. Adding a journey is therefore
// authoring content in lib/demo-journeys.mjs — never a second demo page.
//
// AND IT IS ONE SCROLL, NOT FOUR STEPS. The four beats are acts in a single
// continuous story the prospect scrolls through in about a minute, so
// everything written onto this row is sized for a glance: a metric, a real
// artefact, one sentence. Nothing here is paced for a page they have to
// finish before seeing the next one.
//
// Layout convention, same as every other tab in this workbook:
//   row 1 = header, row 2 = "SCHEMA NOTE ...", row 3+ = data.

import { newDemoId } from './ids.mjs';
import { hasVendorDeclaration, vendorDeclarationText } from './vendor-intent.mjs';
import { cleanAddressForEmail, formatEnquiryDate } from './probe-personalisation.mjs';
import {
  buildJourneyContent, journeySupport, SUPPORTED_HERO_JOURNEYS,
  // The prospect-facing wording for the two INTELLIGENCE ordinals, imported
  // rather than restated so the evidence block and the hero can never
  // describe the same ordinal two different ways.
  VIEWING_PROGRESSION_SENTENCE, SELLER_OPPORTUNITY_SENTENCE,
} from './demo-journeys.mjs';
// probe.observation_deadline, or probe_timestamp + 4 days for the historical
// probes that never had one written. Reused so "the four-day observation
// period" in the demo is the SAME window the grade was decided over.
import { resolveObservationDeadline } from './grading.mjs';
// Both PURE, DETERMINISTIC helpers already used by the Intelligence rollup
// (lib/observation.mjs) — a phrase/rule classifier and a time-window grouper,
// neither of which calls an AI model. Reused here, not reimplemented, so
// "which touches count as human" and "which touches are the same attempt"
// can never disagree between INTELLIGENCE and the demo's own evidence.
import { isHumanCommunication } from './classification.mjs';
import { groupContactAttempts } from './observation.mjs';

export const DEMOS_TAB = 'DEMOS';

// Bumped when the SHAPE of the render-ready payload changes in a way the
// renderer cares about, so a stale row is identifiable rather than silently
// half-rendered.
export const DEMO_VERSION = 6;

// The lifecycle is compile-driven, not publish-driven — there is no manual
// step between "PERSONALISATION finished" and "the link is sendable".
//   ready         every piece of content the demo needs is present
//   needs_review  compiled, but something critical is missing or unreviewed
//                 (review_reasons says what) — resolves, flagged, so it can
//                 be looked at rather than silently sent
//   archived      deliberately retired; the link 404s
export const DEMO_STATUSES = ['ready', 'needs_review', 'archived'];

// property_image_status — why the hero photo is (or isn't) there, and whether
// a later pass should try again.
//   ok           extracted and stored
//   manual       supplied by hand; never overwritten by an extraction
//   unavailable  tried and failed (blocked, dead listing, no media) — NOT
//                retried automatically, so a dead listing isn't re-fetched
//                every pass; --refresh-image forces another go
//   pending      not attempted yet (the pass's image budget ran out) — the
//                next pass picks it up
//   none         the probe carries no property_url to try
export const PROPERTY_IMAGE_STATUSES = ['ok', 'manual', 'unavailable', 'pending', 'none'];

// The canonical column order. `repo.appendRecord` maps object keys onto the
// LIVE header, so a workbook whose DEMOS tab is missing a column simply does
// not persist it — this list is what the tab should be created with.
export const DEMOS_HEADER = [
  // ── identity ──────────────────────────────────────────────────────────────
  'demo_id', 'demo_slug', 'demo_status', 'demo_version', 'review_reasons',
  // ── links back to the pipeline (for cross-reference and debugging) ────────
  'agency_id', 'probe_id', 'probe_reference', 'personalisation_id', 'hero_journey',
  // ── beat 1 — the real event ───────────────────────────────────────────────
  'agency_name',
  'property_address', 'property_price', 'property_url',
  'property_image_url', 'property_image_status',
  'portal', 'enquiry_at', 'enquiry_date', 'enquiry_time',
  // ── beat 2 — the observed facts, copied down from INTELLIGENCE ────────────
  'seller_declared', 'human_contact', 'response_time', 'response_hours',
  'contact_attempts', 'follow_ups', 'channels_used',
  'viewing_progression', 'seller_recognition', 'grade',
  // ── the copy the prospect reads ───────────────────────────────────────────
  'demo_headline', 'demo_hook', 'positive_observation',
  'demo_reveal', 'demo_reveal_support', 'main_finding', 'commercial_consequence',
  'novus_transition', 'scale_line', 'systemic_bridge', 'cta_headline',
  // ── beat 2/3 collections (JSON, deliberately short) ───────────────────────
  'observed_events_json', 'novus_detected_json', 'novus_decisions_json', 'novus_actions_json',
  // ── compilation provenance ────────────────────────────────────────────────
  'created_at', 'updated_at', 'compiled_at', 'compiled_by', 'ready_at',
  // ── analytics — NEVER reset by a recompile ────────────────────────────────
  'first_viewed_at', 'last_viewed_at', 'view_count', 'cta_clicked_at', 'meeting_booked_at',
];

// Written by the compiler, preserved verbatim by every recompile. Listed once,
// here, so "which fields survive a rebuild" is a fact in code rather than a
// convention someone has to remember.
export const ANALYTICS_COLUMNS = [
  'first_viewed_at', 'last_viewed_at', 'view_count', 'cta_clicked_at', 'meeting_booked_at',
];

// Columns the browser must never receive. Everything else on the row is
// prospect-safe by construction (it is the copy they read), but the pipeline
// keys are ours.
const INTERNAL_COLUMNS = new Set(['agency_id', 'probe_id', 'personalisation_id', 'demo_id']);

export { SUPPORTED_HERO_JOURNEYS };

// ── small helpers ────────────────────────────────────────────────────────────

function text(value) { return String(value ?? '').trim(); }

// HOUSE STYLE: no em or en dashes in prospect-facing copy — only the small
// hyphen. Applied to every string this file writes onto the row, including the
// AI-authored PERSONALISATION sentences, so the demo reads consistently
// whoever wrote the sentence. demo.html applies the same rule again at render
// time, which is what keeps a row compiled by an earlier build correct.
export function normaliseDashes(value) {
  return text(value).replace(/\s*[\u2014\u2013]\s*/g, ' - ').trim();
}

// The same rule over a collection's own label/detail strings, which are the
// other half of what the prospect reads.
function normaliseCollection(items) {
  return (Array.isArray(items) ? items : []).map((item) => {
    const out = { ...item };
    if ('label' in out) out.label = normaliseDashes(out.label);
    if ('detail' in out) out.detail = normaliseDashes(out.detail);
    return out;
  });
}

// PERSONALISATION's email fields are CONTINUATIONS of a locked prefix
// ("I want to say upfront that " + fair_observation). The demo prints them as
// standalone sentences, so the first letter is raised — the sentence itself is
// never rewritten.
export function sentenceCase(value) {
  const v = text(value);
  if (!v) return '';
  return v.charAt(0).toUpperCase() + v.slice(1);
}

// 0.38 -> "23 minutes" · 1.2 -> "1 hour 12 minutes" · 17.85 -> "17.9 hours"
// · 50 -> "2 days". Blank for anything unparseable, which is the honest
// answer when INTELLIGENCE never established a response time.
export function formatResponseTime(hours) {
  const h = parseFloat(hours);
  if (!Number.isFinite(h) || h < 0) return '';
  const minutes = Math.round(h * 60);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  if (h < 24) {
    const whole = Math.floor(h);
    const rem = Math.round((h - whole) * 60);
    if (rem === 0) return `${whole} hour${whole === 1 ? '' : 's'}`;
    if (whole < 3) return `${whole} hour${whole === 1 ? '' : 's'} ${rem} minute${rem === 1 ? '' : 's'}`;
    return `${h.toFixed(1)} hours`;
  }
  const days = Math.round(h / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

// '2026-08-11T21:21:04Z' -> '21:21'. Europe/London, for the same reason
// formatEnquiryDate() uses it: an evening probe must show the clock time the
// agency would recognise, not the UTC one.
export function formatEnquiryTime(probeTimestamp) {
  const d = new Date(probeTimestamp);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/London',
  }).format(d);
}

// "voice,email" -> "phone and email". Display only; channels_used is stored raw.
export function formatChannels(channelsUsed) {
  const names = { voice: 'phone', email: 'email', sms: 'SMS', whatsapp: 'WhatsApp' };
  const list = text(channelsUsed).split(',').map((c) => names[c.trim().toLowerCase()] || c.trim()).filter(Boolean);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

// ── the one thing prospect-facing copy may never say ─────────────────────────
//
// THE LISTING PRICE IS NOT THE ENQUIRER'S OWN HOUSE. PERSONALISATION is
// allowed to cite the confirmed property price to give the BUYER enquiry a
// scale ("a £225,000 buyer enquiry"), and on a seller journey that same
// licence produces the one claim this demo must never make: attaching that
// figure to the vendor opportunity ("a potential £650,000 seller instruction")
// asserts a value for a property nobody has seen, let alone valued.
//
// So the demo strips a currency amount that sits in the same clause as a
// seller-side term, and leaves the sentence otherwise untouched — "a potential
// seller instruction sitting inside the same enquiry was never explored". The
// point survives; the invented number does not. Buyer-side money, which IS the
// price of the listing they enquired about, is left exactly as written.
//
// This runs at COMPILE time, on the demo's copy only. Nothing is written back
// into PERSONALISATION, and the email is unaffected.
const SELLER_SIDE_TERM = /\b(sell|selling|seller|sellers|sale|vendor|vendors|instruction|instructions|valuation|valuations|appraisal|appraisals)\b/i;
const CURRENCY = /£\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|bn))?/gi;

// How much text either side of a figure counts as "the same claim". Kept
// generous on purpose: over-stripping costs a number, under-stripping ships
// an invented valuation.
const CLAIM_WINDOW = 60;

export function stripUnsafeSellerValue(sentence) {
  const value = text(sentence);
  if (!value.includes('£')) return value;

  let out = '';
  let cursor = 0;
  for (const match of value.matchAll(CURRENCY)) {
    const at = match.index;
    const after = at + match[0].length;
    // Whole words only, so a window never cuts "sale" into "sal".
    const before = value.slice(Math.max(0, at - CLAIM_WINDOW), at).replace(/^\S*/, '');
    const trailing = value.slice(after, after + CLAIM_WINDOW).replace(/\S*$/, '');
    if (!SELLER_SIDE_TERM.test(`${before} ${trailing}`)) continue;
    out += value.slice(cursor, at);
    cursor = after;
  }
  if (cursor === 0) return value;
  out += value.slice(cursor);

  return out
    // "a  enquiry" -> "an enquiry": dropping the figure leaves the article
    // disagreeing with the noun it now sits against.
    .replace(/\b(an?)\s{2,}(\w+)/gi, (_m, _article, next) => `${/^[aeiou]/i.test(next) ? 'an' : 'a'} ${next}`)
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;])/g, '$1')
    .trim();
}

// ── slug ─────────────────────────────────────────────────────────────────────

export function slugify(value) {
  return text(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

// A readable, stable, guessable-but-not-enumerable-enough slug:
//   "Ensum Brown" + "RM-0031" -> "ensum-brown-rm-0031"
// Deterministic, so rebuilding the same probe's demo keeps the same URL. A
// collision with a DIFFERENT probe gets a numeric suffix rather than silently
// stealing the existing demo's URL.
export function buildDemoSlug({ agencyName, probeReference, probeId }, takenBy = new Map()) {
  const base = [slugify(agencyName), slugify(probeReference)].filter(Boolean).join('-')
    || slugify(probeId)
    || 'demo';
  const owner = takenBy.get(base);
  if (!owner || owner === probeId) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${n}`;
    const candidateOwner = takenBy.get(candidate);
    if (!candidateOwner || candidateOwner === probeId) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

// ── the observed-event list (beat 2) ─────────────────────────────────────────
//
// SHORT ON PURPOSE. The brief is "the minimum real evidence needed to make the
// finding convincing" — not a communications dump. Every entry is a fact this
// probe's own INTELLIGENCE row establishes; nothing here is authored prose and
// nothing is invented when the underlying field is blank.
//
// tone: 'neutral' (it happened) · 'good' (they did this well) · 'gap' (the
// thing that did not happen). The renderer colours on tone alone.

const VIEWING_PROGRESSION_LABELS = {
  none: 'Viewing never progressed',
  mentioned: 'Viewing mentioned',
  invited: 'Buyer invited to view',
  availability_requested: 'Viewing availability requested',
  slot_offered: 'Viewing slot offered',
  booked: 'Viewing booked',
};

const SELLER_RECOGNITION_LABELS = {
  none: 'Seller position never raised',
  asked_position: 'Seller position asked about, never taken further',
  acknowledged: 'Seller acknowledged, no valuation offered',
  valuation_offered: 'Valuation offered',
  valuation_booked: 'Valuation booked',
};

// Everything below valuation_offered leaves the instruction unconverted.
const SELLER_RECOGNITION_CONVERTED = new Set(['valuation_offered', 'valuation_booked']);

// ── the chronological story, from COMMUNICATIONS (beat 2) ───────────────────
//
// ZERO AI. Every line below is picked and worded by FIXED RULES over fields
// the pipeline already wrote when the message arrived — occurred_at, channel,
// automated_or_human (read through isHumanCommunication(), the same
// deterministic classifier lib/observation.mjs's rollups already use),
// voicemail_present, and the message's own stored transcript/body_text/
// subject — plus the two INTELLIGENCE ordinals this probe carries. Nothing
// here calls lib/ai-client.mjs; nothing invents agency behaviour. A shown
// excerpt is a literal sentence lifted from text already sitting on the row.
//
// IT READS AS A CHRONOLOGY, not as a pile of artefacts:
//
//   ENQUIRY SENT ABOUT THIS PROPERTY  what the buyer declared, and whether
//                                     that property was already on the market
//   FIRST RESPONSE                    the most useful sentence of the first
//                                     human touch — or, when that touch was an
//                                     unanswered call, simply "Voicemail left."
//   OTHER CONTACT ATTEMPTS            what the remaining genuine attempts were
//                                     for, and what they still never covered
//
// "Relevant to the stored hero_journey" is satisfied by the DATA, not by a
// branch on hero_journey: a complete_miss probe has no human touches, so the
// last two blocks are absent and the metric strip carries the demo. Branching
// on hero_journey here would duplicate what lib/demo-journeys.mjs already owns
// — this file stays journey-blind, same as the renderer.

// One sentence, not a paragraph. Long enough to carry a real question the
// agency asked; short enough to stay one line of evidence.
const EXCERPT_MAX_CHARS = 170;
// A chosen sentence shorter than this is paired with the one after it, so
// "Thanks for getting in touch." never stands alone as "the useful bit".
const EXCERPT_MIN_USEFUL_CHARS = 45;

function toBool(value) { return value === true || value === 'TRUE' || value === 'true'; }

// What makes a sentence the one worth showing: it demonstrates what the agency
// actually DID. Fixed phrase lists, in the same spirit as
// lib/classification.mjs — never a model call, never a rewrite.
const USEFUL_SENTENCE = [
  /\bviewing|\bview\b|\bappointment|\bavailabilit|\bavailable\b|\bslot\b|\bbook/i,
  /\b(mon|tues|wednes|thurs|fri|satur|sun)day\b|\bthis week\b|\bnext week\b|\bweekend\b|\btomorrow\b/i,
  /\bvaluation|\bappraisal|\bon the market\b|\bto sell\b|\bselling\b|\bsell\b/i,
  /\bmortgage|\bproceed|\bposition\b|\bchain\b|\bcash buyer\b|\bbudget\b|\btimescale/i,
  /\bcall\b|\bcalling\b|\bphone\b|\bring\b|\bspeak\b|\bdiscuss\b/i,
];
// Openers, sign-offs and boilerplate. They are the first thing in the message,
// which is exactly why a plain prefix truncation used to show them.
const PLEASANTRY_SENTENCE = [
  /^(hi|hello|hey|dear|good (morning|afternoon|evening))\b[^?]*$/i,
  /^(many )?thanks\b|^thank you\b/i,
  /^(kind|best|warm) regards\b|^regards\b|^all the best\b/i,
  /^(i hope|hope you)\b/i,
  /\bunsubscribe\b|\bconfidential\b|\bregistered (in|office)\b/i,
];

function sentencesOf(source) {
  return text(source)
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function sentenceScore(sentence) {
  let score = 0;
  for (const pattern of USEFUL_SENTENCE) if (pattern.test(sentence)) score += 2;
  if (sentence.includes('?')) score += 1;
  for (const pattern of PLEASANTRY_SENTENCE) if (pattern.test(sentence)) { score -= 3; break; }
  return score;
}

function truncate(value, max = EXCERPT_MAX_CHARS) {
  const flat = text(value);
  return flat.length > max ? `${flat.slice(0, max).trim()}…` : flat;
}

// THE MOST USEFUL SENTENCE, NOT THE FIRST FEW WORDS. Deterministic: split the
// stored text into sentences, score each one against the fixed lists above,
// take the highest (earliest wins a tie), and pair it with the sentence after
// it when it is too short to stand alone. The result is always a literal
// extract of the message — never a summary and never a reworded one.
export function bestExcerpt(comm) {
  const source = text(comm?.transcript) || text(comm?.body_text) || text(comm?.subject);
  if (!source) return '';
  const sentences = sentencesOf(source);
  if (sentences.length === 0) return '';

  let bestIndex = 0;
  let bestScore = -Infinity;
  sentences.forEach((sentence, index) => {
    const score = sentenceScore(sentence);
    if (score > bestScore) { bestScore = score; bestIndex = index; }
  });

  let excerpt = sentences[bestIndex];
  const next = sentences[bestIndex + 1];
  if (next && excerpt.length < EXCERPT_MIN_USEFUL_CHARS && `${excerpt} ${next}`.length <= EXCERPT_MAX_CHARS) {
    excerpt = `${excerpt} ${next}`;
  }
  return truncate(excerpt);
}

function occurredAtOf(comm) { return text(comm?.occurred_at) || text(comm?.received_at); }

// A parsed Date, or null — matches lib/observation.mjs's own `_occurredAt`
// convention exactly, since groupContactAttempts() (imported from there)
// expects each item to carry a real Date at that key, not a timestamp number.
function occurredAtDate(comm) {
  const d = new Date(occurredAtOf(comm));
  return Number.isNaN(d.getTime()) ? null : d;
}

const EVIDENCE_CHANNEL_LABELS = { voice: 'phone', email: 'email', sms: 'SMS', whatsapp: 'WhatsApp' };
function evidenceChannelLabel(channel) {
  return EVIDENCE_CHANNEL_LABELS[String(channel || '').trim().toLowerCase()] || text(channel) || 'a message';
}

// Chronological, human-classified touches only — an automated acknowledgement
// is never evidence of the team having done something.
function sortedHumanTouches(communications) {
  return (communications || [])
    .filter((c) => isHumanCommunication(c))
    .map((c) => ({ ...c, _occurredAt: occurredAtDate(c) }))
    .filter((c) => c._occurredAt !== null)
    .sort((a, b) => a._occurredAt - b._occurredAt);
}

// Automated messages that genuinely preceded the first human touch. Keeping
// this beside sortedHumanTouches() means the evidence chronology continues to
// use the same timestamps and human/automated classifier as INTELLIGENCE.
function automatedTouchesBefore(communications, firstHumanTouch) {
  const firstHumanAt = firstHumanTouch?._occurredAt;
  if (!(firstHumanAt instanceof Date)) return [];
  return (communications || [])
    .filter((c) => !isHumanCommunication(c))
    .map((c) => ({ ...c, _occurredAt: occurredAtDate(c) }))
    .filter((c) => c._occurredAt !== null && c._occurredAt < firstHumanAt)
    .sort((a, b) => a._occurredAt - b._occurredAt);
}

function automatedTiming(firstAutomated, enquiryAt) {
  const enquiry = new Date(enquiryAt);
  if (!firstAutomated?._occurredAt || Number.isNaN(enquiry.getTime())) return 'before the first human response';
  const hours = (firstAutomated._occurredAt.getTime() - enquiry.getTime()) / (60 * 60 * 1000);
  if (!Number.isFinite(hours) || hours < 0) return 'before the first human response';
  if (hours <= (5 / 60)) return 'straight away';
  const elapsed = formatResponseTime(hours);
  return elapsed ? `${elapsed} after the enquiry` : 'before the first human response';
}

// Automated acknowledgements are different from human replies: their opening
// is usually the evidence worth showing, rather than a later viewing or call
// sentence. Keep at most the first two stored sentences and never rewrite it.
function automatedExcerpt(comm) {
  const source = text(comm?.transcript) || text(comm?.body_text) || text(comm?.subject);
  if (!source) return '';
  return truncate(sentencesOf(source).slice(0, 2).join(' '));
}

function automatedLead(automated, { enquiryAt = '', responseTime = '' } = {}) {
  if (automated.length === 0) return '';

  let acknowledgement;
  if (automated.length === 1) {
    const first = automated[0];
    const excerpt = automatedExcerpt(first);
    acknowledgement = `An automated ${evidenceChannelLabel(first.channel)} was sent ${automatedTiming(first, enquiryAt)}`
      + (excerpt ? ` saying "${excerpt}"${/[.!?…]$/.test(excerpt) ? '' : '.'}` : '.');
  } else {
    const channels = formatChannels(
      [...new Set(automated.map((c) => text(c.channel)).filter(Boolean))].join(','),
    );
    acknowledgement = `Automated messages${channels ? ` by ${channels}` : ''} acknowledged the enquiry.`;
  }

  const humanTiming = responseTime
    ? `The first meaningful human response came ${responseTime} after the enquiry.`
    : 'The first meaningful human response followed later.';
  return `${acknowledgement} ${humanTiming}`;
}

// The story labels. Fixed, so the section always reads in the same order
// whatever a given probe's data turns out to contain, and never phrased in a
// way that lets an automated acknowledgement pass for a human response.
export const STORY_LABELS = {
  enquiry: 'Enquiry sent',
  firstResponse: 'First meaningful response',
  fastFirstResponse: 'Fast first response',
  automatedAck: 'Automated acknowledgement',
  noHumanResponse: 'No meaningful human response',
  viewingProgression: 'Buyer / viewing progression',
  whatHappenedNext: 'What happened next',
  sellerOpportunity: 'Seller opportunity',
};

// Under this, the first response is stated as fast — which is a fact about the
// measured lag, not about which journey is running. An agency that answered in
// minutes is told so on every journey.
const FAST_RESPONSE_HOURS = 1;

// WHAT THE BUYER DECLARED, from the probe's own declaration clause — including
// whether that property was already on the market, which is the part that
// makes it a pre-market seller lead rather than a competitor's instruction.
// Never asserted: a declaration that does not state a market position produces
// the shorter sentence rather than a guessed one.
const NOT_ON_MARKET = /\bnot\s+(?:yet\s+)?on the market\b/i;
const ALREADY_ON_MARKET = /\b(?:already|currently)\s+on the market\b|\bon the market\s+(?:with|through)\b/i;

export function sellerDeclarationSummary(declarationText) {
  const declaration = text(declarationText);
  const opening = 'Buyer declared they also had a property to sell';
  if (NOT_ON_MARKET.test(declaration)) return `${opening}, and that it was not yet on the market.`;
  if (ALREADY_ON_MARKET.test(declaration)) return `${opening}, and that it was already on the market.`;
  return `${opening}.`;
}

// What the remaining attempts were FOR, from INTELLIGENCE.viewing_progression
// alone. Blank where the ordinal does not establish it — the demo never tells
// an agency what its own follow-ups were about.
const VIEWING_FOCUS = new Set(['mentioned', 'invited', 'availability_requested', 'slot_offered', 'booked']);
function viewingFocusClause(intelligence) {
  return VIEWING_FOCUS.has(text(intelligence?.viewing_progression)) ? ', focused on progressing the viewing' : '';
}

// ── the two ordinals, in prospect-facing language ───────────────────────────
//
// Imported, not restated: lib/demo-journeys.mjs owns the wording so the
// evidence block and the hero can never describe the same ordinal two
// different ways. In particular `asked_position` is RECOGNITION everywhere —
// the seller opportunity was seen and not progressed, never "missed".

// Everything below valuation_offered leaves the vendor opportunity
// unprogressed — including asked_position, which IS recognition.
const SELLER_PROGRESSED = new Set(['valuation_offered', 'valuation_booked']);

function viewingProgressionEvent(intelligence) {
  const progression = text(intelligence?.viewing_progression);
  const sentence = VIEWING_PROGRESSION_SENTENCE[progression];
  if (!sentence) return null;
  return {
    label: STORY_LABELS.viewingProgression,
    detail: sentence,
    tone: VIEWING_FOCUS.has(progression) && progression !== 'mentioned' ? 'good' : 'gap',
  };
}

function sellerOpportunityEvent(intelligence) {
  const recognition = text(intelligence?.seller_recognition);
  const sentence = SELLER_OPPORTUNITY_SENTENCE[recognition];
  if (!sentence) return null;
  return {
    label: STORY_LABELS.sellerOpportunity,
    detail: sentence,
    tone: SELLER_PROGRESSED.has(recognition) ? 'good' : 'gap',
  };
}

// "four-day" for the standard window, so the no-response line can say exactly
// how long nothing happened for. Anything unusual degrades to the honest
// generic phrasing rather than a wrong number.
const DAY_WORDS = ['', 'one-day', 'two-day', 'three-day', 'four-day', 'five-day', 'six-day', 'seven-day'];
export function observationWindowPhrase(observationDays) {
  const days = Math.round(Number(observationDays));
  return Number.isFinite(days) && DAY_WORDS[days] ? `the ${DAY_WORDS[days]} observation period` : 'the observation period';
}

// -> the FIRST MEANINGFUL RESPONSE / AUTOMATED ACKNOWLEDGEMENT / NO MEANINGFUL
// HUMAN RESPONSE and WHAT HAPPENED NEXT blocks, in that order.
//
// A probe nobody ever answered still produces evidence here — the ABSENCE is
// the finding, and it is stated as such rather than left as a hole in the
// page. An automated acknowledgement is shown, labelled as automated, and is
// never counted as a response.
export function selectCommunicationEvidence({
  communications, intelligence = {}, sellerDeclared = false,
  responseTime = '', responseHours = '', observationDays = null, enquiryAt = '',
} = {}) {
  const touches = sortedHumanTouches(communications);
  const events = [];

  // ── nobody human ever answered ──
  if (touches.length === 0) {
    const auto = (communications || [])
      .filter((c) => !isHumanCommunication(c) && occurredAtDate(c) !== null)
      .sort((a, b) => occurredAtDate(a) - occurredAtDate(b))[0];

    if (auto) {
      const excerpt = bestExcerpt(auto);
      events.push({
        label: STORY_LABELS.automatedAck,
        // Named as automated in the label AND in the sentence: the one thing
        // this block may never do is read as though somebody replied.
        detail: `An automated acknowledgement was sent by ${evidenceChannelLabel(auto.channel)}.`
          + (excerpt ? ` "${excerpt}"` : '')
          + ' No person followed it.',
        tone: 'neutral',
      });
    }

    events.push({
      label: STORY_LABELS.noHumanResponse,
      detail: `No meaningful human contact was recorded by email, phone or SMS during ${observationWindowPhrase(observationDays)}.`,
      tone: 'gap',
    });
    return events;
  }

  // ── 1) FIRST MEANINGFUL RESPONSE ──
  // The delay leads, because on every journey it is the first thing the owner
  // wants to know. An unanswered call has no useful sentence in it: the fact
  // IS the voicemail.
  const first = touches[0];
  const firstAt = formatEnquiryTime(occurredAtOf(first));
  const channel = evidenceChannelLabel(first.channel);
  const lag = text(responseTime) ? `${responseTime} after the enquiry.` : '';

  let firstDetail;
  if (toBool(first.voicemail_present)) {
    firstDetail = 'Voicemail left.';
  } else {
    const excerpt = bestExcerpt(first);
    firstDetail = excerpt
      ? `"${excerpt}"${firstAt ? ` (${channel}, ${firstAt})` : ` (${channel})`}`
      : `Contact made by ${channel}${firstAt ? ` at ${firstAt}` : ''}.`;
  }

  const hours = parseFloat(responseHours);
  const fast = Number.isFinite(hours) && hours >= 0 && hours < FAST_RESPONSE_HOURS;
  const automated = automatedTouchesBefore(communications, first);
  const acknowledgement = automatedLead(automated, { enquiryAt, responseTime });
  events.push({
    label: fast ? STORY_LABELS.fastFirstResponse : STORY_LABELS.firstResponse,
    detail: [acknowledgement || lag, firstDetail].filter(Boolean).join(' '),
    tone: 'good',
  });

  // ── 2) WHAT HAPPENED NEXT ──
  // The remaining genuine attempts, summarised. Same 30-minute grouping
  // lib/observation.mjs uses for the INTELLIGENCE count, so "3 contact
  // attempts" in the metric strip and "2 further" here can never disagree.
  const further = groupContactAttempts(touches).slice(1);

  let attemptsSentence;
  if (further.length > 0) {
    const channels = formatChannels(
      [...new Set(further.flat().map((c) => text(c.channel)).filter(Boolean))].join(','),
    );
    const plural = further.length === 1 ? 'attempt was' : 'attempts were';
    attemptsSentence = `${further.length} further contact ${plural} made`
      + (channels ? ` by ${channels}` : '')
      + viewingFocusClause(intelligence)
      + '.';
  } else {
    attemptsSentence = 'No further contact attempt was made after the first response.';
  }

  events.push({
    label: STORY_LABELS.whatHappenedNext,
    detail: attemptsSentence,
    tone: further.length > 0 ? 'good' : 'gap',
  });

  return events;
}

// How long the enquiry was watched for, in whole days, so the no-response line
// can name the real window rather than a hard-coded "four days". Null when the
// probe carries neither a deadline nor a timestamp, which degrades to the
// generic phrasing rather than to a wrong number.
export function observationDaysFor(probe) {
  const deadline = resolveObservationDeadline(probe || {});
  const start = new Date(probe?.probe_timestamp);
  if (!deadline || Number.isNaN(deadline.getTime()) || Number.isNaN(start.getTime())) return null;
  const days = (deadline.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
  return days > 0 ? Math.round(days) : null;
}

// ── the compact factual summary + the chronological story (beat 2) ──────────
//
// TWO KINDS, ONE LIST. `kind: 'metric'` entries are the quantified summary the
// owner reads in about three seconds — every one of them a fact this probe's
// own INTELLIGENCE row establishes, never a paragraph explaining it.
// `kind: 'evidence'` entries are THE STORY, in the order it happened: what the
// enquiry declared, what came back first, and what the remaining attempts
// did and did not cover.
//
// The chronology is the point. An unordered pile of artefacts made the
// prospect assemble the sequence themselves; three labelled beats in time
// order tell it to them, and every one of them is still a fact drawn from
// their own probe rather than authored prose.
export function buildObservedEvents({
  intelligence, sellerDeclared, sellerDeclarationText = '', responseTime, communications = [],
  propertyAddress = '', enquiryDate = '', enquiryTime = '', enquiryAt = '', observationDays = null,
}) {
  const events = [];

  // ── the quantified summary ──
  if (sellerDeclared) {
    events.push({ kind: 'metric', label: '2 opportunities', detail: 'in one enquiry', tone: 'neutral' });
  }

  const attempts = parseInt(intelligence.contact_attempts, 10);
  if (Number.isFinite(attempts) && attempts > 0) {
    const channels = formatChannels(intelligence.channels_used);
    events.push({
      kind: 'metric',
      label: `${attempts} contact attempt${attempts === 1 ? '' : 's'}`,
      detail: channels || (responseTime ? `first in ${responseTime}` : ''),
      tone: attempts > 1 ? 'good' : 'neutral',
    });
  } else if (responseTime) {
    events.push({ kind: 'metric', label: `Responded in ${responseTime}`, detail: '', tone: 'good' });
  }

  const progression = text(intelligence.viewing_progression);
  if (progression) {
    events.push({
      kind: 'metric',
      label: VIEWING_PROGRESSION_LABELS[progression] || progression,
      detail: '',
      tone: progression === 'none' ? 'gap' : 'good',
    });
  }

  // Only meaningful where the enquiry actually declared a property to sell —
  // seller_recognition is blank otherwise, by design (schema §3 field 14).
  const recognition = text(intelligence.seller_recognition);
  if (sellerDeclared && recognition) {
    const converted = SELLER_RECOGNITION_CONVERTED.has(recognition);
    events.push({
      kind: 'metric',
      label: SELLER_RECOGNITION_LABELS[recognition] || recognition,
      detail: '',
      tone: converted ? 'good' : 'gap',
    });
    // A DISTINCT fact from the one above: the position may have been asked
    // about and still never have moved towards a valuation. Never stated as a
    // lost instruction — what it would have become is unknowable.
    if (!converted) {
      events.push({ kind: 'metric', label: 'No valuation progression', detail: '', tone: 'gap' });
    }
  }

  // ── the story, in the order it happened ──
  //
  // ONE ORDER FOR EVERY JOURNEY, and the DATA decides which blocks appear:
  //
  //   ENQUIRY SENT              the property, when it was sent, and what the
  //                             buyer declared
  //   FIRST MEANINGFUL RESPONSE the delay, then the useful sentence of it -
  //                             or, where nobody human ever replied, the
  //                             automated acknowledgement (labelled as such)
  //                             followed by the explicit absence
  //   BUYER / VIEWING           what was actually done on the buying side
  //   WHAT HAPPENED NEXT        the remaining genuine attempts
  //   SELLER OPPORTUNITY        what became of the declared vendor
  //
  // Branching on hero_journey here would duplicate what lib/demo-journeys.mjs
  // already owns, so this file stays journey-blind: a complete_miss probe has
  // no human touches and therefore gets the absence blocks, a stalled probe
  // has one touch and no follow-up and therefore gets "no further contact
  // attempt", and neither needed to be told which journey it was on.

  const enquiryLine = [
    [propertyAddress, [enquiryDate, enquiryTime].filter(Boolean).join(' at ')]
      .filter(Boolean).join(', '),
  ].filter(Boolean).join('');
  const enquiryDetail = [
    enquiryLine ? `${enquiryLine}.` : '',
    sellerDeclared ? sellerDeclarationSummary(sellerDeclarationText) : '',
  ].filter(Boolean).join(' ');
  if (enquiryDetail) {
    events.push({ kind: 'evidence', label: STORY_LABELS.enquiry, detail: enquiryDetail, tone: 'neutral' });
  }

  const commEvents = selectCommunicationEvidence({
    communications, intelligence, sellerDeclared, responseTime,
    responseHours: intelligence.response_hours, observationDays, enquiryAt,
  });
  // WHAT HAPPENED NEXT sits after the buyer-progression line, because that is
  // the order it reads in: what came back first, what it achieved on the
  // buying side, and only then how hard the team kept going.
  const whatNext = commEvents.filter((e) => e.label === STORY_LABELS.whatHappenedNext);
  for (const event of commEvents.filter((e) => e.label !== STORY_LABELS.whatHappenedNext)) {
    events.push({ ...event, kind: 'evidence' });
  }

  // The buyer side, stated plainly so the agency gets credit for whatever it
  // genuinely did - which is what makes the seller line below read as a
  // contrast rather than as an attack.
  const viewingEvent = viewingProgressionEvent(intelligence);
  if (viewingEvent) events.push({ ...viewingEvent, kind: 'evidence' });

  for (const event of whatNext) events.push({ ...event, kind: 'evidence' });

  // Only meaningful where the enquiry actually declared a property to sell -
  // seller_recognition is blank otherwise, by design (schema §3 field 14).
  const sellerEvent = sellerDeclared ? sellerOpportunityEvent(intelligence) : null;
  if (sellerEvent) events.push({ ...sellerEvent, kind: 'evidence' });

  return events;
}

// ── what makes a demo sendable ───────────────────────────────────────────────

// The demo is worth sending when it can actually do its job: name the agency,
// show their property, credit what they did well where there was anything to
// credit, name the consequence, and show NOVUS recognising something real.
// Anything missing from that list is a reason for a human to look, not a
// reason to hide the demo — so it is recorded on the row (review_reasons)
// and the status becomes needs_review.
//
// Pure, and deliberately separate from buildDemoRow() so the rule can be read
// and tested on its own.
export function reviewReasonsFor(row, { journeyWarning = '' } = {}) {
  const reasons = [];
  if (journeyWarning) reasons.push(journeyWarning);

  if (!text(row.agency_name)) reasons.push('agency_name is blank — the demo cannot address the agency by name');
  if (!text(row.property_address)) reasons.push('property_address is blank — beat 1 has no property to show');
  if (!text(row.commercial_consequence)) reasons.push('commercial_consequence is blank — beat 2 has no payoff');

  // A positive observation is only owed where somebody actually responded.
  // On a no-contact probe there is genuinely nothing to credit, and
  // PERSONALISATION correctly leaves fair_observation blank — demanding one
  // there would flag every complete_miss demo forever.
  if (!text(row.positive_observation) && text(row.human_contact) === 'yes') {
    reasons.push('positive_observation is blank although the agency did respond — beat 2 has no credit line');
  }

  if (parseCollection(row.novus_detected_json).length === 0) {
    reasons.push('novus_detected is empty — beat 3 has nothing for NOVUS to have recognised');
  }
  // One event is just "an enquiry arrived", which proves nothing.
  if (parseCollection(row.observed_events_json).length < 2) {
    reasons.push('fewer than two observed events — beat 2 has no evidence to show');
  }

  return reasons;
}

// A MISSING PROPERTY IMAGE IS NOT A REVIEW REASON. The renderer falls back to
// the drawn placeholder card, the demo reads correctly without it, and image
// extraction is best-effort by design — see lib/property-image.mjs. It is
// recorded in property_image_status instead, which is what a later pass and a
// human both read.
export function statusFromReasons(reasons) {
  return reasons.length === 0 ? 'ready' : 'needs_review';
}

// ── the row ──────────────────────────────────────────────────────────────────

// Pure. Every input is a plain row object already read from its tab; nothing
// here touches Sheets, the network or the clock beyond `now`.
//
// Returns { row, reasons, status }. It never throws on thin upstream data — a
// missing field becomes a review reason and the demo still compiles, because
// a flagged demo a human can look at beats no demo at all. It DOES refuse a
// hero_journey the shell has no content for: see journeySupport().
//
// `existing` is the current DEMOS row, if any. Identity (demo_id, demo_slug),
// created_at, ready_at and every ANALYTICS_COLUMN are carried over from it
// unchanged — a recompile updates the SNAPSHOT, never the demo's identity or
// its history.
export function buildDemoRow({
  probe, agency, intelligence, findings, personalisation,
  communications = [],
  propertyImageUrl = '', propertyImageStatus = '',
  demoId = '', demoSlug = '', existing = null,
  compiledBy = 'auto', now = new Date().toISOString(),
}) {
  const heroJourney = text(personalisation?.hero_journey);
  const support = journeySupport(heroJourney);
  if (!support.supported) {
    const err = new Error(support.reason);
    err.code = 'unsupported_hero_journey';
    err.hero_journey = heroJourney;
    throw err;
  }

  const agencyName = text(agency?.agency_name);
  const propertyAddress = cleanAddressForEmail(probe?.property_address);
  const enquiryAt = text(probe?.probe_timestamp);
  const sellerDeclared = hasVendorDeclaration(probe);
  const responseTime = formatResponseTime(intelligence?.response_hours);
  const enquiryDate = formatEnquiryDate(enquiryAt);
  const enquiryTime = formatEnquiryTime(enquiryAt);

  const context = {
    agencyName,
    propertyAddress,
    propertyPrice: text(probe?.property_price),
    enquiryDate,
    enquiryTime,
    responseTime,
    sellerDeclared,
    intelligence: intelligence || {},
    findings: findings || [],
    personalisation: personalisation || {},
  };

  const journey = buildJourneyContent(heroJourney, context);

  const observedEvents = buildObservedEvents({
    intelligence: intelligence || {},
    sellerDeclared,
    sellerDeclarationText: vendorDeclarationText(probe),
    responseTime,
    communications,
    propertyAddress,
    enquiryDate,
    enquiryTime,
    enquiryAt,
    observationDays: observationDaysFor(probe),
  });

  const row = {
    // identity — never regenerated once the row exists
    demo_id: demoId || text(existing?.demo_id) || newDemoId(),
    demo_slug: demoSlug || text(existing?.demo_slug) || '',
    demo_status: '',                     // filled in from the reasons below
    demo_version: String(DEMO_VERSION),
    review_reasons: '',

    agency_id: text(probe?.agency_id),
    probe_id: text(probe?.probe_id),
    probe_reference: text(probe?.probe_reference),
    personalisation_id: text(personalisation?.personalisation_id),
    hero_journey: heroJourney,

    agency_name: agencyName,
    property_address: propertyAddress,
    property_price: text(probe?.property_price),
    property_url: text(probe?.property_url),
    property_image_url: text(propertyImageUrl),
    property_image_status: text(propertyImageStatus),

    portal: text(probe?.portal),
    enquiry_at: enquiryAt,
    enquiry_date: enquiryDate,
    enquiry_time: enquiryTime,

    seller_declared: sellerDeclared ? 'yes' : 'no',
    human_contact: text(intelligence?.human_contact),
    response_time: responseTime,
    response_hours: text(intelligence?.response_hours),
    contact_attempts: text(intelligence?.contact_attempts),
    follow_ups: text(intelligence?.follow_ups),
    channels_used: text(intelligence?.channels_used),
    viewing_progression: text(intelligence?.viewing_progression),
    seller_recognition: text(intelligence?.seller_recognition),
    grade: text(intelligence?.grade),

    // Every prospect-facing string goes through normaliseDashes() — including
    // the AI-authored PERSONALISATION sentences, which are the one place an em
    // dash can still enter the page.
    // BLANK MEANS "THE SHELL'S OWN DEFAULT". demo_headline, novus_transition
    // and scale_line are the three places a journey overrides a heading the
    // renderer would otherwise write itself - so weak_seller_qualification,
    // whose defaults already say exactly the right thing, leaves them empty
    // and renders exactly as it did before journeys could set them.
    demo_headline: normaliseDashes(journey.headline),
    demo_hook: normaliseDashes(journey.hook),
    positive_observation: normaliseDashes(sentenceCase(personalisation?.fair_observation)),
    demo_reveal: normaliseDashes(journey.reveal),
    // The journey's own supporting sentence, used ONLY where PERSONALISATION
    // produced neither a commercial consequence nor a main finding for this
    // probe. The agency-specific sentence always wins.
    demo_reveal_support: normaliseDashes(journey.revealSupport),
    main_finding: normaliseDashes(sentenceCase(stripUnsafeSellerValue(personalisation?.main_finding))),
    commercial_consequence: normaliseDashes(sentenceCase(stripUnsafeSellerValue(personalisation?.commercial_consequence))),
    novus_transition: normaliseDashes(journey.transition),
    scale_line: normaliseDashes(journey.scaleLine),
    systemic_bridge: normaliseDashes(journey.systemicBridge),
    cta_headline: normaliseDashes(journey.ctaHeadline),

    observed_events_json: JSON.stringify(normaliseCollection(observedEvents)),
    novus_detected_json: JSON.stringify(normaliseCollection(journey.detected)),
    novus_decisions_json: JSON.stringify(normaliseCollection(journey.decisions)),
    novus_actions_json: JSON.stringify(normaliseCollection(journey.actions)),

    created_at: text(existing?.created_at) || now,
    updated_at: now,
    compiled_at: now,
    compiled_by: text(compiledBy) || 'auto',
    ready_at: text(existing?.ready_at),
  };

  const reasons = reviewReasonsFor(row, { journeyWarning: support.warning || '' });
  // ARCHIVING IS DELIBERATE AND STICKY. A recompile refreshes an archived
  // demo's snapshot but must not quietly bring its link back to life.
  row.demo_status = text(existing?.demo_status) === 'archived' ? 'archived' : statusFromReasons(reasons);
  row.review_reasons = reasons.join(' · ');
  // The moment the link first became sendable. Stamped once and never moved,
  // so a later recompile that flips a demo to needs_review and back does not
  // rewrite when it was first ready.
  if (row.demo_status === 'ready' && !row.ready_at) row.ready_at = now;

  // ANALYTICS ARE THE ROW'S, NOT THE COMPILE'S. Carried across verbatim so a
  // recompile before outreach can never reset a demo's view or CTA history.
  for (const column of ANALYTICS_COLUMNS) row[column] = text(existing?.[column]);

  return { row, reasons, status: row.demo_status };
}

// ── render-ready projection ──────────────────────────────────────────────────

function parseCollection(value) {
  const raw = text(value);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // a hand-mangled cell renders as an absent section, never a broken page
  }
}

// The exact object /api/demo hands the browser. Internal keys are dropped here,
// once, so no route has to remember to strip them.
export function toRenderReady(row) {
  const out = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (INTERNAL_COLUMNS.has(key)) continue;
    if (key.endsWith('_json')) continue;
    out[key] = value;
  }
  out.observed_events = parseCollection(row?.observed_events_json);
  out.novus_detected = parseCollection(row?.novus_detected_json);
  out.novus_decisions = parseCollection(row?.novus_decisions_json);
  out.novus_actions = parseCollection(row?.novus_actions_json);
  return out;
}

// ── repo access ──────────────────────────────────────────────────────────────

// A workbook with no DEMOS tab reads back as an empty table rather than
// throwing, so a deploy that lands before the tab is created serves a clean
// 404 instead of a 500.
export async function loadDemosTable(repo) {
  try {
    const table = await repo.getTable(DEMOS_TAB);
    return { header: table.header || [], rows: table.rows || [] };
  } catch {
    return { header: [], rows: [] };
  }
}

export function demosTabExists(table) {
  return Array.isArray(table.header) && table.header.includes('demo_slug');
}

// -> [{ rowNumber, obj }] for every real data row, SCHEMA NOTE skipped.
export function demoRecords(table) {
  const slugIdx = table.header.indexOf('demo_slug');
  if (slugIdx === -1) return [];
  const out = [];
  table.rows.forEach((row, i) => {
    const slug = String(row[slugIdx] ?? '').trim();
    if (!slug || slug === 'SCHEMA NOTE') return;
    const obj = {};
    table.header.forEach((key, colIdx) => { obj[key] = row[colIdx] ?? ''; });
    obj.demo_slug = slug;
    out.push({ rowNumber: i + 2, obj });
  });
  return out;
}

// ── slug resolution ──────────────────────────────────────────────────────────
//
// A demo slug reaches us through a chain nobody controls end to end: it is
// typed into a sheet cell, pasted into an email, forwarded, and finally
// arrives as a path segment. Every step in that chain can add something the
// slug itself never contained — a stray space or non-breaking space from the
// cell, a zero-width character from a rich-text paste, a trailing slash from a
// mail client, a capital from someone retyping it. None of those are a
// DIFFERENT demo, so none of them may 404.
//
// Both sides of the comparison go through this, which is what makes the rule
// symmetric: a slug stored with a trailing space resolves, and a link opened
// with one resolves too.
export function normaliseSlug(value) {
  return String(value ?? '')
    .replace(/[\u00a0\u200b-\u200d\ufeff]/g, '')   // NBSP + zero-width, from pasted cells
    .trim()
    .replace(/^\/+|\/+$/g, '')                       // a copied "/demo/slug/" path segment
    .toLowerCase();
}

export function findDemoBySlug(table, slug) {
  const wanted = normaliseSlug(slug);
  if (!wanted) return null;
  return demoRecords(table).find((r) => normaliseSlug(r.obj.demo_slug) === wanted) || null;
}

// The status the route must act on, which is not always the cell's contents.
// A row whose demo_status was blanked or mistyped by hand is NOT a demo that
// should silently 404: its own review_reasons already say whether it is
// complete, so the status is re-derived from them. Anything the lifecycle
// does not recognise is treated the same way, so a typo can never retire a
// working link.
export function effectiveDemoStatus(row) {
  const stored = text(row?.demo_status);
  if (DEMO_STATUSES.includes(stored)) return stored;
  return text(row?.review_reasons) ? 'needs_review' : 'ready';
}

// THE ONE PLACE A SLUG BECOMES A DEMO. api/demo.js's GET path and the audit
// action both go through this, so the audit can never report a demo as
// resolvable that the prospect's own request would 404 — they are not two
// implementations of the same rule, they are one.
//
// -> { ok, status, record, httpStatus, error }
export function resolveDemoBySlug(table, slug, { preview = false } = {}) {
  if (!demosTabExists(table)) {
    return { ok: false, status: '', record: null, httpStatus: 404, error: 'No DEMOS tab in the workbook yet' };
  }
  const record = findDemoBySlug(table, slug);
  if (!record) {
    return { ok: false, status: '', record: null, httpStatus: 404, error: 'No demo found for this link' };
  }

  const status = effectiveDemoStatus(record.obj);

  // An archived demo is deliberately retired — gone, preview or not.
  if (status === 'archived') {
    return { ok: false, status, record, httpStatus: 404, error: 'This demo is no longer available' };
  }

  // A needs_review demo is an unfinished prospect experience. A normal request
  // must see exactly what an unknown slug sees, so the outside world cannot
  // tell "not ready yet" apart from "never existed".
  if (status !== 'ready' && !preview) {
    return { ok: false, status, record, httpStatus: 404, error: 'No demo found for this link' };
  }

  return { ok: true, status, record, httpStatus: 200, error: '' };
}

export function findDemoByProbe(table, probeId) {
  const wanted = text(probeId);
  if (!wanted) return null;
  return demoRecords(table).find((r) => String(r.obj.probe_id || '').trim() === wanted) || null;
}

// slug -> probe_id, so buildDemoSlug() can tell "this probe's existing slug"
// from "another probe already owns this slug".
export function slugOwners(table) {
  const owners = new Map();
  for (const { obj } of demoRecords(table)) {
    owners.set(obj.demo_slug.toLowerCase(), String(obj.probe_id || '').trim());
  }
  return owners;
}

// Writes ONE fully-formed row with NO read beforehand — the caller already has
// the table snapshot and merges the patch in memory. Used for both the build
// upsert and the telemetry patch, so a page view costs one read and one write.
export async function writeDemoRow(repo, header, rowNumber, obj) {
  const row = header.map((key) => (obj[key] ?? ''));
  await repo.writeRowsBatch([{ tab: DEMOS_TAB, rowNumber, row }]);
}

export const _internal = { INTERNAL_COLUMNS, VIEWING_PROGRESSION_LABELS, SELLER_RECOGNITION_LABELS };
