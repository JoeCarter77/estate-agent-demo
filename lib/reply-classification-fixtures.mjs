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
