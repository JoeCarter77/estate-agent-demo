// lib/probe-diagnosis.mjs — the ONE AI call that turns a closed, interpreted
// INTELLIGENCE row into a commercial diagnosis (V2 schema §4).
//
// Reads INTELLIGENCE only. Adds no new evidence, no counts, and never
// touches the A-H grade — lib/grading.mjs remains the sole, unchanged,
// objective speed/persistence measure (Source Master §10, §29: "A-H grade |
// Rules engine | Commercial methodology must be stable").
//
// The grade is passed to the model purely as reference context ("this is
// what the timing/persistence rules already concluded") — it is explicitly
// instructed NOT to select or template a diagnosis off the grade letter.
// Two probes graded identically must be able to produce entirely different
// diagnoses, because the diagnosis is generated from the INTELLIGENCE
// evidence fields (viewing/buyer/seller behaviour, communication quality,
// did_well/missed/evidence), not looked up from a grade->paragraph table.
//
// findings may legitimately be an empty array: a probe the evidence shows
// was handled well produces no forced problem. The deterministic guard below
// (findings that survive requireFindingHasEvidence) is the only non-AI logic
// here: a finding without its evidence, or evidence without its finding, is
// never written. Capped at FOUR PER PROBE, allocated by role rather than
// filled in order — see MAX_FINDINGS_PER_PROBE below for why four and which
// four. Diagnosis states what the evidence shows, it does not try to be
// exhaustive; Personalisation (downstream) is still the layer that judges
// which findings the email's beats are written from, so this module stops at
// "here are the genuine, evidence-backed findings that earn their place and
// why each matters," not "here is the one story."
//
// POSITIVES ARE FINDINGS TOO, NOW. `strengths` remains on the DIAGNOSIS row
// (nothing downstream of Diagnosis lost a field), but it is no longer the
// SOURCE the email's fair observation is drawn from. Personalisation reads
// only DIAGNOSIS_FINDINGS, so a strength that exists only as a paragraph is a
// strength the email cannot use — the model therefore also returns
// positive_findings[], each one a SEPARATE, individually evidence-backed
// thing the agency did well, in exactly the same
// finding/evidence/significance_note shape as a problem. They are NOT the
// strengths paragraph chopped up: one positive is one specific act
// ("the team followed up quickly"), with its own evidence ("three attempts
// across phone and email within one day") and its own significance note.
//
// The two arrays are persisted into ONE ordered findings list, problems and
// opportunities FIRST (so finding_index 1 stays "most commercially damaging"
// exactly as before, and every already-written index keeps its meaning),
// positives appended after them. Each row carries its finding_type.

import { callAi } from './ai-client.mjs';
// The existing Personalisation seller-price provenance guard, reused as-is.
// It stays where it is and keeps running downstream as the safety net; this
// module imports it so the SAME rule is enforced at source, where the bad
// claim was actually being born. Not redesigned, not copied.
import { stripSellerPriceAttribution } from './probe-personalisation.mjs';

const NOVUS_OPPORTUNITIES = ['Core (front desk)', 'Growth (valuation list / seller conversion)', 'None evidenced'];

// FOUR FINDINGS PER PROBE, SHAPED BY WHAT THE EMAIL ACTUALLY USES.
//
// Personalisation writes exactly three beats — a fair observation from a
// [POSITIVE], a main story from the strongest [PROBLEM]/[OPPORTUNITY], and an
// optional wider beat from a genuinely DIFFERENT problem or opportunity — so a
// sixth finding was never a sixth thing the agency got told. It was one more
// near-duplicate for the selection step to tell apart, and the more of those
// there were, the likelier two beats came out of the same underlying event.
//
// So the budget is four, allocated by ROLE rather than filled in order:
//   1 positive               — the fair observation
//   1 strongest problem/opportunity — the main story
//   1 wider commercial opportunity  — the wider beat, where one is evidenced
//   1 optional supporting problem   — only when materially different
// Fewer is a correct answer for every slot: nothing is invented to fill one.
// The two array caps below ARE that allocation (3 story + 1 positive), which
// is what makes the per-probe total structurally four.
const MAX_FINDINGS_PER_PROBE = 4;
const MAX_STORY_FINDINGS = 3;
// ONE. The email needs the STRONGEST genuine positive, not a catalogue: it
// writes a single fair observation and never reads a second positive, so a
// second one is only somewhere to pad.
const MAX_POSITIVE_FINDINGS = 1;
const STORY_FINDING_TYPES = ['problem', 'opportunity'];

const TOOL = {
  name: 'record_probe_diagnosis',
  description: 'Record the commercial diagnosis for one probe, derived strictly from its Intelligence evidence.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['findings', 'positive_findings', 'strengths', 'missed_opportunities', 'commercial_implication', 'novus_opportunity', 'diagnosis_summary'],
    properties: {
      findings: {
        type: 'array',
        description: 'The genuine, DISTINCT, commercially meaningful problems and opportunities the evidence shows — 0 to 3 items, most commercially damaging FIRST. These are not a list of everything wrong: they are three roles, and only the first is close to mandatory. [1] THE MAIN STORY: the single most commercially important or damaging thing the evidence shows. [2] THE WIDER COMMERCIAL OPPORTUNITY, where one is genuinely evidenced — most often a declared property to sell whose valuation was never offered. Leave it out entirely when the evidence does not show one, and never repeat [1] here in other words. [3] ONE OPTIONAL SUPPORTING PROBLEM, included ONLY when it is materially different from [1] and would add something a prospect has not already been told. Two findings that describe the SAME event or the same underlying issue in different words are ONE finding — consolidate them into the stronger statement rather than returning both. A distinct, well-evidenced pair beats a padded three, and an empty array is correct when the evidence shows no real problem.',
        maxItems: MAX_STORY_FINDINGS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['finding_type', 'finding', 'evidence', 'significance_note'],
          properties: {
            finding_type: {
              type: 'string',
              enum: STORY_FINDING_TYPES,
              description: "'problem' when the evidence shows something was handled badly or not at all. 'opportunity' when commercial value was sitting inside this enquiry and was never taken — most often the declared property to sell and the valuation behind it. Never 'positive' here: a positive belongs in positive_findings.",
            },
            finding: { type: 'string', description: 'One distinct, commercially damaging thing the evidence shows — stated as its own finding, not folded into another.' },
            evidence: { type: 'string', description: 'The specific fact or quote this finding rests on (a quote, a number of hours, a count of questions, an explicit absence). Never empty when finding is non-empty.' },
            significance_note: { type: 'string', description: 'Why this finding matters commercially and whether this agency would likely recognise it themselves without NOVUS — the raw material a later step uses to judge how commercially consequential this finding is, not a sentence about the whole probe.' },
          },
        },
      },
      positive_findings: {
        type: 'array',
        description: 'The single strongest genuine thing the agency actually DID WELL — 0 or 1 items, never more. This is NOT the strengths paragraph split up: each item is ONE specific act, with its own evidence and its own reason it matters. Empty array ONLY when there was no human contact at all, or when nothing positive is genuinely evidenced — never invent one to fill the slot. If any human replied, called, acknowledged the enquiry, asked a question, followed up or used the name/property correctly, the strongest of those is a real positive and belongs here.',
        maxItems: MAX_POSITIVE_FINDINGS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['finding', 'evidence', 'significance_note'],
          properties: {
            finding: { type: 'string', description: 'One specific thing the agency did well, stated plainly — e.g. "The team followed up quickly." Not a summary of the whole probe, not hedged, and never a compliment the evidence does not support.' },
            evidence: { type: 'string', description: 'The specific fact this positive rests on — e.g. "Three attempts across phone and email within one day." Never empty.' },
            significance_note: { type: 'string', description: 'Why this positive matters — e.g. "Shows strong persistence." One short sentence.' },
          },
        },
      },
      strengths: { type: 'string', description: 'What the agency did well, evidence-backed, as prose for the DIAGNOSIS row and the sales call. May be the longest field when handling was strong. It is NOT what the email is built from — positive_findings is — so never leave a genuine positive here that is missing from that array.' },
      missed_opportunities: { type: 'string', description: 'Named commercial value — from the BUYING or SELLING opportunity — that was on the table and not taken. Empty string if both were taken.' },
      commercial_implication: { type: 'string', description: 'What this costs THIS agency. Must contain at least one probe-specific fact (the property, a time, their own words) — never a generic sentence that would fit any agency.' },
      novus_opportunity: { type: 'string', enum: NOVUS_OPPORTUNITIES },
      diagnosis_summary: { type: 'string', description: 'Two or three sentences a salesperson could say on a call.' },
    },
  },
};

const SYSTEM_PROMPT = `You are writing the commercial diagnosis for one NOVUS probe, from its Intelligence evidence only.

Hard rules:
1. The A-H grade you are given is an objective, unchanged speed/persistence measurement — reference it if useful, but NEVER select or template your answer from the grade letter. Two probes with the same grade must be able to produce completely different diagnoses if their evidence differs, and two probes with different grades can share a finding if the evidence says so.
2. Do not force a finding. If the evidence shows fast, persistent, well-qualified, well-progressed handling of both the buying and selling opportunity, findings must be an empty array — say so plainly in strengths and diagnosis_summary, and only name a novus_opportunity if the evidence genuinely points at one (otherwise "None evidenced").
3. Every finding needs its own evidence field non-empty; never state a finding you cannot back with a specific fact from the Intelligence row (a quote, a number of hours, a count of questions, an explicit absence like "no valuation was ever offered"). Each finding must be genuinely distinct — do not split one observation into two findings, and do not repeat the same problem worded differently. Where two candidate findings are really the same event or the same underlying issue, CONSOLIDATE them into the single stronger statement; distinct and evidenced beats complete.
4. commercial_implication must contain something specific to THIS agency and THIS probe — not a sentence that could be pasted onto any other agency's diagnosis.
5. The probe always creates exactly two opportunities: BUYING (the viewing + qualifying the buyer) and SELLING (the declared property + the valuation, only if one was declared). missed_opportunities should name which of these, specifically, was left on the table — or state that both were taken.
6. FOUR FINDINGS PER PROBE, MAXIMUM, AND THEY HAVE ROLES. You are not cataloguing everything that went wrong. A later step writes one short email from these findings, and it uses at most three of them, so return only the findings that earn their place, most commercially damaging first:
   - findings[0] — THE MAIN STORY: the single most commercially important or damaging thing the evidence shows.
   - findings[1] — THE WIDER COMMERCIAL OPPORTUNITY, where the evidence genuinely shows one (most often a declared property to sell whose valuation was never offered). It must be a DIFFERENT underlying event from findings[0], never the same point again. If findings[0] already IS the seller/valuation opportunity, do not restate it here.
   - findings[2] — ONE OPTIONAL SUPPORTING PROBLEM, only when it is materially different from findings[0] and adds something the email could not otherwise say.
   - positive_findings[0] — the strongest genuine thing they did well (rule 8).
   Every one of these slots may legitimately be empty, and two or three findings in total is a perfectly good answer. Never invent a wider opportunity, a supporting problem or a positive to fill a slot, and never pad by returning the same issue twice in different words. Prefer the stronger of two overlapping findings to both.
7. TYPE EVERY FINDING. 'problem' = something handled badly or not at all. 'opportunity' = commercial value that was sitting inside this enquiry and was never taken (most often the declared property to sell and the valuation behind it). If the enquiry declared a property to sell and no valuation was ever offered, that is an 'opportunity', not just a 'problem'.
8. POSITIVES ARE STRUCTURED FINDINGS, NOT A PARAGRAPH — AND THERE IS ROOM FOR EXACTLY ONE. positive_findings is the ONLY place a later step can read what the agency did well from, so a positive that exists only inside your strengths prose is one the outreach email can never use. Return the SINGLE strongest one: it is ONE specific act with its own evidence and its own one-line reason it matters — for example: finding "The team followed up quickly."; evidence "Three attempts across phone and email within one day."; significance_note "Shows strong persistence." Do not restate the whole strengths paragraph as one item, never return more than one, and never write a positive the evidence does not support — an empty array is the right answer when nothing positive is genuinely evidenced. If there was any human contact at all, there is almost always at least one genuine positive: they replied, they acknowledged it, they called, they asked a question, they followed up, they used the name or the property correctly. If there was NO human contact, positive_findings must be empty.

9. NEVER PRICE THE SELLER OPPORTUNITY. The only figure you are given is the asking price of the property the prospect enquired about AS A BUYER. There is NO figure on file for whatever property that same prospect declared they have to sell, so any price attached to the seller/valuation/instruction opportunity is a valuation nobody ever gave us. Do not state, infer, estimate, compare or imply a value for the seller's property anywhere — not in a finding, not in its evidence, not in its significance_note, not in strengths, missed_opportunities, commercial_implication or diagnosis_summary. Write the seller opportunity unpriced: "a declared seller opportunity", "a valuation opportunity", "a potential seller instruction", "a property to sell not yet on the market". NOT "a £450k valuation opportunity", "a valuation opportunity on a named £255k property", "a £225k+ instruction". You MAY still use the enquiry price for the BUYING side, where it is the price of the property they asked about ("a £450,000 enquiry went unanswered for 17 hours") — the ban is on lending that figure to the selling side.`;

function buildPrompt(intelligence, probe) {
  return [
    // PROVENANCE, STATED. The bare `(£450,000)` this line used to carry read
    // as "a price belonging to this probe", and the model then spent it on
    // whichever opportunity it was writing about — including the seller one,
    // which this figure says nothing about. Naming what the figure IS is half
    // the fix; SYSTEM_PROMPT rule 9 forbids the seller-side use, and
    // diagnoseProbe() strips it deterministically if the model does it anyway.
    `Property the prospect enquired about AS A BUYER: ${probe?.property_address || 'unknown'}`,
    `Asking price of THAT buyer-side property (the only figure on file, and NOT a value for anything the prospect has to sell): ${probe?.property_price || 'price unknown'}`,
    `Grade (reference only, do not template from it): ${intelligence.grade || 'unknown'} — ${intelligence.grade_reason || ''}`,
    `Human contact: ${intelligence.human_contact || 'unknown'}`,
    `Response time: ${intelligence.response_hours !== '' && intelligence.response_hours != null ? `${intelligence.response_hours} hours` : 'no human contact'}`,
    `Contact attempts: ${intelligence.contact_attempts ?? 0}, follow-ups after the first: ${intelligence.follow_ups ?? 0}`,
    `Channels used: ${intelligence.channels_used || 'none'}`,
    `Viewing progression: ${intelligence.viewing_progression || 'none'}`,
    `Buyer qualification depth: ${intelligence.buyer_qualification || 'none'} (questions asked: ${intelligence.buyer_questions_asked || 'none'})`,
    `Seller/vendor recognition: ${intelligence.seller_recognition === '' ? 'n/a — no property declared for sale' : (intelligence.seller_recognition || 'none')}`,
    `Communication quality: ${intelligence.communication_quality || 'unknown'}`,
    `What they did well (from the communications): ${intelligence.did_well || '(nothing recorded)'}`,
    `What they missed (from the communications): ${intelligence.missed || '(nothing recorded)'}`,
    `Verbatim evidence quotes: ${intelligence.evidence || '(none)'}`,
  ].join('\n');
}

// Guards against a finding with no evidence, or evidence with no finding —
// the one piece of non-AI logic in this module. Also drops anything past the
// cap, in case the model over-returns despite the schema.
//
// forcedType: 'positive' for the positives array; undefined for the story
// findings, where the model's own 'problem'/'opportunity' choice is kept and
// anything else falls back to 'problem' (never to 'positive' — a mistyped
// finding must not become praise).
function sanitizeFindings(findings, { max, forcedType } = {}) {
  return (Array.isArray(findings) ? findings : [])
    .map((f) => {
      const declared = String(f?.finding_type || '').trim().toLowerCase();
      return {
        finding_type: forcedType || (STORY_FINDING_TYPES.includes(declared) ? declared : 'problem'),
        // Seller-side price attribution removed AT SOURCE, before the finding
        // is ever persisted to DIAGNOSIS_FINDINGS. Surgical, not sentence-
        // level: only the price reference in a seller clause goes, so an
        // evidenced finding is never emptied (and never dropped by the
        // finding/evidence filter below) by this guard.
        finding: stripSellerPriceAttribution(String(f?.finding || '').trim()),
        evidence: stripSellerPriceAttribution(String(f?.evidence || '').trim()),
        significance_note: stripSellerPriceAttribution(String(f?.significance_note || '').trim()),
      };
    })
    .filter((f) => f.finding && f.evidence)
    .slice(0, max);
}

// intelligence: an INTELLIGENCE row (observation_status must already be
// 'closed' — caller's responsibility). probe: the PROBES row, for property
// context in the prompt.
// -> { findings (JSON string, [] when the evidence shows no problem),
//      strengths, missed_opportunities, commercial_implication,
//      novus_opportunity, diagnosis_summary }
export async function diagnoseProbe(intelligence, probe) {
  const result = await callAi({
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(intelligence, probe),
    tool: TOOL,
  });

  // ONE ordered list, problems/opportunities first so finding_index 1 still
  // means "most commercially damaging" and every index already written to a
  // sheet keeps the meaning it had. Positives are appended after them.
  const storyFindings = sanitizeFindings(result.findings, { max: MAX_STORY_FINDINGS });
  const positiveFindings = sanitizeFindings(result.positive_findings, { max: MAX_POSITIVE_FINDINGS, forcedType: 'positive' });
  // The per-probe cap, stated once rather than left implied by the two array
  // caps that already add up to it — a model that over-returns on both arrays
  // can never put a fifth row into DIAGNOSIS_FINDINGS.
  const findings = [...storyFindings, ...positiveFindings].slice(0, MAX_FINDINGS_PER_PROBE);
  const novusOpportunity = NOVUS_OPPORTUNITIES.includes(result.novus_opportunity) ? result.novus_opportunity : 'None evidenced';

  // The same provenance rule on the prose DIAGNOSIS fields. sanitizeFindings()
  // has already applied it to every findings row above.
  return {
    findings: JSON.stringify(findings),
    strengths: stripSellerPriceAttribution(String(result.strengths || '').trim()),
    missed_opportunities: stripSellerPriceAttribution(String(result.missed_opportunities || '').trim()),
    commercial_implication: stripSellerPriceAttribution(String(result.commercial_implication || '').trim()),
    novus_opportunity: novusOpportunity,
    diagnosis_summary: stripSellerPriceAttribution(String(result.diagnosis_summary || '').trim()),
  };
}

// Shared with lib/probe-personalisation.mjs so both sides agree on the
// stored shape: a DIAGNOSIS.findings cell is either '', a bare '[]', or a
// JSON array of { finding_type, finding, evidence, significance_note }.
// A legacy cell written before finding_type existed reads back untyped, and
// lib/diagnosis-findings.mjs's normaliseFindingType() defaults it to
// 'problem'. Never throws — unparsable content reads back as no findings.
export function parseDiagnosisFindings(diagnosis) {
  const raw = diagnosis?.findings;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Test-only surface, same shape as lib/probe-personalisation.mjs's: the brief
// the model is actually given, so the per-probe finding budget and the
// consolidate-don't-duplicate instruction are regression-tested rather than
// assumed to still be in the prompt.
export const _internal = {
  TOOL, SYSTEM_PROMPT,
  MAX_FINDINGS_PER_PROBE, MAX_STORY_FINDINGS, MAX_POSITIVE_FINDINGS,
  sanitizeFindings,
};
