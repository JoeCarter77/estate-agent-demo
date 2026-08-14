// lib/personalisation.mjs — the NOVUS Personalisation Engine.
//
// Position in the pipeline (Source Master §21, following §20's Sales
// Strategy Engine):
//   OBSERVATION -> GRADE (grading.mjs) -> TIER (tier.mjs)
//                -> SALES STRATEGY (sales-strategy.mjs) -> PERSONALISATION
//
// COPY, NOT STRATEGY. lib/sales-strategy.mjs decides WHAT the commercial
// angle is (§20: observed_problem, commercial_implication, sales_focus,
// discovery_focus, demo_type, email_strategy, phone_strategy, next_action).
// This module is only allowed to turn that already-made decision into
// wording. It never re-derives grade, tier, demo_type or sales_focus, and it
// is never called until a resolved, non-blank strategy exists.
//
// Unlike grading.mjs / tier.mjs / sales-strategy.mjs, this module is NOT
// pure — it calls the Anthropic API to generate prose. That is the entire
// reason it is a separate module rather than an extra branch inside
// sales-strategy.mjs: mixing a non-deterministic, networked, potentially
// failing AI call into the deterministic engines (each explicitly tested to
// perform "no I/O, no AI") would break the guarantee the rest of the
// pipeline depends on. Everything that CAN be decided deterministically
// already has been, upstream; only wording generation happens here.
//
// AI PROVIDER PATTERN — reuses the only existing precedent in this repo
// (api/chat.js): a raw `fetch` to the Anthropic Messages API using
// ANTHROPIC_API_KEY, no SDK dependency. Unlike api/chat.js (free-text
// chat), this module needs a validated structured result, so it forces a
// single tool call (Anthropic tool-use) whose input schema is exactly the
// seven required fields, and rejects anything that doesn't match that shape
// — never falls back to accepting arbitrary model text where a structured
// field is expected.
//
// PERSISTENCE (see the module doc block below `generatePersonalisation`
// for the full reasoning): this module performs no persistence at all. It
// returns a generated package for the caller (a later outreach/demo layer)
// to consume. It is never called from lib/observation-recompute.mjs and
// never upserts an INTELLIGENCE row, so it cannot create a circular
// dependency with the Observation & Evidence Engine and never triggers a
// recompute itself.
//
// EVIDENCE DISCIPLINE (Source Master §21 "AI must not invent behaviour. The
// prospect's own recorded behaviour is the proof."): the AI never sees raw
// free-form context. It receives exactly three things: (1) the deterministic
// strategy, verbatim, as an instruction it must not reconsider; (2) an
// evidence packet built ONLY from fields that are actually present on the
// supplied probe/agency/observation records — anything absent is omitted,
// never filled in as "unknown" prose the model could mistake for a fact; and
// (3) an explicit, itemised list of claims it is never allowed to make. The
// returned object is validated against a strict schema before it is ever
// handed back to a caller.

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

// Model choice is deliberately independent of api/chat.js's Haiku default:
// that endpoint answers short live-chat replies where latency dominates,
// while this module drafts outbound sales copy generated once per probe and
// then reused across a call, an email and a demo intro — quality matters
// more than latency here. Overridable via env for cost/quality tuning
// without a code change.
const DEFAULT_MODEL = process.env.NOVUS_PERSONALISATION_MODEL || 'claude-sonnet-5';

// The seven Source Master §21 outputs, exact names, exact order.
export const PERSONALISATION_FIELDS = [
  'personalised_first_line',
  'grade_specific_call_opener',
  'email_variant',
  'demo_introduction',
  'why_novus',
  'relevant_proof_point',
  'relevant_objection_response',
];

// The eight Sales Strategy Engine fields this module is allowed to read as
// an authoritative instruction (lib/sales-strategy.mjs FIELDS). Duplicated
// here (not imported) deliberately: this module must never import anything
// callable from sales-strategy.mjs, only accept its already-computed output
// as a plain object, so it is structurally impossible for personalisation
// code to invoke or re-derive the strategy itself.
const STRATEGY_FIELDS = [
  'observed_problem', 'commercial_implication', 'sales_focus', 'discovery_focus',
  'demo_type', 'email_strategy', 'phone_strategy', 'next_action',
];

const GROWTH_GRADES = new Set(['A', 'B']);

export class PersonalisationValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'PersonalisationValidationError';
    this.details = details;
  }
}

export class PersonalisationGenerationError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'PersonalisationGenerationError';
    this.cause = cause;
  }
}

function blankPersonalisation(reason) {
  const out = {};
  for (const f of PERSONALISATION_FIELDS) out[f] = '';
  out.meta = { generated: false, model: null, reason };
  return out;
}

function hasResolvedStrategy(strategy) {
  if (!strategy || typeof strategy !== 'object') return false;
  return STRATEGY_FIELDS.every((f) => typeof strategy[f] === 'string' && strategy[f].length > 0);
}

function nonEmpty(v) {
  return v !== undefined && v !== null && String(v).trim() !== '';
}

// ── Evidence packet (§21 inputs) ─────────────────────────────────────────
// Pure, absence-safe: a field is included only when it is actually present
// on the supplied record. Nothing is inferred, defaulted to "unknown", or
// invented — an absent field simply does not appear, so the model has no
// string to mistake for a real value.
//
// { probe, agency, observation } -> { property, behaviour, agency }
export function buildEvidencePacket({ probe = {}, agency = null, observation = {} } = {}) {
  const property = {};
  const PROPERTY_FIELDS = [
    ['property_address', 'address'],
    ['property_price', 'price'],
    ['property_status', 'status'],
    ['portal', 'portal'],
    ['probe_timestamp', 'enquiry_submitted_at'],
    ['enquiry_text', 'enquiry_text'],
  ];
  for (const [src, out] of PROPERTY_FIELDS) {
    if (nonEmpty(probe[src])) property[out] = probe[src];
  }

  const behaviour = {};
  const BEHAVIOUR_FIELDS = [
    'first_human_touch', 'first_human_touch_at', 'human_lag_hours',
    'follow_up_count', 'follow_up_channels', 'contact_attempt_count',
    'days_chased', 'channels_used', 'auto_acknowledgement', 'auto_ack_timestamp',
    'persistence_profile', 'contact_quality', 'proactive_reactive',
  ];
  for (const f of BEHAVIOUR_FIELDS) {
    if (nonEmpty(observation[f])) behaviour[f] = observation[f];
  }

  const agencyOut = {};
  if (agency) {
    const AGENCY_FIELDS = [
      ['agency_name', 'agency_name'],
      ['primary_contact_name', 'contact_name'],
      ['crm_name', 'crm_name'],
      ['years_trading', 'years_trading'],
      ['live_listing_count', 'live_listing_count'],
    ];
    for (const [src, out] of AGENCY_FIELDS) {
      if (nonEmpty(agency[src])) agencyOut[out] = agency[src];
    }
  }

  return { property, behaviour, agency: agencyOut };
}

// ── Prompt construction (pure, no network) ───────────────────────────────

const PROHIBITED_CLAIMS = [
  'response times, call counts, email counts, SMS counts or follow-up counts that are not present in the evidence packet',
  'calls, emails, SMS, follow-ups, conversations or booking attempts that did not happen',
  'property information (address, price, status) beyond what is in the evidence packet',
  'CRM name or capability beyond what is in the evidence packet — if crm_name is absent, say the system used is not currently known, never guess a product',
  'agency characteristics (years trading, listing count, branch count) beyond what is in the evidence packet',
  'staff names',
  'trading history not present in the evidence packet',
  'database size',
  'outcomes of this or any other outreach',
  'client proof points, results, percentages or numbers of any kind — the only legitimate proof point is the prospect\'s own recorded behaviour in this evidence packet',
  'a claim that the prospect has raised any objection — an objection response is a prepared answer to a LIKELY objection, never a claim they said it',
];

function styleGuidance() {
  return [
    'House style, from the NOVUS Email Personalisation & Outreach Reference (source of truth for tone, structure and terminology; the deterministic strategy below takes precedence whenever the two conflict):',
    '- Create a "how do they know this?" reaction using the exact probe evidence (§1). Never a generic opening like "Hope you\'re well."',
    '- Use the deepest level of personalisation the evidence actually supports (property alone; property + response timing; + follow-up + channel; or the full exact-sequence "WTF" level) — never force detail the evidence does not have.',
    '- Growth angle (demo_type starting "growth_"): explicitly acknowledge the strong front-desk handling and make clear you are not contacting them to fix it. The pain is the opportunity that enters the pipeline and disappears before becoming an instruction (a valuation that did not convert, a past vendor, an applicant who mentioned selling) — not "database reactivation" or "CRM optimisation" framing.',
    '- Core angle (demo_type starting "front_desk_"): use the exact observed gap from the strategy below — never collapse it to a generic "your response is bad."',
    '- CTA: point directly at the personalised proof (e.g. "See what would have happened with your enquiry", "See how we\'d work those opportunities"). Never weak permission-seeking like "Worth a look?".',
    '- Keep copy concise. Specificity earns the extra words, generic filler does not.',
    '',
    'email_variant structure (§2 — a six-part sequence to adapt to the actual evidence and strategy, never a rigid fill-in-the-blank template):',
    '  1. WTF opening — the strongest available probe facts (property, price, area, enquiry timing, response timing, follow-up timing, channels, attempt sequence), pitched to land the "how do they know this?" reaction from §1.',
    '  2. Evidence-backed interpretation — state what happened without exaggerating it.',
    '  3. Commercial pain — turn the observation into a commercially meaningful problem before any product language.',
    '  4. NOVUS mechanism — one concise sentence on how NOVUS addresses that specific problem.',
    '  5. Personalised demo — position the demo as built around this agency and this opportunity, never as a generic sales asset.',
    '  6. CTA — point directly at the personalised proof, per the CTA rule above.',
    '',
    'Non-negotiables (§14):',
    '- Select the strongest facts only. Do not expose every available data point merely to prove NOVUS has data — specificity should feel earned, not exhaustive.',
    '- Never lead with generic "AI for estate agents" positioning. The prospect\'s actual observed problem must be established first; product category framing comes after, if at all.',
    '',
    'demo_introduction purpose (§9 — the deterministic demo_type decides which of these applies; you must not swap between them on your own judgement):',
    '- Growth demo (demo_type starting "growth_", grades A/B): the demo shows the work opportunities ALREADY GENERATED by the agency that NOVUS would keep working — seller intent, non-converting valuations, past vendors, applicants — never a repeat of the front-desk demo.',
    '- Core / Front Desk demo (demo_type starting "front_desk_", grades C-H): the demo shows the ENQUIRY JOURNEY FROM RESPONSE THROUGH TO BOOKING (qualification, conversation, booking, follow-up), framed around the exact observed gap in the strategy below.',
  ].join('\n');
}

// relevant_objection_response has no source in the NOVUS Email
// Personalisation & Outreach Reference — that document was checked in full
// and contains zero mentions of "objection" anywhere. It does not define an
// objection-handling framework, so this field is NOT document-derived and
// must not be dressed up as if it were. It is generated only from the
// deterministic Sales Strategy (observed_problem, commercial_implication,
// sales_focus, discovery_focus), the observed evidence packet, and the
// existing hard rules below (never invented from general sales knowledge,
// and never a claim that the prospect actually raised the objection).
function systemPrompt() {
  return [
    'You are the NOVUS Personalisation Engine. You generate persuasive wording for an estate-agency sales outreach package. You do not make commercial decisions — those have already been made deterministically and are supplied to you as a fixed instruction.',
    '',
    'HARD RULES:',
    '1. The supplied grade, tier and sales strategy are authoritative and final. You may not reconsider, soften, contradict or reroute them — for example, if demo_type is "front_desk_persistence" you must not pitch Growth/database, and if demo_type is "growth_database" you must not invent a front-desk weakness.',
    '2. Every factual claim you make must be directly traceable to the supplied evidence packet or strategy text. You must never invent, estimate or imply any of the following: ' + PROHIBITED_CLAIMS.map((c) => `(${c})`).join('; ') + '.',
    '3. If the evidence does not establish something, do not claim it. Where a field in the evidence packet is absent, that fact is unknown — say so or omit it; never fill the gap with a plausible-sounding invention.',
    '4. If you cannot produce a genuinely evidence-backed value for relevant_proof_point, return exactly this fallback string: "No independent proof point is available for this agency yet — the strongest proof is their own recorded behaviour on this probe." Do not fabricate a substitute.',
    '5. You must call the emit_personalisation tool exactly once with ALL SEVEN fields present and non-empty: personalised_first_line, grade_specific_call_opener, email_variant, demo_introduction, why_novus, relevant_proof_point, relevant_objection_response. There is no optional field. relevant_objection_response in particular is frequently and incorrectly treated as skippable — it is not: derive it from the sales strategy and evidence packet exactly like the other fields (see the dedicated note on it below) and always include it. relevant_proof_point may use the fallback string from rule 4, but the field itself must still be present — never omit any of the seven.',
    '',
    styleGuidance(),
    '',
    'relevant_objection_response — mandatory, not optional (see rule 5): this is a prepared answer to the objection most likely to arise given the supplied demo_type and commercial_implication (e.g. a Growth pitch to a strong front desk likely meets "our enquiries are already handled fine"; a Core pitch after a fast-but-unpursued response likely meets "we did reply, so this isn\'t a problem"). Derive it only from the strategy fields and evidence packet above — never invent that the prospect actually raised it, and never reach for general sales-objection knowledge beyond what those fields support.',
  ].join('\n');
}

function userPrompt({ grade, tier, strategy, evidence, agencyName }) {
  const payload = {
    authoritative_decision: {
      grade,
      tier,
      demo_type: strategy.demo_type,
      note: 'Do not override any of the above. Turn the strategy fields below into wording; do not re-derive them.',
      observed_problem: strategy.observed_problem,
      commercial_implication: strategy.commercial_implication,
      sales_focus: strategy.sales_focus,
      discovery_focus: strategy.discovery_focus,
      email_strategy: strategy.email_strategy,
      phone_strategy: strategy.phone_strategy,
      next_action: strategy.next_action,
    },
    evidence_packet: evidence,
    agency_name: agencyName || '(not supplied — do not invent one; use "you"/"your team" instead of a name)',
  };
  return [
    'Generate the seven personalisation outputs for this prospect using ONLY the JSON below as your factual source. Do not use any knowledge about estate agents, NOVUS, or this agency beyond what is written here.',
    '',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}

// Per-field descriptions, not a single generic string, so each field carries
// its own reminder of what it needs — relevant_objection_response spells out
// that it is mandatory because it is the field most often dropped in
// practice (observed omission under live API load), not because the other
// six are any less required.
const FIELD_DESCRIPTIONS = {
  personalised_first_line: 'A concise opening line for outreach referencing the actual observed behaviour. Required, non-empty.',
  grade_specific_call_opener: 'Words a salesperson can say on the phone, reflecting the grade and strategy. Required, non-empty.',
  email_variant: 'The personalised email copy, following the six-part structure above. Required, non-empty.',
  demo_introduction: 'A short intro for the personalised demo, matching the Growth/Core purpose above. Required, non-empty.',
  why_novus: 'One concise sentence on why NOVUS is relevant to this agency. Required, non-empty.',
  relevant_proof_point: 'Evidence-backed proof, or the exact fallback string from hard rule 4 if none is available. Required — always present, even when it is the fallback.',
  relevant_objection_response: 'REQUIRED — do not omit. A prepared response to the objection most likely given demo_type and commercial_implication, derived only from the strategy/evidence supplied. This field is mandatory exactly like the other six and must always be included in the tool call.',
};

const TOOL_SCHEMA = {
  name: 'emit_personalisation',
  description: 'Return all seven NOVUS personalisation outputs. Every field listed in "required" is mandatory — the call is invalid and will be rejected if any field, including relevant_objection_response, is missing or empty.',
  input_schema: {
    type: 'object',
    properties: Object.fromEntries(
      PERSONALISATION_FIELDS.map((f) => [f, { type: 'string', description: FIELD_DESCRIPTIONS[f] }]),
    ),
    required: [...PERSONALISATION_FIELDS],
    additionalProperties: false,
  },
};

// Pure — builds the exact request that would be sent, without sending it.
// Exists so the request shape is independently testable (deterministic
// inputs -> deterministic request) without mocking the network.
export function buildPersonalisationRequest({ grade, tier, strategy, probe, agency, observation, model = DEFAULT_MODEL } = {}) {
  const evidence = buildEvidencePacket({ probe, agency, observation });
  return {
    model,
    max_tokens: 1200,
    system: systemPrompt(),
    messages: [
      { role: 'user', content: userPrompt({ grade, tier, strategy, evidence, agencyName: agency && agency.agency_name }) },
    ],
    tools: [TOOL_SCHEMA],
    tool_choice: { type: 'tool', name: TOOL_SCHEMA.name },
  };
}

// ── Structured-output validation ─────────────────────────────────────────
// Rejects anything that isn't exactly the seven required string fields.
// Never silently accepts partial output or coerces a wrong type.
export function validatePersonalisationOutput(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new PersonalisationValidationError('AI output is not an object', { obj });
  }
  const keys = Object.keys(obj);
  for (const f of PERSONALISATION_FIELDS) {
    if (!(f in obj)) errors.push(`missing field: ${f}`);
    else if (typeof obj[f] !== 'string') errors.push(`field ${f} must be a string, got ${typeof obj[f]}`);
    else if (obj[f].trim() === '' && f !== 'relevant_proof_point') errors.push(`field ${f} must not be empty`);
  }
  const extra = keys.filter((k) => !PERSONALISATION_FIELDS.includes(k));
  if (extra.length) errors.push(`unexpected field(s): ${extra.join(', ')}`);
  if (errors.length) {
    throw new PersonalisationValidationError(`Malformed AI personalisation output: ${errors.join('; ')}`, { obj, errors });
  }
  const out = {};
  for (const f of PERSONALISATION_FIELDS) out[f] = obj[f];
  return out;
}

// Bounded repair budget for defaultCallAi's malformed-tool-call retry (see
// below) — exactly one corrective turn, never more.
const MAX_REPAIR_ATTEMPTS = 1;

async function postToAnthropic(body, apiKey, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new PersonalisationGenerationError('Anthropic request failed', err);
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new PersonalisationGenerationError(err.error?.message || `Anthropic API error ${response.status}`);
  }
  return response.json();
}

// ── Default AI call (Anthropic Messages API, tool-use forced) ───────────
// Mirrors api/chat.js's raw-fetch pattern (no SDK). Injectable via the
// `callAi` parameter of generatePersonalisation so tests never touch the
// network — see scripts/novus-personalisation-selftest.mjs. Exported
// separately (not just used as generatePersonalisation's default) so its
// own bounded-repair behaviour is independently testable via an injected
// `fetchImpl`, without going through the callAi seam.
//
// Anthropic's tool-use `required` array is a strong instruction to the
// model, not a server-enforced JSON-Schema validator — the model can still
// omit a required field under real load (observed: relevant_objection_
// response dropped on a live call). Rather than weakening
// validatePersonalisationOutput() to tolerate that, this adds exactly ONE
// corrective follow-up turn when the first tool call is malformed/
// incomplete: it replays the assistant's tool call, tells the model in its
// own validation-error terms what was missing or invalid, and asks it to
// re-emit the complete tool call. It never fabricates or fills in the
// missing field itself. If the repair attempt is also malformed, this
// still returns whatever the model produced — validatePersonalisationOutput()
// in generatePersonalisation() remains the single, unweakened final gate
// and will reject it exactly as before.
export async function defaultCallAi(request, { fetchImpl = fetch } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new PersonalisationGenerationError('ANTHROPIC_API_KEY is not configured');
  }

  const messages = [...request.messages];
  let raw = null;
  let model = request.model;

  for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
    const data = await postToAnthropic({ ...request, messages }, apiKey, fetchImpl);
    const toolUse = (data.content || []).find((b) => b.type === 'tool_use' && b.name === TOOL_SCHEMA.name);
    if (!toolUse) {
      throw new PersonalisationGenerationError('Anthropic response did not include the required tool call');
    }
    raw = toolUse.input;
    model = data.model || request.model;

    try {
      validatePersonalisationOutput(raw);
      return { raw, model };
    } catch (validationErr) {
      if (attempt >= MAX_REPAIR_ATTEMPTS) {
        // Repair budget exhausted — return the best-effort result as-is.
        // generatePersonalisation()'s own validation call rejects it.
        return { raw, model };
      }
      messages.push({ role: 'assistant', content: data.content });
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolUse.id,
          is_error: true,
          content: `Your ${TOOL_SCHEMA.name} call was invalid: ${validationErr.details.errors.join('; ')}. `
            + 'Call it again with ALL SEVEN fields present and non-empty — personalised_first_line, '
            + 'grade_specific_call_opener, email_variant, demo_introduction, why_novus, relevant_proof_point, '
            + 'and relevant_objection_response. Do not omit any field. Do not invent a fact to fill a gap — derive '
            + 'the missing field(s) from the same strategy and evidence packet you were given.',
        }],
      });
    }
  }
  // Unreachable given the loop bounds above.
  return { raw, model };
}

// { probe, agency, observation, grade, tier, strategy, callAi } -> the seven
// fields + meta.
//
// grade / tier / strategy: pass through exactly what grading.mjs, tier.mjs
// and sales-strategy.mjs already computed for this probe. This function
// never recomputes them and never calls the Observation & Evidence Engine
// itself — the caller is responsible for having a current recompute result
// already in hand (no triggering a recompute from here, no circular
// dependency with lib/observation-recompute.mjs).
//
// If the strategy is not fully resolved (pending / compromised / any
// inconsistent pipeline state — exactly the states where
// buildSalesStrategy() itself returns all-blank fields), this returns a
// blank package WITHOUT calling the AI at all: no commercial personalisation
// package is generated from insufficient or compromised evidence.
//
// On AI failure or malformed/rejected output, this THROWS
// (PersonalisationGenerationError / PersonalisationValidationError) rather
// than returning a fabricated or silently-blank result — callers can
// distinguish "no strategy yet" (blank, no error) from "AI generation
// failed" (thrown error) and neither path ever mutates persisted state,
// since this module performs no persistence.
export async function generatePersonalisation({
  probe = {},
  agency = null,
  observation = {},
  grade,
  tier = '',
  strategy = null,
  callAi = defaultCallAi,
} = {}) {
  if (!hasResolvedStrategy(strategy)) {
    return blankPersonalisation('No resolved Sales Strategy for this probe (pending, compromised, or an inconsistent pipeline state) — insufficient evidence for a commercial personalisation package.');
  }

  const request = buildPersonalisationRequest({ grade, tier, strategy, probe, agency, observation });
  const { raw, model } = await callAi(request);
  const validated = validatePersonalisationOutput(raw);

  return {
    ...validated,
    meta: { generated: true, model, reason: null },
  };
}

// ── Persistence note (Source Master §21 vs INTELLIGENCE, §13) ───────────
//
// This module intentionally does NOT write to the INTELLIGENCE sheet, and
// is not called from lib/observation-recompute.mjs. Reasoning (see the task
// report for the full writeup):
//
// 1. lib/schema.mjs documents INTELLIGENCE as "calculated evidence,
//    behaviour, grade, tier and sales strategy" — every existing producer of
//    an INTELLIGENCE column (grading.mjs, tier.mjs, sales-strategy.mjs) is
//    pure and deterministic, and novus-sales-strategy-selftest.mjs actively
//    asserts "the module performs no I/O and invokes no AI" as a hard
//    guarantee of that sheet's contents. This module is the first AI-backed,
//    non-deterministic, network-calling piece of the pipeline; folding its
//    output into the same row would break that guarantee for every existing
//    consumer of INTELLIGENCE.
// 2. INTELLIGENCE.ai_evidence_summary / ai_confidence (and COMMUNICATIONS'
//    ai_summary/ai_confidence/ai_model) are pre-existing placeholder columns
//    for a DIFFERENT purpose — a short AI summary/confidence over evidence
//    interpretation — not a home for seven paragraphs of outbound sales copy
//    per grade. No columns for personalised_first_line / email_variant /
//    etc. exist anywhere in the live schema, and adding seven new
//    always-changing (re-generation is non-deterministic) text columns to a
//    sheet designed to be idempotently upserted by a pure recompute pass
//    would be a materially different kind of write than anything
//    observation-recompute.mjs does today.
// 3. observation-recompute.mjs already runs on every webhook delivery and
//    every manual recompute; calling an LLM on that path would mean an
//    inbound Twilio/email webhook now blocks on (and can fail because of) an
//    external AI call, and would regenerate paid-for AI copy on every
//    recompute even when nothing commercially meaningful changed.
//
// Recommendation: (B) Personalisation stays a generated package, produced
// on demand by whatever later outreach/demo layer needs it (not built in
// this task — see NOVUS_Email_Personalisation_Reference.docx §12 "Outreach
// sequence" and Source Master §22/§23), consuming the current grade/tier/
// strategy already sitting in INTELLIGENCE. If/when that layer needs to
// persist a generated package, it should get its own dedicated
// PERSONALISATION rows (one per generation, since copy can legitimately be
// regenerated) rather than mutating the deterministic INTELLIGENCE row —
// but that persistence design is out of scope here and deliberately left
// unimplemented rather than guessed at.
