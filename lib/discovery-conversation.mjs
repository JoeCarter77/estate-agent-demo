// lib/discovery-conversation.mjs — CONVERSATION MODE for the discovery
// workspace (novus/meetings.html). Pure data + one pure evaluator; no I/O.
//
// WHY. The question registry (lib/discovery-questions.mjs) is what the
// diagnosis reads; asked one question at a time it feels like a
// questionnaire. This module sits ON TOP of it and changes nothing
// underneath: questions are grouped into TOPICS, and for the topic in front
// of Joe the guide says what we're trying to understand, what earlier
// answers already established, the one natural thing to ask next, what to
// listen for, and two or three optional directions still worth exploring.
// Answers are still captured through the registry's own structured options
// and notes — nothing here reads free speech, and nothing here is ever
// treated as an answer.
//
// DETERMINISTIC. Every fact, bridge and acknowledgement is a fixed sentence
// gated on a specific STORED/derived answer, using the same condition shape
// as the coverage rules ({ question, any | levels | answered | number }). No
// model call. The page mirrors conversationGuide() from the server-sent data
// (like it mirrors evaluateCoverage) — keep the two copies in sync.
//
// PRIVATE. The opening, bridges, acknowledgements and facts are Joe's
// speaking cues. None of it is part of the conclusion or presentation
// payloads (the self-test asserts it).

import { QUESTIONS, QUESTION_BY_ID, DIMENSIONS, effectiveAnswers, isVisible, wordingFor, effectiveLevel, optionOf, answerValues, _internal } from './discovery-questions.mjs';

const { conditionHolds } = _internal;
const text = (value) => String(value ?? '').trim();

// ── OPENING & FRAMING (private, before the first commercial question) ─────
export const OPENING = Object.freeze({
  greeting: "Hi {name}, how's it going? Appreciate you jumping on today.",
  framing: Object.freeze([
    "So {name}, just to give you a bit of context on how I thought we'd approach today.",
    'The main thing I want to do is understand a bit more about your business, how things are currently working, and whether there are any areas where we could potentially make a difference.',
    "If there are, I'll show you what we'd actually put in place and how we'd approach it. If not, absolutely no worries.",
  ]),
  // Only ever offered when genuine local research exists (see
  // buildAgencyContext().local_research) — never promised otherwise.
  research: "Either way, I'll run you through a couple of things I've noticed from looking at other agencies in your area.",
  close: 'Sound fair?',
});

// A contact's first name, only when the stored name plausibly is one.
export function firstNameOf(contactName) {
  const first = text(contactName).split(/\s+/)[0] || '';
  return /^[A-Za-z][A-Za-z'-]{1,30}$/.test(first) ? first : '';
}

const withName = (sentence, name) => (name ? sentence.replace('{name}', name) : sentence.replace(/ \{name\}/, '').replace('{name}', ''));

// -> { first_name, greeting, framing: [paragraph…], research: bool }
export function openingScript({ contact_name = '', local_research = null } = {}) {
  const name = firstNameOf(contact_name);
  const hasResearch = Boolean(local_research && Number(local_research.agencies) > 0);
  return {
    first_name: name,
    greeting: withName(OPENING.greeting, name),
    framing: [...OPENING.framing.map((p) => withName(p, name)), ...(hasResearch ? [OPENING.research] : []), OPENING.close],
    research: hasResearch,
  };
}

// ── TOPICS: the unit of conversation ──────────────────────────────────────
// Order IS the meeting order: objective → bottleneck → agency context →
// foundations → intelligence → numbers → future pacing. Dimension topics take
// every registry question for that dimension, in registry order.
const DIM_TOPICS = {
  F1: { label: 'Recording what customers tell you', understand: 'Whether what customers say about selling — their situation, their timeframe — actually gets recorded.',
    listen_for: ['Whether the selling situation and timeframe get captured', 'Whether it depends on who takes the call'] },
  F2: { label: "Picking up a customer's history", understand: "Whether someone else on the team can quickly understand a returning customer's situation.",
    listen_for: ['Whether the history is there at all', 'Whether someone else could pick it up quickly'] },
  F3: { label: 'Future sellers: what happens next', understand: "Whether someone who isn't ready to sell yet gets a definite next step.",
    listen_for: ['Whether a follow-up gets set', 'Whether that holds for the longer-term ones too'] },
  F4: { label: 'Making sure follow-ups happen', understand: 'Whether a missed follow-up would be noticed and picked up by anyone.',
    listen_for: ['Who owns the follow-up', "Whether anyone can see what's overdue"] },
  F5: { label: 'What opportunities turn into', understand: 'Whether they can see which opportunities became valuations and instructions.',
    listen_for: ['Whether source → valuation → instruction is visible', 'Whether it is measured or just felt'] },
  I1: { label: 'Sellers in new enquiries', understand: 'Whether a seller mentioned in a buyer enquiry is recognised and picked up.',
    listen_for: ['Whether anything flags it, or it relies on someone noticing', 'Roughly how many enquiries carry a seller'] },
  I2: { label: 'Past customers coming back', understand: 'Whether renewed activity from a past customer is recognised as a selling opportunity — not whether their history exists.',
    listen_for: ["Whether anything brings them back to someone's attention", 'Whether the same person is matched across records'] },
  I3: { label: 'The existing database', understand: 'Whether the database they already own is being used to find valuations.',
    listen_for: ['How, and how often, it gets worked', 'Whether the history is in the CRM and usable'] },
  I4: { label: "Who's worth calling", understand: 'How the team decide who to focus on when there are more contacts than time.',
    listen_for: ['Whether priority is based on situation and activity', 'Whether they would know an old contact is active again'] },
  I5: { label: 'Learning from results', understand: 'Whether what actually converts changes what the team focus on.',
    listen_for: ['Whether results are measured', 'Whether it changes what the team do'] },
};

export const TOPICS = Object.freeze([
  { id: 'objective', section: 'commercial', label: 'Commercial objective', questions: ['C1'],
    understand: 'What they are actually trying to achieve commercially — everything later is judged against it.',
    listen_for: ['The one outcome that matters most to them', "Whether it's valuations, instructions, buyer demand or the team's time"] },
  { id: 'bottleneck', section: 'commercial', label: "What's holding it back", questions: ['C1b_instructions', 'C1b_demand', 'C1b_capacity', 'C2'],
    understand: 'What is preventing that objective — the bottleneck the rest of discovery investigates.',
    listen_for: ['Where it breaks: getting opportunities, or converting them', 'Anything they volunteer about the database, follow-up or the team — record it against that topic'] },
  { id: 'strategy', section: 'commercial', label: "How they'd do it today",
    questions: ['C12', 'C12_selection', 'C12_consistency', 'C12_existing', 'C12_output', 'C12_change', 'C12_exhausted', 'C12_results', 'C12_belief'],
    understand: "How they would currently generate the extra result with what they already have — their strategy, not an admission of a problem.",
    listen_for: ['The approach, and the systems or people behind it', 'How they pick who to go after, and how consistently it happens', 'Whether they would know what it produced — and whether they think it would be enough'] },
  { id: 'context', section: 'commercial', label: 'The agency', questions: ['C3', 'C6', 'C7', 'C7_block', 'C4', 'C5'],
    understand: 'The scale and systems we would be working with — only what is not already known.',
    listen_for: ['Branches and CRM', 'Monthly enquiry volume', 'How big the database is, and whether we could get at it'] },
  ...DIMENSIONS.map((d) => ({ id: d.id, section: d.section, dimension: d.id, ...DIM_TOPICS[d.id],
    questions: QUESTIONS.filter((q) => q.dimension === d.id).map((q) => q.id) })),
  { id: 'numbers', section: 'value', label: 'The commercial numbers', questions: ['C8', 'C9', 'C10', 'C11'],
    understand: 'The baseline that puts a commercial value on what has been discussed.',
    listen_for: ['Valuations a month', 'Instructions a month', 'Average fee'] },
  { id: 'future', section: 'future', label: 'Future pacing', questions: ['C1a'],
    understand: 'What a really good six months would look like to them, in their own words.',
    listen_for: ['What would have changed for them', 'A number — only if they give one'] },
].map((t) => Object.freeze({ ...t, questions: Object.freeze([...t.questions]), listen_for: Object.freeze([...t.listen_for]) })));
export const TOPIC_BY_ID = Object.freeze(Object.fromEntries(TOPICS.map((t) => [t.id, t])));

export function topicOf(questionId) {
  return TOPICS.find((t) => t.questions.includes(questionId))?.id || '';
}

// ── WHAT WE ALREADY KNOW ──────────────────────────────────────────────────
// A fact is shown on each listed topic once its condition holds. `{Cn}` is
// filled from that answer (a number, or the chosen option's label); a fact
// whose token cannot be filled is not shown. Wording states what the owner
// said — it never upgrades it into a finding.
const fact = (topics, when, sentence) => Object.freeze({ topics: Object.freeze(topics), when, text: sentence });
export const TOPIC_FACTS = Object.freeze([
  fact(['I1', 'I2', 'I3', 'I4'], { question: 'C1b_instructions', any: ['valuation_volume'] }, 'The bottleneck is getting valuations through the door, not winning them.'),
  fact(['F3', 'F4', 'F5'], { question: 'C1b_instructions', any: ['winning_instructions'] }, "They get the valuations — it's winning the instruction that's hard."),
  fact(['I3', 'I4'], { question: 'C2', any: ['database'] }, "Said they can't get much out of the database."),
  fact(['F3', 'F4'], { question: 'C2', any: ['slipping_through'] }, 'Mentioned things slipping through the net.'),
  fact(['I1', 'I3'], { question: 'C2', any: ['not_enough_opportunities'] }, 'Not enough valuation opportunities coming through.'),
  fact(['I3', 'I4'], { question: 'C2', any: ['team_time'] }, "The team's time is stretched."),
  fact(['I1', 'I2', 'I3', 'I4', 'F3', 'F5'], { question: 'C12', answered: true }, "How they'd do it today: {C12}."),
  fact(['I2', 'I3', 'I4'], { question: 'C12_existing', any: ['finds_and_routes'] }, 'Their system already finds likely sellers and passes them to someone.'),
  fact(['I2', 'I3', 'F3', 'F4'], { question: 'C12_existing', any: ['finds_not_actioned'] }, 'Their system finds likely sellers, but nothing structured happens next.'),
  fact(['I3', 'I4', 'numbers'], { question: 'C12_output', number: true }, 'That activity produces about {C12_output} valuations a month.'),
  fact(['I3'], { question: 'C12_exhausted', any: ['not_established'] }, "Not established whether the existing customers have really been worked."),
  fact(['F5', 'I5'], { question: 'C12_results', any: ['not_measured'] }, "Said they wouldn't really know what their approach produced."),
  fact(['F5', 'I5'], { question: 'C12_change', any: ['measure'] }, "Would like to know what their system is actually producing."),
  fact(['I1'], { question: 'C4', number: true }, 'Around {C4} enquiries a month.'),
  fact(['I3', 'I4'], { question: 'C5', number: true }, 'About {C5} contacts in the database.'),
  fact(['F1', 'F3', 'I2', 'I3'], { question: 'C6', answered: true }, 'On {C6}.'),
  fact(['F2', 'I1', 'I2'], { question: 'F1', levels: ['weak', 'partial'] }, "The selling situation isn't always recorded consistently."),
  fact(['I1'], { question: 'F1', levels: ['strong'] }, 'The selling situation gets recorded consistently.'),
  fact(['I2', 'I3'], { question: 'F2', any: ['sometimes'] }, 'Customer history is inconsistently recorded. Relevant information can be accessed when present.'),
  fact(['I2', 'I3'], { question: 'F2', any: ['no'] }, "A returning customer's history usually starts from scratch."),
  fact(['I2'], { question: 'F2', any: ['with_digging'] }, 'The history is there, but it takes some digging.'),
  fact(['I2'], { question: 'F2', levels: ['strong'] }, "Anyone can pick up a returning customer's history."),
  fact(['F4', 'F5'], { question: 'F3', any: ['task_every_time'] }, 'A follow-up gets set every time.'),
  fact(['F4'], { question: 'F3', any: ['memory'] }, 'Follow-ups depend on the negotiator remembering.'),
  fact(['F4'], { question: 'F3', any: ['sometimes_task'] }, 'Sometimes a follow-up gets set, sometimes not.'),
  fact(['F5', 'I4'], { question: 'F4', levels: ['strong'] }, 'Overdue follow-ups get picked up by a manager.'),
  fact(['I2', 'I3'], { question: 'I1', levels: ['strong'] }, 'The team are good at spotting sellers in fresh enquiries.'),
  fact(['I4'], { question: 'I3', any: ['when_time'] }, 'The database gets worked when negotiators have time.'),
  fact(['I4'], { question: 'I3', any: ['campaigns'] }, 'The database gets occasional campaigns.'),
  fact(['I4'], { question: 'I2', levels: ['weak'] }, "Nothing brings a returning past customer back to anyone's attention."),
  fact(['I5'], { question: 'F5', any: ['none'] }, "Outcomes aren't tracked back to where they came from."),
  fact(['I5'], { question: 'F5', any: ['partial', 'spreadsheet'] }, 'Valuations and instructions are tracked, but not where they came from.'),
  fact(['future'], { question: 'C8', number: true }, 'Currently about {C8} valuations a month.'),
  fact(['future'], { question: 'C9', number: true }, 'And about {C9} instructions a month.'),
]);

// ── SUGGESTED TRANSITIONS into a topic ────────────────────────────────────
// Shown above the topic's first question while nothing has been asked in it,
// connecting it to something the owner already said. First match wins.
export const TOPIC_BRIDGES = Object.freeze([
  { topic: 'I2', when: { question: 'F2', any: ['sometimes', 'no', 'with_digging'] }, text: "You mentioned earlier that customer history isn't always picked up consistently. I'm interested in what happens when one of those customers comes back into the market…" },
  { topic: 'I3', when: { question: 'I3', answered: true }, text: 'You mentioned earlier how the database gets worked — I\'d like to come back to that for a minute.' },
  { topic: 'I3', when: { question: 'C12', any: ['negotiators_database', 'call_old_valuations'] }, text: "You said the way you'd go about it is calling through the database and past valuations — I'd like to come back to that for a minute." },
  { topic: 'I3', when: { question: 'C12', any: ['crm_identifies'] }, text: 'You mentioned your system already picks out likely sellers — I\'d like to understand what that covers.' },
  { topic: 'I3', when: { question: 'C2', any: ['database'] }, text: "You said earlier you can't get much out of the database — I'd like to come back to that for a minute." },
  { topic: 'I1', when: { question: 'F1', levels: ['strong'] }, text: "You said the selling situation does get recorded — what I'm interested in now is what happens with it." },
  { topic: 'F4', when: { question: 'C2', any: ['slipping_through'] }, text: 'You mentioned things slipping through the net earlier…' },
].map((b) => Object.freeze(b)));

// ── SHORT SPOKEN ACKNOWLEDGEMENTS (optional, not questions) ───────────────
// Shown once the topic has an answer. First match for the topic wins.
export const ACKNOWLEDGEMENTS = Object.freeze([
  // Strategy: never manufacture a weakness in something they say works.
  { topic: 'strategy', when: [{ question: 'C12_change', any: ['nothing_needed'] }, { question: 'C12_belief', any: ['yes'] }], text: 'Sounds like that\'s genuinely working for you.' },
  { topic: 'strategy', when: { question: 'C12_existing', any: ['finds_and_routes'] }, text: "Right — so that side is already covered. What I'm really interested in is what it's producing." },
  { topic: 'strategy', when: { question: 'C12_consistency', any: ['consistently'] }, text: "Okay, so that's already a regular part of how you work." },
  { topic: 'F1', when: { question: 'F1', levels: ['weak'] }, text: "So a fair bit of what customers tell you doesn't make it into the system." },
  { topic: 'F2', when: { question: 'F2', any: ['with_digging', 'sometimes'] }, text: "Right, so the information is there, but it's not always getting used." },
  { topic: 'F3', when: { question: 'F3', levels: ['strong'] }, text: "Okay, so your follow-up process sounds like something you've already got working." },
  { topic: 'F4', when: { question: 'F4', levels: ['strong'] }, text: "Good — so the follow-ups get set and someone's keeping an eye on them." },
  { topic: 'F5', when: { question: 'F5', any: ['none'] }, text: 'So you see the instructions land, but not really where they came from.' },
  { topic: 'I1', when: { question: 'I1', levels: ['strong'] }, text: 'Right, so the new enquiries are well covered.' },
  { topic: 'I2', when: [{ question: 'I1', levels: ['strong'] }, { question: 'I2', levels: ['weak', 'partial'] }], text: "Interesting. That's slightly different from the fresh enquiries we were talking about." },
  { topic: 'I3', when: { question: 'I3', any: ['when_time', 'not_used'] }, text: "So there's a lot sitting in there that isn't really being worked." },
].map((x) => Object.freeze(x)));

// ── OTHER DIRECTIONS: short cues for the questions still open ─────────────
export const ROLE_CUES = Object.freeze({
  verify: 'Whether that holds up in practice', cause: "What's behind it", consequence: 'Whether it has cost them business',
  frequency: 'Whether it happens often', tried: "Whether they've tried doing anything differently", example: 'A recent example, in their words',
});
export const QUESTION_CUES = Object.freeze({
  C1b_instructions: 'Valuations through the door, or winning them', C1b_demand: 'Particular properties, or across the business',
  C1b_capacity: "Where the team's time goes", C2: "What's getting in the way",
  C12: "How they'd get more today", C12_selection: 'How they would pick who to speak to first', C12_consistency: 'Whether it happens consistently',
  C12_existing: 'What their system finds, and what happens next', C12_output: 'What it produces', C12_change: 'What they would change',
  C12_exhausted: 'Whether the existing customers are exhausted', C12_results: 'Whether they would know what it produced', C12_belief: 'Whether they think it would be enough',
  C3: 'Number of branches', C6: 'Which CRM', C7: 'Whether we could get at the CRM data', C7_block: 'What the block actually is',
  C4: 'Monthly enquiry volume', C5: 'Database size', C8: 'Valuations a month', C9: 'Instructions a month', C10: 'Average fee',
  C11: 'Valuation-to-instruction conversion', C1a: 'What a good six months looks like',
  F1_crm_limit: 'What the CRM gets in the way of', F1_process: 'Whether a process exists and is ignored',
  F4_frequency: 'Whether missed follow-ups happen regularly', F4_tried: 'Whether they have tried improving the process',
  F4_consequence: 'Whether it has cost them opportunities',
  I1_volume: 'How many enquiries carry a seller', I1_current: 'Whether the CRM or portal does anything with it',
  I2_matching: 'Whether one person means one record', I3_history: 'How far back the usable history goes',
  I3_quality: 'How clean the data is', I4_signals: 'Whether they see when an old contact is active again',
});
export function cueFor(question) {
  return QUESTION_CUES[question.id] || ROLE_CUES[question.role] || question.purpose;
}

// ── the guide ─────────────────────────────────────────────────────────────
const MAX_DIRECTIONS = 3;
const MAX_FACTS = 4;

function hasValue(a) { return Boolean(a) && !a.skipped && (Array.isArray(a.values) ? a.values.length > 0 : (a.value !== undefined && a.value !== '' && a.value !== null)); }
function holdsAll(when, answers) { return (Array.isArray(when) ? when : [when]).every((c) => conditionHolds(c, answers)); }

function tokenValue(id, answers) {
  const q = QUESTION_BY_ID[id]; const a = answers[id];
  if (!q || !hasValue(a)) return null;
  if (q.type === 'number') { const n = Number(a.value); return Number.isFinite(n) ? n.toLocaleString('en-GB') : null; }
  const v = answerValues(a).filter((x) => x !== 'unknown');
  if (!v.length) return null;
  if (v[0] === 'other') return text(a.note) || null;
  return v.map((x) => optionOf(q, x)?.label || x).join(', ');
}
export function fillTokens(sentence, answers) {
  let missing = false;
  const out = sentence.replace(/\{([A-Za-z0-9_]+)\}/g, (_, id) => { const v = tokenValue(id, answers); if (v === null) missing = true; return v ?? ''; });
  return missing ? null : out;
}

// The answer, read back as a short "what we've established" line.
export function answerSummary(question, answer) {
  if (!answer) return '';
  if (answer.skipped) return `Skipped — ${text(answer.skip_reason) || 'no reason'}`;
  if (question.type === 'number') {
    if (!hasValue(answer)) return '';
    const n = Number(answer.value).toLocaleString('en-GB');
    const unit = question.unit === 'branches' && Number(answer.value) === 1 ? 'branch' : question.unit;
    return question.unit === '£' ? `£${n}` : `${n}${unit ? ` ${unit}` : ''}`;
  }
  if (question.type === 'text') return [text(answer.value), answer.target !== undefined && answer.target !== null ? `(target ${answer.target})` : ''].filter(Boolean).join(' ');
  return answerValues(answer).map((v) => (v === 'other' && text(answer.note) ? text(answer.note) : optionOf(question, v)?.label || v)).join('; ');
}

function explorationComplete(dim, answers) {
  const need = QUESTIONS.filter((q) => q.dimension === dim && (q.role === 'cause' || q.role === 'consequence'));
  return need.every((q) => answerValues(answers[q.id]).some((v) => v !== 'unknown'));
}

// -> the conversation guide for one topic, from the STORED answers.
//   status      not_started | in_progress | enough | done
//   next        { id, wording, variant } — the one question to ask now, or null
//   directions  [{ id, cue, optional }] — up to three other open questions
//   established [{ id, summary, volunteered_in }] — answered in this topic
//   covered     [{ id, note, basis }] — already covered by an earlier answer
//   known       [sentence] — relevant things established in OTHER topics
//   bridge      sentence | '' — a transition into the topic, before it starts
//   acknowledgement sentence | '' — an optional spoken cue once it has started
export function conversationGuide(topicId, stored = {}) {
  const topic = TOPIC_BY_ID[topicId];
  if (!topic) return null;
  const eff = effectiveAnswers(stored);
  const answers = eff.answers;
  const inTopic = topic.questions.map((id) => QUESTION_BY_ID[id]).filter(Boolean);
  const visible = inTopic.filter((q) => isVisible(q, stored, eff));
  const done = (q) => hasValue(stored[q.id]) || Boolean(stored[q.id]?.skipped);
  const complete = topic.dimension ? explorationComplete(topic.dimension, answers) : false;
  const optionalNow = (q) => Boolean(q.optional) && Boolean(q.dimension) && complete;
  const pending = visible.filter((q) => !done(q) && !optionalNow(q));
  const optional = visible.filter((q) => !done(q) && optionalNow(q));

  const established = visible.filter((q) => done(q)).map((q) => ({ id: q.id, summary: answerSummary(q, stored[q.id]), volunteered_in: text(stored[q.id]?.volunteered_in), prefilled: Boolean(stored[q.id]?.prefilled) }));
  // "Started" means asked IN this topic: something the owner volunteered
  // while talking about another topic does not count, so the bridge that
  // picks it back up still shows.
  const started = established.some((e) => !e.volunteered_in);

  let status = 'not_started';
  if (established.length) {
    if (!pending.length) status = optional.length ? 'enough' : 'done';
    else if (topic.dimension) {
      const level = effectiveLevel(topic.dimension, answers);
      const verify = QUESTION_BY_ID[`${topic.dimension}_verify`];
      const primaryDone = done(QUESTION_BY_ID[topic.dimension]) || Boolean(eff.coverage[topic.dimension]);
      const enough = primaryDone && ((level === 'strong' && (!verify || done(verify))) || (['weak', 'partial'].includes(level) && complete) || level === 'unknown');
      status = enough ? 'enough' : 'in_progress';
    } else status = 'in_progress';
  }

  const next = pending[0] ? { id: pending[0].id, ...wordingFor(pending[0], answers) } : null;
  // Required pieces first; frequency / what they tried / an example are
  // always marked optional — never a sequence Joe has to work through.
  const rest = [...pending.slice(1), ...optional];
  const directions = [...rest.filter((q) => !q.optional), ...rest.filter((q) => q.optional)]
    .map((q) => ({ id: q.id, cue: cueFor(q), optional: Boolean(q.optional) })).slice(0, MAX_DIRECTIONS);
  const covered = inTopic.filter((q) => eff.coverage[q.id]).map((q) => ({ id: q.id, note: eff.coverage[q.id].note, basis: eff.coverage[q.id].basis }));

  const known = [];
  for (const f of TOPIC_FACTS) {
    if (known.length >= MAX_FACTS) break;
    if (!f.topics.includes(topic.id) || !holdsAll(f.when, answers)) continue;
    const sentence = fillTokens(f.text, answers);
    if (sentence && !known.includes(sentence)) known.push(sentence);
  }
  const bridge = started ? '' : (TOPIC_BRIDGES.find((b) => b.topic === topic.id && holdsAll(b.when, answers))?.text || '');
  const acknowledgement = established.length ? (ACKNOWLEDGEMENTS.find((x) => x.topic === topic.id && holdsAll(x.when, answers))?.text || '') : '';

  return {
    topic: topic.id, label: topic.label, section: topic.section, understand: topic.understand, listen_for: [...topic.listen_for],
    status, next, directions, established, covered, known, bridge, acknowledgement,
    has_questions: visible.length > 0,
  };
}

// The topics a stage covers, in meeting order.
export function topicsForSections(sections) {
  return TOPICS.filter((t) => sections.includes(t.section)).map((t) => t.id);
}

// Everything the page needs to mirror the guide.
export function conversationPayload() {
  return { topics: TOPICS, facts: TOPIC_FACTS, bridges: TOPIC_BRIDGES, acknowledgements: ACKNOWLEDGEMENTS, role_cues: ROLE_CUES, question_cues: QUESTION_CUES, opening: OPENING };
}
