// Fact-constrained Personalisation surface realiser.
//
// Its only factual input is PERSONALISATION_FACTS, and the model is limited
// to surface realisation of those canonical sentences. No PROBES,
// INTELLIGENCE, DIAGNOSIS, DIAGNOSIS_FINDINGS or raw communication value
// crosses the AI boundary here.

import { callAi } from './ai-client.mjs';
import {
  attributesEnquiryPriceToSeller,
  claimsProspectReply,
  claimsUnaskedQuestions,
  hookFailureAgainstObservation,
  makesUnsupportedVoicemailClaim,
  readsAsUnfairOutcomeCriticism,
  readsAsFalseChronology,
  readsAsInventedLoss,
  readsAsSpeculativeProspectBehaviour,
  secondHookFailure,
} from './probe-personalisation.mjs';
import { buildSupportContext, findUnsupportedRelationship } from './factual-relationships.mjs';

const MAX_ATTEMPTS = 2;
const CATEGORIES = ['positive', 'problems', 'consequences', 'secondary_facts'];
const FIELD_NAMES = ['email_observation', 'email_commercial_hook', 'email_commercial_hook_email_2'];

const TOOL = {
  name: 'realise_personalisation_facts',
  description: 'Render only the supplied canonical PERSONALISATION_FACTS as three natural email sentences.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: FIELD_NAMES,
    properties: Object.fromEntries(FIELD_NAMES.map((field) => [field, {
      type: 'string',
      description: 'One sentence, or an empty string only when the supplied field source is empty.',
    }])),
  },
};

const SYSTEM_PROMPT = `You are a constrained surface realiser, not an analyst.

Your complete factual universe is the OBSERVATION_FACTS and FINAL_EMAIL_OBSERVATION in the user message. Canonical fact text is authoritative. Do not reinterpret it.

You may only:
- choose sentence order;
- combine supplied facts;
- adjust grammar;
- make wording natural, concise, fair and commercially clear;
- use first-person wording only where the supplied fact already concerns the buyer or the property declared for sale.

You must not add facts, actions, replies, answers, chronology, causality, co-occurrence, quantities, certainty, seller instructions, property ownership or value claims, or universal claims. Preserve every uncertainty marker.
Never criticise failure to reach an outcome that required the prospect to reply or cooperate, including a booked or confirmed viewing/appointment, a booked slot, completed qualification, or generic "progress" beyond an agency request. Describe only what the agency itself did or did not do.

OBSERVATION
- Use every supplied positive and problem, and nothing else.
- At most one positive and at most two problems will be supplied.
- Positive plus problem: "Although [positive], [problem 1][, and problem 2]."
- Problems without a positive: "[problem 1][, and problem 2]."
- Positive without a problem: state only the positive.
- If neither exists, return an empty string.
- Prefer ordinary prospect-facing language over internal system terms. For example, where the current supplied fact licenses it, say "the property I'd said I had to sell" rather than repeatedly saying "declared seller opportunity".

COMMERCIAL HOOK
- Answer: "What is the immediate commercial consequence of this observation?"
- Begin exactly with "That meant that".
- Use only FINAL_EMAIL_OBSERVATION and HOOK_SOURCE, which is a conservative commercial frame derived from the same observation facts.
- Use plain, natural owner-facing language and avoid internal process terms.
- When the observation contains a seller opportunity, lead with that commercial consequence.
- Do not merely paraphrase the observation.

HOOK 2
- Answer: "What is a second, distinct commercial way of framing the same observation?"
- Do not begin with "That meant that".
- Use only FINAL_EMAIL_OBSERVATION and HOOK_2_SOURCE, which is a second conservative frame derived from the same observation facts.
- Use plain, natural owner-facing language and avoid internal process terms.
- Do not paraphrase the observation or the first hook.

HOOK SAFETY
- Neither hook may add a fact not contained in or directly implied by FINAL_EMAIL_OBSERVATION.
- A seller miss may become "potential valuation opportunity left without a next step", "seller opportunity left untouched", or "two opportunities present but only one progressed" when the observation supports it.
- Never claim lost revenue, instructions, fees, valuation, clients, or any numeric commercial impact.

Never import a detail from a gold example: every gold line below is generated only from the current input.`;

// Authorised prospect-facing equivalents of the canonical Phase 1 facts.
// This is a wording table only: it neither selects facts nor changes which
// fact feeds a field. The lexical safety gate below allows an alias only for
// the exact fact type currently assigned to that exact field.
function naturalFactText(fact) {
  const canonical = clean(fact?.text);
  switch (fact?.type) {
    case 'human_response_fast':
      return 'your team got back to the enquiry within 1 hour';
    case 'human_response_within_16h':
      return 'your team got back to the enquiry within 16 hours';
    case 'seller_opportunity_recognised':
      if (/valuation as booked/i.test(canonical)) return 'your team recorded a valuation as booked for the property I had said I wanted to sell';
      if (/offered a valuation/i.test(canonical)) return 'your team offered a valuation for the property I had said I wanted to sell';
      if (/acknowledged/i.test(canonical)) return 'your team acknowledged the property I had said I wanted to sell';
      return 'your team asked about the property I had said I wanted to sell';
    case 'concrete_buyer_next_step':
      if (/recorded.*booked/i.test(canonical)) return 'your team recorded my viewing as booked';
      if (/specific viewing slot/i.test(canonical)) return 'your team offered me a specific viewing slot';
      return 'your team asked for my availability for a viewing';
    case 'persistent_follow_up': {
      const count = canonical.match(/\b\d+\b/)?.[0];
      return count ? `your team made ${count} follow-up attempts` : canonical;
    }
    case 'complete_miss':
      return 'the enquiry received no human response or agency contact attempt during the observation window';
    case 'no_human_response':
      return 'the enquiry received no human response during the observation window';
    case 'slow_human_response':
      return 'the first human response came more than 16 hours after the enquiry';
    case 'no_follow_up':
      return 'your team made one human contact attempt, with no recorded follow-up';
    case 'buyer_not_progressed':
      return 'your team did not invite me to arrange a viewing, ask for my availability or offer a viewing slot';
    case 'buyer_not_qualified':
      return 'there were no recorded questions about my position as a buyer';
    case 'seller_not_recognised':
      return "nobody picked up on the property I'd said I had to sell";
    case 'seller_recognised_not_progressed':
      return "the property I'd said I had to sell was recognised without moving towards a valuation offer";
    case 'communication_record_incomplete':
      return 'the available communication record is incomplete';
    case 'buyer_received_no_further_progression':
      return 'there was no recorded viewing invitation, availability request or offered viewing slot';
    case 'seller_opportunity_not_developed':
      return "the property I'd said I had to sell never moved towards a valuation offer";
    case 'persistence_but_seller_not_recognised':
      return 'there was persistence on the enquiry, but the seller opportunity was never recognised';
    case 'response_speed_good_but_progression_weak':
      if (/qualification questions/i.test(canonical)) return 'the response was timely, but it did not include questions about my position as a buyer';
      return 'the response was timely, but it did not give me a concrete viewing next step';
    case 'two_opportunities_present_but_not_both_progressed':
      return 'the enquiry contained buyer and seller opportunities, without evidence that both were progressed';
    case 'enquiry_waited_before_human_handling':
      return 'the issue was the wait of more than 16 hours before recorded human handling';
    case 'communication_quality_not_determinable':
      return 'the incomplete record does not support a fair assessment of communication quality';
    case 'communication_content_unknown':
      return 'there is no available content or transcript, so what was discussed remains unknown';
    case 'communication_content_incomplete':
      return 'the record ends with an incomplete fragment, so anything beyond it remains unknown';
    case 'seller_intent_present_in_original_enquiry':
      return "I'd already mentioned the property I had to sell in the original enquiry";
    default:
      return canonical;
  }
}

const SURFACE_GRAMMAR_WORDS = new Set([
  'a', 'an', 'and', 'although', 'as', 'at', 'be', 'been', 'being', 'but', 'by',
  'did', 'does', 'either', 'for', 'from', 'had', 'has', 'have', 'however', 'if',
  'in', 'into', 'is', 'it', 'its', 'neither', 'nor', 'not', 'of', 'on', 'only',
  'or', 'remained', 'so', 'still', 'than', 'that', 'the', 'then', 'there', 'this',
  'though', 'to', 'was', 'were', 'what', 'when', 'while', 'with', 'within', 'yet',
  'your', 'agency', 'record', 'recorded', 'supported', 'supplied', 'shows', 'showed',
]);

const CONTENT_STOP_WORDS = new Set([
  ...SURFACE_GRAMMAR_WORDS,
  'after', 'before', 'during', 'further', 'more', 'no', 'one', 'two', 'up',
]);

const NUMBER_WORDS = new Map([
  ['zero', '0'], ['one', '1'], ['two', '2'], ['three', '3'], ['four', '4'],
  ['five', '5'], ['six', '6'], ['seven', '7'], ['eight', '8'], ['nine', '9'],
  ['ten', '10'], ['sixteen', '16'],
]);

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function sentence(value) {
  const text = clean(value).replace(/[.!?]+$/, '');
  return text ? `${text[0].toUpperCase()}${text.slice(1)}.` : '';
}

function lowerFirst(value) {
  const text = clean(value).replace(/[.!?]+$/, '');
  return text ? `${text[0].toLowerCase()}${text.slice(1)}` : '';
}

function joinFacts(facts) {
  const clauses = facts.map((item) => lowerFirst(naturalFactText(item))).filter(Boolean);
  if (clauses.length === 0) return '';
  if (clauses.length === 1) return clauses[0];
  return `${clauses.slice(0, -1).join(', ')}, and ${clauses.at(-1)}`;
}

function observationHookFrames(observationFacts) {
  const types = new Set(observationFacts.map((item) => item.type));
  const has = (type) => types.has(type);
  const frame = (type, text) => ({ type, text });

  if (has('seller_not_recognised')) {
    const hook = frame('observation_commercial_consequence', 'That meant that a potential valuation opportunity was left without any acknowledgement or next step.');
    if (has('slow_human_response')) {
      return [
        frame('observation_commercial_consequence', 'That meant that the enquiry was sitting untouched for more than 16 hours; a potential valuation opportunity went unacknowledged.'),
        frame('observation_second_commercial_frame', 'The delay mattered, but the seller opportunity in the enquiry was also missed.'),
      ];
    }
    if (has('concrete_buyer_next_step')) {
      return [hook, frame('observation_second_commercial_frame', 'The potential valuation conversation was never acknowledged.')];
    }
    if (has('persistent_follow_up')) {
      return [hook, frame('observation_second_commercial_frame', 'Persistence on the enquiry did not extend to the seller opportunity.')];
    }
    if (has('complete_miss') || has('no_human_response')) {
      return [hook, frame('observation_second_commercial_frame', 'The seller opportunity was left untouched alongside an unanswered buyer enquiry.')];
    }
    if (has('human_response_fast') || has('human_response_within_16h')) {
      return [hook, frame('observation_second_commercial_frame', 'The team responded to the buyer enquiry but left the seller opportunity untouched.')];
    }
    return [hook, frame('observation_second_commercial_frame', 'A viewing offer or request for availability was still missing from the buyer side.')];
  }

  if (has('seller_recognised_not_progressed')) {
    return [
      frame('observation_commercial_consequence', 'That meant that a recognised seller opportunity was left without a valuation offer or next step.'),
      frame('observation_second_commercial_frame', 'The seller side was noticed, but it never reached a valuation proposal.'),
    ];
  }

  if (has('complete_miss') || has('no_human_response')) {
    return [
      frame('observation_commercial_consequence', 'That meant that the enquiry was left without any response or next step.'),
      frame('observation_second_commercial_frame', 'The buyer enquiry never became a conversation.'),
    ];
  }

  if (has('buyer_not_progressed')) {
    return [
      frame('observation_commercial_consequence', 'That meant that the buyer enquiry was left without a clear route into a viewing.'),
      frame('observation_second_commercial_frame', 'The missing piece was a viewing offer or a request for availability.'),
    ];
  }

  if (has('buyer_not_qualified')) {
    return [
      frame('observation_commercial_consequence', 'That meant that the team learned nothing more about the buyer\'s position through its own questions.'),
      frame('observation_second_commercial_frame', 'The buyer opportunity remained unexplored beyond the initial enquiry.'),
    ];
  }

  if (has('slow_human_response')) {
    return [
      frame('observation_commercial_consequence', 'That meant that the enquiry missed the chance of a prompt first response.'),
      frame('observation_second_commercial_frame', 'A prompt first response was the missing piece.'),
    ];
  }

  if (has('communication_record_incomplete')) {
    return [
      frame('observation_commercial_consequence', 'That meant that there was not enough information to judge how well the enquiry was handled.'),
      frame('observation_second_commercial_frame', 'The missing detail limits any fair conclusion about the conversation.'),
    ];
  }

  if (has('concrete_buyer_next_step')) {
    return [
      frame('observation_commercial_consequence', 'That meant that the buyer had a clear next step towards a viewing.'),
      frame('observation_second_commercial_frame', 'The enquiry moved from initial contact to a specific viewing action.'),
    ];
  }

  return [
    frame('observation_commercial_consequence', 'That meant that the enquiry received a prompt human response.'),
    frame('observation_second_commercial_frame', 'Response speed was a clear strength in how the enquiry was handled.'),
  ];
}

function applyHookWording(output) {
  const result = { ...output };
  const hook = clean(result.email_commercial_hook);
  if (hook && !/^that meant that\b/i.test(hook)) {
    result.email_commercial_hook = `That meant that ${lowerFirst(hook)}`;
  }
  const hook2 = clean(result.email_commercial_hook_email_2);
  if (/^that meant that\b/i.test(hook2)) {
    result.email_commercial_hook_email_2 = hook2.replace(/^that meant that\s*/i, '');
  }
  return result;
}

function validatedFacts(personalisationFacts) {
  const value = personalisationFacts && typeof personalisationFacts === 'object'
    ? personalisationFacts : {};
  const selected = Object.fromEntries(CATEGORIES.map((category) => [category,
    (Array.isArray(value[category]) ? value[category] : [])
      .filter((item) => clean(item?.type) && clean(item?.text))
      // Provenance has already done its job in Phase 1. The surface model gets
      // only stable type + canonical text, so finding indexes and source-field
      // names cannot become accidental copy ingredients.
      .map((item) => ({ type: clean(item.type), text: clean(item.text) })),
  ]));
  if (selected.positive.length > 1) throw new Error('PERSONALISATION_FACTS may contain at most 1 positive');
  if (selected.problems.length > 2) throw new Error('PERSONALISATION_FACTS may contain at most 2 problems');
  return selected;
}

function fieldSources(facts) {
  const observation = [...facts.positive, ...facts.problems];
  const [hook, hook2] = observationHookFrames(observation);
  return {
    email_observation: observation,
    email_commercial_hook: hook ? [hook] : [],
    email_commercial_hook_email_2: hook2 ? [hook2] : [],
  };
}

export function renderCanonicalFactCopy(personalisationFacts) {
  const facts = validatedFacts(personalisationFacts);
  const sources = fieldSources(facts);
  let observation = '';
  if (facts.positive.length && facts.problems.length) {
    const positive = naturalFactText(facts.positive[0]);
    observation = facts.positive[0].type === 'concrete_buyer_next_step'
      ? sentence(`${positive}, but ${joinFacts(facts.problems)}`)
      : sentence(`Although ${lowerFirst(positive)}, ${joinFacts(facts.problems)}`);
  } else if (facts.problems.length) {
    observation = sentence(joinFacts(facts.problems));
  } else if (facts.positive.length) {
    observation = sentence(naturalFactText(facts.positive[0]));
  }
  return {
    email_observation: observation,
    email_commercial_hook: sentence(naturalFactText(sources.email_commercial_hook[0])),
    email_commercial_hook_email_2: sentence(naturalFactText(sources.email_commercial_hook_email_2[0])),
  };
}

export function buildFactConstrainedPrompt(personalisationFacts, repairReasons = [], lockedObservation = '') {
  const facts = validatedFacts(personalisationFacts);
  const sources = fieldSources(facts);
  const gold = renderCanonicalFactCopy(facts);
  const finalObservation = sentence(lockedObservation) || gold.email_observation;
  return [
    'OBSERVATION_FACTS:',
    JSON.stringify({ positive: facts.positive, problems: facts.problems }, null, 2),
    '',
    `FINAL_EMAIL_OBSERVATION: ${finalObservation || '(empty)'}`,
    ...(lockedObservation ? ['This observation is locked. Return it byte-for-byte unchanged.'] : []),
    '',
    'OBSERVATION-DERIVED HOOK SOURCES:',
    `OBSERVATION_SOURCE: ${JSON.stringify(sources.email_observation)}`,
    `HOOK_SOURCE: ${JSON.stringify(sources.email_commercial_hook)}`,
    `HOOK_2_SOURCE: ${JSON.stringify(sources.email_commercial_hook_email_2)}`,
    '',
    'GOLD GRAMMAR SHAPES — these use only this input:',
    `Observation: ${gold.email_observation || '(empty because its source is empty)'}`,
    `Commercial hook: ${gold.email_commercial_hook || '(empty because its source is empty)'}`,
    `Hook 2: ${gold.email_commercial_hook_email_2 || '(empty because its source is empty)'}`,
    ...(repairReasons.length ? [
      '',
      'CORRECTION REQUIRED. The previous wording was rejected. Return all three fields again using only the same supplied facts:',
      ...repairReasons.map((reason) => `- ${reason.field}: ${reason.reason}`),
    ] : []),
  ].join('\n');
}

function tokens(value) {
  return clean(value).toLowerCase().replace(/[’']/g, '').match(/[a-z0-9]+/g) || [];
}

function numberTokens(value) {
  return tokens(value)
    .map((token) => NUMBER_WORDS.get(token) || (/^\d+(?:\.\d+)?$/.test(token) ? token : null))
    .filter(Boolean);
}

function textCoverage(output, sourceText) {
  const sourceTokens = [...new Set(tokens(sourceText).filter((token) => token.length >= 4 && !CONTENT_STOP_WORDS.has(token)))];
  if (sourceTokens.length === 0) return 1;
  const outputTokens = new Set(tokens(output));
  return sourceTokens.filter((token) => outputTokens.has(token)).length / sourceTokens.length;
}

function authorisedSurfaceTexts(source) {
  const texts = [source.text, naturalFactText(source)];
  if (source.type === 'observation_commercial_consequence' && /valuation opportunity/i.test(source.text)) {
    texts.push('A potential valuation opportunity was left without a next step.', 'The seller opportunity was left untouched.');
  }
  if (source.type === 'observation_second_commercial_frame' && /buyer and seller opportunities/i.test(source.text)) {
    texts.push('Two opportunities were present, but only the buyer side progressed.', 'Two opportunities were present, but only one received a next step.');
  }
  return texts;
}

function factCoverage(output, source) {
  return Math.max(...authorisedSurfaceTexts(source).map((text) => textCoverage(output, text)));
}

function factualSurfaceFailure(output, sources) {
  const sourceText = sources.map((item) => item.text).join(' ');
  const authorisedNaturalText = sources.flatMap(authorisedSurfaceTexts).join(' ');
  const allowed = new Set([...tokens(sourceText), ...tokens(authorisedNaturalText), ...SURFACE_GRAMMAR_WORDS]);
  const added = [...new Set(tokens(output).filter((token) => !allowed.has(token)))];
  if (added.length) return `adds vocabulary absent from canonical facts: ${added.join(', ')}`;

  const allowedNumbers = new Set(numberTokens(sourceText));
  const addedNumbers = numberTokens(output).filter((token) => !allowedNumbers.has(token));
  if (addedNumbers.length) return `adds quantities absent from canonical facts: ${[...new Set(addedNumbers)].join(', ')}`;

  const uncovered = sources.filter((source) => factCoverage(output, source) < 0.6).map((source) => source.type);
  if (uncovered.length) return `does not preserve supplied facts: ${uncovered.join(', ')}`;
  return null;
}

function relationshipSupport(facts) {
  const all = [...facts.positive, ...facts.problems];
  const sellerDeclared = all.some((item) => /seller_(?:not_recognised|recognised_not_progressed|opportunity)|seller opportunity/i.test(`${item.type} ${item.text}`));
  const contentUnknown = facts.secondary_facts.some((item) => /communication_content_(?:unknown|incomplete)/.test(item.type));
  return buildSupportContext({
    probe: { enquiry_text: sellerDeclared ? 'A property to sell was declared in the enquiry.' : '' },
    findings: all.map((item) => ({ finding: item.text, evidence: item.text })),
    intelligence: {},
    prospectContactEvidenced: false,
    callContentUnknown: contentUnknown,
  });
}

const FORBIDDEN_COMMERCIAL_LOSS_RE = /\b(?:lost|lose|losing)\b[^.!?]{0,28}\b(?:revenue|instructions?|fees?|valuations?|clients?)\b|\b(?:revenue|instructions?|fees?|valuations?|clients?)\b[^.!?]{0,28}\b(?:lost|lose|losing)\b/i;
const NUMERIC_COMMERCIAL_IMPACT_RE = /(?:[£$€]\s*\d|\b\d+(?:\.\d+)?%?\b)[^.!?]{0,32}\b(?:revenue|fees?|commission|commercial impact|loss|value)\b|\b(?:revenue|fees?|commission|commercial impact|loss|value)\b[^.!?]{0,32}(?:[£$€]\s*\d|\b\d+(?:\.\d+)?%?\b)/i;

function readsAsResponseDependentOutcomeCriticism(value) {
  const text = clean(value);
  if (readsAsUnfairOutcomeCriticism(text)) return true;
  return [
    /\b(?:qualification|qualifying process|buyer checks?)\b[^.!?]{0,36}\b(?:never|not|wasn['’]?t|weren['’]?t|failed to)\b[^.!?]{0,20}\b(?:complete(?:d)?|finish(?:ed)?|conclude(?:d)?)\b/i,
    /\b(?:never|not|failed to|didn['’]?t)\b[^.!?]{0,20}\b(?:complete|finish|conclude)(?:d)?\b[^.!?]{0,36}\b(?:qualification|qualifying process|buyer checks?)\b/i,
    /\b(?:enquiry|buyer|prospect|viewing)\b[^.!?]{0,36}\b(?:never|not|failed to|didn['’]?t)\b[^.!?]{0,20}\b(?:reach(?:ed)?|progress(?:ed)?|move(?:d)? forward)\b[^.!?]{0,28}\b(?:book(?:ed|ing)?(?:\s+slot)?|viewing time|appointment)\b/i,
    /\b(?:buyer and seller|seller and buyer)\s+opportunit(?:y|ies)\b[^.!?]{0,48}\b(?:without|no)\s+evidence\b[^.!?]{0,32}\bprogress(?:ed|ion)?\b/i,
  ].some((pattern) => pattern.test(text));
}

export function validateFactConstrainedOutput(personalisationFacts, output) {
  const facts = validatedFacts(personalisationFacts);
  const sources = fieldSources(facts);
  const support = relationshipSupport(facts);
  const result = Object.fromEntries(FIELD_NAMES.map((field) => [field, sentence(output?.[field])]));
  const rejections = [];

  for (const field of FIELD_NAMES) {
    const value = result[field];
    const expectedSources = sources[field];
    if (expectedSources.length === 0) {
      if (value) rejections.push({ field, reason: 'source is empty but AI returned text' });
      continue;
    }
    if (!value) {
      rejections.push({ field, reason: 'blank despite a supplied source fact' });
      continue;
    }

    const surfaceFailure = factualSurfaceFailure(value, expectedSources);
    if (surfaceFailure) rejections.push({ field, reason: surfaceFailure });
    if (attributesEnquiryPriceToSeller(value)) rejections.push({ field, reason: 'existing validator: seller price attribution' });
    if (readsAsInventedLoss(value)) rejections.push({ field, reason: 'existing validator: invented commercial loss' });
    if (claimsProspectReply(value)) rejections.push({ field, reason: 'existing validator: unsupported prospect reply' });
    if (readsAsFalseChronology(value)) rejections.push({ field, reason: 'existing validator: false chronology' });
    if (makesUnsupportedVoicemailClaim(value)) rejections.push({ field, reason: 'existing validator: unsupported voicemail content claim' });
    if (claimsUnaskedQuestions(value)) rejections.push({ field, reason: 'existing validator: unasked questions' });
    if (readsAsSpeculativeProspectBehaviour(value)) rejections.push({ field, reason: 'existing validator: speculative prospect behaviour' });
    if (readsAsResponseDependentOutcomeCriticism(value)) rejections.push({ field, reason: 'response-dependent outcome criticism' });
    const relationshipFailure = findUnsupportedRelationship(value, support);
    if (relationshipFailure) rejections.push({ field, reason: `existing relationship validator: ${relationshipFailure}` });
  }

  if (result.email_commercial_hook_email_2) {
    const distinctnessFailure = secondHookFailure(
      result.email_commercial_hook_email_2,
      result.email_observation,
      result.email_commercial_hook,
    );
    if (distinctnessFailure) {
      rejections.push({
        field: 'email_commercial_hook_email_2',
        reason: `existing Hook 2 distinctness validator: ${distinctnessFailure}`,
      });
    }
  }

  for (const field of ['email_commercial_hook', 'email_commercial_hook_email_2']) {
    const value = result[field];
    if (!value) continue;
    if (FORBIDDEN_COMMERCIAL_LOSS_RE.test(value)) rejections.push({ field, reason: 'forbidden commercial loss claim' });
    if (NUMERIC_COMMERCIAL_IMPACT_RE.test(value)) rejections.push({ field, reason: 'numeric commercial impact' });
  }

  if (result.email_commercial_hook) {
    const hookFailure = hookFailureAgainstObservation(result.email_commercial_hook, result.email_observation);
    if (hookFailure) rejections.push({ field: 'email_commercial_hook', reason: `existing commercial hook validator: ${hookFailure}` });
  }

  return { result, rejections };
}

export async function personaliseProbeFromFacts(personalisationFacts, { enabled = false } = {}) {
  if (!enabled) throw new Error('Fact-constrained Personalisation requires { enabled: true } explicitly');
  const facts = validatedFacts(personalisationFacts);
  let rejections = [];
  let lockedObservation = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = await callAi({
      system: SYSTEM_PROMPT,
      prompt: buildFactConstrainedPrompt(facts, rejections, lockedObservation),
      tool: TOOL,
    });
    const worded = applyHookWording(result);
    const candidate = lockedObservation ? { ...worded, email_observation: lockedObservation } : worded;
    const validated = validateFactConstrainedOutput(facts, candidate);
    if (validated.rejections.length === 0) {
      return { ...validated.result, ai_calls_used: attempt, used_canonical_fallback: false };
    }
    if (!lockedObservation && validated.rejections.every((item) => item.field !== 'email_observation')) {
      lockedObservation = validated.result.email_observation;
    }
    rejections = validated.rejections;
  }

  const fallback = { ...renderCanonicalFactCopy(facts), ...(lockedObservation ? { email_observation: lockedObservation } : {}) };
  const validatedFallback = validateFactConstrainedOutput(facts, fallback);
  if (validatedFallback.rejections.length) {
    throw new Error(`Canonical PERSONALISATION_FACTS fallback failed validation: ${JSON.stringify(validatedFallback.rejections)}`);
  }
  return { ...validatedFallback.result, ai_calls_used: MAX_ATTEMPTS, used_canonical_fallback: true };
}

export const _internal = {
  TOOL, SYSTEM_PROMPT, MAX_ATTEMPTS, fieldSources, factualSurfaceFailure, naturalFactText,
  applyHookWording, observationHookFrames, readsAsResponseDependentOutcomeCriticism,
};
