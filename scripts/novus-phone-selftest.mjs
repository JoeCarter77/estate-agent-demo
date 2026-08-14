// scripts/novus-phone-selftest.mjs — hermetic Communications Layer (voice/SMS)
// test (no network, no creds, no real Twilio account).
//
// Exercises the REAL code paths — lib/twilio-signature.mjs,
// lib/phone-matching.mjs, lib/classification.mjs (channel-aware path), and
// the three Twilio webhook handlers — against an in-memory fake Sheets API
// and hand-signed fake Twilio requests.
//
// Run:  npm run novus:phone-selftest

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { computeTwilioSignature } from '../lib/twilio-signature.mjs';
import { matchAgencyByPhone } from '../lib/phone-matching.mjs';
import { classifyCommunication } from '../lib/classification.mjs';

const AGENCIES_HEADER = [
  'agency_id','agency_name','website','domain','location','branch_count','main_phone',
  'known_phone_numbers','primary_contact_name','primary_contact_email','other_known_emails',
  'owner_md','independent_franchise_corporate','sales_led_lettings_only','years_trading',
  'incorporation_date','live_listing_count','crm_name','crm_evidence','qualification_segment',
  'current_pipeline_status','suppression_status','suppression_reason','notes','created_at','updated_at',
];
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
const RAW_EVENTS_HEADER = [
  'raw_event_id','provider','provider_event_id','channel','event_type','received_at','occurred_at',
  'source_identifier','destination_identifier','payload_reference','processing_status',
  'processed_communication_id','error_message','created_at',
];

function makeFakeSheet() {
  const store = {
    AGENCIES: [AGENCIES_HEADER.slice(), ['SCHEMA NOTE', 'Stable identity only.']],
    PROBES: [PROBES_HEADER.slice(), ['SCHEMA NOTE', 'One row per actual probe.']],
    COMMUNICATIONS: [COMMUNICATIONS_HEADER.slice(), ['SCHEMA NOTE', 'One row per meaningful communication.']],
    RAW_EVENTS: [RAW_EVENTS_HEADER.slice(), ['SCHEMA NOTE', 'Immutable provider webhook/event audit trail.']],
  };
  function tabOf(range) { return String(range).split('!')[0]; }
  function startRowOf(range) {
    const m = String(range).match(/!\D+(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }
  const valuesApi = {
    async get(range) { return (store[tabOf(range)] || []).map((r) => r.slice()); },
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

function seedAgency(store, { agency_id, main_phone = '', known_phone_numbers = '' }) {
  store.AGENCIES.push(AGENCIES_HEADER.map((key) => {
    if (key === 'agency_id') return agency_id;
    if (key === 'main_phone') return main_phone;
    if (key === 'known_phone_numbers') return known_phone_numbers;
    return '';
  }));
}

function seedProbe(store, { probe_id, agency_id, probe_status = 'observing', probe_timestamp, observation_deadline }) {
  store.PROBES.push(PROBES_HEADER.map((key) => {
    if (key === 'probe_id') return probe_id;
    if (key === 'agency_id') return agency_id;
    if (key === 'probe_status') return probe_status;
    if (key === 'probe_timestamp') return probe_timestamp || '';
    if (key === 'observation_deadline') return observation_deadline || '';
    return '';
  }));
}

function inWindow(offsetStartMs, offsetEndMs) {
  const now = Date.now();
  return {
    probe_timestamp: new Date(now + offsetStartMs).toISOString(),
    observation_deadline: new Date(now + offsetEndMs).toISOString(),
  };
}

const AUTH_TOKEN = 'test-twilio-auth-token';
const BASE_URL = 'https://novus.example.com';

function signedReq({ path, params, badSignature = false, noSignature = false }) {
  const url = `${BASE_URL}${path}`;
  const signature = noSignature ? undefined : (badSignature ? 'tampered-signature==' : computeTwilioSignature(AUTH_TOKEN, url, params));
  const headers = {};
  if (signature !== undefined) headers['x-twilio-signature'] = signature;
  return { method: 'POST', body: params, headers };
}

function mockRes() {
  return {
    statusCode: 200, body: null, headers: {}, _sentText: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    send(text) { this._sentText = text; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    end() { return this; },
  };
}

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

async function run() {
  process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
  process.env.NOVUS_PUBLIC_BASE_URL = BASE_URL;

  const { default: voiceInbound } = await import('../api/novus/webhooks/voice-inbound.js');
  const { default: voiceRecording } = await import('../api/novus/webhooks/voice-recording.js');
  const { default: smsInbound } = await import('../api/novus/webhooks/sms-inbound.js');

  // ── lib/twilio-signature.mjs ──
  console.log('\nSignature verification');
  {
    const { store, valuesApi } = makeFakeSheet();
    seedAgency(store, { agency_id: 'ag_1', main_phone: '+447700900123' });
    __setRepoForTests(createRepo(valuesApi));

    const params = { CallSid: 'CA_sig_test', From: '+447700900123', To: '+447575333064', CallStatus: 'ringing' };
    const res1 = mockRes();
    await voiceInbound(signedReq({ path: '/api/novus/webhooks/voice-inbound', params, badSignature: true }), res1);
    assert.strictEqual(res1.statusCode, 401, 'tampered signature rejected');

    const res2 = mockRes();
    await voiceInbound(signedReq({ path: '/api/novus/webhooks/voice-inbound', params, noSignature: true }), res2);
    assert.strictEqual(res2.statusCode, 401, 'missing signature rejected');

    assert.strictEqual(store.RAW_EVENTS.length, 2, 'no RAW_EVENTS written for unauthenticated requests');
    ok('voice-inbound rejects tampered/missing X-Twilio-Signature (401), writes nothing');
    __setRepoForTests(null);
  }

  // ── lib/phone-matching.mjs ──
  console.log('\nphone-matching.mjs');
  {
    const { store, valuesApi } = makeFakeSheet();
    seedAgency(store, { agency_id: 'ag_1', main_phone: '+447700900111' });
    seedAgency(store, { agency_id: 'ag_2', main_phone: '+447700900222', known_phone_numbers: '+447700900222' });
    __setRepoForTests(createRepo(valuesApi));
    const repo = createRepo(valuesApi);

    const exact = await matchAgencyByPhone(repo, '07700 900111');
    assert.strictEqual(exact.match_status, 'matched', 'UK national format normalises to E.164 and matches');
    assert.strictEqual(exact.agency_id, 'ag_1');
    assert.strictEqual(exact.matching_method, 'phone_exact');

    const unmatched = await matchAgencyByPhone(repo, '+447700900999');
    assert.strictEqual(unmatched.match_status, 'unmatched', 'unknown number stays unmatched, never guessed');

    ok('deterministic phone matching: UK-format normalisation, exact match, unmatched for unknown numbers');
    __setRepoForTests(null);
  }

  // ── lib/classification.mjs — channel-aware ──
  console.log('\nclassification.mjs — voice/SMS channel');
  {
    const voiceHuman = classifyCommunication({ channel: 'voice', source_identifier_raw: '+447700900111', body_text: '' });
    assert.strictEqual(voiceHuman.automated_or_human, 'human', 'a ringing call defaults to human (no mail-robot equivalent for phone numbers)');

    const voiceAutoAck = classifyCommunication({ channel: 'voice', source_identifier_raw: '+447700900111', body_text: 'Thank you for your enquiry, a member of our team will call you back.' });
    assert.strictEqual(voiceAutoAck.communication_classification, 'auto_acknowledgement', 'known auto-ack phrase in a voicemail transcript still detected');

    const emailAutoSender = classifyCommunication({ channel: 'email', source_identifier_raw: 'no-reply@agency.co.uk', body_text: '' });
    assert.strictEqual(emailAutoSender.automated_or_human, 'automated', 'email sender-pattern rule is unchanged by the channel-aware refactor');

    ok('voice/SMS default to human (no sender-pattern check), phrase-based auto-ack still applies, email path unchanged');
  }

  // ── End-to-end: voice-inbound -> voicemail TwiML, matched agency+probe ──
  console.log('\nvoice-inbound — matched agency + active probe, voicemail TwiML');
  {
    const { store, valuesApi } = makeFakeSheet();
    seedAgency(store, { agency_id: 'ag_1', main_phone: '+447700900123' });
    seedProbe(store, { probe_id: 'prb_1', agency_id: 'ag_1', ...inWindow(-1000 * 60 * 60, 1000 * 60 * 60 * 24) });
    __setRepoForTests(createRepo(valuesApi));

    const params = { CallSid: 'CA_001', From: '+447700900123', To: '+447575333064', CallStatus: 'ringing' };
    const res = mockRes();
    await voiceInbound(signedReq({ path: '/api/novus/webhooks/voice-inbound', params }), res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['Content-Type'], 'text/xml', 'TwiML content type');
    assert.ok(res._sentText.includes('<Record'), 'TwiML instructs Twilio to record a voicemail');
    assert.ok(!res._sentText.includes('<Dial'), 'never dials anywhere — Source Master S16');

    assert.strictEqual(store.COMMUNICATIONS.length, 3, 'one COMMUNICATIONS row written');
    const comm = Object.fromEntries(COMMUNICATIONS_HEADER.map((k, i) => [k, store.COMMUNICATIONS[2][i]]));
    assert.strictEqual(comm.agency_id, 'ag_1', 'agency matched by phone');
    assert.strictEqual(comm.probe_id, 'prb_1', 'probe matched (active observation window)');
    assert.strictEqual(comm.channel, 'voice');
    assert.strictEqual(comm.interaction_id, 'CA_001', 'CallSid stored for later recording/transcript correlation');
    assert.strictEqual(comm.human_contact, 'TRUE', 'a phone call defaults to human contact');
    assert.strictEqual(comm.callback_attempt, 'TRUE', 'every inbound call is evidence of a callback attempt');
    assert.strictEqual(comm.successful_conversation, 'FALSE', 'V1 never connects a live conversation (S16) — deterministic');
    assert.strictEqual(comm.voicemail_present, 'FALSE', 'not yet known at ringing time');
    ok('signed inbound call: RAW_EVENTS + COMMUNICATIONS written, agency+probe matched, voicemail-only TwiML, no live dial');
    __setRepoForTests(null);
  }

  // ── Idempotency: duplicate CallSid ──
  console.log('\nvoice-inbound — duplicate CallSid delivery');
  {
    const { store, valuesApi } = makeFakeSheet();
    seedAgency(store, { agency_id: 'ag_1', main_phone: '+447700900123' });
    __setRepoForTests(createRepo(valuesApi));

    const params = { CallSid: 'CA_dup', From: '+447700900123', To: '+447575333064', CallStatus: 'ringing' };
    await voiceInbound(signedReq({ path: '/api/novus/webhooks/voice-inbound', params }), mockRes());
    const res2 = mockRes();
    await voiceInbound(signedReq({ path: '/api/novus/webhooks/voice-inbound', params }), res2);

    assert.strictEqual(store.RAW_EVENTS.length, 3, 'still exactly one RAW_EVENTS row after redelivery');
    assert.strictEqual(store.COMMUNICATIONS.length, 3, 'still exactly one COMMUNICATIONS row after redelivery');
    assert.ok(res2._sentText.includes('<Record'), 'duplicate delivery still gets valid voicemail TwiML back');
    ok('redelivered CallSid produces one logical call, still valid TwiML');
    __setRepoForTests(null);
  }

  // ── voice-recording: recording callback then transcription callback ──
  console.log('\nvoice-recording — recording + transcription callbacks patch the existing Communication');
  {
    const { store, valuesApi } = makeFakeSheet();
    seedAgency(store, { agency_id: 'ag_1', main_phone: '+447700900123' });
    seedProbe(store, { probe_id: 'prb_1', agency_id: 'ag_1', ...inWindow(-1000 * 60 * 60, 1000 * 60 * 60 * 24) });
    __setRepoForTests(createRepo(valuesApi));

    await voiceInbound(signedReq({
      path: '/api/novus/webhooks/voice-inbound',
      params: { CallSid: 'CA_002', From: '+447700900123', To: '+447575333064', CallStatus: 'ringing' },
    }), mockRes());
    const beforeCount = store.COMMUNICATIONS.length;

    const recordingParams = { CallSid: 'CA_002', RecordingSid: 'RE_001', RecordingUrl: 'https://api.twilio.com/rec/RE_001', RecordingDuration: '18' };
    const resRecording = mockRes();
    await voiceRecording(signedReq({ path: '/api/novus/webhooks/voice-recording', params: recordingParams }), resRecording);
    assert.strictEqual(resRecording.statusCode, 200);

    const transcriptParams = { CallSid: 'CA_002', TranscriptionSid: 'TR_001', RecordingSid: 'RE_001', TranscriptionText: 'Hi, this is Jane from the agency, please call me back.' };
    const resTranscript = mockRes();
    await voiceRecording(signedReq({ path: '/api/novus/webhooks/voice-recording', params: transcriptParams }), resTranscript);
    assert.strictEqual(resTranscript.statusCode, 200);

    assert.strictEqual(store.COMMUNICATIONS.length, beforeCount, 'no new COMMUNICATIONS row created — the existing call row was patched');
    const comm = Object.fromEntries(COMMUNICATIONS_HEADER.map((k, i) => [k, store.COMMUNICATIONS[2][i]]));
    assert.strictEqual(comm.voicemail_present, 'TRUE', 'voicemail_present set once a recording exists');
    assert.strictEqual(comm.call_status, 'voicemail');
    assert.strictEqual(comm.duration_seconds, '18');
    assert.strictEqual(comm.recording_reference, 'https://api.twilio.com/rec/RE_001');
    assert.strictEqual(comm.transcript, 'Hi, this is Jane from the agency, please call me back.');
    assert.strictEqual(comm.human_contact, 'TRUE', 'transcript re-classification confirms human contact');

    // Idempotent re-delivery of the same recording callback.
    const resDupRecording = mockRes();
    await voiceRecording(signedReq({ path: '/api/novus/webhooks/voice-recording', params: recordingParams }), resDupRecording);
    assert.strictEqual(resDupRecording.body.duplicate, true, 'redelivered RecordingSid detected as duplicate');

    ok('recording callback sets voicemail evidence; transcription callback fills transcript + re-classifies; both idempotent, no duplicate rows');
    __setRepoForTests(null);
  }

  // ── sms-inbound ──
  console.log('\nsms-inbound — matched agency, empty TwiML, no auto-reply');
  {
    const { store, valuesApi } = makeFakeSheet();
    seedAgency(store, { agency_id: 'ag_1', main_phone: '+447700900123' });
    seedProbe(store, { probe_id: 'prb_1', agency_id: 'ag_1', ...inWindow(-1000 * 60 * 60, 1000 * 60 * 60 * 24) });
    __setRepoForTests(createRepo(valuesApi));

    const params = { MessageSid: 'SM_001', From: '+447700900123', To: '+447575333064', Body: 'Hi, just following up on your enquiry.' };
    const res = mockRes();
    await smsInbound(signedReq({ path: '/api/novus/webhooks/sms-inbound', params }), res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res._sentText, '<?xml version="1.0" encoding="UTF-8"?><Response></Response>', 'empty TwiML — no auto-reply invented');
    assert.strictEqual(store.COMMUNICATIONS.length, 3);
    const comm = Object.fromEntries(COMMUNICATIONS_HEADER.map((k, i) => [k, store.COMMUNICATIONS[2][i]]));
    assert.strictEqual(comm.channel, 'sms');
    assert.strictEqual(comm.body_text, 'Hi, just following up on your enquiry.');
    assert.strictEqual(comm.probe_id, 'prb_1');
    assert.strictEqual(comm.callback_attempt, 'FALSE', 'SMS is not counted as a phone callback attempt');
    ok('signed inbound SMS: RAW_EVENTS + COMMUNICATIONS written, matched, empty TwiML reply');
    __setRepoForTests(null);
  }

  console.log(`\n✅ All ${passed} checks passed.\n`);
}

run().catch((err) => { console.error('\n❌ SELFTEST FAILED:\n', err); process.exit(1); });
