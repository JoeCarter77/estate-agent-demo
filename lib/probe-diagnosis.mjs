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
// never written. Capped at 4 items — Diagnosis states what the evidence
// shows, it does not try to be exhaustive; Personalisation (downstream) is
// the layer that judges which of these findings combine into the strongest
// commercial narrative, so this module deliberately stops at "here are the
// genuine, evidence-backed findings and why each matters," not "here is the
// one story."

import { callAi } from './ai-client.mjs';

const NOVUS_OPPORTUNITIES = ['Core (front desk)', 'Growth (valuation list / seller conversion)', 'None evidenced'];
const MAX_FINDINGS = 4;

const TOOL = {
  name: 'record_probe_diagnosis',
  description: 'Record the commercial diagnosis for one probe, derived strictly from its Intelligence evidence.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['findings', 'strengths', 'missed_opportunities', 'commercial_implication', 'novus_opportunity', 'diagnosis_summary'],
    properties: {
      findings: {
        type: 'array',
        description: 'Every genuine, distinct, commercially meaningful problem the evidence shows — 0 to 4 items, most commercially damaging first. Empty array if the evidence shows no real problem. Do not pad this to 4; only include a finding the evidence actually supports.',
        maxItems: MAX_FINDINGS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['finding', 'evidence', 'significance_note'],
          properties: {
            finding: { type: 'string', description: 'One distinct, commercially damaging thing the evidence shows — stated as its own finding, not folded into another.' },
            evidence: { type: 'string', description: 'The specific fact or quote this finding rests on (a quote, a number of hours, a count of questions, an explicit absence). Never empty when finding is non-empty.' },
            significance_note: { type: 'string', description: 'Why this finding matters commercially and whether this agency would likely recognise it themselves without NOVUS — the raw material a later step uses to judge how commercially consequential this finding is, not a sentence about the whole probe.' },
          },
        },
      },
      strengths: { type: 'string', description: 'What the agency did well, evidence-backed. May be the longest field when handling was strong.' },
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
3. Every finding needs its own evidence field non-empty; never state a finding you cannot back with a specific fact from the Intelligence row (a quote, a number of hours, a count of questions, an explicit absence like "no valuation was ever offered"). Each finding must be genuinely distinct — do not split one observation into two findings, and do not repeat the same problem worded differently.
4. commercial_implication must contain something specific to THIS agency and THIS probe — not a sentence that could be pasted onto any other agency's diagnosis.
5. The probe always creates exactly two opportunities: BUYING (the viewing + qualifying the buyer) and SELLING (the declared property + the valuation, only if one was declared). missed_opportunities should name which of these, specifically, was left on the table — or state that both were taken.
6. You are not choosing "the" story — you are listing every genuine finding, most commercially damaging first, so a later step can decide how they combine. Do not compress several real findings into one just because they relate to the same opportunity.`;

function buildPrompt(intelligence, probe) {
  return [
    `Property: ${probe?.property_address || 'unknown'} (${probe?.property_price || 'price unknown'})`,
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
// the one piece of non-AI logic in this module. Also drops anything past
// MAX_FINDINGS, in case the model over-returns despite the schema cap.
function sanitizeFindings(findings) {
  return (Array.isArray(findings) ? findings : [])
    .map((f) => ({
      finding: String(f?.finding || '').trim(),
      evidence: String(f?.evidence || '').trim(),
      significance_note: String(f?.significance_note || '').trim(),
    }))
    .filter((f) => f.finding && f.evidence)
    .slice(0, MAX_FINDINGS);
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

  const findings = sanitizeFindings(result.findings);
  const novusOpportunity = NOVUS_OPPORTUNITIES.includes(result.novus_opportunity) ? result.novus_opportunity : 'None evidenced';

  return {
    findings: JSON.stringify(findings),
    strengths: String(result.strengths || '').trim(),
    missed_opportunities: String(result.missed_opportunities || '').trim(),
    commercial_implication: String(result.commercial_implication || '').trim(),
    novus_opportunity: novusOpportunity,
    diagnosis_summary: String(result.diagnosis_summary || '').trim(),
  };
}

// Shared with lib/probe-personalisation.mjs so both sides agree on the
// stored shape: a DIAGNOSIS.findings cell is either '', a bare '[]', or a
// JSON array of { finding, evidence, significance_note }. Never throws —
// unparsable/legacy content reads back as no findings.
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
