// lib/discovery-pitch.mjs — personalised pitch generation for the meeting
// discovery workspace.
//
// The pitch is an EXPLANATION of a diagnosis the deterministic engine
// already made (lib/discovery-engine.mjs). The model receives only the
// structured findings, the selected rules' own wording, the plan and the
// offer, and must return the eight spoken sections as a tool result. It is
// not told about rules that were not selected, so it cannot pitch them, and
// every result is validated before it is stored:
//
//   · no invented money figures (every £ amount must be one we supplied)
//   · no guarantees or AI marketing language
//   · no mention of a rule that was not proposed
//   · every required section present
//
// If generation fails or validation rejects it, a deterministic TEMPLATE
// pitch built from the rules' pitch_explanation strings is returned instead,
// flagged as such, so the meeting never ends without something to say and
// the discovery data is untouched either way.
//
// What is NOT sent to the model: contact emails, phone numbers, addresses,
// previous call transcripts, or anything about the agency's customers.

import { callAi } from './ai-client.mjs';
import { RULE_BY_ID, FOUNDING_OFFER, DELIVERY_STATUSES } from './discovery-rules.mjs';

const text = (value) => String(value ?? '').trim();
const firstName = (name) => text(name).split(/\s+/)[0] || '';

export const PITCH_SECTIONS = Object.freeze([
  { key: 'situation', title: 'Where you are' },
  { key: 'gaps', title: 'What we heard' },
  { key: 'interventions', title: 'What we would do' },
  { key: 'preserved', title: 'What we would leave alone' },
  { key: 'together', title: 'How it fits together' },
  { key: 'plan_60_days', title: 'The first sixty days' },
  { key: 'measurement', title: 'How we would know it worked' },
  { key: 'pilot_offer', title: 'The founding pilot' },
]);

const BANNED = [
  [/guarantee/i, 'uses "guarantee"'],
  [/\bAI[- ]powered\b/i, 'AI marketing language'],
  [/revolutioni[sz]e|revolutionary|cutting[- ]edge|game[- ]chang/i, 'generic marketing language'],
  [/cross-interaction intelligence|data architecture|information optimi[sz]ation|adaptive commercial system/i, 'technical jargon the brief forbids'],
];

// ── the input the model (and the template) sees ───────────────────────────
export function buildPitchInput(session, diagnosis) {
  const d = diagnosis;
  const proposed = d.interventions.filter((i) => i.selected);
  const rules = proposed.map((i) => {
    const r = RULE_BY_ID[i.rule_id];
    return {
      rule_id: i.rule_id, title: r.title, kind: r.kind, intervention: r.intervention, pitch_explanation: r.pitch_explanation,
      delivery_status: DELIVERY_STATUSES[i.delivery_status], feasibility: i.feasibility, confidence: i.confidence,
      dependencies: i.dependencies.map((dep) => dep.note), assessment_items: i.assessment_items, scope_limitations: r.scope_limitations,
      agency_does: r.agency_responsibilities, novus_does: r.novus_responsibilities, measurement: r.measurement,
    };
  });
  const finding = (a) => ({
    dimension: a.dimension, label: a.label, level: a.level, evidence_status: a.evidence_status, verified: a.verified,
    what_they_said: a.primary_label, causes: a.causes.map((c) => c.label), consequences: a.consequences.map((c) => c.label),
    frequency: a.frequency, example: a.example, owner_notes: a.owner_notes,
  });
  const money = new Set();
  const b = d.economics.baseline;
  if (b.fee_per_instruction.value !== null) money.add(Math.round(b.fee_per_instruction.value));
  for (const ill of d.economics.illustrations) { money.add(ill.additional_fee_income_per_month_gbp); money.add(ill.additional_fee_income_per_year_gbp); }
  money.add(FOUNDING_OFFER.price_gbp);
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
    blockers: d.blockers, validation: d.validation,
    plan: d.plan.phases.map((p) => ({ days: p.days, title: p.title, novus_does: p.novus_does, agency_does: p.agency_does, owner_sees: p.owner_sees })),
    measurement: d.plan.measurement,
    suitability: d.suitability,
    offer: FOUNDING_OFFER,
    allowed_money_figures: [...money],
  };
}

// ── deterministic template ────────────────────────────────────────────────
function list(items, sep = ', ') { return items.filter(Boolean).join(sep); }

export function templatePitch(input) {
  const a = input.agency;
  const name = a.owner_first_name ? `${a.owner_first_name}, ` : '';
  const b = input.baseline;
  const numbers = [];
  if (b.valuations_per_month.value !== null) numbers.push(`around ${b.valuations_per_month.value} valuations a month`);
  if (b.instructions_per_month.value !== null) numbers.push(`${b.instructions_per_month.value} instructions`);
  if (b.enquiries_per_month.value !== null) numbers.push(`roughly ${b.enquiries_per_month.value} enquiries coming in`);
  if (b.database_size.value !== null) numbers.push(`a database of about ${b.database_size.value} contacts`);
  const situation = `${name}from what you've told me, ${a.name} is ${a.branches ? `${a.branches} branch${a.branches === 1 ? '' : 'es'} on ${a.crm || 'your current CRM'}` : `running on ${a.crm || 'your current CRM'}`}${numbers.length ? `, doing ${list(numbers, ', ')}` : ''}. The thing you want most is ${input.objective.priority_label ? input.objective.priority_label.toLowerCase() : 'more from the sales side'}${input.objective.obstacles.length ? `, and what's getting in the way is ${list(input.objective.obstacles.map((o) => o.label.toLowerCase()), ' and ')}` : ''}.`;

  const confirmed = input.findings.confirmed;
  const provisional = input.findings.provisional;
  const gapLine = (f) => `${f.label.toLowerCase()}: you said "${f.what_they_said.toLowerCase()}"${f.causes.length ? ` — ${list(f.causes.map((c) => c.toLowerCase()), ', ')}` : ''}${f.consequences.length ? `, and it's costing you ${list(f.consequences.map((c) => c.toLowerCase()), ' and ')}` : ''}`;
  const gaps = confirmed.length || provisional.length
    ? `The gaps that matter commercially are ${list(confirmed.map(gapLine), '; ')}${provisional.length ? `. There are a couple I'd want to check rather than assume — ${list(provisional.map((f) => f.label.toLowerCase()), ', ')} — because we didn't get to the bottom of them today` : ''}.`
    : 'We did not establish a commercially meaningful gap today.';

  const feasible = input.interventions.filter((i) => ['FEASIBLE', 'FEASIBLE_WITH_FOUNDATION'].includes(i.feasibility));
  const assess = input.interventions.filter((i) => i.feasibility === 'REQUIRES_ASSESSMENT');
  const interventions = input.mode === 'PILOT'
    ? `Here's exactly what we'd do. ${list(feasible.map((i) => i.pitch_explanation), ' ')}${assess.length ? ` There's one more thing that depends on what your CRM will let us see — ${list(assess.map((i) => i.title.toLowerCase()), ' and ')} — and we'd confirm that in the first three days rather than promise it now.` : ''}`
    : input.mode === 'VALIDATION'
      ? `I'm not going to propose the pilot today, because ${input.suitability.recommendation}`
      : `I'm going to be straight with you: I don't think we should run the pilot. ${input.suitability.recommendation}`;

  const strengths = input.findings.strengths;
  const preserved = strengths.length
    ? `What we wouldn't touch: ${list(strengths.map((s) => `${s.label.toLowerCase()} — ${s.what_they_said.toLowerCase()}${s.verified === false ? ' (we\'d confirm that in the first few days)' : ''}`), '; ')}. That already works, and we'd plug into it rather than replace it.`
    : 'We didn\'t find an existing process today that we\'d be replacing — everything proposed sits alongside how you work now.';

  const together = feasible.length
    ? `How it fits together: ${feasible.some((i) => i.kind === 'foundation') ? 'the foundation work makes sure what your team hear gets recorded and followed up, ' : ''}${feasible.some((i) => i.kind === 'intelligence') ? 'and the intelligence work finds the sellers that are already in your enquiries and your database and puts them in front of the team in the right order' : 'and the outcome tracking shows you what it produced'}. None of it asks your team to work a different system — it changes what turns up on their list and what you can see.`
    : '';

  const plan = input.mode === 'PILOT'
    ? `The first sixty days: ${list(input.plan.map((p) => `days ${p.days} — ${p.title.toLowerCase()}${p.novus_does[0] ? ` (${p.novus_does[0].toLowerCase()})` : ''}`), '; ')}. Setup is targeted at about fourteen days; the rest is the workflow running and being reviewed.`
    : '';
  const measurement = input.mode === 'PILOT'
    ? `How we'd know it worked: we record the baseline in the first three days, then ${list(input.measurement.slice(0, 4).map((m) => m.toLowerCase()), '; ')}. Only valuations and instructions we can actually attribute count.${input.illustrations.length ? ` To put a number on why it matters — purely as an illustration, not a forecast — ${input.illustrations[1].additional_valuations_per_month} extra valuations a month at your conversion and fee would be about £${input.illustrations[1].additional_fee_income_per_month_gbp.toLocaleString('en-GB')} a month.` : ''}`
    : '';
  const pilot = input.mode === 'PILOT'
    ? `The founding pilot is £${FOUNDING_OFFER.price_gbp.toLocaleString('en-GB')} all-in for sixty days. ${FOUNDING_OFFER.commitment} ${FOUNDING_OFFER.scope} ${FOUNDING_OFFER.success_criteria} ${FOUNDING_OFFER.extension} ${FOUNDING_OFFER.continuation}`
    : '';

  return {
    mode: input.mode,
    sections: { situation, gaps, interventions, preserved, together, plan_60_days: plan, measurement, pilot_offer: pilot },
    rule_ids_used: input.interventions.map((i) => i.rule_id),
    confidence_note: provisional.length || assess.length ? 'Some findings are provisional and some interventions depend on a technical assessment; the pitch says so.' : '',
  };
}

// ── validation ────────────────────────────────────────────────────────────
export function validatePitch(pitch, input) {
  const issues = [];
  const sections = pitch?.sections || {};
  const required = input.mode === 'PILOT' ? PITCH_SECTIONS.map((s) => s.key) : ['situation', 'gaps', 'interventions', 'preserved'];
  for (const key of required) if (!text(sections[key])) issues.push(`missing section: ${key}`);
  const all = PITCH_SECTIONS.map((s) => text(sections[s.key])).join('\n');
  for (const [re, why] of BANNED) if (re.test(all)) issues.push(why);
  const allowed = new Set((input.allowed_money_figures || []).map((n) => Math.round(Number(n))));
  for (const match of all.matchAll(/£\s?([\d,]+(?:\.\d+)?)(\s?k)?/gi)) {
    let n = Number(match[1].replace(/,/g, ''));
    if (match[2]) n *= 1000;
    if (!allowed.has(Math.round(n))) issues.push(`money figure not from discovery: £${match[1]}${match[2] || ''}`);
  }
  const proposed = new Set(input.interventions.map((i) => i.rule_id));
  for (const [id, rule] of Object.entries(RULE_BY_ID)) {
    if (proposed.has(id)) continue;
    if (new RegExp(`\\b${id}\\b`).test(all) || all.toLowerCase().includes(rule.title.toLowerCase())) issues.push(`mentions a rule that was not proposed: ${id}`);
  }
  if (input.mode !== 'PILOT' && /£\s?1,?500/.test(all)) issues.push('offers the pilot price in a no-pitch/validation outcome');
  if (input.mode === 'PILOT') {
    const provisional = input.findings.provisional.map((f) => f.label);
    for (const label of provisional) {
      if (new RegExp(`\\b${label}\\b`, 'i').test(sections.gaps || '') && /\b(confirmed|definitely|clearly)\b/i.test(sections.gaps || '')) issues.push(`may present provisional finding "${label}" as confirmed`);
    }
  }
  return { valid: issues.length === 0, issues };
}

// ── the model call ────────────────────────────────────────────────────────
const TOOL = {
  name: 'discovery_pitch',
  description: 'The personalised pitch, as eight sections to be spoken aloud.',
  input_schema: {
    type: 'object',
    properties: Object.fromEntries(PITCH_SECTIONS.map((s) => [s.key, { type: 'string', description: s.title }])),
    required: PITCH_SECTIONS.map((s) => s.key),
  },
};

const SYSTEM = `You write the words Joe will SAY to an independent UK estate-agency owner at the end of a discovery meeting. Conversational, plain estate-agency English, first person plural ("we"). No headings, no bullet points, no introductions, no jargon (never say AI-powered, cross-interaction intelligence, data architecture, information optimisation, adaptive systems). Each section is one to four spoken paragraphs; keep the whole thing under 900 words.

HARD RULES
- You are explaining a diagnosis that has already been made. Do not add, remove, merge or rename interventions. Describe ONLY the interventions supplied, using their own wording as the basis.
- CONFIRMED findings may be stated. PROVISIONAL findings must be framed as something to confirm ("I'd want to check…"). UNKNOWN dimensions are not findings; do not mention them as problems.
- Existing strengths must be recognised explicitly as things you would preserve and plug into, not replace.
- Interventions whose feasibility is REQUIRES_ASSESSMENT must be framed as dependent on a check in the first three days. Never promise an integration.
- Never guarantee, forecast or imply a number of valuations, instructions or revenue. Illustrations may be quoted only with the words "as an illustration, not a forecast", and you may only use money figures that appear in allowed_money_figures.
- Do not repeat the discovery back as a list. Translate it into the specific change we would make inside their agency and why that could produce additional valuations and instructions.
- mode=PILOT: all eight sections, ending with the founding pilot exactly as supplied (£1,500 all-in, 60 days, ~14-day setup, no long-term commitment, success criteria agreed first, the bounded extension, continuation pricing not fixed). No other pricing.
- mode=VALIDATION: sections situation, gaps, interventions ("here is what I'd need to confirm before proposing anything"), preserved. Leave the others empty. Do not offer the pilot or its price.
- mode=NO_PITCH: sections situation, gaps ("what we heard"), interventions ("why I'm not proposing the pilot"), preserved. Say plainly that you are not recommending the pilot and why. Leave the others empty. No price.`;

export async function generatePitch({ session, diagnosis, call = callAi, model } = {}) {
  const input = buildPitchInput(session, diagnosis);
  let pitch = null;
  let error = '';
  let source = 'AI';
  try {
    const raw = await call({
      system: SYSTEM,
      prompt: `Write the pitch from this diagnosis. Return it through the tool.\n\n${JSON.stringify(input, null, 1)}`,
      tool: TOOL, purpose: 'discovery-pitch', maxTokens: 4000, ...(model ? { model } : {}),
    });
    pitch = {
      mode: input.mode,
      sections: Object.fromEntries(PITCH_SECTIONS.map((s) => [s.key, text(raw?.[s.key])])),
      rule_ids_used: input.interventions.map((i) => i.rule_id),
      confidence_note: input.findings.provisional.length || input.interventions.some((i) => i.feasibility === 'REQUIRES_ASSESSMENT') ? 'Some findings are provisional and some interventions depend on a technical assessment.' : '',
    };
  } catch (err) {
    error = err?.message || String(err);
    pitch = null;
  }
  let validation = pitch ? validatePitch(pitch, input) : { valid: false, issues: [error || 'generation failed'] };
  if (!pitch || !validation.valid) {
    const template = templatePitch(input);
    const templateValidation = validatePitch(template, input);
    return {
      pitch: template, source: 'TEMPLATE', model: '', input,
      validation: { ...templateValidation, ai_rejected: Boolean(pitch), ai_issues: validation.issues },
      error: error || (pitch ? `AI pitch rejected: ${validation.issues.join('; ')}` : ''),
    };
  }
  return { pitch, source, model: model || '', input, validation, error: '' };
}

export function pitchSpoken(pitch) {
  return PITCH_SECTIONS.map((s) => text(pitch?.sections?.[s.key])).filter(Boolean).join('\n\n');
}

export const _internal = { SYSTEM, TOOL, BANNED };
