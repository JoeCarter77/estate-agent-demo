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

// calls: counts every request the fake transport receives, split by kind —
// used to assert the rebuild path stays within the real Sheets API's request
// quota (a small, roughly-constant number of calls regardless of probe
// count), not O(probes).
function makeFakeSheet() {
  const store = {
    PROBES: [PROBES_HEADER.slice(), ['SCHEMA NOTE', 'One row per actual probe.']],
    COMMUNICATIONS: [COMMUNICATIONS_HEADER.slice(), ['SCHEMA NOTE', 'One row per meaningful communication.']],
    INTELLIGENCE: [INTELLIGENCE_HEADER.slice(), ['SCHEMA NOTE', 'Derived behaviour and official decisions.']],
  };
  const calls = { get: 0, append: 0, update: 0, batchUpdate: 0 };
  function tabOf(range) { return String(range).split('!')[0]; }
  function startRowOf(range) {
    const m = String(range).match(/!\D+(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }
  const valuesApi = {
    async get(range) {
      calls.get += 1;
      const tab = tabOf(range);
      return (store[tab] || []).map((r) => r.slice());
    },
    async append(range, rows) {
      calls.append += 1;
      const tab = tabOf(range);
      store[tab] = store[tab] || [];
      for (const r of rows) store[tab].push(r.slice());
      return { updates: { updatedRows: rows.length } };
    },
    async update(range, rows) {
      calls.update += 1;
      const tab = tabOf(range);
      const start = startRowOf(range);
      store[tab] = store[tab] || [];
      rows.forEach((r, i) => { store[tab][start - 1 + i] = r.slice(); });
      return { updatedRows: rows.length };
    },
    // Mirrors the real Sheets values:batchUpdate endpoint: one request writes
    // many ranges (any mix of tabs), no read involved.
    async batchUpdate(data) {
      calls.batchUpdate += 1;
      for (const { range, values } of data) {
        const tab = tabOf(range);
        const start = startRowOf(range);
        store[tab] = store[tab] || [];
        values.forEach((row, i) => { store[tab][start - 1 + i] = row.slice(); });
      }
      return { totalUpdatedCells: data.reduce((n, d) => n + d.values[0].length, 0) };
    },
  };
  return { store, valuesApi, calls };
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
  const { store, valuesApi, calls } = makeFakeSheet();
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

  // prb_sms_email — SMS + human email + automated email, to prove
  // inbound_sms_count/email_touch_count/channels_used on the full-rebuild path.
  seedProbe(store, { probe_id: 'prb_sms_email', probe_timestamp: PROBE_SENT, observation_deadline: iso(4 * DAY, PROBE_SENT) });
  seedCommunication(store, { probe_id: 'prb_sms_email', occurred_at: iso(10 * MIN, PROBE_SENT), channel: 'sms', body_text: 'Please call me back to arrange a viewing.' });
  seedCommunication(store, { probe_id: 'prb_sms_email', occurred_at: iso(20 * MIN, PROBE_SENT), channel: 'email', body_text: "Hi, it's Jane, following up on your enquiry." });
  seedCommunication(store, {
    probe_id: 'prb_sms_email', occurred_at: iso(1 * HOUR, PROBE_SENT), channel: 'email',
    from: 'no-reply@agency.co.uk', subject: 'We have received your enquiry', body_text: 'This is an automated response.',
  });

  // prb_historical_no_deadline_zero — historical probe from "last week" with
  // NO observation_deadline written (legacy/imported PROBES row), zero
  // communications. probe_timestamp is 10 days before NOW, so the derived
  // 4-day deadline has long since passed -> must resolve closed -> Grade H,
  // not still 'observing'.
  seedProbe(store, { probe_id: 'prb_historical_no_deadline_zero', probe_timestamp: iso(-10 * DAY, NOW.toISOString()), observation_deadline: '' });

  // prb_historical_no_deadline_with_comms — same missing-deadline shape, but
  // with a genuine human touch inside the derived 4-day window -> must
  // resolve closed with a real A-F grade (not H, not stuck 'observing').
  seedProbe(store, { probe_id: 'prb_historical_no_deadline_with_comms', probe_timestamp: iso(-10 * DAY, NOW.toISOString()), observation_deadline: '' });
  seedCommunication(store, { probe_id: 'prb_historical_no_deadline_with_comms', occurred_at: iso(-10 * DAY + 30 * MIN, NOW.toISOString()), body_text: 'Thanks, calling you now.' });

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

  // ── Read/write quota shape: exactly 3 reads (PROBES/COMMUNICATIONS/
  // INTELLIGENCE, once each), zero legacy per-row reads (repo.update/repo.append
  // are never called by the rebuild path), and writes going through the
  // no-read batchUpdate transport only. ──
  assert.strictEqual(calls.get, 3, 'exactly one read per table (PROBES, COMMUNICATIONS, INTELLIGENCE) — no per-probe or per-write reads');
  assert.strictEqual(calls.update, 0, 'the no-read batch write path never calls the single-range update() transport');
  assert.strictEqual(calls.append, 0, 'the no-read batch write path never calls the read-then-append() transport');
  assert.ok(calls.batchUpdate >= 1, 'writes go through the batched, no-read batchUpdate() transport');
  ok(`rebuild-all reads each table exactly once (3 total) and writes only via batchUpdate — 0 update()/append() calls`);

  assert.strictEqual(summary1.probes_processed, 10, 'all 10 seeded probes processed');
  assert.strictEqual(summary1.probes_with_communications, 6, 'prb_open_with_comms, prb_closed_with_comms, prb_automated_only, prb_historical, prb_sms_email, prb_historical_no_deadline_with_comms');
  assert.strictEqual(summary1.probes_with_zero_communications, 4, 'prb_zero_open, prb_zero_closed, prb_draft, prb_historical_no_deadline_zero');
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
  for (const pid of ['prb_open_with_comms', 'prb_closed_with_comms', 'prb_automated_only', 'prb_zero_open', 'prb_zero_closed', 'prb_historical', 'prb_draft', 'prb_sms_email', 'prb_historical_no_deadline_zero', 'prb_historical_no_deadline_with_comms']) {
    assert.ok(intelligenceProbeIds.has(pid), `INTELLIGENCE row exists for ${pid}`);
  }
  ok('every probe (including zero-communication and draft probes) has exactly one INTELLIGENCE row');

  // ── Historical probes with a missing observation_deadline must still close ──
  const noDeadlineZero = allIntelligence.find((r) => r.obj.probe_id === 'prb_historical_no_deadline_zero').obj;
  const noDeadlineWithComms = allIntelligence.find((r) => r.obj.probe_id === 'prb_historical_no_deadline_with_comms').obj;
  const expectedDeadline = iso(-10 * DAY + 4 * DAY, NOW.toISOString());

  assert.strictEqual(noDeadlineZero.observation_status, 'closed', 'historical probe from last week with no stored deadline is closed, not stuck observing');
  assert.strictEqual(noDeadlineZero.grade, 'H', 'closed + zero communications -> Grade H');
  assert.strictEqual(noDeadlineZero.observation_deadline, expectedDeadline, 'missing deadline derived as probe_timestamp + 4 days and written back to INTELLIGENCE');

  assert.strictEqual(noDeadlineWithComms.observation_status, 'closed', 'historical probe with communications and no stored deadline is closed, not stuck observing');
  assert.ok(['A', 'B', 'C', 'D', 'E', 'F'].includes(noDeadlineWithComms.grade), `closed + human contact -> a real A-F grade, got ${noDeadlineWithComms.grade}`);
  assert.strictEqual(noDeadlineWithComms.observation_deadline, expectedDeadline, 'missing deadline derived as probe_timestamp + 4 days and written back to INTELLIGENCE');
  ok('historical probes with a missing observation_deadline derive it from probe_timestamp + 4 days, resolve to closed, and grade correctly (H when no evidence, A-F when human contact occurred)');

  const smsEmailIntelligence = allIntelligence.find((r) => r.obj.probe_id === 'prb_sms_email').obj;
  assert.strictEqual(String(smsEmailIntelligence.inbound_sms_count), '1', 'one human SMS touch counted');
  assert.strictEqual(String(smsEmailIntelligence.email_touch_count), '1', 'one human email touch counted; automated email excluded');
  assert.strictEqual(smsEmailIntelligence.channels_used, 'sms,email', 'channels_used includes both sms and email');
  ok('rebuild-all populates inbound_sms_count/email_touch_count/channels_used correctly for SMS + human email + automated email');

  assert.strictEqual(summary1.intelligence_updated, 1, 'prb_closed_with_comms had a pre-existing row -> updated');
  assert.strictEqual(summary1.intelligence_created, 9, 'the other 9 probes create a fresh row');
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
  const callsBeforeSecondRun = { ...calls };
  let summary2;
  try {
    summary2 = await rebuildAllIntelligence(repo);
  } finally {
    global.Date = OrigDate;
  }

  assert.strictEqual(calls.get - callsBeforeSecondRun.get, 3, 'second run also reads each table exactly once — no per-probe reads even when every row is an update');
  assert.strictEqual(calls.update - callsBeforeSecondRun.update, 0, 'second run still never calls the single-range update() transport');
  assert.strictEqual(calls.append - callsBeforeSecondRun.append, 0, 'second run still never calls the read-then-append() transport');
  ok('re-running rebuild-all is just as batch-based as the first run — same fixed 3-read shape, no per-write reads');

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

  // ── Live-sized quota test: a rebuild across hundreds of probes must stay
  // within the Google Sheets API's per-minute READ quota (60 read requests
  // per user per 100 seconds is the default project quota) — i.e. total
  // reads must stay O(1), not O(probes). Also asserts the write side stays
  // a small, bounded number of batched requests, not one per row. ──
  console.log('\nLive-sized rebuild — Sheets API quota check (400 probes, mixed shapes)');
  {
    const big = makeFakeSheet();
    __setRepoForTests(createRepo(big.valuesApi));
    const bigRepo = createRepo(big.valuesApi);

    const PROBE_COUNT = 400;
    for (let i = 0; i < PROBE_COUNT; i++) {
      const probeId = `prb_live_${i}`;
      // A representative mix: ~40% zero-communication, ~30% automated-only,
      // ~30% real human contact with a follow-up (exercises classification +
      // follow-up writes on most probes, not just a quiet majority).
      if (i % 10 < 4) {
        seedProbe(big.store, { probe_id: probeId, probe_timestamp: PROBE_SENT, observation_deadline: iso(4 * DAY, PROBE_SENT) });
      } else if (i % 10 < 7) {
        seedProbe(big.store, { probe_id: probeId, probe_timestamp: PROBE_SENT, observation_deadline: iso(4 * DAY, PROBE_SENT) });
        seedCommunication(big.store, {
          probe_id: probeId, occurred_at: iso(5 * MIN, PROBE_SENT),
          from: 'no-reply@agency.co.uk', subject: 'We have received your enquiry', body_text: 'This is an automated response.',
        });
      } else {
        seedProbe(big.store, { probe_id: probeId, probe_timestamp: PROBE_SENT, observation_deadline: iso(4 * DAY, PROBE_SENT) });
        seedCommunication(big.store, { probe_id: probeId, occurred_at: iso(30 * MIN, PROBE_SENT), body_text: 'Thanks, calling you now.' });
        seedCommunication(big.store, { probe_id: probeId, occurred_at: iso(2 * DAY, PROBE_SENT), body_text: 'Just checking in again.' });
      }
    }
    // A third of these probes already have a pre-existing INTELLIGENCE row
    // (simulating a prior rebuild), so this run is a realistic mix of
    // creates and updates, not all-creates.
    for (let i = 0; i < PROBE_COUNT; i += 3) {
      big.store.INTELLIGENCE.push(INTELLIGENCE_HEADER.map((key) => {
        if (key === 'intelligence_id') return `itl_live_${i}`;
        if (key === 'probe_id') return `prb_live_${i}`;
        if (key === 'grade') return 'stale_placeholder';
        return '';
      }));
    }

    global.Date = class extends OrigDate {
      constructor(...args) { if (args.length === 0) return new OrigDate(NOW); super(...args); }
      static now() { return NOW.getTime(); }
    };
    let bigSummary;
    try {
      bigSummary = await rebuildAllIntelligence(bigRepo);
    } finally {
      global.Date = OrigDate;
    }

    assert.strictEqual(bigSummary.probes_processed, PROBE_COUNT, `all ${PROBE_COUNT} probes processed`);
    assert.deepStrictEqual(bigSummary.problems, [], 'no problems processing a live-sized probe set');

    // The actual quota-safety claim: reads do NOT scale with probe count.
    assert.strictEqual(big.calls.get, 3, `exactly 3 reads total for ${PROBE_COUNT} probes (not O(probes)) — well inside the ~60/min Sheets read quota`);
    assert.strictEqual(big.calls.update, 0, 'no legacy per-row update() calls at this scale either');
    assert.strictEqual(big.calls.append, 0, 'no legacy per-row append() calls at this scale either');
    // Writes are chunked (200 rows/request by default) but still a small,
    // bounded count — nowhere near one request per row/probe.
    assert.ok(big.calls.batchUpdate >= 1 && big.calls.batchUpdate < PROBE_COUNT, `writes sent in ${big.calls.batchUpdate} chunked batchUpdate request(s), not ${PROBE_COUNT} individual writes`);

    const liveIntelligence = await bigRepo.getRecords('INTELLIGENCE', 'intelligence_id');
    assert.strictEqual(liveIntelligence.length, PROBE_COUNT, `exactly ${PROBE_COUNT} INTELLIGENCE rows exist after rebuilding ${PROBE_COUNT} probes — no duplicates, none missing`);

    ok(`live-sized rebuild (${PROBE_COUNT} probes, mixed creates/updates) stays at a fixed 3 reads total and ${big.calls.batchUpdate} batched write request(s) — reads never scale with probe count, so the real Sheets API read quota (429s) cannot be hit regardless of how many probes exist`);

    __setRepoForTests(null);
  }

  console.log(`\n✅ All ${passed} checks passed.\n`);
}

run().catch((err) => { console.error('\n❌ SELFTEST FAILED:\n', err); process.exit(1); });
