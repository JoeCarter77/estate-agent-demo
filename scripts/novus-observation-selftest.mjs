// scripts/novus-observation-selftest.mjs — hermetic Observation & Evidence
// Engine test (no network, no creds).
//
// Exercises the REAL code paths — lib/classification.mjs, lib/observation.mjs,
// lib/grading.mjs, and the recompute endpoint — against an in-memory fake that
// mimics the Google Sheets values API and the live workbook's confirmed
// headers, for PROBES, COMMUNICATIONS and INTELLIGENCE.
//
// Run:  npm run novus:observation-selftest  (or: node scripts/novus-observation-selftest.mjs)

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { classifyCommunication } from '../lib/classification.mjs';
import { computeObservation } from '../lib/observation.mjs';
import { gradeObservation } from '../lib/grading.mjs';

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

// ── In-memory fake of the Google Sheets values API ────────────────────────────
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

function seedProbe(store, { probe_id, agency_id = 'ag_1', probe_timestamp, observation_deadline }) {
  const row = PROBES_HEADER.map((key) => {
    if (key === 'probe_id') return probe_id;
    if (key === 'agency_id') return agency_id;
    if (key === 'probe_status') return 'observing';
    if (key === 'probe_timestamp') return probe_timestamp;
    if (key === 'observation_deadline') return observation_deadline;
    return '';
  });
  store.PROBES.push(row);
}

let commSeq = 0;
function seedCommunication(store, { probe_id, agency_id = 'ag_1', occurred_at, channel = 'email', from = 'agent@agency-one.co.uk', subject = '', body_text = '' }) {
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
    if (key === 'matching_method') return 'email_exact';
    if (key === 'match_score') return 1;
    // classification columns intentionally start blank — recompute fills them.
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

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PROBE_SENT = '2026-08-01T21:00:00.000Z'; // ~9pm, per Source Master §7

async function run() {
  process.env.NOVUS_BASIC_AUTH_USER = 'novus';
  process.env.NOVUS_BASIC_AUTH_PASS = 'test-pass';
  const { default: recompute } = await import('../api/novus/observation/recompute.js');

  function mockReq(body) {
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

  // ── lib/classification.mjs — narrow deterministic rules ──
  console.log('\nclassification.mjs');
  {
    const auto = classifyCommunication({ source_identifier_raw: 'no-reply@agency.co.uk', subject: 'Auto-reply', body_text: 'This is an automated message.' });
    assert.strictEqual(auto.automated_or_human, 'automated', 'known no-reply sender classified automated');
    assert.strictEqual(auto.human_contact, false, 'automated sender never counts as human contact');
    assert.strictEqual(auto.communication_classification, 'auto_acknowledgement', 'auto-ack phrase detected');

    const human = classifyCommunication({ source_identifier_raw: 'jane@agency.co.uk', subject: 'Re: your enquiry', body_text: 'Hi, thanks for your interest, give me a call.' });
    assert.strictEqual(human.automated_or_human, 'human', 'unrecognised sender defaults to human');
    assert.strictEqual(human.human_contact, true, 'human contact true when no automated signal matched');

    const unknown = classifyCommunication({ source_identifier_raw: '', subject: '', body_text: '' });
    assert.strictEqual(unknown.automated_or_human, 'unknown', 'degenerate row (no sender/subject/body) stays unknown, not guessed');

    const bounce = classifyCommunication({ source_identifier_raw: 'mailer-daemon@agency.co.uk', subject: 'Undelivered', body_text: '' });
    assert.strictEqual(bounce.automated_or_human, 'automated', 'mailer-daemon is automated');
    assert.strictEqual(bounce.communication_classification, '', 'a bounce is never an acknowledgement');

    ok('known auto-sender/phrase -> automated + auto_acknowledgement; unmatched -> human; degenerate -> unknown; bounce is automated but not an ack');
  }

  // ── Test A: human contact <=1h, 2+ follow-ups ──
  console.log('\nTest A — human contact inside 1h + 2+ follow-ups');
  {
    const { store, valuesApi } = makeFakeSheet();
    __setRepoForTests(createRepo(valuesApi));
    seedProbe(store, { probe_id: 'prb_a', probe_timestamp: PROBE_SENT, observation_deadline: iso(7 * DAY, PROBE_SENT) });
    seedCommunication(store, { probe_id: 'prb_a', occurred_at: iso(30 * 60 * 1000, PROBE_SENT), body_text: 'Thanks, calling you now.' });
    seedCommunication(store, { probe_id: 'prb_a', occurred_at: iso(2 * DAY, PROBE_SENT), body_text: 'Just checking in again.' });
    seedCommunication(store, { probe_id: 'prb_a', occurred_at: iso(4 * DAY, PROBE_SENT), body_text: 'One more follow up, still interested?' });

    const res = mockRes();
    await recompute(mockReq({ probe_id: 'prb_a' }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.grade, 'A', `expected A, got ${res.body.grade}: ${res.body.grade_reason}`);
    assert.strictEqual(res.body.observation.follow_up_count, 2, 'two follow-ups counted');
    ok('grade A produced for fast contact + 2 follow-ups');
    __setRepoForTests(null);
  }

  // ── Test B: fast human contact (<=16h), zero follow-up ──
  console.log('\nTest B — fast human contact, zero follow-up');
  {
    const { store, valuesApi } = makeFakeSheet();
    __setRepoForTests(createRepo(valuesApi));
    seedProbe(store, { probe_id: 'prb_b', probe_timestamp: PROBE_SENT, observation_deadline: iso(7 * DAY, PROBE_SENT) });
    seedCommunication(store, { probe_id: 'prb_b', occurred_at: iso(10 * HOUR, PROBE_SENT), body_text: 'Thanks for your interest, someone will be in touch.' });

    const res = mockRes();
    await recompute(mockReq({ probe_id: 'prb_b' }), res);
    assert.strictEqual(res.body.grade, 'B', `expected B, got ${res.body.grade}: ${res.body.grade_reason}`);
    ok('grade B produced for <=16h contact + zero follow-up');
    __setRepoForTests(null);
  }

  // ── Test C: automated acknowledgement only ──
  console.log('\nTest C — automated acknowledgement only, no human contact, window closed');
  {
    const { store, valuesApi } = makeFakeSheet();
    __setRepoForTests(createRepo(valuesApi));
    seedProbe(store, { probe_id: 'prb_c', probe_timestamp: PROBE_SENT, observation_deadline: iso(7 * DAY, PROBE_SENT) });
    seedCommunication(store, {
      probe_id: 'prb_c', occurred_at: iso(5 * 60 * 1000, PROBE_SENT), from: 'no-reply@agency.co.uk',
      subject: 'We have received your enquiry', body_text: 'This is an automated response.',
    });

    const res = mockRes();
    await recompute(mockReq({ probe_id: 'prb_c' }), res);
    assert.strictEqual(res.body.grade, 'C', `expected C, got ${res.body.grade}: ${res.body.grade_reason}`);
    assert.strictEqual(res.body.observation.first_human_touch, 'no', 'no human contact');
    ok('grade C produced for auto-ack only, no human contact');
    __setRepoForTests(null);
  }

  // ── Test D: slow human contact (>16h), zero follow-up ──
  console.log('\nTest D — slow human contact, zero follow-up');
  {
    const { store, valuesApi } = makeFakeSheet();
    __setRepoForTests(createRepo(valuesApi));
    seedProbe(store, { probe_id: 'prb_d', probe_timestamp: PROBE_SENT, observation_deadline: iso(7 * DAY, PROBE_SENT) });
    seedCommunication(store, { probe_id: 'prb_d', occurred_at: iso(20 * HOUR, PROBE_SENT), body_text: 'Sorry for the delay, calling now.' });

    const res = mockRes();
    await recompute(mockReq({ probe_id: 'prb_d' }), res);
    assert.strictEqual(res.body.grade, 'D', `expected D, got ${res.body.grade}: ${res.body.grade_reason}`);
    ok('grade D produced for >16h contact + zero follow-up');
    __setRepoForTests(null);
  }

  // ── Test E: nothing on any channel, window closed ──
  console.log('\nTest E — nothing on any channel after 7 days');
  {
    const { store, valuesApi } = makeFakeSheet();
    __setRepoForTests(createRepo(valuesApi));
    seedProbe(store, { probe_id: 'prb_e', probe_timestamp: PROBE_SENT, observation_deadline: iso(7 * DAY, PROBE_SENT) });

    const res = mockRes();
    await recompute(mockReq({ probe_id: 'prb_e' }), res);
    assert.strictEqual(res.body.grade, 'E', `expected E, got ${res.body.grade}: ${res.body.grade_reason}`);
    ok('grade E produced for zero evidence after window closes');
    __setRepoForTests(null);
  }

  // ── Test ungraded: fast contact + 1 follow-up (undefined combination) ──
  console.log('\nTest ungraded — fast contact with exactly 1 follow-up (Source Master does not define this)');
  {
    const { store, valuesApi } = makeFakeSheet();
    __setRepoForTests(createRepo(valuesApi));
    seedProbe(store, { probe_id: 'prb_u', probe_timestamp: PROBE_SENT, observation_deadline: iso(7 * DAY, PROBE_SENT) });
    seedCommunication(store, { probe_id: 'prb_u', occurred_at: iso(30 * 60 * 1000, PROBE_SENT), body_text: 'Calling now.' });
    seedCommunication(store, { probe_id: 'prb_u', occurred_at: iso(2 * DAY, PROBE_SENT), body_text: 'Checking in.' });

    const res = mockRes();
    await recompute(mockReq({ probe_id: 'prb_u' }), res);
    assert.strictEqual(res.body.grade, 'ungraded', `expected ungraded, got ${res.body.grade}`);
    assert.strictEqual(res.body.observation.follow_up_count, 1);
    ok('undefined A/B/D combination resolves to ungraded, not invented');
    __setRepoForTests(null);
  }

  // ── Idempotency + raw/matching field preservation ──
  console.log('\nIdempotent recomputation + raw/matching field preservation');
  {
    const { store, valuesApi } = makeFakeSheet();
    __setRepoForTests(createRepo(valuesApi));
    seedProbe(store, { probe_id: 'prb_i', probe_timestamp: PROBE_SENT, observation_deadline: iso(7 * DAY, PROBE_SENT) });
    seedCommunication(store, {
      probe_id: 'prb_i', occurred_at: iso(30 * 60 * 1000, PROBE_SENT),
      from: 'Jane@Agency-One.co.uk', subject: 'Original subject', body_text: 'Original body, calling now.',
    });
    seedCommunication(store, { probe_id: 'prb_i', occurred_at: iso(2 * DAY, PROBE_SENT), body_text: 'Follow up 1.' });
    seedCommunication(store, { probe_id: 'prb_i', occurred_at: iso(4 * DAY, PROBE_SENT), body_text: 'Follow up 2.' });

    const beforeRaw = store.COMMUNICATIONS.slice(2).map((r) => r.slice());

    const res1 = mockRes();
    await recompute(mockReq({ probe_id: 'prb_i' }), res1);
    assert.strictEqual(res1.body.grade, 'A');
    assert.strictEqual(res1.body.communications_updated, 3, 'first run classifies all 3 rows');
    assert.strictEqual(store.INTELLIGENCE.length, 3, 'exactly one INTELLIGENCE data row created');
    const intelligenceIdAfterFirst = res1.body.intelligence_id;

    const res2 = mockRes();
    await recompute(mockReq({ probe_id: 'prb_i' }), res2);
    assert.strictEqual(res2.body.grade, 'A', 'grade stable across re-run');
    assert.strictEqual(res2.body.intelligence_id, intelligenceIdAfterFirst, 'same INTELLIGENCE row reused, not duplicated');
    assert.strictEqual(store.INTELLIGENCE.length, 3, 'still exactly one INTELLIGENCE data row after re-run');
    assert.strictEqual(res2.body.communications_updated, 0, 'second run does not reclassify already-classified rows');

    // Raw evidence + deterministic matching columns must be byte-for-byte
    // unchanged by recompute — only classification columns were writable.
    const RAW_MATCH_COLUMNS = [
      'communication_id', 'occurred_at', 'received_at', 'channel', 'direction',
      'source_identifier_raw', 'source_identifier_normalized', 'subject', 'body_text',
      'raw_content', 'matching_method', 'match_score', 'match_status', 'probe_id', 'agency_id',
    ];
    const idxOf = (key) => COMMUNICATIONS_HEADER.indexOf(key);
    const afterRaw = store.COMMUNICATIONS.slice(2, 5);
    for (let i = 0; i < beforeRaw.length; i++) {
      for (const col of RAW_MATCH_COLUMNS) {
        assert.strictEqual(afterRaw[i][idxOf(col)], beforeRaw[i][idxOf(col)], `${col} unchanged on row ${i}`);
      }
    }
    ok('idempotent re-run: stable grade, single INTELLIGENCE row, no reclassification, raw/matching COMMUNICATIONS columns untouched');
    __setRepoForTests(null);
  }

  console.log(`\n✅ All ${passed} checks passed.\n`);
}

run().catch((err) => { console.error('\n❌ SELFTEST FAILED:\n', err); process.exit(1); });
