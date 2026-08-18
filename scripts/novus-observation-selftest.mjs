// scripts/novus-observation-selftest.mjs — hermetic Observation & Evidence
// Engine test (no network, no creds).
//
// Exercises the REAL code paths — lib/classification.mjs, lib/observation.mjs
// (including the 30-minute contact-attempt grouping rule), lib/grading.mjs
// (the A-H engine), and the recompute endpoint — against an in-memory fake
// that mimics the Google Sheets values API and the live workbook's confirmed
// headers, for PROBES, COMMUNICATIONS and INTELLIGENCE.
//
// Run:  npm run novus:observation-selftest  (or: node scripts/novus-observation-selftest.mjs)

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { classifyCommunication } from '../lib/classification.mjs';
import { computeObservation, groupContactAttempts } from '../lib/observation.mjs';
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

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
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

  async function runProbeGrade(probeId, comms) {
    const { store, valuesApi } = makeFakeSheet();
    __setRepoForTests(createRepo(valuesApi));
    seedProbe(store, { probe_id: probeId, probe_timestamp: PROBE_SENT, observation_deadline: iso(4 * DAY, PROBE_SENT) });
    for (const c of comms) seedCommunication(store, { probe_id: probeId, ...c });
    const res = mockRes();
    await recompute(mockReq({ probe_id: probeId }), res);
    __setRepoForTests(null);
    return res.body;
  }

  // ── lib/classification.mjs — narrow deterministic rules (unchanged by this update) ──
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

  // ── 30-minute contact-attempt grouping — unit-level, direct against groupContactAttempts ──
  console.log('\n30-minute contact-attempt grouping (lib/observation.mjs groupContactAttempts)');
  {
    function touches(offsetsMin) {
      return offsetsMin.map((m) => ({ label: `${m}m`, _occurredAt: new Date(PROBE_SENT).getTime() + m * MIN }))
        .map((t) => ({ ...t, _occurredAt: new Date(t._occurredAt) }));
    }
    function attemptSizes(offsetsMin) {
      return groupContactAttempts(touches(offsetsMin)).map((a) => a.length);
    }

    // 1. call -> voicemail immediately
    assert.deepStrictEqual(attemptSizes([0, 1]), [2], '1) call+voicemail immediately = 1 attempt');
    // 2. call -> voicemail -> SMS within 30 mins
    assert.deepStrictEqual(attemptSizes([0, 1, 25]), [3], '2) call+voicemail+SMS within 30min = 1 attempt');
    // 3. call -> email within 30 mins
    assert.deepStrictEqual(attemptSizes([0, 29]), [2], '3) call + email at 29min = 1 attempt (within window)');
    // 4. call -> email at 31 mins
    assert.deepStrictEqual(attemptSizes([0, 31]), [1, 1], '4) call + email at 31min = 2 attempts (crosses window)');
    // 5. call -> several communications over 30 mins (some inside, one crosses)
    assert.deepStrictEqual(attemptSizes([0, 5, 20, 45]), [3, 1], '5) several comms: 0/5/20 grouped, 45 starts new attempt');
    // 6. multiple channels within the same attempt
    assert.deepStrictEqual(
      groupContactAttempts([
        { channel: 'voice', _occurredAt: new Date(new Date(PROBE_SENT).getTime()) },
        { channel: 'email', _occurredAt: new Date(new Date(PROBE_SENT).getTime() + 10 * MIN) },
        { channel: 'sms', _occurredAt: new Date(new Date(PROBE_SENT).getTime() + 20 * MIN) },
      ]).length,
      1,
      '6) voice+email+sms all within 30min of attempt start = 1 attempt regardless of channel mix',
    );
    // 7. two genuinely separate attempts
    assert.deepStrictEqual(attemptSizes([0, 2 * 60]), [1, 1], '7) two touches 2h apart = 2 genuinely separate attempts');
    // 8. 3+ genuine follow-ups (4 attempts total)
    assert.deepStrictEqual(attemptSizes([0, 60, 120, 180]), [1, 1, 1, 1], '8) four touches 1h apart each = 4 attempts (3 follow-ups)');

    // Anchor-does-not-reset check: attempt starting at 0 stays anchored to 0,
    // not to the 25min touch — a touch at 50min (20min after the 25min touch,
    // but 50min after attempt start) must start a NEW attempt.
    assert.deepStrictEqual(attemptSizes([0, 25, 50]), [2, 1], 'window anchored to attempt START, not the previous communication');

    ok('30-minute grouping matches all 8 required scenarios + anchor-does-not-reset rule');
  }

  // ── Grade A: very fast (<=1h) + persistent (1+ genuine follow-up attempts) ──
  console.log('\nGrade A — very fast + persistent');
  {
    const body = await runProbeGrade('prb_a', [
      { occurred_at: iso(30 * MIN, PROBE_SENT), body_text: 'Thanks, calling you now.' },
      { occurred_at: iso(2 * DAY, PROBE_SENT), body_text: 'Just checking in again.' },
    ]);
    assert.strictEqual(body.grade, 'A', `expected A, got ${body.grade}: ${body.grade_reason}`);
    assert.strictEqual(body.observation.follow_up_count, 1, 'one genuine follow-up attempt (2 days later, well outside 30min)');
    ok('grade A: <=1h contact + 1 genuine follow-up attempt');
  }

  // ── Grade B: fast (>1h, <=16h) + persistent ──
  console.log('\nGrade B — fast + persistent');
  {
    const body = await runProbeGrade('prb_b', [
      { occurred_at: iso(10 * HOUR, PROBE_SENT), body_text: 'Sorry for the delay, calling now.' },
      { occurred_at: iso(10 * HOUR + 45 * MIN, PROBE_SENT), body_text: 'Following up again.' },
    ]);
    assert.strictEqual(body.grade, 'B', `expected B, got ${body.grade}: ${body.grade_reason}`);
    assert.strictEqual(body.observation.follow_up_count, 1);
    ok('grade B: >1h,<=16h contact + 1 genuine follow-up attempt');
  }

  // ── Grade C: very fast (<=1h) + non-persistent (0 genuine follow-ups) ──
  // This is the exact shape of prb_msstv7xg_nksnc0: a call/voicemail and an
  // SMS both inside the 30-minute window of the first attempt.
  console.log('\nGrade C — very fast + non-persistent (regression case: prb_msstv7xg_nksnc0 shape)');
  {
    const body = await runProbeGrade('prb_c', [
      { occurred_at: iso(9 * MIN, PROBE_SENT), channel: 'voice', body_text: 'voicemail: It.' },
      { occurred_at: iso(10 * MIN, PROBE_SENT), channel: 'sms', body_text: 'Please call me back to arrange a viewing.' },
    ]);
    assert.strictEqual(body.grade, 'C', `expected C, got ${body.grade}: ${body.grade_reason}`);
    assert.strictEqual(body.observation.follow_up_count, 0, 'the SMS 1 minute after the call is the SAME attempt, not a follow-up');
    assert.strictEqual(body.observation.contact_attempt_count, 1);
    ok('grade C: <=1h contact + 0 genuine follow-ups (voicemail + SMS grouped into one attempt)');
  }

  // ── inbound_sms_count / email_touch_count / channels_used ──
  console.log('\ninbound_sms_count / email_touch_count / channels_used (SMS + Email evidence)');
  {
    const body = await runProbeGrade('prb_sms_email', [
      { occurred_at: iso(10 * MIN, PROBE_SENT), channel: 'sms', body_text: 'Please call me back to arrange a viewing.' },
      { occurred_at: iso(20 * MIN, PROBE_SENT), channel: 'email', body_text: "Hi, it's Jane, following up on your enquiry." },
      {
        occurred_at: iso(1 * HOUR, PROBE_SENT), channel: 'email',
        from: 'no-reply@agency.co.uk', subject: 'We have received your enquiry', body_text: 'This is an automated response.',
      },
    ]);
    assert.strictEqual(body.observation.inbound_sms_count, 1, 'one human SMS touch counted');
    assert.strictEqual(body.observation.email_touch_count, 1, 'one human email touch counted; the automated email is excluded');
    assert.strictEqual(body.observation.channels_used, 'sms,email', 'channels_used includes both sms and email');
    ok('inbound_sms_count and email_touch_count count only human-contact touches; automated email excluded; channels_used includes sms + email');
  }

  // ── Grade D: fast (>1h, <=16h) + non-persistent ──
  console.log('\nGrade D — fast + non-persistent');
  {
    const body = await runProbeGrade('prb_d', [
      { occurred_at: iso(10 * HOUR, PROBE_SENT), body_text: 'Sorry for the delay, calling now.' },
    ]);
    assert.strictEqual(body.grade, 'D', `expected D, got ${body.grade}: ${body.grade_reason}`);
    assert.strictEqual(body.observation.follow_up_count, 0);
    ok('grade D: >1h,<=16h contact + 0 genuine follow-ups');
  }

  // ── Grade E: slow (>16h) + persistent ──
  console.log('\nGrade E — slow + persistent');
  {
    const body = await runProbeGrade('prb_e', [
      { occurred_at: iso(20 * HOUR, PROBE_SENT), body_text: 'Sorry for the delay, calling now.' },
      { occurred_at: iso(3 * DAY, PROBE_SENT), body_text: 'Checking in again.' },
    ]);
    assert.strictEqual(body.grade, 'E', `expected E, got ${body.grade}: ${body.grade_reason}`);
    assert.strictEqual(body.observation.follow_up_count, 1);
    ok('grade E: >16h contact + 1 genuine follow-up attempt');
  }

  // ── Grade F: slow (>16h) + non-persistent ──
  console.log('\nGrade F — slow + non-persistent');
  {
    const body = await runProbeGrade('prb_f', [
      { occurred_at: iso(20 * HOUR, PROBE_SENT), body_text: 'Sorry for the delay, calling now.' },
    ]);
    assert.strictEqual(body.grade, 'F', `expected F, got ${body.grade}: ${body.grade_reason}`);
    assert.strictEqual(body.observation.follow_up_count, 0);
    ok('grade F: >16h contact + 0 genuine follow-ups');
  }

  // ── Grade G: automated acknowledgement only, no human contact ──
  console.log('\nGrade G — automated acknowledgement only');
  {
    const body = await runProbeGrade('prb_g', [
      { occurred_at: iso(5 * MIN, PROBE_SENT), from: 'no-reply@agency.co.uk', subject: 'We have received your enquiry', body_text: 'This is an automated response.' },
    ]);
    assert.strictEqual(body.grade, 'G', `expected G, got ${body.grade}: ${body.grade_reason}`);
    assert.strictEqual(body.observation.first_human_touch, 'no', 'no human contact');
    ok('grade G: auto-ack only, no human contact');
  }

  // ── Grade H: nothing on any channel, window closed ──
  console.log('\nGrade H — no meaningful response after 4 days');
  {
    const body = await runProbeGrade('prb_h', []);
    assert.strictEqual(body.grade, 'H', `expected H, got ${body.grade}: ${body.grade_reason}`);
    ok('grade H: zero evidence after window closes');
  }

  // ── 4-day window boundary — deterministic (controlled `now`, not real
  // wall-clock), proving the window is exactly 4 days, not 7. ──
  console.log('\n4-day observation window boundary (deterministic)');
  {
    const probe = { probe_timestamp: PROBE_SENT, observation_deadline: iso(4 * DAY, PROBE_SENT) };
    const observation = computeObservation(probe, []);

    const justBeforeClose = gradeObservation({ probe, observation, now: new Date(iso(4 * DAY - 1 * MIN, PROBE_SENT)) });
    assert.strictEqual(justBeforeClose.grade, 'pending', 'window still open 1 minute before the 4-day deadline -> pending, not H');

    const justAfterClose = gradeObservation({ probe, observation, now: new Date(iso(4 * DAY + 1 * MIN, PROBE_SENT)) });
    assert.strictEqual(justAfterClose.grade, 'H', 'window closed 1 minute after the 4-day deadline -> H');

    // A 7-day-old probe evidence-free at the OLD deadline must already be H
    // under the new 4-day policy — proves the window is genuinely 4 days,
    // not a leftover 7-day value that happens to still read as "closed".
    const atOldSevenDayMark = gradeObservation({ probe, observation, now: new Date(iso(5 * DAY, PROBE_SENT)) });
    assert.strictEqual(atOldSevenDayMark.grade, 'H', 'still closed well past 4 days (5 days), consistent with the 4-day policy');

    ok('observation window closes at exactly 4 days (pending just before, H just after) — not 7');
  }

  // ── Exhaustiveness: the old "ungraded" gap (fast contact + exactly 1
  // follow-up) must now resolve cleanly to a real grade, not fall through. ──
  console.log('\nExhaustiveness — former A-E "ungraded" gap now resolves to a real grade');
  {
    const body = await runProbeGrade('prb_gap', [
      { occurred_at: iso(30 * MIN, PROBE_SENT), body_text: 'Calling now.' },
      { occurred_at: iso(2 * DAY, PROBE_SENT), body_text: 'Checking in.' },
    ]);
    assert.notStrictEqual(body.grade, 'ungraded', 'the old A-E system left this combination ungraded; A-H must not');
    assert.strictEqual(body.grade, 'A', 'very fast contact + 1 genuine follow-up attempt is Grade A under A-H');
    ok('former ungraded gap (fast contact + exactly 1 follow-up) now resolves to Grade A, not ungraded');
  }

  // ── G/H must never overlap with A-F, and grading engine must not read
  // unrelated intelligence fields (callback_attempts, persistence_profile,
  // contact_quality, voicemail_count, booking_attempt). ──
  console.log('\nG/H isolation from A-F + grading engine field isolation');
  {
    // Human contact present alongside a spoofed high callback_attempts /
    // booking_attempt / persistence_profile must still grade purely on
    // lag + follow_up_count — never on those unrelated fields.
    const observation = {
      first_human_touch: 'yes',
      human_lag_hours: 0.5,
      follow_up_count: 0,
      auto_acknowledgement: true, // even if true, hasHumanContact must take priority over G
      last_touch_at: iso(30 * MIN, PROBE_SENT),
      callback_attempts: 99,
      persistence_profile: 'high',
      contact_quality: 'Booking attempt',
      voicemail_count: 99,
      booking_attempt: true,
    };
    const probe = { probe_timestamp: PROBE_SENT, observation_deadline: iso(4 * DAY, PROBE_SENT) };
    const { grade } = gradeObservation({ probe, observation, now: new Date(iso(1 * DAY, PROBE_SENT)) });
    assert.strictEqual(grade, 'C', 'human contact takes priority over auto_acknowledgement=true (G never fires when a human touch exists)');
    ok('human-contact grades (A-F) always take priority over G, regardless of auto_acknowledgement or unrelated intelligence fields');
  }

  // ── Idempotency + raw/matching field preservation (unchanged behaviour) ──
  console.log('\nIdempotent recomputation + raw/matching field preservation');
  {
    const { store, valuesApi } = makeFakeSheet();
    __setRepoForTests(createRepo(valuesApi));
    seedProbe(store, { probe_id: 'prb_i', probe_timestamp: PROBE_SENT, observation_deadline: iso(4 * DAY, PROBE_SENT) });
    seedCommunication(store, {
      probe_id: 'prb_i', occurred_at: iso(30 * MIN, PROBE_SENT),
      from: 'Jane@Agency-One.co.uk', subject: 'Original subject', body_text: 'Original body, calling now.',
    });
    seedCommunication(store, { probe_id: 'prb_i', occurred_at: iso(1 * DAY, PROBE_SENT), body_text: 'Follow up 1.' });
    seedCommunication(store, { probe_id: 'prb_i', occurred_at: iso(2 * DAY, PROBE_SENT), body_text: 'Follow up 2.' });

    const beforeRaw = store.COMMUNICATIONS.slice(2).map((r) => r.slice());

    const res1 = mockRes();
    await recompute(mockReq({ probe_id: 'prb_i' }), res1);
    assert.strictEqual(res1.body.grade, 'A');
    assert.strictEqual(res1.body.observation.follow_up_count, 2, 'two genuinely separate follow-up attempts (2 days, 4 days apart)');
    assert.strictEqual(res1.body.communications_updated, 3, 'first run classifies all 3 rows');
    assert.strictEqual(store.INTELLIGENCE.length, 3, 'exactly one INTELLIGENCE data row created');
    // API response shape: communications_updated is a SIBLING of observation, not nested inside it.
    assert.ok('communications_updated' in res1.body, 'communications_updated present at top level');
    assert.ok(!('communications_updated' in res1.body.observation), 'communications_updated NOT nested inside observation');
    const intelligenceIdAfterFirst = res1.body.intelligence_id;

    const res2 = mockRes();
    await recompute(mockReq({ probe_id: 'prb_i' }), res2);
    assert.strictEqual(res2.body.grade, 'A', 'grade stable across re-run');
    assert.strictEqual(res2.body.intelligence_id, intelligenceIdAfterFirst, 'same INTELLIGENCE row reused, not duplicated');
    assert.strictEqual(store.INTELLIGENCE.length, 3, 'still exactly one INTELLIGENCE data row after re-run');
    assert.strictEqual(res2.body.communications_updated, 0, 'second run does not reclassify already-classified rows');

    // Raw evidence + deterministic matching columns must be byte-for-byte
    // unchanged by recompute — only classification/follow_up columns writable.
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

  // ── Recompute is manual, not webhook-triggered (production regression):
  // a genuine second contact attempt lands in COMMUNICATIONS via the normal
  // webhook path, but INTELLIGENCE only reflects it once recompute is
  // re-run for that probe_id. This mirrors exactly what happened with
  // prb_msstv7xg_nksnc0 in production — same INTELLIGENCE row (upserted, not
  // duplicated), grade recalculates C -> A the moment recompute runs again. ──
  console.log('\nRecompute recalculation — genuine second attempt moves Grade C -> A (prb_msstv7xg_nksnc0 shape)');
  {
    const { store, valuesApi } = makeFakeSheet();
    __setRepoForTests(createRepo(valuesApi));
    seedProbe(store, { probe_id: 'prb_recalc', probe_timestamp: PROBE_SENT, observation_deadline: iso(4 * DAY, PROBE_SENT) });
    seedCommunication(store, { probe_id: 'prb_recalc', occurred_at: iso(9 * MIN, PROBE_SENT), channel: 'voice', body_text: 'voicemail: It.' });
    seedCommunication(store, { probe_id: 'prb_recalc', occurred_at: iso(10 * MIN, PROBE_SENT), channel: 'sms', body_text: 'Please call me back to arrange a viewing.' });

    // First recompute — matches production's actual result before the
    // follow-up arrived: Grade C, 1 contact attempt, 0 follow-ups.
    const res1 = mockRes();
    await recompute(mockReq({ probe_id: 'prb_recalc' }), res1);
    assert.strictEqual(res1.body.grade, 'C', `expected C before follow-up, got ${res1.body.grade}`);
    assert.strictEqual(res1.body.observation.contact_attempt_count, 1);
    assert.strictEqual(res1.body.observation.follow_up_count, 0);
    const intelligenceIdBeforeFollowUp = res1.body.intelligence_id;

    // A genuine follow-up communication arrives via the normal webhook path
    // (simulated here by seeding a COMMUNICATIONS row directly, same as a
    // real inbound SMS webhook would) — 74 minutes after the FIRST attempt's
    // start (9min mark), well past the 30-minute window, so it is NOT part
    // of attempt 1. Raw communication events remain individually stored:
    // this is a brand new COMMUNICATIONS row, not an edit of the first two.
    seedCommunication(store, { probe_id: 'prb_recalc', occurred_at: iso(9 * MIN + 74 * MIN, PROBE_SENT), channel: 'sms', body_text: 'Do you have any time this week?' });
    assert.strictEqual(store.COMMUNICATIONS.length, 5, 'three raw COMMUNICATIONS rows now exist (2 header/schema rows + 3 data rows)');

    // Recompute is NOT automatically triggered by ingestion — this manual
    // re-run is standing in for the still-missing production trigger.
    const res2 = mockRes();
    await recompute(mockReq({ probe_id: 'prb_recalc' }), res2);
    assert.strictEqual(res2.body.grade, 'A', `expected A after genuine follow-up, got ${res2.body.grade}: ${res2.body.grade_reason}`);
    assert.strictEqual(res2.body.observation.contact_attempt_count, 2, 'the 74-minute-later SMS starts contact attempt 2');
    assert.strictEqual(res2.body.observation.follow_up_count, 1, 'exactly one genuine follow-up attempt');
    assert.strictEqual(res2.body.observation.human_lag_hours, res1.body.observation.human_lag_hours, 'human_lag_hours unchanged — still measured from the first human touch');
    assert.strictEqual(res2.body.intelligence_id, intelligenceIdBeforeFollowUp, 'same INTELLIGENCE row recalculated in place, not duplicated');
    assert.strictEqual(store.INTELLIGENCE.length, 3, 'still exactly one INTELLIGENCE data row after recalculation');

    ok('a genuine second contact attempt (>30min after attempt 1 start) recalculates Grade C -> A on the next recompute, same INTELLIGENCE row, raw events preserved individually');
    __setRepoForTests(null);
  }

  console.log(`\n✅ All ${passed} checks passed.\n`);
}

run().catch((err) => { console.error('\n❌ SELFTEST FAILED:\n', err); process.exit(1); });
