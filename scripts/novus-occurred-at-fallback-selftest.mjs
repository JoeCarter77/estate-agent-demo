// scripts/novus-occurred-at-fallback-selftest.mjs — regression test for a
// silent-undercount bug in lib/observation.mjs's computeObservation():
// a COMMUNICATIONS row with a blank/unparseable occurred_at (common on
// historical/imported rows that only ever had received_at populated) was
// dropped out of EVERY rollup (channels_used, contact attempts, grade —
// the works) even though it was correctly linked to its probe by probe_id.
// occurred_at now falls back to received_at so such a row is never silently
// excluded from the probe's communication history.
//
// Run:  node scripts/novus-occurred-at-fallback-selftest.mjs

import assert from 'node:assert';
import { computeObservation } from '../lib/observation.mjs';

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

const probe = {
  probe_timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
};

console.log('\ncomputeObservation() — occurred_at falls back to received_at');
{
  const communications = [
    // Normal row: occurred_at populated.
    {
      channel: 'email', occurred_at: new Date(Date.now() - 1000 * 60 * 60 * 20).toISOString(),
      received_at: new Date(Date.now() - 1000 * 60 * 60 * 20).toISOString(),
      automated_or_human: 'human', human_contact: 'TRUE',
    },
    // Historical/imported row: occurred_at is BLANK, only received_at is set.
    // Before the fix this row's _occurredAt was null and it was silently
    // dropped by the `.filter((c) => c._occurredAt)` in computeObservation().
    {
      channel: 'sms', occurred_at: '',
      received_at: new Date(Date.now() - 1000 * 60 * 60 * 10).toISOString(),
      automated_or_human: 'human', human_contact: 'TRUE',
    },
    // Historical/imported row: occurred_at is unparseable garbage.
    {
      channel: 'voice', occurred_at: 'not-a-date',
      received_at: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
      automated_or_human: 'human', human_contact: 'TRUE',
    },
  ];

  const observation = computeObservation(probe, communications);
  const channels = observation.channels_used.split(',').filter(Boolean);

  assert.ok(channels.includes('email'), 'row with occurred_at populated is counted');
  assert.ok(channels.includes('sms'), 'row with blank occurred_at falls back to received_at and is counted');
  assert.ok(channels.includes('voice'), 'row with unparseable occurred_at falls back to received_at and is counted');
  assert.strictEqual(channels.length, 3, 'all three linked communications are counted — none silently dropped');
  ok('all three linked communications are counted, none silently dropped by a blank/unparseable occurred_at');
}

console.log(`\n✅ All ${passed} checks passed.\n`);
