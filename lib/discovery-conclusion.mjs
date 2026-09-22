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
//   buildFocusAreas(agreed, situation)        up to three commercial focus areas
//                                             from seven — ONE selection behind
//                                             the client slide, the private
//                                             guidance and the roadmap
//   buildDeployment(agreed, solutions, …)     the four phases, from those areas
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
  { id: 'help', title: 'Where we\'d focus', nav: 'Focus', blurb: 'The personalised focus areas, with talking points and implementation answers' },
  { id: 'needs', title: 'What we\'d need from you', nav: 'Needs', blurb: 'Access, a short setup, acting on opportunities' },
  { id: 'deployment', title: 'Your first 60 days', nav: '60 days', blurb: 'Four phases from the same focus areas, with the implementation tasks underneath' },
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

// ── the personalised COMMERCIAL FOCUS AREAS behind the solution slide ─────
// Seven internal focus categories — not seven products and not seven client
// slides. Up to THREE are selected for this agency from the AGREED
// diagnosis, and the same selection drives the client cards, the private
// implementation guidance and the 60-day roadmap, so the three can never
// drift apart. Selection is by commercial meaning (the owner's objective,
// the consequences established, the evidence behind them, the incremental
// value beyond what already works and delivery feasibility) — NOT simply
// the three weakest diagnostic dimensions, and never fewer or more areas
// than the agency's answers actually establish.
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

// Two areas that would be ONE coherent intervention for this agency. Only
// used when more than three areas are commercially meaningful: the pair is
// merged into a single card (headline from the table, clauses from both)
// rather than dropping one of them.
const FOCUS_COMBINATIONS = Object.freeze([
  { ids: ['database_intelligence', 'connecting_activity'], heading: 'Unlock the opportunities in your customer history', short: 'your customer history' },
  { ids: ['enquiry_intelligence', 'connecting_activity'], heading: 'Recognise the sellers in your day-to-day activity', short: 'the sellers in your activity' },
  { ids: ['progression', 'prioritisation'], heading: 'Make sure the right opportunities get acted on', short: 'acting on the right opportunities' },
  { ids: ['foundations', 'progression'], heading: 'Get the right foundations in place', short: 'the foundations' },
]);

// A focus area is COMMERCIALLY MEANINGFUL at or above this score. The
// highest-scoring area is always kept (something is established, or there
// would be no candidates at all); the second and third have to earn it, so
// an agency with one or two real areas gets one or two cards.
export const FOCUS_MEANINGFUL_SCORE = 3;
export const MAX_FOCUS_AREAS = 3;

// The short, factual, agency-specific clause under a card — only ever from
// a figure this agency actually gave.
function focusContext(areaId, situation) {
  const s = situation;
  if (areaId === 'foundations') return s.crm.known ? `Using your existing ${s.crm.display} setup — nothing gets rebuilt.` : '';
  if (areaId === 'enquiry_intelligence') return s.enquiries_per_month.known ? `Working from the ${s.enquiries_per_month.display.replace(' a month', '')} enquiries a month you already get.` : '';
  if (areaId === 'database_intelligence') return s.database_size.known ? `You already hold around ${s.database_size.display}.` : '';
  if (areaId === 'connecting_activity') return s.database_size.known ? `Across the ${s.database_size.display} you already hold.` : '';
  if (areaId === 'measurement') return s.valuations_per_month.known ? `Measured against your ${s.valuations_per_month.display.replace(' a month', '')} valuations a month.` : '';
  return '';
}

// One clause per selected rule: the plain-English action, named against the
// agency's own CRM where that is what the rule touches, and hedged with
// "once we've confirmed…" rather than promised when the rule still needs a
// technical assessment — never claims an integration before access is
// established.
const condClause = (cond) => lower(clientSafe(cond)).replace(/^confirm(?:ing)?\s+/, '').replace(/\.$/, '');
function focusActionClause(item, rule, situation, crmAlreadyNamed) {
  let clause = lower(rule.spoken_change).replace(/\.$/, '');
  const crm = !crmAlreadyNamed && situation.crm.known ? situation.crm.display : '';
  if (crm && ['F1', 'F2'].includes(rule.rule_id)) clause += ` in ${crm}`;
  else if (crm && ['I2', 'I3'].includes(rule.rule_id)) clause += ` from ${crm}`;
  if (item.feasibility === 'REQUIRES_ASSESSMENT') {
    const cond = item.assessment_items[0] || item.validation_items[0] || item.blockers[0];
    if (cond) clause += `, once we've confirmed ${condClause(cond)}`;
  }
  return clause;
}

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

function focusCard(candidate, agreed, situation, { heading, short } = {}) {
  const { area, selected } = candidate;
  let crmNamed = false;
  // At most two clauses, and on a combined card one from each area it
  // covers, so the merge still reads as one coherent intervention.
  const byArea = new Map();
  for (const i of selected) { const id = FOCUS_BY_DIM[i.rule_id]; if (!byArea.has(id)) byArea.set(id, []); byArea.get(id).push(i); }
  const spoken = [...[...byArea.values()].map((list) => list[0]), ...[...byArea.values()].flatMap((list) => list.slice(1))]
    .slice(0, 2).sort((x, y) => selected.indexOf(x) - selected.indexOf(y));
  const clauses = spoken.map((i) => {
    const clause = focusActionClause(i, RULE_BY_ID[i.rule_id], situation, crmNamed);
    if (situation.crm.known && ['F1', 'F2', 'I2', 'I3'].includes(i.rule_id)) crmNamed = true;
    return clause;
  });
  const feasible = selected.every((i) => ['FEASIBLE', 'FEASIBLE_WITH_FOUNDATION'].includes(i.feasibility));
  const toConfirm = [...new Set(selected.flatMap((i) => [...i.assessment_items, ...i.validation_items]))];
  return {
    id: area.id, area_ids: candidate.area_ids || [area.id], name: area.name,
    dims: candidate.dims || area.dims, order: area.order,
    heading: heading || area.heading, short: short || area.short,
    sentence: clauses.length ? `We'd ${join(clauses)}.` : '',
    context: focusContext(area.id, situation),
    plan_phrase: area.plan_phrase, effect: area.effect,
    rule_ids: selected.map((i) => i.rule_id),
    preserved: (candidate.strengths || []).map((d) => ({ dimension: d, label: agreed.assessments[d].label })),
    feasible, to_confirm: toConfirm.map((x) => clientSafe(x)),
    score: candidate.score, why: candidate.why,
  };
}

// Up to three focus areas for this agency, in implementation order.
export function buildFocusAreas(agreed, situation) {
  // Nothing proposed anywhere (not currently suitable, or a strong agency
  // with no gap) → no focus areas; the caller falls back to next_step.
  if (!agreed.proposed.length) return [];
  const scored = FOCUS_AREAS.map((area) => scoreFocusArea(area, agreed, situation)).filter(Boolean)
    .sort((a, b) => b.score - a.score || a.area.order - b.area.order);
  if (!scored.length) return [];
  // The highest scorer always stands; the rest must be commercially
  // meaningful in their own right. Three cards are never forced.
  let keep = [scored[0], ...scored.slice(1).filter((x) => x.score >= FOCUS_MEANINGFUL_SCORE)];
  // More than three meaningful areas → combine a related pair into one
  // coherent intervention before anything is dropped.
  for (const combo of FOCUS_COMBINATIONS) {
    if (keep.length <= MAX_FOCUS_AREAS) break;
    const parts = combo.ids.map((id) => keep.find((x) => x.area.id === id));
    if (parts.some((p) => !p || p.combined)) continue;
    const [lead, other] = [...parts].sort((a, b) => b.score - a.score || a.area.order - b.area.order);
    keep = keep.filter((x) => x !== other);
    lead.selected = [...lead.selected, ...other.selected];
    lead.area_ids = [...(lead.area_ids || [lead.area.id]), other.area.id];
    lead.dims = [...lead.area.dims, ...other.area.dims];
    lead.strengths = [...(lead.strengths || []), ...(other.strengths || [])];
    lead.why = [...new Set([...lead.why, ...other.why])];
    lead.combined = combo;
    lead.score = Math.max(lead.score, other.score);
  }
  keep = keep.sort((a, b) => b.score - a.score || a.area.order - b.area.order).slice(0, MAX_FOCUS_AREAS);
  return keep
    .map((candidate) => focusCard(candidate, agreed, situation, candidate.combined ? { heading: candidate.combined.heading, short: candidate.combined.short } : {}))
    .sort((a, b) => a.order - b.order);
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
// Built from the SAME selected focus areas as the solution slide — never an
// independently constructed roadmap. Week 1 establishes access, scope and
// only the foundations this agency actually needs (reusing what already
// works); week 2 activates the first focus area that is feasible today;
// weeks 3–4 take on the rest, WITHOUT a date for anything still waiting on
// a technical validation; weeks 5–8 progress and review. Outcome tracking
// starts in week 1 with the baseline, not in week 5.
const PHASE_MAP = Object.freeze({ week1: ['p1', 'p2'], week2: ['p3'], weeks3_4: ['p4'], weeks5_8: ['p5'] });
export function buildDeployment(agreed, solutions = [], situation = null) {
  const phases = agreed.plan?.phases || [];
  const proposed = agreed.suitability.verdict === 'POTENTIAL_FIT';
  const cards = solutions.filter((c) => c.rule_ids.length);
  const foundation = cards.find((c) => c.id === 'foundations');
  const measurement = cards.find((c) => c.id === 'measurement');
  const others = cards.filter((c) => c !== foundation && c !== measurement);
  const workflows = others.length ? others : (measurement ? [measurement] : []);
  const first = workflows.find((c) => c.feasible) || workflows[0] || null;
  const later = workflows.filter((c) => c !== first);
  const reused = agreed.preserved.map((p) => lower(p.label));
  const crm = situation?.crm?.known ? situation.crm.display : 'your CRM';
  const baseline = situation?.valuations_per_month?.known
    ? `your ${situation.valuations_per_month.display.replace(' a month', '')} valuations${situation.instructions_per_month?.known ? ` and ${situation.instructions_per_month.display.replace(' a month', '')} instructions` : ''} a month`
    : 'where you are today';
  const pending = [...new Set(cards.filter((c) => !c.feasible).flatMap((c) => c.to_confirm))];

  const titles = {
    week1: foundation ? 'Access, scope and the foundations we need' : (reused.length ? 'Access, scope and reusing what already works' : 'Access, scope and setup'),
    week2: first ? `Go live with ${first.short}` : 'Activate the first workflow',
    weeks3_4: later.length ? 'Extend into the rest of your focus areas' : 'Refine what is live with your team',
    weeks5_8: 'Progress the opportunities and review the commercial results',
  };
  const foundationSentence = foundation ? cap(foundation.sentence.replace(/^We'd /, 'We ')) : '';
  // Anything still to validate is said once: if the foundations sentence
  // already carries the condition, it is not repeated.
  const week1Pending = pending.filter((x) => !foundationSentence.includes(condClause(x)));
  const summaries = {
    week1: [
      `We agree exactly what we're doing, get the access we need to ${crm}, and record ${baseline} so we can measure everything against it from day one.`,
      foundationSentence || (reused.length ? `What already works — ${join(reused)} — stays exactly as it is and we plug into it.` : ''),
      week1Pending.length ? `We also confirm ${join(week1Pending.map(condClause))} first, rather than assume it.` : '',
    ].filter(Boolean).join(' '),
    week2: first
      ? `We go live with ${first.plan_phrase} — alongside your team for the first few days, then properly. Every opportunity it raises comes with a dated next step, and we count them from the start.`
      : (foundation ? `The first thing running is ${foundation.plan_phrase}, and your team work from it.` : 'Nothing to activate — this is not a pilot proposal.'),
    weeks3_4: [
      later.length
        ? `We move on to ${join(later.map((c) => c.plan_phrase))}${later.some((c) => !c.feasible) ? ', as soon as the week-1 checks confirm what is possible — we won\'t put a date on that before we know' : ''}.`
        : 'Rather than adding more, we refine what is live with the people using it.',
      'Two-week review with you either way, and we adjust from what the first opportunities actually produced.',
    ].join(' '),
    weeks5_8: `${measurement && measurement !== first ? `${cap(measurement.plan_phrase)} becomes part of how the week runs. ` : ''}The workflow runs as business as usual. At day 45 and day 60 we count the valuations and instructions that came from NOVUS-raised opportunities against ${baseline}, and you get a written recommendation.`,
  };
  return {
    phases: PLAN_PHASES_COMPACT.map((p) => {
      const detail = phases.filter((x) => PHASE_MAP[p.key].includes(x.id));
      return {
        key: p.key, title: p.title, heading: titles[p.key], summary: proposed ? clientSafe(summaries[p.key]) : '',
        focus_ids: p.key === 'week1' ? (foundation ? [foundation.id] : []) : p.key === 'week2' ? (first ? [first.id] : []) : p.key === 'weeks3_4' ? later.map((c) => c.id) : (measurement ? [measurement.id] : []),
        novus_does: detail.flatMap((x) => x.novus_does), agency_does: detail.flatMap((x) => x.agency_does),
        changes: detail.flatMap((x) => x.changes), owner_sees: detail.flatMap((x) => x.owner_sees), measures: detail.flatMap((x) => x.measures),
      };
    }),
    focus_ids: cards.map((c) => c.id), first_focus_id: first?.id || '',
    first_workflow: agreed.plan?.generated_from?.first_workflow || '', rules: agreed.plan?.generated_from?.rules || [],
    required_access: agreed.plan?.required_access || [], pending_validation: pending,
    caveat: 'Integrations are confirmed in the first days, not assumed; no completion dates are promised beyond the phase structure.',
  };
}

// ── 7. the founding pilot ─────────────────────────────────────────────────
export function buildPilot(agreed, changes, scopeRuleIds, situation) {
  const proposed = agreed.proposed;
  const scope = (Array.isArray(scopeRuleIds) ? scopeRuleIds.filter((id) => proposed.includes(id)) : proposed);
  const rules = scope.map((id) => ({ rule_id: id, title: RULE_BY_ID[id].title, spoken_change: RULE_BY_ID[id].spoken_change, kind: RULE_BY_ID[id].kind }));
  const measures = [...new Set(scope.flatMap((id) => RULE_BY_ID[id].measurement))];
  const baseline = situation.valuations_per_month.known ? `${situation.valuations_per_month.display.replace(' a month', '')} valuations${situation.instructions_per_month.known ? ` and ${situation.instructions_per_month.display.replace(' a month', '')} instructions` : ''} a month` : 'the baseline recorded in week 1';
  const groupsInScope = changes.groups.filter((g) => g.rules.some((r) => scope.includes(r.rule_id)));
  const name = situation.owner_first_name;
  const script = agreed.suitability.verdict === 'POTENTIAL_FIT'
    ? `${name ? `${name}, ` : ''}the founding pilot is ${gbp(FOUNDING_OFFER.price_gbp)} all-in for ${FOUNDING_OFFER.duration_days} days. That covers everything we've just gone through${groupsInScope.length ? ` — ${join(groupsInScope.map((g) => GROUP_NOUNS[g.id] || lower(g.short)))}` : ''} — the set-up, progressing the opportunities it raises with your team, and measuring the valuations and instructions against ${baseline}. There's no long-term commitment: at day 60 you get the numbers and a written recommendation, and if it's worked we agree a separate arrangement from there based on what it actually produced. Shall we get the first week in the diary?`
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
// Which finding dimensions a focus area's private guidance can draw on: any
// dimension that is part of a SELECTED rule in the area, cross-referenced
// against the owner's own established findings (so the "why it matters" is
// always their words, never invented for the area).
function focusFindingContext(card, findings, agreement) {
  const dims = new Set(card.rule_ids.map((id) => RULE_BY_ID[id].dimension));
  const points = []; const said = []; let note = '';
  for (const f of findings) {
    if (!f.dimensions.some((d) => dims.has(d.dimension))) continue;
    for (const d of f.dimensions) if (dims.has(d.dimension)) { points.push(cap(d.gap)); if (d.said) said.push(d.said); }
    const a = agreement?.[f.id];
    if (a?.note) note = a.note;
  }
  return { points: [...new Set(points)], said: [...new Set(said)], note };
}
export function buildGuidance({ agreed, changes, findings, agreement, situation, pilot, solutions }) {
  const priority = situation.objective.priority_label ? lower(situation.objective.priority_label) : 'more from the sales side';
  const help = {};
  for (const card of solutions) {
    const items = agreed.interventions.filter((i) => i.selected && card.rule_ids.includes(i.rule_id));
    const rules = items.map((i) => ruleGuidance(i, RULE_BY_ID[i.rule_id], agreed));
    const ctx = focusFindingContext(card, findings, agreement);
    const conditions = [...new Map(rules.flatMap((r) => r.validation.map((x) => [x, x]))).values()];
    const dependencies = [...new Set(rules.flatMap((r) => r.dependencies))];
    // 1. WHY THIS AREA — from the owner's own answers, plus the commercial
    // reason the selection scored it where it did. Never invented.
    const why_selected = [
      ctx.points.length ? `You told me ${join(ctx.points.map(lower))}.` : '',
      ctx.said.length ? `Their words: ${ctx.said.map((x) => `"${lower(x)}"`).join(', ')}.` : '',
      ctx.note ? `They corrected this: "${ctx.note}".` : '',
      card.why.length ? `Why it made the three: ${join(card.why)}.` : '',
      card.preserved.length ? `Already works and is reused, not rebuilt: ${join(card.preserved.map((p) => lower(p.label)))}.` : '',
    ].filter(Boolean);
    // 2. SAY IT ALOUD — a natural explanation, not a script to read.
    const say_aloud = [
      ctx.points.length ? `You said ${join(ctx.points.map(lower))}` : `This is the part of your operation we'd focus on first`,
      `, so what we'd do is ${lower(card.sentence).replace(/^we'd /, '').replace(/\.$/, '')}`,
      ` — ${card.effect}`,
      situation.objective.priority_label ? `, which is what gets you ${priority}.` : '.',
    ].join('');
    const talking = [
      why_selected[0] ? `Why it matters here: ${lower(why_selected[0])}` : (card.preserved.length ? `Why it matters here: your ${join(card.preserved.map((p) => lower(p.label)))} already work${card.preserved.length === 1 ? 's' : ''} well — this is reuse, not a gap.` : ''),
      `What we'd actually do: ${card.sentence}`,
      `Why that's ${priority}: ${card.effect}.${rules.length ? ` We'd see it in ${lower([...new Set(rules.flatMap((r) => r.measurement))][0] || 'the weekly outcome view')}.` : ''}`,
      card.preserved.length && card.rule_ids.length ? `What stays: ${join(card.preserved.map((p) => lower(p.label)))} works — we plug into it, we don't replace it.` : '',
      conditions.length ? `Say honestly: ${conditions.map((x) => lower(clientSafe(x))).join('; ')} — confirmed in the first days, not promised now.` : '',
    ].filter(Boolean);
    help[card.id] = {
      name: card.name, heading: card.heading,
      why_selected, say_aloud, talking_points: talking,
      // 3. what we'd actually implement · 4. what we'd need · 5. what changes
      what_we_implement: [...new Set(rules.flatMap((r) => r.configure))],
      need_from_agency: [
        ...new Set([...rules.flatMap((r) => r.systems_data), ...rules.flatMap((r) => r.access), ...rules.flatMap((r) => r.agency)]),
      ],
      team_change: rules.map((r) => ({ rule_id: r.rule_id, name: cap(RULE_SHORT_NAMES[r.rule_id] || r.rule_id), text: r.team_change })),
      // 6. technical conditions and dependencies
      conditions: [
        ...conditions.map((x) => ({ kind: 'confirm', text: x })),
        ...dependencies.map((x) => ({ kind: 'depends', text: x })),
        ...rules.filter((r) => ['REQUIRES_ASSESSMENT', 'PROPOSED'].includes(r.delivery_status)).map((r) => ({ kind: 'delivery', text: `${cap(RULE_SHORT_NAMES[r.rule_id] || r.rule_id)}: ${r.delivery_status_note}` })),
      ],
      // 7. questions and objections · 8. fallbacks
      questions: questionsFor(rules, agreed),
      fallbacks: rules.filter((r) => r.fallback).map((r) => ({ rule_id: r.rule_id, name: cap(RULE_SHORT_NAMES[r.rule_id] || r.rule_id), text: r.fallback })),
      implementation: rules,
    };
  }
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
  return { help, needs, pilot: pilotGuidance };
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

export function buildCheckpoint(state, { pilot, mode, solutions }) {
  const available = checkpointConcerns(pilot.scope_rule_ids);
  const s = state || { understanding: '', interest: '', concerns: [], concerns_resolved: false, notes: '', at: '' };
  const concerns = s.concerns.map((id) => available.find((c) => c.id === id)).filter(Boolean);
  // What "potentially" needs opened: the focus areas whose private guidance
  // answers the concerns raised, plus the pilot objections.
  const openGuidance = concerns.some((c) => c.guidance) ? solutions.map((c) => c.id) : [];
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
        concerns.length ? `Answer what they actually raised: ${join(concerns.map((c) => lower(c.label)))}. The private guidance for each focus area is open below.` : 'Write down exactly what they say — record it here before you move on.',
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
  for (const st of conclusion.solutions) {
    const p = polish.changes?.[st.id];
    if (!p) continue;
    if (p.original === st.sentence && text(p.text)) { st.sentence_polished = text(p.text); applied += 1; } else stale += 1;
  }
  return { applied, stale };
}

export function buildConclusion({ session, base, agreed, conclusion: stored } = {}) {
  const findings = buildFindings(base);
  const state = cleanConclusion(stored, findings);
  const agreement = state.agreement;
  const situation = buildSituation(session, agreed);
  const changes = buildChanges(agreed, findings, agreement);
  // ONE selection of focus areas drives the client slide, the private
  // guidance and the roadmap — they cannot drift apart.
  const solutions = buildFocusAreas(agreed, situation);
  const pilot = buildPilot(agreed, changes, state.scope_rule_ids, situation);
  const checkpointState = cleanCheckpoint(state.checkpoint, checkpointConcerns(pilot.scope_rule_ids));
  const name = situation.owner_first_name;
  const mode = agreed.suitability.verdict === 'POTENTIAL_FIT' ? 'PILOT' : agreed.suitability.verdict === 'FURTHER_VALIDATION_REQUIRED' ? 'VALIDATION' : 'NO_PITCH';
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
    solutions,
    deployment: buildDeployment(agreed, solutions, situation),
    pilot,
    suitability: { verdict: agreed.suitability.verdict, recommendation: agreed.suitability.recommendation, reasons: agreed.suitability.reasons },
    next_step: nextStepFor(agreed.suitability, situation),
    state: { agreement, additional_valuations: state.additional_valuations, scope_rule_ids: state.scope_rule_ids, checkpoint: checkpointState, updated_at: state.updated_at },
    owner_overrides: agreementOverrides(agreement, findings),
    polish: null,
  };
  out.guidance = buildGuidance({ agreed, changes, findings, agreement, situation, pilot: out.pilot, solutions: out.solutions });
  out.checkpoint = buildCheckpoint(checkpointState, { pilot: out.pilot, mode, solutions: out.solutions });
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
      // Up to three personalised commercial focus areas, in implementation
      // order — not the three weakest diagnostic dimensions, and never
      // three for the sake of three. Heading, one plain-English sentence,
      // and this agency's own context where a real figure exists.
      id: 'help', title: 'Here\'s where we\'d focus for your agency.', subtitle: c.mode === 'PILOT' ? 'What we would put in place for you' : 'What we would need to confirm first',
      cards: c.solutions.map((st) => ({ id: st.id, heading: st.heading, sentence: st.sentence_polished || st.sentence, context: st.context })),
      preserved: c.changes.preserved.map((p) => p.label),
      ongoing: c.mode === 'PILOT' && c.solutions.length
        ? 'From there it keeps running: NOVUS carries on identifying opportunities, making sure they are progressed, and reviewing what actually turned into valuations and instructions.'
        : '',
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
  for (const [re, why] of BANNED) if (re.test(s)) issues.push(why);
  return { valid: issues.length === 0, issues };
}

const POLISH_TOOL = {
  name: 'polish_conclusion',
  description: 'Reworded finding statements and change sentences, same meaning, same facts.',
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
  const changes = conclusion.solutions.map((st) => ({ id: st.id, text: st.sentence }));
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
