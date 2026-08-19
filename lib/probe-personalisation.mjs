// lib/probe-personalisation.mjs — the ONE AI call that turns a probe's
// already-finalised INTELLIGENCE + DIAGNOSIS into the agency-specific
// acquisition story (Personalisation layer: COMMUNICATIONS = evidence,
// INTELLIGENCE = interpretation, DIAGNOSIS = commercial conclusion,
// PERSONALISATION = that evidence + conclusion turned into the story).
//
// Reads INTELLIGENCE and DIAGNOSIS as already-settled interpretation — it
// never re-grades, re-diagnoses, or second-guesses novus_opportunity. Its
// own job is strictly additive: (1) reach past INTELLIGENCE's already-
// curated evidence quotes back into the RAW COMMUNICATIONS for this probe,
// so the opener/counterfactual can show fresh verbatim wording and exact
// timestamps rather than just restating the Diagnosis prose, and (2) turn
// the single observed interaction into the wider acquisition story: what it
// is evidence OF, what NOVUS would have done differently to THIS specific
// situation, and how that ties to the always-on system.
//
// Two hard guards enforced in code, not just prompted for:
//   - quotes_used: every quote must be a literal substring of the raw
//     communication it cites (same discipline as lib/probe-interpretation.mjs
//     and lib/probe-diagnosis.mjs) — a quote that fails is dropped.
//   - wider_leakage: the model is NEVER allowed to state a currency amount.
//     It may cite the one pre-computed scale fact it's handed (e.g. live
//     listing count) verbatim, but any sentence containing a currency
//     symbol is stripped after the call, whatever the model actually wrote —
//     see stripInventedCurrency(). No £ figure in this system is ever
//     AI-estimated; if the data doesn't support a number, the field stays
//     qualitative.

import { callAi } from './ai-client.mjs';

const HERO_JOURNEYS = [
  'complete_miss',
  'automated_ack_only',
  'slow_response_gap',
  'fast_response_stalled_follow_up',
  'weak_seller_qualification',
  'strong_handling_database_opportunity',
  'strong_handling_no_opportunity',
];

// Deterministic — no AI. Mirrors the Demo doc's grade/problem-shape ->
// hero-journey table (NOVUS_Demo_System_Reference §7/§8). Reused as-is by
// the Demo, so the journey a prospect sees is a lookup, not a fresh AI
// judgement call every time the page renders.
export function pickHeroJourney(intelligence, diagnosis) {
  const humanContact = String(intelligence.human_contact || '').trim();
  if (humanContact === 'none') return 'complete_miss';
  if (humanContact === 'automated_only') return 'automated_ack_only';

  const primaryProblem = String(diagnosis.primary_problem || '').trim();
  const responseHours = parseFloat(intelligence.response_hours);
  const followUps = Number(intelligence.follow_ups) || 0;

  if (!primaryProblem) {
    return diagnosis.novus_opportunity === 'Growth (valuation list / seller conversion)'
      ? 'strong_handling_database_opportunity'
      : 'strong_handling_no_opportunity';
  }

  // Fast to first contact but the declared seller thread stalled — the
  // buying side moved (viewing_progression beyond "none") while the selling
  // side didn't (seller_recognition still "none"/"asked_position").
  const sellerRecognition = String(intelligence.seller_recognition || '').trim();
  const viewingProgression = String(intelligence.viewing_progression || '').trim();
  const buyingMovedButSellingDidnt = sellerRecognition
    && sellerRecognition !== 'valuation_offered'
    && sellerRecognition !== 'valuation_booked'
    && viewingProgression !== 'none';

  if (Number.isFinite(responseHours) && responseHours <= 6 && buyingMovedButSellingDidnt) {
    return 'weak_seller_qualification';
  }
  if (Number.isFinite(responseHours) && responseHours > 6) {
    return 'slow_response_gap';
  }
  if (followUps === 0) {
    return 'fast_response_stalled_follow_up';
  }
  return 'slow_response_gap';
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

// Never trust an AI-stated currency figure — strip any sentence containing
// one, whatever the model actually wrote. Splits on sentence boundaries so
// a legitimate qualitative sentence elsewhere in the same field survives.
export function stripInventedCurrency(text) {
  const CURRENCY_RE = /[£$€]\s?\d/;
  const sentences = String(text || '').split(/(?<=[.!?])\s+/).filter(Boolean);
  return sentences.filter((s) => !CURRENCY_RE.test(s)).join(' ').trim();
}

// AGENCIES row -> a single defensible, code-computed scale fact the AI may
// cite verbatim, or null when nothing usable is available. Deliberately not
// a leakage estimate itself (no multiplication, no assumed conversion rate,
// no revenue figure) — just the raw count the wider_leakage sentence is
// allowed to reference.
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

const TOOL = {
  name: 'record_probe_personalisation',
  description: 'Record the agency-specific acquisition story for one probe, built from its already-settled Intelligence and Diagnosis, plus fresh verbatim quotes from the raw communications.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['personalised_opener', 'quotes_used', 'novus_counterfactual', 'wider_leakage', 'systemic_promise', 'why_novus', 'objection_response', 'demo_intro'],
    properties: {
      personalised_opener: { type: 'string', description: 'The first line of a call or email to this specific agency — names the property, the exact behaviour observed, and reads as written for them, not a template.' },
      quotes_used: {
        type: 'array',
        description: 'The verbatim quotes (from the raw communications shown, not paraphrased) that personalised_opener and novus_counterfactual rest on — proof the actual interaction was used, not just the grade or the diagnosis summary.',
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
      novus_counterfactual: { type: 'string', description: 'What NOVUS would have done differently to THIS specific observed situation — anchored to the actual timestamps and wording, not a generic pitch. If the agency handled it well, state plainly that NOVUS would have matched it, and say what NOVUS adds on top (speed guaranteed every time, or the specific opening they did not take).' },
      wider_leakage: { type: 'string', description: 'How this one observed interaction is evidence of a larger, recurring pattern — not the whole pitch. Qualitative unless you are explicitly given a pre-computed scale fact to cite. NEVER state a currency amount, a percentage of revenue, or any invented number — describe pattern and scale in words, or leave this empty if the evidence only supports a single-instance read.' },
      systemic_promise: { type: 'string', description: 'How the specific intervention above connects to the wider NOVUS system: catching this kind of leakage before the agency itself would notice it.' },
      why_novus: { type: 'string', description: 'One sentence.' },
      objection_response: { type: 'string', description: 'The most likely pushback to THIS specific finding, answered with the evidence. Empty string if the handling was strong enough that there is no real objection to pre-empt.' },
      demo_intro: { type: 'string', description: 'One paragraph introducing the demo hero journey built around this probe.' },
    },
  },
};

const SYSTEM_PROMPT = `You are writing the Personalisation layer for one NOVUS probe — the story that turns this agency's specific evidence and commercial diagnosis into an acquisition narrative. You are NOT re-analysing anything: Intelligence and Diagnosis below are already the settled interpretation and commercial conclusion. Treat them as given.

Hard rules:
1. Ground personalised_opener and novus_counterfactual in the RAW COMMUNICATIONS shown below, not just the Diagnosis summary — quote the agency's actual words and cite the actual timestamps. Every quote you use must be copied verbatim into quotes_used with its communication_id; a quote that isn't a literal match to the source is worthless and will be discarded.
2. The observed interaction is EVIDENCE of a larger pattern, not the entire pitch. wider_leakage should generalise from it — but only in words. If you are handed a pre-computed scale fact, you may cite that exact fact; you must never invent, estimate, or compute a currency amount, a percentage of revenue, or any other number yourself. If the data doesn't support a number, stay qualitative or leave the field empty — an empty wider_leakage is a legitimate, honest answer.
3. novus_counterfactual must respond to what THIS agency actually did at THIS moment — reference the actual delay, the actual questions asked or not asked, the actual channel. A sentence that would read identically for any other agency's probe is wrong.
4. If Diagnosis's primary_problem is empty (the agency handled this well), do not manufacture a weakness anywhere — novus_counterfactual should say NOVUS would have matched the handling, wider_leakage and objection_response may legitimately be empty, and the story becomes about consistency/scale/the next opportunity (novus_opportunity), never a fabricated gap.
5. systemic_promise connects the specific intervention to the wider system: NOVUS finds and closes this kind of gap before the agency would ever notice it existed on its own.`;

function contentBlock(c, i) {
  const content = contentOf(c) || '(no content)';
  return `--- Message ${i + 1} | communication_id: ${c.communication_id} | channel: ${c.channel || 'unknown'} | occurred_at: ${c.occurred_at} ---\n${content}`;
}

function buildPrompt(probe, intelligence, diagnosis, communications, scaleFact) {
  const ordered = communications
    .map((c) => ({ ...c, _at: new Date(c.occurred_at) }))
    .filter((c) => !Number.isNaN(c._at.getTime()))
    .sort((a, b) => a._at - b._at);

  return [
    `Property: ${probe?.property_address || 'unknown'} (${probe?.property_price || 'price unknown'})`,
    `Probe sent: ${probe?.probe_timestamp || 'unknown'}`,
    `Enquiry text: ${probe?.enquiry_text || '(none)'}`,
    '',
    '=== INTELLIGENCE (settled interpretation — do not re-derive) ===',
    `Grade (reference only): ${intelligence.grade || 'unknown'} — ${intelligence.grade_reason || ''}`,
    `Response: ${intelligence.human_contact || 'unknown'}, ${intelligence.response_hours !== '' && intelligence.response_hours != null ? `${intelligence.response_hours} hours to first human contact` : 'no human contact'}`,
    `Contact attempts: ${intelligence.contact_attempts ?? 0}, follow-ups after the first: ${intelligence.follow_ups ?? 0}, channels: ${intelligence.channels_used || 'none'}`,
    `Viewing progression: ${intelligence.viewing_progression || 'none'}; buyer qualification: ${intelligence.buyer_qualification || 'none'} (${intelligence.buyer_questions_asked || 'no questions recorded'})`,
    `Seller/vendor recognition: ${intelligence.seller_recognition === '' ? 'n/a — no property declared for sale' : (intelligence.seller_recognition || 'none')}`,
    `Communication quality: ${intelligence.communication_quality || 'unknown'}`,
    `Pre-validated evidence quotes already on file: ${intelligence.evidence || '(none)'}`,
    '',
    '=== DIAGNOSIS (settled commercial conclusion — do not re-derive) ===',
    `Primary problem: ${diagnosis.primary_problem || '(none — handled well)'}${diagnosis.primary_evidence ? ` — ${diagnosis.primary_evidence}` : ''}`,
    `Secondary problem: ${diagnosis.secondary_problem || '(none)'}${diagnosis.secondary_evidence ? ` — ${diagnosis.secondary_evidence}` : ''}`,
    `Strengths: ${diagnosis.strengths || '(none recorded)'}`,
    `Missed opportunities: ${diagnosis.missed_opportunities || '(none — both taken)'}`,
    `Commercial implication: ${diagnosis.commercial_implication || '(none)'}`,
    `NOVUS opportunity: ${diagnosis.novus_opportunity || 'None evidenced'}`,
    `Diagnosis summary: ${diagnosis.diagnosis_summary || ''}`,
    '',
    scaleFact
      ? `=== SCALE FACT (the ONLY number you may cite in wider_leakage; do not compute anything further from it) ===\n${scaleFact}`
      : '=== SCALE FACT ===\n(none available — wider_leakage must stay qualitative, with no numbers at all)',
    '',
    '=== RAW COMMUNICATIONS (for exact wording and timestamps — quote from here) ===',
    ordered.length > 0 ? ordered.map(contentBlock).join('\n\n') : '(No communications were received for this probe.)',
  ].join('\n');
}

// probe: PROBES row. intelligence: INTELLIGENCE row (must be the finalised,
// closed one). diagnosis: DIAGNOSIS row for the same probe. communications:
// this probe's COMMUNICATIONS rows. agency: AGENCIES row, for the scale
// fact only.
// -> { hero_journey, personalised_opener, quotes_used (formatted string),
//      novus_counterfactual, wider_leakage, systemic_promise, why_novus,
//      objection_response, demo_intro }
export async function personaliseProbe(probe, intelligence, diagnosis, communications, agency) {
  const byId = new Map(communications.map((c) => [c.communication_id, c]));
  const scaleFact = computeScaleFact(agency);

  const result = await callAi({
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(probe, intelligence, diagnosis, communications, scaleFact),
    tool: TOOL,
  });

  const genuineQuotes = (result.quotes_used || [])
    .filter((q) => q && quoteIsGenuine(q.quote, byId.get(q.communication_id)))
    .map((q) => {
      const comm = byId.get(q.communication_id);
      return `"${q.quote.trim()}" (${comm.channel || 'unknown channel'}, ${comm.occurred_at})`;
    });

  const heroJourney = pickHeroJourney(intelligence, diagnosis);

  return {
    hero_journey: HERO_JOURNEYS.includes(heroJourney) ? heroJourney : 'slow_response_gap',
    personalised_opener: String(result.personalised_opener || '').trim(),
    quotes_used: genuineQuotes.join('; '),
    novus_counterfactual: String(result.novus_counterfactual || '').trim(),
    wider_leakage: stripInventedCurrency(result.wider_leakage),
    systemic_promise: String(result.systemic_promise || '').trim(),
    why_novus: String(result.why_novus || '').trim(),
    objection_response: String(result.objection_response || '').trim(),
    demo_intro: String(result.demo_intro || '').trim(),
  };
}

export const _internal = { quoteIsGenuine, normalize, contentOf, computeScaleFact, HERO_JOURNEYS };
