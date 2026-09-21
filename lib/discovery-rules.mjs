// lib/discovery-rules.mjs — the VERSIONED NOVUS deployment rule registry.
// Pure data; no I/O.
//
// Ten configurable components of ONE product, not ten services. The
// diagnosis engine (lib/discovery-engine.mjs) selects rules from a session's
// findings; the pitch generator (lib/discovery-pitch.mjs) may only describe
// rules the engine selected, and only in the terms written here.
//
// DELIVERY STATUS IS A MAINTAINED CLAIM, NOT A DERIVED FACT. Nothing in this
// repository can prove what NOVUS has shipped to an agency, so each rule's
// delivery_status is a statement Joe maintains and the UI shows verbatim
// next to the intervention. Never let an AI step upgrade it. Review before
// every pilot.
//
//   IMPLEMENTED               already implemented and verified in NOVUS
//   SUPPORTED_CONFIGURATION   supported, needs per-agency configuration
//   REQUIRES_ASSESSMENT       needs a technical assessment first (CRM, data)
//   PROPOSED                  proposed / not yet implemented
//   OUTSIDE_PILOT             outside the standard founding pilot
//
// DEPENDENCIES. `dependencies` name the dimension a rule needs and what
// satisfies it. The engine treats an EXISTING STRENGTH in that dimension as
// satisfied (reuse, never rebuild), a selected foundation rule as "provided
// by the plan", and anything else as a blocker or an assessment item.
// `answer_conditions` are hard facts from the discovery answers that gate
// feasibility (e.g. CRM access for anything touching historical records).

export const RULES_VERSION = 2;

export const DELIVERY_STATUSES = Object.freeze({
  IMPLEMENTED: 'Implemented and verified in NOVUS',
  SUPPORTED_CONFIGURATION: 'Supported — requires configuration',
  REQUIRES_ASSESSMENT: 'Requires technical assessment',
  PROPOSED: 'Proposed — not yet implemented',
  OUTSIDE_PILOT: 'Outside the standard founding pilot',
});

export const FOUNDING_OFFER = Object.freeze({
  price_gbp: 1500,
  duration_days: 60,
  setup_target_days: 14,
  commitment: 'No long-term commitment.',
  scope: 'One focused commercial deployment, with the foundations it needs and the agreed intelligence workflows.',
  success_criteria: 'Success criteria agreed before implementation starts.',
  extension: 'A bounded extension of up to 30 days at no additional cost may apply where genuine outcome latency prevents a fair assessment, under the agreed pilot terms.',
  continuation: 'Long-term continuation pricing is not fixed yet; it depends on measured commercial value and the ongoing scope.',
  never: ['No guaranteed number of valuations, instructions or revenue.', 'No additional pricing tiers.'],
});

function rule(def) {
  return Object.freeze({
    version: RULES_VERSION, dependencies: [], answer_conditions: [], ...def,
  });
}

// Standard rule shape (every field the brief requires):
//   rule_id, dimension, title, triggers, required_evidence, commercial_consequence,
//   intervention, implementation_steps, required_data_access, agency_responsibilities,
//   novus_responsibilities, dependencies, measurement, scope_limitations,
//   pitch_explanation, spoken_change (one short clause for the spoken pitch),
//   plan_phrase (one short clause for the compact plan), delivery_status, delivery_status_note
export const RULES = Object.freeze([
  // ── FOUNDATIONS ─────────────────────────────────────────────────────────
  rule({
    rule_id: 'F1', dimension: 'F1', kind: 'foundation', title: 'Establish commercially relevant information capture',
    triggers: { levels: ['weak', 'partial'] },
    required_evidence: ['F1 primary answer weak or partial', 'At least one cause other than staff adoption alone', 'A stated consequence (missed sellers, no follow-up, no visibility)'],
    commercial_consequence: 'Selling situations and timeframes mentioned in conversations are not recorded, so seller opportunities are invisible to everyone but the person who heard them.',
    intervention: 'Make the selling situation, timeframe and property-to-sell a reliable part of every enquiry and conversation record, using the agency\'s existing CRM fields where they exist and a NOVUS-assisted extraction from enquiry text and call notes where they do not.',
    implementation_steps: [
      'Agree the four things every conversation must capture: selling situation, property to sell, timeframe, contact preference.',
      'Map each to an existing CRM field or note convention (no new CRM build).',
      'Configure NOVUS to read incoming enquiry text and logged call notes and extract those four items where they appear.',
      'Give the team a one-line prompt for the two questions to ask when they are missing.',
      'Weekly exception list: conversations with no selling situation recorded.',
    ],
    required_data_access: ['Incoming enquiry feed (portal lead emails or CRM enquiry export)', 'Ability to write or read a note/field on the customer record'],
    agency_responsibilities: ['Agree the capture standard', 'Brief the team once', 'Nominate one person who owns the weekly exception list'],
    novus_responsibilities: ['Configure the extraction', 'Produce the exception list', 'Report capture rate weekly'],
    measurement: ['Share of new enquiries with a recorded selling situation (baseline vs weeks 2–8)', 'Number of seller signals surfaced that were not in the CRM'],
    scope_limitations: ['Does not rebuild CRM screens', 'Cannot capture what was never said or written', 'A process that exists but is not followed is a management matter — NOVUS makes the gap visible, it does not manage the team'],
    pitch_explanation: 'The first thing we\'d do is make sure the selling information your team hear actually lands somewhere — reading the enquiries and call notes for it, and showing you each week where it\'s missing — so that nothing else we do depends on memory.',
    spoken_change: 'make sure what your team hear about selling actually gets recorded',
    plan_phrase: 'capture standard agreed and NOVUS reading enquiries and call notes for selling situations',
    delivery_status: 'SUPPORTED_CONFIGURATION',
    delivery_status_note: 'Enquiry-text extraction exists; the per-agency feed and field mapping are configured per pilot.',
  }),
  rule({
    rule_id: 'F2', dimension: 'F2', kind: 'foundation', title: 'Establish usable customer context',
    triggers: { levels: ['weak', 'partial'] },
    required_evidence: ['F2 primary answer weak or partial', 'A cause (scattered notes, duplicates, unreadable history)', 'A consequence (missed context, repeated questions)'],
    commercial_consequence: 'A returning customer\'s history is not usable by whoever picks up the phone, so prior selling intent is missed and customers repeat themselves.',
    intervention: 'Bring the relevant history for a customer into one readable view — what they enquired about, what they said about selling, what was promised — connected across the records the agency already has.',
    implementation_steps: [
      'Assess how customers are identified across records (phone, email, duplicates).',
      'Agree the matching rule and how duplicates are handled.',
      'Build a per-customer context summary from the accessible records.',
      'Surface it where the team already look (CRM note, or the NOVUS view).',
    ],
    required_data_access: ['CRM export or access to customer, enquiry and valuation records', 'Consistent identifiers (phone/email) on records'],
    agency_responsibilities: ['Provide the export or access', 'Agree the duplicate rule'],
    novus_responsibilities: ['Matching assessment', 'Context summary', 'Refresh cadence'],
    dependencies: [],
    answer_conditions: [{ question: 'C7', not: ['blocked'], effect: 'INFEASIBLE', note: 'Historical records are not accessible — customer context cannot be assembled within the pilot', unless: { question: 'C7_block', any: ['nobody_knows_how'], note: 'Export is "not worked out" rather than blocked — confirm the route with the CRM provider' } }, { question: 'C7', not: ['unsure', 'unknown'], effect: 'ASSESS', note: 'Confirm what the CRM can export before scoping' }],
    measurement: ['Share of returning customers whose prior selling intent is visible before the call', 'Owner-reported instances of customers repeating themselves'],
    scope_limitations: ['Depends on what the CRM can export', 'Does not merge or rewrite CRM records', 'Not a CRM migration'],
    pitch_explanation: 'We\'d put the history of each customer in one place — what they\'ve said about selling, when, and what happened — so whoever picks up the phone knows where they stand.',
    spoken_change: 'put each customer\'s history in one place whoever picks up the phone',
    plan_phrase: 'customer history assembled into one view from the CRM export',
    delivery_status: 'REQUIRES_ASSESSMENT',
    delivery_status_note: 'Depends entirely on what the CRM exposes; assessed in days 1–3.',
  }),
  rule({
    rule_id: 'F3', dimension: 'F3', kind: 'foundation', title: 'Establish appropriate opportunity progression',
    triggers: { levels: ['weak', 'partial'] },
    required_evidence: ['F3 primary answer weak or partial', 'A cause (no process, no reminder, unclear owner)', 'A consequence (lost valuations, late)'],
    commercial_consequence: 'Not-yet-ready sellers get no defined next step, so the valuation goes to whoever is in front of them when they are ready.',
    intervention: 'An agreed next-action workflow for every seller opportunity: who owns it, when it is next touched, and what "done" means — with NOVUS creating and dating the actions from the recorded selling situation.',
    implementation_steps: [
      'Agree the action ladder for a seller opportunity (e.g. 2 weeks, 6 weeks, month-before-timeframe).',
      'Agree ownership rules (branch, negotiator, valuer).',
      'Configure NOVUS to create dated next actions from the selling situation and timeframe.',
      'Daily list per owner of what is due.',
    ],
    required_data_access: ['The recorded selling situation and timeframe (F1 or existing)', 'A place the team see their due actions (CRM tasks or the NOVUS list)'],
    agency_responsibilities: ['Agree the ladder and ownership', 'Work the daily list'],
    novus_responsibilities: ['Create and date actions', 'Daily due list'],
    dependencies: [{ dimension: 'F1', need: 'A recorded selling situation and timeframe to act on' }],
    measurement: ['Share of seller opportunities with a dated next action', 'Valuations booked from progressed opportunities'],
    scope_limitations: ['NOVUS schedules and surfaces the work; the team still do it', 'No promise of a specific number of valuations'],
    pitch_explanation: 'Every "not yet" seller would get a dated next step with a named owner, created from what they told you, so the September sellers you hear about in June are still yours in September.',
    spoken_change: 'give every not-yet seller a dated next step with a named owner',
    plan_phrase: 'the follow-up ladder and owners agreed, dated actions created from what sellers said',
    delivery_status: 'SUPPORTED_CONFIGURATION',
    delivery_status_note: 'Action creation and due lists exist; the ladder and ownership are configured per agency.',
  }),
  rule({
    rule_id: 'F4', dimension: 'F4', kind: 'foundation', title: 'Establish action ownership and accountability',
    triggers: { levels: ['weak', 'partial'] },
    required_evidence: ['F4 primary answer weak or partial', 'A cause (no overdue view, unclear ownership, ignored tasks)', 'A consequence'],
    commercial_consequence: 'Follow-ups that do not happen are invisible, so missed sellers are only discovered when they list with someone else.',
    intervention: 'Ownership, completion tracking and exception handling: every action has an owner, overdue actions are surfaced daily, and the owner sees a weekly exception view rather than having to ask.',
    implementation_steps: [
      'Agree owners and the overdue threshold.',
      'Configure the overdue/exception view (daily to negotiators, weekly to the owner).',
      'Agree what happens to an action that is overdue by more than the threshold (reassign, escalate).',
    ],
    required_data_access: ['The action list (F3 or existing CRM tasks with owners and due dates)'],
    agency_responsibilities: ['Review the weekly exception view', 'Act on escalations'],
    novus_responsibilities: ['Overdue detection', 'Exception view', 'Completion tracking'],
    dependencies: [{ dimension: 'F3', need: 'Dated, owned actions to track' }],
    measurement: ['Overdue actions per week (trend)', 'Completion rate within the agreed threshold'],
    scope_limitations: ['Makes gaps visible; does not manage people', 'Cannot track actions that live only in a negotiator\'s head'],
    pitch_explanation: 'You\'d see, without asking, which follow-ups didn\'t happen — a short overdue list each morning for the team and a weekly exception view for you.',
    spoken_change: 'surface the follow-ups that didn\'t happen before they\'re lost',
    plan_phrase: 'the daily overdue list and weekly exception view switched on',
    delivery_status: 'SUPPORTED_CONFIGURATION',
    delivery_status_note: 'Overdue and exception views exist; owners and thresholds are configured per agency.',
  }),
  rule({
    rule_id: 'F5', dimension: 'F5', kind: 'foundation', title: 'Establish commercial outcome tracking',
    triggers: { levels: ['weak', 'partial'] },
    required_evidence: ['F5 primary answer weak or partial', 'A cause (no stages, reporting, not recorded)', 'A consequence'],
    commercial_consequence: 'Nobody can see which opportunities became valuations and instructions, so nothing can be judged, managed or improved — including this pilot.',
    intervention: 'A simple, structured progression for seller opportunities (identified → contacted → valuation booked → valuation done → instructed / lost) with the source recorded, so outcomes can be counted.',
    implementation_steps: [
      'Agree the stages and what moves an opportunity between them.',
      'Agree how valuations and instructions are confirmed (CRM status, or a weekly confirmation from the agency).',
      'Configure NOVUS to hold the progression and produce the weekly outcome view.',
    ],
    required_data_access: ['Valuation and instruction confirmations (CRM export, or weekly agency confirmation)'],
    agency_responsibilities: ['Confirm valuations and instructions weekly if the CRM cannot provide them'],
    novus_responsibilities: ['Hold the progression', 'Weekly outcome view', 'Baseline and pilot comparison'],
    measurement: ['Opportunities by stage', 'Valuations and instructions attributed to a source'],
    scope_limitations: ['Attribution is only as good as the confirmations provided', 'Not a replacement for CRM reporting'],
    pitch_explanation: 'We\'d put a simple progression on every seller opportunity so that, for the first time, you can see how many turned into valuations and instructions — and where they came from. It\'s also how we\'d measure the pilot honestly.',
    spoken_change: 'track every seller opportunity through to valuation and instruction',
    plan_phrase: 'a simple seller-opportunity progression with valuations and instructions confirmed weekly',
    delivery_status: 'SUPPORTED_CONFIGURATION',
    delivery_status_note: 'Progression and outcome views exist; the confirmation route is agreed per agency.',
  }),

  // ── INTELLIGENCE ────────────────────────────────────────────────────────
  rule({
    rule_id: 'I1', dimension: 'I1', kind: 'intelligence', title: 'Seller signal recognition across incoming demand',
    triggers: { levels: ['weak', 'partial'] },
    required_evidence: ['I1 primary answer weak or partial', 'A cause', 'A consequence (lost valuations, competitor wins)', 'Meaningful incoming enquiry volume (C4)'],
    commercial_consequence: 'Buyers who mention a property to sell are the warmest valuation opportunities an agency receives, and they are being missed or left to chance.',
    intervention: 'NOVUS reads incoming enquiries (portal leads, web forms, logged calls) for seller signals — a property to sell, a chain, a timeframe — checks whether that person is already being progressed, and raises a valuation opportunity with a dated action when they are not.',
    implementation_steps: [
      'Connect the incoming enquiry feed (portal lead emails or CRM enquiry export).',
      'Configure the seller-signal recognition for the agency\'s area and wording.',
      'Agree what happens when a signal is found: who is told, what the first action is, by when.',
      'Run in shadow for the first week (surface only), then live.',
    ],
    required_data_access: ['Incoming enquiry feed', 'Ability to check whether the person is already an opportunity (F2 context, or the CRM)'],
    agency_responsibilities: ['Provide the feed', 'Act on raised opportunities'],
    novus_responsibilities: ['Recognition', 'De-duplication against existing opportunities', 'Raising the action'],
    dependencies: [
      { dimension: 'F3', need: 'An agreed next-action workflow so a found signal goes somewhere' },
      { dimension: 'F1', need: 'A recorded selling situation so found signals persist', soft: true },
    ],
    answer_conditions: [{ question: 'C4', min: 30, effect: 'ASSESS', note: 'Incoming enquiry volume looks low for this to be the lead workflow — confirm the number' }],
    measurement: ['Seller signals recognised per month', 'Share progressed to a valuation booking', 'Signals that were not already in the CRM'],
    scope_limitations: ['Only as good as the enquiry feed provided', 'Recognises signals in text; does not listen to unrecorded calls'],
    pitch_explanation: 'NOVUS would read every enquiry that comes in for the ones that mention a property to sell, check whether you\'re already on it, and raise it with a dated action when you\'re not — so those warm sellers stop depending on who picked up the phone.',
    spoken_change: 'read every incoming enquiry for buyers who\'ve also got somewhere to sell',
    plan_phrase: 'seller-signal recognition running on the incoming enquiry feed',
    delivery_status: 'SUPPORTED_CONFIGURATION',
    delivery_status_note: 'Seller-signal recognition on enquiry text is in use inside NOVUS today; the agency\'s inbound feed and routing are configured per pilot.',
  }),
  rule({
    rule_id: 'I2', dimension: 'I2', kind: 'intelligence', title: 'Cross-interaction opportunity identification',
    triggers: { levels: ['weak', 'partial'] },
    required_evidence: ['I2 primary answer weak or partial', 'A cause', 'A consequence (missed reactivation)', 'Customers can be matched across records (I2_matching not "no")'],
    commercial_consequence: 'A past valuation that starts buying again, or an old applicant who now mentions selling, is a change of circumstances nobody notices — and those are among the likeliest instructions.',
    intervention: 'Connect a customer\'s accessible history with their current activity and flag commercially relevant changes: a past valuation enquiring again, a buyer whose timeframe has arrived, a seller who went quiet and is back.',
    implementation_steps: [
      'Establish the matching rule (with F2).',
      'Agree the changes that matter (e.g. past valuation → new enquiry; timeframe reached; renewed activity).',
      'Configure the flags and where they surface, with a dated action.',
    ],
    required_data_access: ['Accessible customer records with identifiers', 'Current activity (enquiries, viewings, or CRM activity export)'],
    agency_responsibilities: ['Provide records and current activity', 'Act on flags'],
    novus_responsibilities: ['Matching', 'Change detection', 'Raising the action'],
    dependencies: [
      { dimension: 'F2', need: 'Usable customer records and reliable matching' },
      { dimension: 'F3', need: 'A next-action workflow for a flagged change' },
    ],
    answer_conditions: [
      { question: 'C7', not: ['blocked'], effect: 'INFEASIBLE', note: 'Historical records are not accessible', unless: { question: 'C7_block', any: ['nobody_knows_how'], note: 'Export is "not worked out" rather than blocked — confirm the route with the CRM provider' } },
      { question: 'C7', not: ['unsure', 'unknown'], effect: 'ASSESS', note: 'Confirm CRM export/access first' },
      { question: 'I2_matching', not: ['no'], effect: 'ASSESS', note: 'Heavy duplication — matching must be assessed before any connection work' },
    ],
    measurement: ['Changes flagged per month', 'Share that led to a conversation and a valuation booking'],
    scope_limitations: ['Only across records that can be accessed and matched', 'Does not de-duplicate the CRM itself'],
    pitch_explanation: 'We\'d connect what a customer did before with what they\'re doing now — so a valuation from last year that starts booking viewings gets flagged to you the day it happens, not never.',
    spoken_change: 'flag past valuations and applicants the moment their circumstances change',
    plan_phrase: 'change-of-circumstance flags on past valuations and applicants',
    delivery_status: 'REQUIRES_ASSESSMENT',
    delivery_status_note: 'Feasibility depends on matching quality and CRM access; assessed in days 1–3.',
  }),
  rule({
    rule_id: 'I3', dimension: 'I3', kind: 'intelligence', title: 'Historical database opportunity identification',
    triggers: { levels: ['weak', 'partial'] },
    required_evidence: ['I3 primary answer weak or partial', 'Accessible historical records (I3_history not "elsewhere")', 'A consequence', 'A database of meaningful size (C5)'],
    commercial_consequence: 'Thousands of past applicants, valuations and enquiries contain people whose circumstances have moved on, and no one is going back to them systematically.',
    intervention: 'Analyse suitable segments of the historical database — past valuations that never listed, applicants who bought elsewhere a few years ago, sellers who paused — and produce a worked list of worthwhile valuation opportunities with a reason for each.',
    implementation_steps: [
      'Export the historical records (or connect access).',
      'Assess quality: identifiers, duplication, recency.',
      'Agree the segments to work first and the rules that put someone on the list.',
      'Produce the first prioritised list with reasons; team work it through F3/F4.',
    ],
    required_data_access: ['CRM export of applicants, valuations, enquiries with dates and contact details', 'Confirmation of who must not be contacted'],
    agency_responsibilities: ['Provide the export', 'Confirm suppression rules', 'Work the list'],
    novus_responsibilities: ['Quality assessment', 'Segmentation', 'Prioritised list with reasons'],
    dependencies: [
      { dimension: 'F3', need: 'A workflow to progress listed opportunities' },
      { dimension: 'F5', need: 'Outcome tracking so the list can be judged', soft: true },
    ],
    answer_conditions: [
      { question: 'C7', not: ['blocked'], effect: 'INFEASIBLE', note: 'Historical records cannot be exported', unless: { question: 'C7_block', any: ['nobody_knows_how'], note: 'Export is "not worked out" rather than blocked — confirm the route with the CRM provider' } },
      { question: 'C7', not: ['unsure', 'unknown'], effect: 'ASSESS', note: 'Confirm export route first' },
      { question: 'I3_history', not: ['elsewhere'], effect: 'INFEASIBLE', note: 'Usable history is mostly outside the CRM — no database to work within the pilot' },
      { question: 'I3_quality', not: ['messy'], effect: 'ASSESS', note: 'Data quality needs assessing before a list can be trusted' },
      { question: 'C5', min: 500, effect: 'ASSESS', note: 'Database looks small for this to carry the pilot — confirm the size' },
    ],
    measurement: ['Opportunities identified and worked', 'Valuations booked from the list', 'Instructions from the list'],
    scope_limitations: ['Not a database clean-up or migration', 'Does not contact anyone itself', 'Depends on the export'],
    pitch_explanation: 'We\'d go through the database you already own — the valuations that never listed, the applicants from a couple of years back — and hand your team a short, reasoned list of who is worth a call now, rather than a list of everyone.',
    spoken_change: 'work through the database you already own for the people worth a call now',
    plan_phrase: 'the first prioritised list from the historical database, with reasons',
    delivery_status: 'REQUIRES_ASSESSMENT',
    delivery_status_note: 'Depends on export and data quality; assessed in days 1–3.',
  }),
  rule({
    rule_id: 'I4', dimension: 'I4', kind: 'intelligence', title: 'Commercial opportunity prioritisation',
    triggers: { levels: ['weak', 'partial'] },
    required_evidence: ['I4 primary answer weak or partial', 'A cause', 'A consequence', 'A source of opportunities to prioritise (I1/I3 selected, or an existing worked list)'],
    commercial_consequence: 'The team\'s time goes on whoever is next on the list rather than whoever is most likely to instruct, so ready sellers wait behind people who were never going to move.',
    intervention: 'Order the opportunities the team work by circumstance, intent, activity and commercial relevance — with the reason shown — so the daily list starts with the people most likely to instruct.',
    implementation_steps: [
      'Agree the factors that matter for this agency (timeframe, property to sell, recent activity, source).',
      'Configure the ordering and the reason shown against each opportunity.',
      'Review the order with the team after two weeks and adjust.',
    ],
    required_data_access: ['The opportunity list (from I1, I3, F3 or an existing list)', 'Activity signals where available'],
    agency_responsibilities: ['Agree the factors', 'Work the list in order'],
    novus_responsibilities: ['Ordering', 'Reasons', 'Review'],
    dependencies: [
      { dimension: 'F3', need: 'A worked opportunity list to order' },
      { any_of_rules: ['I1', 'I3'], need: 'A source of opportunities', soft: true },
    ],
    measurement: ['Conversations per valuation booked (before vs during)', 'Share of valuations from the top of the list'],
    scope_limitations: ['Ordering is only as good as the information recorded (F1)', 'Not a predictive model on day one'],
    pitch_explanation: 'Rather than working the list top to bottom, your team would start each day with the people most likely to instruct, and see why — timeframe, property to sell, recent activity — next to each name.',
    spoken_change: 'start each day with the people most likely to instruct, and why',
    plan_phrase: 'the daily list ordered by likelihood to instruct',
    delivery_status: 'SUPPORTED_CONFIGURATION',
    delivery_status_note: 'Prioritised queues with reasons exist; the factors are configured per agency.',
  }),
  rule({
    rule_id: 'I5', dimension: 'I5', kind: 'intelligence', title: 'Outcome-based improvement',
    triggers: { levels: ['weak', 'partial'] },
    required_evidence: ['I5 primary answer weak or partial', 'Meaningful recorded outcomes (F5 strong, or F5 selected)'],
    commercial_consequence: 'What actually produces valuations never changes what the team does next, so effort stays where habit put it.',
    intervention: 'Use recorded outcomes — which sources, segments and timings produced valuations and instructions — to adjust what is identified and prioritised, and tell the owner what to do more of.',
    implementation_steps: [
      'Ensure outcomes are being recorded (F5).',
      'Monthly outcome review: what produced valuations, what did not.',
      'Adjust segments and prioritisation factors on the evidence.',
    ],
    required_data_access: ['Recorded outcomes with sources (F5)'],
    agency_responsibilities: ['Confirm outcomes', 'Take part in the monthly review'],
    novus_responsibilities: ['Outcome analysis', 'Adjustments', 'Written recommendation'],
    dependencies: [{ dimension: 'F5', need: 'Meaningful recorded outcomes to learn from' }],
    measurement: ['Change in conversations-per-valuation after adjustments', 'Owner-confirmed changes in focus'],
    scope_limitations: ['Within 60 days the outcome volume is usually small — expect a first review, not a learning system', 'Included as measurement design in the pilot; automated adjustment is not yet implemented'],
    pitch_explanation: 'By the end of the sixty days you\'d know what actually produced valuations — and the plan for what to do more of would come from that, not from a hunch.',
    spoken_change: 'use what actually produced valuations to decide what to do more of',
    plan_phrase: 'the first outcome review and a written recommendation',
    delivery_status: 'PROPOSED',
    delivery_status_note: 'Automated learning is not implemented; the pilot delivers the outcome review and recommendation only.',
  }),
]);

export const RULE_BY_ID = Object.freeze(Object.fromEntries(RULES.map((r) => [r.rule_id, r])));

// The 60-day plan phases. Populated per session by the engine.
export const PLAN_PHASES = Object.freeze([
  { id: 'p1', days: '1–3', title: 'Validate findings, establish scope, access and baseline' },
  { id: 'p2', days: '4–7', title: 'Establish necessary foundations' },
  { id: 'p3', days: '8–14', title: 'Activate the first agreed NOVUS intelligence workflow' },
  { id: 'p4', days: '15–30', title: 'Expand and refine where feasible' },
  { id: 'p5', days: '31–60', title: 'Continue progression, review outcomes and evaluate commercial value' },
]);
