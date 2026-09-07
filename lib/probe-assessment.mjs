// lib/probe-assessment.mjs — THE ONE ANTHROPIC CALL IN THE ACQUISITION
// PIPELINE.
//
// WHAT IT REPLACED. The pipeline used to reason about the same enquiry three
// separate times with three separate model calls:
//   1. INTERPRETATION  — read the communications, produce the semantic
//                        INTELLIGENCE fields. Ran on EVERY inbound webhook and
//                        on every probe that had never been interpreted, i.e.
//                        repeatedly, while the probe was still observing and
//                        the evidence was still changing.
//   2. DIAGNOSIS       — read those fields back and produce the commercial
//                        assessment.
//   3. PERSONALISATION — read the findings and surface-realise two sentences
//                        that a deterministic renderer in
//                        lib/fact-constrained-personalisation.mjs was already
//                        producing anyway.
// Steps 1 and 2 were the same enquiry read twice, and step 3 bought nothing at
// all. Worse, all three shared one AI budget in sequence, so an interpretation
// backlog could starve diagnosis, and a diagnosis backlog could starve
// personalisation — which is exactly why "Rebuild Intelligence" moved DIAGNOSIS
// and left PERSONALISATION, DEMOS and OUTBOUND standing still.
//
// WHAT HAPPENS NOW. Nothing reaches a model until the probe's observation
// window CLOSES. At that moment — once, ever, per probe — this module makes ONE
// call that does the reading and the commercial assessment together, because
// they were always the same act: look at what actually happened, then say what
// it means commercially. Personalisation, demos and outbound are deterministic
// and cost nothing.
//
// EVERY SAFETY RULE HAS ONE IMPLEMENTATION. The model contract is pruned here,
// while validation and deterministic derivation stay in the existing shared
// functions:
//   - quote validation is deriveInterpretationFields() — a quote that is not a
//     literal substring of the message it cites is still dropped;
//   - every factual guard on the commercial half is sanitizeDiagnosisResult() —
//     the seller-price strip, the enquiry-address strip, the invented-prospect-
//     response strip, the finding/evidence gate, the four-finding cap, the
//     seller/valuation gate and the deterministic handling reconstruction.
// So there is no second, weaker implementation of any of them to drift.
//
// ZERO COMMUNICATIONS. A probe that received nothing gets its interpretation
// deterministically (lib/probe-interpretation.mjs's
// zeroCommunicationInterpretation) — no model can add anything to "nothing was
// received" — and the single call then assesses that, so the per-closed-probe
// ceiling of ONE call holds in every case.

import { callAi } from './ai-client.mjs';
import {
  INTERPRETATION_TOOL_PROPERTIES,
  buildInterpretationPrompt,
  deriveInterpretationFields,
  zeroCommunicationInterpretation,
} from './probe-interpretation.mjs';
import {
  DIAGNOSIS_MAX_TOKENS,
  buildDiagnosisPrompt,
  sanitizeDiagnosisResult,
  _internal as diagnosisInternal,
} from './probe-diagnosis.mjs';

// The INTELLIGENCE fields this call is responsible for. buyer_qualification is
// absent deliberately: it is floored from the validated question count, never
// returned by the model.
export const ASSESSMENT_INTELLIGENCE_FIELDS = Object.freeze([
  'viewing_progression', 'buyer_qualification', 'buyer_questions_asked',
  'seller_recognition',
]);

const INTERPRETATION_PROPERTY_NAMES = Object.freeze([
  'viewing_progression', 'buyer_questions_asked', 'seller_recognition',
]);

// The merged schema contains only the seven semantic fields production keeps.
// buyer_qualification is derived after quote validation and is never requested.
const TOOL = {
  name: 'record_probe_assessment',
  description: 'Read one probe\'s complete communication record and record BOTH what happened and what it means commercially, in one pass.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      ...INTERPRETATION_PROPERTY_NAMES,
      ...diagnosisInternal.TOOL.input_schema.required,
    ],
    properties: {
      ...Object.fromEntries(INTERPRETATION_PROPERTY_NAMES.map((key) => [key, INTERPRETATION_TOOL_PROPERTIES[key]])),
      ...diagnosisInternal.TOOL.input_schema.properties,
    },
  },
};

// One compact rule set for the retained reading and commercial fields.
const SYSTEM_PROMPT = [
  'You are completing the FINAL assessment of one NOVUS probe. Its observation window has closed, so the evidence below is complete and will not change. You do this once, and everything downstream is built from it.',
  '',
  'Read the agency\'s actual communications and the deterministic measurements, then return only the retained production fields.',
  '',
  'READING RULES:',
  '- viewing_progression records how far the agency moved the viewing: none, mentioned, invited, availability_requested, slot_offered or booked.',
  '- buyer_questions_asked lists only genuine qualification questions actually asked. Every quote must be copied verbatim from the cited communication_id; invalid quotes are discarded.',
  '- seller_recognition is relevant only when the original enquiry declares a property to sell. Record only what the agency actually did: none, asked_position, acknowledged, valuation_offered or valuation_booked. A declaration alone never makes a valuation appropriate.',
  '- Never infer that the listed property address or price belongs to a property the enquirer may sell.',
  '',
  diagnosisInternal.SYSTEM_PROMPT,
  '',
  'CONSISTENCY. Findings may rest only on the actual communications and supplied measurements. If the enquiry was handled well, findings is empty; that is complete and correct.',
].join('\n');

function buildPrompt(probe, communications, intelligence) {
  return [
    'THE COMMUNICATIONS (Part 1 evidence):',
    buildInterpretationPrompt(probe, communications),
    '',
    'THE DETERMINISTIC MEASUREMENTS (Part 2 context — already calculated, never re-derive or dispute them):',
    buildDiagnosisPrompt(intelligence, probe),
  ].join('\n');
}

// MODEL COST, AND WHY THIS NUMBER RATHER THAN A SMALLER ONE.
//
// The cap does not bill anything — output tokens are billed on what is actually
// produced — so its only job is to be comfortably above the largest legitimate
// result and below anything runaway: three findings, one positive, six signals,
// three unresolved questions, plus validated buyer-question quotes.
//
// It is set generously ON PURPOSE. Truncation is an ERROR, never a half record
// (lib/ai-structured-output.mjs), and an assessment that errors leaves the
// probe unassessed and retried on every subsequent run — so a cap set too
// tight would turn a long conversation into a permanently stuck probe.
export const ASSESSMENT_MAX_TOKENS = DIAGNOSIS_MAX_TOKENS + 800;

// probe: the PROBES row.
// communications: this probe's COMMUNICATIONS rows (deleted ones already
//   filtered out by the caller — this module never re-decides matching).
// deterministicIntelligence: the output of computeDeterministicIntelligence()
//   for this probe — grade, response time, attempts, follow-ups, channels,
//   observation status. Supplied, never recomputed here.
//
// -> { intelligence: {...the eight semantic INTELLIGENCE fields},
//      diagnosis:    {...the twelve DIAGNOSIS fields},
//      ai_calls_used: 1 }
//
// Exactly one AI call, always. Never called for a probe that is still
// observing — that is the caller's gate, and both callers
// (lib/assessment-rebuild.mjs, lib/observation-recompute.mjs) enforce it.
export async function assessProbe(probe, communications, deterministicIntelligence = {}) {
  const comms = Array.isArray(communications) ? communications : [];

  // Zero communications: the reading is deterministic, so the model is asked
  // only for the commercial half. Still one call, never two.
  const deterministicInterpretation = comms.length === 0 ? zeroCommunicationInterpretation(probe) : null;

  const intelligenceForPrompt = {
    ...deterministicIntelligence,
    ...(deterministicInterpretation || {}),
  };

  const result = await callAi({
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(probe, comms, intelligenceForPrompt),
    tool: TOOL,
    purpose: 'assessment',
    maxTokens: ASSESSMENT_MAX_TOKENS,
  });

  const interpretation = deterministicInterpretation
    || deriveInterpretationFields(result, probe, comms);

  // The commercial half is sanitised against the SAME intelligence row the
  // pipeline will persist — deterministic measurements plus the just-validated
  // semantic fields — so every guard that reads intelligence (the handling
  // summary rewrite, the already-answered-question filter) sees exactly what
  // DIAGNOSIS will be stored beside.
  const intelligenceRow = { ...deterministicIntelligence, ...interpretation };
  const diagnosis = sanitizeDiagnosisResult(result, intelligenceRow, probe);

  return { intelligence: interpretation, diagnosis, ai_calls_used: 1 };
}

export const _internal = { TOOL, SYSTEM_PROMPT, buildPrompt };
