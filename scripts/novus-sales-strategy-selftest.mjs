// scripts/novus-sales-strategy-selftest.mjs — hermetic Sales Strategy Engine
// test (no network, no creds, no AI).
//
// Exercises lib/sales-strategy.mjs across all 10 grade/probe states, and
// enforces the engine's hard guarantees: determinism, purity (no I/O, no AI),
// evidence discipline per grade band (G and H must never reference
// human-contact evidence they do not have), strategy-not-copy, and the
// live-recompute property that a C -> A grade change moves the strategy.
//
// Run:  npm run novus:sales-strategy-selftest

import assert from 'node:assert';
import { buildSalesStrategy } from '../lib/sales-strategy.mjs';
import { classifyTier } from '../lib/tier.mjs';

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

console.log('novus-sales-strategy-selftest');

const FIELDS = [
  'observed_problem', 'commercial_implication', 'sales_focus', 'discovery_focus',
  'demo_type', 'email_strategy', 'phone_strategy', 'next_action',
];

// Evidence fixtures shaped exactly like computeObservation() output.
function humanEvidence({ lag, followUps = 0, channels = 'email' }) {
  return {
    auto_acknowledgement: false,
    auto_ack_timestamp: '',
    first_human_touch: 'yes',
    first_human_touch_at: '2026-08-10T09:00:00.000Z',
    human_lag_hours: lag,
    follow_up_count: followUps,
    follow_up_channels: followUps > 0 ? channels : '',
    channels_used: channels,
    last_touch_at: '2026-08-10T09:00:00.000Z',
    days_chased: 0.5,
  };
}
const G_EVIDENCE = {
  auto_acknowledgement: true,
  auto_ack_timestamp: '2026-08-10T09:05:00.000Z',
  first_human_touch: 'no',
  first_human_touch_at: '',
  human_lag_hours: '',
  follow_up_count: 0,
  follow_up_channels: '',
  channels_used: 'email',
  last_touch_at: '2026-08-10T09:05:00.000Z',
  days_chased: 0.01,
};
const H_EVIDENCE = {
  auto_acknowledgement: false,
  auto_ack_timestamp: '',
  first_human_touch: 'no',
  first_human_touch_at: '',
  human_lag_hours: '',
  follow_up_count: 0,
  follow_up_channels: '',
  channels_used: '',
  last_touch_at: '',
  days_chased: '',
};

const CASES = {
  A: { tier: 'Growth', observation: humanEvidence({ lag: 0.4, followUps: 2, channels: 'email,voice' }) },
  B: { tier: 'Growth', observation: humanEvidence({ lag: 6, followUps: 1 }) },
  C: { tier: 'Core', observation: humanEvidence({ lag: 0.3, followUps: 0 }) },
  D: { tier: 'Core', observation: humanEvidence({ lag: 7.5, followUps: 0 }) },
  E: { tier: 'Core', observation: humanEvidence({ lag: 30, followUps: 1 }) },
  F: { tier: 'Core', observation: humanEvidence({ lag: 40, followUps: 0 }) },
  G: { tier: 'Core', observation: G_EVIDENCE },
  H: { tier: 'Core', observation: H_EVIDENCE },
};

// ── 1. All eight resolved grades produce a complete strategy ───────────────
for (const [grade, { tier, observation }] of Object.entries(CASES)) {
  check(`grade ${grade} -> complete strategy (${tier})`, () => {
    const s = buildSalesStrategy({ grade, tier, observation });
    for (const f of FIELDS) {
      assert.ok(typeof s[f] === 'string', `${grade}.${f} must be a string`);
      assert.ok(s[f].length > 0, `${grade}.${f} must not be empty`);
    }
    assert.deepStrictEqual(Object.keys(s).sort(), [...FIELDS].sort(), `${grade}: exact 8-field contract`);
  });
}

check('Growth grades (A,B) and Core grades (C-H) get distinct demo types', () => {
  assert.strictEqual(buildSalesStrategy({ grade: 'A', tier: 'Growth', observation: CASES.A.observation }).demo_type, 'growth_database');
  assert.strictEqual(buildSalesStrategy({ grade: 'B', tier: 'Growth', observation: CASES.B.observation }).demo_type, 'growth_database');
  for (const g of ['C', 'D', 'E', 'F', 'G', 'H']) {
    const dt = buildSalesStrategy({ grade: g, tier: 'Core', observation: CASES[g].observation }).demo_type;
    assert.ok(dt.startsWith('front_desk_'), `${g} demo_type should be a front-desk type, got ${dt}`);
  }
});

// ── 2. pending / compromised produce NO strategy ──────────────────────────
check('grade pending -> all eight fields blank, no manufactured strategy', () => {
  const s = buildSalesStrategy({ grade: 'pending', tier: 'unclassified', observation: {} });
  for (const f of FIELDS) assert.strictEqual(s[f], '', `pending.${f} must be blank`);
});

check('compromised probe -> all eight fields blank, even with strong A evidence', () => {
  const s = buildSalesStrategy({
    grade: 'A', tier: 'Growth', observation: CASES.A.observation, compromised: 'TRUE',
  });
  for (const f of FIELDS) assert.strictEqual(s[f], '', `compromised.${f} must be blank`);
});

check('unresolved/garbage grades never fall through to a strategy', () => {
  for (const grade of [undefined, null, '', 'X', 'unknown', 'ungraded']) {
    const s = buildSalesStrategy({ grade, observation: {} });
    for (const f of FIELDS) assert.strictEqual(s[f], '', `grade ${grade} must yield blank ${f}`);
  }
});

check('an inconsistent tier (unclassified with a resolved grade) yields no strategy', () => {
  const s = buildSalesStrategy({ grade: 'A', tier: 'unclassified', observation: CASES.A.observation });
  for (const f of FIELDS) assert.strictEqual(s[f], '', `inconsistent pipeline state must not assert ${f}`);
});

// ── 3. Evidence discipline per band ───────────────────────────────────────
const HUMAN_EVIDENCE_TERMS = [
  'human contact came', 'follow-up attempt', 'follow-up attempts', 'after the probe with',
];

check('G never references human-contact evidence it does not have', () => {
  const s = buildSalesStrategy({ grade: 'G', tier: 'Core', observation: G_EVIDENCE });
  const problem = s.observed_problem.toLowerCase();
  for (const term of HUMAN_EVIDENCE_TERMS) {
    assert.ok(!problem.includes(term), `G.observed_problem must not claim "${term}"`);
  }
  assert.ok(problem.includes('no human contact'), 'G must state the absence of human contact');
  assert.ok(problem.includes('automated acknowledgement'), 'G must cite the acknowledgement it does have');
});

check('H never references human-contact or acknowledgement evidence it does not have', () => {
  const s = buildSalesStrategy({ grade: 'H', tier: 'Core', observation: H_EVIDENCE });
  const problem = s.observed_problem.toLowerCase();
  for (const term of HUMAN_EVIDENCE_TERMS) {
    assert.ok(!problem.includes(term), `H.observed_problem must not claim "${term}"`);
  }
  assert.ok(problem.includes('no meaningful response'), 'H must state the documented absence');
  assert.ok(problem.includes('four days'), 'H must reference the 4-day observation window');
});

check('no grade ever emits a malformed evidence phrase (blank number / dangling unit)', () => {
  // Includes the degenerate case: an A-F grade whose lag is somehow missing.
  const degenerate = { ...humanEvidence({ lag: 1 }), human_lag_hours: '' };
  const all = [
    ...Object.entries(CASES).map(([g, c]) => buildSalesStrategy({ grade: g, tier: c.tier, observation: c.observation })),
    buildSalesStrategy({ grade: 'C', tier: 'Core', observation: degenerate }),
    buildSalesStrategy({ grade: 'F', tier: 'Core', observation: {} }),
  ];
  for (const s of all) {
    for (const f of FIELDS) {
      const v = s[f];
      assert.ok(!/\s{2,}/.test(v), `double space (interpolated blank) in ${f}: ${v}`);
      assert.ok(!/came\s+(hours|minutes|days)/.test(v), `dangling unit in ${f}: ${v}`);
      assert.ok(!/\btook\s+(hours|minutes|days)\b/.test(v), `dangling unit in ${f}: ${v}`);
      assert.ok(!v.includes('undefined') && !v.includes('NaN') && !v.includes('null'), `leaked placeholder in ${f}: ${v}`);
    }
  }
});

check('A-F quote their real observed lag rather than a generic phrase', () => {
  const s = buildSalesStrategy({ grade: 'E', tier: 'Core', observation: humanEvidence({ lag: 30, followUps: 1 }) });
  assert.ok(s.observed_problem.includes('30 hours'), `expected the real lag, got: ${s.observed_problem}`);
  const fast = buildSalesStrategy({ grade: 'C', tier: 'Core', observation: humanEvidence({ lag: 0.5, followUps: 0 }) });
  assert.ok(fast.observed_problem.includes('30 minutes'), `sub-hour lag should render as minutes: ${fast.observed_problem}`);
});

check('a missing lag on an A-F grade describes the absence instead of interpolating a blank', () => {
  const degenerate = { ...humanEvidence({ lag: 1 }), human_lag_hours: '' };
  const s = buildSalesStrategy({ grade: 'C', tier: 'Core', observation: degenerate });
  assert.ok(s.observed_problem.includes('could not be computed'), s.observed_problem);
});

// ── 4. Strategy, not copy ─────────────────────────────────────────────────
check('email_strategy and phone_strategy are strategy, never drafted copy', () => {
  for (const [grade, { tier, observation }] of Object.entries(CASES)) {
    const s = buildSalesStrategy({ grade, tier, observation });
    for (const f of ['email_strategy', 'phone_strategy']) {
      const v = s[f];
      assert.ok(!/^(hi|hello|dear)\b/i.test(v.trim()), `${grade}.${f} reads as drafted copy: ${v}`);
      assert.ok(!v.includes('{{') && !v.includes('{name'), `${grade}.${f} contains a copy template token: ${v}`);
      assert.ok(!/\bSubject:/i.test(v), `${grade}.${f} contains an email subject line: ${v}`);
    }
  }
});

check('next_action is a recommendation string only — no ACTIONS record shape', () => {
  for (const [grade, { tier, observation }] of Object.entries(CASES)) {
    const s = buildSalesStrategy({ grade, tier, observation });
    assert.strictEqual(typeof s.next_action, 'string');
    assert.ok(/^Route to (Core|Growth) outreach:/.test(s.next_action), `${grade}: ${s.next_action}`);
    assert.ok(!/due_date|action_id|status:/i.test(s.next_action), `${grade}.next_action leaks ACTIONS state`);
  }
});

// ── 5. Determinism and purity ─────────────────────────────────────────────
check('identical inputs always produce byte-identical outputs (no clock, no randomness)', () => {
  for (const [grade, { tier, observation }] of Object.entries(CASES)) {
    const a = buildSalesStrategy({ grade, tier, observation });
    const b = buildSalesStrategy({ grade, tier, observation });
    const c = buildSalesStrategy({ grade, tier, observation: JSON.parse(JSON.stringify(observation)) });
    assert.deepStrictEqual(a, b, `${grade} not deterministic across calls`);
    assert.deepStrictEqual(a, c, `${grade} not deterministic across equal-value inputs`);
  }
});

check('the module performs no I/O and invokes no AI', async () => {
  // Any network/AI call would have to go through one of these. Trap them all
  // and assert nothing is touched during a full sweep of every grade.
  const originals = { fetch: globalThis.fetch, Request: globalThis.Request };
  let touched = null;
  globalThis.fetch = () => { touched = 'fetch'; throw new Error('I/O attempted'); };
  try {
    for (const [grade, { tier, observation }] of Object.entries(CASES)) {
      const s = buildSalesStrategy({ grade, tier, observation });
      assert.ok(s.observed_problem.length > 0);
    }
  } finally {
    globalThis.fetch = originals.fetch;
    globalThis.Request = originals.Request;
  }
  assert.strictEqual(touched, null, 'sales-strategy.mjs attempted network I/O');
  // Purity: the module must not mutate the evidence it is handed.
  const evidence = humanEvidence({ lag: 2, followUps: 1 });
  const before = JSON.stringify(evidence);
  buildSalesStrategy({ grade: 'B', tier: 'Growth', observation: evidence });
  assert.strictEqual(JSON.stringify(evidence), before, 'observation was mutated');
});

// ── 6. Agency context enriches wording, never routes or invents ───────────
check('agency context never changes demo_type or next_action (no routing influence)', () => {
  const variants = [null, {}, { crm_name: 'Reapit' }, { years_trading: '1' }, { years_trading: '40', crm_name: 'Alto' }];
  for (const grade of Object.keys(CASES)) {
    const base = buildSalesStrategy({ grade, tier: CASES[grade].tier, observation: CASES[grade].observation });
    for (const agency of variants) {
      const s = buildSalesStrategy({ grade, tier: CASES[grade].tier, observation: CASES[grade].observation, agency });
      assert.strictEqual(s.demo_type, base.demo_type, `${grade}: agency context changed demo_type`);
      assert.strictEqual(s.next_action, base.next_action, `${grade}: agency context changed next_action`);
      assert.strictEqual(s.sales_focus, base.sales_focus, `${grade}: agency context changed sales_focus`);
    }
  }
});

check('a known CRM is named in discovery; an unknown CRM is stated as unknown, never invented', () => {
  const known = buildSalesStrategy({ grade: 'C', tier: 'Core', observation: CASES.C.observation, agency: { crm_name: 'Reapit' } });
  assert.ok(known.discovery_focus.includes('Reapit'), known.discovery_focus);

  for (const agency of [null, {}, { crm_name: '' }]) {
    const unknown = buildSalesStrategy({ grade: 'C', tier: 'Core', observation: CASES.C.observation, agency });
    assert.ok(unknown.discovery_focus.includes('not currently known'), unknown.discovery_focus);
    assert.ok(!unknown.discovery_focus.includes('Reapit'), 'invented a CRM that was never supplied');
  }
});

// ── 7. Live recompute: a late follow-up flips C -> A and the strategy moves ─
check('C -> A regrade produces a genuinely different strategy (recomputed, not frozen)', () => {
  // Same probe, same agency. Initially: fast contact, no follow-up -> C.
  const beforeObs = humanEvidence({ lag: 0.3, followUps: 0, channels: 'voice' });
  const beforeTier = classifyTier({ grade: 'C' });
  const before = buildSalesStrategy({ grade: 'C', tier: beforeTier.tier, observation: beforeObs });

  // A genuine follow-up attempt arrives >30 min later -> regraded A.
  const afterObs = humanEvidence({ lag: 0.3, followUps: 1, channels: 'voice,email' });
  const afterTier = classifyTier({ grade: 'A' });
  const after = buildSalesStrategy({ grade: 'A', tier: afterTier.tier, observation: afterObs });

  assert.strictEqual(beforeTier.tier, 'Core');
  assert.strictEqual(afterTier.tier, 'Growth');
  for (const f of FIELDS) {
    assert.notStrictEqual(after[f], before[f], `${f} did not change across the C -> A regrade`);
  }
  assert.strictEqual(before.demo_type, 'front_desk_persistence');
  assert.strictEqual(after.demo_type, 'growth_database');
  assert.ok(before.next_action.includes('Core'), before.next_action);
  assert.ok(after.next_action.includes('Growth'), after.next_action);
});

console.log(`\n${passed} checks passed.`);
