// scripts/novus-rebuild-all-selftest.mjs — hermetic test for the "Rebuild All
// Intelligence" full-rebuild path (lib/intelligence-rebuild.mjs +
// api/novus/intelligence/rebuild-all.js), no network, no creds.
//
// Same in-memory fake-Sheets pattern as scripts/novus-observation-selftest.mjs
// (identical PROBES/COMMUNICATIONS/INTELLIGENCE headers, taken from the live
// workbook), seeded with a mix of probe shapes representative of the real
// data: probes with communications, probes with zero communications (both
// open and closed), historical/imported communications, and a pre-existing
// INTELLIGENCE row to prove update-not-duplicate.
//
// Run: npm run novus:rebuild-all-selftest

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';

const PROBES_HEADER = [
  'probe_id','probe_reference','agency_id','portal','property_address','property_url',
  'property_price','property_status','enquiry_text','probe_email','probe_phone',
  'probe_timestamp','observation_deadline','probe_status','compromised','compromise_reason',
  'observation_closed_at','sent_from','observation_notes','created_at','updated_at',
];
const COMMUNICATIONS_HEADER = [
  'communication_id','agency_id','probe_id','interaction_id','occurred_at','received_at','channel',
  'direction','communication_type','provider','provider_event_id','source_identifier_raw',
  'source_identifier_normalized','destination_identifier','display_name','call_status',
  'duration_seconds','voicemail_present','recording_reference','transcript','email_message_id',
  'email_thread_id','subject','body_text','raw_content','raw_payload_reference','matching_method',
  'match_score','match_status','automated_or_human','human_contact','callback_attempt',
  'successful_conversation','follow_up','booking_attempt','communication_classification','intent',
  'contact_quality','ai_summary','ai_confidence','ai_model','manual_review_status','manual_override',
  'override_reason','created_at','updated_at',
];
const INTELLIGENCE_HEADER = [
  'intelligence_id','agency_id','probe_id','observation_status','observation_deadline',
  'auto_acknowledgement','auto_ack_timestamp','crm_detected','crm_name','crm_evidence',
  'first_human_touch','first_human_touch_at','human_lag_hours','callback_attempts',
  'successful_conversations','voicemail_count','inbound_sms_count','email_touch_count',
  'follow_up_count','follow_up_channels','last_touch_at','days_chased','booking_attempt',
  'contact_quality','proactive_reactive','persistence_profile','channels_used','grade',
  'grade_reason','tier','tier_reason','sales_angle','segment','ai_evidence_summary','ai_confidence',
  'manual_override','override_reason','observation_closed_at','created_at','updated_at',
];

function makeFakeSheet() {
  const store = {
    PROBES: [PROBES_HEADER.slice(), ['SCHEMA NOTE', 'One row per actual probe.']],
    COMMUNICATIONS: [COMMUNICATIONS_HEADER.slice(), ['SCHEMA NOTE', 'One row per meaningful communication.']],
    INTELLIGENCE: [INTELLIGENCE_HEADER.slice(), ['SCHEMA NOTE', 'Derived behaviour and official decisions.']],
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
  };
  return { store, valuesApi };
}

function seedProbe(store, { probe_id, agency_id = 'ag_1', probe_status = 'observing', probe_timestamp = '', observation_deadline = '' }) {
  const row = PROBES_HEADER.map((key) => {
    if (key === 'probe_id') return probe_id;
    if (key === 'agency_id') return agency_id;
    if (key === 'probe_status') return probe_status;
    if (key === 'probe_timestamp') return probe_timestamp;
    if (key === 'observation_deadline') return observation_deadline;
    return '';
  });
  store.PROBES.push(row);
}

let commSeq = 0;
function seedCommunication(store, { probe_id, agency_id = 'ag_1', occurred_at, channel = 'email', from = 'agent@agency-one.co.uk', subject = '', body_text = '', historical = false }) {
  commSeq += 1;
  const communication_id = `com_test_${commSeq}`;
  const row = COMMUNICATIONS_HEADER.map((key) => {
    if (key === 'communication_id') return communication_id;
    if (key === 'agency_id') return agency_id;
    if (key === 'probe_id') return probe_id;
    if (key === 'occurred_at') return occurred_at;
    if (key === 'received_at') return occurred_at;
    if (key === 'channel') return channel;
    if (key === 'direction') return 'inbound';
    if (key === 'communication_type') return channel;
    if (key === 'source_identifier_raw') return from;
    if (key === 'source_identifier_normalized') return from.toLowerCase();
    if (key === 'subject') return subject;
    if (key === 'body_text') return body_text;
    if (key === 'raw_content') return body_text;
    if (key === 'match_status') return 'matched';
    // Historical imported communications were matched by a different method
    // than live webhook ingestion, but must be treated identically by
    // rebuild — proves "include historical imported communications".
    if (key === 'matching_method') return historical ? 'historical_import' : 'email_exact';
    if (key === 'match_score') return 1;
    return '';
  });
  store.COMMUNICATIONS.push(row);
  return communication_id;
}

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

function iso(offsetMsFromEpochBase, baseIso) {
  return new Date(new Date(baseIso).getTime() + offsetMsFromEpochBase).toISOString();
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const PROBE_SENT = '2026-08-01T21:00:00.000Z';
const NOW = new Date('2026-08-18T12:00:00.000Z'); // "today" per session context

async function run() {
  process.env.NOVUS_BASIC_AUTH_USER = 'novus';
  process.env.NOVUS_BASIC_AUTH_PASS = 'test-pass';
  const { default: rebuildAllHandler } = await import('../api/novus/intelligence/rebuild-all.js');
  const { rebuildAllIntelligence } = await import('../lib/intelligence-rebuild.mjs');

  function mockReq(body = {}) {
    const creds = Buffer.from('novus:test-pass').toString('base64');
    return { method: 'POST', body, headers: { authorization: `Basic ${creds}` } };
  }
  function mockRes() {
    return {
      statusCode: 200, body: null,
      status(c) { this.statusCode = c; return this; },
      json(o) { this.body = o; return this; },
      setHeader() {},
      end() { return this; },
    };
  }

  console.log('\nRebuild-all: mixed real-world-shaped probe set');
  const { store, valuesApi } = makeFakeSheet();
  __setRepoForTests(createRepo(valuesApi));
  const repo = createRepo(valuesApi);

  // prb_open_with_comms — currently observing, has real human contact -> A/B/C/D/E/F, still open.
  seedProbe(store, { probe_id: 'prb_open_with_comms', probe_timestamp: iso(-1 * DAY, NOW.toISOString()), observation_deadline: iso(3 * DAY, NOW.toISOString()) });
  seedCommunication(store, { probe_id: 'prb_open_with_comms', occurred_at: iso(-1 * DAY + 30 * MIN, NOW.toISOString()), body_text: 'Thanks, calling you now.' });

  // prb_closed_with_comms — window closed, human contact -> real grade, not H.
  seedProbe(store, { probe_id: 'prb_closed_with_comms', probe_timestamp: PROBE_SENT, observation_deadline: iso(4 * DAY, PROBE_SENT) });
  seedCommunication(store, { probe_id: 'prb_closed_with_comms', occurred_at: iso(30 * MIN, PROBE_SENT), body_text: 'Thanks, calling you now.' });

  // prb_automated_only — automated ack only, must NOT count as human contact -> G.
  seedProbe(store, { probe_id: 'prb_automated_only', probe_timestamp: PROBE_SENT, observation_deadline: iso(4 * DAY, PROBE_SENT) });
  seedCommunication(store, {
    probe_id: 'prb_automated_only', occurred_at: iso(5 * MIN, PROBE_SENT),
    from: 'no-reply@agency.co.uk', subject: 'We have received your enquiry', body_text: 'This is an automated response.',
  });

  // prb_zero_open — zero communications, window still open -> pending/observing, no final H.
  seedProbe(store, { probe_id: 'prb_zero_open', probe_timestamp: iso(-1 * DAY, NOW.toISOString()), observation_deadline: iso(3 * DAY, NOW.toISOString()) });

  // prb_zero_closed — zero communications, window closed -> Grade H.
  seedProbe(store, { probe_id: 'prb_zero_closed', probe_timestamp: PROBE_SENT, observation_deadline: iso(4 * DAY, PROBE_SENT) });

  // prb_historical — historical imported communications (different matching_method), human contact.
  seedProbe(store, { probe_id: 'prb_historical', probe_timestamp: PROBE_SENT, observation_deadline: iso(4 * DAY, PROBE_SENT) });
  seedCommunication(store, { probe_id: 'prb_historical', occurred_at: iso(2 * HOUR, PROBE_SENT), body_text: 'Following up on your enquiry.', historical: true });

  // prb_draft — never sent (draft), no probe_timestamp/deadline at all.
  seedProbe(store, { probe_id: 'prb_draft', probe_status: 'draft' });

  // Pre-existing INTELLIGENCE row for prb_closed_with_comms, simulating a
  // prior rebuild/recompute run with a stale grade — must be UPDATED in
  // place, not duplicated.
  store.INTELLIGENCE.push(INTELLIGENCE_HEADER.map((key) => {
    if (key === 'intelligence_id') return 'itl_pre_existing';
    if (key === 'probe_id') return 'prb_closed_with_comms';
    if (key === 'grade') return 'stale_placeholder';
    return '';
  }));

  const OrigDate = Date;
  global.Date = class extends OrigDate {
    constructor(...args) { if (args.length === 0) return new OrigDate(NOW); super(...args); }
    static now() { return NOW.getTime(); }
  };

  let summary1;
  try {
    const res = mockRes();
    await rebuildAllHandler(mockReq(), res);
    assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    summary1 = res.body;
  } finally {
    global.Date = OrigDate;
  }

  assert.strictEqual(summary1.probes_processed, 7, 'all 7 seeded probes processed');
  assert.strictEqual(summary1.probes_with_communications, 4, 'prb_open_with_comms, prb_closed_with_comms, prb_automated_only, prb_historical');
  assert.strictEqual(summary1.probes_with_zero_communications, 3, 'prb_zero_open, prb_zero_closed, prb_draft');
  assert.deepStrictEqual(summary1.problems, [], 'no problematic/unmatched probes');
  ok(`rebuild-all processed all probes (${summary1.probes_processed}), split communications/zero correctly`);

  const byId = Object.fromEntries(summary1.results.map((r) => [r.probe_id, r]));

  assert.strictEqual(byId.prb_automated_only.grade, 'G', 'automated-only communication does not count as human contact -> G, not A-F');
  ok('automated-only communications do not count as human contact');

  assert.ok(['A', 'B', 'C', 'D', 'E', 'F'].includes(byId.prb_closed_with_comms.grade), `human contact calculates a real grade, got ${byId.prb_closed_with_comms.grade}`);
  assert.ok(['A', 'B', 'C', 'D', 'E', 'F'].includes(byId.prb_historical.grade), `historical imported communication calculates a real grade, got ${byId.prb_historical.grade}`);
  ok('human communications (live and historical-imported) calculate correctly');

  assert.strictEqual(byId.prb_zero_open.grade, 'pending', 'zero comms + window open -> pending, no final H');
  assert.strictEqual(byId.prb_zero_closed.grade, 'H', 'zero comms + window closed -> Grade H');
  ok('zero-communication probes appear in INTELLIGENCE: open -> observing/pending, closed -> H');

  // Every probe, including both zero-comm probes, must have produced an INTELLIGENCE row.
  const allIntelligence = await repo.getRecords('INTELLIGENCE', 'intelligence_id');
  const intelligenceProbeIds = new Set(allIntelligence.map((r) => r.obj.probe_id));
  for (const pid of ['prb_open_with_comms', 'prb_closed_with_comms', 'prb_automated_only', 'prb_zero_open', 'prb_zero_closed', 'prb_historical', 'prb_draft']) {
    assert.ok(intelligenceProbeIds.has(pid), `INTELLIGENCE row exists for ${pid}`);
  }
  ok('every probe (including zero-communication and draft probes) has exactly one INTELLIGENCE row');

  assert.strictEqual(summary1.intelligence_updated, 1, 'prb_closed_with_comms had a pre-existing row -> updated');
  assert.strictEqual(summary1.intelligence_created, 6, 'the other 6 probes create a fresh row');
  const preExisting = allIntelligence.find((r) => r.obj.probe_id === 'prb_closed_with_comms');
  assert.strictEqual(preExisting.obj.intelligence_id, 'itl_pre_existing', 'existing INTELLIGENCE row updated in place, not duplicated');
  assert.notStrictEqual(preExisting.obj.grade, 'stale_placeholder', 'stale grade recalculated');
  ok('existing INTELLIGENCE records update rather than duplicate');

  // ── Idempotency: running rebuild twice produces identical results ──
  console.log('\nIdempotency — running rebuild-all twice');
  global.Date = class extends OrigDate {
    constructor(...args) { if (args.length === 0) return new OrigDate(NOW); super(...args); }
    static now() { return NOW.getTime(); }
  };
  let summary2;
  try {
    summary2 = await rebuildAllIntelligence(repo);
  } finally {
    global.Date = OrigDate;
  }

  assert.strictEqual(summary2.probes_processed, summary1.probes_processed, 'same probe count on second run');
  const intelligenceAfterSecondRun = await repo.getRecords('INTELLIGENCE', 'intelligence_id');
  assert.strictEqual(intelligenceAfterSecondRun.length, allIntelligence.length, 'no new INTELLIGENCE rows created on second run (7 probes -> still 7 rows)');
  assert.strictEqual(summary2.intelligence_created, 0, 'second run creates nothing new');
  assert.strictEqual(summary2.intelligence_updated, summary1.probes_processed, 'second run updates every row in place');

  const byId2 = Object.fromEntries(summary2.results.map((r) => [r.probe_id, r]));
  for (const pid of Object.keys(byId)) {
    assert.strictEqual(byId2[pid].grade, byId[pid].grade, `grade for ${pid} identical across both runs`);
    assert.strictEqual(byId2[pid].intelligence_id, byId[pid].intelligence_id, `same INTELLIGENCE row reused for ${pid}, not duplicated`);
  }
  ok('running rebuild-all twice produces identical grades and the same INTELLIGENCE row ids — no duplicates');

  __setRepoForTests(null);
  console.log(`\n✅ All ${passed} checks passed.\n`);
}

run().catch((err) => { console.error('\n❌ SELFTEST FAILED:\n', err); process.exit(1); });
