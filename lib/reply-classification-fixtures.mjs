// lib/reply-classification-fixtures.mjs — the ONE phrase test set for reply
// classification, shared by the offline selftest and the live diagnostic
// operation so they can never drift apart.
//
// PHRASES go through the model (or the injected fake in tests) via
// classifyReply(). DETERMINISTIC_PHRASES never reach the model at all — they
// exist here only so both callers can assert that.

export const PHRASES = [
  ['Yes send', 'POSITIVE_SEND_DEMO'],
  ['Yeah, send it over please', 'POSITIVE_SEND_DEMO'],
  ['yeah go on', 'POSITIVE_SEND_DEMO'],
  ['happy to have a look', 'POSITIVE_SEND_DEMO'],
  ['sure', 'POSITIVE_SEND_DEMO'],
  ['why not', 'POSITIVE_SEND_DEMO'],
  ["send me whatever you've got", 'POSITIVE_SEND_DEMO'],
  ['okay send across', 'POSITIVE_SEND_DEMO'],
  ['yes please', 'POSITIVE_SEND_DEMO'],
  ['go for it', 'POSITIVE_SEND_DEMO'],
  ['sounds good', 'POSITIVE_SEND_DEMO'],

  ['Can we have a call tomorrow?', 'POSITIVE_MEETING'],
  ['Give me a call', 'POSITIVE_MEETING'],
  ["Let's have a chat", 'POSITIVE_MEETING'],
  ['What availability do you have?', 'POSITIVE_MEETING'],
  ['Looks interesting, can you call me tomorrow?', 'POSITIVE_MEETING'],

  ['How much does it cost?', 'QUESTION'],
  ['How does this work?', 'QUESTION'],
  ['What exactly did you test?', 'QUESTION'],
  ['Where did you get my details?', 'QUESTION'],
  ['Yes send it over, how much is it?', 'QUESTION'],
  ['Maybe, what exactly is this?', 'QUESTION'],

  ['Not interested thanks', 'NOT_INTERESTED'],
  ['Not for us', 'NOT_INTERESTED'],
  ['not for us thanks', 'NOT_INTERESTED'],
  ["We're happy with what we have", 'NOT_INTERESTED'],

  ['Maybe come back to me in October', 'NOT_NOW'],
  ['Not at the minute', 'NOT_NOW'],
  ['Give me a shout in a few months', 'NOT_NOW'],
  ["We're too busy at the moment", 'NOT_NOW'],
  ["we've got too much going on at the moment", 'NOT_NOW'],
  ['Try me after Christmas', 'NOT_NOW'],

  ['Okay', 'OTHER_UNCLEAR'],
  ['Thanks', 'OTHER_UNCLEAR'],
];

export const DETERMINISTIC_PHRASES = [
  ['Please remove me from your list', 'OPT_OUT'],
  ['unsubscribe', 'OPT_OUT'],
];

// CONTEXTUAL CASES — the same reply text meaning different things depending on
// the immediately previous NOVUS message.
//
// `context` is exactly the shape lib/reply-thread-context.mjs produces and
// classifyReply() consumes. A null context means "no previous NOVUS message
// could be retrieved", which must make the classifier MORE conservative, not
// less: a bare acceptance with nothing to anchor it is OTHER_UNCLEAR, because
// POSITIVE_SEND_DEMO and POSITIVE_MEETING are two different next actions and
// guessing between them is exactly what we do not want.
export const CONTEXTUAL_PHRASES = [
  {
    label: 'demo offer + bare acceptance',
    phrase: 'yeah okay',
    context: { previous_novus_message: 'Want me to send the demo?', demo_already_sent: false },
    expected: 'POSITIVE_SEND_DEMO',
  },
  {
    label: 'call offer + bare acceptance',
    phrase: 'yeah okay',
    context: { previous_novus_message: 'Would you be open to a quick call tomorrow?', demo_already_sent: false },
    expected: 'POSITIVE_MEETING',
  },
  {
    label: 'no context + bare acceptance',
    phrase: 'yeah okay',
    context: null,
    expected: 'OTHER_UNCLEAR',
  },
  {
    label: 'proposed times + time acceptance',
    phrase: 'tomorrow works',
    context: { previous_novus_message: 'Could do 11am or 2pm tomorrow.', demo_already_sent: false },
    expected: 'POSITIVE_MEETING',
  },
  {
    label: 'no context + time acceptance',
    phrase: 'tomorrow works',
    context: null,
    expected: 'OTHER_UNCLEAR',
  },
  {
    label: 'demo offer + "sounds good"',
    phrase: 'sounds good',
    context: { previous_novus_message: 'Want me to send over the breakdown of how the enquiry was handled?', demo_already_sent: false },
    expected: 'POSITIVE_SEND_DEMO',
  },
  {
    label: 'call offer + "sounds good"',
    phrase: 'sounds good',
    context: { previous_novus_message: 'Shall we jump on a quick call this week?', demo_already_sent: false },
    expected: 'POSITIVE_MEETING',
  },
  {
    label: 'demo already sent + positive feedback asking to talk',
    phrase: "looks good, let's chat",
    context: {
      previous_novus_message: "Here's the breakdown of how your team handled the enquiry — link inside.",
      demo_already_sent: true,
    },
    expected: 'POSITIVE_MEETING',
  },
  {
    label: 'immediate previous message outranks an older unrelated one',
    phrase: 'yeah go on',
    context: {
      previous_novus_message: 'Happy to jump on a call if easier — does Thursday work?',
      previous_prospect_message: 'Saw your email about the enquiry test, interesting.',
      demo_already_sent: false,
    },
    expected: 'POSITIVE_MEETING',
  },
];

// ---------------------------------------------------------------------------
// THE REAL SEND-DEMO CTA, verbatim from the production campaign. Every case in
// SEND_DEMO_CTA_CASES below is answered against THIS message, so the fixtures
// test the actual parent NOVUS sends rather than a shortened paraphrase.
//
// Note what it contains: "asked for my availability for a viewing" — narrative
// about the enquiry, sitting well before the ask. A competing-CTA check that
// scanned the whole body would refuse to recognise this as a send CTA. Only the
// final question is the ask.
export const REAL_SEND_DEMO_CTA = [
  'Hi Adam,',
  '',
  'I sent your team an enquiry about Milton Road on 11 August at 22:19.',
  '',
  "Although your team asked for my availability for a viewing, the property I'd said I had to sell was recognised but not progressed towards a valuation offer.",
  '',
  'That meant that a recognised seller opportunity was left without a valuation offer or next step.',
  '',
  'I pulled together a short breakdown of what happened and where the opportunity was missed.',
  '',
  'Want me to send it over?',
  '',
  'Joe',
].join('\n');

// THE REAL REGRESSION. This exact reply, against the CTA above, was classified
// POSITIVE_SEND_DEMO at 0.55 by the model, fell below the 0.85 threshold, and
// went to MANUAL_REVIEW instead of sending. It is unambiguous English and must
// be treated as such.
export const REAL_REGRESSION_REPLY = 'Hi Joe,\n\nSure thing.\n\nAdam';

// Replies answered against REAL_SEND_DEMO_CTA.
//   auto: true  -> must reach POSITIVE_SEND_DEMO at >= 0.90 (auto-send eligible)
//   auto: false -> must NOT be POSITIVE_SEND_DEMO, whatever else it is
// THE THREE REAL END-TO-END REGRESSIONS, verbatim. Each ran through Instantly
// and REPLY_EVENTS and produced the wrong result:
//   A  "Yeah okay, sure. Thanks, Joe"  -> OTHER_UNCLEAR @ 0.30, MANUAL_REVIEW
//   B  "Maybe later"                   -> NOT_NOW @ 0.75, below threshold
//   C  "...Please remove us off..."    -> NOT_INTERESTED, suppression NONE
export const REAL_CASE_A_REPLY = 'Yeah okay, sure.\n\nThanks,\nJoe';
export const REAL_CASE_B_REPLY = 'Maybe later';
export const REAL_CASE_C_REPLY = 'So you sent our team a fake enquiry? Please remove us off your email list.';

// Explicit removal requests. Every one must reach OPT_OUT with PERMANENT
// suppression, and must beat NOT_INTERESTED / complaint sentiment.
export const OPT_OUT_CASES = [
  'Please remove us off your email list.',
  'Not interested, take us off your mailing list.',
  'This is ridiculous. Stop emailing me.',
  "Don't email us again.",
  'Please remove me from your email list',
  'take me off your list',
  'remove our details',
  'unsubscribe me',
  'no more emails please',
];

// Negative or deferring, but NOT a removal request. These must never become
// OPT_OUT — suppression is permanent and must not be applied to someone who
// merely said no to this offer.
export const NOT_OPT_OUT_CASES = [
  ['No thanks.', 'NOT_INTERESTED'],
  ['Maybe later.', 'NOT_NOW'],
];

export const SEND_DEMO_CTA_CASES = [
  { phrase: 'Sure thing', auto: true },
  { phrase: REAL_REGRESSION_REPLY, auto: true, label: 'the real Adam regression' },
  { phrase: 'Yep', auto: true },
  { phrase: 'Please do', auto: true },
  { phrase: 'Go ahead', auto: true },
  { phrase: 'Go on then', auto: true },
  { phrase: 'Sounds good', auto: true },
  { phrase: 'Send it over', auto: true },
  { phrase: 'yes please', auto: true },
  { phrase: REAL_CASE_A_REPLY, auto: true, label: 'REAL CASE A — "Yeah okay, sure. Thanks, Joe"' },
  { phrase: 'Yeah sure', auto: true },
  { phrase: 'Yeah sure, thanks Joe', auto: true },
  { phrase: 'Yep sure', auto: true },
  { phrase: 'Okay yeah', auto: true },
  { phrase: 'Alright', auto: true },
  { phrase: "That's fine", auto: true },
  { phrase: 'Sounds good to me', auto: true },
  { phrase: 'yeah send it through', auto: true },
  // REAL, both live regressions against a resolved SEND_DEMO parent:
  //   "Yes"            -> model proposed POSITIVE_SEND_DEMO @ 0.60, MANUAL_REVIEW
  //   "Yes sure thing" -> POSITIVE_SEND_DEMO @ 0.85, weaker than it should be
  // "Yes sure thing" is a STACK of affirmatives and missed the exact-match list.
  { phrase: 'Yes', auto: true, label: 'REAL — bare "Yes"' },
  { phrase: 'Yes sure thing', auto: true, label: 'REAL — stacked "Yes sure thing"' },
  { phrase: 'Yeah okay sure', auto: true },
  { phrase: 'Yep sure thing', auto: true },
  { phrase: 'Okay', auto: true },
  { phrase: 'Yeah', auto: true },
  { phrase: 'Sure', auto: true },
  // A stack must still not survive a competing instruction.
  { phrase: 'Yes sure thing, but give me a call first', auto: false },

  // Contradiction or redirection: never automatic, whatever the parent asked.
  { phrase: 'Sure thing, but call me first', auto: false },
  { phrase: "Sure thing, although actually don't send anything yet — give me a call tomorrow.", auto: false },
  { phrase: "Sure thing, but I'm not interested anymore", auto: false },
  { phrase: 'No thanks', auto: false },
  { phrase: 'Maybe later', auto: false },
  { phrase: 'Yes send it over, how much is it?', auto: false },
  { phrase: 'Yeah okay, actually don’t send it', auto: false },
  { phrase: 'Yep, maybe later', auto: false },
  { phrase: "Okay, but I'm not interested", auto: false },
];

// Deferrals answered against a known CTA. Each must reach NOT_NOW at or above
// the classification threshold — the real "Maybe later" scored 0.75 and fell
// through to MANUAL_REVIEW.
export const DEFERRAL_CTA_CASES = [
  { phrase: REAL_CASE_B_REPLY, defer: true, label: 'REAL CASE B — "Maybe later"' },
  { phrase: 'Not right now', defer: true },
  { phrase: 'Perhaps another time', defer: true },
  { phrase: 'Not at the moment', defer: true },
  { phrase: 'Maybe next week', defer: true },
  { phrase: 'Come back to me later', defer: true },
  // Opens as a deferral and then reverses it: the model must handle this, not
  // a naive prefix match.
  { phrase: 'Maybe later, actually send it now', defer: false },
];

// The SAME affirmatives against parents that ask something else entirely. None
// may become POSITIVE_SEND_DEMO — this is what stops the rule degenerating into
// a global phrase list.
export const CROSS_CONTEXT_CASES = [
  { label: 'call CTA', parent: 'Can I give you a call tomorrow?', phrases: ['Sure thing', 'Yep'] },
  { label: 'meeting CTA', parent: 'Would Tuesday at 2 work?', phrases: ['Sure thing'] },
  { label: 'identity check', parent: 'Are you the right person to speak to?', phrases: ['Yep'] },
  { label: 'send AND call offered together', parent: 'Want me to send it over, or would a quick call be easier?', phrases: ['Sure thing'] },
  { label: 'no context at all', parent: '', phrases: ['Sure thing', 'Yep'] },
];
