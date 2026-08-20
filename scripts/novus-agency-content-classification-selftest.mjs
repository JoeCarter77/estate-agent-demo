// scripts/novus-agency-content-classification-selftest.mjs — hermetic test
// (no network, no creds) for the two Communications-layer fixes:
//
//   1) Agency matching order: deterministic identifiers (phone/email/domain)
//      first; only if still unmatched, fall back to an explicit,
//      unambiguous agency-name mention in email subject/body, SMS body, or
//      voicemail transcript (lib/agency-content-matching.mjs). Garbled/
//      ambiguous content never forces a match.
//   2) Human vs automated classification (lib/classification.mjs): content
//      signals (template/bot-branding language) first, plus a timing-
//      proximity-to-probe signal that only ever STRENGTHENS a non-human-
//      looking communication — never decides on its own, and never
//      overrides a genuinely personalised (self-introduction) message.
//
// Covers the five acceptance-test cases from the task brief (A-E).
//
// Run:  node scripts/novus-agency-content-classification-selftest.mjs

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';

// This suite is hermetic (no network, no creds) but recomputeProbeObservation()
// now always makes one AI interpretation call when a probe is matched. Stub it
// with a fixed, schema-valid response — these tests assert on matching/webhook
// mechanics, not on AI interpretation content (see
// scripts/novus-probe-interpretation-selftest.mjs for that).
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
import { matchAgencyByName } from '../lib/agency-content-matching.mjs';
import { classifyCommunication } from '../lib/classification.mjs';
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

function makeFakeSheet() {
  const store = {
    AGENCIES: [AGENCIES_HEADER.slice(), ['SCHEMA NOTE', 'Stable identity only.']],
    PROBES: [PROBES_HEADER.slice(), ['SCHEMA NOTE', 'One row per actual probe.']],
    COMMUNICATIONS: [COMMUNICATIONS_HEADER.slice(), ['SCHEMA NOTE', 'One row per meaningful communication.']],
    RAW_EVENTS: [RAW_EVENTS_HEADER.slice(), ['SCHEMA NOTE', 'Immutable provider webhook/event audit trail.']],
    INTELLIGENCE: [INTELLIGENCE_HEADER.slice(), ['SCHEMA NOTE', 'Derived behaviour and official decisions.']],
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

const INGEST_SECRET = 'test-ingest-secret';
function emailReq(body) {
  return { method: 'POST', body, headers: { 'x-novus-ingest-secret': INGEST_SECRET } };
}

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

async function run() {
  process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
  process.env.NOVUS_PUBLIC_BASE_URL = BASE_URL;
  process.env.NOVUS_INGEST_SECRET = INGEST_SECRET;

  const { default: emailInbound } = await import('../api/novus/webhooks/email-inbound.js');
  const { default: voiceInbound } = await import('../api/novus/webhooks/voice-inbound.js');
  const { default: voiceRecording } = await import('../api/novus/webhooks/voice-recording.js');
  const { default: smsInbound } = await import('../api/novus/webhooks/sms-inbound.js');

  // ── lib/agency-content-matching.mjs — unit-level ──
  console.log('\nagency-content-matching.mjs — deterministic name fallback');
  {
    const { store, valuesApi } = makeFakeSheet();
    seedAgency(store, { agency_id: 'ag_aspire', agency_name: 'Aspire Estate Agents' });
    seedAgency(store, { agency_id: 'ag_toddlers', agency_name: 'Toddlers Estate Agents' });
    const repo = createRepo(valuesApi);

    const named = await matchAgencyByName(repo, "Hi, it's Kareena from Aspire Estate Agents. Please contact me regarding your recent enquiry on Peregrine Drive.");
    assert.strictEqual(named.match_status, 'matched', 'explicit agency name in free text is matched');
    assert.strictEqual(named.agency_id, 'ag_aspire');
    assert.strictEqual(named.matching_method, 'name_content');

    const garbled = await matchAgencyByName(repo, 'Good morning is some toddlers estate agents here in New Market');
    assert.notStrictEqual(garbled.match_status, 'matched', 'garbled/imprecise transcript text is never force-matched');

    const noMention = await matchAgencyByName(repo, 'Just calling about the property, give me a ring back.');
    assert.strictEqual(noMention.match_status, 'unmatched', 'no agency name mentioned -> unmatched, not guessed');

    ok('agency-name content fallback matches an explicit, exact mention; never guesses on noisy/absent text');
    __setRepoForTests(null);
  }

  // ── Test Case A: Kareena SMS mentioning "Aspire Estate Agents" ──
  console.log('\nTest Case A — SMS from an unregistered number, agency identified from content, human contact');
  {
    const { store, valuesApi } = makeFakeSheet();
    seedAgency(store, { agency_id: 'ag_aspire', agency_name: 'Aspire Estate Agents', main_phone: '+447700900001' });
    seedProbe(store, { probe_id: 'prb_aspire', agency_id: 'ag_aspire', ...inWindow(-1000 * 60 * 60, 1000 * 60 * 60 * 24) });
    __setRepoForTests(createRepo(valuesApi));

    const params = {
      MessageSid: 'SM_A', From: '+447700900999', To: '+447575333064',
      Body: "Hi, it's Kareena from Aspire Estate Agents. Please contact me regarding your recent enquiry on Peregrine Drive.",
    };
    await smsInbound(signedReq({ path: '/api/novus/webhooks/sms-inbound', params }), mockRes());

    const comm = Object.fromEntries(COMMUNICATIONS_HEADER.map((k, i) => [k, store.COMMUNICATIONS[2][i]]));
    assert.strictEqual(comm.agency_id, 'ag_aspire', 'agency identified from SMS content, not the (unregistered) sending number');
    assert.strictEqual(comm.matching_method, 'name_content');
    assert.strictEqual(comm.automated_or_human, 'human');
    ok('Case A: agency = Aspire (content fallback), human = true');
    __setRepoForTests(null);
  }

  // ── Test Case B: garbled voicemail — no confident agency match ──
  console.log('\nTest Case B — garbled voicemail transcript, no confident agency match, manual review');
  {
    const { store, valuesApi } = makeFakeSheet();
    seedAgency(store, { agency_id: 'ag_toddlers', agency_name: 'Toddlers Estate Agents', main_phone: '+447700900002' });
    __setRepoForTests(createRepo(valuesApi));

    await voiceInbound(signedReq({
      path: '/api/novus/webhooks/voice-inbound',
      params: { CallSid: 'CA_B', From: '+447700900998', To: '+447575333064', CallStatus: 'ringing' },
    }), mockRes());

    await voiceRecording(signedReq({
      path: '/api/novus/webhooks/voice-recording',
      params: { CallSid: 'CA_B', TranscriptionSid: 'TR_B', RecordingSid: 'RE_B', TranscriptionText: 'Good morning is some toddlers estate agents here in New Market' },
    }), mockRes());

    const comm = Object.fromEntries(COMMUNICATIONS_HEADER.map((k, i) => [k, store.COMMUNICATIONS[2][i]]));
    assert.notStrictEqual(comm.match_status, 'matched', 'unreliable transcription never forces an agency match');
    assert.strictEqual(comm.agency_id, '', 'no agency_id guessed from garbled content');
    assert.strictEqual(comm.manual_review_status, 'pending', 'left for manual review');
    ok('Case B: no confident agency match from a garbled voicemail transcript -> manual review');
    __setRepoForTests(null);
  }

  // ── Test Case C: Aspire BridgeAI/template email -> automated, no human contact ──
  console.log('\nTest Case C — known agency, BridgeAI-style template email -> automated, human_contact = false');
  {
    const { store, valuesApi } = makeFakeSheet();
    seedAgency(store, { agency_id: 'ag_aspire', agency_name: 'Aspire Estate Agents', primary_contact_email: 'hello@aspireagents.co.uk', domain: 'aspireagents.co.uk' });
    seedProbe(store, { probe_id: 'prb_aspire', agency_id: 'ag_aspire', ...inWindow(-1000 * 60 * 60, 1000 * 60 * 60 * 24) });
    __setRepoForTests(createRepo(valuesApi));

    await emailInbound(emailReq({
      provider_event_id: 'evt-C', from: 'hello@aspireagents.co.uk',
      subject: 'Email Template',
      body_text: 'Greetings from Aspire Estate Agents! Good Morning, Thank you for your enquiry. Book A Viewing here: bot.bridgeai.co.uk/book',
    }), mockRes());

    const comm = Object.fromEntries(COMMUNICATIONS_HEADER.map((k, i) => [k, store.COMMUNICATIONS[2][i]]));
    assert.strictEqual(comm.agency_id, 'ag_aspire', 'agency matched deterministically by domain');
    assert.strictEqual(comm.automated_or_human, 'automated', 'template/bot-branding language detected as automated');
    ok('Case C: agency = Aspire, automated = true, human_contact = false');
    __setRepoForTests(null);
  }

  // ── Test Case D: generic non-human email 2-3 min after probe -> automated ──
  console.log('\nTest Case D — generic, non-personalised email arriving 2-3 minutes after the probe -> automated');
  {
    const { store, valuesApi } = makeFakeSheet();
    seedAgency(store, { agency_id: 'ag_aspire', agency_name: 'Aspire Estate Agents', primary_contact_email: 'hello@aspireagents.co.uk', domain: 'aspireagents.co.uk' });
    const probeStart = new Date(Date.now() - 2 * 60 * 1000); // probe sent 2 minutes ago
    seedProbe(store, {
      probe_id: 'prb_aspire', agency_id: 'ag_aspire',
      probe_timestamp: probeStart.toISOString(),
      observation_deadline: new Date(Date.now() + 1000 * 60 * 60 * 24 * 4).toISOString(),
    });
    __setRepoForTests(createRepo(valuesApi));

    await emailInbound(emailReq({
      provider_event_id: 'evt-D', from: 'hello@aspireagents.co.uk',
      subject: 'Re: your enquiry',
      body_text: 'Good afternoon, thank you for your interest. Book a viewing at your convenience.',
      occurred_at: new Date().toISOString(),
    }), mockRes());

    const comm = Object.fromEntries(COMMUNICATIONS_HEADER.map((k, i) => [k, store.COMMUNICATIONS[2][i]]));
    assert.strictEqual(comm.automated_or_human, 'automated', 'close timing + generic/templated content -> automated');
    ok('Case D: generic email 2-3 minutes after probe -> automated = true');
    __setRepoForTests(null);
  }

  // ── Test Case E: personalised human email 2-3 min after probe -> human ──
  console.log('\nTest Case E — clearly personalised email arriving 2-3 minutes after a daytime probe -> human');
  {
    const { store, valuesApi } = makeFakeSheet();
    seedAgency(store, { agency_id: 'ag_aspire', agency_name: 'Aspire Estate Agents', primary_contact_email: 'hello@aspireagents.co.uk', domain: 'aspireagents.co.uk' });
    const probeStart = new Date(Date.now() - 2 * 60 * 1000);
    seedProbe(store, {
      probe_id: 'prb_aspire', agency_id: 'ag_aspire',
      probe_timestamp: probeStart.toISOString(),
      observation_deadline: new Date(Date.now() + 1000 * 60 * 60 * 24 * 4).toISOString(),
    });
    __setRepoForTests(createRepo(valuesApi));

    await emailInbound(emailReq({
      provider_event_id: 'evt-E', from: 'hello@aspireagents.co.uk',
      subject: 'Re: Peregrine Drive',
      body_text: "Hi, it's Kareena from Aspire Estate Agents, thanks for your enquiry on Peregrine Drive - happy to answer any questions.",
      occurred_at: new Date().toISOString(),
    }), mockRes());

    const comm = Object.fromEntries(COMMUNICATIONS_HEADER.map((k, i) => [k, store.COMMUNICATIONS[2][i]]));
    assert.strictEqual(comm.automated_or_human, 'human', 'personalised self-introduction overrides timing proximity');
    ok('Case E: personalised email 2-3 minutes after probe -> human = true');
    __setRepoForTests(null);
  }

  console.log(`\n✅ All ${passed} checks passed.\n`);
}

run().catch((err) => { console.error('\n❌ SELFTEST FAILED:\n', err); process.exit(1); });
