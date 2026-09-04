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
Report how certain you actually are, from 0.0 to 1.0. Under-reporting sends the reply to a human, which is safe. Over-reporting is not. Reserve 0.9+ for replies whose meaning a careful reader would not argue about.

A bare acceptance with NO previous NOVUS message to anchor it is exactly the case that deserves a low score — you are guessing between two different next actions.

But the reverse is equally true, and matters just as much. When the previous NOVUS message IS given and it asks ONE unambiguous question, a plain acceptance of that question is NOT a borderline call — it is as clear as English gets, and it deserves 0.95+. "Want me to send it over?" answered with "Sure thing", "Yep", "Please do", "Go on then" or "Sounds good" means yes, send it. Do not mark such a reply down merely because it is short, casual, or contains no specific nouns: brevity is how people actually answer a direct question, and the anchoring question has already removed the ambiguity. A low score there wrongly sends an unambiguous acceptance to a human.

Judge the reply AS AN ANSWER to the message directly above it, not as a standalone sentence.`;

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

  // The proposition, named. Derived from the previous message's final question
  // by the same code the deterministic rules use, so the model and those rules
  // can never disagree about what was asked.
  if (previousNovus) {
    const ctaType = context?.previous_novus_cta_type ?? previousNovusCtaType(previousNovus);
    const described = {
      SEND_DEMO: 'NOVUS offered to SEND the breakdown. An acceptance here means "yes, send it".',
      CALL_OR_MEETING: 'NOVUS asked about a CALL, a time, or availability. An acceptance here is about that conversation — it is NOT a request to send anything.',
      OTHER: 'NOVUS asked a question that is neither a send offer nor a call request. Read the reply as an answer to it.',
    }[ctaType];
    if (described) lines.push(`WHAT NOVUS ASKED: ${described}`);
  }
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

// ---------------------------------------------------------------------------
// THE CONTEXTUAL AFFIRMATIVE RULE.
//
// A bare "sure thing" has NO fixed meaning. It inherits its meaning entirely
// from the proposition it is answering. This rule fires ONLY when both halves
// of that relationship are unambiguous:
//
//   1. the immediately preceding NOVUS message's OPERATIVE QUESTION is a
//      send-the-demo CTA, with no competing call/meeting ask attached, and
//   2. the reply reduces to a bare affirmative and nothing else.
//
// Either half missing -> this does not fire and the model decides, exactly as
// before. It can therefore never widen POSITIVE_SEND_DEMO on reply text alone,
// which is the failure mode a global phrase list would have introduced.
//
// WHY DETERMINISTIC AT ALL, rather than only strengthening the prompt: with
// both halves established there is no judgement left to make, and a model's
// self-reported confidence on a two-word reply is the least reliable number in
// the system — it was 0.55 on a reply whose meaning was not actually in doubt.
// The automatic-send threshold is NOT lowered anywhere; this makes the
// confidence correct instead.

// The operative question is the LAST one in the message. NOVUS emails open with
// narrative — which legitimately contains words like "availability" and
// "viewing" from the enquiry being described — and close with the ask. Scanning
// the whole body for competing keywords would trip on that narrative every
// time, so only the CTA region is examined.
export function extractCtaRegion(previousNovusMessage) {
  const text = String(previousNovusMessage ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const lastQuestion = text.lastIndexOf('?');
  if (lastQuestion < 0) return '';
  // Back up to the start of the sentence that question ends.
  const before = text.slice(0, lastQuestion);
  const boundary = Math.max(before.lastIndexOf('. '), before.lastIndexOf('! '), before.lastIndexOf('? '));
  // From the operative question to the END of the message: a competing ask
  // tacked on after it ("...or happy to jump on a call instead.") must count.
  return text.slice(boundary < 0 ? 0 : boundary + 2);
}

const SEND_DEMO_CTA_PATTERN =
  /\b(?:want me to|shall i|should i|would you like me to|do you want me to|happy to|can i|ok(?:ay)? (?:for me )?to)\s+(?:just\s+)?(?:send|share|forward|pass)\b/i;

// Anything that turns the ask into a DIFFERENT next action. Checked only inside
// the CTA region, so narrative mentions elsewhere are irrelevant.
const COMPETING_CTA_PATTERN =
  /\b(?:call|phone|ring|chat|meeting|meet|catch up|speak|availability|available|diary|calendar|book|zoom|teams|slot|monday|tuesday|wednesday|thursday|friday|\d{1,2}\s*(?:am|pm))\b/i;

// What the previous NOVUS message actually PROPOSED. Named explicitly rather
// than left for the model to re-derive from prose on every call: the whole
// difficulty with a two-word reply is that its meaning lives entirely in this
// one fact, and asking the model to infer it from a five-paragraph email each
// time is what produced inconsistent confidence on identical situations.
//
//   SEND_DEMO       — offers to send/share the breakdown, and nothing else
//   CALL_OR_MEETING — asks for a call, a time, or availability (possibly as
//                     well as a send, which makes a bare "sure" ambiguous)
//   OTHER           — a question that is neither
//   null            — no question found, so nothing was proposed
export function previousNovusCtaType(previousNovusMessage) {
  const region = extractCtaRegion(previousNovusMessage);
  if (!region) return null;
  if (COMPETING_CTA_PATTERN.test(region)) return 'CALL_OR_MEETING';
  if (SEND_DEMO_CTA_PATTERN.test(region)) return 'SEND_DEMO';
  return 'OTHER';
}

export function isSendDemoCta(previousNovusMessage) {
  return previousNovusCtaType(previousNovusMessage) === 'SEND_DEMO';
}

// Bare affirmatives. Deliberately NOT a general "positive language" list: each
// entry is a complete reply that adds nothing beyond assent.
export const AFFIRMATIVE_REPLIES = [
  'yes', 'yep', 'yeah', 'yup', 'ya', 'aye',
  'yes please', 'yeah please', 'yep please', 'yes thanks', 'yes please do',
  'sure', 'sure thing', 'sure thanks', 'yeah sure', 'yes sure', 'ok sure',
  'absolutely', 'definitely', 'certainly',
  'please do', 'please send', 'please send it', 'please send it over',
  'go ahead', 'go for it', 'go on', 'go on then', 'yeah go on',
  'send it', 'send it over', 'send it across', 'send over', 'send across', 'send away',
  'fire away', 'ok', 'okay', 'ok then', 'okay then', 'okay please', 'yeah okay', 'yes okay',
  'fine by me', 'sounds good', 'sounds great', 'sounds good to me', 'that would be great', 'that will be great',
  'why not', 'works for me', 'happy to have a look', 'happy to take a look',
  'alright', 'all right', 'fine', "that's fine", 'thats fine', 'okay yeah', 'yep sure',
  'yeah send it through', 'send it through', 'yeah send it', 'yes send it', 'yes send it over',
];

// Deferrals of whatever was just proposed. The mirror image of the affirmative
// list, and needed for the same reason: "maybe later" answering a known offer
// is not a 0.75 judgement call, it is a plain deferral of that offer.
export const DEFERRAL_REPLIES = [
  'maybe later', 'later', 'maybe next week', 'maybe next month', 'maybe another time',
  'maybe some other time', 'another time', 'some other time', 'perhaps another time',
  'perhaps later', 'not right now', 'not now', 'not at the moment', 'not at the minute',
  'not today', 'not this week', 'not this month', 'come back to me later',
  'come back to me', 'try me later', 'ask me later', 'check back later',
  'maybe in a few months', 'maybe in a bit', 'not just yet', 'not yet',
];

// Any of these anywhere in the reply means it is NOT a bare affirmative, even
// if an affirmative phrase opens it: "sure thing, but call me first" is a
// redirection, not an acceptance.
const CONTRADICTION_PATTERN =
  /\b(?:but|however|although|though|actually|instead|first|before|unless|rather|dont|don't|do not|not|no thanks|hold off|wait|call me|give me a call|ring me)\b/i;

// The deferral rule needs its OWN contradiction guard: half the deferral
// phrases legitimately contain "not" ("not right now", "not at the moment"), so
// reusing the affirmative guard above would reject every one of them. What
// contradicts a deferral is an instruction to act NOW, or a competing ask.
const DEFERRAL_CONTRADICTION_PATTERN =
  /\b(?:but|however|although|though|actually|instead|unless|send|call me|give me a call|ring me|go ahead|do it)\b/i;

// A sign-off STARTS a closing block — "Thanks, Joe" is one, and so is the bare
// "Thanks". Matching the start (not the whole part) is what lets "thanks joe"
// be recognised when no comma separates them.
const SIGN_OFF_PATTERN =
  /^(?:thanks|thank you|thankyou|cheers|regards|kind regards|best regards|best wishes|best|many thanks|ta|speak soon|talk soon)\b/i;

const GREETING_PATTERN =
  /^(?:hi|hey|hello|hiya|dear|good morning|good afternoon|good evening|morning|afternoon)\b[^.,!?\n]{0,40}[,.!]?\s*/i;

function normalise(value) {
  return String(value ?? '')
    .replace(/[‘’ʼ]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// The prospect's own words, split into the parts that actually carry intent.
//
// COMMAS ARE BOUNDARIES. "Yeah okay, sure. Thanks, Joe" was the real reply that
// failed: splitting on sentence punctuation alone left "thanks, joe" as one
// unrecognisable part, so the whole reply was judged to contain something
// beyond an affirmative and the rule declined. Commas separate a sign-off from
// its name, and separate stacked affirmatives ("yeah okay, sure"), so they must
// split too.
//
// Only greetings and closing blocks are removed, and a closing block is only
// removed when something else precedes it — a one-word reply is never mistaken
// for a signature. Nothing else is ever dropped: speculative trailing removal
// would reduce "sure thing, but call me first" to "sure thing" and auto-send
// against an explicit instruction not to.
function meaningfulParts(cleanedReplyText) {
  const text = normalise(cleanedReplyText);
  if (!text) return null;
  // A question is a request for information, never a bare accept-or-defer.
  if (text.includes('?')) return null;

  const withoutGreeting = text.replace(GREETING_PATTERN, '').trim();
  if (!withoutGreeting) return null;

  const parts = withoutGreeting
    .split(/[.,!;\n]+/)
    .map((s) => s.replace(/^[\s,;:-]+|[\s,;:-]+$/g, '').trim())
    .filter(Boolean);
  if (!parts.length) return null;

  const kept = [];
  for (const part of parts) {
    const isSignOff = SIGN_OFF_PATTERN.test(part);
    // A lone name, e.g. the "Joe" under "Thanks,". Never an affirmative or a
    // deferral, which are checked first so "sure" and "later" survive.
    const isName = /^[a-z][a-z'-]{1,19}$/.test(part)
      && !AFFIRMATIVE_REPLIES.includes(part)
      && !DEFERRAL_REPLIES.includes(part);
    if (isSignOff || isName) continue;
    kept.push(part);
  }
  return kept.length ? kept : null;
}

// Words that are a complete affirmation ON THEIR OWN. People stack them —
// "yes sure thing", "yeah okay sure", "yep sure" — and enumerating every
// combination in AFFIRMATIVE_REPLIES is a losing game: a real "Yes sure thing"
// missed the list and fell through to the model, which scored it 0.85.
const AFFIRMATIVE_LEAD_ATOMS = [
  'yes', 'yeah', 'yep', 'yup', 'ya', 'aye',
  'sure', 'ok', 'okay', 'alright', 'absolutely', 'definitely', 'certainly',
  'fine', 'great', 'perfect',
];

// A single part is affirmative if it is a known affirmative, OR if it is one
// affirmative atom followed by something that is itself affirmative.
//
// THIS IS NOT SPECULATIVE STRIPPING. A token is only removed when that token is
// a complete affirmation in its own right, and whatever remains must ALSO be
// affirmative — so no content is ever discarded to force a match. "sure, call
// me first" still fails: "call me" is not affirmative, so the whole part is not.
// Bounded depth keeps a pathological input cheap.
// Conversational tail that carries no intent: a vocative ("yeah sure thing
// MATE") or an inline thanks ("yes CHEERS"). A real reply — "Yeah sure thing
// mate" — declined for this reason alone once its parent had resolved.
//
// A CLOSED list, stripped only from the END, and only when something remains.
// This is not general trailing-token removal: "yes call me" keeps "call me",
// because "call me" is not in this list.
const VOCATIVE_TAIL_PATTERN =
  /(?:\s+(?:mate|pal|buddy|bud|chief|thanks|thankyou|cheers|ta))+$/i;

function stripVocativeTail(part) {
  const stripped = part.replace(VOCATIVE_TAIL_PATTERN, '').trim();
  return stripped || part;
}

function isAffirmativePart(rawPart, depth = 0) {
  const part = depth === 0 ? stripVocativeTail(rawPart) : rawPart;
  if (AFFIRMATIVE_REPLIES.includes(part)) return true;
  if (depth >= 3) return false;
  const space = part.indexOf(' ');
  if (space < 0) return false;
  const head = part.slice(0, space);
  const rest = part.slice(space + 1).trim();
  if (!rest || !AFFIRMATIVE_LEAD_ATOMS.includes(head)) return false;
  return isAffirmativePart(rest, depth + 1);
}

// True only when every intent-carrying part of the reply is an affirmative.
export function isSimpleAffirmative(cleanedReplyText) {
  const text = normalise(cleanedReplyText);
  if (!text || CONTRADICTION_PATTERN.test(text)) return false;
  const parts = meaningfulParts(cleanedReplyText);
  if (!parts) return false;
  return parts.every((part) => isAffirmativePart(part));
}

// True only when every intent-carrying part of the reply is a deferral.
//
// "Maybe later, actually send it now" is rejected here — "actually" and "send"
// both trip the deferral contradiction guard — so a reply that opens like a
// deferral and then reverses it goes to the model, not to a naive NOT_NOW.
export function isSimpleDeferral(cleanedReplyText) {
  const text = normalise(cleanedReplyText);
  if (!text || DEFERRAL_CONTRADICTION_PATTERN.test(text)) return false;
  const parts = meaningfulParts(cleanedReplyText);
  if (!parts) return false;
  return parts.every((part) => DEFERRAL_REPLIES.includes(stripVocativeTail(part)));
}

// The decision, or null when the rule does not apply.
export function contextualAffirmativeDecision(reply, context) {
  if (!isSendDemoCta(context?.previous_novus_message)) return null;
  if (!isSimpleAffirmative(reply?.cleaned_reply_text)) return null;
  // The offer has already been fulfilled; a positive reply after it is feedback,
  // not a fresh request to send. The model handles that case.
  if (context?.demo_already_sent === true) return null;
  return routed(
    'POSITIVE_SEND_DEMO',
    'bare affirmative answering an unambiguous send-the-demo CTA in the immediately preceding NOVUS message',
    CONTEXTUAL_AFFIRMATIVE_CONFIDENCE,
    { source: 'DETERMINISTIC_CONTEXTUAL' },
  );
}

// A DEFERRAL of whatever was just proposed.
//
// Unlike the affirmative rule this does NOT require a send-demo CTA
// specifically: putting off a send and putting off a call are both NOT_NOW, and
// the routing (CREATE_NURTURE) is identical either way, so all this needs is
// that NOVUS actually asked something. A deferral cannot be turned into a send
// by mis-reading which CTA it answered, so the narrower gate buys nothing here.
//
// It sends nothing and can never reach the SEND_DEMO path — NOT_NOW routes to
// CREATE_NURTURE, and lib/reply-send-demo.mjs refuses anything that is not
// POSITIVE_SEND_DEMO.
export function contextualDeferralDecision(reply, context) {
  if (previousNovusCtaType(context?.previous_novus_message) === null) return null;
  if (!isSimpleDeferral(reply?.cleaned_reply_text)) return null;
  return routed(
    'NOT_NOW',
    'bare deferral of the proposition in the immediately preceding NOVUS message',
    CONTEXTUAL_DEFERRAL_CONFIDENCE,
    { source: 'DETERMINISTIC_CONTEXTUAL' },
  );
}

// Certain by construction, the same standing as the other deterministic
// verdicts. Comfortably above BOTH the 0.85 classification threshold and the
// stricter 0.90 execution threshold in lib/reply-send-demo.mjs — neither of
// which is changed by this work.
export const CONTEXTUAL_AFFIRMATIVE_CONFIDENCE = 0.96;

// Above the 0.85 classification threshold so the deferral is recorded as a
// real NOT_NOW rather than falling to MANUAL_REVIEW. The 0.90 execution
// threshold is irrelevant to it: NOT_NOW never reaches an execution path.
export const CONTEXTUAL_DEFERRAL_CONFIDENCE = 0.93;

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

  // RELATIONAL, and strictly after the compliance-critical rules above: an
  // opt-out or an out-of-office still wins over any affirmative reading. Fires
  // only when BOTH the parent CTA and the reply are unambiguous; otherwise
  // returns null and the model decides exactly as before.
  const contextual = contextualAffirmativeDecision(reply, context)
    || contextualDeferralDecision(reply, context);
  if (contextual) return { ...contextual, error: '' };

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
      purpose: 'reply_classification',
      ...(model ? { model } : {}),
    });
  } catch (err) {
    // Provider timeout, 5xx, malformed JSON, truncation — all land here, and
    // all leave the already-persisted raw event intact.
    return safeFallback('semantic classification failed', err?.message || 'classifier call failed');
  }

  return validateClassifierResult(raw);
}
