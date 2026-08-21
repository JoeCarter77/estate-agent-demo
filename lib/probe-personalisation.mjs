// lib/probe-personalisation.mjs — the ONE AI call that turns a probe's
// already-settled INTELLIGENCE + DIAGNOSIS + DIAGNOSIS_FINDINGS into the
// story, and assembles the outreach email from it.
//
// Pipeline position: PROBE -> DIAGNOSIS -> DIAGNOSIS_FINDINGS ->
// PERSONALISATION -> EMAIL -> personalised audit / demo journey.
//
// What this layer is FOR (and what it is deliberately not):
//
//   Diagnosis lists every genuine, independently evidence-backed finding and
//   why each one matters. It does NOT decide which of them is the story.
//   That judgement is this file's entire job: look across the COMPLETE set of
//   findings and pick the strongest commercially consequential narrative,
//   which may well be several findings combining into one broader problem
//   rather than simply finding #1. Everything else here — supporting
//   findings, evidence, commercial story, counterfactual, email — hangs off
//   that one decision.
//
//   It is NOT a second Diagnosis engine. It never re-grades, re-diagnoses,
//   invents a finding, or second-guesses novus_opportunity. It adds no AI
//   call beyond the single one below. Intelligence and Diagnosis are inputs,
//   treated as settled.
//
// It reads the WHOLE Diagnosis picture, not just findings[]: strengths,
// missed_opportunities, commercial_implication, novus_opportunity and
// diagnosis_summary all go into the prompt, alongside the probe facts the
// email itself needs (property address, property value, enquiry date, the
// enquiry text) and the RAW COMMUNICATIONS, so the story quotes what the
// agency actually said rather than restating Diagnosis prose.
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
//     strengths for, and is replaced by the plain "we never received a
//     reply" line when there was no human contact at all.
//   - supporting_findings: forced empty when every genuine finding is
//     already inside the primary narrative — the email's "a couple of other
//     things" line then cannot appear with nothing behind it.
//   - the email body is ASSEMBLED IN CODE from the locked structure, so the
//     shape of the email cannot drift with the model's mood.

import { callAi } from './ai-client.mjs';
import { ONE_HOUR_MS, SIXTEEN_HOUR_MS } from './grading.mjs';
import { formatFindingsForPrompt } from './diagnosis-findings.mjs';

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
  description: 'Record the commercial story for one probe: which of its diagnosed findings combine into the strongest narrative, the evidence behind it, and the parts of the outreach email.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'primary_narrative', 'narrative_finding_indexes', 'supporting_findings', 'evidence_quotes',
      'commercial_story', 'fair_observation', 'novus_counterfactual',
      'email_main_point', 'email_consequence', 'email_wider_consequence',
    ],
    properties: {
      primary_narrative: {
        type: 'string',
        description: 'The single strongest commercially consequential story this enquiry tells, in two to four sentences. Where several findings are really one broader problem, COMBINE them into that broader problem rather than picking the first finding and ignoring the rest. If there are no findings at all, this is the story of handling that genuinely worked and what it would take to guarantee it every time.',
      },
      narrative_finding_indexes: {
        type: 'array',
        description: 'The finding numbers (as shown in the FINDINGS list) that combine into primary_narrative — one number if the story really is a single finding, several if they combine. Empty array only when there are no findings at all.',
        items: { type: 'integer' },
      },
      supporting_findings: {
        type: 'string',
        description: 'The genuine findings NOT already inside primary_narrative, stated plainly in one or two sentences. Empty string when the narrative already covers every finding, or when there are no findings. Never pad this.',
      },
      evidence_quotes: {
        type: 'array',
        description: 'Verbatim quotes from the RAW COMMUNICATIONS shown (copied exactly, never paraphrased) that the narrative and the email rest on. A quote that is not a literal match to its source is discarded. Empty array is correct when nothing was ever said — for example when there was no reply at all.',
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
      commercial_story: {
        type: 'string',
        description: 'What primary_narrative actually costs THIS agency, in plain commercial terms, referencing this specific property and enquiry. Use the property value only where it genuinely sharpens the point. Never assume a fee, a commission rate, or a conversion rate, and never state any monetary figure other than the property value you are given.',
      },
      fair_observation: {
        type: 'string',
        description: 'One short, genuinely fair sentence acknowledging what this agency did well, drawn strictly from the Diagnosis strengths. It should disarm, not flatter, and must be something the evidence actually shows. Empty string if the Diagnosis records no strengths worth naming.',
      },
      novus_counterfactual: {
        type: 'string',
        description: 'What NOVUS would have done differently at THIS specific moment — anchored to the actual delay, the actual questions asked or not asked, the actual channel. If the handling was strong, say plainly that NOVUS would have matched it and name what it adds on top. A sentence that would read identically for any other agency is wrong.',
      },
      email_main_point: {
        type: 'string',
        description: 'The email version of primary_narrative: one or two short sentences, human and specific, no jargon. This is the main finding as the recipient will read it.',
      },
      email_consequence: {
        type: 'string',
        description: 'The immediate commercial consequence, as a sentence beginning "That means". Concrete and modest — say only what this one enquiry can actually establish.',
      },
      email_wider_consequence: {
        type: 'string',
        description: 'OPTIONAL second sentence, also beginning "That means", for the wider commercial consequence — only when the evidence genuinely supports generalising beyond this one enquiry. Empty string is the right answer whenever it does not. Never invent a number here.',
      },
    },
  },
};

const SYSTEM_PROMPT = `You are writing the Personalisation layer for one NOVUS probe: an estate agency was sent a genuine property enquiry, everything that happened next was recorded, and a commercial Diagnosis has already been completed.

Diagnosis has already listed every genuine, evidence-backed finding and why each one matters. Your job is NOT to re-analyse, re-grade, or add findings. Your job is to decide WHAT THE STORY IS.

Hard rules:
1. Look across the COMPLETE set of findings, not just the first one. Where two, three or four findings are really different faces of one broader commercial problem, combine them into that one broader narrative — that combined story is almost always stronger than the single worst finding on its own. Name the finding numbers you combined.
2. Never state a finding, a fact, or an outcome the probe cannot establish. This enquiry is one observed interaction. It shows what happened to THIS enquiry. It does not prove what happens to every enquiry, and it does not prove a lost sale. Say what it shows, and stop.
3. Be fair. Where the agency genuinely did something well, say so plainly — a fair observation disarms, and it is the difference between a note worth reading and a scorecard nobody asked for. Never invent praise the Diagnosis does not support, and equally never manufacture a weakness: if the findings list is empty, the story is that the handling worked and the question is whether it happens every time.
4. Quote the agency's actual words from the RAW COMMUNICATIONS. Every quote must be copied verbatim with its communication_id; anything that is not a literal match is discarded.
5. Money: you may reference the property value you are given, where it genuinely sharpens the commercial point. You may NEVER state any other monetary figure — no fee, no commission, no percentage, no annual cost, no estimate of what this "costs" in pounds. If you are handed a scale fact, you may cite it exactly as written and draw no further arithmetic from it.
6. Write like a person who noticed something, not like a system grading an agency. No jargon, no sales language, no "leakage", no exaggeration, no pressure. Short sentences. The email's only job is to make them want to see the full breakdown — it is not selling anything.`;

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

// ── The email (structure locked in code) ─────────────────────────────────────

const NO_REPLY_LINE = 'We never received a reply.';
const OTHER_THINGS_LINE = 'There were also a couple of other things from this enquiry that caught our attention.';
const CTA_LINE = "I've put together the full breakdown of what we found. Happy to send it over if you want to take a look.";

// Both "That means" beats are normalised so the locked structure holds even
// if the model phrases the sentence its own way.
function asThatMeans(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (/^that means\b/i.test(t)) return t;
  return `That means ${t.charAt(0).toLowerCase()}${t.slice(1)}`;
}

// The opening line: the enquiry date and, when we actually established it,
// the property. An address we never pinned down is simply left out rather
// than printed as "UNKNOWN — ..." at the prospect.
export function buildOpeningLine(probe) {
  const date = formatEnquiryDate(probe?.probe_timestamp);
  const on = date ? ` on ${date}` : '';
  if (isUnknownAddress(probe?.property_address)) {
    return `We sent your team an enquiry${on}.`;
  }
  const address = cleanAddressForEmail(probe.property_address);
  if (!address) return `We sent your team an enquiry${on}.`;
  return `We sent your team an enquiry${on} about ${address}.`;
}

// Assembles the locked email structure. {{first_name}} stays a merge field —
// the name is filled in at send time, not baked into the sheet.
export function buildEmailBody(probe, parts) {
  const paragraphs = [
    'Hi {{first_name}},',
    buildOpeningLine(probe),
    parts.fair_observation,
    parts.email_main_point,
    parts.email_consequence,
    parts.email_wider_consequence,
    parts.has_other_things ? OTHER_THINGS_LINE : '',
    CTA_LINE,
  ];
  return paragraphs.filter((p) => String(p || '').trim()).join('\n\n');
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
  // left to be "a couple of other things" — the field is forced empty so the
  // email's optional line cannot appear with nothing behind it.
  const hasUncoveredFindings = orderedFindings
    .some((f, i) => !narrativeIndexes.includes(f.finding_index || i + 1));
  const supportingFindings = hasUncoveredFindings ? clean(result.supporting_findings) : '';

  // Fair observation: the plain no-reply line when nothing came back at all,
  // otherwise only what Diagnosis actually recorded strengths for. Praise the
  // evidence does not support is never printed.
  const noHumanContact = String(intelligence.human_contact || '').trim() === 'none';
  const hasStrengths = Boolean(String(diagnosis.strengths || '').trim());
  const fairObservation = noHumanContact
    ? NO_REPLY_LINE
    : (hasStrengths ? clean(result.fair_observation) : '');

  const emailMainPoint = clean(result.email_main_point);
  const emailConsequence = asThatMeans(clean(result.email_consequence));
  const emailWiderConsequence = asThatMeans(clean(result.email_wider_consequence));

  const emailBody = buildEmailBody(probe, {
    fair_observation: fairObservation,
    email_main_point: emailMainPoint,
    email_consequence: emailConsequence,
    email_wider_consequence: emailWiderConsequence,
    has_other_things: Boolean(supportingFindings),
  });

  const heroJourney = pickHeroJourney(intelligence, orderedFindings, diagnosis);

  return {
    hero_journey: HERO_JOURNEYS.includes(heroJourney) ? heroJourney : 'slow_response_gap',
    primary_narrative: clean(result.primary_narrative),
    narrative_finding_indexes: narrativeIndexes.join(','),
    supporting_findings: supportingFindings,
    evidence: evidence.join('; '),
    commercial_story: clean(result.commercial_story),
    fair_observation: fairObservation,
    novus_counterfactual: clean(result.novus_counterfactual),
    email_main_point: emailMainPoint,
    email_consequence: emailConsequence,
    email_wider_consequence: emailWiderConsequence,
    email_body: emailBody,
  };
}

export const _internal = {
  quoteIsGenuine, normalize, contentOf, computeScaleFact, isUnknownAddress, asThatMeans, cleanAddressForEmail,
  HERO_JOURNEYS, NO_REPLY_LINE, OTHER_THINGS_LINE, CTA_LINE,
};
