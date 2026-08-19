// scripts/novus-rebuild-all-selftest.mjs — hermetic test (no network, no
// creds) for the full-rebuild path lib/intelligence-rebuild.mjs
// (V2 schema, docs/V2_COMMS_INTELLIGENCE_DIAGNOSIS_SCHEMA.md §6).
//
// Same in-memory fake-Sheets pattern as the other selftests. The AI half of
// the pipeline is stubbed via lib/ai-client.mjs's __setAiCallerForTests();
// this suite checks the ORCHESTRATION around it:
//   - deterministic fields (grade, human_contact, response_hours, contact
//     attempts/follow-ups, channels) are computed correctly, unchanged from
//     the old A-H engine
//   - AI interpretation runs exactly once per probe that has never been
//     interpreted (communication_quality blank) — a probe already carrying
//     an interpretation is left untouched on a routine rebuild
//   - a second rebuild makes ZERO further AI calls (the idempotency
//     invariant the whole no-fingerprint design depends on)
//   - force_ai:true re-runs every probe regardless
//   - COMMUNICATIONS only ever gets automated_or_human patched — none of
//     the retired columns (human_contact, follow_up, booking_attempt, …)
//
// Run: npm run novus:rebuild-all-selftest

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';
import { rebuildAllIntelligence } from '../lib/intelligence-rebuild.mjs';

const PROBES_HEADER = [
  'probe_id', 'probe_reference', 'agency_id', 'portal', 'property_address', 'property_url',
  'property_price', 'property_status', 'enquiry_text', 'probe_email', 'probe_phone',
  'probe_timestamp', 'observation_deadline', 'probe_status', 'compromised', 'compromise_reason',
  'observation_closed_at', 'sent_from', 'observation_notes', 'created_at', 'updated_at',
];
const COMMUNICATIONS_HEADER = [
  'communication_id', 'agency_id', 'probe_id', 'occurred_at', 'channel', 'direction',
  'source_identifier_normalized', 'subject', 'body_text', 'transcript', 'raw_content',
  'match_status', 'automated_or_human', 'manual_override', 'created_at', 'updated_at',
];
const INTELLIGENCE_HEADER = [
  'intelligence_id', 'agency_id', 'probe_id', 'observation_status', 'observation_deadline',
  'observation_closed_at', 'human_contact', 'response_hours', 'first_human_response_at',
  'contact_attempts', 'follow_ups', 'channels_used',
  'viewing_progression', 'buyer_qualification', 'buyer_questions_asked', 'seller_recognition',
  'communication_quality', 'did_well', 'missed', 'evidence',
  'grade', 'grade_reason', 'created_at', 'updated_at',
];

function makeFakeSheet() {
  const store = {
    PROBES: [PROBES_HEADER.slice(), ['SCHEMA NOTE', 'Fixture']],
    COMMUNICATIONS: [COMMUNICATIONS_HEADER.slice(), ['SCHEMA NOTE', 'Fixture']],
    INTELLIGENCE: [INTELLIGENCE_HEADER.slice(), ['SCHEMA NOTE', 'Fixture']],
  };
  function tabOf(range) { return String(range).split('!')[0]; }
  function startRowOf(range) {
    const m = String(range).match(/!\D+(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }
  const valuesApi = {
    async get(range) {
      const tab = tabOf(range);
      return (store[tab] || []).map((r) => r.slice());
    },
    async append(range, rows) {
      const tab = tabOf(range);
      store[tab] = store[tab] || [];
      for (const r of rows) store[tab].push(r.slice());
      return { updates: { updatedRows: rows.length } };
    },
    async update(range, rows) {
      const tab = tabOf(range);
      const start = startRowOf(range);
      store[tab] = store[tab] || [];
      rows.forEach((r, i) => { store[tab][start - 1 + i] = r.slice(); });
      return { updatedRows: rows.length };
    },
    async batchUpdate(data) {
      for (const { range, values } of data) {
        const tab = tabOf(range);
        const start = startRowOf(range);
        store[tab] = store[tab] || [];
        values.forEach((row, i) => { store[tab][start - 1 + i] = row.slice(); });
      }
    },
  };
  return { store, repo: createRepo(valuesApi) };
}

function row(header, obj) { return header.map((k) => obj[k] ?? ''); }
function toObj(header, r) { return Object.fromEntries(header.map((k, i) => [k, r[i]])); }

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

async function run() {
  console.log('lib/intelligence-rebuild.mjs — hermetic selftest\n');

  const { store, repo } = makeFakeSheet();
  __setRepoForTests(repo);

  // Probe A: never interpreted, fast human contact, one follow-up.
  store.PROBES.push(row(PROBES_HEADER, {
    probe_id: 'prb_a', probe_reference: 'RM-0001', agency_id: 'agc_a',
    property_address: '1 Fast Street', property_price: '£300,000',
    enquiry_text: 'Interested in viewing this property.',
    probe_timestamp: '2026-08-01T09:00:00.000Z',
  }));
  store.COMMUNICATIONS.push(row(COMMUNICATIONS_HEADER, {
    communication_id: 'com_a1', agency_id: 'agc_a', probe_id: 'prb_a',
    occurred_at: '2026-08-01T09:30:00.000Z', channel: 'email',
    body_text: 'Happy to show you round, when suits?', match_status: 'matched',
  }));

  // Probe B: already AI-interpreted on a prior run (communication_quality set) —
  // a routine rebuild must NOT call the AI for it again.
  store.PROBES.push(row(PROBES_HEADER, {
    probe_id: 'prb_b', probe_reference: 'RM-0002', agency_id: 'agc_b',
    property_address: '2 Slow Street', property_price: '£250,000',
    enquiry_text: 'Interested in viewing this property.',
    probe_timestamp: '2026-08-01T09:00:00.000Z',
  }));
  store.COMMUNICATIONS.push(row(COMMUNICATIONS_HEADER, {
    communication_id: 'com_b1', agency_id: 'agc_b', probe_id: 'prb_b',
    occurred_at: '2026-08-03T09:00:00.000Z', channel: 'email',
    body_text: 'Please call us back.', match_status: 'matched',
  }));
  store.INTELLIGENCE.push(row(INTELLIGENCE_HEADER, {
    intelligence_id: 'itl_b', agency_id: 'agc_b', probe_id: 'prb_b',
    communication_quality: 'generic', viewing_progression: 'none',
    buyer_qualification: 'none', evidence: 'stubbed from a prior run',
    created_at: '2026-08-02T00:00:00.000Z',
  }));

  let aiCallCount = 0;
  __setAiCallerForTests(async ({ prompt }) => {
    aiCallCount += 1;
    return {
      viewing_progression: 'invited',
      buyer_questions_asked: [{ topic: 'availability', quote: 'when suits?', communication_id: 'com_a1' }],
      seller_recognition: 'none',
      communication_quality: 'competent',
      did_well: 'Responded within 30 minutes and offered a viewing.',
      missed: '',
      evidence: [{ quote: 'when suits?', communication_id: 'com_a1' }],
    };
  });

  const first = await rebuildAllIntelligence(repo);
  assert.strictEqual(first.probes_processed, 2);
  assert.strictEqual(first.ai_interpretations_run, 1, 'only prb_a (never interpreted) triggers an AI call; prb_b is already interpreted');
  assert.strictEqual(aiCallCount, 1);
  ok('AI interpretation runs only for the probe that has never been interpreted before');

  const intelRecords = store.INTELLIGENCE.slice(2).map((r) => toObj(INTELLIGENCE_HEADER, r));
  const a = intelRecords.find((r) => r.probe_id === 'prb_a');
  const b = intelRecords.find((r) => r.probe_id === 'prb_b');

  assert.strictEqual(a.human_contact, 'yes');
  assert.strictEqual(a.grade, 'C', 'very fast (<=1h) human contact with 0 follow-ups grades C — the unchanged A-H engine');
  assert.ok(Number(a.response_hours) < 1, 'prb_a response_hours reflects the 30-minute lag');
  assert.strictEqual(a.viewing_progression, 'invited', 'AI-derived field written through from the stub');
  assert.strictEqual(a.buyer_qualification, 'minimal', '1 genuine question floors qualification to minimal');
  ok('deterministic fields (human_contact, response_hours) and AI fields are both written correctly for the newly-interpreted probe');

  assert.strictEqual(b.communication_quality, 'generic', 'prb_b keeps its prior AI interpretation untouched');
  assert.strictEqual(b.evidence, 'stubbed from a prior run', 'a routine rebuild never overwrites an existing AI interpretation');
  assert.strictEqual(b.human_contact, 'yes', 'deterministic fields still recompute even when the AI fields are reused');
  ok('a probe already interpreted keeps its AI fields verbatim while its deterministic fields still recompute');

  // COMMUNICATIONS: only automated_or_human should ever be patched.
  const commA = toObj(COMMUNICATIONS_HEADER, store.COMMUNICATIONS.slice(2).find((r) => r[0] === 'com_a1'));
  assert.strictEqual(commA.automated_or_human, 'human', 'automated_or_human is the one per-message fact still written');
  ok('COMMUNICATIONS rows are patched with automated_or_human only — no retired column is ever written');

  // ── Second rebuild: zero further AI calls (idempotency) ──
  aiCallCount = 0;
  const second = await rebuildAllIntelligence(repo);
  assert.strictEqual(second.ai_interpretations_run, 0, 'a second rebuild over an already-interpreted sheet makes no AI calls');
  assert.strictEqual(aiCallCount, 0);
  const stripTimestamps = (records) => records.map(({ updated_at, ...rest }) => rest);
  const intelRecords2 = store.INTELLIGENCE.slice(2).map((r) => toObj(INTELLIGENCE_HEADER, r));
  assert.deepStrictEqual(stripTimestamps(intelRecords2), stripTimestamps(intelRecords), 'a second rebuild changes nothing (besides updated_at) — same invariant as the old pipeline');
  ok('a second rebuild is fully idempotent: zero AI calls, identical rows');

  // ── force_ai: true re-runs every probe regardless ──
  const forced = await rebuildAllIntelligence(repo, { forceAi: true });
  assert.strictEqual(forced.ai_interpretations_run, 2, 'force_ai re-interprets every probe, including the already-interpreted one');
  ok('force_ai:true re-runs AI interpretation for every probe');

  console.log(`\n${passed} checks passed.`);
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
