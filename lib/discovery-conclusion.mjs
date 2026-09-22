// lib/discovery-conclusion.mjs — the MEETING CONCLUSION: what Joe walks the
// owner through after discovery, built deterministically from the stored
// answers and the diagnosis. No model is needed for any of it; the optional
// polish step (polishConclusion) may only reword sentences this file already
// wrote, and every polished sentence is validated and falls back to the
// deterministic one.
//
//   Discovery → agree understanding → commercial opportunity → personalised
//   NOVUS solution → what we'd need from them → personalised 60-day
//   deployment → confirm understanding and implementation interest →
//   £1,500 founding pilot → decision
//
//   buildFindings(base)                       the two or three grouped problems,
//                                             from the owner's own answers
//   agreementOverrides(agreement, findings)   what an owner's correction does to
//                                             the diagnosis (never to the answers)
//   buildProject(agreed, situation)           ONE primary commercial project —
//                                             the seven focus areas only rank
//                                             which project; the project drives
//                                             the client slide, the private
//                                             guidance, the roadmap and the scope
//   buildDeployment(agreed, project, …)       the four phases, from its components
//   buildCheckpoint(state, …)                 the PRIVATE pre-price checkpoint
//   buildConclusion({ session, base, agreed, conclusion })
//                                             the whole conclusion object
//   presentationPayload(conclusion)           the seven client-facing screens —
//                                             no ids, codes, notes or controls
//   polishConclusion / validatePolish         optional AI wording, validated
//
// TWO DIAGNOSES. `base` is the engine over the operator's answers and
// overrides; `agreed` is the same engine with the owner's corrections applied
// as recorded overrides. Findings are reflected from `base` (so a rejected
// finding still shows as "rejected" instead of vanishing); interventions,
// deployment and scope come from `agreed`.

import { RULE_BY_ID, FOUNDING_OFFER, DELIVERY_STATUSES } from './discovery-rules.mjs';
import { buildPlan } from './discovery-engine.mjs';
import { THEMES, PLAN_PHASES_COMPACT, wordCount } from './discovery-pitch.mjs';
import { callAi } from './ai-client.mjs';

const text = (value) => String(value ?? '').trim();
const lower = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const firstName = (name) => text(name).split(/\s+/)[0] || '';
function join(items, conj = 'and') {
  const list = items.filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} ${conj} ${list[list.length - 1]}`;
}
const gbp = (n) => `£${Math.round(Number(n || 0)).toLocaleString('en-GB')}`;

export const CONCLUSION_STEPS = Object.freeze([
  { id: 'today', title: 'Your agency today', nav: 'Today', blurb: 'Their situation in their own numbers' },
  { id: 'established', title: 'What we\'ve established', nav: 'Established', blurb: 'The two or three problems, and their agreement' },
  { id: 'opportunity', title: 'The commercial opportunity', nav: 'Opportunity', blurb: 'Their fee, their conversion, illustrative additional valuations' },
  { id: 'help', title: 'The project we\'d propose', nav: 'Project', blurb: 'One personalised commercial project, its components, and the private guidance behind it' },
  { id: 'needs', title: 'What we\'d need from you', nav: 'Needs', blurb: 'Access, a short setup, acting on opportunities' },
  { id: 'deployment', title: 'Your first 60 days', nav: '60 days', blurb: 'Four phases generated from the project\'s components, with the implementation tasks underneath' },
  { id: 'checkpoint', title: 'Understanding & interest', nav: 'Checkpoint', private: true, blurb: 'PRIVATE — does it make sense, and do they want it? Before any price' },
  { id: 'pilot', title: 'The founding pilot', nav: 'Pilot', blurb: '£1,500 all-in for sixty days, scope and closing guidance' },
]);
export const AGREEMENT_STATUSES = Object.freeze(['AGREED', 'CORRECTED', 'REJECTED']);
export const ADDITIONAL_VALUATIONS_RANGE = Object.freeze([1, 2, 3, 4, 5]);
export const DEFAULT_ADDITIONAL_VALUATIONS = 2;

// Owner-facing wording for each finding group and each dimension gap — plain
// estate-agency language, second person, no rule ids. The group titles are
// what the presentation shows; the gap phrases are what "we understood".
export const FINDING_GROUPS = Object.freeze(THEMES.map((theme) => ({
  id: theme.id, rules: theme.rules, value: theme.value,
  title: { capture: 'Selling information your team hear gets lost', progress: 'Sellers slip through between now and when they are ready', opportunities: 'Valuation opportunities already in your demand are not being found', measure: 'You cannot see what is actually working' }[theme.id],
  short: { capture: 'Selling information gets lost', progress: 'Sellers slip through', opportunities: 'Opportunities go unfound', measure: 'Results are invisible' }[theme.id],
})));
export const GAP_PHRASES = Object.freeze({
  F1: 'what your team hear about selling is not reliably recorded',
  F2: 'whoever picks up the phone cannot easily see what a customer has said before',
  F3: 'a seller who is not ready yet does not get a defined next step',
  F4: 'follow-ups that do not happen go unnoticed',
  F5: 'you cannot see which opportunities became valuations and instructions',
  I1: 'buyers who mention a property to sell are not systematically picked up',
  I2: 'a customer\'s past history and current activity are not connected, so a change of circumstances goes unnoticed',
  I3: 'the database you already own is not being worked for valuation opportunities',
  I4: 'the team\'s time goes on whoever is next on the list rather than whoever is most likely to instruct',
  I5: 'what actually produces valuations does not change what the team does next',
});
// Owner-facing short names for the rules, used wherever an internal id would
// otherwise reach the client (plan sentences name rules by id).
export const RULE_SHORT_NAMES = Object.freeze({
  F1: 'capture', F2: 'customer history', F3: 'next actions', F4: 'accountability', F5: 'outcome tracking',
  I1: 'seller signals', I2: 'change-of-circumstance flags', I3: 'the database list', I4: 'prioritisation', I5: 'the outcome review',
});
export const GROUP_SOLUTION_HEADINGS = Object.freeze({ capture: 'Capture what your team hear', progress: 'Progress every seller', opportunities: 'Find the sellers already in your demand', measure: 'Measure what works' });
export const GROUP_NOUNS = Object.freeze({ capture: 'capturing what your team hear', progress: 'progressing every seller', opportunities: 'finding the opportunities already in your demand', measure: 'measuring what works' });
export function clientSafe(value) {
  return text(value).replace(/^[FI][1-5]:\s*/, '').replace(/\b(?:Activate|Add)\s+([FI][1-5])\s+/g, '$1 ').replace(/\b([FI][1-5])\b/g, (id) => RULE_SHORT_NAMES[id] || id);
}
const COMMERCIAL_CONSEQUENCES = new Set(['missed_sellers', 'lost_valuations', 'competitor_wins', 'missed_reactivation', 'missed_ready', 'untouched_value', 'missed_context', 'late']);

// ── the seven internal COMMERCIAL FOCUS AREAS ─────────────────────────────
// Internal diagnostic categories — not products and not client slides. They
// are scored on the AGREED diagnosis by commercial meaning (the owner's
// objective, the consequences established, the evidence behind them, the
// incremental value beyond what already works and delivery feasibility) and
// the ranking decides which ONE primary project this agency gets (see
// buildProject below). They never become headline cards of their own.
export const FOCUS_AREAS = Object.freeze([
  {
    id: 'foundations', order: 1, dims: ['F1', 'F2'],
    name: 'Operational foundations',
    internal: 'Get the necessary information and processes in place.',
    heading: 'Get the right foundations in place',
    short: 'the foundations',
    plan_phrase: 'getting the selling information captured and usable',
    effect: 'so nothing else we do depends on memory or on who happened to take the call',
  },
  {
    id: 'enquiry_intelligence', order: 2, dims: ['I1'],
    name: 'Incoming enquiry intelligence',
    internal: 'Recognise additional seller opportunities in new enquiries.',
    heading: 'Spot the sellers in your incoming enquiries',
    short: 'your incoming enquiries',
    plan_phrase: 'reading every incoming enquiry for sellers',
    effect: 'so more of the sellers already contacting you get found',
  },
  {
    id: 'database_intelligence', order: 3, dims: ['I3'],
    name: 'Historical database intelligence',
    internal: 'Find valuation opportunities in existing customer records.',
    heading: 'Unlock opportunities in your existing database',
    short: 'your existing database',
    plan_phrase: 'working the database for the people worth a call now',
    effect: 'so the value already sitting in your own records gets worked',
  },
  {
    id: 'connecting_activity', order: 4, dims: ['I2'],
    name: 'Connecting customer activity',
    internal: 'Recognise commercially relevant changes using customer history and new activity.',
    heading: 'Connect previous history with new activity',
    short: 'connecting history with new activity',
    plan_phrase: 'connecting past history with what customers are doing now',
    effect: 'so a change in someone\'s circumstances gets noticed while it still matters',
  },
  {
    id: 'progression', order: 5, dims: ['F3', 'F4'],
    name: 'Opportunity progression',
    internal: 'Ensure identified opportunities are acted upon appropriately.',
    heading: 'Make sure every opportunity gets followed through',
    short: 'following opportunities through',
    plan_phrase: 'dated next steps on every opportunity, with nothing going quiet',
    effect: 'so the sellers who aren\'t ready yet are still yours when they are',
  },
  {
    id: 'prioritisation', order: 6, dims: ['I4'],
    name: 'Commercial prioritisation',
    internal: 'Help the team focus on the most relevant opportunities.',
    heading: 'Focus the team on the opportunities that matter most',
    short: 'prioritising the day',
    plan_phrase: 'the daily list ordered by who is most likely to instruct',
    effect: 'so the team\'s time goes to whoever is most likely to instruct',
  },
  {
    id: 'measurement', order: 7, dims: ['F5', 'I5'],
    name: 'Commercial measurement & improvement',
    internal: 'Understand what generates valuations and instructions, and use outcomes to improve decisions.',
    heading: 'See what actually produces valuations',
    short: 'measuring the outcomes',
    plan_phrase: 'tracking what turns into valuations and instructions',
    effect: 'so you can see what is working and decide on evidence rather than impression',
  },
]);
export const FOCUS_BY_ID = Object.freeze(Object.fromEntries(FOCUS_AREAS.map((a) => [a.id, a])));
export const FOCUS_BY_DIM = Object.freeze(Object.fromEntries(FOCUS_AREAS.flatMap((a) => a.dims.map((d) => [d, a.id]))));

// An area is COMMERCIALLY MEANINGFUL at or above this score — used to
// decide what is worth recording as future scope beyond the project.
export const FOCUS_MEANINGFUL_SCORE = 3;
const condClause = (cond) => lower(clientSafe(cond)).replace(/^confirm(?:ing)?\s+/, '').replace(/\.$/, '');

// What makes an area commercially meaningful for THIS agency. Nothing here
// reads the diagnostic level on its own: an area only scores through the
// evidence behind it, the consequence the owner established, what it adds
// beyond what already works, and whether it can actually be delivered.
function scoreFocusArea(area, agreed, situation) {
  const selected = agreed.interventions.filter((i) => i.selected && area.dims.includes(i.rule_id));
  if (!selected.length) return null;
  const priority = situation.objective.priority;
  const obstacles = new Set(agreed.objective.obstacles.map((o) => o.value));
  let score = 0;
  const why = [];
  // Scored per rule and averaged: a two-dimension area is not worth twice a
  // one-dimension area simply for covering two dimensions.
  for (const item of selected) {
    const a = agreed.assessments[item.dimension];
    score += 1;
    // the owner's agreed discovery findings + supporting evidence
    if (item.confidence === 'CONFIRMED') { score += 1.5; why.push(`${item.dimension} is established with a cause and a consequence`); }
    else if (item.confidence === 'PROVISIONAL') score += 0.5;
    // the commercial consequences established
    if (a?.consequences?.some((c) => COMMERCIAL_CONSEQUENCES.has(c.value))) { score += 1; why.push(`${item.dimension} costs them: ${a.consequences.map((c) => lower(c.label)).join(', ')}`); }
    if (a?.frequency === 'daily' || a?.frequency === 'constantly') score += 0.5;
    if (a?.example) score += 0.25;
    // delivery feasibility and dependencies
    if (item.feasibility === 'FEASIBLE') score += 1;
    else if (item.feasibility === 'FEASIBLE_WITH_FOUNDATION') score += 0.5;
    else score -= 1;
    if (['IMPLEMENTED', 'SUPPORTED_CONFIGURATION'].includes(item.delivery_status)) score += 0.25;
  }
  score = score / selected.length;
  // incremental value beyond the existing process: an area where part of
  // the capability already works effectively is worth less as a headline.
  const strengths = area.dims.filter((d) => agreed.assessments[d]?.evidence_status === 'EXISTING_STRENGTH');
  score -= strengths.length;
  // their commercial objective
  const OBJECTIVE = {
    more_valuations: { enquiry_intelligence: 1.5, database_intelligence: 1.5, connecting_activity: 1 },
    // Winning more instructions overall: the work is progressing and
    // converting the opportunities, not only finding more of them.
    more_instructions: { progression: 1, foundations: 0.5, prioritisation: 0.5, measurement: 0.5 },
    // More buyer demand: the seller opportunities sit inside that demand.
    more_buyer_demand: { enquiry_intelligence: 1.5, connecting_activity: 1, database_intelligence: 1 },
    win_instructions: { progression: 1, foundations: 0.5, prioritisation: 0.5 },
    capacity: { prioritisation: 1, progression: 0.5 },
    fees: { measurement: 0.5, progression: 0.5 },
  };
  const OBSTACLE = {
    not_enough_opportunities: { enquiry_intelligence: 1, database_intelligence: 1, connecting_activity: 1 },
    slipping_through: { progression: 1.5, foundations: 0.5 },
    database: { database_intelligence: 1.5, connecting_activity: 0.5 },
    losing_to_competitors: { progression: 0.5, enquiry_intelligence: 0.5, foundations: 0.5 },
    team_time: { prioritisation: 0.5, progression: 0.5 },
  };
  const objectiveBonus = OBJECTIVE[priority]?.[area.id] || 0;
  if (objectiveBonus) { score += objectiveBonus; why.push(`their stated objective is ${lower(situation.objective.priority_label)}`); }
  for (const value of obstacles) {
    const bonus = OBSTACLE[value]?.[area.id] || 0;
    if (bonus) { score += bonus; why.push(`they named this as what is in the way`); break; }
  }
  // FOUNDATIONS are a headline only when the intelligence work genuinely
  // needs them: a foundation nobody depends on is delivery detail, not a
  // commercial focus area worth a card.
  if (area.id === 'foundations') {
    const enabling = agreed.interventions.some((i) => i.selected && !area.dims.includes(i.rule_id)
      && i.dependencies.some((d) => area.dims.includes(d.dimension) && ['provided', 'added'].includes(d.resolution)));
    if (enabling) { score += 1.5; why.push('the intelligence work cannot run until this is in place'); }
    else score -= 1;
  }
  // MEASUREMENT is in every pilot regardless (it is how NOVUS is
  // evaluated), so it only earns a headline card when the agency's own
  // measurement is a real commercial weakness in its own right.
  if (area.id === 'measurement') {
    const realWeakness = selected.some((i) => i.confidence === 'CONFIRMED'
      && agreed.assessments[i.dimension]?.consequences?.some((c) => COMMERCIAL_CONSEQUENCES.has(c.value) || c.value === 'keep_failing' || c.value === 'drop_working'));
    if (realWeakness) { score += 0.5; why.push('their own measurement is a commercial weakness, not just our evaluation'); }
    else score -= 1.5;
  }
  return { area, selected, score: Math.round(score * 10) / 10, why: [...new Set(why)], strengths };
}

// ── the PRIMARY COMMERCIAL PROJECT ────────────────────────────────────────
// One commercial objective → one personalised project → the work needed to
// deliver it → a 60-day pilot to prove its value. The seven focus areas
// above are scored as before, but only to decide WHICH project this agency
// gets: the highest-scoring intelligence/progression area is the anchor, the
// anchor sets the project type, and the project's implementation components
// are generated from the selected rules that belong to that type. Selected
// rules outside the type are kept as future scope, never pitched. Foundations
// are supporting setup — only where a project component genuinely depends on
// them — unless fixing the foundations IS the project.
const COMPONENT_DEFS = Object.freeze({
  find_database: { label: 'Recover existing opportunities', rules: ['I3'], stage: 'identify', heading: 'Find existing opportunities', plan_heading: 'Start finding existing opportunities', plan_phrase: 'identifying the first historical contacts and previous valuations worth approaching again' },
  find_enquiries: { label: 'Find sellers in new demand', rules: ['I1'], stage: 'identify', heading: 'Spot the sellers in new enquiries', plan_heading: 'Start spotting the sellers in new enquiries', plan_phrase: 'reading every incoming enquiry for buyers who also have a property to sell' },
  recognise: { label: 'Identify new opportunities', rules: ['I2'], stage: 'identify', heading: 'Recognise new opportunities', plan_heading: 'Start recognising renewed activity', plan_phrase: 'recognising when existing contacts show new activity and may be back in the market' },
  recognise_enquiries: { label: 'Connect returning customers', rules: ['I2'], stage: 'identify', heading: 'Recognise returning customers', plan_heading: 'Start recognising returning customers', plan_phrase: 'connecting new enquiries with what you already hold on the customer' },
  business: { label: 'Generate commercial results', rules: ['F3', 'F4', 'I4', 'F5', 'I5'], stage: 'progress', heading: 'Turn opportunities into business', plan_heading: 'Progress the opportunities', plan_phrase: 'getting the opportunities to your team and following them through' },
  next_steps: { label: 'Follow every opportunity through', rules: ['F3', 'F4'], stage: 'identify', heading: 'Give every opportunity a next step', plan_heading: 'Put a next step on every opportunity', plan_phrase: 'a dated next step with a named owner on every seller who isn\'t ready yet' },
  prioritise: { label: 'Focus the team\'s time', rules: ['I4'], stage: 'identify', heading: 'Start with the likeliest to instruct', plan_heading: 'Order the day by likelihood to instruct', plan_phrase: 'ordering the team\'s day by who is most likely to instruct' },
  track: { label: 'Measure what converts', rules: ['F5', 'I5'], stage: 'progress', heading: 'Track what turns into business', plan_heading: 'Track what turns into business', plan_phrase: 'tracking every opportunity through to valuation and instruction' },
  track_outcomes: { label: 'Track every opportunity', rules: ['F5'], stage: 'identify', heading: 'Track every opportunity', plan_heading: 'Start tracking every opportunity', plan_phrase: 'recording every seller opportunity and following it through to valuation and instruction' },
  learn: { label: 'Learn what works', rules: ['I5'], stage: 'progress', heading: 'Learn what works', plan_heading: 'Review what works', plan_phrase: 'reviewing what actually produced valuations and instructions' },
  capture: { label: 'Capture selling information', rules: ['F1'], stage: 'identify', heading: 'Record what your team hear', plan_heading: 'Start recording what your team hear', plan_phrase: 'recording the selling situation on every conversation' },
  history: { label: 'Connect customer history', rules: ['F2'], stage: 'identify', heading: 'Put the history in one place', plan_heading: 'Put the customer history in one place', plan_phrase: 'bringing each customer\'s history into one place' },
});
// Titles are [verb, gerund, rest] so the same wording can head the slide
// and be spoken inside a sentence ("the project is generating more…").
export const PROJECT_TYPES = Object.freeze({
  existing_customers: {
    name: 'Existing-customer opportunities', components: ['find_database', 'recognise', 'business'],
    title: { more_valuations: ['Generate', 'generating', 'more valuations from the customers you already have'], more_instructions: ['Win', 'winning', 'more instructions from the customers you already have'], win_instructions: ['Win', 'winning', 'more instructions from the customers you already have'], _: ['Find', 'finding', 'the sellers among the customers you already have'] },
    effect: 'the value already sitting in your own customer records gets worked, continuously, rather than when someone has time',
  },
  incoming_demand: {
    name: 'Incoming demand opportunities', components: ['find_enquiries', 'recognise_enquiries', 'business'],
    title: { more_valuations: ['Generate', 'generating', 'more valuations from the enquiries you already get'], more_buyer_demand: ['Turn', 'turning', 'more of your buyer demand into valuation opportunities'], _: ['Find', 'finding', 'more of the sellers in your incoming enquiries'] },
    effect: 'more of the sellers who are already contacting you get recognised while they are still warm',
  },
  conversion: {
    name: 'Opportunity conversion', components: ['next_steps', 'prioritise', 'track'],
    title: { more_valuations: ['Turn', 'turning', 'more of the sellers you already hear about into valuations'], capacity: ['Put', 'putting', 'your team\'s time into the opportunities most likely to instruct'], _: ['Turn', 'turning', 'more of the sellers you already hear about into instructions'] },
    effect: 'the sellers you already hear about are still yours when they are ready',
  },
  visibility: {
    name: 'Commercial visibility', components: ['track_outcomes', 'learn', 'next_steps'],
    title: { _: ['See', 'seeing', 'exactly what produces your valuations and instructions'] },
    effect: 'you can see what is working and put more effort behind it, on evidence rather than impression',
  },
  capture: {
    name: 'Selling-information capture', components: ['capture', 'history', 'business'],
    title: { _: ['Stop', 'stopping', 'losing the sellers your team already hear about'] },
    effect: 'what your team hear about selling stops depending on memory or on who took the call',
  },
});
const ANCHOR_TYPE = Object.freeze({ database_intelligence: 'existing_customers', connecting_activity: 'existing_customers', enquiry_intelligence: 'incoming_demand', progression: 'conversion', prioritisation: 'conversion', measurement: 'visibility', foundations: 'capture' });
// What is still to be checked before a component is relied on, said plainly.
const HEDGES = Object.freeze({
  I1: 'once the enquiry feed is connected',
  I2: 'once we\'ve confirmed the records can be matched reliably',
  I3: 'once we\'ve checked what the export gives us',
  F2: 'once we\'ve confirmed what the CRM can export',
});
const IDENTIFY_RULES = new Set(['I1', 'I2', 'I3']);
const isFeasible = (item) => ['FEASIBLE', 'FEASIBLE_WITH_FOUNDATION'].includes(item.feasibility);

// The commercially meaningful heading and one explanatory sentence for a
// component, from THIS agency's figures, CRM, strengths and the components
// before it in the project (so the sequence reads as one piece of work).
// `hedge` is appended to the sentence by the caller when a rule still needs
// a check.
function componentCopy(id, sel, ctx, before) {
  const { crm, situation, strengths, outcomeNoun } = ctx;
  const has = (r) => sel.has(r);
  const n = (entry) => entry.display.replace(' a month', '');
  const inCrm = crm ? ` in ${crm}` : '';
  const after = (x) => before.includes(x);
  if (id === 'find_database') return {
    heading: situation.database_size.known ? `Find potential sellers within your ${n(situation.database_size)}` : 'Find potential sellers within your existing contacts',
    sentence: `Start with previous valuations and suitable existing customers${inCrm}, identifying people your team has a genuine reason to approach about selling`,
  };
  if (id === 'find_enquiries') return {
    heading: situation.enquiries_per_month.known ? `Spot the sellers within your ${n(situation.enquiries_per_month)} enquiries a month` : 'Spot the sellers within your incoming enquiries',
    sentence: 'Read each enquiry for buyers who also have a property to sell, check whether your team already know about it, and raise the ones that are new',
  };
  if (id === 'recognise') return {
    heading: after('find_database') ? 'Pick up when those customers come back into the market' : 'Pick up when existing customers come back into the market',
    sentence: `Use ${crm ? `${crm}'s` : 'your'} customer history and new activity to recognise renewed selling opportunities that might otherwise go unnoticed`,
  };
  if (id === 'recognise_enquiries') return {
    heading: 'Recognise the sellers you already know when they enquire again',
    sentence: `Connect each new enquiry with ${crm ? `what ${crm} already holds on that customer` : 'their previous history'}, so a returning seller is picked up straight away`,
  };
  if (id === 'business') {
    const work = has('F3') || has('F4') ? 'give each one a dated next step with a named owner'
      : strengths.has('F3') ? 'work them through your existing follow-up process' : 'work the opportunities with your team';
    return {
      heading: `Turn those opportunities into ${outcomeNoun === 'instructions' ? 'instructions' : 'valuation conversations'}`,
      sentence: `Put relevant contacts in front of your negotiators${has('I4') ? ', starting with those most likely to instruct' : ''}, ${work} and establish which become additional valuations and instructions`,
    };
  }
  if (id === 'next_steps') return {
    heading: has('F3') ? 'Give every seller who isn\'t ready yet a next step' : 'Catch the follow-ups that didn\'t happen',
    sentence: has('F3')
      ? `Every not-yet seller gets a dated next step with a named owner${has('F4') ? ', and any follow-up that didn\'t happen is flagged before the seller is lost' : ''}`
      : 'Flag the follow-ups that didn\'t happen, so a seller who isn\'t ready yet is still yours when they are',
  };
  if (id === 'prioritise') return {
    heading: 'Start each day with the people most likely to instruct',
    sentence: 'Order the opportunities by timeframe, property to sell and recent activity, with the reason shown, so your team\'s time goes where it counts',
  };
  if (id === 'track') return {
    heading: `See which opportunities become ${outcomeNoun}`,
    sentence: has('F5')
      ? `Track every opportunity through to valuation and instruction${has('I5') ? ', and use the results to decide what the team does more of' : ''}`
      : 'Review what actually produced valuations and instructions, and use it to decide what the team does more of',
  };
  if (id === 'track_outcomes') return {
    heading: 'Follow each seller opportunity through to instruction',
    sentence: `Record every seller opportunity${inCrm} with where it came from, and follow it through to valuation and instruction`,
  };
  if (id === 'learn') return {
    heading: 'Put more effort behind what actually produces business',
    sentence: 'Review each month which sources and actions produced valuations and instructions, and adjust where the team focuses',
  };
  if (id === 'capture') return {
    heading: 'Record what your team hear about selling',
    sentence: `Make sure every selling situation your team hear about is recorded${inCrm}, with a prompt when it's missing`,
  };
  if (id === 'history') return {
    heading: 'Put each customer\'s history in one place',
    sentence: 'Whoever picks up the phone can see what that customer has said and done before',
  };
  return { heading: COMPONENT_DEFS[id]?.heading || '', sentence: '' };
}

function projectTitle(type, priority) {
  const t = PROJECT_TYPES[type].title;
  const [verb, gerund, rest] = t[priority] || t._;
  return { title: `${verb} ${rest}.`, short: `${gerund} ${rest}` };
}

function projectDescription(type, ctx) {
  const { crm, outcomeNoun } = ctx;
  if (type === 'existing_customers') return `A focused 60-day project built around the potential sellers already in your ${crm ? `${crm} ` : ''}database, and an ongoing process to turn more of them into ${outcomeNoun}.`;
  if (type === 'incoming_demand') return `A focused 60-day project built around the sellers already contacting you, and an ongoing process to turn more of them into ${outcomeNoun}.`;
  if (type === 'conversion') return `A focused 60-day project built around the seller opportunities you already have, making sure more of them are followed through to ${outcomeNoun}.`;
  if (type === 'visibility') return 'A focused 60-day project to follow every seller opportunity through to valuation and instruction, so you can see what is working and put more effort behind it.';
  return 'A focused 60-day project to make sure what your team hear about selling is recorded and followed up, so fewer sellers slip away between conversations.';
}

// THE OBJECTIVE: the owner's ambition in their own words, or the objective
// they chose — never a number we supplied, never a promise.
const PILOT_TEST = 'establishing what additional business NOVUS can genuinely contribute during the pilot';
function projectObjective(situation) {
  const said = text(situation.objective.outcome?.text).replace(/[.!\s]+$/, '').slice(0, 160);
  if (said) return /^I\b/.test(said)
    ? `Work towards what you told me you want — "${said}" — ${PILOT_TEST}.`
    : `Work towards your ambition of ${lower(said)}, ${PILOT_TEST}.`;
  if (situation.objective.priority_label && situation.objective.priority !== 'other') return `Work towards ${lower(situation.objective.priority_label)}, ${PILOT_TEST}.`;
  return `${cap(PILOT_TEST)}.`;
}

function projectOngoing(type, ruleIds) {
  const ids = new Set(ruleIds);
  const identifies = [...ids].some((id) => IDENTIFY_RULES.has(id));
  const progresses = ['F3', 'F4', 'I4'].some((id) => ids.has(id));
  const parts = [
    identifies ? 'continues identifying relevant opportunities' : 'keeps every opportunity moving',
    progresses ? 'helping your team progress them' : 'passing them to your team to progress',
    'using the results to refine the approach',
  ];
  const lead = identifies ? `This isn't a one-off ${type === 'existing_customers' ? 'database clean-up or list' : 'exercise'}. ` : '';
  return `${lead}Once established, NOVUS ${parts[0]}, ${parts[1]} and ${parts[2]}.`;
}

// The ONE project for this agency, or null when nothing is proposed or no
// feasible component can be built — a project is never invented.
export function buildProject(agreed, situation) {
  if (!agreed.proposed.length) return null;
  const scored = FOCUS_AREAS.map((area) => scoreFocusArea(area, agreed, situation)).filter(Boolean)
    .sort((a, b) => b.score - a.score || a.area.order - b.area.order);
  if (!scored.length) return null;
  // The anchor: the strongest commercial area that is not foundations —
  // foundations only anchor when there is nothing else to build on.
  const anchor = scored.find((x) => x.area.id !== 'foundations') || scored[0];
  const type = ANCHOR_TYPE[anchor.area.id];
  const def = PROJECT_TYPES[type];
  const selected = new Map(agreed.interventions.filter((i) => i.selected).map((i) => [i.rule_id, i]));
  const strengths = new Set(Object.values(agreed.assessments).filter((a) => a.evidence_status === 'EXISTING_STRENGTH').map((a) => a.dimension));
  const ctx = { situation, crm: situation.crm.known ? situation.crm.display : '', strengths, outcomeNoun: ['more_instructions', 'win_instructions'].includes(situation.objective.priority) ? 'instructions' : 'valuations' };

  const components = [];
  for (const id of def.components) {
    const cd = COMPONENT_DEFS[id];
    const items = cd.rules.map((r) => selected.get(r)).filter(Boolean);
    if (!items.length) continue;
    const sel = new Set(items.map((i) => i.rule_id));
    const copy = componentCopy(id, sel, ctx, components.map((c) => c.id));
    let sentence = copy.sentence;
    const unsure = items.filter((i) => i.feasibility === 'REQUIRES_ASSESSMENT' && HEDGES[i.rule_id]);
    if (unsure.length) sentence += `, ${HEDGES[unsure[0].rule_id]}`;
    components.push({
      id, label: cd.label, heading: copy.heading, sentence: `${sentence}.`, stage: cd.stage,
      plan_heading: cd.plan_heading, plan_phrase: cd.plan_phrase,
      rule_ids: items.map((i) => i.rule_id),
      feasible: items.every(isFeasible),
      // Assessed before it is relied on: a feasibility condition, or a rule
      // whose delivery itself depends on the agency's data.
      assured: items.every((i) => isFeasible(i) && i.delivery_status !== 'REQUIRES_ASSESSMENT'),
      to_confirm: [...new Set(items.flatMap((i) => [...i.assessment_items, ...i.validation_items]))].map(clientSafe),
    });
  }
  // A project needs at least one component that is not only the tracking
  // of other work, and at least one that can actually be delivered.
  if (!components.length || !components.some((c) => c.stage === 'identify' || components.length === 1)) return null;
  const inComponents = new Set(components.flatMap((c) => c.rule_ids));
  // Supporting setup: foundations a component depends on (provided/added by
  // the engine), never CRM administration for its own sake.
  const foundations = type === 'capture' ? [] : ['F1', 'F2'].filter((d) => selected.has(d) && !inComponents.has(d)
    && [...inComponents].some((r) => selected.get(r).dependencies.some((dep) => dep.dimension === d && ['provided', 'added'].includes(dep.resolution))))
    .map((d) => {
      const item = selected.get(d);
      let t = lower(RULE_BY_ID[d].spoken_change);
      if (ctx.crm && d === 'F1') t += ` in ${ctx.crm}`;
      if (item.feasibility === 'REQUIRES_ASSESSMENT' && HEDGES[d]) t += `, ${HEDGES[d].replace('the CRM', ctx.crm || 'the CRM')}`;
      return { rule_id: d, text: t };
    });
  const ruleIds = [...inComponents, ...foundations.map((f) => f.rule_id)];
  const items = ruleIds.map((id) => selected.get(id));
  // Everything else that was selected stays on record as future scope.
  const futureRules = [...selected.keys()].filter((id) => !ruleIds.includes(id));
  const future = scored.map((x) => ({ area_id: x.area.id, name: x.area.name, score: x.score, rule_ids: x.selected.map((i) => i.rule_id).filter((id) => futureRules.includes(id)) }))
    .filter((x) => x.rule_ids.length);

  const { title, short } = projectTitle(type, situation.objective.priority);
  const anchorDims = anchor.selected.map((i) => i.dimension);
  const bottleneck = join(anchorDims.map((d) => GAP_PHRASES[d]).filter(Boolean));
  const preserved = agreed.preserved.map((p) => p.label);
  const measures = [...new Set(items.flatMap((i) => RULE_BY_ID[i.rule_id].measurement))];
  const o = situation.objective;
  const relevance = [
    o.priority_label ? `Their priority is ${lower(o.priority_label)}${o.outcome?.text ? ` — in their words, "${o.outcome.text}"` : ''}.` : '',
    bottleneck ? `The principal bottleneck they described: ${bottleneck}.` : '',
    type === 'existing_customers' && situation.database_size.known ? `They already hold ${situation.database_size.display}${ctx.crm ? ` in ${ctx.crm}` : ''}.` : '',
    type === 'incoming_demand' && situation.enquiries_per_month.known ? `They already get ${situation.enquiries_per_month.display} enquiries.` : '',
    preserved.length ? `What already works stays as it is: ${join(preserved.map(lower))}.` : '',
  ].filter(Boolean);
  return {
    type, name: def.name, title, short,
    description: projectDescription(type, ctx),
    objective: { priority: o.priority, label: o.priority_label },
    desired_outcome: o.outcome?.text ? { text: o.outcome.text, target: o.outcome.target ?? null } : null,
    objective_statement: projectObjective(situation), outcome_noun: ctx.outcomeNoun,
    bottleneck: { area_id: anchor.area.id, text: bottleneck },
    relevance, effect: def.effect,
    components,
    foundations,
    setup_line: foundations.length ? `To support this, we'd first ${join(foundations.map((f) => f.text))}.` : '',
    preserved,
    feasible: components.some((c) => c.feasible),
    conditions: [...new Set(items.flatMap((i) => [...i.assessment_items, ...i.validation_items, ...i.blockers]))],
    success: measures,
    ongoing: projectOngoing(type, ruleIds),
    rule_ids: ruleIds,
    future_scope: future,
    anchor: anchor.area.id, why: anchor.why, score: anchor.score,
  };
}

// ── 1. the situation, in their numbers ────────────────────────────────────
export function buildSituation(session, diagnosis) {
  const b = diagnosis.economics.baseline;
  const f = diagnosis.facts;
  const fig = (entry, format) => (entry && entry.value !== null && entry.value !== undefined ? { known: true, value: entry.value, display: format(entry.value), source: entry.source || '' } : { known: false, value: null, display: '', source: '' });
  return {
    agency_name: text(session.agency_name),
    owner_first_name: firstName(session.contact_name),
    branches: f.branches ? { known: true, value: f.branches, display: `${f.branches} branch${f.branches === 1 ? '' : 'es'}`, source: '' } : { known: false, value: null, display: '', source: '' },
    crm: f.crm ? { known: true, value: f.crm, display: f.crm, source: '' } : { known: false, value: null, display: '', source: '' },
    enquiries_per_month: fig(b.enquiries_per_month, (v) => `${Number(v).toLocaleString('en-GB')} a month`),
    database_size: fig(b.database_size, (v) => `${Number(v).toLocaleString('en-GB')} contacts`),
    valuations_per_month: fig(b.valuations_per_month, (v) => `${v} a month`),
    instructions_per_month: fig(b.instructions_per_month, (v) => `${v} a month`),
    fee_per_instruction: fig(b.fee_per_instruction, (v) => gbp(v)),
    conversion_pct: fig(b.conversion_pct, (v) => `${v}%`),
    objective: {
      priority: diagnosis.objective.priority, priority_label: diagnosis.objective.priority_label,
      obstacles: diagnosis.objective.obstacles.map((o) => o.label),
      // What they said "gone really well" would look like. Private: it is
      // their own words about their own agency, not a claim we put on a slide.
      outcome: diagnosis.objective.outcome || { text: '', target: null, note: '' },
      notes: diagnosis.objective.notes,
    },
    missing: ['enquiries_per_month', 'database_size', 'valuations_per_month', 'instructions_per_month', 'fee_per_instruction', 'conversion_pct'].filter((k) => !fig(b[k], String).known),
  };
}

// A private script for the moment discovery ends: what Joe reads aloud
// before he asks the confirm-understanding question, and — once the owner
// has agreed — the short line that leads into sharing the screen. Both are
// built ONLY from the deterministic situation/findings already computed;
// no model, and nothing invented for a figure or a finding that isn't there.
export const SCREEN_SHARE_SCRIPT = "Perfect. Based on that, I think there's a few areas where NOVUS could make a real difference.\n\nRather than try and explain it all verbally, I've got something I can show you based on what we've just discussed.\n\nMind if I share my screen for a couple of minutes?";

export function buildTransitionScript(situation, findings) {
  const name = situation.owner_first_name;
  const lead = `Right${name ? ` ${name}` : ''}, I think I've got a pretty good picture of where you're at. Just before I show you what we do, let me make sure I've understood everything correctly.`;
  const demandBits = [];
  if (situation.enquiries_per_month.known) demandBits.push(`around ${situation.enquiries_per_month.display.replace(' a month', '')} enquiries a month`);
  if (situation.database_size.known) demandBits.push(`${situation.database_size.display} in the database`);
  else if (situation.valuations_per_month.known) demandBits.push(`about ${situation.valuations_per_month.display.replace(' a month', '')} valuations a month`);
  const demand = demandBits.length ? `You're looking at ${join(demandBits)}.` : '';
  const titles = findings.map((f) => lower(f.title));
  const summary = titles.length
    ? `From what we've gone through, ${titles.length === 1 ? 'the main thing that stands out is' : 'a few things stand out:'} ${join(titles)}.`
    : '';
  const closing = "Is that a fair reflection, or is there anything you'd change?";
  return [lead, demand, summary, closing].filter(Boolean).join(' ');
}

// ── 2. the findings: grouped, ranked, in the owner's words ─────────────────
function dimensionSentence(a, { brief = false } = {}) {
  const causes = a.causes.map((c) => lower(c.label));
  const consequences = a.consequences.map((c) => lower(c.label));
  const hedge = a.evidence_status === 'PROVISIONAL' ? 'I think ' : '';
  const parts = [`${hedge}${GAP_PHRASES[a.dimension] || lower(a.label)}${a.primary_label ? ` — "${lower(a.primary_label)}"` : ''}.`];
  if (!brief) {
    if (causes.length) parts.push(`Mainly because ${join(causes)}.`);
    if (consequences.length) parts.push(`The result: ${join(consequences)}.`);
    if (a.frequency && a.frequency !== 'unknown') parts.push(`You said that happens ${{ occasionally: 'now and again', weekly: 'most weeks', daily: 'most days', constantly: 'all the time' }[a.frequency] || a.frequency}.`);
  }
  return cap(parts.join(' '));
}
// A group's statement: the two best-evidenced dimensions in full (gap, the
// owner's answer, cause, consequence), the rest as one line each — so a
// group of four is still something Joe can say aloud.
function groupStatement(dims) {
  const rank = (a) => (a.evidence_status === 'CONFIRMED' ? 0 : 1);
  const full = new Set([...dims].sort((x, y) => rank(x) - rank(y)).slice(0, 2).map((a) => a.dimension));
  return dims.map((a) => dimensionSentence(a, { brief: !full.has(a.dimension) })).join(' ');
}

export function buildFindings(base) {
  const d = base;
  const priority = d.objective.priority;
  const obstacles = new Set(d.objective.obstacles.map((o) => o.value));
  const groups = FINDING_GROUPS.map((group) => {
    const dims = group.rules.map((id) => d.assessments[id]).filter((a) => a && ['weak', 'partial'].includes(a.level) && ['CONFIRMED', 'PROVISIONAL'].includes(a.evidence_status));
    if (!dims.length) return null;
    let score = 0;
    for (const a of dims) {
      score += a.evidence_status === 'CONFIRMED' ? 2 : 1;
      if (a.consequences.some((c) => COMMERCIAL_CONSEQUENCES.has(c.value))) score += 1;
      if (a.frequency === 'daily' || a.frequency === 'constantly') score += 0.5;
    }
    if ((priority === 'more_valuations' || priority === 'more_buyer_demand') && group.id === 'opportunities') score += 1.5;
    if ((priority === 'win_instructions' || priority === 'more_instructions') && group.id === 'capture') score += 0.5;
    if (priority === 'more_instructions' && group.id === 'progress') score += 0.5;
    if (priority === 'capacity' && (group.id === 'progress' || group.id === 'opportunities')) score += 0.5;
    if (obstacles.has('slipping_through') && group.id === 'progress') score += 1;
    if (obstacles.has('not_enough_opportunities') && group.id === 'opportunities') score += 1;
    if (obstacles.has('database') && group.id === 'opportunities') score += 0.5;
    const confirmed = dims.filter((a) => a.evidence_status === 'CONFIRMED');
    return {
      id: group.id, title: group.title, short: group.short,
      evidence: confirmed.length ? 'CONFIRMED' : 'PROVISIONAL',
      dimensions: dims.map((a) => ({
        dimension: a.dimension, label: a.label, level: a.level, evidence_status: a.evidence_status,
        gap: GAP_PHRASES[a.dimension] || lower(a.label), said: a.primary_label,
        causes: a.causes.map((c) => c.label), consequences: a.consequences.map((c) => c.label),
        sentence: dimensionSentence(a),
        owner_words: [a.example, ...a.owner_notes].filter(Boolean),
      })),
      statement: groupStatement(dims),
      owner_words: dims.flatMap((a) => [a.example, ...a.owner_notes]).filter(Boolean),
      score: Math.round(score * 10) / 10,
    };
  }).filter(Boolean).sort((a, b) => b.score - a.score);
  // Two or three groups, never more: the meeting conclusion is about the
  // problems that matter, not every diagnostic dimension.
  return groups.slice(0, 3).filter((g, i) => i < 2 || g.score >= 2);
}

// ── 3. what a correction does ──────────────────────────────────────────────
// A rejected finding, or a corrected finding with parts the owner dropped,
// becomes an EXISTING_STRENGTH override on those dimensions with the owner's
// reason: "you have told me this works, we plug into it and check it early".
// Nothing touches the answers or the operator's own overrides.
export function cleanAgreement(raw, findings) {
  const out = {};
  const ids = new Set(findings.map((f) => f.id));
  for (const [id, value] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (!ids.has(id) || !value || typeof value !== 'object') continue;
    const status = AGREEMENT_STATUSES.includes(text(value.status)) ? text(value.status) : '';
    if (!status) continue;
    const finding = findings.find((f) => f.id === id);
    const allowed = new Set(finding.dimensions.map((x) => x.dimension));
    const dropped = status === 'CORRECTED' ? [...new Set((Array.isArray(value.dropped) ? value.dropped : []).map(text).filter((x) => allowed.has(x)))] : [];
    out[id] = {
      status, note: text(value.note).slice(0, 600), dropped,
      present: status === 'REJECTED' ? false : value.present !== false,
      at: text(value.at) || new Date().toISOString(),
    };
  }
  return out;
}

export function agreementOverrides(agreement, findings) {
  const out = {};
  for (const finding of findings) {
    const a = agreement?.[finding.id];
    if (!a) continue;
    const dims = a.status === 'REJECTED' ? finding.dimensions.map((x) => x.dimension) : a.status === 'CORRECTED' ? a.dropped : [];
    for (const dim of dims) {
      out[dim] = {
        evidence_status: 'EXISTING_STRENGTH', level: 'strong',
        reason: `Owner (meeting conclusion): ${a.status === 'REJECTED' ? 'not a problem' : 'this part is not a problem'}${a.note ? ` — ${a.note}` : ''}`,
        at: a.at, source: 'OWNER_CONCLUSION',
      };
    }
  }
  return out;
}

export function mergeOverrides(operatorOverrides, agreement, findings) {
  const base = operatorOverrides && typeof operatorOverrides === 'object' ? operatorOverrides : {};
  const owner = agreementOverrides(agreement, findings);
  // The operator's recorded override wins over the owner's remark, so a
  // deliberate decision on the diagnosis stage is never silently undone.
  return { ...owner, ...base, rules: base.rules || {} };
}

export function cleanConclusion(raw, findings) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const n = Number(src.additional_valuations);
  const scope = Array.isArray(src.scope_rule_ids) ? [...new Set(src.scope_rule_ids.map(text).filter((id) => RULE_BY_ID[id]))] : null;
  return {
    agreement: cleanAgreement(src.agreement, findings),
    additional_valuations: ADDITIONAL_VALUATIONS_RANGE.includes(n) ? n : DEFAULT_ADDITIONAL_VALUATIONS,
    scope_rule_ids: scope,
    polish: src.polish && typeof src.polish === 'object' ? src.polish : null,
    checkpoint: src.checkpoint && typeof src.checkpoint === 'object' ? src.checkpoint : null,
    updated_at: text(src.updated_at),
  };
}

// ── 4. economics ──────────────────────────────────────────────────────────
export function buildOpportunity(diagnosis, additionalValuations = DEFAULT_ADDITIONAL_VALUATIONS) {
  const e = diagnosis.economics;
  const b = e.baseline;
  const fee = b.fee_per_instruction.value;
  const conversion = b.conversion_pct.value;
  const available = fee !== null && fee !== undefined && conversion !== null && conversion !== undefined;
  const perValuation = available ? Math.round(fee * (conversion / 100)) : null;
  const rows = available ? ADDITIONAL_VALUATIONS_RANGE.map((n) => {
    const monthly = Math.round(n * (conversion / 100) * fee);
    return { additional_valuations_per_month: n, additional_instructions_per_month: Math.round(n * (conversion / 100) * 100) / 100, monthly_gbp: monthly, annual_gbp: monthly * 12, kind: 'HYPOTHETICAL_ILLUSTRATION' };
  }) : [];
  const selected = ADDITIONAL_VALUATIONS_RANGE.includes(additionalValuations) ? additionalValuations : DEFAULT_ADDITIONAL_VALUATIONS;
  return {
    available, missing: e.missing.filter((m) => m !== 'monthly valuations'),
    fee_per_instruction: { value: fee ?? null, source: b.fee_per_instruction.source || '' },
    conversion_pct: { value: conversion ?? null, source: b.conversion_pct.source || '', detail: b.conversion_pct.detail || '' },
    valuations_per_month: { value: b.valuations_per_month.value ?? null, source: b.valuations_per_month.source || '' },
    instructions_per_month: { value: b.instructions_per_month.value ?? null, source: b.instructions_per_month.source || '' },
    expected_fee_income_per_valuation_gbp: perValuation,
    formula: 'Expected gross fee income per additional valuation = average instruction fee × valuation-to-instruction conversion',
    rows, selected_additional_valuations: selected,
    selected: rows.find((r) => r.additional_valuations_per_month === selected) || null,
    label: 'Illustration, not a forecast',
    disclaimer: e.disclaimer,
  };
}

// ── 5. what NOVUS would change ────────────────────────────────────────────
function dependencyPreserve(item, agreed) {
  return item.dependencies.filter((dep) => dep.resolution === 'existing' && dep.dimension).map((dep) => agreed.assessments[dep.dimension]?.label).filter(Boolean);
}
function conditionsFor(item, rule) {
  const out = [];
  for (const x of item.assessment_items) out.push({ kind: 'assess', text: x });
  for (const x of item.validation_items) out.push({ kind: 'confirm', text: x });
  for (const x of item.blockers) out.push({ kind: 'blocked', text: x });
  for (const dep of item.dependencies) if (dep.resolution === 'unknown' || dep.resolution === 'assess') out.push({ kind: 'confirm', text: dep.note });
  if (rule.delivery_status === 'REQUIRES_ASSESSMENT' || rule.delivery_status === 'PROPOSED') out.push({ kind: 'delivery', text: rule.delivery_status_note });
  return out;
}

export function buildChanges(agreed, findings, agreement) {
  const selected = agreed.interventions.filter((i) => i.selected);
  const strengths = new Map(agreed.findings.strengths.map((s) => [s.dimension, s]));
  const groups = [];
  for (const group of FINDING_GROUPS) {
    const items = selected.filter((i) => group.rules.includes(i.rule_id));
    if (!items.length) continue;
    const finding = findings.find((f) => f.id === group.id) || null;
    const a = finding ? agreement?.[finding.id] : null;
    const problemDims = finding ? finding.dimensions.filter((x) => !(a?.status === 'CORRECTED' && a.dropped.includes(x.dimension))) : [];
    const preserve = [...new Set([
      ...group.rules.filter((id) => strengths.has(id)).map((id) => strengths.get(id).label),
      ...items.flatMap((i) => dependencyPreserve(i, agreed)),
    ])];
    const rules = items.map((i) => {
      const r = RULE_BY_ID[i.rule_id];
      return {
        rule_id: i.rule_id, title: r.title, kind: r.kind, change: r.intervention, spoken_change: r.spoken_change, feasibility: i.feasibility,
        delivery_status: i.delivery_status, delivery_status_label: DELIVERY_STATUSES[i.delivery_status], added_for_dependency: i.added_for_dependency,
        measurement: r.measurement, scope_limitations: r.scope_limitations, conditions: conditionsFor(i, r),
      };
    });
    const feasible = rules.filter((r) => ['FEASIBLE', 'FEASIBLE_WITH_FOUNDATION'].includes(r.feasibility));
    // A group with no finding of its own is here because the intelligence
    // work depends on it (a foundation added by the engine): its problem is
    // the gap on the dimensions of the rules it carries.
    const problemPoints = problemDims.length ? problemDims.map((x) => cap(x.gap)) : items.map((i) => cap(GAP_PHRASES[RULE_BY_ID[i.rule_id].dimension] || RULE_BY_ID[i.rule_id].title));
    groups.push({
      id: group.id, title: group.title, short: group.short,
      problem: problemPoints.join('. ') + '.',
      problem_points: problemPoints,
      problem_from_finding: Boolean(finding), owner_note: a?.note || '',
      change: rules.map((r) => cap(r.spoken_change)).join('. ') + '.',
      changes: rules.map((r) => r.change),
      effect: cap(group.value) + '.',
      measured_by: [...new Set(rules.flatMap((r) => r.measurement))].slice(0, 3),
      preserve, conditions: [...new Map(rules.flatMap((r) => r.conditions).map((c) => [c.text, c])).values()],
      rules, status: feasible.length ? (feasible.length === rules.length ? 'FEASIBLE' : 'PARTLY_SUBJECT_TO_ASSESSMENT') : 'SUBJECT_TO_ASSESSMENT',
      foundation_only: rules.every((r) => r.kind === 'foundation'),
    });
  }
  // Order: the group that carries the first live workflow first, then by the
  // finding ranking, foundations-only groups last (they exist to enable).
  const first = agreed.plan?.generated_from?.first_workflow || '';
  const rank = new Map(findings.map((f, i) => [f.id, i]));
  groups.sort((x, y) => (y.rules.some((r) => r.rule_id === first) - x.rules.some((r) => r.rule_id === first)) || (x.foundation_only - y.foundation_only) || ((rank.get(x.id) ?? 9) - (rank.get(y.id) ?? 9)));
  return {
    groups: groups.slice(0, 3),
    other_groups: groups.slice(3),
    preserved: agreed.preserved.map((p) => ({ dimension: p.dimension, label: p.label, verified: p.verified })),
    foundations: selected.filter((i) => i.kind === 'foundation').map((i) => i.rule_id),
    foundations_note: selected.some((i) => i.kind === 'foundation')
      ? 'Foundations are only built where the intelligence work needs them; everything else stays as it is.'
      : (agreed.preserved.length ? 'Your existing processes are reused as they are — nothing is rebuilt.' : ''),
  };
}

// ── 6. the personalised deployment ────────────────────────────────────────
// Generated from the PRIMARY PROJECT's components — never assembled from
// every selected rule. Week 1 establishes access, scope, the baseline and
// only the supporting setup the project needs (reusing what already works);
// week 2 activates the first part of the project; weeks 3–4 expand it and
// progress the opportunities, WITHOUT a date on anything still waiting on a
// check; weeks 5–8 keep it running, improve it and review the commercial
// outcome. Outcome tracking starts in week 1 with the baseline. The expandable
// task lists come from the engine's plan over the project's rules only.
const PHASE_MAP = Object.freeze({ week1: ['p1', 'p2'], week2: ['p3'], weeks3_4: ['p4'], weeks5_8: ['p5'] });
export function projectPlan(agreed, project) {
  const inScope = new Set(project?.rule_ids || []);
  return buildPlan({ ...agreed, interventions: agreed.interventions.map((i) => ({ ...i, selected: i.selected && inScope.has(i.rule_id) })) });
}
export function buildDeployment(agreed, project = null, situation = null) {
  const plan = projectPlan(agreed, project);
  const proposed = agreed.suitability.verdict === 'POTENTIAL_FIT' && Boolean(project);
  const components = project?.components || [];
  const workflows = components.filter((c) => c.stage === 'identify');
  const first = workflows.find((c) => c.assured) || workflows.find((c) => c.feasible) || workflows[0] || components[0] || null;
  const later = workflows.filter((c) => c !== first);
  const progress = components.find((c) => c.stage === 'progress' && c !== first) || null;
  const reused = agreed.preserved.map((p) => lower(p.label));
  const crm = situation?.crm?.known ? situation.crm.display : 'your CRM';
  const baseline = situation?.valuations_per_month?.known
    ? `your ${situation.valuations_per_month.display.replace(' a month', '')} valuations${situation.instructions_per_month?.known ? ` and ${situation.instructions_per_month.display.replace(' a month', '')} instructions` : ''} a month`
    : 'where you are today';
  const inScope = new Set(project?.rule_ids || []);
  const items = agreed.interventions.filter((i) => i.selected && inScope.has(i.rule_id));
  const pending = [...new Set(items.filter((i) => !isFeasible(i)).flatMap((i) => [...i.assessment_items, ...i.validation_items]))].map(clientSafe);
  const dataChecks = items.some((i) => ['I2', 'I3', 'F2'].includes(i.rule_id) && (i.delivery_status === 'REQUIRES_ASSESSMENT' || !isFeasible(i)));
  const foundations = project?.foundations || [];
  const undated = (c) => !c.assured;

  const titles = {
    week1: foundations.length ? 'Access, scope and the foundations we need' : (reused.length ? 'Access, scope and reusing what already works' : 'Access, scope and setup'),
    week2: first ? first.plan_heading : 'Activate the first workflow',
    weeks3_4: later.length ? 'Expand the project and progress the opportunities' : 'Progress the opportunities and refine what is live',
    weeks5_8: 'Keep it running, improve it and review the results',
  };
  const summaries = {
    week1: [
      `We agree exactly what we're doing, get the access we need to ${crm}, and record ${baseline} so we can measure everything against it from day one.`,
      foundations.length ? `We ${join(foundations.map((f) => f.text))}.` : '',
      reused.length ? `What already works — ${join(reused)} — stays exactly as it is and we plug into it.` : '',
      dataChecks ? `We check what ${crm} actually gives us — identifiers, duplicates, how recent it is — before we rely on it.` : '',
      pending.length ? `We also confirm ${join(pending.map(condClause))} first, rather than assume it.` : '',
    ].filter(Boolean).join(' '),
    week2: first
      ? `${undated(first) ? `As soon as the week-1 checks confirm what we can work with, we start ${first.plan_phrase} — we won't put a date on that before we know.` : `We start ${first.plan_phrase} — alongside your team for the first few days, then properly.`} Every opportunity comes with a reason and a next step, and we count them from the start.`
      : 'Nothing to activate — this is not a pilot proposal.',
    weeks3_4: [
      later.length ? `We add ${join(later.map((c) => c.plan_phrase))}${later.some(undated) ? ', as soon as the week-1 checks confirm what is possible — no date on that before we know' : ''}.` : '',
      progress ? `Your team work the opportunities — ${progress.rule_ids.some((id) => ['F3', 'F4'].includes(id)) ? 'each with a dated next step and a named owner' : (agreed.assessments.F3?.evidence_status === 'EXISTING_STRENGTH' ? 'through your existing follow-up process' : 'through the process we agreed')} — and we track what they turn into.` : '',
      'Two-week review with you, and we adjust from what the first opportunities actually produced.',
    ].filter(Boolean).join(' '),
    weeks5_8: `It runs as part of the normal week: new opportunities keep coming through, your team progress them, and we refine what we look for from what actually produced valuations. At day 45 and day 60 we count the valuations and instructions that came from NOVUS-raised opportunities against ${baseline}, and you get a written recommendation.`,
  };
  const phaseComponents = { week1: [], week2: first ? [first.id] : [], weeks3_4: [...later.map((c) => c.id), ...(progress ? [progress.id] : [])], weeks5_8: components.map((c) => c.id) };
  return {
    phases: PLAN_PHASES_COMPACT.map((p) => {
      const detail = plan.phases.filter((x) => PHASE_MAP[p.key].includes(x.id));
      return {
        key: p.key, title: p.title, heading: titles[p.key], summary: proposed ? clientSafe(summaries[p.key]) : '',
        component_ids: phaseComponents[p.key],
        novus_does: detail.flatMap((x) => x.novus_does), agency_does: detail.flatMap((x) => x.agency_does),
        changes: detail.flatMap((x) => x.changes), owner_sees: detail.flatMap((x) => x.owner_sees), measures: detail.flatMap((x) => x.measures),
      };
    }),
    component_ids: components.map((c) => c.id), first_component_id: first?.id || '',
    first_workflow: plan.generated_from.first_workflow, rules: plan.generated_from.rules,
    required_access: plan.required_access, measurement: plan.measurement, pending_validation: pending,
    plan,
    caveat: 'Integrations are confirmed in the first days, not assumed; no completion dates are promised beyond the phase structure.',
  };
}

// ── 7. the founding pilot ─────────────────────────────────────────────────
export function buildPilot(agreed, project, scopeRuleIds, situation) {
  const proposed = agreed.proposed;
  // The default scope is the project, not everything the diagnosis found:
  // other selected rules are future scope unless the operator ticks them in.
  const defaults = project ? project.rule_ids.filter((id) => proposed.includes(id)) : proposed;
  const scope = (Array.isArray(scopeRuleIds) ? scopeRuleIds.filter((id) => proposed.includes(id)) : defaults);
  const rules = scope.map((id) => ({ rule_id: id, title: RULE_BY_ID[id].title, spoken_change: RULE_BY_ID[id].spoken_change, kind: RULE_BY_ID[id].kind }));
  const measures = [...new Set(scope.flatMap((id) => RULE_BY_ID[id].measurement))];
  const baseline = situation.valuations_per_month.known ? `${situation.valuations_per_month.display.replace(' a month', '')} valuations${situation.instructions_per_month.known ? ` and ${situation.instructions_per_month.display.replace(' a month', '')} instructions` : ''} a month` : 'the baseline recorded in week 1';
  const name = situation.owner_first_name;
  const script = agreed.suitability.verdict === 'POTENTIAL_FIT'
    ? `${name ? `${name}, ` : ''}the founding pilot is ${gbp(FOUNDING_OFFER.price_gbp)} all-in for ${FOUNDING_OFFER.duration_days} days. That covers the project we've just gone through${project ? ` — ${project.short}` : ''} — the set-up, progressing the opportunities it raises with your team, and measuring the valuations and instructions against ${baseline}. There's no long-term commitment: at day 60 you get the numbers and a written recommendation, and if it's worked we agree a separate arrangement from there based on what it actually produced. Shall we get the first week in the diary?`
    : '';
  return {
    proposed: agreed.suitability.verdict === 'POTENTIAL_FIT',
    price_gbp: FOUNDING_OFFER.price_gbp, duration_days: FOUNDING_OFFER.duration_days, setup_target_days: FOUNDING_OFFER.setup_target_days,
    headline: `${gbp(FOUNDING_OFFER.price_gbp)} all-in for ${FOUNDING_OFFER.duration_days} days`,
    scope_rule_ids: scope, scope: rules,
    includes: ['Implementation of the agreed scope', 'Opportunity progression with your team', 'Commercial measurement against the recorded baseline', 'Success criteria agreed in writing before anything is configured', 'End-of-pilot review at day 60 with a written recommendation'],
    success_criteria: [...measures.slice(0, 4), 'Valuations and instructions attributable to NOVUS-raised opportunities, against the baseline'],
    review: 'Day-45 check-in and day-60 review with the numbers and a written recommendation on continuation.',
    commitment: FOUNDING_OFFER.commitment, continuation: FOUNDING_OFFER.continuation, extension: FOUNDING_OFFER.extension, never: FOUNDING_OFFER.never,
    pricing_script: script,
  };
}

// ── 7b. PRIVATE guidance for the internal workspace ───────────────────────
// Talking points, implementation answers and likely questions for each
// solution card, from the rule registry and this agency's diagnosis. Never
// part of presentationPayload.
const FALLBACKS = Object.freeze({
  F1: 'If the CRM has no usable field: agree a note convention and NOVUS extracts the selling situation from enquiry text and call notes instead.',
  F2: 'If the CRM cannot export customer, enquiry and valuation records: NOVUS cannot assemble the history in the pilot — the context work comes out of scope and the rest carries on without it.',
  F3: 'If CRM tasks cannot be written: the team work the NOVUS daily due list instead of CRM tasks.',
  F4: 'If there is no action list to track: the overdue view runs on the NOVUS list from F3; it cannot track actions that only live in someone\'s head.',
  F5: 'If the CRM cannot confirm valuations and instructions: the agency confirms them weekly (a five-minute check-in) and NOVUS holds the progression.',
  I1: 'If there is no portal lead feed: forward the lead emails to a NOVUS mailbox, or use a CRM enquiry export; without any feed this cannot run.',
  I2: 'If records cannot be matched reliably (heavy duplication, no consistent phone/email): assessed in days 1–3; if matching fails, this stays out of the pilot.',
  I3: 'If the export is not possible or the data is too messy: work a smaller, cleaner segment the agency can produce (e.g. last two years of valuations); if nothing usable exists, this stays out and the scope shrinks.',
  I4: 'If there are no activity signals: order the list on recorded circumstance, timeframe and property-to-sell only.',
  I5: 'This is a review and a written recommendation within sixty days, not automated learning — that is not implemented and is not claimed.',
});
function ruleGuidance(item, rule, agreed) {
  const facts = agreed.facts;
  const crm = facts.crm || 'the CRM';
  const access = facts.crm_access || '';
  const validation = [...new Set([...item.assessment_items, ...item.validation_items, ...item.blockers])];
  return {
    rule_id: rule.rule_id, title: rule.title, kind: rule.kind, feasibility: item.feasibility,
    delivery_status: rule.delivery_status, delivery_status_label: DELIVERY_STATUSES[rule.delivery_status], delivery_status_note: rule.delivery_status_note,
    configure: rule.implementation_steps,
    systems_data: rule.required_data_access,
    access: [
      ...(['F2', 'I2', 'I3'].includes(rule.rule_id) ? [`${crm}: ${access === 'export' ? 'the owner said an export or access can be given' : access === 'api' ? 'the owner said API / integration access already exists' : access === 'blocked' ? 'the owner said it is locked down — this depends on it' : access === 'unsure' ? 'the owner is not sure what is possible — confirm with the provider in days 1–3' : 'access not established — confirm before relying on it'}`] : []),
      ...(rule.rule_id === 'I1' ? ['Incoming enquiry feed: portal lead emails forwarded, a web-form copy, or a CRM enquiry export'] : []),
      ...(['F3', 'F4'].includes(rule.rule_id) ? ['Somewhere the team see due actions: CRM tasks (write access) or the NOVUS daily list'] : []),
      ...(rule.rule_id === 'F5' ? ['Valuation and instruction confirmations: CRM status export, or a weekly confirmation from the agency'] : []),
    ],
    novus: rule.novus_responsibilities, agency: rule.agency_responsibilities,
    team_change: rule.intervention,
    dependencies: item.dependencies.map((d) => d.note),
    validation,
    fallback: FALLBACKS[rule.rule_id] || '',
    limits: rule.scope_limitations,
    measurement: rule.measurement,
  };
}
function questionsFor(rules, agreed) {
  const facts = agreed.facts; const crm = facts.crm || 'your CRM'; const access = facts.crm_access;
  const ids = rules.map((r) => r.rule_id);
  const q = [];
  q.push({ q: 'How would you actually do that?', a: rules.map((r) => `${cap(RULE_SHORT_NAMES[r.rule_id])}: ${r.configure.slice(0, 3).map((x) => lower(x).replace(/\.$/, '')).join('; ')}.`).join(' ') });
  q.push({ q: 'What do you need from us?', a: `${[...new Set(rules.flatMap((r) => r.systems_data))].join('; ')}. On your side: ${[...new Set(rules.flatMap((r) => r.agency))].map(lower).join(', ')}.` });
  if (ids.some((id) => ['F2', 'I2', 'I3', 'I1', 'F1'].includes(id))) {
    const dep = ids.some((id) => ['F2', 'I2', 'I3'].includes(id));
    q.push({ q: `Will this work with ${crm}?`, a: dep
      ? `${access === 'export' || access === 'api' ? `You said we can get ${access === 'api' ? 'integration access' : 'an export'} — that is what this needs. ` : access === 'blocked' ? `You said ${crm} is locked down, which is why this part is ${ids.includes('I3') || ids.includes('F2') ? 'subject to what we can get' : 'to be confirmed'}. ` : `It depends on what ${crm} will let us export — we confirm that with the provider in the first days rather than assume it. `}We do not rebuild or migrate ${crm}; we read what it can give us. ${rules.filter((r) => r.delivery_status === 'REQUIRES_ASSESSMENT').map((r) => r.delivery_status_note).join(' ')}`.trim()
      : `Yes — this part reads incoming enquiries and call notes rather than ${crm}'s database; we write back to a field or note where ${crm} allows it, and keep it in the NOVUS view where it does not.` });
  }
  q.push({ q: 'Does my team have to learn another system?', a: ids.some((id) => ['F3', 'F4', 'I4'].includes(id)) ? `No. The team get a short daily list of who to contact and why — in ${crm} tasks where that is possible, otherwise one NOVUS page. Nothing else changes for them.` : `No. The team carry on as they are; NOVUS raises the opportunities and shows them where the team already look${ids.includes('F1') ? ', plus a one-line prompt for the two questions to ask when the selling situation is missing' : ''}.` });
  q.push({ q: 'How much extra work will this create?', a: `${[...new Set(rules.flatMap((r) => r.agency))].map(lower).join('; ')}. The aim is less chasing, not more admin: NOVUS creates and dates the work, the team do the conversations.` });
  if (ids.some((id) => ['I2', 'I3', 'F2'].includes(id))) {
    const quality = agreed.assessments?.I3?.details?.I3_quality || '';
    q.push({ q: 'What happens if our database is a mess?', a: `We check it before we promise anything: identifiers, duplicates, recency, in days 1–3${quality ? ` (you described it as "${quality}")` : ''}. If it is usable we start with the cleanest segment — say the last two years of valuations — and widen from there; if it is not, that part stays out of the pilot and we say so. We do not clean or migrate the database itself.` });
  }
  q.push({ q: 'How will we know whether it\'s working?', a: `${[...new Set(rules.flatMap((r) => r.measurement))].slice(0, 3).join('; ')}. Every opportunity NOVUS raises is recorded, so at day 45 and day 60 we count the valuations and instructions that came from them against your baseline.` });
  const toValidate = [...new Set(rules.flatMap((r) => r.validation))];
  if (toValidate.length) q.push({ q: 'What could stop this?', a: `To validate first: ${toValidate.join('; ')}. If it fails: ${rules.map((r) => r.fallback).filter(Boolean).join(' ')}` });
  return q;
}
// Which of the owner's own established findings support the project: any
// finding dimension that belongs to one of the project's rules, so the
// "why" is always their words, never invented for the project.
function projectFindingContext(ruleIds, findings, agreement) {
  const dims = new Set(ruleIds.map((id) => RULE_BY_ID[id].dimension));
  const points = []; const said = []; const notes = [];
  for (const f of findings) {
    if (!f.dimensions.some((d) => dims.has(d.dimension))) continue;
    for (const d of f.dimensions) if (dims.has(d.dimension)) { points.push(cap(d.gap)); if (d.said) said.push(`${d.label}: "${lower(d.said)}"`); }
    const a = agreement?.[f.id];
    if (a?.note) notes.push(a.note);
  }
  return { points: [...new Set(points)], said: [...new Set(said)], notes: [...new Set(notes)] };
}
export function buildProjectGuidance({ agreed, project, findings, agreement, situation }) {
  if (!project) return null;
  const selected = new Map(agreed.interventions.filter((i) => i.selected).map((i) => [i.rule_id, i]));
  const rules = project.rule_ids.map((id) => ruleGuidance(selected.get(id), RULE_BY_ID[id], agreed));
  const byId = new Map(rules.map((r) => [r.rule_id, r]));
  const ctx = projectFindingContext(project.rule_ids, findings, agreement);
  const o = situation.objective;
  const name = situation.owner_first_name;
  const conditions = [...new Set(rules.flatMap((r) => r.validation))];
  const dependencies = [...new Set(rules.flatMap((r) => r.dependencies))];
  const clauses = project.components.map((c) => lower(c.sentence).replace(/\.$/, ''));
  const objectiveText = project.desired_outcome ? `what you said you want — ${lower(project.desired_outcome.text).replace(/[.!\s]+$/, '')}` : (o.priority_label ? lower(o.priority_label) : 'more from the sales side');
  // A founder explaining what his company would do for this agency — not a
  // product description. Built only from what is already established.
  const say_aloud = [
    `${name ? `So ${name}, b` : 'B'}ased on what you've told me, the project I'd propose is ${project.short}.`,
    project.bottleneck.text ? `You told me ${project.bottleneck.text}${project.preserved.length ? `, while ${join(project.preserved.map(lower))} already work${project.preserved.length === 1 ? 's' : ''} well — so we'd leave ${project.preserved.length === 1 ? 'that' : 'those'} alone` : ''}.` : '',
    clauses.map((cl, i) => `${i === 0 ? (clauses.length > 1 ? 'First, we\'d' : 'What we\'d actually do is') : i === clauses.length - 1 ? 'And we\'d' : 'Then we\'d'} ${cl}.`).join(' '),
    project.foundations.length ? `To make that work, we'd first ${join(project.foundations.map((f) => f.text))}.` : '',
    `And it's not a one-off: once it's running we keep finding the opportunities, get them to your team and look at what actually turns into ${project.outcome_noun}, so it gets sharper over time. That's all aimed at ${objectiveText}.`,
  ].filter(Boolean).join(' ');
  const agencyNeeds = [...new Set(rules.flatMap((r) => r.agency))];
  return {
    title: project.title, name: project.name,
    // 1. why we're proposing it, and the answers behind it
    why: [
      ...project.relevance,
      project.why.length ? `Why this project over the alternatives: ${join(project.why)}.` : '',
      project.future_scope.length ? `Not led with (future scope): ${join(project.future_scope.map((x) => lower(x.name)))} — keeps the pilot bounded.` : '',
    ].filter(Boolean),
    supporting_answers: [
      ...(o.priority_label ? [`Priority: "${lower(o.priority_label)}"`] : []),
      ...(o.outcome?.text ? [`Six-month ambition: "${o.outcome.text}"${o.outcome.target !== null && o.outcome.target !== undefined ? ` (target ${o.outcome.target})` : ''}`] : []),
      ...(o.obstacles.length ? [`What's in the way: ${join(o.obstacles.map((x) => `"${lower(x)}"`))}`] : []),
      ...ctx.said,
      ...ctx.notes.map((n) => `Their correction: "${n}"`),
    ],
    // 2. how it addresses the objective
    objective_link: `${project.title.replace(/\.$/, '')} goes straight at ${o.priority_label ? lower(o.priority_label) : 'their objective'}: ${project.effect}.`,
    say_aloud,
    // 3. what we'd implement · 4. data, systems, permissions · 5. their team
    what_we_implement: [...new Set(rules.flatMap((r) => r.configure))],
    data_access: [...new Set([...rules.flatMap((r) => r.systems_data), ...rules.flatMap((r) => r.access)])],
    need_from_team: agencyNeeds,
    team_change: rules.map((r) => ({ rule_id: r.rule_id, name: cap(RULE_SHORT_NAMES[r.rule_id] || r.rule_id), text: r.team_change })),
    // 6. what stays · 7. the ongoing service · 8. what we measure
    preserved: project.preserved,
    ongoing: [
      project.ongoing,
      project.components.some((c) => c.stage === 'identify') ? 'Each week: new opportunities are raised with the reason and a next step, and the team work them where they already work.' : '',
      'Each month: a short review with the owner of what was raised, what was progressed and what turned into valuations and instructions — and what to change.',
      selected.get('I5') && project.rule_ids.includes('I5') ? 'The refinement is a structured review and recommendation, not automated learning — say it that way.' : '',
    ].filter(Boolean),
    measures: project.success,
    // 9. technical conditions and fallbacks
    conditions: [
      ...conditions.map((x) => ({ kind: 'confirm', text: x })),
      ...dependencies.map((x) => ({ kind: 'depends', text: x })),
      ...rules.filter((r) => ['REQUIRES_ASSESSMENT', 'PROPOSED'].includes(r.delivery_status)).map((r) => ({ kind: 'delivery', text: `${cap(RULE_SHORT_NAMES[r.rule_id] || r.rule_id)}: ${r.delivery_status_note}` })),
    ],
    fallbacks: rules.filter((r) => r.fallback).map((r) => ({ rule_id: r.rule_id, name: cap(RULE_SHORT_NAMES[r.rule_id] || r.rule_id), text: r.fallback })),
    // 10. questions and objections
    questions: questionsFor(rules, agreed),
    components: project.components.map((c) => ({ id: c.id, label: c.label, heading: c.heading, implementation: c.rule_ids.map((id) => byId.get(id)) })),
    foundations: project.foundations.map((f) => ({ ...f, implementation: byId.get(f.rule_id) })),
    future_scope: project.future_scope.map((x) => ({ name: x.name, rule_ids: x.rule_ids })),
  };
}
export function buildGuidance({ agreed, findings, agreement, situation, pilot, project }) {
  const projectGuidance = buildProjectGuidance({ agreed, project, findings, agreement, situation });
  const scope = agreed.interventions.filter((i) => i.selected && pilot.scope_rule_ids.includes(i.rule_id));
  const scopeRules = scope.map((i) => RULE_BY_ID[i.rule_id]);
  const needs = {
    access: [
      ...[...new Set(scopeRules.flatMap((r) => r.required_data_access.map((x) => `${x} (${RULE_SHORT_NAMES[r.rule_id]})`)))],
      ...(agreed.facts.crm ? [`CRM: ${agreed.facts.crm}${agreed.facts.crm_access_label ? ` — ${lower(agreed.facts.crm_access_label)}` : ' — access not established'}`] : []),
      ...scope.flatMap((i) => i.validation_items.map((v) => `Confirm: ${v}`)),
    ],
    setup: [...new Set(scopeRules.flatMap((r) => r.implementation_steps.filter((x) => /^agree|nominate|map each/i.test(x)).map((x) => `${x} (${RULE_SHORT_NAMES[r.rule_id]})`)))].concat(['Confirm who owns the pilot on the agency side', 'Agree the success criteria in writing before anything is configured']),
    act: [...new Set(scopeRules.flatMap((r) => r.agency_responsibilities))].concat(['Confirm valuations and instructions weekly if the CRM cannot provide them', 'Take part in the day-45 and day-60 reviews']),
  };
  const pilotGuidance = {
    closing: [
      pilot.pricing_script,
      'Then stop talking. Let them answer.',
      `If they hesitate on price: it is ${gbp(pilot.price_gbp)} all-in for sixty days with no continuation obligation — one additional instruction at their fee covers it several times over, and every raised opportunity is counted so they can see whether it did.`,
    ].filter(Boolean),
    questions: [
      { q: 'Why £1,500?', a: 'It covers the set-up and sixty days of running and measuring it, and it is deliberately low so the decision is easy: no tiers, no add-ons, no commitment beyond the sixty days.' },
      { q: 'What happens after the sixty days?', a: 'You get the numbers and a written recommendation. If it has worked, continuation is a separate arrangement priced on the measured value and the scope you want to keep — it is not fixed now and you are not committed to it.' },
      { q: 'What if it doesn\'t work?', a: 'Then it stops at day 60 and you have paid £1,500 to find that out with evidence. Where genuine outcome latency prevents a fair assessment, a bounded extension of up to 30 days at no additional cost may apply.' },
      { q: 'Can we start smaller?', a: `The scope is already the minimum that can show a result: ${join(scopeRules.map((r) => RULE_SHORT_NAMES[r.rule_id]))}. Taking parts out mostly removes the measurement, not the cost.` },
      { q: 'Are you guaranteeing results?', a: 'No — no guaranteed number of valuations, instructions or revenue. What is guaranteed is that every opportunity NOVUS raises is recorded and counted against your baseline, so you decide on evidence.' },
    ],
  };
  return { project: projectGuidance, needs, pilot: pilotGuidance };
}

// ── 7c. the PRE-PRICE CHECKPOINT (private) ────────────────────────────────
// Between the 60-day deployment and the founding pilot. The client carries
// on looking at the deployment slide — none of this is ever part of
// presentationPayload. Two questions: did it land, and do they actually
// want it? The answers decide what happens next; the price is never forced
// and the owner is never asked to guess it.
export const UNDERSTANDING_LEVELS = Object.freeze(['CLEAR', 'QUESTIONS_ANSWERED', 'FURTHER_EXPLANATION']);
export const UNDERSTANDING_LABELS = Object.freeze({
  CLEAR: 'Clear — it all made sense',
  QUESTIONS_ANSWERED: 'They had questions, and those were answered',
  FURTHER_EXPLANATION: 'Further explanation required',
});
export const INTEREST_LEVELS = Object.freeze(['YES', 'POTENTIALLY', 'NO']);
export const INTEREST_LABELS = Object.freeze({
  YES: 'Yes — wants it implemented',
  POTENTIALLY: 'Potentially — concerns remain',
  NO: 'No — not interested',
});
// Outstanding concerns, offered only where they are actually relevant to
// what has been proposed to THIS agency. `focus` names the private
// guidance to open when the answer is "potentially".
const CONCERN_DEFS = Object.freeze([
  { id: 'crm_access', label: 'Whether their CRM will actually allow it', dims: ['F2', 'I2', 'I3'], guidance: 'conditions' },
  { id: 'data_quality', label: 'The state of their data / database', dims: ['I2', 'I3'], guidance: 'questions' },
  { id: 'team_capacity', label: 'Whether the team have time to act on the opportunities', dims: ['F1', 'F3', 'F4', 'I4'], guidance: 'team_change' },
  { id: 'team_adoption', label: 'Whether the team will actually use it', dims: [], guidance: 'team_change' },
  { id: 'another_system', label: 'Not wanting another system to learn', dims: [], guidance: 'questions' },
  { id: 'proof', label: 'Wants evidence it has worked elsewhere', dims: [], guidance: 'questions' },
  { id: 'value', label: 'Not convinced of the commercial value yet', dims: [], guidance: 'why_selected' },
  { id: 'timing', label: 'Timing — not right at the moment', dims: [], guidance: '' },
  { id: 'decision_maker', label: 'Needs to discuss it with a partner / co-director', dims: [], guidance: '' },
  { id: 'compliance', label: 'Data protection / contacting past customers', dims: ['I2', 'I3'], guidance: 'questions' },
]);
export function checkpointConcerns(scopeRuleIds = []) {
  const scope = new Set(scopeRuleIds);
  return CONCERN_DEFS.filter((c) => !c.dims.length || c.dims.some((d) => scope.has(d)))
    .map((c) => ({ id: c.id, label: c.label, guidance: c.guidance }));
}
export const CHECKPOINT_UNDERSTANDING_CUE = "Before we get into the commercial side of things, does everything I've shown you make sense? Is there anything about how this would work, or what we'd need from your team, that you'd want me to explain in a bit more detail?";
export const CHECKPOINT_INTEREST_CUE = "Based on everything we've discussed, is this something you'd actually want to get implemented in your agency?";
export const CHECKPOINT_RESPONSES = Object.freeze({
  YES: "Perfect. Let me explain how we're structuring the founding pilot.",
  POTENTIALLY: 'What would you need to feel comfortable moving forward with something like this?',
  NO: '',
});

export function cleanCheckpoint(raw, available) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const ids = new Set(available.map((c) => c.id));
  const understanding = UNDERSTANDING_LEVELS.includes(text(src.understanding)) ? text(src.understanding) : '';
  const interest = INTEREST_LEVELS.includes(text(src.interest)) ? text(src.interest) : '';
  return {
    understanding, interest,
    concerns: [...new Set((Array.isArray(src.concerns) ? src.concerns : []).map(text).filter((id) => ids.has(id)))],
    concerns_resolved: src.concerns_resolved === true,
    notes: text(src.notes).slice(0, 2000),
    at: text(src.at) || (understanding || interest ? new Date().toISOString() : ''),
  };
}

export function buildCheckpoint(state, { pilot, mode, project }) {
  const available = checkpointConcerns(pilot.scope_rule_ids);
  const s = state || { understanding: '', interest: '', concerns: [], concerns_resolved: false, notes: '', at: '' };
  const concerns = s.concerns.map((id) => available.find((c) => c.id === id)).filter(Boolean);
  // What "potentially" needs opened: the project's private guidance, when
  // it answers the concerns raised.
  const openGuidance = concerns.some((c) => c.guidance) && project ? ['project'] : [];
  const next = s.interest === 'YES' ? 'pilot' : s.interest === 'POTENTIALLY' ? 'explore' : s.interest === 'NO' ? 'outcome' : '';
  return {
    understanding_cue: CHECKPOINT_UNDERSTANDING_CUE,
    interest_cue: CHECKPOINT_INTEREST_CUE,
    understanding: s.understanding, understanding_label: UNDERSTANDING_LABELS[s.understanding] || '',
    interest: s.interest, interest_label: INTEREST_LABELS[s.interest] || '',
    concerns: concerns.map((c) => ({ id: c.id, label: c.label, guidance: c.guidance })),
    concerns_available: available,
    concerns_resolved: s.concerns_resolved, notes: s.notes, at: s.at,
    response: CHECKPOINT_RESPONSES[s.interest] || '',
    open_guidance: s.interest === 'POTENTIALLY' ? openGuidance : [],
    next,
    // The pilot is only the next step when they said yes; "no" goes
    // straight to the decision without a price ever being put to them.
    show_pilot: mode === 'PILOT' && s.interest !== 'NO',
    explanation_needed: s.understanding === 'FURTHER_EXPLANATION',
    guidance: s.interest === 'POTENTIALLY'
      ? [
        'Ask it and then stop talking — the answer is the objection, in their words.',
        concerns.length ? `Answer what they actually raised: ${join(concerns.map((c) => lower(c.label)))}. The private guidance for the project is open below.` : 'Write down exactly what they say — record it here before you move on.',
        'If what they need is a condition you can meet inside the pilot, say so plainly; if it is not, say that too rather than softening it.',
      ]
      : s.interest === 'NO'
        ? ['Do not put the price to them. Thank them, record the outcome and leave the door open.']
        : s.interest === 'YES'
          ? ['Say the line, then go straight to the pilot slide — do not re-sell it.']
          : ['Ask both questions before any price. Record what they said as they said it.'],
  };
}

// ── 8. the whole conclusion ───────────────────────────────────────────────
// What Joe says when he is NOT proposing the pilot — owner-facing, from the
// suitability reason, never the internal recommendation text.
export function nextStepFor(suitability, situation) {
  const reason = suitability.reasons?.[0] || '';
  const enquiries = situation.enquiries_per_month.known ? situation.enquiries_per_month.display : '';
  const database = situation.database_size.known ? situation.database_size.display : '';
  const NO = {
    EXISTING_CAPABILITY: 'I\'ll be straight with you: from what you\'ve told me you already have most of what we\'d put in, so I\'m not going to propose a pilot today. If a specific gap shows up, I\'d be glad to look at that.',
    NO_ESTABLISHED_GAP: 'I\'ll be straight with you: nothing we\'ve talked about is a gap worth paying us to fix, so I\'m not going to propose a pilot today.',
    INSUFFICIENT_DEMAND: `I\'ll be straight with you: at the current volume${enquiries || database ? ` (${[enquiries, database].filter(Boolean).join(', ')})` : ''} a sixty-day pilot wouldn\'t have enough to work with, so I\'m not going to propose one today. If that changes, so does the picture.`,
    DEPLOYMENT_INFEASIBLE: 'I\'ll be straight with you: the gaps are real, but the things we\'d change depend on access we can\'t get within a pilot, so I\'m not going to propose one today.',
  };
  const VALIDATE = {
    INCOMPLETE_DISCOVERY: 'I\'m not going to put a pilot to you today — I\'d want to finish going through how things work now before I propose anything specific.',
    TECHNICAL_ASSESSMENT: 'I\'m not going to put a pilot to you today — everything we\'d change depends on what your CRM will let us see, and I\'d rather confirm that first than promise it.',
    EVIDENCE_PROVISIONAL: 'I\'m not going to put a pilot to you today — I\'d want to check a couple of the things we\'ve talked about before proposing anything.',
    ECONOMICS_UNKNOWN: 'I\'m not going to put a pilot to you today — I\'d want your fee and conversion figures first, so we can put a proper number on it.',
  };
  if (suitability.verdict === 'NOT_CURRENTLY_SUITABLE') return NO[reason] || NO.NO_ESTABLISHED_GAP;
  if (suitability.verdict === 'FURTHER_VALIDATION_REQUIRED') return VALIDATE[reason] || VALIDATE.EVIDENCE_PROVISIONAL;
  return '';
}

function applyPolish(conclusion, polish) {
  // Polished wording only ever replaces a sentence whose deterministic
  // original is unchanged; a correction that rewrites the original drops it.
  if (!polish || typeof polish !== 'object') return { applied: 0, stale: 0 };
  let applied = 0; let stale = 0;
  for (const f of conclusion.understanding.findings) {
    const p = polish.findings?.[f.id];
    if (!p) continue;
    if (p.original === f.statement && text(p.text)) { f.statement_polished = text(p.text); applied += 1; } else stale += 1;
  }
  const project = conclusion.project;
  if (project) {
    const p = polish.changes?.project;
    if (p) { if (p.original === project.description && text(p.text)) { project.description_polished = text(p.text); applied += 1; } else stale += 1; }
    for (const st of project.components) {
      const q = polish.changes?.[st.id];
      if (!q) continue;
      if (q.original === st.sentence && text(q.text)) { st.sentence_polished = text(q.text); applied += 1; } else stale += 1;
    }
  }
  return { applied, stale };
}

export function buildConclusion({ session, base, agreed, conclusion: stored } = {}) {
  const findings = buildFindings(base);
  const state = cleanConclusion(stored, findings);
  const agreement = state.agreement;
  const situation = buildSituation(session, agreed);
  const changes = buildChanges(agreed, findings, agreement);
  // ONE primary project drives the client slide, the private guidance, the
  // roadmap and the default pilot scope — they cannot drift apart.
  const mode = agreed.suitability.verdict === 'POTENTIAL_FIT' ? 'PILOT' : agreed.suitability.verdict === 'FURTHER_VALIDATION_REQUIRED' ? 'VALIDATION' : 'NO_PITCH';
  // Not suitable → no project at all, however many weak processes exist.
  const project = mode === 'NO_PITCH' ? null : buildProject(agreed, situation);
  const pilot = buildPilot(agreed, project, state.scope_rule_ids, situation);
  const checkpointState = cleanCheckpoint(state.checkpoint, checkpointConcerns(pilot.scope_rule_ids));
  const name = situation.owner_first_name;
  const outsideScope = base.findings.outside_scope.map((a) => ({ dimension: a.dimension, label: a.label, note: 'A process exists but is not followed — a management matter, not something NOVUS fixes.' }));
  const out = {
    version: 1, mode, generated_at: new Date().toISOString(),
    understanding: {
      opening: `Right${name ? ` ${name}` : ''}, correct me if I'm wrong, but this is what I've understood from our conversation...`,
      script: buildTransitionScript(situation, findings),
      after_agreement_script: SCREEN_SHARE_SCRIPT,
      situation,
      findings: findings.map((f) => ({ ...f, agreement: agreement[f.id] || null, present: agreement[f.id] ? agreement[f.id].present : true })),
      outside_scope: outsideScope,
      unknown: base.findings.unknown.map((a) => a.label),
      closing: 'Is that a fair reflection of what\'s happening, or have I missed anything?',
      agreed: findings.length > 0 && findings.every((f) => agreement[f.id]),
      counts: { findings: findings.length, agreed: findings.filter((f) => agreement[f.id]?.status === 'AGREED').length, corrected: findings.filter((f) => agreement[f.id]?.status === 'CORRECTED').length, rejected: findings.filter((f) => agreement[f.id]?.status === 'REJECTED').length },
    },
    opportunity: buildOpportunity(agreed, state.additional_valuations),
    changes,
    project,
    deployment: buildDeployment(agreed, project, situation),
    pilot,
    suitability: { verdict: agreed.suitability.verdict, recommendation: agreed.suitability.recommendation, reasons: agreed.suitability.reasons },
    next_step: nextStepFor(agreed.suitability, situation),
    state: { agreement, additional_valuations: state.additional_valuations, scope_rule_ids: state.scope_rule_ids, checkpoint: checkpointState, updated_at: state.updated_at },
    owner_overrides: agreementOverrides(agreement, findings),
    polish: null,
  };
  out.guidance = buildGuidance({ agreed, findings, agreement, situation, pilot: out.pilot, project });
  out.checkpoint = buildCheckpoint(checkpointState, { pilot: out.pilot, mode, project });
  if (state.polish) {
    const result = applyPolish(out, state.polish);
    out.polish = { model: text(state.polish.model), at: text(state.polish.at), applied: result.applied, stale: result.stale, issues: state.polish.issues || [] };
  }
  return out;
}

// ── 9. the client-facing presentation ─────────────────────────────────────
// Six screens, nothing internal: no rule ids, no evidence codes, no notes,
// no scripts, no controls. Only findings approved for presentation.
export function presentationPayload(conclusion) {
  const c = conclusion;
  const s = c.understanding.situation;
  const findings = c.understanding.findings.filter((f) => f.present && f.agreement?.status !== 'REJECTED');
  const fact = (label, entry) => (entry.known ? { label, value: entry.display } : null);
  const opp = c.opportunity;
  const pr = c.project;
  const screens = [
    {
      id: 'today', title: 'Your agency today', subtitle: s.agency_name,
      facts: [fact('Branches', s.branches), fact('Enquiries', s.enquiries_per_month), fact('Database', s.database_size), fact('Valuations', s.valuations_per_month), fact('Instructions', s.instructions_per_month), fact('CRM', s.crm)].filter(Boolean),
      objective: s.objective.priority_label ? `What you want most: ${lower(s.objective.priority_label)}` : '',
      obstacles: s.objective.obstacles.map(lower),
    },
    {
      id: 'established', title: 'What we\'ve established', subtitle: findings.length ? 'The problems that matter commercially' : 'Nothing agreed for presentation yet',
      findings: findings.map((f) => ({
        title: f.title, hedged: f.evidence === 'PROVISIONAL',
        points: f.dimensions.filter((x) => !(f.agreement?.status === 'CORRECTED' && f.agreement.dropped.includes(x.dimension))).map((x) => cap(x.gap)),
        corrected: f.agreement?.status === 'CORRECTED' ? f.agreement.note : '',
      })),
    },
    {
      id: 'opportunity', title: 'The commercial opportunity', subtitle: opp.available ? 'Using your own figures' : 'Your figures',
      available: opp.available,
      fee: opp.fee_per_instruction.value !== null ? gbp(opp.fee_per_instruction.value) : '', conversion: opp.conversion_pct.value !== null ? `${opp.conversion_pct.value}%` : '',
      per_valuation: opp.expected_fee_income_per_valuation_gbp !== null ? gbp(opp.expected_fee_income_per_valuation_gbp) : '',
      rows: opp.rows.map((r) => ({ n: r.additional_valuations_per_month, monthly: gbp(r.monthly_gbp), annual: gbp(r.annual_gbp) })),
      selected: opp.selected_additional_valuations,
      label: opp.label, footnote: 'Illustrative scenarios from the figures given in this meeting — not forecasts, not guarantees.',
      missing: opp.available ? [] : opp.missing,
    },
    {
      // ONE personalised commercial project: a headline, a short
      // description, up to three numbered components (category label,
      // heading, one sentence) generated for this agency, and THE OBJECTIVE.
      id: 'help', title: 'Your proposed NOVUS deployment', subtitle: c.mode === 'PILOT' ? '' : 'What we would need to confirm first',
      headline: pr ? pr.title : '',
      description: pr ? (pr.description_polished || pr.description) : '',
      components: pr ? pr.components.map((st) => ({ id: st.id, label: st.label, heading: st.heading, sentence: st.sentence_polished || st.sentence })) : [],
      setup: pr ? pr.setup_line : '',
      objective: pr ? pr.objective_statement : '',
      preserved: pr ? pr.preserved : [],
      ongoing: c.mode === 'PILOT' && pr ? pr.ongoing : '',
      next_step: c.mode === 'PILOT' ? '' : c.next_step,
    },
    {
      id: 'needs', title: 'What we\'d need from you', subtitle: c.mode === 'PILOT' ? 'Three things' : '',
      cards: [
        { id: 'access', heading: 'Access to the relevant systems & information', sentence: 'The systems, data and permissions needed to implement your agreed NOVUS setup.' },
        { id: 'setup', heading: 'A short setup with your team', sentence: 'Agree how opportunities are identified, who handles them and how NOVUS fits into your existing processes.' },
        { id: 'act', heading: 'Act on the opportunities', sentence: c.pilot.scope_rule_ids.includes('F1')
          ? 'Your team contacts the relevant customers, records what they hear about selling, and logs the outcomes so we can measure what works.'
          : c.pilot.scope_rule_ids.includes('F3') || c.pilot.scope_rule_ids.includes('F4')
            ? 'Your team contacts the relevant customers, works the daily follow-up list, and records the outcomes so we can measure what works.'
            : 'Your team contacts the relevant customers and records the outcomes so we can measure what works.' },
      ],
    },
    {
      id: 'deployment', title: 'Your first 60 days', subtitle: c.mode === 'PILOT' ? 'Four phases' : 'What would happen next',
      phases: c.deployment.phases.map((p) => ({ title: p.title, heading: p.heading, summary: p.summary, points: [...p.changes.filter((x) => !/^Preserved:/.test(x) && !/^Nothing changes/.test(x)).slice(0, 2), ...p.owner_sees.slice(0, 1)].map(clientSafe) })),
      caveat: c.deployment.caveat, proposed: c.mode === 'PILOT',
    },
    {
      id: 'pilot', title: 'The founding pilot', subtitle: c.pilot.proposed ? c.pilot.headline : 'Not today',
      proposed: c.pilot.proposed, price: gbp(c.pilot.price_gbp), duration: `${c.pilot.duration_days} days`,
      scope: c.pilot.scope.map((r) => cap(r.spoken_change)), includes: c.pilot.includes, success_criteria: c.pilot.success_criteria,
      commitment: 'No long-term commitment. Continuation, if it has worked, is a separate arrangement based on measured value.',
      next_step: c.pilot.proposed ? '' : c.next_step,
    },
  ];
  return { agency_name: s.agency_name, owner_first_name: s.owner_first_name, mode: c.mode, screens, generated_at: c.generated_at };
}

// ── 10. optional AI polish — wording only, validated, never scope or price ─
const BANNED = [
  [/guarantee/i, 'uses "guarantee"'],
  [/\bAI[- ]powered\b|\bartificial intelligence\b/i, 'AI marketing language'],
  [/revolutioni[sz]e|revolutionary|cutting[- ]edge|game[- ]chang|seamless|leverage/i, 'generic marketing language'],
  [/cross-interaction intelligence|data architecture|information optimi[sz]ation|adaptive commercial system|deployment rule|dimension\b/i, 'technical jargon'],
  [/£|\bGBP\b|\b\d{3,}\b/, 'introduces a figure'],
  [/\b[FI][1-5]\b/, 'mentions an internal rule id'],
];
export function validatePolishedText(polished, original) {
  const issues = [];
  const s = text(polished);
  if (!s) return { valid: false, issues: ['empty'] };
  const words = wordCount(s);
  // No longer than the original plus a little: the model may not add.
  if (words > Math.ceil(wordCount(original) * 1.3) + 8) issues.push(`too long (${words} words)`);
  if (/^\s*(#|[-*•]\s|\d+[.)]\s)/m.test(s)) issues.push('contains headings or bullets');
  // A figure is only "introduced" when the original did not already carry
  // it — the project wording quotes the agency's own numbers.
  const figures = (x) => text(x).match(/£|\bGBP\b|\d[\d,]*/g) || [];
  const originalFigures = new Set(figures(original));
  for (const [re, why] of BANNED) {
    if (why === 'introduces a figure') { if (figures(s).some((f) => !originalFigures.has(f))) issues.push(why); continue; }
    if (re.test(s)) issues.push(why);
  }
  return { valid: issues.length === 0, issues };
}

const POLISH_TOOL = {
  name: 'polish_conclusion',
  description: 'Reworded finding statements and project sentences, same meaning, same facts.',
  input_schema: {
    type: 'object',
    properties: {
      findings: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] } },
      changes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] } },
    },
    required: ['findings', 'changes'],
  },
};
const POLISH_SYSTEM = `You tidy the wording of sentences Joe will say to a UK estate-agency owner at the end of a discovery meeting. Natural, conversational UK English, second person, plain estate-agency language (valuations, instructions, applicants, the database, the CRM).
RULES: keep every fact and every hedge ("I think") exactly as given; do not add, remove or reorder facts; do not add numbers, money, promises, guarantees or marketing language; no headings or bullets; each result at most a few sentences and no longer than the original plus a little. Return every id you were given.`;

export async function polishConclusion({ conclusion, call = callAi, model } = {}) {
  const findings = conclusion.understanding.findings.map((f) => ({ id: f.id, text: f.statement }));
  const project = conclusion.project;
  const changes = project ? [{ id: 'project', text: project.description }, ...project.components.map((st) => ({ id: st.id, text: st.sentence }))] : [];
  const at = new Date().toISOString();
  let raw = null; let error = '';
  try {
    raw = await call({ system: POLISH_SYSTEM, prompt: `Reword these, keeping the meaning and every fact. Return them through the tool.\n\n${JSON.stringify({ findings, changes }, null, 1)}`, tool: POLISH_TOOL, purpose: 'discovery-conclusion-polish', maxTokens: 1200, ...(model ? { model } : {}) });
  } catch (err) { error = err?.message || String(err); }
  const polish = { model: model || '', at, findings: {}, changes: {}, issues: [] };
  if (!raw) return { polish, error, accepted: 0, rejected: 0 };
  let accepted = 0; let rejected = 0;
  const take = (bucket, items, list) => {
    for (const item of items) {
      const got = (Array.isArray(list) ? list : []).find((x) => text(x?.id) === item.id);
      if (!got) { rejected += 1; polish.issues.push(`${item.id}: missing`); continue; }
      const check = validatePolishedText(got.text, item.text);
      if (check.valid) { bucket[item.id] = { text: text(got.text), original: item.text }; accepted += 1; }
      else { rejected += 1; polish.issues.push(`${item.id}: ${check.issues.join(', ')}`); }
    }
  };
  take(polish.findings, findings, raw.findings);
  take(polish.changes, changes, raw.changes);
  return { polish, error: rejected ? `Some polished wording was rejected and the deterministic wording kept: ${polish.issues.join('; ')}` : '', accepted, rejected };
}

export const _internal = { dimensionSentence, groupStatement, applyPolish, BANNED, POLISH_SYSTEM, POLISH_TOOL, join };
