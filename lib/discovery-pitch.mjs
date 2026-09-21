// lib/discovery-pitch.mjs — personalised pitch generation for the meeting
// discovery workspace.
//
// THREE OUTPUTS, ONE DIAGNOSIS.
//   spoken   150–220 words (hard cap 250) Joe says aloud: the agency's
//            situation, the two or three commercially significant
//            opportunities, what NOVUS would change, why that means more
//            valuations, what the sixty days are for, and a closing
//            question. No price, no headings, no jargon.
//   plan     four phases (week 1 / week 2 / weeks 3–4 / weeks 5–8), at most
//            two short sentences each, built from the SELECTED rules.
//   internal the full diagnosis — not generated here; the page shows the
//            engine's output in an expandable reference section.
//
// THEMES, NOT RULES. Ten rules are grouped into four commercial themes
// (making customer information usable; making sure opportunities progress;
// finding more opportunities in existing demand; measuring and improving)
// and the spoken pitch talks about the top two or three themes, ranked by
// the owner's stated priority, evidence quality, feasibility and how much
// the theme adds beyond what already works. Grouping is presentation only —
// the engine's selected rules are unchanged and the plan still names them.
//
// GROUNDING. The model receives the structured findings, the selected
// rules' own wording, the ranked themes, the plan skeleton, the baseline
// with sources and the allowed money figures — never emails, phones, or
// anything about the agency's customers. Every result is validated: word
// cap, no price in the spoken pitch, no invented £ figures, no guarantees or
// AI marketing, no rule that was not proposed, a closing question, and
// plan phases of at most two sentences. A failed or rejected generation
// stores the deterministic TEMPLATE version instead, flagged as such, so the
// meeting never ends without something to say and the discovery data is
// untouched either way.

import { callAi } from './ai-client.mjs';
import { RULE_BY_ID, FOUNDING_OFFER, DELIVERY_STATUSES } from './discovery-rules.mjs';

const text = (value) => String(value ?? '').trim();
const firstName = (name) => text(name).split(/\s+/)[0] || '';
export const SPOKEN_WORD_CAP = 250;
export const SPOKEN_WORD_TARGET = [150, 220];

export const THEMES = Object.freeze([
  { id: 'capture', title: 'Making customer information usable', rules: ['F1', 'F2'], value: 'the selling situations your team already hear stop getting lost' },
  { id: 'progress', title: 'Making sure opportunities actually progress', rules: ['F3', 'F4'], value: 'the not-yet sellers are still yours when they are ready' },
  { id: 'opportunities', title: 'Finding more valuation opportunities in the demand you already have', rules: ['I1', 'I2', 'I3', 'I4'], value: 'more of the sellers already in your enquiries and your database turn into valuation appointments' },
  { id: 'measure', title: 'Measuring and improving results', rules: ['F5', 'I5'], value: 'you can see, for the first time, what is actually producing instructions' },
]);

export const PLAN_PHASES_COMPACT = Object.freeze([
  { key: 'week1', title: 'Week 1', blurb: 'Necessary foundations and setup' },
  { key: 'week2', title: 'Week 2', blurb: 'Initial intelligence activation' },
  { key: 'weeks3_4', title: 'Weeks 3–4', blurb: 'Expansion and refinement' },
  { key: 'weeks5_8', title: 'Weeks 5–8', blurb: 'Progression and commercial measurement' },
]);

const BANNED = [
  [/guarantee/i, 'uses "guarantee"'],
  [/\bAI[- ]powered\b|\bartificial intelligence\b/i, 'AI marketing language'],
  [/revolutioni[sz]e|revolutionary|cutting[- ]edge|game[- ]chang|seamless|leverage/i, 'generic marketing language'],
  [/cross-interaction intelligence|data architecture|information optimi[sz]ation|adaptive commercial system|deployment rule|dimension\b/i, 'technical jargon the brief forbids'],
];
const COMMERCIAL_CONSEQUENCES = new Set(['missed_sellers', 'lost_valuations', 'competitor_wins', 'missed_reactivation', 'missed_ready', 'untouched_value', 'missed_context', 'late']);

export function wordCount(value) { return text(value) ? text(value).split(/\s+/).length : 0; }
function sentenceCount(value) { return text(value) ? text(value).split(/(?<=[.!?])\s+/).filter(Boolean).length : 0; }
function join(items, conj = 'and') {
  const list = items.filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} ${conj} ${list[list.length - 1]}`;
}

// ── the input the model (and the template) sees ───────────────────────────
export function rankThemes(diagnosis) {
  const d = diagnosis;
  const selected = new Map(d.interventions.filter((i) => i.selected).map((i) => [i.rule_id, i]));
  const priority = d.objective.priority;
  const obstacles = new Set(d.objective.obstacles.map((o) => o.value));
  const strengths = new Set(d.findings.strengths.map((s) => s.dimension));
  return THEMES.map((theme) => {
    const rules = theme.rules.filter((id) => selected.has(id));
    if (!rules.length) return null;
    let score = 0;
    const why = [];
    for (const id of rules) {
      const item = selected.get(id);
      const finding = d.assessments[item.dimension];
      score += 1;
      if (item.confidence === 'CONFIRMED') { score += 1; }
      if (item.feasibility === 'FEASIBLE') score += 1; else if (item.feasibility === 'FEASIBLE_WITH_FOUNDATION') score += 0.5; else score -= 0.5;
      if (finding?.consequences?.some((c) => COMMERCIAL_CONSEQUENCES.has(c.value))) { score += 1; why.push(`${id}: ${finding.consequences.map((c) => c.label.toLowerCase()).join(', ')}`); }
      if (finding?.frequency === 'daily' || finding?.frequency === 'constantly') score += 0.5;
    }
    if (priority === 'more_valuations' && theme.id === 'opportunities') score += 1.5;
    if (priority === 'win_instructions' && theme.id === 'capture') score += 0.5;
    if (priority === 'capacity' && (theme.id === 'progress' || theme.id === 'opportunities')) score += 0.5;
    if (obstacles.has('slipping_through') && theme.id === 'progress') score += 1;
    if (obstacles.has('not_enough_opportunities') && theme.id === 'opportunities') score += 1;
    if (obstacles.has('database') && theme.id === 'opportunities') score += 0.5;
    // A theme that would only restate an existing strength adds little.
    const preservedInTheme = theme.rules.filter((id) => strengths.has(id)).length;
    score -= preservedInTheme * 0.5;
    // The two rules worth saying aloud for this theme: confirmed and feasible
    // first, then registry order. The rest still sit in the plan.
    const first = d.plan?.generated_from?.first_workflow;
    const ruleRank = (id) => { const item = selected.get(id); return (id === first ? -2 : 0) + (item.confidence === 'CONFIRMED' ? 0 : 2) + (item.feasibility === 'FEASIBLE' ? 0 : item.feasibility === 'FEASIBLE_WITH_FOUNDATION' ? 0.5 : 1); };
    const spoken_rules = [...rules].sort((x, y) => ruleRank(x) - ruleRank(y) || theme.rules.indexOf(x) - theme.rules.indexOf(y)).slice(0, 2)
      .sort((x, y) => theme.rules.indexOf(x) - theme.rules.indexOf(y));
    return { id: theme.id, title: theme.title, value: theme.value, rules, spoken_rules, score: Math.round(score * 10) / 10, why };
  }).filter(Boolean).sort((a, b) => b.score - a.score);
}

export function buildPitchInput(session, diagnosis) {
  const d = diagnosis;
  const proposed = d.interventions.filter((i) => i.selected);
  const rules = proposed.map((i) => {
    const r = RULE_BY_ID[i.rule_id];
    return {
      rule_id: i.rule_id, title: r.title, kind: r.kind, what_we_would_change: r.spoken_change, intervention: r.intervention,
      delivery_status: DELIVERY_STATUSES[i.delivery_status], feasibility: i.feasibility, confidence: i.confidence,
      dependencies: i.dependencies.map((dep) => dep.note), assessment_items: i.assessment_items, scope_limitations: r.scope_limitations,
    };
  });
  const finding = (a) => ({
    dimension: a.dimension, label: a.label, level: a.level, evidence_status: a.evidence_status, verified: a.verified,
    what_they_said: a.primary_label, causes: a.causes.map((c) => c.label), consequences: a.consequences.map((c) => c.label),
    frequency: a.frequency, example: a.example, owner_notes: a.owner_notes, derived_from: a.basis_dimensions || [],
  });
  const money = new Set();
  const b = d.economics.baseline;
  if (b.fee_per_instruction.value !== null) money.add(Math.round(b.fee_per_instruction.value));
  for (const ill of d.economics.illustrations) { money.add(ill.additional_fee_income_per_month_gbp); money.add(ill.additional_fee_income_per_year_gbp); }
  const themes = rankThemes(d);
  const focus = themes.slice(0, 3).filter((t, i) => i < 2 || t.score >= 2);
  return {
    mode: d.suitability.verdict === 'POTENTIAL_FIT' ? 'PILOT' : d.suitability.verdict === 'FURTHER_VALIDATION_REQUIRED' ? 'VALIDATION' : 'NO_PITCH',
    agency: { name: text(session.agency_name), owner_first_name: firstName(session.contact_name), branches: d.facts.branches, crm: d.facts.crm, crm_access: d.facts.crm_access_label },
    objective: d.objective,
    baseline: d.economics.baseline,
    illustrations: d.economics.illustrations,
    economics_disclaimer: d.economics.disclaimer,
    findings: {
      confirmed: d.findings.confirmed.map(finding), provisional: d.findings.provisional.map(finding),
      strengths: d.findings.strengths.map(finding), outside_scope: d.findings.outside_scope.map(finding), unknown: d.findings.unknown.map((a) => a.label),
    },
    interventions: rules,
    themes, focus,
    blockers: d.blockers, validation: d.validation,
    plan_skeleton: templatePlan(d),
    suitability: d.suitability,
    pilot: { duration_days: FOUNDING_OFFER.duration_days, setup_target_days: FOUNDING_OFFER.setup_target_days, objective: 'Show, against the recorded baseline, whether NOVUS-raised opportunities produced valuations and instructions the agency would not otherwise have had.' },
    allowed_money_figures: [...money],
    spoken_word_cap: SPOKEN_WORD_CAP,
  };
}

// ── deterministic template: the compact plan ──────────────────────────────
function sel(diagnosis) { return diagnosis.interventions.filter((i) => i.selected); }
const rule = (id) => RULE_BY_ID[id];
const feasibleOf = (items) => items.filter((i) => ['FEASIBLE', 'FEASIBLE_WITH_FOUNDATION'].includes(i.feasibility));
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export function templatePlan(diagnosis) {
  const d = diagnosis;
  const selected = sel(d);
  const feasible = feasibleOf(selected);
  const assess = selected.filter((i) => i.feasibility === 'REQUIRES_ASSESSMENT');
  const foundations = feasible.filter((i) => i.kind === 'foundation');
  const first = d.plan.generated_from.first_workflow ? feasible.find((i) => i.rule_id === d.plan.generated_from.first_workflow) : null;
  const remaining = feasible.filter((i) => i.kind === 'intelligence' && i.rule_id !== first?.rule_id);
  const strengths = d.findings.strengths.map((s) => s.label.toLowerCase());
  const b = d.economics.baseline;
  const baseline = b.valuations_per_month.value !== null ? ` (${b.valuations_per_month.value} valuations${b.instructions_per_month.value !== null ? ` and ${b.instructions_per_month.value} instructions` : ''} a month)` : '';
  const phrases = (items, max = 2) => {
    const named = items.slice(0, max).map((i) => rule(i.rule_id).plan_phrase);
    const rest = items.slice(max).map((i) => i.rule_id);
    return join(named) + (rest.length ? `, with ${join(rest)} following` : '');
  };

  const week1 = [
    `Confirm the findings with you, agree the success criteria and record the baseline${baseline}${assess.length ? `; check ${join(assess.map((i) => i.assessment_items[0] ? i.assessment_items[0].toLowerCase() : rule(i.rule_id).title.toLowerCase()))}` : ''}.`,
    foundations.length ? `${cap(phrases(foundations))}.` : (strengths.length ? `Your existing ${join(strengths)} stays as it is and NOVUS plugs into it.` : ''),
  ].filter(Boolean).join(' ');
  const week2 = first
    ? `${cap(rule(first.rule_id).plan_phrase)}, in shadow for the first few days then live. ${first.dependencies.some((x) => x.resolution === 'provided' || x.resolution === 'added') ? 'It runs on the foundations from week 1.' : 'Every raised opportunity gets a dated action for your team.'}`
    : foundations.length ? `The first workflow live is ${rule(foundations[0].rule_id).plan_phrase}. Your team work the daily list from here.` : 'Nothing to activate — this plan is not a pilot proposal.';
  const weeks3_4 = [
    remaining.length ? `Add ${phrases(remaining, 2)}.` : 'Refine the live workflow with the team rather than adding more.',
    assess.length ? `${join(assess.map((i) => i.rule_id))} ${assess.length === 1 ? 'joins' : 'join'} only if the week-1 check passes; two-week review with you either way.` : 'Two-week review with you and the team, then adjust the configuration.',
  ].join(' ');
  const weeks5_8 = `The workflow runs as business as usual with a weekly outcome view. At day 45 and day 60 we count the valuations and instructions attributable to NOVUS-raised opportunities against the baseline and give you a written recommendation.`;
  return { week1, week2, weeks3_4, weeks5_8 };
}

// ── deterministic template: the spoken pitch ──────────────────────────────
export function templateSpoken(input) {
  const a = input.agency;
  const b = input.baseline;
  const name = a.owner_first_name;
  const situationBits = [];
  if (a.branches) situationBits.push(`${a.branches} branch${a.branches === 1 ? '' : 'es'}`);
  if (b.valuations_per_month.value !== null) situationBits.push(`about ${b.valuations_per_month.value} valuations a month`);
  else if (b.enquiries_per_month.value !== null) situationBits.push(`around ${b.enquiries_per_month.value} enquiries a month`);
  const priority = input.objective.priority_label ? input.objective.priority_label.toLowerCase() : 'more from the sales side';
  const obstacle = input.objective.obstacles[0]?.label ? input.objective.obstacles[0].label.toLowerCase() : '';
  const strengths = input.findings.strengths.map((s) => s.label.toLowerCase());
  const focus = input.focus;

  if (input.mode !== 'PILOT') {
    const gaps = join(input.findings.confirmed.slice(0, 3).map((f) => f.label.toLowerCase()));
    const lead = `${name ? `${name}, ` : ''}thanks for being so open. ${gaps ? `The things that stood out were ${gaps}. ` : ''}`;
    const body = input.mode === 'VALIDATION'
      ? `I'm not going to put a pilot to you today, because ${input.suitability.recommendation.replace(/\.$/, '').toLowerCase()}. I'd rather come back with something specific than guess.`
      : `I'll be straight with you: I don't think a pilot is the right thing right now. ${input.suitability.recommendation}`;
    const close = input.mode === 'VALIDATION' ? ' Could we get those confirmed this week so I can put a proper proposal in front of you?' : ' Would it be useful if I stayed in touch and we looked again if that changes?';
    return `${lead}${body}${strengths.length ? ` What you've built around ${join(strengths)} already works, and I wouldn't touch it.` : ''}${close}`;
  }

  const running = a.branches ? `runs ${situationBits[0]}${situationBits[1] ? ` doing ${situationBits[1]}` : ''}` : (situationBits[0] ? `is doing ${situationBits[0]}` : 'is');
  const opening = `${name ? `${name}, ` : ''}from what you've told me, ${a.name} ${running}, the thing you want most is ${priority}${obstacle ? `, and what's getting in the way is ${obstacle}` : ''}.`;
  const themeSentence = (t, i) => {
    const changes = join((t.spoken_rules || t.rules).map((id) => rule(id).spoken_change));
    const lead = i === 0 ? `The first thing I'd do is` : i === 1 ? `Second, I'd` : `And third, I'd`;
    return `${lead} ${changes}, so that ${t.value}.`;
  };
  const themes = focus.map(themeSentence);
  const preserved = strengths.length ? `What you've already got around ${join(strengths)} works, and we'd plug into it rather than replace it.` : '';
  const together = focus.length > 1
    ? `Together, that means the sellers already coming to you, and the ones in your database, get found, followed up and counted — without your team working a different system.`
    : `That means more of the sellers already talking to you turn into valuation appointments, without your team working a different system.`;
  const assess = input.interventions.filter((i) => i.feasibility === 'REQUIRES_ASSESSMENT');
  const caveat = assess.length ? `One part depends on what ${a.crm || 'your CRM'} will let us see, and we'd confirm that in the first few days rather than promise it now.` : '';
  const pilot = `The sixty-day pilot is simple: set it up in the first fortnight, run it, and count the valuations and instructions it produced against where you are today.`;
  const close = `Does that sound like the right place to start?`;
  let spoken = [opening, ...themes, preserved, together, caveat, pilot, close].filter(Boolean).join(' ');
  // Aim for the target, never exceed the cap: drop the third theme first if
  // the pitch runs long, then the caveat, then the preserved clause.
  if (wordCount(spoken) > SPOKEN_WORD_TARGET[1] && themes[2]) spoken = spoken.replace(` ${themes[2]}`, '');
  for (const part of [caveat, preserved]) {
    if (wordCount(spoken) <= SPOKEN_WORD_CAP) break;
    if (part) spoken = spoken.replace(` ${part}`, '');
  }
  return spoken;
}

export function templatePitch(input, diagnosis) {
  return {
    mode: input.mode,
    spoken: templateSpoken(input),
    plan: input.mode === 'PILOT' ? (diagnosis ? templatePlan(diagnosis) : input.plan_skeleton) : null,
    themes: input.focus.map((t) => ({ id: t.id, title: t.title, rules: t.rules })),
    preserved: input.findings.strengths.map((s) => s.label),
    rule_ids_used: input.interventions.map((i) => i.rule_id),
    confidence_note: input.findings.provisional.length || input.interventions.some((i) => i.feasibility === 'REQUIRES_ASSESSMENT') ? 'Some findings are provisional and some interventions depend on a technical assessment; the pitch says so.' : '',
  };
}

// ── validation ────────────────────────────────────────────────────────────
function moneyIssues(all, input) {
  const issues = [];
  const allowed = new Set((input.allowed_money_figures || []).map((n) => Math.round(Number(n))));
  for (const match of all.matchAll(/£\s?([\d,]+(?:\.\d+)?)(\s?k)?/gi)) {
    let n = Number(match[1].replace(/,/g, ''));
    if (match[2]) n *= 1000;
    if (!allowed.has(Math.round(n))) issues.push(`money figure not from discovery: £${match[1]}${match[2] || ''}`);
  }
  return issues;
}
function ruleIssues(all, input) {
  const issues = [];
  const proposed = new Set(input.interventions.map((i) => i.rule_id));
  for (const [id, r] of Object.entries(RULE_BY_ID)) {
    if (proposed.has(id)) continue;
    if (new RegExp(`\\b${id}\\b`).test(all) || all.toLowerCase().includes(r.title.toLowerCase()) || all.toLowerCase().includes(r.spoken_change.toLowerCase())) issues.push(`mentions a rule that was not proposed: ${id}`);
  }
  return issues;
}

export function validateSpoken(spoken, input) {
  const issues = [];
  const s = text(spoken);
  if (!s) return { valid: false, issues: ['spoken pitch is empty'] };
  const words = wordCount(s);
  if (words > SPOKEN_WORD_CAP) issues.push(`spoken pitch is ${words} words (cap ${SPOKEN_WORD_CAP})`);
  if (input.mode === 'PILOT' && words < 90) issues.push(`spoken pitch is only ${words} words`);
  if (/^\s*(#|[-*•]\s|\d+[.)]\s)/m.test(s) || /\n\s*\n/.test(s) && /:\s*\n/.test(s)) issues.push('contains headings or bullet points');
  for (const [re, why] of BANNED) if (re.test(s)) issues.push(why);
  if (/£\s?1,?500|\b1,?500\b|per month for|a month for the pilot|pilot (fee|price|cost)/i.test(s)) issues.push('mentions the price in the spoken pitch');
  issues.push(...moneyIssues(s, input), ...ruleIssues(s, input));
  if (!/\?\s*$/.test(s)) issues.push('does not end with a question');
  if (input.mode === 'PILOT') {
    for (const f of input.findings.provisional) {
      if (new RegExp(`\\b${f.label}\\b`, 'i').test(s) && /\b(confirmed|definitely|clearly)\b/i.test(s)) issues.push(`may present provisional finding "${f.label}" as confirmed`);
    }
    if (!/sixty|60/.test(s)) issues.push('does not mention the sixty-day pilot');
  }
  return { valid: issues.length === 0, issues, words };
}

export function validatePlan(plan, input) {
  const issues = [];
  if (input.mode !== 'PILOT') return { valid: true, issues };
  for (const phase of PLAN_PHASES_COMPACT) {
    const s = text(plan?.[phase.key]);
    if (!s) { issues.push(`plan phase ${phase.key} is empty`); continue; }
    if (sentenceCount(s) > 2) issues.push(`plan phase ${phase.key} has more than two sentences`);
    if (wordCount(s) > 60) issues.push(`plan phase ${phase.key} is ${wordCount(s)} words`);
    for (const [re, why] of BANNED) if (re.test(s)) issues.push(`plan ${phase.key}: ${why}`);
    issues.push(...moneyIssues(s, input).map((x) => `plan ${phase.key}: ${x}`), ...ruleIssues(s, input).map((x) => `plan ${phase.key}: ${x}`));
  }
  return { valid: issues.length === 0, issues };
}

export function validatePitch(pitch, input) {
  const spoken = validateSpoken(pitch?.spoken, input);
  const plan = validatePlan(pitch?.plan, input);
  return { valid: spoken.valid && plan.valid, issues: [...spoken.issues, ...plan.issues], spoken: spoken, plan_valid: plan.valid, words: spoken.words };
}

// ── the model call ────────────────────────────────────────────────────────
const TOOL = {
  name: 'discovery_pitch',
  description: 'The spoken pitch and the four-phase plan.',
  input_schema: {
    type: 'object',
    properties: {
      spoken: { type: 'string', description: 'The words Joe says aloud. 150–220 words, hard maximum 250. One flowing spoken passage, no headings or bullets, ends with a question.' },
      week1: { type: 'string', description: 'Week 1 — necessary foundations and setup. At most two short sentences, specific to this agency.' },
      week2: { type: 'string', description: 'Week 2 — initial intelligence activation. At most two short sentences.' },
      weeks3_4: { type: 'string', description: 'Weeks 3–4 — expansion and refinement. At most two short sentences.' },
      weeks5_8: { type: 'string', description: 'Weeks 5–8 — progression and commercial measurement. At most two short sentences.' },
    },
    required: ['spoken', 'week1', 'week2', 'weeks3_4', 'weeks5_8'],
  },
};

const SYSTEM = `You write the words Joe will SAY to an independent UK estate-agency owner at the end of a discovery meeting, plus a four-phase plan. Natural, conversational UK English, first person ("I'd", "we'd"). Plain estate-agency language: valuations, instructions, applicants, the database, the CRM. Never: AI-powered, cross-interaction intelligence, data architecture, information optimisation, adaptive systems, "deployment rule", "dimension".

THE SPOKEN PITCH (field "spoken")
- 150 to 220 words. Hard maximum 250. One flowing passage — no headings, no bullet points, no lists of rule ids.
- Structure: briefly acknowledge their situation in their own numbers (one sentence) → the two or three opportunities in "focus", in order → what NOVUS would actually change for each (use "what_we_would_change"; combine the rules within a theme into one commercial improvement, do not list rules) → how that turns into additional valuation opportunities → what the sixty-day pilot is for (setup in the first fortnight, then run it and count valuations and instructions against the baseline) → end with a natural question inviting them to respond.
- Explain what we'd DO. Do not recite their problems back; one clause acknowledging a gap is enough before saying what changes.
- Talk only about the themes in "focus" and only the interventions in "interventions". Do not add, merge into new products, or rename anything.
- Existing strengths: one short clause saying you'd keep it and plug into it, if any.
- PROVISIONAL findings: hedge ("I'd want to check"). Interventions with feasibility REQUIRES_ASSESSMENT: "depends on what the CRM will let us see, and we'd confirm that in the first few days".
- No price, no fee, no cost. No guarantees, forecasts or promised numbers of valuations or instructions. Money figures only from allowed_money_figures, and only as "as an illustration, not a forecast".
- mode=VALIDATION: explain plainly what you'd need to confirm before proposing anything, still under 250 words, still ending with a question. No pilot pitch.
- mode=NO_PITCH: say plainly you are not recommending the pilot and why, kindly, under 250 words, ending with a question. No pilot pitch.

THE PLAN (week1, week2, weeks3_4, weeks5_8)
- Start from "plan_skeleton" and make it read naturally. At most TWO short sentences per phase, specific to this agency's selected interventions and dependencies. Keep every feasibility caveat the skeleton carries. No dates, no promises of integrations that are still to be assessed. For mode VALIDATION or NO_PITCH, put a single sentence in each phase saying what the next step would be.`;

export async function generatePitch({ session, diagnosis, call = callAi, model } = {}) {
  const input = buildPitchInput(session, diagnosis);
  const template = templatePitch(input, diagnosis);
  let raw = null;
  let error = '';
  try {
    raw = await call({
      system: SYSTEM,
      prompt: `Write the spoken pitch and the plan from this diagnosis. Return them through the tool.\n\n${JSON.stringify(input, null, 1)}`,
      tool: TOOL, purpose: 'discovery-pitch', maxTokens: 1500, ...(model ? { model } : {}),
    });
  } catch (err) {
    error = err?.message || String(err);
  }
  if (!raw) {
    return { pitch: template, source: 'TEMPLATE', sources: { spoken: 'TEMPLATE', plan: 'TEMPLATE' }, model: '', input, validation: { ...validatePitch(template, input), ai_rejected: false, ai_issues: [] }, error };
  }
  // Validate the two parts separately: a good spoken pitch is kept even if
  // the plan sentences ran long, and vice versa.
  const aiPlan = input.mode === 'PILOT' ? Object.fromEntries(PLAN_PHASES_COMPACT.map((p) => [p.key, text(raw[p.key])])) : null;
  const spokenCheck = validateSpoken(raw.spoken, input);
  const planCheck = validatePlan(aiPlan, input);
  const pitch = {
    ...template,
    spoken: spokenCheck.valid ? text(raw.spoken) : template.spoken,
    plan: input.mode === 'PILOT' ? (planCheck.valid ? aiPlan : template.plan) : null,
  };
  const sources = { spoken: spokenCheck.valid ? 'AI' : 'TEMPLATE', plan: input.mode === 'PILOT' ? (planCheck.valid ? 'AI' : 'TEMPLATE') : 'NONE' };
  const rejected = [...spokenCheck.issues, ...planCheck.issues];
  return {
    pitch, source: sources.spoken === 'AI' ? 'AI' : 'TEMPLATE', sources, model: model || '', input,
    validation: { ...validatePitch(pitch, input), ai_rejected: rejected.length > 0, ai_issues: rejected },
    error: rejected.length ? `AI output partly rejected: ${rejected.join('; ')}` : '',
  };
}

export function pitchSpoken(pitch) { return text(pitch?.spoken) || Object.values(pitch?.sections || {}).map(text).filter(Boolean).join('\n\n'); }

export const _internal = { SYSTEM, TOOL, BANNED, sentenceCount };
