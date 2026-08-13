// scripts/novus-comms-selftest.mjs — hermetic Milestone 1 test (no network, no creds).
//
// Exercises the REAL code paths — lib/matching.mjs, lib/normalize.mjs, and the
// email-inbound webhook handler — against an in-memory fake that mimics the
// Google Sheets values API and the live workbook's confirmed headers (row 1 =
// header, row 2 = "SCHEMA NOTE ...", row 3+ = data), for AGENCIES, PROBES,
// COMMUNICATIONS and RAW_EVENTS.
//
// Run:  npm run novus:comms-selftest

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';

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

// ── In-memory fake of the Google Sheets values API ────────────────────────────
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

function seedAgency(store, { agency_id, primary_contact_email = '', other_known_emails = '', domain = '' }) {
  const row = AGENCIES_HEADER.map((key) => {
    if (key === 'agency_id') return agency_id;
    if (key === 'primary_contact_email') return primary_contact_email;
    if (key === 'other_known_emails') return other_known_emails;
    if (key === 'domain') return domain;
    return '';
  });
  store.AGENCIES.push(row);
}

function seedProbe(store, { probe_id, agency_id, probe_status = 'observing', probe_timestamp, observation_deadline }) {
  const row = PROBES_HEADER.map((key) => {
    if (key === 'probe_id') return probe_id;
    if (key === 'agency_id') return agency_id;
    if (key === 'probe_status') return probe_status;
    if (key === 'probe_timestamp') return probe_timestamp || '';
    if (key === 'observation_deadline') return observation_deadline || '';
    return '';
  });
  store.PROBES.push(row);
}

// ── Minimal req/res doubles for the Vercel handler signature ──────────────────
const SECRET = 'test-ingest-secret';
function mockReq({ method = 'POST', body = {}, secret = SECRET } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (secret !== undefined) headers['x-novus-ingest-secret'] = secret;
  return { method, body, headers };
}
function mockRes() {
  return {
    statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    end() { return this; },
    setHeader(k, v) { this.headers[k] = v; },
  };
}

function inWindow(offsetStartMs, offsetEndMs) {
  const now = Date.now();
  return {
    probe_timestamp: new Date(now + offsetStartMs).toISOString(),
    observation_deadline: new Date(now + offsetEndMs).toISOString(),
  };
}

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

async function run() {
  process.env.NOVUS_INGEST_SECRET = SECRET;
  const { default: handler } = await import('../api/novus/webhooks/email-inbound.js');

  // ── Auth ──
  console.log('\nAuth');
  {
    const { valuesApi } = makeFakeSheet();
    __setRepoForTests(createRepo(valuesApi));
    const res = mockRes();
    await handler(mockReq({ body: { provider_event_id: 'x', from: 'a@b.com' }, secret: 'wrong' }), res);
    assert.strictEqual(res.statusCode, 401, 'wrong secret rejected');
    ok('email-inbound rejects a wrong/missing ingest secret (401)');
    __setRepoForTests(null);
  }

  // ── Test 1: known agency email, single active probe → matched + matched ──
  console.log('\nTest 1 — known agency email + single active probe');
  {
    const { store, valuesApi } = makeFakeSheet();
    seedAgency(store, { agency_id: 'ag_1', primary_contact_email: 'contact@agency-one.co.uk', domain: 'agency-one.co.uk' });
    seedProbe(store, { probe_id: 'prb_1', agency_id: 'ag_1', ...inWindow(-1000 * 60 * 60, 1000 * 60 * 60 * 24) });
    __setRepoForTests(createRepo(valuesApi));

    const res = mockRes();
    await handler(mockReq({
      body: {
        provider_event_id: 'gmail-evt-1',
        from: 'Contact@Agency-One.co.uk',
        to: 'joe.novus2@gmail.com',
        subject: 'Re: your enquiry',
        body_text: 'Thanks for your interest, someone will call you back.',
        occurred_at: new Date().toISOString(),
      },
    }), res);

    assert.strictEqual(res.statusCode, 200, 'ingestion returned 200');
    assert.strictEqual(res.body.match_status, 'matched', 'overall match_status = matched');
    assert.strictEqual(res.body.agency_id, 'ag_1', 'agency matched by exact email');
    assert.strictEqual(res.body.probe_id, 'prb_1', 'probe matched (single active probe for the agency)');
    assert.strictEqual(res.body.matching_method, 'email_exact', 'matching_method = email_exact');
    assert.strictEqual(store.RAW_EVENTS.length, 3, 'exactly one RAW_EVENTS data row written');
    assert.strictEqual(store.COMMUNICATIONS.length, 3, 'exactly one COMMUNICATIONS data row written');
    const rawRow = store.RAW_EVENTS[2];
    const rawObj = Object.fromEntries(RAW_EVENTS_HEADER.map((k, i) => [k, rawRow[i]]));
    assert.strictEqual(rawObj.processing_status, 'processed', 'RAW_EVENTS marked processed');
    assert.strictEqual(rawObj.processed_communication_id, res.body.communication_id, 'RAW_EVENTS links to the Communication');
    ok('RAW_EVENTS created, Agency matched, Probe matched, COMMUNICATIONS created');
    __setRepoForTests(null);
  }

  // ── Test 2: unknown sender → unmatched, no AI guess ──
  console.log('\nTest 2 — unknown sender');
  {
    const { store, valuesApi } = makeFakeSheet();
    seedAgency(store, { agency_id: 'ag_1', primary_contact_email: 'contact@agency-one.co.uk', domain: 'agency-one.co.uk' });
    __setRepoForTests(createRepo(valuesApi));

    const res = mockRes();
    await handler(mockReq({
      body: { provider_event_id: 'gmail-evt-2', from: 'stranger@totally-unknown.example', subject: 'Hi', body_text: 'hello' },
    }), res);

    assert.strictEqual(res.body.match_status, 'unmatched', 'match_status = unmatched');
    assert.strictEqual(res.body.agency_id, '', 'no agency_id guessed');
    assert.strictEqual(res.body.probe_id, '', 'no probe_id guessed');
    assert.strictEqual(store.RAW_EVENTS.length, 3, 'RAW_EVENT created');
    assert.strictEqual(store.COMMUNICATIONS.length, 3, 'COMMUNICATION retained with unmatched status');
    ok('RAW_EVENT created, Agency unmatched, no AI guess, COMMUNICATION retained as unmatched');
    __setRepoForTests(null);
  }

  // ── Test 3: ambiguous domain (two agencies share a domain, no exact email) ──
  console.log('\nTest 3 — ambiguous domain');
  {
    const { store, valuesApi } = makeFakeSheet();
    seedAgency(store, { agency_id: 'ag_a', primary_contact_email: 'a@shared-domain.co.uk', domain: 'shared-domain.co.uk' });
    seedAgency(store, { agency_id: 'ag_b', primary_contact_email: 'b@shared-domain.co.uk', domain: 'shared-domain.co.uk' });
    __setRepoForTests(createRepo(valuesApi));

    const res = mockRes();
    await handler(mockReq({
      body: { provider_event_id: 'gmail-evt-3', from: 'someone-else@shared-domain.co.uk', subject: 'Enquiry reply', body_text: 'body' },
    }), res);

    assert.strictEqual(res.body.match_status, 'ambiguous', 'match_status = ambiguous');
    assert.strictEqual(res.body.agency_id, '', 'no Agency ID guessed for an ambiguous domain');
    assert.strictEqual(store.COMMUNICATIONS.length, 3, 'COMMUNICATION still recorded (ambiguous, not silently dropped)');
    ok('RAW_EVENT created, match_status = ambiguous, no incorrect Agency ID');
    __setRepoForTests(null);
  }

  // ── Test 4: agency matched, multiple active probes → probe ambiguous ──
  console.log('\nTest 4 — multiple active probes for the matched agency');
  {
    const { store, valuesApi } = makeFakeSheet();
    seedAgency(store, { agency_id: 'ag_1', primary_contact_email: 'contact@agency-one.co.uk', domain: 'agency-one.co.uk' });
    seedProbe(store, { probe_id: 'prb_1', agency_id: 'ag_1', ...inWindow(-1000 * 60 * 60, 1000 * 60 * 60 * 24) });
    seedProbe(store, { probe_id: 'prb_2', agency_id: 'ag_1', ...inWindow(-1000 * 60 * 30, 1000 * 60 * 60 * 24) });
    __setRepoForTests(createRepo(valuesApi));

    const res = mockRes();
    await handler(mockReq({
      body: { provider_event_id: 'gmail-evt-4', from: 'contact@agency-one.co.uk', subject: 'Re', body_text: 'body' },
    }), res);

    assert.strictEqual(res.body.agency_id, 'ag_1', 'Agency matched');
    assert.strictEqual(res.body.match_status, 'ambiguous', 'overall match_status = ambiguous (probe not resolved)');
    assert.strictEqual(res.body.probe_id, '', 'no Probe ID guessed between the two active probes');
    ok('Agency matched, Probe ambiguous, no guessed Probe ID');
    __setRepoForTests(null);
  }

  // ── Test 5: duplicate event → one logical event, no duplicate Communication ──
  console.log('\nTest 5 — duplicate event delivery');
  {
    const { store, valuesApi } = makeFakeSheet();
    seedAgency(store, { agency_id: 'ag_1', primary_contact_email: 'contact@agency-one.co.uk', domain: 'agency-one.co.uk' });
    seedProbe(store, { probe_id: 'prb_1', agency_id: 'ag_1', ...inWindow(-1000 * 60 * 60, 1000 * 60 * 60 * 24) });
    __setRepoForTests(createRepo(valuesApi));

    const body = {
      provider_event_id: 'gmail-evt-5',
      from: 'contact@agency-one.co.uk',
      subject: 'Re: enquiry',
      body_text: 'body',
    };
    const res1 = mockRes();
    await handler(mockReq({ body }), res1);
    assert.strictEqual(res1.body.duplicate, false, 'first delivery is not a duplicate');

    const res2 = mockRes();
    await handler(mockReq({ body }), res2);
    assert.strictEqual(res2.body.duplicate, true, 'second delivery is detected as a duplicate');
    assert.strictEqual(res2.body.raw_event_id, res1.body.raw_event_id, 'same raw_event_id returned');
    assert.strictEqual(res2.body.processed_communication_id, res1.body.communication_id, 'same communication_id returned');

    assert.strictEqual(store.RAW_EVENTS.length, 3, 'still exactly one RAW_EVENTS data row after resend');
    assert.strictEqual(store.COMMUNICATIONS.length, 3, 'still exactly one COMMUNICATIONS data row after resend');
    ok('duplicate delivery of the same provider_event_id produces one logical event, no duplicate Communication');
    __setRepoForTests(null);
  }

  // ── Test 6: raw evidence preservation through matching ──
  console.log('\nTest 6 — raw evidence preservation');
  {
    const { store, valuesApi } = makeFakeSheet();
    seedAgency(store, { agency_id: 'ag_1', primary_contact_email: 'contact@agency-one.co.uk', domain: 'agency-one.co.uk' });
    seedProbe(store, { probe_id: 'prb_1', agency_id: 'ag_1', ...inWindow(-1000 * 60 * 60, 1000 * 60 * 60 * 24) });
    __setRepoForTests(createRepo(valuesApi));

    const res = mockRes();
    await handler(mockReq({
      body: {
        provider_event_id: 'gmail-evt-6',
        from: '  Contact@Agency-One.co.uk  ',
        subject: 'Original subject line',
        body_text: 'Exact original body content.',
      },
    }), res);

    const commRow = store.COMMUNICATIONS[2];
    const commObj = Object.fromEntries(COMMUNICATIONS_HEADER.map((k, i) => [k, commRow[i]]));
    assert.strictEqual(commObj.source_identifier_raw, 'Contact@Agency-One.co.uk', 'raw sender casing/whitespace preserved (trimmed only)');
    assert.strictEqual(commObj.source_identifier_normalized, 'contact@agency-one.co.uk', 'normalized sender also stored, alongside the raw value');
    assert.strictEqual(commObj.subject, 'Original subject line', 'subject preserved verbatim');
    assert.strictEqual(commObj.body_text, 'Exact original body content.', 'body preserved verbatim');

    const rawRow = store.RAW_EVENTS[2];
    const rawObj = Object.fromEntries(RAW_EVENTS_HEADER.map((k, i) => [k, rawRow[i]]));
    assert.strictEqual(rawObj.source_identifier, '  Contact@Agency-One.co.uk  '.trim(), 'RAW_EVENTS retains the original sender identifier');
    assert.ok(rawObj.payload_reference.includes('Original subject line'), 'RAW_EVENTS payload_reference retains the original payload');
    ok('original sender, subject and body remain available after matching (both RAW_EVENTS and COMMUNICATIONS)');
    __setRepoForTests(null);
  }

  console.log(`\n✅ All ${passed} checks passed.\n`);
}

run().catch((err) => { console.error('\n❌ SELFTEST FAILED:\n', err); process.exit(1); });
