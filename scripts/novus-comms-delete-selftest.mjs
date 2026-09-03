// scripts/novus-comms-delete-selftest.mjs — hermetic test (no network, no creds)
// for "Delete communication" in the Comms Resolution queue.
//
// Deletion is a tombstone (match_status = 'deleted' on COMMUNICATIONS,
// processing_status = 'discarded' on the originating RAW_EVENT) rather than a
// schema change or a physical row delete — this workbook has no migration
// mechanism (see lib/communication-status.mjs). This suite proves the
// invariants the tombstone is required to hold:
//
//   1. A deleted row disappears from the resolution queue (inbound-match-dry-run).
//   2. Deleting an already-matched row recomputes its probe, and that probe's
//      recomputed INTELLIGENCE reflects the communication's absence.
//   3. Deleting is idempotent.
//   4. The confirm token is required.
//   5. A deleted row can never be resurrected: not via confirm-match, not via
//      a full lib/intelligence-rebuild.mjs pass, and not via a late-arriving
//      voice transcript for the same call.
//
// Run:  node scripts/novus-comms-delete-selftest.mjs

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';

__setAiCallerForTests(async ({ tool }) => {
  if (tool.name === 'record_probe_diagnosis') {
    return {
      findings: [],
      strengths: '', missed_opportunities: '', commercial_implication: '',
      novus_opportunity: 'None evidenced', diagnosis_summary: 'Stubbed for a hermetic test.',
    };
  }
  return {
    viewing_progression: 'none', buyer_questions_asked: [], seller_recognition: 'none',
    communication_quality: 'generic', did_well: '', missed: '', evidence: [],
  };
});

import { deleteInboundCommunication, DELETE_COMMUNICATION_CONFIRMATION } from '../lib/inbound-match-delete.mjs';
import { runInboundMatchDryRun } from '../lib/inbound-match-review.mjs';
import { confirmInboundCommunicationMatch, MANUAL_MATCH_CONFIRMATION } from '../lib/inbound-match-manual.mjs';
import { rebuildAllIntelligence } from '../lib/intelligence-rebuild.mjs';
import { computeTwilioSignature } from '../lib/twilio-signature.mjs';

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
const DIAGNOSIS_HEADER = [
  'diagnosis_id','agency_id','probe_id','findings',
  'strengths','missed_opportunities','commercial_implication',
  'novus_opportunity','diagnosis_summary','created_at','updated_at',
];

function makeFakeSheet() {
  const store = {
    AGENCIES: [AGENCIES_HEADER.slice(), ['SCHEMA NOTE', 'Stable identity only.']],
    PROBES: [PROBES_HEADER.slice(), ['SCHEMA NOTE', 'One row per actual probe.']],
    COMMUNICATIONS: [COMMUNICATIONS_HEADER.slice(), ['SCHEMA NOTE', 'One row per meaningful communication.']],
    RAW_EVENTS: [RAW_EVENTS_HEADER.slice(), ['SCHEMA NOTE', 'Immutable provider webhook/event audit trail.']],
    INTELLIGENCE: [INTELLIGENCE_HEADER.slice(), ['SCHEMA NOTE', 'Derived behaviour and official decisions.']],
    DIAGNOSIS: [DIAGNOSIS_HEADER.slice(), ['SCHEMA NOTE', 'Final commercial read, written once.']],
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
    async batchUpdate(data) {
      for (const { range, values } of data) {
        const tab = tabOf(range);
        const start = startRowOf(range);
        store[tab] = store[tab] || [];
        values.forEach((row, i) => { store[tab][start - 1 + i] = row.slice(); });
      }
    },
  };
  return { store, valuesApi };
}

function seedAgency(store, { agency_id, agency_name = '', primary_contact_email = '', domain = '', main_phone = '' }) {
  store.AGENCIES.push(AGENCIES_HEADER.map((key) => {
    if (key === 'agency_id') return agency_id;
    if (key === 'agency_name') return agency_name;
    if (key === 'primary_contact_email') return primary_contact_email;
    if (key === 'domain') return domain;
    if (key === 'main_phone') return main_phone;
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

function seedCommunication(store, overrides = {}) {
  store.COMMUNICATIONS.push(COMMUNICATIONS_HEADER.map((key) => {
    if (key in overrides) return overrides[key];
    if (key === 'direction') return 'inbound';
    if (key === 'match_status') return 'unmatched';
    return '';
  }));
}

function seedRawEvent(store, overrides = {}) {
  store.RAW_EVENTS.push(RAW_EVENTS_HEADER.map((key) => {
    if (key in overrides) return overrides[key];
    if (key === 'processing_status') return 'processed';
    return '';
  }));
}

function rowByHeader(row, header) {
  return Object.fromEntries(header.map((k, i) => [k, row[i]]));
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
function signedReq({ path, params }) {
  const url = `${BASE_URL}${path}`;
  const signature = computeTwilioSignature(AUTH_TOKEN, url, params);
  return { method: 'POST', body: params, headers: { 'x-twilio-signature': signature } };
}
function mockRes() {
  return {
    statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    send() { return this; },
    end() { return this; },
    setHeader(k, v) { this.headers[k] = v; },
  };
}

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

async function run() {
  process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
  process.env.NOVUS_PUBLIC_BASE_URL = BASE_URL;

  // ── Test 1: confirm token required ──
  console.log('\nTest 1 — confirm token required');
  {
    const { store, valuesApi } = makeFakeSheet();
    seedAgency(store, { agency_id: 'ag_1' });
    seedCommunication(store, { communication_id: 'com_1', channel: 'voice', match_status: 'unmatched' });
    __setRepoForTests(createRepo(valuesApi));

    const result = await deleteInboundCommunication(createRepo(valuesApi), { communication_id: 'com_1' });
    assert.strictEqual(result.ok, false, 'missing confirm token is rejected');
    assert.strictEqual(result.status, 400);
    const row = rowByHeader(store.COMMUNICATIONS[2], COMMUNICATIONS_HEADER);
    assert.strictEqual(row.match_status, 'unmatched', 'row untouched without the confirm token');
    ok('deleteInboundCommunication requires confirm=DELETE_COMMUNICATION');
    __setRepoForTests(null);
  }

  // ── Test 2: delete an unmatched voicemail with no useful evidence ──
  console.log('\nTest 2 — delete an unmatched call with no voicemail');
  {
    const { store, valuesApi } = makeFakeSheet();
    seedAgency(store, { agency_id: 'ag_1', agency_name: 'Aspire Estate Agents' });
    seedCommunication(store, {
      communication_id: 'com_novm', channel: 'voice', match_status: 'unmatched',
      occurred_at: new Date().toISOString(), source_identifier_raw: '+447700900555',
      source_identifier_normalized: '+447700900555',
    });
    seedRawEvent(store, { raw_event_id: 'rev_novm', provider: 'twilio', provider_event_id: 'CA_NOVM', processed_communication_id: 'com_novm', processing_status: 'processed' });
    const repo = createRepo(valuesApi);
    __setRepoForTests(repo);

    // Before delete: it's in the resolution queue.
    const before = await runInboundMatchDryRun(repo, { days: 90, limit: 500 });
    assert.ok(before.rows.some((r) => r.communication_id === 'com_novm'), 'unmatched row appears in the resolution queue before deletion');

    const result = await deleteInboundCommunication(repo, { communication_id: 'com_novm', confirm: DELETE_COMMUNICATION_CONFIRMATION, reason: 'No voicemail left, silent hangup' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.probe_id, '', 'no probe to recompute (was never matched)');
    assert.strictEqual(result.recomputed, false);
    assert.strictEqual(result.raw_events_discarded, 1, 'the one linked RAW_EVENT was tombstoned');

    const commRow = rowByHeader(store.COMMUNICATIONS[2], COMMUNICATIONS_HEADER);
    assert.strictEqual(commRow.match_status, 'deleted', 'COMMUNICATIONS row tombstoned via match_status');
    assert.strictEqual(commRow.override_reason, 'No voicemail left, silent hangup', 'reason stored');
    const rawRow = rowByHeader(store.RAW_EVENTS[2], RAW_EVENTS_HEADER);
    assert.strictEqual(rawRow.processing_status, 'discarded', 'RAW_EVENT flagged so a future rebuild pass will not recreate this communication');

    // After delete: gone from the resolution queue.
    const after = await runInboundMatchDryRun(repo, { days: 90, limit: 500 });
    assert.ok(!after.rows.some((r) => r.communication_id === 'com_novm'), 'deleted row no longer appears in the resolution queue');

    ok('deleting an unmatched, evidence-free call tombstones COMMUNICATIONS + RAW_EVENT and removes it from the queue');
    __setRepoForTests(null);
  }

  // ── Test 3: delete a matched communication -> its probe is recomputed and excludes it ──
  console.log('\nTest 3 — delete a matched communication recomputes its probe, excluding it');
  {
    const { store, valuesApi } = makeFakeSheet();
    seedAgency(store, { agency_id: 'ag_aspire', agency_name: 'Aspire Estate Agents' });
    seedProbe(store, { probe_id: 'prb_aspire', agency_id: 'ag_aspire', ...inWindow(-1000 * 60 * 60, 1000 * 60 * 60 * 24 * 3) });

    seedCommunication(store, {
      communication_id: 'com_keep', agency_id: 'ag_aspire', probe_id: 'prb_aspire',
      channel: 'email', match_status: 'matched', occurred_at: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
      received_at: new Date(Date.now() - 1000 * 60 * 30).toISOString(), automated_or_human: 'human', human_contact: 'TRUE',
      body_text: "Hi, it's Kareena from Aspire, happy to help.",
    });
    seedCommunication(store, {
      communication_id: 'com_todelete', agency_id: 'ag_aspire', probe_id: 'prb_aspire',
      channel: 'voice', match_status: 'matched', occurred_at: new Date(Date.now() - 1000 * 60 * 10).toISOString(),
      received_at: new Date(Date.now() - 1000 * 60 * 10).toISOString(), automated_or_human: 'human', human_contact: 'TRUE',
      voicemail_present: 'FALSE',
    });
    const repo = createRepo(valuesApi);
    __setRepoForTests(repo);

    // Sanity: before deletion, recompute sees both channels.
    const before = await rebuildAllIntelligence(repo, {});
    const beforeIntel = rowByHeader(store.INTELLIGENCE[2], INTELLIGENCE_HEADER);
    const beforeChannels = String(beforeIntel.channels_used || '').split(',').filter(Boolean);
    assert.ok(beforeChannels.includes('voice') && beforeChannels.includes('email'), 'both communications counted before deletion');

    const result = await deleteInboundCommunication(repo, { communication_id: 'com_todelete', confirm: DELETE_COMMUNICATION_CONFIRMATION });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.probe_id, 'prb_aspire', 'delete identified the matched probe');
    assert.strictEqual(result.recomputed, true, 'the probe was recomputed after deletion');

    const afterIntel = rowByHeader(store.INTELLIGENCE[2], INTELLIGENCE_HEADER);
    const afterChannels = String(afterIntel.channels_used || '').split(',').filter(Boolean);
    assert.ok(afterChannels.includes('email'), 'the remaining matched email communication still counted');
    assert.ok(!afterChannels.includes('voice'), 'the deleted voice communication no longer counted in the recomputed INTELLIGENCE');

    ok('deleting a matched communication recomputes its probe and the recompute excludes the deleted row');
    __setRepoForTests(null);
  }

  // ── Test 4: idempotent second delete ──
  console.log('\nTest 4 — idempotent delete');
  {
    const { store, valuesApi } = makeFakeSheet();
    seedAgency(store, { agency_id: 'ag_1' });
    seedCommunication(store, { communication_id: 'com_1', channel: 'sms', match_status: 'unmatched' });
    const repo = createRepo(valuesApi);
    __setRepoForTests(repo);

    const first = await deleteInboundCommunication(repo, { communication_id: 'com_1', confirm: DELETE_COMMUNICATION_CONFIRMATION });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.already_deleted, undefined);

    const second = await deleteInboundCommunication(repo, { communication_id: 'com_1', confirm: DELETE_COMMUNICATION_CONFIRMATION });
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.already_deleted, true, 'a second delete is a no-op, not an error');

    ok('deleting an already-deleted communication is idempotent');
    __setRepoForTests(null);
  }

  // ── Test 5: a deleted communication can never be resurrected via confirm-match ──
  console.log('\nTest 5 — confirm-match refuses a deleted communication');
  {
    const { store, valuesApi } = makeFakeSheet();
    seedAgency(store, { agency_id: 'ag_1', agency_name: 'Aspire Estate Agents' });
    seedProbe(store, { probe_id: 'prb_1', agency_id: 'ag_1', ...inWindow(-1000 * 60 * 60, 1000 * 60 * 60 * 24) });
    seedCommunication(store, { communication_id: 'com_1', channel: 'sms', match_status: 'unmatched' });
    const repo = createRepo(valuesApi);
    __setRepoForTests(repo);

    await deleteInboundCommunication(repo, { communication_id: 'com_1', confirm: DELETE_COMMUNICATION_CONFIRMATION });

    const result = await confirmInboundCommunicationMatch(repo, {
      communication_id: 'com_1', agency_id: 'ag_1', probe_id: 'prb_1', confirm: MANUAL_MATCH_CONFIRMATION,
    });
    assert.strictEqual(result.ok, false, 'confirm-match refuses a deleted communication');
    assert.strictEqual(result.status, 409);

    const row = rowByHeader(store.COMMUNICATIONS[2], COMMUNICATIONS_HEADER);
    assert.strictEqual(row.match_status, 'deleted', 'row remains tombstoned, never resurrected via manual match');
    ok('confirmInboundCommunicationMatch refuses to resurrect a deleted communication');
    __setRepoForTests(null);
  }

  // ── Test 6: a deleted call is not resurrected by a late-arriving transcript ──
  console.log('\nTest 6 — late voice transcript does not resurrect a deleted call');
  {
    const { store, valuesApi } = makeFakeSheet();
    seedAgency(store, { agency_id: 'ag_1', agency_name: 'Aspire Estate Agents' });
    const repo = createRepo(valuesApi);
    __setRepoForTests(repo);

    const { default: voiceInbound } = await import('../api/novus/webhooks/voice-inbound.js');
    const { default: voiceRecording } = await import('../api/novus/webhooks/voice-recording.js');

    await voiceInbound(signedReq({
      path: '/api/novus/webhooks/voice-inbound',
      params: { CallSid: 'CA_DEL', From: '+447700900777', To: '+447575333064', CallStatus: 'ringing' },
    }), mockRes());

    const commRecord = store.COMMUNICATIONS.find((r) => r[COMMUNICATIONS_HEADER.indexOf('interaction_id')] === 'CA_DEL');
    const commId = commRecord[COMMUNICATIONS_HEADER.indexOf('communication_id')];

    const del = await deleteInboundCommunication(repo, { communication_id: commId, confirm: DELETE_COMMUNICATION_CONFIRMATION, reason: 'No voicemail left' });
    assert.strictEqual(del.ok, true);

    // The transcript callback for the SAME call arrives after deletion and
    // unambiguously names the agency — it must not resurrect the row.
    const res = mockRes();
    await voiceRecording(signedReq({
      path: '/api/novus/webhooks/voice-recording',
      params: { CallSid: 'CA_DEL', TranscriptionSid: 'TR_DEL', RecordingSid: 'RE_DEL', TranscriptionText: "Hi, it's Kareena from Aspire Estate Agents, calling back." },
    }), res);
    assert.strictEqual(res.body.deleted, true, 'voice-recording recognises the target as deleted');

    const afterRow = store.COMMUNICATIONS.find((r) => r[COMMUNICATIONS_HEADER.indexOf('communication_id')] === commId);
    const afterObj = rowByHeader(afterRow, COMMUNICATIONS_HEADER);
    assert.strictEqual(afterObj.match_status, 'deleted', 'deleted call stays deleted after a late transcript arrives');
    assert.strictEqual(afterObj.transcript, '', 'transcript is not written onto a deleted row');

    ok('a late-arriving recording/transcript for a deleted call does not resurrect it');
    __setRepoForTests(null);
  }

  console.log(`\n✅ All ${passed} checks passed.\n`);
}

run().catch((err) => { console.error('\n❌ SELFTEST FAILED:\n', err); process.exit(1); });
