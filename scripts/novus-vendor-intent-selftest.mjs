// scripts/novus-vendor-intent-selftest.mjs — hermetic test for:
//   1. Rightmove probe creation writing the vendor declaration into
//      PROBES.enquiry_text (api/novus/probe.js, action=create).
//   2. Vendor Opportunity detection in the Intelligence pipeline
//      (lib/vendor-intent.mjs), wired into both the batch rebuild
//      (lib/intelligence-rebuild.mjs) and the single-probe recompute used by
//      the live webhooks (lib/observation-recompute.mjs, exposed at
//      api/novus/intelligence/rebuild-all.js when body.probe_id is present).
//
// No network, no creds — same in-memory fake-Sheets pattern as the other
// novus-*-selftest.mjs scripts, using the live workbook's confirmed headers.
//
// Run: node scripts/novus-vendor-intent-selftest.mjs

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { hasVendorDeclaration, classifyVendorCommunication, computeVendorOpportunity } from '../lib/vendor-intent.mjs';

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
    async batchUpdate(data) {
      for (const { range, values } of data) {
        const tab = tabOf(range);
        const start = startRowOf(range);
        store[tab] = store[tab] || [];
        values.forEach((row, i) => { store[tab][start - 1 + i] = row.slice(); });
      }
      return { totalUpdatedCells: data.reduce((n, d) => n + d.values[0].length, 0) };
    },
  };
  return { store, valuesApi };
}

function seedProbe(store, { probe_id, agency_id = 'ag_1', probe_timestamp, observation_deadline, enquiry_text = '' }) {
  const row = PROBES_HEADER.map((key) => {
    if (key === 'probe_id') return probe_id;
    if (key === 'agency_id') return agency_id;
    if (key === 'probe_status') return 'observing';
    if (key === 'probe_timestamp') return probe_timestamp;
    if (key === 'observation_deadline') return observation_deadline;
    if (key === 'enquiry_text') return enquiry_text;
    return '';
  });
  store.PROBES.push(row);
}

let commSeq = 0;
function seedCommunication(store, { probe_id, agency_id = 'ag_1', occurred_at, channel = 'email', from = 'jane@agency-one.co.uk', subject = '', body_text = '' }) {
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

const VENDOR_DECLARATION = 'Declared: has a property to sell, yes, it is not yet on the market';

async function run() {
  process.env.NOVUS_BASIC_AUTH_USER = 'novus';
  process.env.NOVUS_BASIC_AUTH_PASS = 'test-pass';
  process.env.NOVUS_PROBE_EMAIL = 'novusprobes@gmail.com';
  process.env.NOVUS_PROBE_PHONE = '+441234567890';

  // probe-create.js was consolidated into api/novus/probe.js (POST with
  // body.action === 'create') to stay within Vercel Hobby's 12-function
  // limit — same handler, same behaviour.
  const { default: createHandler } = await import('../api/novus/probe.js');
  const { rebuildAllIntelligence } = await import('../lib/intelligence-rebuild.mjs');
  const { recomputeProbeObservation } = await import('../lib/observation-recompute.mjs');

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

  // ── Task 1: probe creation writes the vendor declaration ──
  console.log('\nProbe creation — vendor declaration written to enquiry_text');
  {
    const { store, valuesApi } = makeFakeSheet();
    __setRepoForTests(createRepo(valuesApi));

    const res = mockRes();
    await createHandler(mockReq({ action: 'create', url: 'https://www.rightmove.co.uk/properties/159273000' }), res);
    assert.strictEqual(res.statusCode, 200, `probe-create returned 200: ${JSON.stringify(res.body)}`);
    const probe = res.body.probe;
    assert.strictEqual(probe.portal, 'rightmove', 'portal detected as rightmove');
    assert.strictEqual(probe.enquiry_text, VENDOR_DECLARATION, 'enquiry_text carries the exact vendor declaration, matching historical probes');
    ok('a new Rightmove probe writes the vendor declaration into PROBES.enquiry_text, with no new PROBES column');

    // Existing enquiry details (if ever supplied) are preserved, not overwritten.
    const res2 = mockRes();
    await createHandler(mockReq({ action: 'create', url: 'https://www.rightmove.co.uk/properties/2', enquiry_text: 'Prefers afternoon viewings.' }), res2);
    assert.strictEqual(res2.body.probe.enquiry_text, `${VENDOR_DECLARATION} — Prefers afternoon viewings.`, 'existing enquiry detail preserved alongside the declaration');
    ok('any other supplied enquiry detail is preserved alongside the vendor declaration, not overwritten');

    // Non-Rightmove portals get no Rightmove-specific declaration.
    const res3 = mockRes();
    await createHandler(mockReq({ action: 'create', url: 'https://www.zoopla.co.uk/for-sale/details/1' }), res3);
    assert.strictEqual(res3.body.probe.portal, 'zoopla');
    assert.strictEqual(res3.body.probe.enquiry_text, '', 'zoopla probe gets no Rightmove-specific vendor declaration');
    ok('non-Rightmove probes are left untouched (declaration is Rightmove-form-specific)');

    assert.strictEqual(store.PROBES.length, 5, 'exactly 3 PROBES data rows written (+ header + schema note)');

    __setRepoForTests(null);
  }

  // ── lib/vendor-intent.mjs — unit tests ──
  console.log('\nlib/vendor-intent.mjs — unit tests');
  {
    assert.ok(hasVendorDeclaration({ enquiry_text: VENDOR_DECLARATION }), 'recognises the exact declaration written at probe creation');
    assert.ok(hasVendorDeclaration({ enquiry_text: `${VENDOR_DECLARATION} — Prefers afternoon viewings.` }), 'recognises the declaration with trailing enquiry detail');
    assert.ok(!hasVendorDeclaration({ enquiry_text: '' }), 'blank enquiry_text has no declaration');
    assert.ok(!hasVendorDeclaration({ enquiry_text: 'Interested in viewing this property.' }), 'an ordinary buyer enquiry has no declaration');
    ok('hasVendorDeclaration() matches the declaration marker and only the marker');

    const progressed = classifyVendorCommunication({ body_text: 'Thanks for calling — we can book a valuation for Thursday at 2pm.' });
    assert.strictEqual(progressed.tag, 'vendor_progressed', 'booking-a-valuation language tags as progressed');

    const discussed = classifyVendorCommunication({ body_text: 'We would be happy to give you a free valuation and market appraisal.' });
    assert.strictEqual(discussed.tag, 'vendor_discussed', 'valuation/appraisal language without booking tags as discussed');

    const acknowledged = classifyVendorCommunication({ body_text: 'Thanks for your enquiry — I understand you are thinking of selling your property.' });
    assert.strictEqual(acknowledged.tag, 'vendor_acknowledged', 'generic seller-recognition language tags as acknowledged');

    const none = classifyVendorCommunication({ body_text: 'Sure, I can show you round on Saturday at 11am.' });
    assert.strictEqual(none, null, 'ordinary buyer/viewing language has no vendor tag');

    ok('classifyVendorCommunication() ranks progressed > discussed > acknowledged > none, from narrow literal phrase lists');
  }

  // ── computeVendorOpportunity — rollup + evidence ──
  console.log('\ncomputeVendorOpportunity() — probe-level rollup with evidence');
  {
    const declaredProbe = { probe_id: 'prb_v1', enquiry_text: VENDOR_DECLARATION };
    const undeclaredProbe = { probe_id: 'prb_v2', enquiry_text: '' };

    assert.strictEqual(computeVendorOpportunity(undeclaredProbe, []), null, 'no declaration -> null, nothing computed or written');
    ok('probes without the vendor declaration are skipped entirely (no vendor fields touched)');

    const zeroEvidence = computeVendorOpportunity(declaredProbe, [
      { communication_id: 'c1', channel: 'email', occurred_at: PROBE_SENT, human_contact: 'TRUE', body_text: 'Sure, viewing is available Saturday at 11am.' },
    ]);
    assert.strictEqual(zeroEvidence.commPatches.size, 0, 'no communication matched a vendor phrase');
    assert.match(zeroEvidence.ai_evidence_summary, /no_evidence/, 'summary records no_evidence explicitly');
    assert.match(zeroEvidence.ai_evidence_summary, /1 human communication\(s\) reviewed/, 'summary states how many communications were actually reviewed');
    ok('declared-but-unnoticed vendor opportunity is recorded as no_evidence, with the review count as supporting context');

    const withEvidence = computeVendorOpportunity(declaredProbe, [
      { communication_id: 'c1', channel: 'email', occurred_at: PROBE_SENT, human_contact: 'TRUE', body_text: 'Hi, thanks for your enquiry.' },
      { communication_id: 'c2', channel: 'phone', occurred_at: iso(HOUR, PROBE_SENT), human_contact: 'TRUE', body_text: '', transcript: 'We would love to give you a free valuation on the property.' },
      { communication_id: 'c3', channel: 'email', occurred_at: iso(2 * HOUR, PROBE_SENT), human_contact: 'FALSE', body_text: 'This is an automated response mentioning book a valuation, ignored because not human.' },
    ]);
    assert.strictEqual(withEvidence.commPatches.get('c2').intent, 'vendor_discussed', 'the matching human communication is tagged');
    assert.ok(!withEvidence.commPatches.has('c3'), 'automated (non-human) communications are never counted as evidence, even if they contain vendor phrases');
    assert.ok(!withEvidence.commPatches.has('c1'), 'a communication with no vendor phrase is left untagged');
    assert.match(withEvidence.ai_evidence_summary, /Vendor opportunity: discussed/, 'summary states the reached status');
    assert.match(withEvidence.ai_evidence_summary, /free valuation/, 'summary quotes the actual matched evidence text');
    assert.match(withEvidence.ai_evidence_summary, /phone/, 'summary names the channel the evidence came from');
    ok('computeVendorOpportunity() tags only genuinely-matching human communications and quotes real evidence in the rollup');

    const manualOverride = computeVendorOpportunity(declaredProbe, [
      { communication_id: 'c4', channel: 'email', occurred_at: PROBE_SENT, human_contact: 'TRUE', manual_override: 'TRUE', body_text: 'Book a valuation for Friday.' },
    ]);
    assert.strictEqual(manualOverride.commPatches.size, 0, 'a manually-overridden row is never auto-tagged');
    ok('manual_override rows are respected — never auto-tagged, same convention as classification.mjs');
  }

  // ── End-to-end: batch rebuild (lib/intelligence-rebuild.mjs) ──
  console.log('\nEnd-to-end — rebuildAllIntelligence() writes intent + ai_evidence_summary, A-H grade unaffected');
  {
    const { store, valuesApi } = makeFakeSheet();
    __setRepoForTests(createRepo(valuesApi));
    const repo = createRepo(valuesApi);

    // Declared vendor probe, fast human contact, valuation actually discussed.
    seedProbe(store, { probe_id: 'prb_vendor_progressed', probe_timestamp: PROBE_SENT, observation_deadline: iso(4 * DAY, PROBE_SENT), enquiry_text: VENDOR_DECLARATION });
    seedCommunication(store, { probe_id: 'prb_vendor_progressed', occurred_at: iso(30 * MIN, PROBE_SENT), body_text: "Hi, it's Jane — happy to book a valuation for you this week." });

    // Declared vendor probe, human contact, but the reply never mentions selling/valuation at all.
    seedProbe(store, { probe_id: 'prb_vendor_missed', probe_timestamp: PROBE_SENT, observation_deadline: iso(4 * DAY, PROBE_SENT), enquiry_text: VENDOR_DECLARATION });
    seedCommunication(store, { probe_id: 'prb_vendor_missed', occurred_at: iso(30 * MIN, PROBE_SENT), body_text: "Hi, it's Tom — sure, come by Saturday at 11am to view." });

    // Ordinary probe, no vendor declaration at all — must be completely untouched.
    seedProbe(store, { probe_id: 'prb_no_declaration', probe_timestamp: PROBE_SENT, observation_deadline: iso(4 * DAY, PROBE_SENT), enquiry_text: '' });
    seedCommunication(store, { probe_id: 'prb_no_declaration', occurred_at: iso(30 * MIN, PROBE_SENT), body_text: "Hi, it's Sam — happy to book a valuation for you this week." });

    const summary = await rebuildAllIntelligence(repo);
    assert.deepStrictEqual(summary.problems, [], 'no errors processing the vendor-shaped probe set');

    const allIntelligence = await repo.getRecords('INTELLIGENCE', 'intelligence_id');
    const allComms = await repo.getRecords('COMMUNICATIONS', 'communication_id');
    const byProbe = (pid) => allIntelligence.find((r) => r.obj.probe_id === pid).obj;
    const commsFor = (pid) => allComms.filter((r) => r.obj.probe_id === pid).map((r) => r.obj);

    const progressed = byProbe('prb_vendor_progressed');
    assert.match(progressed.ai_evidence_summary, /Vendor opportunity: progressed/, 'rebuild-all: valuation-booking language rolls up to progressed');
    assert.strictEqual(commsFor('prb_vendor_progressed')[0].intent, 'vendor_progressed', 'rebuild-all: COMMUNICATIONS.intent written on the matching row');
    assert.ok(['A', 'B', 'C', 'D', 'E', 'F'].includes(progressed.grade), 'A-H grade still computed normally alongside vendor evidence');

    const missed = byProbe('prb_vendor_missed');
    assert.match(missed.ai_evidence_summary, /no_evidence/, 'rebuild-all: declared vendor opportunity with no matching reply rolls up to no_evidence');
    assert.strictEqual(commsFor('prb_vendor_missed')[0].intent, '', 'rebuild-all: no COMMUNICATIONS.intent tag when nothing matched');

    const noDecl = byProbe('prb_no_declaration');
    assert.strictEqual(noDecl.ai_evidence_summary, '', 'rebuild-all: probes without the vendor declaration get no ai_evidence_summary at all');
    assert.strictEqual(commsFor('prb_no_declaration')[0].intent, '', 'rebuild-all: non-vendor probes never get an intent tag, even with matching language');
    ok('rebuildAllIntelligence() writes vendor evidence for declared probes only, leaves the A-H grade untouched, and leaves non-vendor probes completely alone');

    __setRepoForTests(null);
  }

  // ── End-to-end: single-probe recompute (lib/observation-recompute.mjs), the path the live webhooks use ──
  console.log('\nEnd-to-end — recomputeProbeObservation() (webhook path) writes the same vendor evidence');
  {
    const { store, valuesApi } = makeFakeSheet();
    __setRepoForTests(createRepo(valuesApi));
    const repo = createRepo(valuesApi);

    seedProbe(store, { probe_id: 'prb_webhook_vendor', probe_timestamp: PROBE_SENT, observation_deadline: iso(4 * DAY, PROBE_SENT), enquiry_text: VENDOR_DECLARATION });
    seedCommunication(store, { probe_id: 'prb_webhook_vendor', occurred_at: iso(45 * MIN, PROBE_SENT), body_text: 'We can offer a free market appraisal of your property next week.' });

    const result = await recomputeProbeObservation(repo, 'prb_webhook_vendor');
    assert.ok(result, 'recompute found the probe');

    const intelligence = (await repo.getRecords('INTELLIGENCE', 'intelligence_id')).find((r) => r.obj.probe_id === 'prb_webhook_vendor').obj;
    assert.match(intelligence.ai_evidence_summary, /Vendor opportunity: discussed/, 'single-probe recompute (webhook path) computes the same vendor rollup as rebuild-all');
    assert.match(intelligence.ai_evidence_summary, /market appraisal/, 'evidence quote present on the webhook path too');

    const comm = (await repo.getRecords('COMMUNICATIONS', 'communication_id')).find((r) => r.obj.probe_id === 'prb_webhook_vendor').obj;
    assert.strictEqual(comm.intent, 'vendor_discussed', 'COMMUNICATIONS.intent written on the webhook path too');

    ok('recomputeProbeObservation() (used by live inbound webhooks) applies the identical vendor-opportunity logic as the batch rebuild — one shared module, no duplicated rules');

    __setRepoForTests(null);
  }

  console.log(`\n✅ All ${passed} checks passed.\n`);
}

run().catch((err) => { console.error('\n❌ SELFTEST FAILED:\n', err); process.exit(1); });
