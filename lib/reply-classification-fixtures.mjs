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
