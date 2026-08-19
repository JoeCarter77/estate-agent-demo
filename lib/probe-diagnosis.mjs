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
// primary_problem may legitimately be empty: a probe the evidence shows was
// handled well produces no forced problem. The deterministic guard below
// (requireProblemHasEvidence) is the only non-AI logic here: a problem
// without its evidence, or evidence without its problem, is never written.

import { callAi } from './ai-client.mjs';

const NOVUS_OPPORTUNITIES = ['Core (front desk)', 'Growth (valuation list / seller conversion)', 'None evidenced'];

const TOOL = {
  name: 'record_probe_diagnosis',
  description: 'Record the commercial diagnosis for one probe, derived strictly from its Intelligence evidence.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['primary_problem', 'primary_evidence', 'secondary_problem', 'secondary_evidence', 'strengths', 'missed_opportunities', 'commercial_implication', 'novus_opportunity', 'diagnosis_summary'],
    properties: {
      primary_problem: { type: 'string', description: 'The single most commercially damaging finding. Empty string if the evidence shows no real problem.' },
      primary_evidence: { type: 'string', description: 'The specific fact or quote it rests on. Empty string if primary_problem is empty.' },
      secondary_problem: { type: 'string', description: 'A second, distinct finding, only if the evidence genuinely supports one. Empty string otherwise.' },
      secondary_evidence: { type: 'string', description: 'Empty string if secondary_problem is empty.' },
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
2. Do not force a problem. If the evidence shows fast, persistent, well-qualified, well-progressed handling of both the buying and selling opportunity, primary_problem and secondary_problem must be empty strings — say so plainly in strengths and diagnosis_summary, and only name a novus_opportunity if the evidence genuinely points at one (otherwise "None evidenced").
3. Every problem needs its own evidence field non-empty; never state a problem you cannot back with a specific fact from the Intelligence row (a quote, a number of hours, a count of questions, an explicit absence like "no valuation was ever offered").
4. commercial_implication must contain something specific to THIS agency and THIS probe — not a sentence that could be pasted onto any other agency's diagnosis.
5. The probe always creates exactly two opportunities: BUYING (the viewing + qualifying the buyer) and SELLING (the declared property + the valuation, only if one was declared). missed_opportunities should name which of these, specifically, was left on the table — or state that both were taken.`;

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

// Guards against a problem with no evidence, or evidence with no problem —
// the one piece of non-AI logic in this module.
function requireProblemHasEvidence(problem, evidence) {
  const p = String(problem || '').trim();
  const e = String(evidence || '').trim();
  if (!p || !e) return { problem: '', evidence: '' };
  return { problem: p, evidence: e };
}

// intelligence: an INTELLIGENCE row (observation_status must already be
// 'closed' — caller's responsibility). probe: the PROBES row, for property
// context in the prompt.
// -> { primary_problem, primary_evidence, secondary_problem,
//      secondary_evidence, strengths, missed_opportunities,
//      commercial_implication, novus_opportunity, diagnosis_summary }
export async function diagnoseProbe(intelligence, probe) {
  const result = await callAi({
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(intelligence, probe),
    tool: TOOL,
  });

  const primary = requireProblemHasEvidence(result.primary_problem, result.primary_evidence);
  const secondary = requireProblemHasEvidence(result.secondary_problem, result.secondary_evidence);
  const novusOpportunity = NOVUS_OPPORTUNITIES.includes(result.novus_opportunity) ? result.novus_opportunity : 'None evidenced';

  return {
    primary_problem: primary.problem,
    primary_evidence: primary.evidence,
    secondary_problem: secondary.problem,
    secondary_evidence: secondary.evidence,
    strengths: String(result.strengths || '').trim(),
    missed_opportunities: String(result.missed_opportunities || '').trim(),
    commercial_implication: String(result.commercial_implication || '').trim(),
    novus_opportunity: novusOpportunity,
    diagnosis_summary: String(result.diagnosis_summary || '').trim(),
  };
}
