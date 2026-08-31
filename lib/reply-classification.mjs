// lib/reply-classification.mjs — semantic classification of a genuine human
// Instantly reply, on top of the deterministic router.
//
// CLASSIFICATION IS BROAD. AUTOMATIC ACTION WILL BE NARROW.
// This file only decides what a reply MEANS and what routing metadata the
// REPLY_EVENTS row should carry. It executes nothing: no demo send, no
// Instantly write, no OUTBOUND update, no suppression, no notification. A
// POSITIVE_SEND_DEMO here is a classification, NOT a decision to send — the
// SEND_DEMO execution gate is a separate, stricter thing that does not exist
// yet.
//
// ORDER OF DECISIONING (the contract):
//   1. is_auto_reply -> OOO_AUTOMATED        deterministic, AI is NOT called
//   2. explicit opt-out phrase -> OPT_OUT    deterministic, AI is NOT called
//   3. everything else -> semantic AI classification
//   4. anything the AI returns that cannot be trusted -> OTHER_UNCLEAR /
//      MANUAL_REVIEW / HIGH, confidence blank, the failure reason recorded.
//
// Steps 1 and 2 are routeReply()'s existing behaviour and remain authoritative:
// a compliance-critical opt-out and an out-of-office never depend on a model
// call. Only step 3 is new.
//
// AI FAILURE MUST NEVER LOSE THE EVENT. Every failure path — transport error,
// timeout, HTTP 500, empty response, malformed JSON, unknown enum value,
// non-numeric or out-of-range confidence, confidence below threshold — returns
// a valid safe decision rather than throwing. The raw REPLY_EVENTS row is
// already persisted before this runs; a failure leaves it exactly as it was
// except for the derived fields, which land on the safe default.

import { callAi } from './ai-client.mjs';
import { CLASSIFICATIONS, ROUTING_TABLE, routeReply } from './reply-router.mjs';

// The model's self-reported confidence is a signal, not a verdict. Anything
// below this is treated as "the model was not sure enough to be believed" and
// falls back to OTHER_UNCLEAR / MANUAL_REVIEW, where a human sees it.
//
// Deliberately a single exported constant so it can be tuned (or later made
// per-class) without touching any decision logic.
export const CONFIDENCE_THRESHOLD = 0.85;

// Classes the model is allowed to choose. OOO_AUTOMATED and OPT_OUT are
// EXCLUDED on purpose: both are decided deterministically before this point, so
// offering them to the model would create a second, weaker path to a
// compliance-critical verdict.
export const AI_CLASSIFICATIONS = CLASSIFICATIONS.filter(
  (c) => c !== 'OOO_AUTOMATED' && c !== 'OPT_OUT',
);

export const CLASSIFIER_TOOL = {
  name: 'record_reply_classification',
  description: 'Record the single best classification of one prospect reply to NOVUS cold outreach.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['classification', 'confidence', 'reason'],
    properties: {
      classification: { type: 'string', enum: AI_CLASSIFICATIONS },
      confidence: {
        type: 'number',
        description: 'How certain you are, 0.0 to 1.0. Be honest — a low score routes the reply to a human, which is the safe outcome.',
      },
      reason: {
        type: 'string',
        description: 'One short sentence citing what in the reply decided it.',
      },
    },
  },
};

// The classifier reads INTENT, not keywords. The examples below are there to
// set the register of a real UK estate-agency inbox — short, casual, elliptical
// replies — not to be pattern-matched.
export const SYSTEM_PROMPT = `You classify a single reply from a UK estate agency to NOVUS's cold outreach email.

WHAT NOVUS DOES
NOVUS emails an agency about how it handled a real test enquiry NOVUS sent them, and offers to send/show them the breakdown (a "demo"). Follow-ups may instead offer a call.

THE MOST IMPORTANT INPUT IS THE PREVIOUS NOVUS MESSAGE
Short replies are answers to whatever NOVUS asked immediately before them. The same words mean different things:
  NOVUS asked "Want me to send the demo?"           -> "yeah okay" means POSITIVE_SEND_DEMO
  NOVUS asked "Open to a quick call tomorrow?"      -> "yeah okay" means POSITIVE_MEETING
  NOVUS offered "11am or 2pm tomorrow"              -> "tomorrow works" means POSITIVE_MEETING
So when a PREVIOUS NOVUS MESSAGE is given, it decides what a bare acceptance is accepting. It always outranks older messages and general assumptions.

WHEN THERE IS NO PREVIOUS NOVUS MESSAGE
You are told explicitly when none is available. In that case you know only that NOVUS's standing cold outreach offers to SEND a breakdown.
- A reply that says what it wants ("send it over", "send me whatever you've got", "happy to have a look") is still POSITIVE_SEND_DEMO — it names the thing itself.
- A reply that is only bare assent, and could equally be accepting a send OR a call ("yeah okay", "tomorrow works"), does NOT tell you which. Classify OTHER_UNCLEAR, or give a genuinely low confidence — do not guess between two different next actions.

CLASSIFY BY MEANING, NEVER BY KEYWORD
Replies are short, casual and elliptical. There is no required vocabulary — never require the words "demo", "send" or "meeting" to be present.

THE CLASSES — choose exactly one
POSITIVE_SEND_DEMO — they accept, agree to, or ask for the material NOVUS offered to send.
POSITIVE_MEETING — they want a conversation: a call, a chat, a meeting, a time, or their availability. Also when they accept a call NOVUS just offered, or pick one of the times NOVUS proposed.
QUESTION — they ask something a person must answer: price, how it works, what was tested, where their details came from, who NOVUS is. Also use this when they accept AND ask a question in the same reply.
NOT_INTERESTED — a rejection of the offer itself: not for us, not interested, we're happy with what we have. A refusal, not a timing problem, and NOT a request to be removed from a list.
NOT_NOW — a TIMING objection, with or without a date: come back in October, not at the minute, give me a shout in a few months, too much on right now, try me after Christmas. They are not saying no to the idea, only to now.
OTHER_UNCLEAR — you genuinely cannot tell what they mean, or the reply is bare assent with no context to anchor it.

IF THE DEMO HAS ALREADY BEEN SENT
You may be told that. A positive reply after it is not another request to send it — it is usually feedback and a move toward a conversation. "Looks good, let's chat" after the demo was sent is POSITIVE_MEETING.

MIXED INTENT — single label, and it is the one JOE MUST HANDLE NEXT
"Yes send it over, how much is it?" is QUESTION, not POSITIVE_SEND_DEMO: there is an unanswered direct question, and nothing may be auto-sent while it is ignored.
"Looks interesting, can you call me tomorrow?" is POSITIVE_MEETING.
"Maybe, what exactly is it?" is QUESTION.
An acceptance that also asks anything is always QUESTION.

CONFIDENCE
Report how certain you actually are, from 0.0 to 1.0. Under-reporting sends the reply to a human, which is safe. Over-reporting is not. Reserve 0.9+ for replies whose meaning a careful reader would not argue about. A bare acceptance with no previous NOVUS message to anchor it is exactly the case that deserves a low score.`;

// The context block. Absence is stated EXPLICITLY rather than omitted: a
// silently missing section reads to the model as "assume the usual", which is
// the opposite of what an unknown preceding message should mean.
export function buildContextBlock(context) {
  const previousNovus = String(context?.previous_novus_message ?? '').trim();
  const previousProspect = String(context?.previous_prospect_message ?? '').trim();
  const demoSent = context?.demo_already_sent;

  const lines = [];
  lines.push(previousNovus
    ? `PREVIOUS NOVUS MESSAGE (the message this reply is answering):\n${previousNovus}`
    : 'PREVIOUS NOVUS MESSAGE: none available — you do not know what was last offered.');
  if (previousProspect) {
    lines.push(`EARLIER MESSAGE FROM THIS PROSPECT:\n${previousProspect}`);
  }
  if (demoSent === true) lines.push('The demo has ALREADY been sent to this prospect.');
  else if (demoSent === false) lines.push('The demo has NOT yet been sent to this prospect.');
  return lines.join('\n\n');
}

export function buildClassifierPrompt(cleanedReplyText, context) {
  return [
    'Classify this reply from an estate agency to NOVUS cold outreach.',
    '',
    buildContextBlock(context),
    '',
    'REPLY TO CLASSIFY (this is the only thing you are classifying):',
    String(cleanedReplyText ?? '').trim() || '(empty)',
  ].join('\n');
}

function routed(classification, reason, confidence, extra = {}) {
  const route = ROUTING_TABLE[classification];
  return {
    classification,
    confidence,
    suppression_type: route.suppression_type,
    next_action: route.next_action,
    priority: route.priority,
    reason,
    error: '',
    ...extra,
  };
}

// The one safe landing place for every untrustworthy outcome.
export function safeFallback(reason, error = '') {
  return routed('OTHER_UNCLEAR', reason, null, { error, source: 'FALLBACK' });
}

// Validate the model's structured answer. Returns a decision, never throws.
// `raw` is whatever came back from callAi.
export function validateClassifierResult(raw) {
  if (!raw || typeof raw !== 'object') {
    return safeFallback('classifier returned no usable result', 'empty classifier response');
  }

  const classification = typeof raw.classification === 'string' ? raw.classification.trim() : '';
  if (!AI_CLASSIFICATIONS.includes(classification)) {
    return safeFallback(
      'classifier returned an unsupported classification',
      `unsupported classification: ${JSON.stringify(raw.classification ?? null)}`,
    );
  }

  const confidence = typeof raw.confidence === 'number' ? raw.confidence : Number(raw.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return safeFallback(
      'classifier returned an unusable confidence value',
      `invalid confidence: ${JSON.stringify(raw.confidence ?? null)}`,
    );
  }

  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';

  if (confidence < CONFIDENCE_THRESHOLD) {
    return {
      ...safeFallback(
        `classifier proposed ${classification} at ${confidence} — below the ${CONFIDENCE_THRESHOLD} threshold`,
        '',
      ),
      // The proposal is preserved for tuning, but it decides nothing.
      proposed_classification: classification,
      proposed_confidence: confidence,
      source: 'BELOW_THRESHOLD',
    };
  }

  return routed(classification, reason || `classified as ${classification}`, confidence, { source: 'AI' });
}

// classifyReply — the whole decision for one normalised reply.
//
// Deterministic first (AI is not called at all for those). Otherwise ONE AI
// call on cleaned_reply_text PLUS the minimal immediate thread context: the
// previous NOVUS message, optionally the previous prospect message, and
// whether the demo has already demonstrably been sent. Still no raw body, no
// quoted history, no full thread, no lead identity, no OUTBOUND row.
//
// context is optional. Absent or blank context is a valid, supported state —
// it makes the classifier MORE conservative (see SYSTEM_PROMPT), never less —
// so a context retrieval failure degrades the answer safely instead of
// blocking it. Nothing here writes anything.
//
// aiCall is injectable purely so tests can drive every failure path without a
// network or an API key; production leaves it as callAi.
export async function classifyReply(reply, { aiCall = callAi, model, context = null } = {}) {
  const deterministic = routeReply(reply);
  if (deterministic.classification !== 'OTHER_UNCLEAR') {
    return { ...deterministic, error: '', source: 'DETERMINISTIC' };
  }

  const text = String(reply?.cleaned_reply_text ?? '').trim();
  if (!text) {
    return safeFallback('reply has no cleaned text to classify');
  }

  let raw;
  try {
    raw = await aiCall({
      system: SYSTEM_PROMPT,
      prompt: buildClassifierPrompt(text, context),
      tool: CLASSIFIER_TOOL,
      ...(model ? { model } : {}),
    });
  } catch (err) {
    // Provider timeout, 5xx, malformed JSON, truncation — all land here, and
    // all leave the already-persisted raw event intact.
    return safeFallback('semantic classification failed', err?.message || 'classifier call failed');
  }

  return validateClassifierResult(raw);
}
