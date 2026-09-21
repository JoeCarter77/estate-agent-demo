// lib/discovery-conclusion.mjs — the MEETING CONCLUSION: what Joe walks the
// owner through after discovery, built deterministically from the stored
// answers and the diagnosis. No model is needed for any of it; the optional
// polish step (polishConclusion) may only reword sentences this file already
// wrote, and every polished sentence is validated and falls back to the
// deterministic one.
//
//   Discovery → confirm understanding → commercial opportunity →
//   what NOVUS would change → 60-day deployment → £1,500 founding pilot → decision
//
//   buildFindings(base)                       the two or three grouped problems,
//                                             from the owner's own answers
//   agreementOverrides(agreement, findings)   what an owner's correction does to
//                                             the diagnosis (never to the answers)
//   buildConclusion({ session, base, agreed, conclusion })
//                                             the whole conclusion object
//   presentationPayload(conclusion)           the six client-facing screens —
//                                             no ids, codes, notes or controls
//   polishConclusion / validatePolish         optional AI wording, validated
//
// TWO DIAGNOSES. `base` is the engine over the operator's answers and
// overrides; `agreed` is the same engine with the owner's corrections applied
// as recorded overrides. Findings are reflected from `base` (so a rejected
// finding still shows as "rejected" instead of vanishing); interventions,
// deployment and scope come from `agreed`.

import { RULE_BY_ID, FOUNDING_OFFER, DELIVERY_STATUSES } from './discovery-rules.mjs';
import { THEMES, templatePlan, PLAN_PHASES_COMPACT, wordCount } from './discovery-pitch.mjs';
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
  { id: 'understanding', title: 'Confirm understanding', nav: 'Understanding', blurb: 'Reflect their situation and the two or three problems back, and get agreement' },
  { id: 'opportunity', title: 'Commercial opportunity', nav: 'Opportunity', blurb: 'Their fee, their conversion, illustrative additional valuations' },
  { id: 'changes', title: 'What NOVUS would change', nav: 'Changes', blurb: 'The specific changes, what is preserved, what has to be true' },
  { id: 'deployment', title: '60-day deployment', nav: 'Deployment', blurb: 'Four phases, adapted to the diagnosis' },
  { id: 'pilot', title: 'Founding pilot', nav: 'Pilot', blurb: '£1,500 all-in for sixty days, scope and success criteria' },
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
export const GROUP_NOUNS = Object.freeze({ capture: 'capturing what your team hear', progress: 'progressing every seller', opportunities: 'finding the opportunities already in your demand', measure: 'measuring what works' });
export function clientSafe(value) {
  return text(value).replace(/^[FI][1-5]:\s*/, '').replace(/\b(?:Activate|Add)\s+([FI][1-5])\s+/g, '$1 ').replace(/\b([FI][1-5])\b/g, (id) => RULE_SHORT_NAMES[id] || id);
}
const COMMERCIAL_CONSEQUENCES = new Set(['missed_sellers', 'lost_valuations', 'competitor_wins', 'missed_reactivation', 'missed_ready', 'untouched_value', 'missed_context', 'late']);

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
    objective: { priority: diagnosis.objective.priority, priority_label: diagnosis.objective.priority_label, obstacles: diagnosis.objective.obstacles.map((o) => o.label), notes: diagnosis.objective.notes },
    missing: ['enquiries_per_month', 'database_size', 'valuations_per_month', 'instructions_per_month', 'fee_per_instruction', 'conversion_pct'].filter((k) => !fig(b[k], String).known),
  };
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
    if (priority === 'more_valuations' && group.id === 'opportunities') score += 1.5;
    if (priority === 'win_instructions' && group.id === 'capture') score += 0.5;
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
const PHASE_MAP = Object.freeze({ week1: ['p1', 'p2'], week2: ['p3'], weeks3_4: ['p4'], weeks5_8: ['p5'] });
export function buildDeployment(agreed) {
  const compact = agreed.suitability.verdict === 'POTENTIAL_FIT' ? templatePlan(agreed) : null;
  const phases = agreed.plan?.phases || [];
  const hasFoundations = agreed.plan?.generated_from?.rules?.some((id) => id.startsWith('F'));
  const first = agreed.plan?.generated_from?.first_workflow || '';
  const titles = {
    week1: hasFoundations ? 'Scope, access and necessary foundations' : 'Scope, access and reuse of what already works',
    week2: first ? 'Activate the initial intelligence workflow' : 'Activate the first workflow',
    weeks3_4: 'Expand and refine',
    weeks5_8: 'Progress opportunities and measure commercial results',
  };
  return {
    phases: PLAN_PHASES_COMPACT.map((p) => {
      const detail = phases.filter((x) => PHASE_MAP[p.key].includes(x.id));
      return {
        key: p.key, title: p.title, heading: titles[p.key], summary: compact ? clientSafe(compact[p.key]) : '',
        novus_does: detail.flatMap((x) => x.novus_does), agency_does: detail.flatMap((x) => x.agency_does),
        changes: detail.flatMap((x) => x.changes), owner_sees: detail.flatMap((x) => x.owner_sees), measures: detail.flatMap((x) => x.measures),
      };
    }),
    first_workflow: first, rules: agreed.plan?.generated_from?.rules || [], required_access: agreed.plan?.required_access || [],
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
  for (const g of conclusion.changes.groups) {
    const p = polish.changes?.[g.id];
    if (!p) continue;
    if (p.original === g.change && text(p.text)) { g.change_polished = text(p.text); applied += 1; } else stale += 1;
  }
  return { applied, stale };
}

export function buildConclusion({ session, base, agreed, conclusion: stored } = {}) {
  const findings = buildFindings(base);
  const state = cleanConclusion(stored, findings);
  const agreement = state.agreement;
  const situation = buildSituation(session, agreed);
  const changes = buildChanges(agreed, findings, agreement);
  const name = situation.owner_first_name;
  const mode = agreed.suitability.verdict === 'POTENTIAL_FIT' ? 'PILOT' : agreed.suitability.verdict === 'FURTHER_VALIDATION_REQUIRED' ? 'VALIDATION' : 'NO_PITCH';
  const outsideScope = base.findings.outside_scope.map((a) => ({ dimension: a.dimension, label: a.label, note: 'A process exists but is not followed — a management matter, not something NOVUS fixes.' }));
  const out = {
    version: 1, mode, generated_at: new Date().toISOString(),
    understanding: {
      opening: `Right${name ? ` ${name}` : ''}, correct me if I'm wrong, but this is what I've understood from our conversation...`,
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
    deployment: buildDeployment(agreed),
    pilot: buildPilot(agreed, changes, state.scope_rule_ids, situation),
    suitability: { verdict: agreed.suitability.verdict, recommendation: agreed.suitability.recommendation, reasons: agreed.suitability.reasons },
    next_step: nextStepFor(agreed.suitability, situation),
    state: { agreement, additional_valuations: state.additional_valuations, scope_rule_ids: state.scope_rule_ids, updated_at: state.updated_at },
    owner_overrides: agreementOverrides(agreement, findings),
    polish: null,
  };
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
      id: 'opportunity', title: 'Commercial opportunity', subtitle: opp.available ? 'Using your own figures' : 'Your figures',
      available: opp.available,
      fee: opp.fee_per_instruction.value !== null ? gbp(opp.fee_per_instruction.value) : '', conversion: opp.conversion_pct.value !== null ? `${opp.conversion_pct.value}%` : '',
      per_valuation: opp.expected_fee_income_per_valuation_gbp !== null ? gbp(opp.expected_fee_income_per_valuation_gbp) : '',
      rows: opp.rows.map((r) => ({ n: r.additional_valuations_per_month, monthly: gbp(r.monthly_gbp), annual: gbp(r.annual_gbp) })),
      selected: opp.selected_additional_valuations,
      label: opp.label, footnote: 'Illustrative scenarios from the figures given in this meeting — not forecasts, not guarantees.',
      missing: opp.available ? [] : opp.missing,
    },
    {
      id: 'help', title: 'How NOVUS would help', subtitle: c.mode === 'PILOT' ? 'What we would change, and what stays as it is' : 'What we would need to confirm first',
      groups: c.changes.groups.map((g) => ({
        title: g.short,
        problem_points: g.problem_points.slice(0, 2),
        change_points: g.change_polished ? [g.change_polished] : g.rules.map((r) => cap(r.spoken_change)).slice(0, 3),
        effect: g.effect, preserve: g.preserve,
        subject_to: g.conditions.filter((x) => x.kind !== 'delivery').map((x) => clientSafe(x.text)).slice(0, 1),
      })),
      preserved: c.changes.preserved.map((p) => p.label), foundations_note: c.changes.foundations_note,
      next_step: c.mode === 'PILOT' ? '' : c.next_step,
    },
    {
      id: 'deployment', title: 'Your 60-day deployment', subtitle: c.mode === 'PILOT' ? 'Four phases' : 'What would happen next',
      phases: c.deployment.phases.map((p) => ({ title: p.title, heading: p.heading, summary: p.summary, points: [...p.changes.filter((x) => !/^Preserved:/.test(x) && !/^Nothing changes/.test(x)).slice(0, 2), ...p.owner_sees.slice(0, 1)].map(clientSafe) })),
      caveat: c.deployment.caveat, proposed: c.mode === 'PILOT',
    },
    {
      id: 'pilot', title: 'Founding pilot', subtitle: c.pilot.proposed ? c.pilot.headline : 'Not today',
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
  const changes = conclusion.changes.groups.map((g) => ({ id: g.id, text: g.change }));
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
