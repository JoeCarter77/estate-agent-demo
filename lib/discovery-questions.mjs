// lib/discovery-questions.mjs — the VERSIONED question registry behind the
// meeting discovery workspace (novus/meetings.html). Pure data + two pure
// helpers; no I/O.
//
// WHY A REGISTRY AND NOT MARKUP. Every question here is what Joe says out
// loud to an estate-agency owner, and every option is what the owner's
// answer is recorded as. The diagnosis engine (lib/discovery-engine.mjs)
// reads the SAME objects, so an option's `level` / `role` is the only bridge
// between "what was said" and "what it means" — nothing in the UI or the
// engine hard-codes question text.
//
// VERSIONING. QUESTIONS_VERSION is stamped on every DISCOVERY_SESSIONS row.
// Rules: never change the meaning of an existing option value; add new ids
// for new questions; bump the version when anything a stored answer could
// depend on changes. A completed session also freezes a small snapshot of
// the labels it used (lib/discovery-store.mjs), so an old meeting stays
// readable after the registry moves on.
//
// CONVERSATION, NOT INTERROGATION. Three mechanisms keep the flow natural:
//   variants   — contextual wording: a question can carry `variants`, each
//                with a `when` condition; the first that matches replaces
//                the primary wording so a follow-up builds on what the owner
//                just said instead of restarting ("You said it's down to the
//                negotiator remembering — if one gets forgotten…").
//   hide_when  — an option that an earlier answer has already made redundant
//                (e.g. "not much gets recorded" once capture is known weak)
//                is not offered again.
//   COVERAGE   — data-driven rules (bottom of this file) that recognise when
//                an earlier answer already establishes what a question was
//                designed to collect. The question is suppressed, the
//                derived answer is a MAPPING of the owner's real answer (never
//                invented), the basis is recorded, and the operator can ask
//                it anyway. See evaluateCoverage().
//
// LANGUAGE. Spoken text is plain estate-agency English: valuations,
// instructions, applicants, the database, the CRM. Nothing here says
// "cross-interaction intelligence" or "data architecture".

export const QUESTIONS_VERSION = 2;

export const SECTIONS = Object.freeze([
  { id: 'commercial', label: 'Commercial situation', stage: 1, blurb: 'Understand the agency before diagnosing anything.' },
  { id: 'foundations', label: 'Operational foundations', stage: 2, blurb: 'Is the information there, connected, actioned, owned and measured?' },
  { id: 'intelligence', label: 'Commercial intelligence', stage: 3, blurb: 'Does anything find, connect, prioritise and learn from opportunities?' },
  // Asked last, once the gaps are on the table, so the numbers land as "what
  // is this worth" rather than an opening interrogation.
  { id: 'value', label: 'Commercial value', stage: 3, blurb: 'The baseline the pilot will be measured against.' },
]);

// The six-stage workspace maps stages onto sections; stage 3 carries both
// the intelligence dimensions and the commercial-value numbers.
export const STAGE_SECTIONS = Object.freeze({ commercial: ['commercial'], foundations: ['foundations'], intelligence: ['intelligence', 'value'] });

export const DIMENSIONS = Object.freeze([
  { id: 'F1', section: 'foundations', label: 'Information capture', short: 'Capture' },
  { id: 'F2', section: 'foundations', label: 'Customer context', short: 'Context' },
  { id: 'F3', section: 'foundations', label: 'Next actions', short: 'Next actions' },
  { id: 'F4', section: 'foundations', label: 'Accountability', short: 'Accountability' },
  { id: 'F5', section: 'foundations', label: 'Commercial outcomes', short: 'Outcomes' },
  { id: 'I1', section: 'intelligence', label: 'Opportunity recognition', short: 'Seller signals' },
  { id: 'I2', section: 'intelligence', label: 'Connecting information', short: 'Connections' },
  { id: 'I3', section: 'intelligence', label: 'Database intelligence', short: 'Database' },
  { id: 'I4', section: 'intelligence', label: 'Commercial prioritisation', short: 'Prioritisation' },
  { id: 'I5', section: 'intelligence', label: 'Learning from outcomes', short: 'Learning' },
]);

// Skip reasons offered on every question. Free text is also accepted.
export const SKIP_REASONS = Object.freeze([
  { value: 'not_relevant', label: 'Not relevant to this agency' },
  { value: 'ran_out_of_time', label: 'Ran out of time' },
  { value: 'owner_didnt_know', label: "Owner didn't know" },
  { value: 'already_covered', label: 'Already covered elsewhere' },
  { value: 'other', label: 'Other' },
]);

const UNKNOWN = { value: 'unknown', label: "Don't know / would need to check", level: 'unknown' };

// ── builders ──────────────────────────────────────────────────────────────
// `role` is what the engine reads a question for:
//   primary       the dimension's headline question (option.level → weak/partial/strong)
//   verify        asked when the primary answer is strong; option.verdict → confirms or downgrades
//   cause         why it is happening (multi)          required for CONFIRMED
//   consequence   what it costs (multi)                required for CONFIRMED
//   frequency     how often                            optional
//   tried         what they have tried                 optional
//   example       a real example (free text)           optional
//   detail        dimension-specific facts the rules need (I3 history, I2 matching, C7 CRM access…)
function q(def) {
  return Object.freeze({
    type: 'single', multi: false, allow_notes: true, required: false, options: [], ...def,
    options: Object.freeze((def.options || []).map((o) => Object.freeze(o))),
  });
}
const withUnknown = (options) => [...options, UNKNOWN];

// A weak/partial primary answer opens the exploration questions; a strong one
// opens the verification question.
const WEAK = { levels: ['weak', 'partial'] };
const STRONG = { levels: ['strong'] };

function exploration(dim, spec) {
  const out = [];
  out.push(q({
    id: `${dim}_verify`, dimension: dim, section: spec.section, role: 'verify', show_when: { question: dim, ...STRONG },
    purpose: `Verify the reported strength in ${dim} rather than assume it.`,
    primary: spec.verify.primary, simpler: spec.verify.simpler || '', example: spec.verify.example || '',
    options: spec.verify.options,
  }));
  out.push(q({
    id: `${dim}_cause`, dimension: dim, section: spec.section, role: 'cause', multi: true, type: 'multi', show_when: { question: dim, ...WEAK },
    purpose: 'Establish why it is happening — the intervention depends on the cause.',
    primary: spec.cause.primary, simpler: spec.cause.simpler || '', example: spec.cause.example || '',
    variants: spec.cause.variants || [],
    options: withUnknown(spec.cause.options),
  }));
  for (const extra of spec.extras || []) {
    out.push(q({ dimension: dim, section: spec.section, role: 'detail', ...extra }));
  }
  out.push(q({
    id: `${dim}_consequence`, dimension: dim, section: spec.section, role: 'consequence', multi: true, type: 'multi', show_when: { question: dim, ...WEAK },
    purpose: 'Establish the commercial or operational consequence — without one there is no finding to act on.',
    primary: spec.consequence.primary, simpler: spec.consequence.simpler || '', example: spec.consequence.example || '',
    options: withUnknown(spec.consequence.options),
  }));
  if (spec.frequency !== false) {
    out.push(q({
      id: `${dim}_frequency`, dimension: dim, section: spec.section, role: 'frequency', optional: true, show_when: { question: dim, ...WEAK },
      purpose: 'How often it happens, where known.',
      primary: spec.frequency?.primary || 'How often would you say that happens — now and again, most weeks, most days?',
      simpler: 'Is it a once-in-a-while thing or an everyday thing?', example: '',
      options: withUnknown([
        { value: 'occasionally', label: 'Now and again' }, { value: 'weekly', label: 'Most weeks' },
        { value: 'daily', label: 'Most days' }, { value: 'constantly', label: 'All the time' },
      ]),
    }));
  }
  out.push(q({
    id: `${dim}_tried`, dimension: dim, section: spec.section, role: 'tried', multi: true, type: 'multi', optional: true, show_when: { question: dim, ...WEAK },
    purpose: 'What the agency has previously tried — so we do not propose something that already failed for a reason.',
    primary: spec.tried?.primary || 'Have you tried anything to fix that before?',
    simpler: 'Has anyone had a go at sorting it — training, a new process, a CRM change?', example: '',
    options: withUnknown(spec.tried?.options || [
      { value: 'training', label: 'Training / reminders to the team' }, { value: 'process', label: 'A written process or checklist' },
      { value: 'crm_change', label: 'CRM changes or a new CRM' }, { value: 'tool', label: 'A separate tool or spreadsheet' },
      { value: 'nothing', label: 'Nothing yet' },
    ]),
  }));
  out.push(q({
    id: `${dim}_example`, dimension: dim, section: spec.section, role: 'example', type: 'text', optional: true, show_when: { question: dim, ...WEAK },
    purpose: 'A real example anchors the finding in the owner\'s own words.',
    primary: spec.example?.primary || 'Can you think of a recent example of that?', simpler: 'Has it happened recently?', example: '',
    options: [],
  }));
  return out;
}

// ── 1. COMMERCIAL SITUATION ───────────────────────────────────────────────
const COMMERCIAL = [
  q({
    id: 'C1', section: 'commercial', role: 'context', key: 'priority',
    purpose: 'The commercial objective everything else is judged against.',
    primary: "What's the main focus commercially for you at the moment? Is it getting more valuations, winning more instructions, or something else?",
    simpler: 'If you could fix one thing on the sales side this year, what would it be?',
    example: 'Some owners say "we do plenty of valuations but don\'t win enough of them"; others say "we\'re just not getting in front of enough people".',
    options: withUnknown([
      { value: 'more_valuations', label: 'More valuations' },
      { value: 'win_instructions', label: 'Winning more of the valuations we do' },
      { value: 'fees', label: 'Fee levels and margin' },
      { value: 'lettings', label: 'Growing lettings' },
      { value: 'capacity', label: 'Doing more with the same team' },
      { value: 'other', label: 'Something else (note it)' },
    ]),
  }),
  q({
    id: 'C2', section: 'commercial', role: 'context', key: 'obstacles', multi: true, type: 'multi',
    purpose: 'The main obstacles to that priority, in the owner\'s framing.',
    primary: "What's the main thing getting in the way of that right now?",
    simpler: "What's stopping you doing more of it?",
    example: 'For a lot of agencies it\'s "we don\'t hear about people until they\'re already on with someone else".',
    options: withUnknown([
      { value: 'not_enough_opportunities', label: 'Not enough valuation opportunities coming through' },
      { value: 'losing_to_competitors', label: 'Losing valuations to competitors or on fee' },
      { value: 'slipping_through', label: 'Things slipping through the net — follow-up' },
      { value: 'team_time', label: 'Team time and capacity' },
      { value: 'database', label: "Can't get much out of the database" },
      { value: 'market', label: 'Market conditions' },
      { value: 'other', label: 'Something else (note it)' },
    ]),
  }),
  q({
    id: 'C3', section: 'commercial', role: 'context', key: 'branch_count', type: 'number', unit: 'branches', prefill: 'branch_count',
    purpose: 'Scale of the operation.',
    primary: 'How many branches are you running?', simpler: 'Just the one office, or more?', example: '',
  }),
  q({
    id: 'C4', section: 'commercial', role: 'context', key: 'enquiries_per_month', type: 'number', unit: 'per month', source_toggle: true,
    purpose: 'Existing demand volume — the raw material any seller-signal work depends on.',
    primary: 'Roughly how much enquiry volume are you getting across the business each month — buyers and sellers together?',
    simpler: 'How many new enquiries land in a month, across the portals, the phone and walk-ins, roughly?',
    example: 'A single branch might see 150 to 300 a month; a multi-branch agency can be well over a thousand.',
  }),
  q({
    id: 'C5', section: 'commercial', role: 'context', key: 'database_size', type: 'number', unit: 'contacts', source_toggle: true,
    purpose: 'Existing database size — whether historical opportunity work has anything to work with.',
    primary: 'Roughly how many contacts are sitting in your database from past applicants, valuations and old enquiries?',
    simpler: 'If you counted everyone the CRM has ever had a record for, roughly how many is that?',
    example: 'Most established branches have several thousand; some have tens of thousands going back years.',
  }),
  q({
    id: 'C6', section: 'commercial', role: 'context', key: 'crm', prefill: 'crm_name', type: 'single', allow_other_text: true,
    purpose: 'The CRM and any other systems — sets the shape of every integration question.',
    primary: 'Which CRM are you on at the moment?', simpler: 'What software do you run the sales side on?', example: 'Reapit, Alto, Jupix, Dezrez, Street, agentOS, Acquaint, Expert Agent…',
    options: withUnknown([
      { value: 'reapit', label: 'Reapit' }, { value: 'alto', label: 'Alto' }, { value: 'jupix', label: 'Jupix' }, { value: 'dezrez', label: 'Dezrez' },
      { value: 'street', label: 'Street' }, { value: 'agentos', label: 'agentOS' }, { value: 'acquaint', label: 'Acquaint' }, { value: 'expert_agent', label: 'Expert Agent' },
      { value: 'spreadsheet', label: 'Spreadsheets / no real CRM' }, { value: 'other', label: 'Other (note it)' },
    ]),
  }),
  q({
    id: 'C7', section: 'commercial', role: 'detail', key: 'crm_access',
    purpose: 'Whether NOVUS could actually get at the records — the dependency behind F2, I2 and I3.',
    primary: "If we needed to look at what's in the CRM — say an export of past valuations, or access to the records — is that something you'd be able to give us?",
    simpler: 'Can you get data out of your CRM easily, or is it locked down?',
    example: 'Some providers let you export everything to a spreadsheet in a few clicks; some make you ask them and wait.',
    options: withUnknown([
      { value: 'export', label: 'Yes — we can export or give access' },
      { value: 'api', label: 'We already have API / integration access' },
      { value: 'unsure', label: "Not sure what's possible" },
      { value: 'blocked', label: "No — it's locked down or the provider won't allow it" },
    ]),
  }),
  q({
    id: 'C7_block', section: 'commercial', role: 'detail', key: 'crm_block', show_when: { question: 'C7', any: ['blocked'] },
    purpose: 'What the block actually is — a provider policy is a real limit; "nobody knows how" is an assessment item.',
    primary: "What's actually stopping it — is it the provider, the contract, or just that nobody's ever worked out how?",
    simpler: 'Is it a rule, or a not-sure-how?', example: 'Some CRMs charge for an export; some just hide the button.',
    options: withUnknown([
      { value: 'provider_policy', label: "The provider doesn't allow it" }, { value: 'contract', label: "It's a contract / cost thing" },
      { value: 'nobody_knows_how', label: "Nobody's worked out how" }, { value: 'owner_prefers_not', label: "I'd rather not share it" },
    ]),
  }),
];

// ── 2. FOUNDATIONS ────────────────────────────────────────────────────────
const F = 'foundations';
const FOUNDATIONS = [
  q({
    id: 'F1', dimension: 'F1', section: F, role: 'primary',
    purpose: 'Is commercially relevant information (selling situation, timeframe) captured reliably?',
    primary: 'When your team speaks to customers, how consistently are things like their selling situation and moving timeframe recorded?',
    simpler: 'Does that information actually make it into the CRM, or does some of it get lost after conversations?',
    example: "Say somebody enquires about a house and mentions they've got somewhere to sell as well. Does that selling information get recorded properly?",
    options: withUnknown([
      { value: 'consistently', label: "Consistently — it's recorded every time", level: 'strong' },
      { value: 'mostly', label: 'Mostly, but some gets missed', level: 'partial' },
      { value: 'patchy', label: 'Patchy — depends who takes the call', level: 'weak' },
      { value: 'rarely', label: "Rarely — it mostly lives in people's heads", level: 'weak' },
    ]),
  }),
  ...exploration('F1', {
    section: F,
    verify: {
      primary: "Even the softer things — a buyer mentioning they've got a place to sell, or that they're not moving until the summer — that gets recorded as well?",
      simpler: 'Is it just the basics, or the selling situation too?',
      options: [
        { value: 'yes_all', label: 'Yes — selling situation and timeframe included', verdict: 'confirm' },
        { value: 'mostly', label: 'Mostly the basics; the softer stuff sometimes', verdict: 'downgrade' },
        { value: 'not_really', label: 'Not really — mainly name, number, what they want to view', verdict: 'downgrade' },
      ],
    },
    cause: {
      primary: 'What do you think is behind that — is it time, no set way of doing it, the CRM making it awkward, the team not doing it, or something else?',
      simpler: 'Why does it get missed?',
      options: [
        { value: 'time', label: 'Time — too busy on the phones' }, { value: 'no_process', label: "There's no set way of doing it" },
        { value: 'crm_limits', label: 'The CRM makes it awkward' }, { value: 'staff_adoption', label: "The team just don't do it" },
        { value: 'other', label: 'Something else (note it)' },
      ],
    },
    extras: [
      {
        id: 'F1_crm_limit', show_when: { question: 'F1_cause', any: ['crm_limits'] },
        purpose: 'The actual CRM limitation, not the impression of one.',
        primary: 'What is it about the CRM that gets in the way?', simpler: 'Where does it fall down — no field for it, too many clicks, no prompt?', example: '',
        options: withUnknown([
          { value: 'no_fields', label: 'Nowhere obvious to put it' }, { value: 'too_slow', label: 'Too many clicks / too slow' },
          { value: 'no_prompt', label: "It doesn't prompt for it" }, { value: 'mobile', label: 'Hard to use on the move' }, { value: 'other', label: 'Other (note it)' },
        ]),
      },
      {
        id: 'F1_process', show_when: { question: 'F1_cause', any: ['staff_adoption'] },
        purpose: 'Whether a process exists and is not followed (a management issue) or was never set out.',
        primary: "Is there an agreed way of doing it that isn't being followed, or has it never really been set out?",
        simpler: 'Do they know what they should be recording?', example: '',
        options: withUnknown([
          { value: 'exists_not_followed', label: "There's a process — it isn't followed" },
          { value: 'never_set_out', label: 'Never really been set out' },
        ]),
      },
    ],
    consequence: {
      primary: 'Where do you actually notice that — what does it cost you?',
      simpler: 'What goes wrong because of it?',
      options: [
        { value: 'missed_sellers', label: 'Seller opportunities get missed' }, { value: 'repeated_questions', label: 'Customers get asked the same things again' },
        { value: 'no_followup', label: 'Nothing gets followed up' }, { value: 'no_visibility', label: "Can't see what's in the pipeline" },
      ],
    },
  }),

  q({
    id: 'F2', dimension: 'F2', section: F, role: 'primary',
    purpose: 'Can anyone on the team understand a returning customer\'s situation quickly?',
    primary: 'If somebody comes back after a few months and speaks to someone else on your team, can they quickly understand their situation?',
    variants: [{ when: { question: 'F1', levels: ['weak', 'partial'] }, primary: "For what does make it into the CRM — if somebody comes back after a few months and speaks to someone else, can they quickly pick up where that person is?" }],
    simpler: 'Can someone open their CRM record and understand what\'s happened previously?',
    example: 'If I mentioned three months ago that I was planning to sell, would someone else on your team know that if I rang tomorrow?',
    options: withUnknown([
      { value: 'yes_easily', label: "Yes — it's all there and easy to see", level: 'strong' },
      { value: 'with_digging', label: 'Yes, with a bit of digging', level: 'partial' },
      { value: 'sometimes', label: 'Sometimes — depends who dealt with them', level: 'weak' },
      { value: 'no', label: "No — they'd be starting from scratch", level: 'weak' },
    ]),
  }),
  ...exploration('F2', {
    section: F,
    verify: {
      primary: "Even if they've spoken to different negotiators or enquired about several properties?",
      simpler: 'Does it still hang together when more than one person has dealt with them?',
      options: [
        { value: 'yes', label: 'Yes — one record, whole story', verdict: 'confirm' },
        { value: 'mostly', label: 'Mostly — the odd duplicate record', verdict: 'downgrade' },
        { value: 'no', label: 'No — it gets messy across people and properties', verdict: 'downgrade' },
      ],
    },
    cause: {
      primary: 'Why is that — are the notes scattered, are there duplicate records, is the history hard to read in the CRM, or does not much get recorded in the first place?',
      variants: [{ when: { question: 'F1', levels: ['weak', 'partial'] }, primary: "Leaving aside what never gets recorded — why is the history that is there hard to pick up? Scattered notes, duplicate records, the CRM itself?" }],
      simpler: 'Where does the history get lost?',
      options: [
        { value: 'scattered', label: 'Notes scattered across people and systems' }, { value: 'duplicates', label: 'Duplicate records for the same person' },
        { value: 'history_hard', label: 'The CRM makes history hard to read' }, { value: 'not_recorded', label: 'Not much gets recorded in the first place', hide_when: { question: 'F1', levels: ['weak', 'partial'] } },
        { value: 'other', label: 'Something else (note it)' },
      ],
    },
    consequence: {
      primary: 'What does that cause — customers repeating themselves, missing that they\'re a potential seller, calls taking longer?',
      simpler: 'What goes wrong when the history isn\'t there?',
      options: [
        { value: 'repeated_questions', label: 'Customers repeat themselves' }, { value: 'missed_context', label: "We miss that they're a potential seller" },
        { value: 'poor_experience', label: 'It looks disorganised to the customer' }, { value: 'slow', label: 'Calls take longer than they should' },
      ],
    },
  }),

  q({
    id: 'F3', dimension: 'F3', section: F, role: 'primary',
    purpose: 'Does a not-yet-ready seller get a defined next action?',
    primary: "When somebody mentions they're planning to sell, but they're not ready just yet, what normally happens next?",
    variants: [{ when: { question: 'C2', any: ['slipping_through'] }, primary: "You mentioned things slipping through the net — when somebody says they're planning to sell but not just yet, what normally happens next?" }],
    simpler: 'Does someone set a follow-up, or is it mainly down to the negotiator remembering?',
    example: "Someone tells you in June they're thinking of selling in September. What happens between June and September?",
    options: withUnknown([
      { value: 'task_every_time', label: 'A follow-up gets set every time', level: 'strong' },
      { value: 'sometimes_task', label: 'Sometimes a task, sometimes not', level: 'partial' },
      { value: 'memory', label: 'Mainly down to the negotiator remembering', level: 'weak' },
      { value: 'nothing', label: 'Honestly, usually nothing until they come back to us', level: 'weak' },
    ]),
  }),
  ...exploration('F3', {
    section: F,
    verify: {
      primary: 'Is that the same for a "maybe in six months" as it is for "next month"?',
      simpler: 'Do the longer-term ones get a date too?',
      options: [
        { value: 'yes', label: 'Yes — everyone gets a dated follow-up', verdict: 'confirm' },
        { value: 'near_only', label: 'The near ones, not the long ones', verdict: 'downgrade' },
        { value: 'no', label: 'No — the long-term ones drift', verdict: 'downgrade' },
      ],
    },
    cause: {
      primary: "Why is that — no agreed way of doing it, no easy way to set reminders, too busy, or it's not clear whose job it is?",
      variants: [{ when: { question: 'F3', any: ['sometimes_task'] }, primary: 'What decides whether a task gets set or not?' }],
      simpler: 'Why don\'t they get followed up?',
      options: [
        { value: 'no_process', label: 'No agreed way of doing it' }, { value: 'no_reminder_tool', label: 'No easy way to set reminders in the CRM' },
        { value: 'too_busy', label: 'Too busy — today\'s work wins' }, { value: 'unclear_owner', label: "Not clear whose job it is" },
        { value: 'other', label: 'Something else (note it)' },
      ],
    },
    consequence: {
      primary: "Where does that hurt — do those valuations end up going to whoever's in front of them at the time?",
      simpler: 'What happens to those people?',
      options: [
        { value: 'lost_valuations', label: "They instruct whoever's in front of them" }, { value: 'late', label: 'We get to them late' },
        { value: 'no_visibility', label: "We can't see how many are out there" },
      ],
    },
  }),

  q({
    id: 'F4', dimension: 'F4', section: F, role: 'primary',
    purpose: 'Is there ownership, completion tracking and exception handling for follow-ups?',
    primary: 'How do you make sure those follow-ups actually happen?',
    variants: [
      { when: { question: 'F3', any: ['memory'] }, primary: "You said it's mostly down to the negotiator remembering — if one of those gets forgotten, does anything pick it up?" },
      { when: { question: 'F3', any: ['sometimes_task'] }, primary: 'For the ones that do get a task set — how do you make sure they actually happen?' },
    ],
    simpler: "If someone was meant to call a potential seller yesterday but didn't, would anyone know?",
    example: 'A negotiator was supposed to call me about a valuation and never did. Is there something that picks that up?',
    options: withUnknown([
      { value: 'tracked_reviewed', label: 'Tracked in the system and reviewed — overdue ones get picked up', level: 'strong' },
      { value: 'tracked_not_reviewed', label: "They're in the system but nobody really checks", level: 'partial' },
      { value: 'manager_asks', label: 'I ask the team / it comes up in meetings', level: 'partial' },
      { value: 'nothing', label: 'Nothing, really', level: 'weak' },
    ]),
  }),
  ...exploration('F4', {
    section: F,
    verify: {
      primary: "If someone was meant to call a potential seller yesterday and didn't — would that be picked up by a report or an alert, or only if someone happens to remember?",
      simpler: 'Is there something that shows overdue follow-ups?',
      options: [
        { value: 'report_or_alert', label: 'A report or alert would show it', verdict: 'confirm' },
        { value: 'someone_remembers', label: 'Only if someone remembers', verdict: 'downgrade' },
        { value: 'wouldnt', label: "It wouldn't be picked up", verdict: 'downgrade' },
      ],
    },
    cause: {
      primary: "What's missing — an overdue view, clear ownership, tasks being ignored, or no time to review them?",
      simpler: 'Why do they slip?',
      options: [
        { value: 'no_overdue_view', label: 'No overdue view or report' }, { value: 'ownership_unclear', label: "Ownership isn't clear" },
        { value: 'tasks_ignored', label: 'Tasks exist but get ignored or closed off' }, { value: 'no_review_time', label: 'No time to review them' },
        { value: 'other', label: 'Something else (note it)' },
      ],
    },
    consequence: {
      primary: 'And what does that lead to — missed sellers, not knowing who\'s doing what, or the team being inconsistent?',
      simpler: 'What does it cost you?',
      options: [
        { value: 'missed_sellers', label: 'Missed sellers' }, { value: 'no_accountability', label: "Can't tell who's doing what" },
        { value: 'inconsistency', label: 'Inconsistent between negotiators' },
      ],
    },
  }),

  q({
    id: 'F5', dimension: 'F5', section: F, role: 'primary',
    purpose: 'Is there structured progression and outcome tracking for opportunities?',
    primary: 'How do you currently track what happens to the opportunities your team are working?',
    simpler: 'Can you see which opportunities went on to become valuations and instructions?',
    example: 'If your team called 30 people from the database last week, could you see how many turned into valuations?',
    options: withUnknown([
      { value: 'full', label: 'We can see every opportunity through to valuation and instruction', level: 'strong' },
      { value: 'partial', label: "We track valuations and instructions, but not where they came from", level: 'partial' },
      { value: 'spreadsheet', label: 'Bits of it in a spreadsheet or on a whiteboard', level: 'partial' },
      { value: 'none', label: "We don't really — we see the instructions when they land", level: 'weak' },
    ]),
  }),
  ...exploration('F5', {
    section: F,
    frequency: false,
    verify: {
      primary: 'If your team called 30 people from the database last week, could you see how many turned into valuations?',
      simpler: 'Can you trace a valuation back to where it came from?',
      options: [
        { value: 'yes', label: 'Yes — source to valuation to instruction', verdict: 'confirm' },
        { value: 'roughly', label: 'Roughly — with some manual work', verdict: 'downgrade' },
        { value: 'no', label: 'No', verdict: 'downgrade' },
      ],
    },
    cause: {
      primary: 'Why is that — no stages set up for seller opportunities, the CRM reporting not showing it, or it just not being recorded?',
      simpler: 'What stops you seeing it?',
      options: [
        { value: 'no_stages', label: 'No stages or pipeline for seller opportunities' }, { value: 'crm_reporting', label: "CRM reporting doesn't show it" },
        { value: 'not_recorded', label: "It isn't recorded" }, { value: 'other', label: 'Something else (note it)' },
      ],
    },
    consequence: {
      primary: "And what does that mean day to day — you can't tell what's working, can't manage the team on it, effort goes in the wrong place?",
      simpler: 'What does not knowing cost you?',
      options: [
        { value: 'cant_judge', label: "Can't tell what's working" }, { value: 'cant_manage', label: "Can't manage the team on it" },
        { value: 'wasted_effort', label: 'Effort goes in the wrong places' },
      ],
    },
  }),
];

// ── 3. INTELLIGENCE ───────────────────────────────────────────────────────
const I = 'intelligence';
const INTELLIGENCE = [
  q({
    id: 'I1', dimension: 'I1', section: I, role: 'primary',
    purpose: 'Are seller signals in incoming demand recognised and picked up?',
    primary: "When someone comes through as a buyer but mentions they've got somewhere to sell, how do you make sure that selling opportunity gets picked up?",
    variants: [{ when: { question: 'F1', any: ['mostly'] }, primary: "You said the selling situation mostly gets recorded — when a buyer mentions they've got somewhere to sell, is there anything that flags it, or does it rely on the negotiator noticing?" }],
    simpler: 'Does your system flag that, or does whoever handles the enquiry need to spot it?',
    example: 'Someone enquires through Rightmove about a house and mentions they own a place they need to sell first.',
    options: withUnknown([
      { value: 'system_flags', label: 'The system flags it and someone acts on it', level: 'strong' },
      { value: 'process_manual', label: "The negotiator is expected to spot it and log it — a process, not a system", level: 'partial' },
      { value: 'ad_hoc', label: 'Whoever handles the enquiry needs to spot it', level: 'weak' },
      { value: 'slips', label: 'Honestly, a lot of those slip through', level: 'weak' },
    ]),
  }),
  ...exploration('I1', {
    section: I,
    verify: {
      primary: 'What does the system actually identify for you, and what happens when it finds something?',
      simpler: 'When it flags one, who does what?',
      options: [
        { value: 'identifies_routes', label: 'Identifies it and routes it to someone with a task', verdict: 'confirm' },
        { value: 'identifies_only', label: 'Identifies it, but nothing structured happens next', verdict: 'downgrade' },
        { value: 'not_sure', label: 'Not sure exactly what it does', verdict: 'downgrade' },
      ],
    },
    cause: {
      primary: 'Why do they get missed — nothing reads the enquiries for it, people are busy, or there\'s nowhere for it to go once spotted?',
      simpler: 'Where does it fall down?',
      options: [
        { value: 'nothing_reads', label: 'Nothing reads the enquiries for it' }, { value: 'busy', label: 'People are too busy to spot it' },
        { value: 'nowhere_to_go', label: "Nowhere for it to go once it's spotted" }, { value: 'other', label: 'Something else (note it)' },
      ],
    },
    extras: [
      {
        id: 'I1_volume', type: 'number', unit: 'per month', source_toggle: true, show_when: { question: 'I1', levels: ['weak', 'partial', 'strong'] },
        purpose: 'How much of the incoming demand carries a seller signal — sizes the opportunity.',
        primary: 'Roughly how many of your buyer enquiries a month mention they\'ve got something to sell?',
        simpler: 'Out of a month\'s enquiries, how many are also potential sellers?', example: 'In many areas it\'s somewhere between one in ten and one in five.',
      },
      {
        id: 'I1_current', show_when: { question: 'I1', levels: ['weak', 'partial'] },
        purpose: 'What the current systems already do with the signal.',
        primary: 'Does your CRM or the portal feed do anything with that at the moment?', simpler: 'Does anything tag or flag it today?', example: '',
        options: withUnknown([
          { value: 'nothing', label: 'Nothing' }, { value: 'tags_no_followup', label: 'Tags or flags it, but nobody follows up' },
          { value: 'partial', label: 'Some of it, sometimes' },
        ]),
      },
    ],
    consequence: {
      primary: "And what happens to those people — do they end up instructing someone else?",
      simpler: 'Who wins those valuations?',
      options: [
        { value: 'lost_valuations', label: 'We never get the valuation' }, { value: 'competitor_wins', label: 'A competitor gets there first' },
        { value: 'late', label: 'We get to them late' },
      ],
    },
  }),

  q({
    id: 'I2', dimension: 'I2', section: I, role: 'primary',
    purpose: 'Does anything connect what a customer said or did at different points in time?',
    primary: 'Does your system help connect things a customer has said or done at different points in time?',
    simpler: 'If someone had a valuation six months ago and starts enquiring about buying again, would anything flag that?',
    example: "A couple you valued last spring didn't list. This month they've booked two viewings with you. Would anyone notice the link?",
    options: withUnknown([
      { value: 'flags_changes', label: "Yes — it flags when someone's circumstances change", level: 'strong' },
      { value: 'there_if_you_look', label: "Partly — it's all there if someone looks", level: 'partial' },
      { value: 'no', label: "No — it's down to whoever remembers", level: 'weak' },
    ]),
  }),
  ...exploration('I2', {
    section: I,
    verify: {
      primary: 'If someone had a valuation six months ago and starts enquiring about buying again, would anything flag that?',
      simpler: 'Would the system spot the link, or a person?',
      options: [
        { value: 'yes', label: 'Yes — the system would flag it', verdict: 'confirm' },
        { value: 'person', label: 'Only if a person noticed', verdict: 'downgrade' },
        { value: 'no', label: 'No', verdict: 'downgrade' },
      ],
    },
    cause: {
      primary: 'Is that because enquiries and valuations sit in separate places, duplicate records, the CRM not doing it, or it just never being looked at?',
      simpler: 'Why doesn\'t it join up?',
      options: [
        { value: 'separate_places', label: 'Enquiries and valuations sit in separate places' }, { value: 'duplicates', label: 'Duplicate records' },
        { value: 'crm_cant', label: "The CRM can't do it" }, { value: 'never_looked', label: 'Never really looked at it' }, { value: 'other', label: 'Something else (note it)' },
      ],
    },
    extras: [
      {
        id: 'I2_matching', show_when: { question: 'I2', levels: ['weak', 'partial', 'strong'] },
        purpose: 'Whether customers can be reliably matched across records — the technical dependency for any connection work.',
        primary: 'Are customers reliably matched — does the same phone number or email pull up the same record every time?',
        simpler: 'Do people end up with more than one record?', example: '',
        options: withUnknown([
          { value: 'yes', label: 'Yes — one person, one record' }, { value: 'mostly', label: 'Mostly — some duplicates' }, { value: 'no', label: 'No — lots of duplicates' },
        ]),
      },
    ],
    consequence: {
      primary: 'What does that cost — past valuations that go on to sell with someone else, people repeating themselves?',
      simpler: 'What gets missed?',
      options: [
        { value: 'missed_reactivation', label: 'Past valuations that list with someone else' }, { value: 'repeated_questions', label: 'People repeat themselves' },
        { value: 'missed_sellers', label: 'Sellers we never realise are sellers' },
      ],
    },
  }),

  q({
    id: 'I3', dimension: 'I3', section: I, role: 'primary',
    purpose: 'Is the historical database being used to identify valuation opportunities?',
    primary: 'How are you currently identifying new valuation opportunities from the people already sitting in your database?',
    variants: [{ when: { question: 'C2', any: ['database'] }, primary: "You said you can't get much out of the database — how are you finding valuation opportunities in it at the moment, if at all?" }],
    simpler: 'Are you actively using your old contacts to find potential sellers, or is it mainly when negotiators have time to call through them?',
    example: 'The applicants from two years ago who bought elsewhere, the valuations that never listed — is anyone going back to them?',
    options: withUnknown([
      { value: 'systematic', label: 'Systematically — segmented, prioritised, worked', level: 'strong' },
      { value: 'campaigns', label: 'Occasional campaigns — mailers, e-shots, calling sessions', level: 'partial' },
      { value: 'when_time', label: 'When negotiators have time to call through it', level: 'weak' },
      { value: 'not_used', label: "We don't really use the old database", level: 'weak' },
    ]),
  }),
  ...exploration('I3', {
    section: I,
    verify: {
      primary: 'How do you decide who goes into that — and do you know what it produced last quarter?',
      simpler: 'Is it measured?',
      options: [
        { value: 'know_results', label: 'Selected on their situation; results are measured', verdict: 'confirm' },
        { value: 'not_measured', label: "We do it, but it isn't measured", verdict: 'downgrade' },
        { value: 'not_sure', label: 'Not sure', verdict: 'downgrade' },
      ],
    },
    cause: {
      primary: "Why is that — no time, no way of knowing who's worth calling, the data being a mess, or it just not being a priority?",
      variants: [{ when: { question: 'I3', any: ['campaigns'] }, primary: 'What decides who goes into those campaigns — and what stops it being more systematic?' }],
      simpler: 'What stops you working the database?',
      options: [
        { value: 'no_time', label: 'No time' }, { value: 'no_way_to_prioritise', label: "No way of knowing who's worth calling" },
        { value: 'data_messy', label: 'The data is a mess' }, { value: 'not_priority', label: "It hasn't been a priority" }, { value: 'other', label: 'Something else (note it)' },
      ],
    },
    extras: [
      {
        id: 'I3_history', show_when: { question: 'I3', levels: ['weak', 'partial', 'strong'] },
        purpose: 'Whether historical information is accessible at all — the hard dependency for database work.',
        primary: 'How far back does the usable history go — are past valuations, applicants and enquiries all in the CRM?',
        simpler: 'Is the old stuff actually in the system?', example: 'Some agencies moved CRM a few years ago and the old records never came across.',
        options: withUnknown([
          { value: 'all_in_crm', label: 'Yes — years of it, all in the CRM' }, { value: 'partly', label: 'Partly — recent years are, older records are patchy' },
          { value: 'elsewhere', label: 'Mostly in old systems, spreadsheets or people\'s heads' },
        ]),
      },
      {
        id: 'I3_quality', show_when: { question: 'I3', levels: ['weak', 'partial', 'strong'] },
        purpose: 'Data quality — whether the records could be worked without a clean-up first.',
        primary: 'How clean is it — up-to-date numbers, not too much duplication?', simpler: 'Could you ring people off it tomorrow?', example: '',
        options: withUnknown([
          { value: 'clean', label: 'Pretty clean' }, { value: 'ok', label: 'Usable, with some rubbish in it' }, { value: 'messy', label: 'Messy' },
        ]),
      },
    ],
    consequence: {
      primary: 'What do you think is sitting in there — valuations you could be doing that are going elsewhere?',
      simpler: 'What are you missing by not working it?',
      options: [
        { value: 'untouched_value', label: 'Valuations we could be doing' }, { value: 'competitor_wins', label: 'They list with a competitor' },
        { value: 'unknown_value', label: "Honestly no idea what's in there" },
      ],
    },
    tried: {
      options: [
        { value: 'mailers', label: 'Mailers / leaflets' }, { value: 'eshots', label: 'E-shots' }, { value: 'calling_days', label: 'Calling sessions' },
        { value: 'nothing', label: 'Nothing yet' },
      ],
    },
  }),

  q({
    id: 'I4', dimension: 'I4', section: I, role: 'primary',
    purpose: 'Is there commercial prioritisation across a large number of contacts?',
    primary: "When you've got a large number of contacts to work through, how do you decide who the team should focus on first?",
    variants: [{ when: { question: 'I3', levels: ['weak', 'partial'] }, primary: 'When the team do go through the database, how do they decide who to call first?' }],
    simpler: "How do you know who's worth calling today rather than just working through a list?",
    example: 'Two hundred names on a Monday morning. Who gets called first, and why?',
    options: withUnknown([
      { value: 'scored', label: "There's a scoring or prioritisation based on their situation and activity", level: 'strong' },
      { value: 'simple_rules', label: 'Simple rules — recent activity, last contact date', level: 'partial' },
      { value: 'list_order', label: 'Work through the list, top to bottom', level: 'weak' },
      { value: 'judgement', label: "The negotiator's judgement", level: 'weak' },
    ]),
  }),
  ...exploration('I4', {
    section: I,
    verify: {
      primary: 'What goes into that — is it their circumstances and activity, or mainly how recently they were added?',
      simpler: 'What is the priority based on?',
      options: [
        { value: 'circumstances', label: 'Circumstances, intent and activity', verdict: 'confirm' },
        { value: 'recency', label: 'Mainly recency', verdict: 'downgrade' },
        { value: 'not_sure', label: 'Not sure', verdict: 'downgrade' },
      ],
    },
    cause: {
      primary: "Is that because you don't hold the information to prioritise on, there's no tool for it, or it's never really been needed?",
      simpler: 'Why isn\'t there a priority order?',
      options: [
        { value: 'no_data', label: "We don't hold the information to prioritise on" }, { value: 'no_tool', label: 'No tool for it' },
        { value: 'never_needed', label: 'Never really needed it' }, { value: 'other', label: 'Something else (note it)' },
      ],
    },
    extras: [
      {
        id: 'I4_signals', show_when: { question: 'I4', levels: ['weak', 'partial'] },
        purpose: 'Whether activity signals exist to prioritise on.',
        primary: "Do you get to see when someone's active again — a new enquiry, portal activity, a website visit?",
        simpler: 'Would you know if an old contact started looking again?', example: '',
        options: withUnknown([
          { value: 'yes', label: 'Yes' }, { value: 'some', label: 'Some of it' }, { value: 'no', label: 'No' },
        ]),
      },
    ],
    consequence: {
      primary: 'And where does that show — time spent on people who were never going to sell, or missing the ones who were ready?',
      simpler: 'What goes wrong without a priority order?',
      options: [
        { value: 'wasted_calls', label: 'Time on people who were never going to sell' }, { value: 'missed_ready', label: 'Missing the ones who were ready' },
        { value: 'team_avoid', label: 'The team avoid the list altogether' },
      ],
    },
    frequency: false,
  }),

  q({
    id: 'I5', dimension: 'I5', section: I, role: 'primary',
    purpose: 'Do recorded outcomes change what the team focuses on?',
    primary: "When you find something that's working particularly well for generating valuations, how does that change what the team focuses on?",
    variants: [
      { when: { question: 'F5', any: ['none'] }, primary: "You said outcomes aren't really tracked — so when something is clearly working, is that picked up informally, or not really at all?" },
      { when: { question: 'F5', any: ['partial', 'spreadsheet'] }, primary: "You track the valuations and instructions but not where they came from — when something's clearly working, does that change what the team do?" },
    ],
    simpler: "Does your system learn anything from which people actually go on to book valuations, or is it mainly the team's judgement?",
    example: 'Say the past-valuation call-backs produced three instructions last month. Does that change what gets done this month?',
    options: withUnknown([
      { value: 'measured_adjust', label: 'We measure what converts and change the approach on the back of it', level: 'strong' },
      { value: 'informal', label: 'Informally — we notice and mention it in meetings', level: 'partial' },
      { value: 'no_learning', label: "It doesn't really — we keep doing the same things", level: 'weak' },
    ]),
  }),
  ...exploration('I5', {
    section: I,
    frequency: false,
    verify: {
      primary: "Does your system learn anything from which people actually go on to book valuations, or is it mainly the team's judgement?",
      simpler: 'System or gut?',
      options: [
        { value: 'system_learns', label: 'The system feeds it back', verdict: 'confirm' },
        { value: 'team_judgement', label: "Mainly the team's judgement", verdict: 'downgrade' },
        { value: 'mix', label: 'A bit of both', verdict: 'downgrade' },
      ],
    },
    cause: {
      primary: "Is that because outcomes aren't recorded well enough to learn from, there's no time to look, or nothing to look at it with?",
      simpler: 'Why doesn\'t it feed back?',
      options: [
        { value: 'no_outcomes', label: "Outcomes aren't recorded well enough" }, { value: 'no_time', label: 'No time to look' },
        { value: 'no_tool', label: 'Nothing to look at it with' }, { value: 'other', label: 'Something else (note it)' },
      ],
    },
    consequence: {
      primary: 'What does that mean — you keep doing things that don\'t work, or stop doing things that do?',
      simpler: 'What does not learning cost?',
      options: [
        { value: 'keep_failing', label: "Keep doing things that don't work" }, { value: 'drop_working', label: 'Stop doing things that were working' },
        { value: 'cant_scale', label: "Can't tell the team what to do more of" },
      ],
    },
  }),
];

// ── 4. COMMERCIAL VALUE (asked last) ───────────────────────────────────────
const VALUE = [
  q({
    id: 'C8', section: 'value', role: 'context', key: 'valuations_per_month', type: 'number', unit: 'per month', source_toggle: true,
    purpose: 'Current monthly valuation volume — the baseline.',
    primary: 'To put a number on it — how many market appraisals are you doing a month at the moment?', simpler: 'How many valuations a month, roughly?', example: '',
  }),
  q({
    id: 'C9', section: 'value', role: 'context', key: 'instructions_per_month', type: 'number', unit: 'per month', source_toggle: true,
    purpose: 'Current monthly instruction volume — the baseline.',
    primary: 'And how many of those are turning into instructions each month?', simpler: 'How many new instructions a month?', example: '',
  }),
  q({
    id: 'C10', section: 'value', role: 'context', key: 'fee_per_instruction', type: 'number', unit: '£', source_toggle: true,
    purpose: 'Average fee per instruction — what an extra instruction is worth.',
    primary: "What's your average fee on an instruction, in pounds?", simpler: 'On a typical sale, what fee do you actually bank?', example: 'Say 1.2% on a £350k house — about £4,200.',
  }),
  q({
    id: 'C11', section: 'value', role: 'context', key: 'conversion_pct', type: 'number', unit: '%', source_toggle: true, derived_from: ['C8', 'C9'],
    purpose: 'Valuation-to-instruction conversion. Covered automatically when C8 and C9 are both known; otherwise asked.',
    primary: 'Roughly what proportion of the valuations you do end up as instructions?', simpler: 'Out of ten valuations, how many do you win?', example: '',
  }),
];

export const QUESTIONS = Object.freeze([...COMMERCIAL, ...FOUNDATIONS, ...INTELLIGENCE, ...VALUE]);
export const QUESTION_BY_ID = Object.freeze(Object.fromEntries(QUESTIONS.map((question) => [question.id, question])));

// ── pure helpers ──────────────────────────────────────────────────────────
const text = (value) => String(value ?? '').trim();

export function optionOf(question, value) {
  return (question?.options || []).find((option) => option.value === text(value)) || null;
}

// The level a primary answer maps to: weak | partial | strong | unknown.
export function levelOf(question, answer) {
  if (!answer || answer.skipped) return 'unknown';
  const option = optionOf(question, answer.value);
  return option?.level || (text(answer.value) ? 'unknown' : 'unknown');
}

// The level a dimension is treated as AFTER verification: a strong primary
// answer whose verification question came back 'downgrade' is treated as
// partial, which is what opens the exploration questions for it.
export function effectiveLevel(dimensionId, answers) {
  const primary = QUESTION_BY_ID[dimensionId];
  if (!primary || primary.role !== 'primary') return 'unknown';
  const level = levelOf(primary, answers?.[dimensionId]);
  if (level !== 'strong') return level;
  const verify = QUESTION_BY_ID[`${dimensionId}_verify`];
  const verifyAnswer = answers?.[`${dimensionId}_verify`];
  if (!verify || !verifyAnswer || verifyAnswer.skipped) return level;
  return optionOf(verify, verifyAnswer.value)?.verdict === 'downgrade' ? 'partial' : level;
}

export function answerValues(answer) {
  if (!answer || answer.skipped) return [];
  if (Array.isArray(answer.values)) return answer.values.map(text).filter(Boolean);
  return text(answer.value) ? [text(answer.value)] : [];
}

// ── shared discovery context: coverage rules ───────────────────────────────
// Each rule says: WHEN these stored answers are present, THIS question is
// already covered, and its answer is DERIVED by mapping those answers. A
// rule never fires on similar words — only on a specific answer that
// establishes what the question was designed to collect. `when` conditions
// are all evaluated on STORED answers (never on other derived answers), so
// there are no chains. First matching rule wins. A stored answer for the
// question, or a stored `{ reopened: true }` marker ("ask anyway"), always
// beats coverage.
//
// derive shapes:
//   { value }                       a fixed option (the level it implies is
//                                   the level the basis answer implies)
//   { values }                      fixed multi-select
//   { map_from, map }               map the basis answer's value(s) through
//                                   `map`; the rule does not fire if the
//                                   mapping is empty
//   { compute: 'conversion' }       C11 from C8 / C9
export const COVERAGE_RULES = Object.freeze([
  { id: 'C11_from_volumes', question: 'C11', basis: ['C8', 'C9'], when: [{ question: 'C8', number: true }, { question: 'C9', number: true }],
    derive: { compute: 'conversion' }, note: 'Worked out from the monthly valuations and instructions you gave.' },
  { id: 'F4_from_F3_nothing', question: 'F4', basis: ['F3'], when: [{ question: 'F3', any: ['nothing'] }],
    derive: { value: 'nothing' }, note: 'You said usually nothing happens until they come back — there are no follow-ups to make happen yet.' },
  { id: 'F4_cause_from_F3', question: 'F4_cause', basis: ['F3', 'F3_cause'], when: [{ question: 'F3', any: ['nothing'] }, { question: 'F3_cause', answered: true }],
    derive: { map_from: 'F3_cause', map: { unclear_owner: 'ownership_unclear', too_busy: 'no_review_time', no_reminder_tool: 'no_overdue_view' } }, note: 'Carried from why follow-ups do not happen.' },
  { id: 'F4_consequence_from_F3', question: 'F4_consequence', basis: ['F3', 'F3_consequence'], when: [{ question: 'F3', any: ['nothing'] }, { question: 'F3_consequence', answered: true }],
    derive: { map_from: 'F3_consequence', map: { lost_valuations: 'missed_sellers', late: 'missed_sellers', no_visibility: 'no_accountability' } }, note: 'Carried from what missed follow-ups cost you.' },
  { id: 'I1_from_F1_missed_sellers', question: 'I1', basis: ['F1', 'F1_consequence'], when: [{ question: 'F1', any: ['patchy', 'rarely'] }, { question: 'F1_consequence', any: ['missed_sellers'] }],
    derive: { value: 'ad_hoc' }, note: 'Seller mentions are already being missed at the capture stage, so nothing is flagging them — it depends on whoever picks up.' },
  { id: 'I1_cause_from_F1', question: 'I1_cause', basis: ['F1', 'F1_cause'], when: [{ question: 'F1', any: ['patchy', 'rarely'] }, { question: 'F1_consequence', any: ['missed_sellers'] }, { question: 'F1_cause', answered: true }],
    derive: { map_from: 'F1_cause', map: { time: 'busy', crm_limits: 'nothing_reads', no_process: 'nowhere_to_go' } }, note: 'Carried from why capture is patchy.' },
  { id: 'I1_consequence_from_F1', question: 'I1_consequence', basis: ['F1', 'F1_consequence'], when: [{ question: 'F1', any: ['patchy', 'rarely'] }, { question: 'F1_consequence', any: ['missed_sellers'] }],
    derive: { values: ['lost_valuations'] }, note: 'You already said seller opportunities get missed.' },
  { id: 'I1_current_from_cause', question: 'I1_current', basis: ['I1_cause'], when: [{ question: 'I1_cause', any: ['nothing_reads'] }],
    derive: { value: 'nothing' }, note: 'You said nothing reads the enquiries for it.' },
  { id: 'I2_matching_from_F2_verify', question: 'I2_matching', basis: ['F2_verify'], when: [{ question: 'F2_verify', any: ['yes', 'mostly'] }],
    derive: { map_from: 'F2_verify', map: { yes: 'yes', mostly: 'mostly' } }, note: 'Covered by your answer about one record per customer.' },
  { id: 'I2_matching_from_F2_duplicates', question: 'I2_matching', basis: ['F2_cause'], when: [{ question: 'F2_cause', any: ['duplicates'] }],
    derive: { value: 'mostly' }, note: 'You mentioned duplicate records for the same person — matching needs assessing.' },
  { id: 'I3_history_from_no_crm', question: 'I3_history', basis: ['C6'], when: [{ question: 'C6', any: ['spreadsheet'] }],
    derive: { value: 'elsewhere' }, note: 'You are not on a CRM, so the history is in spreadsheets and heads.' },
  { id: 'I4_from_I3_systematic', question: 'I4', basis: ['I3', 'I3_verify'], when: [{ question: 'I3', any: ['systematic'] }, { question: 'I3_verify', any: ['know_results'] }],
    derive: { value: 'scored' }, note: 'You said the database work is segmented and prioritised on their situation — the verification question below checks what goes into that.' },
  { id: 'I4_from_I3_no_prioritisation', question: 'I4', basis: ['I3_cause'], when: [{ question: 'I3_cause', any: ['no_way_to_prioritise'] }],
    derive: { value: 'judgement' }, note: "You said there's no way of knowing who's worth calling." },
  { id: 'I4_cause_from_I3', question: 'I4_cause', basis: ['I3_cause'], when: [{ question: 'I3_cause', any: ['no_way_to_prioritise'] }],
    derive: { values: ['no_data'] }, note: 'Carried from the database answer.' },
  { id: 'I4_signals_from_I2', question: 'I4_signals', basis: ['I2', 'I2_verify'], when: [{ question: 'I2', any: ['flags_changes'] }, { question: 'I2_verify', any: ['yes'] }],
    derive: { value: 'yes' }, note: 'Your system already flags renewed activity.' },
  { id: 'I4_signals_from_I2_partial', question: 'I4_signals', basis: ['I2'], when: [{ question: 'I2', any: ['there_if_you_look'] }],
    derive: { value: 'some' }, note: "You said the activity is there if someone looks." },
  { id: 'I5_cause_from_F5', question: 'I5_cause', basis: ['F5'], when: [{ question: 'F5', any: ['none'] }],
    derive: { values: ['no_outcomes'] }, note: "You already said outcomes aren't tracked — there is nothing to learn from yet." },
  { id: 'I5_consequence_from_F5', question: 'I5_consequence', basis: ['F5', 'F5_consequence'], when: [{ question: 'F5', any: ['none'] }, { question: 'F5_consequence', answered: true }],
    derive: { map_from: 'F5_consequence', map: { cant_judge: 'cant_scale', wasted_effort: 'keep_failing' } }, note: 'Carried from what not tracking outcomes costs you.' },
]);

function num(value) { if (value === '' || value === null || value === undefined) return null; const n = Number(value); return Number.isFinite(n) ? n : null; }
function stored(answers, id) { const a = answers?.[id]; return a && !a.skipped && !a.reopened ? a : null; }
function storedAnswered(answers, id) {
  const a = stored(answers, id);
  if (!a) return false;
  return answerValues(a).some((v) => v !== 'unknown') || (a.value !== undefined && a.value !== '' && a.value !== null && a.value !== 'unknown');
}
function conditionHolds(condition, answers) {
  const a = stored(answers, condition.question);
  if (!a) return false;
  if (condition.number) return num(a.value) !== null;
  if (condition.answered) return storedAnswered(answers, condition.question);
  if (condition.any) return answerValues(a).some((v) => condition.any.includes(v));
  if (condition.levels) return condition.levels.includes(effectiveLevel(condition.question, answers));
  return true;
}
function deriveAnswer(rule, answers) {
  const d = rule.derive;
  const question = QUESTION_BY_ID[rule.question];
  if (d.compute === 'conversion') {
    const vals = num(answers.C8?.value); const inst = num(answers.C9?.value);
    if (!vals || inst === null) return null;
    return { value: Math.round((inst / vals) * 1000) / 10, source: 'derived' };
  }
  if (d.map_from) {
    const mapped = [...new Set(answerValues(answers[d.map_from]).map((v) => d.map[v]).filter(Boolean))];
    if (!mapped.length) return null;
    return question.multi ? { values: mapped } : { value: mapped[0] };
  }
  if (d.values) return { values: [...d.values] };
  return { value: d.value };
}

// -> { [questionId]: { rule_id, basis, note, derived } } for every question an
// earlier stored answer already covers (and that has not been reopened).
export function evaluateCoverage(answers = {}) {
  const out = {};
  for (const rule of COVERAGE_RULES) {
    if (out[rule.question]) continue;
    const own = answers?.[rule.question];
    if (own && (own.reopened || own.skipped || answerValues(own).length || (own.value !== undefined && own.value !== '' && own.value !== null))) continue;
    if (!rule.when.every((condition) => conditionHolds(condition, answers))) continue;
    const derived = deriveAnswer(rule, answers);
    if (!derived) continue;
    out[rule.question] = { rule_id: rule.id, basis: rule.basis, note: rule.note, derived: { ...derived, derived: true, basis: rule.basis } };
  }
  return out;
}

// Stored answers overlaid with derived ones where nothing was stored. This
// is what the engine reads; the stored object is never mutated.
export function effectiveAnswers(answers = {}) {
  const coverage = evaluateCoverage(answers);
  const merged = { ...answers };
  for (const [id, entry] of Object.entries(coverage)) merged[id] = entry.derived;
  return { answers: merged, coverage };
}

// Conditional logic. show_when: { question, levels? , any? }
//   levels — the referenced PRIMARY question's level must be one of these
//   any    — the referenced question's selected values must include one of these
// A question without show_when is always visible. A covered question is not
// visible (it is listed as covered instead) unless it has been reopened.
// `effective` (from effectiveAnswers) may be passed to avoid recomputing; the
// show_when reference is resolved against stored + derived answers, so a
// covered primary still opens the follow-ups the derived answer implies.
export function isVisible(question, answers, effective = null) {
  const eff = effective || effectiveAnswers(answers);
  if (eff.coverage[question?.id]) return false;
  const rule = question?.show_when;
  if (!rule) return true;
  const ref = QUESTION_BY_ID[rule.question];
  const answer = eff.answers?.[rule.question];
  if (!ref || !answer || answer.skipped || (answer.reopened && !answerValues(answer).length && answer.value === undefined)) return false;
  if (rule.levels) return rule.levels.includes(ref.role === 'primary' ? effectiveLevel(ref.id, eff.answers) : levelOf(ref, answer));
  if (rule.any) return answerValues(answer).some((value) => rule.any.includes(value));
  return true;
}

export function visibleQuestions(answers, section = null) {
  const eff = effectiveAnswers(answers);
  return QUESTIONS.filter((question) => (!section || question.section === section) && isVisible(question, answers, eff));
}

// The wording to say now: the first matching variant, else the primary.
// -> { primary, variant: variant id | '' }
export function wordingFor(question, answers) {
  for (const [i, variant] of (question?.variants || []).entries()) {
    if (conditionHolds(variant.when, answers)) return { primary: variant.primary, variant: variant.id || `v${i + 1}` };
  }
  return { primary: question?.primary || '', variant: '' };
}

// Options minus the ones an earlier answer has made redundant.
export function visibleOptions(question, answers) {
  return (question?.options || []).filter((option) => !option.hide_when || !conditionHolds(option.hide_when, answers));
}

// A compact, label-only snapshot of the questions a session actually
// answered — stored with the completed session so it stays readable if this
// registry changes later.
export function snapshotFor(answers) {
  const out = {};
  for (const id of Object.keys(answers || {})) {
    const question = QUESTION_BY_ID[id];
    if (!question) continue;
    out[id] = {
      primary: text(answers[id]?.asked_as) || question.primary, section: question.section, dimension: question.dimension || '', role: question.role,
      options: Object.fromEntries((question.options || []).map((option) => [option.value, option.label])),
    };
  }
  return out;
}

export const _internal = { exploration, q, conditionHolds, deriveAnswer };
