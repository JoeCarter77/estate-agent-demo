// scripts/novus-match-status-recompute-selftest.mjs — regression test for:
//
//   When a COMMUNICATIONS row's match_status changes from 'unmatched' to
//   'matched', INTELLIGENCE is automatically recomputed for that probe using
//   its FULL communication history — via the existing single-probe recompute
//   path (lib/observation-recompute.mjs's recomputeProbeObservation()), not a
//   full rebuild. DIAGNOSIS and the probe lifecycle are untouched (the probe
//   stays 'observing', so DIAGNOSIS is never written).
//
// The only place in the codebase where an already-created COMMUNICATIONS row
// has its match_status resolved from 'unmatched' to 'matched' after the fact
// is api/novus/webhooks/voice-recording.js's transcript-based agency-name
// fallback (a voicemail that rang in unmatched, then names the agency once
// transcribed). This test drives that exact path.
//
// Run:  node scripts/novus-match-status-recompute-selftest.mjs

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';

__setAiCallerForTests(async ({ tool }) => {
  if (tool.name === 'record_probe_diagnosis') {
    return {
      primary_problem: '', primary_evidence: '', secondary_problem: '', secondary_evidence: '',
      strengths: '', missed_opportunities: '', commercial_implication: '',
      novus_opportunity: 'None evidenced', diagnosis_summary: 'Stubbed for a hermetic test.',
    };
  }
  return {
    viewing_progression: 'none', buyer_questions_asked: [], seller_recognition: 'none',
    communication_quality: 'generic', did_well: '', missed: '', evidence: [],
  };
});

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
  'diagnosis_id','agency_id','probe_id','primary_problem','primary_evidence','secondary_problem',
  'secondary_evidence','strengths','missed_opportunities','commercial_implication',
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

// A prior, already-matched communication on the SAME probe — this is what
// proves the recompute below uses the probe's FULL communication history,
// not just the one row whose match_status just changed.
function seedMatchedEmail(store, { communication_id, agency_id, probe_id, occurred_at }) {
  store.COMMUNICATIONS.push(COMMUNICATIONS_HEADER.map((key) => {
    if (key === 'communication_id') return communication_id;
    if (key === 'agency_id') return agency_id;
    if (key === 'probe_id') return probe_id;
    if (key === 'channel') return 'email';
    if (key === 'direction') return 'inbound';
    if (key === 'occurred_at') return occurred_at;
    if (key === 'received_at') return occurred_at;
    if (key === 'match_status') return 'matched';
    if (key === 'automated_or_human') return 'human';
    if (key === 'human_contact') return 'TRUE';
    if (key === 'body_text') return "Hi, it's Kareena from Aspire Estate Agents, happy to help with your enquiry.";
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

const AUTH_TOKEN = 'test-twilio-auth-token';
const BASE_URL = 'https://novus.example.com';
function signedReq({ path, params }) {
  const url = `${BASE_URL}${path}`;
  const signature = computeTwilioSignature(AUTH_TOKEN, url, params);
  return { method: 'POST', body: params, headers: { 'x-twilio-signature': signature } };
}

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

async function run() {
  process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
  process.env.NOVUS_PUBLIC_BASE_URL = BASE_URL;

  const { default: voiceInbound } = await import('../api/novus/webhooks/voice-inbound.js');
  const { default: voiceRecording } = await import('../api/novus/webhooks/voice-recording.js');

  console.log('\nmatch_status unmatched -> matched auto-recomputes INTELLIGENCE for that probe (full history), not a full rebuild, no DIAGNOSIS write');
  {
    const { store, valuesApi } = makeFakeSheet();
    seedAgency(store, { agency_id: 'ag_aspire', agency_name: 'Aspire Estate Agents', main_phone: '+447700900001' });
    const window = inWindow(-1000 * 60 * 60, 1000 * 60 * 60 * 24 * 3); // still well inside the 4-day window
    seedProbe(store, { probe_id: 'prb_aspire', agency_id: 'ag_aspire', ...window });

    // Prior communication already on this probe's history, via a different
    // channel — proves the recompute reads the FULL history, not just the
    // one row that just resolved.
    seedMatchedEmail(store, {
      communication_id: 'com_prior_email', agency_id: 'ag_aspire', probe_id: 'prb_aspire',
      occurred_at: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
    });

    __setRepoForTests(createRepo(valuesApi));

    // Call rings in from an unregistered number — deterministic phone match
    // finds nothing, so the row is created unmatched (voice-inbound.js).
    await voiceInbound(signedReq({
      path: '/api/novus/webhooks/voice-inbound',
      params: { CallSid: 'CA_MS', From: '+447700900998', To: '+447575333064', CallStatus: 'ringing' },
    }), mockRes());

    const voiceRowIndexBefore = store.COMMUNICATIONS.findIndex((r) => r[COMMUNICATIONS_HEADER.indexOf('interaction_id')] === 'CA_MS');
    const beforeMatchStatus = store.COMMUNICATIONS[voiceRowIndexBefore][COMMUNICATIONS_HEADER.indexOf('match_status')];
    assert.strictEqual(beforeMatchStatus, 'unmatched', 'voicemail rings in unmatched (no deterministic phone match)');

    // Transcript names the agency unambiguously — this is the ONLY code path
    // that resolves an existing COMMUNICATIONS row's match_status from
    // 'unmatched' to 'matched' after the row already exists.
    await voiceRecording(signedReq({
      path: '/api/novus/webhooks/voice-recording',
      params: {
        CallSid: 'CA_MS', TranscriptionSid: 'TR_MS', RecordingSid: 'RE_MS',
        TranscriptionText: "Hi, it's Kareena from Aspire Estate Agents, calling about your enquiry.",
      },
    }), mockRes());

    const voiceRowIndexAfter = store.COMMUNICATIONS.findIndex((r) => r[COMMUNICATIONS_HEADER.indexOf('interaction_id')] === 'CA_MS');
    const afterRow = store.COMMUNICATIONS[voiceRowIndexAfter];
    const afterMatchStatus = afterRow[COMMUNICATIONS_HEADER.indexOf('match_status')];
    const afterProbeId = afterRow[COMMUNICATIONS_HEADER.indexOf('probe_id')];
    assert.strictEqual(afterMatchStatus, 'matched', 'transcript content resolves the agency+probe -> match_status becomes matched');
    assert.strictEqual(afterProbeId, 'prb_aspire', 'resolved to the correct probe');
    ok('COMMUNICATIONS row transitions match_status: unmatched -> matched');

    // INTELLIGENCE recomputed for prb_aspire, using BOTH communications.
    const intelligenceRows = store.INTELLIGENCE.slice(2); // skip header + SCHEMA NOTE
    assert.strictEqual(intelligenceRows.length, 1, 'exactly one INTELLIGENCE row exists — single-probe recompute, not a full rebuild creating rows for other probes');
    const intelligence = Object.fromEntries(INTELLIGENCE_HEADER.map((k, i) => [k, intelligenceRows[0][i]]));
    assert.strictEqual(intelligence.probe_id, 'prb_aspire', 'INTELLIGENCE recomputed for the specific probe the resolved communication belongs to');
    const channels = String(intelligence.channels_used || '').split(',').filter(Boolean);
    assert.ok(channels.includes('email'), 'recompute used the full history: prior email communication counted');
    assert.ok(channels.includes('voice'), 'recompute used the full history: the newly-resolved voicemail counted');
    ok('INTELLIGENCE recomputed for prb_aspire from its FULL communication history (email + voice), via the single-probe recompute path');

    // DIAGNOSIS untouched — the probe is still 'observing' (window open), so
    // the existing lifecycle logic (unchanged) correctly does not diagnose it.
    const diagnosisRows = store.DIAGNOSIS.slice(2);
    assert.strictEqual(diagnosisRows.length, 0, 'DIAGNOSIS is not written — the probe has not closed, existing lifecycle logic is untouched');
    const probeRow = store.PROBES.find((r) => r[PROBES_HEADER.indexOf('probe_id')] === 'prb_aspire');
    const probeStatus = probeRow[PROBES_HEADER.indexOf('probe_status')];
    assert.strictEqual(probeStatus, 'observing', 'probe lifecycle status is unchanged by this automation');
    ok('DIAGNOSIS untouched and probe lifecycle unchanged');

    __setRepoForTests(null);
  }

  console.log(`\n✅ All ${passed} checks passed.\n`);
}

run().catch((err) => { console.error('\n❌ SELFTEST FAILED:\n', err); process.exit(1); });
