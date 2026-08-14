// scripts/novus-tier-selftest.mjs — hermetic Tier / Sales Strategy Engine
// test (no network, no creds).
//
// Exercises lib/tier.mjs directly: all 10 INTELLIGENCE.grade/compromised
// states, plus proof that AGENCIES metadata (present, absent, or varied)
// never changes the tier classification for a given grade, and that
// `segment` is never derived from grade — only ever passed through
// unchanged from whatever authoritative value (if any) the caller supplies.
//
// Run:  npm run novus:tier-selftest  (or: node scripts/novus-tier-selftest.mjs)

import assert from 'node:assert';
import { classifyTier } from '../lib/tier.mjs';

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

console.log('novus-tier-selftest');

// ── All 10 states: A-H, pending, compromised ──────────────────────────────
const GROWTH_GRADES = ['A', 'B'];
const CORE_GRADES = ['C', 'D', 'E', 'F', 'G', 'H'];

for (const grade of GROWTH_GRADES) {
  check(`grade ${grade} -> Growth`, () => {
    const result = classifyTier({ grade });
    assert.strictEqual(result.tier, 'Growth');
    assert.ok(result.tier_reason && result.tier_reason.length > 0);
    assert.ok(result.sales_angle && result.sales_angle.length > 0);
  });
}

for (const grade of CORE_GRADES) {
  check(`grade ${grade} -> Core`, () => {
    const result = classifyTier({ grade });
    assert.strictEqual(result.tier, 'Core');
    assert.ok(result.tier_reason && result.tier_reason.length > 0);
    assert.ok(result.sales_angle && result.sales_angle.length > 0);
  });
}

check('grade pending -> unclassified', () => {
  const result = classifyTier({ grade: 'pending' });
  assert.strictEqual(result.tier, 'unclassified');
  assert.strictEqual(result.sales_angle, '');
  assert.notStrictEqual(result.tier, 'Core');
  assert.notStrictEqual(result.tier, 'Growth');
});

check('compromised probe -> unclassified regardless of grade', () => {
  // Even if a grade WAS somehow computed (e.g. A), compromised wins.
  for (const grade of ['A', 'H', 'pending', undefined]) {
    const result = classifyTier({ grade, compromised: 'TRUE' });
    assert.strictEqual(result.tier, 'unclassified');
    assert.notStrictEqual(result.tier, 'Core');
    assert.notStrictEqual(result.tier, 'Growth');
  }
});

// ── segment is NEVER derived from grade — only ever passed through ────────
check('segment defaults to blank when no authoritative value is supplied, for every state', () => {
  for (const grade of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'pending', undefined, 'garbage']) {
    const result = classifyTier({ grade });
    assert.strictEqual(result.segment, '', `grade ${grade} invented a segment instead of staying blank`);
  }
  const compromisedResult = classifyTier({ grade: 'A', compromised: 'TRUE' });
  assert.strictEqual(compromisedResult.segment, '');
});

check('an existing authoritative segment value passes through unchanged for every grade/state', () => {
  for (const grade of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'pending', undefined]) {
    const result = classifyTier({ grade, segment: 'some-authoritative-value' });
    assert.strictEqual(result.segment, 'some-authoritative-value', `grade ${grade} overwrote the existing segment`);
  }
  // Even a compromised probe must not clear or alter it.
  const compromisedResult = classifyTier({ grade: 'A', compromised: 'TRUE', segment: 'some-authoritative-value' });
  assert.strictEqual(compromisedResult.segment, 'some-authoritative-value');
});

check('segment passthrough is independent of tier — A and C never diverge on segment given the same input', () => {
  const growthResult = classifyTier({ grade: 'A', segment: 'whatever' });
  const coreResult = classifyTier({ grade: 'C', segment: 'whatever' });
  assert.strictEqual(growthResult.segment, 'whatever');
  assert.strictEqual(coreResult.segment, 'whatever');
});

check('unknown/garbage grade value -> unclassified (never falls through to Core)', () => {
  for (const grade of [undefined, null, '', 'X', 'unknown']) {
    const result = classifyTier({ grade });
    assert.strictEqual(result.tier, 'unclassified');
  }
});

// ── Metadata independence: classification cannot change on agency context ──
const AGENCY_VARIANTS = [
  null,
  undefined,
  {},
  { years_trading: '1' },          // well under any old "5+ years" threshold
  { years_trading: '20', live_listing_count: '500', crm_name: 'Reapit', qualification_segment: 'B' },
  { years_trading: '0', live_listing_count: '0' },
];

check('grade A remains Growth with metadata present or absent', () => {
  for (const agency of AGENCY_VARIANTS) {
    const result = classifyTier({ grade: 'A', agency });
    assert.strictEqual(result.tier, 'Growth');
  }
});

check('grade C remains Core with metadata present or absent', () => {
  for (const agency of AGENCY_VARIANTS) {
    const result = classifyTier({ grade: 'C', agency });
    assert.strictEqual(result.tier, 'Core');
  }
});

check('grade H remains Core regardless of qualification metadata', () => {
  for (const agency of AGENCY_VARIANTS) {
    const result = classifyTier({ grade: 'H', agency });
    assert.strictEqual(result.tier, 'Core');
  }
});

check('agency metadata never changes segment, with or without an authoritative segment supplied', () => {
  for (const agency of AGENCY_VARIANTS) {
    assert.strictEqual(classifyTier({ grade: 'A', agency }).segment, '');
    assert.strictEqual(classifyTier({ grade: 'A', agency, segment: 'kept' }).segment, 'kept');
  }
});

check('agency context enriches tier_reason without changing tier/segment', () => {
  const bare = classifyTier({ grade: 'A', agency: null });
  const enriched = classifyTier({
    grade: 'A',
    agency: { years_trading: '12', crm_name: 'Reapit' },
  });
  assert.strictEqual(bare.tier, enriched.tier);
  assert.strictEqual(bare.segment, enriched.segment);
  assert.strictEqual(bare.sales_angle, enriched.sales_angle);
  assert.notStrictEqual(bare.tier_reason, enriched.tier_reason);
  assert.ok(enriched.tier_reason.includes('12 years trading'));
  assert.ok(enriched.tier_reason.includes('CRM: Reapit'));
});

check('missing agency fields are simply omitted from context, never invented', () => {
  const result = classifyTier({ grade: 'B', agency: { years_trading: '', crm_name: 'HouseSimple' } });
  assert.ok(!result.tier_reason.includes('years trading'));
  assert.ok(result.tier_reason.includes('CRM: HouseSimple'));
});

console.log(`\n${passed} checks passed.`);
