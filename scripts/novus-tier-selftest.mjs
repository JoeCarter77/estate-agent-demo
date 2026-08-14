// scripts/novus-tier-selftest.mjs — hermetic Tier / Sales Strategy Engine
// test (no network, no creds).
//
// Exercises lib/tier.mjs directly: all 10 INTELLIGENCE.grade/compromised
// states, plus proof that AGENCIES metadata (present, absent, or varied)
// never changes the tier/segment classification for a given grade.
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
    assert.strictEqual(result.segment, 'A');
    assert.ok(result.tier_reason && result.tier_reason.length > 0);
    assert.ok(result.sales_angle && result.sales_angle.length > 0);
  });
}

for (const grade of CORE_GRADES) {
  check(`grade ${grade} -> Core`, () => {
    const result = classifyTier({ grade });
    assert.strictEqual(result.tier, 'Core');
    assert.strictEqual(result.segment, 'B');
    assert.ok(result.tier_reason && result.tier_reason.length > 0);
    assert.ok(result.sales_angle && result.sales_angle.length > 0);
  });
}

check('grade pending -> unclassified', () => {
  const result = classifyTier({ grade: 'pending' });
  assert.strictEqual(result.tier, 'unclassified');
  assert.strictEqual(result.segment, 'unclassified');
  assert.strictEqual(result.sales_angle, '');
  assert.notStrictEqual(result.tier, 'Core');
  assert.notStrictEqual(result.tier, 'Growth');
});

check('compromised probe -> unclassified regardless of grade', () => {
  // Even if a grade WAS somehow computed (e.g. A), compromised wins.
  for (const grade of ['A', 'H', 'pending', undefined]) {
    const result = classifyTier({ grade, compromised: 'TRUE' });
    assert.strictEqual(result.tier, 'unclassified');
    assert.strictEqual(result.segment, 'unclassified');
    assert.notStrictEqual(result.tier, 'Core');
    assert.notStrictEqual(result.tier, 'Growth');
  }
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
    assert.strictEqual(result.segment, 'A');
  }
});

check('grade C remains Core with metadata present or absent', () => {
  for (const agency of AGENCY_VARIANTS) {
    const result = classifyTier({ grade: 'C', agency });
    assert.strictEqual(result.tier, 'Core');
    assert.strictEqual(result.segment, 'B');
  }
});

check('grade H remains Core regardless of qualification metadata', () => {
  for (const agency of AGENCY_VARIANTS) {
    const result = classifyTier({ grade: 'H', agency });
    assert.strictEqual(result.tier, 'Core');
    assert.strictEqual(result.segment, 'B');
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
