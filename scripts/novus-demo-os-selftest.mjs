// scripts/novus-demo-os-selftest.mjs — hermetic test for the Demo OS adapter
// (lib/demoOs.mjs, lib/problem.mjs) and its two integration points
// (api/novus/probe-create.js writing PROBES.agency_id, api/novus/demo-state.js
// reading it back). No network, no creds — same in-memory Sheets fake pattern
// as scripts/novus-selftest.mjs.
//
// Run: node scripts/novus-demo-os-selftest.mjs

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { getProbeIntelligenceForSlug, buildDemoOsState } from '../lib/demoOs.mjs';
import { deriveProblem } from '../lib/problem.mjs';

const PROBES_HEADER = [
  'probe_id', 'probe_reference', 'agency_id', 'portal', 'property_address', 'property_url',
  'property_price', 'property_status', 'enquiry_text', 'probe_email', 'probe_phone',
  'probe_timestamp', 'observation_deadline', 'probe_status', 'compromised', 'compromise_reason',
  'observation_closed_at', 'sent_from', 'observation_notes', 'created_at', 'updated_at',
];
const INTELLIGENCE_HEADER = [
  'intelligence_id', 'agency_id', 'probe_id', 'observation_status', 'observation_deadline',
  'auto_acknowledgement', 'auto_ack_timestamp', 'crm_detected', 'crm_name', 'crm_evidence',
  'first_human_touch', 'first_human_touch_at', 'human_lag_hours', 'callback_attempts',
  'successful_conversations', 'voicemail_count', 'inbound_sms_count', 'email_touch_count',
  'follow_up_count', 'follow_up_channels', 'last_touch_at', 'days_chased', 'booking_attempt',
  'contact_quality', 'proactive_reactive', 'persistence_profile', 'channels_used', 'grade',
  'grade_reason', 'tier', 'tier_reason', 'sales_angle', 'segment', 'ai_evidence_summary', 'ai_confidence',
  'manual_override', 'override_reason', 'observation_closed_at', 'created_at', 'updated_at',
];
const COMMUNICATIONS_HEADER = [
  'communication_id', 'agency_id', 'probe_id', 'interaction_id', 'occurred_at', 'received_at', 'channel',
  'direction', 'communication_type', 'provider', 'provider_event_id', 'source_identifier_raw',
  'source_identifier_normalized', 'destination_identifier', 'display_name', 'call_status',
  'duration_seconds', 'voicemail_present', 'recording_reference', 'transcript', 'email_message_id',
  'email_thread_id', 'subject', 'body_text', 'raw_content', 'raw_payload_reference', 'matching_method',
  'match_score', 'match_status', 'automated_or_human', 'human_contact', 'callback_attempt',
  'successful_conversation', 'follow_up', 'booking_attempt', 'communication_classification', 'intent',
  'contact_quality', 'ai_summary', 'ai_confidence', 'ai_model', 'manual_review_status', 'manual_override',
  'override_reason', 'created_at', 'updated_at',
];

function makeFakeSheet() {
  const store = {
    PROBES: [PROBES_HEADER.slice(), ['SCHEMA NOTE', 'probes']],
    INTELLIGENCE: [INTELLIGENCE_HEADER.slice(), ['SCHEMA NOTE', 'intelligence']],
    COMMUNICATIONS: [COMMUNICATIONS_HEADER.slice(), ['SCHEMA NOTE', 'communications']],
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

const BASIC = 'Basic ' + Buffer.from('novus:testpass').toString('base64');
function mockReq({ method = 'POST', body = {}, query = {}, auth = BASIC } = {}) {
  return { method, body, query, headers: { authorization: auth } };
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

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

async function seedIntelligence(repo, patch) {
  await repo.appendRecord('INTELLIGENCE', {
    intelligence_id: 'int_' + patch.probe_id,
    agency_id: patch.agency_id || '',
    created_at: 'X', updated_at: 'X',
    ...patch,
  });
}

async function run() {
  process.env.NOVUS_BASIC_AUTH_USER = 'novus';
  process.env.NOVUS_BASIC_AUTH_PASS = 'testpass';
  process.env.NOVUS_PROBE_EMAIL = 'novusprobes@gmail.com';
  process.env.NOVUS_PROBE_PHONE = '+441234567890';

  // ── Part A: lib/problem.mjs — pure grade -> problem mapping ──
  console.log('\nPart A — lib/problem.mjs deterministic problem derivation');
  {
    const c = deriveProblem({ grade: 'C', evidence: { humanLagHours: 0.5 } });
    assert.strictEqual(c.key, 'fast_response_no_follow_up');
    assert.ok(c.statement.includes('under an hour'), 'uses the real evidence number, not a guess');
    ok('C -> fast_response_no_follow_up, evidence-backed statement');

    const g = deriveProblem({ grade: 'G', evidence: {} });
    assert.strictEqual(g.key, 'automated_acknowledgement_only');
    ok('G -> automated_acknowledgement_only');

    const h = deriveProblem({ grade: 'H', evidence: {} });
    assert.strictEqual(h.key, 'complete_miss');
    ok('H -> complete_miss');

    const a = deriveProblem({ grade: 'A', evidence: {} });
    assert.strictEqual(a.key, 'strong_front_desk');
    assert.ok(!/database/.test(a.statement.toLowerCase()) || a.statement.includes('cannot speak to'), 'does not fabricate a Growth finding');
    ok('A -> strong_front_desk, does not invent a Core problem or assert a Growth one');

    const pending = deriveProblem({ grade: 'pending', evidence: null });
    assert.deepStrictEqual(pending, { key: null, statement: null });
    ok('pending -> safe unknown state, not invented');

    const missing = deriveProblem({ grade: null, evidence: null });
    assert.deepStrictEqual(missing, { key: null, statement: null });
    ok('no grade -> safe unknown state');
  }

  // ── Part B: lib/demoOs.mjs adapter against a fake repo ──
  console.log('\nPart B — lib/demoOs.mjs adapter (probe+intelligence -> Demo OS contract)');
  {
    const { valuesApi } = makeFakeSheet();
    const repo = createRepo(valuesApi);

    // No probe linked to this slug at all.
    const none = await getProbeIntelligenceForSlug(repo, 'nobody-here');
    assert.deepStrictEqual(none, { probe: null, intelligence: null, communications: [] });
    const noneState = buildDemoOsState({ slug: 'nobody-here', lead: { company: 'Nobody Ltd' }, probe: null, intelligence: null });
    assert.strictEqual(noneState.probe, null);
    assert.strictEqual(noneState.grade, null);
    assert.deepStrictEqual(noneState.problem, { key: null, statement: null });
    assert.strictEqual(noneState.journey.key, 'C1');
    ok('unlinked slug -> agency-only state, no fabricated probe/grade/problem');

    // A known agency: fast reply, no follow-up (grade C), via probe-create + a
    // hand-seeded INTELLIGENCE row (the real recompute pipeline is exercised
    // separately in scripts/novus-observation-selftest.mjs — this test only
    // proves the adapter reads its output correctly).
    await repo.appendRecord('PROBES', {
      probe_id: 'prb_c1', probe_reference: 'RM-0001', agency_id: 'ashton-white-dxfw',
      portal: 'rightmove', property_address: '12 Example Street', property_url: 'https://example.com/1',
      property_price: '£350,000', property_status: 'For Sale', enquiry_text: '',
      probe_timestamp: '2026-08-01T09:00:00.000Z', observation_deadline: '2026-08-05T09:00:00.000Z',
      probe_status: 'observing', created_at: '2026-08-01T08:00:00.000Z', updated_at: 'X',
    });
    await seedIntelligence(repo, {
      probe_id: 'prb_c1', agency_id: 'ashton-white-dxfw',
      observation_status: 'observing', auto_acknowledgement: 'FALSE',
      first_human_touch: 'yes', first_human_touch_at: '2026-08-01T09:40:00.000Z',
      human_lag_hours: '0.6666666666666666', follow_up_count: '0', follow_up_channels: '',
      last_touch_at: '2026-08-01T09:40:00.000Z', days_chased: '0.03', persistence_profile: 'none',
      contact_quality: 'Reactive', grade: 'C',
      grade_reason: 'Very fast human contact (≤1h) with 0 genuine follow-up attempts (Source Master §10).',
    });

    const { probe: p1, intelligence: i1 } = await getProbeIntelligenceForSlug(repo, 'ashton-white-dxfw');
    assert.strictEqual(p1.probe_id, 'prb_c1');
    assert.strictEqual(i1.grade, 'C');
    ok('adapter finds the PROBES/INTELLIGENCE pair linked via agency_id = slug');

    const state1 = buildDemoOsState({
      slug: 'ashton-white-dxfw',
      lead: { company: 'Ashton White Estate Agents Billericay', url: 'http://www.ashtonwhite.co.uk/', town: 'Billericay', first_name: '' },
      probe: p1, intelligence: i1,
    });
    assert.strictEqual(state1.agency.company, 'Ashton White Estate Agents Billericay');
    assert.strictEqual(state1.property.address, '12 Example Street');
    assert.strictEqual(state1.probe.reference, 'RM-0001');
    assert.strictEqual(state1.evidence.followUpCount, 0);
    assert.ok(Math.abs(state1.evidence.humanLagHours - 0.6667) < 0.01);
    assert.strictEqual(state1.grade.value, 'C');
    assert.strictEqual(state1.problem.key, 'fast_response_no_follow_up');
    assert.strictEqual(state1.journey.key, 'C1');
    assert.strictEqual(state1.probe.enquiry, '', 'no enquiry text captured yet -> empty string, not fabricated');
    ok('grade C end-to-end: real observation numbers -> grade -> matching problem, nothing invented');

    // Milestone 2: probe.enquiry passes through PROBES.enquiry_text verbatim
    // when it IS populated - the C1 journey UI must never invent this text.
    await repo.appendRecord('PROBES', {
      probe_id: 'prb_c1_with_text', probe_reference: 'RM-0004', agency_id: 'has-enquiry-text',
      portal: 'rightmove', property_address: '18 Oak Road', enquiry_text: "I'd like to arrange a viewing for this weekend if possible.",
      probe_timestamp: '2026-08-10T09:00:00.000Z', observation_deadline: '2026-08-14T09:00:00.000Z',
      probe_status: 'observing', created_at: '2026-08-10T08:00:00.000Z', updated_at: 'X',
    });
    const { probe: pText } = await getProbeIntelligenceForSlug(repo, 'has-enquiry-text');
    const stateText = buildDemoOsState({ slug: 'has-enquiry-text', lead: { company: 'Has Enquiry Text Ltd' }, probe: pText, intelligence: null });
    assert.strictEqual(stateText.probe.enquiry, "I'd like to arrange a viewing for this weekend if possible.");
    ok('probe.enquiry passes PROBES.enquiry_text through verbatim when populated');

    // A second known agency: no observation yet (probe exists, not yet recomputed).
    await repo.appendRecord('PROBES', {
      probe_id: 'prb_pending', probe_reference: 'RM-0002', agency_id: 'stanton-hockett-3n81',
      portal: 'rightmove', property_url: 'https://example.com/2', probe_status: 'observing',
      probe_timestamp: '2026-08-13T09:00:00.000Z', observation_deadline: '2026-08-17T09:00:00.000Z',
      created_at: '2026-08-13T08:00:00.000Z', updated_at: 'X',
    });
    const { probe: p2, intelligence: i2 } = await getProbeIntelligenceForSlug(repo, 'stanton-hockett-3n81');
    assert.strictEqual(i2, null);
    const state2 = buildDemoOsState({ slug: 'stanton-hockett-3n81', lead: { company: 'Stanton Hockett Limited' }, probe: p2, intelligence: i2 });
    assert.strictEqual(state2.grade.value, 'pending');
    assert.deepStrictEqual(state2.problem, { key: null, statement: null });
    ok('probe exists but not yet observed -> pending grade, safe unknown problem (not fabricated)');

    // A third agency: grade H (complete miss) — different grade, different problem.
    await repo.appendRecord('PROBES', {
      probe_id: 'prb_h1', probe_reference: 'RM-0003', agency_id: 'quirks-estate-7dxl',
      portal: 'rightmove', property_url: 'https://example.com/3', probe_status: 'observing',
      probe_timestamp: '2026-08-01T09:00:00.000Z', observation_deadline: '2026-08-05T09:00:00.000Z',
      created_at: '2026-08-01T08:00:00.000Z', updated_at: 'X',
    });
    await seedIntelligence(repo, {
      probe_id: 'prb_h1', agency_id: 'quirks-estate-7dxl', observation_status: 'closed',
      auto_acknowledgement: 'FALSE', first_human_touch: 'no', follow_up_count: '0',
      grade: 'H', grade_reason: 'Observation window closed after 4 days with no meaningful response on any channel (Source Master §10).',
    });
    const { probe: p3, intelligence: i3 } = await getProbeIntelligenceForSlug(repo, 'quirks-estate-7dxl');
    const state3 = buildDemoOsState({ slug: 'quirks-estate-7dxl', lead: { company: 'Quirks Estate Agents Billericay' }, probe: p3, intelligence: i3 });
    assert.strictEqual(state3.grade.value, 'H');
    assert.strictEqual(state3.problem.key, 'complete_miss');
    ok('a second real agency with a different grade (H) yields a different, correctly-derived problem');
  }

  // ── Part C: end-to-end through the real handlers (create with slug -> demo-state) ──
  console.log('\nPart C — probe-create(slug) -> demo-state end-to-end');
  {
    const { valuesApi } = makeFakeSheet();
    const repo = createRepo(valuesApi);
    __setRepoForTests(repo);

    const { default: createHandler } = await import('../api/novus/probe-create.js');

    const cRes = mockRes();
    await createHandler(mockReq({ body: { url: 'https://www.rightmove.co.uk/properties/1', slug: 'Ashton-White-DXFW' } }), cRes);
    assert.strictEqual(cRes.statusCode, 200);
    assert.strictEqual(cRes.body.probe.agency_id, 'ashton-white-dxfw', 'slug is lower-cased and written to PROBES.agency_id');
    ok('probe-create writes the optional slug into PROBES.agency_id');

    const { probe } = await getProbeIntelligenceForSlug(repo, 'ashton-white-dxfw');
    assert.strictEqual(probe.probe_id, cRes.body.probe.probe_id, 'the adapter finds the just-created probe by slug');
    ok('demo-os adapter resolves a probe created via the ops tool by its linked slug');

    // Omitting slug leaves agency_id blank, exactly as before this milestone.
    const cRes2 = mockRes();
    await createHandler(mockReq({ body: { url: 'https://www.rightmove.co.uk/properties/2' } }), cRes2);
    assert.strictEqual(cRes2.body.probe.agency_id, '', 'unlinked probes still work exactly as before');
    ok('slug remains optional — existing unlinked-probe flow is unchanged');

    // ── Part D: the dev-only test fixtures (both C/G seller-ask branches) ──
    // Reuses the SAME fake repo/__setRepoForTests from Part C (still active),
    // deliberately, to prove the fixture slugs never touch it while a real
    // linked slug (ashton-white-dxfw, created above) still goes through the
    // normal Sheets-backed path untouched by either fixture's existence.
    console.log('\nPart D — dev-only test fixtures (/d/test-c1-fast-response, /d/test-g-no-ask)');
    const { default: demoStateHandler } = await import('../api/novus/demo-state.js');

    const fixtureRes = mockRes();
    await demoStateHandler(mockReq({ method: 'GET', query: { slug: 'test-c1-fast-response' } }), fixtureRes);
    assert.strictEqual(fixtureRes.statusCode, 200);
    assert.strictEqual(fixtureRes.body.agency.slug, 'test-c1-fast-response');
    assert.ok(/DEV ONLY/.test(fixtureRes.body.agency.company), 'company name makes the fixture obviously a test agency');
    assert.strictEqual(fixtureRes.body.grade.value, 'C');
    assert.strictEqual(fixtureRes.body.evidence.followUpCount, 0);
    assert.ok(Math.abs(fixtureRes.body.evidence.humanLagHours - 0.1) < 1e-9, '~6 minutes, same numbers as the Part B/self-test fixture');
    assert.strictEqual(fixtureRes.body.problem.key, 'fast_response_no_follow_up');
    assert.strictEqual(fixtureRes.body.journey.key, 'C1');
    assert.strictEqual(fixtureRes.body.acknowledgement.exists, true);
    assert.strictEqual(fixtureRes.body.acknowledgement.sellerAsk, true, 'this fixture\'s auto-ack text genuinely asks the seller question');
    assert.ok(/sell/i.test(fixtureRes.body.acknowledgement.sellerAskEvidence || ''), 'evidence quote is the real matched sentence, not invented');
    assert.strictEqual(fixtureRes.body.journeyVariant, 'C_G_SELLER_ASK');
    ok('/d/test-c1-fast-response resolves grade C + a genuine seller-ask acknowledgement -> C_G_SELLER_ASK');

    const gFixtureRes = mockRes();
    await demoStateHandler(mockReq({ method: 'GET', query: { slug: 'test-g-no-ask' } }), gFixtureRes);
    assert.strictEqual(gFixtureRes.statusCode, 200);
    assert.strictEqual(gFixtureRes.body.grade.value, 'G');
    assert.strictEqual(gFixtureRes.body.acknowledgement.exists, true);
    assert.strictEqual(gFixtureRes.body.acknowledgement.sellerAsk, false, 'this fixture\'s auto-ack text genuinely does NOT ask the seller question');
    assert.strictEqual(gFixtureRes.body.acknowledgement.sellerAskEvidence, null, 'no fabricated evidence quote when nothing matched');
    assert.strictEqual(gFixtureRes.body.journeyVariant, 'C_G_SELLER_NO_ASK');
    ok('/d/test-g-no-ask resolves grade G + an acknowledgement with no seller question -> C_G_SELLER_NO_ASK');

    const realRes = mockRes();
    await demoStateHandler(mockReq({ method: 'GET', query: { slug: 'ashton-white-dxfw' } }), realRes);
    assert.strictEqual(realRes.statusCode, 200);
    assert.strictEqual(realRes.body.probe.id, cRes.body.probe.probe_id, 'the REAL agency still resolves its own probe via the normal Sheets-backed path, unaffected by the fixture');
    ok('the dev fixture does not intercept or contaminate any other slug, including a real linked agency');

    const unknownRes = mockRes();
    await demoStateHandler(mockReq({ method: 'GET', query: { slug: 'not-a-real-slug' } }), unknownRes);
    assert.strictEqual(unknownRes.statusCode, 404, 'an unknown slug is still a 404, fixture or not');
    ok('unknown slugs are unaffected (still 404)');
  }

  // ── Part E: lib/sellerIntent.mjs — narrow, deterministic phrase detection ──
  console.log('\nPart E — lib/sellerIntent.mjs seller-intent question detection');
  {
    const { detectSellerIntentQuestion } = await import('../lib/sellerIntent.mjs');

    const hit = detectSellerIntentQuestion('Thanks for your enquiry. Do you have a property to sell?');
    assert.strictEqual(hit.asked, true);
    assert.ok(/property to sell/i.test(hit.evidence), 'evidence is the real matched sentence');
    ok('recognises a confirmed seller-intent phrase');

    const miss = detectSellerIntentQuestion('Thanks for your enquiry, one of our team will be in touch shortly.');
    assert.strictEqual(miss.asked, false);
    assert.strictEqual(miss.evidence, null, 'no evidence fabricated when nothing matched');
    ok('does not invent a match when the phrase is genuinely absent');

    const empty = detectSellerIntentQuestion('');
    assert.deepStrictEqual(empty, { asked: false, evidence: null });
    ok('empty/missing text -> safe default, not a guess');

    const curly = detectSellerIntentQuestion("We got your message! Do you have a property you’d like to sell too?");
    assert.strictEqual(curly.asked, true, 'curly apostrophe variants are still recognised');
    ok('normalises curly apostrophes before matching');
  }

  // ── Part F: lib/demoOs.mjs — deriveAcknowledgement / deriveJourneyVariant / deriveTimeline ──
  console.log('\nPart F — deriveAcknowledgement / deriveJourneyVariant / deriveTimeline (unit)');
  {
    const { deriveAcknowledgement, deriveJourneyVariant, deriveTimeline } = await import('../lib/demoOs.mjs');

    // No communications at all -> safe "doesn't exist" state, no fabricated question.
    const noAck = deriveAcknowledgement([]);
    assert.deepStrictEqual(noAck, { exists: false, text: null, timestamp: null, sellerAsk: null, sellerAskEvidence: null });
    ok('deriveAcknowledgement: no communications -> exists:false, nothing invented');

    // An auto-ack row that DOES ask.
    const askComms = [{ communication_classification: 'auto_acknowledgement', occurred_at: '2026-08-01T09:00:00.000Z', body_text: 'Thanks! Do you have a property to sell?' }];
    const askAck = deriveAcknowledgement(askComms);
    assert.strictEqual(askAck.exists, true);
    assert.strictEqual(askAck.sellerAsk, true);
    assert.ok(askAck.sellerAskEvidence.includes('property to sell'));
    ok('deriveAcknowledgement: real seller-ask text -> sellerAsk:true with real quoted evidence');

    // An auto-ack row that exists but does NOT ask.
    const noAskComms = [{ communication_classification: 'auto_acknowledgement', occurred_at: '2026-08-01T09:00:00.000Z', body_text: 'Thanks for your enquiry, we will be in touch.' }];
    const noAskAck = deriveAcknowledgement(noAskComms);
    assert.strictEqual(noAskAck.exists, true);
    assert.strictEqual(noAskAck.sellerAsk, false);
    assert.strictEqual(noAskAck.sellerAskEvidence, null);
    ok('deriveAcknowledgement: ack exists but no seller question -> sellerAsk:false, no fabricated evidence');

    // Earliest auto_acknowledgement row wins when several communications exist.
    const multiComms = [
      { communication_classification: 'human_reply', occurred_at: '2026-08-01T09:10:00.000Z', body_text: 'Hi, calling now.' },
      { communication_classification: 'auto_acknowledgement', occurred_at: '2026-08-01T09:00:00.000Z', body_text: 'Do you have a property to sell?' },
    ];
    assert.strictEqual(deriveAcknowledgement(multiComms).sellerAsk, true, 'only the classified auto_acknowledgement row is inspected, not a human reply');

    // deriveJourneyVariant: grade gate.
    assert.strictEqual(deriveJourneyVariant({ grade: 'C', acknowledgement: askAck }), 'C_G_SELLER_ASK');
    assert.strictEqual(deriveJourneyVariant({ grade: 'G', acknowledgement: askAck }), 'C_G_SELLER_ASK');
    assert.strictEqual(deriveJourneyVariant({ grade: 'C', acknowledgement: noAskAck }), 'C_G_SELLER_NO_ASK');
    assert.strictEqual(deriveJourneyVariant({ grade: 'G', acknowledgement: noAskAck }), 'C_G_SELLER_NO_ASK');
    ok('deriveJourneyVariant: grade C or G + real acknowledgement -> the correct variant');

    for (const grade of ['A', 'B', 'D', 'E', 'F', 'H', 'pending', null, undefined]) {
      assert.strictEqual(deriveJourneyVariant({ grade, acknowledgement: askAck }), null, `grade ${grade} must never activate the case journey`);
    }
    ok('deriveJourneyVariant: every non-C/G grade (A,B,D,E,F,H,pending) -> null, unchanged behaviour');

    assert.strictEqual(deriveJourneyVariant({ grade: 'C', acknowledgement: noAck }), null, 'a C-grade probe with NO acknowledgement evidence at all has no premise for this journey');
    assert.strictEqual(deriveJourneyVariant({ grade: 'C', acknowledgement: null }), null);
    ok('deriveJourneyVariant: missing seller-intent evidence -> safe fallback (null), never forces the story');

    // deriveTimeline: only real events, correctly ordered, no "— nothing —" rows invented as data.
    const tl = deriveTimeline({
      probe: { probe_timestamp: '2026-08-01T09:00:00.000Z' },
      evidence: { firstHumanTouch: 'yes', firstHumanTouchAt: '2026-08-01T09:06:00.000Z' },
      acknowledgement: askAck,
    });
    assert.strictEqual(tl.length, 3);
    assert.deepStrictEqual(tl.map((e) => e.kind), ['received', 'auto_ack', 'human']);
    assert.ok(tl.every((e) => !/nothing/i.test(e.label)), 'no fabricated placeholder rows — only real events');
    ok('deriveTimeline: real events only, correctly ordered');

    const tlNoHuman = deriveTimeline({ probe: { probe_timestamp: '2026-08-01T09:00:00.000Z' }, evidence: { firstHumanTouch: 'no' }, acknowledgement: noAskAck });
    assert.strictEqual(tlNoHuman.length, 2, 'no human touch -> no human row invented');
    ok('deriveTimeline: absent evidence produces fewer rows, never a guessed one');
  }

  // ── Part G: buildDemoOsState end-to-end for both C/G variants via a fake repo ──
  console.log('\nPart G — buildDemoOsState end-to-end, both journey variants + graceful degradation');
  {
    const { valuesApi } = makeFakeSheet();
    const repo = createRepo(valuesApi);

    // Grade C, seller-ask, full property fields.
    await repo.appendRecord('PROBES', {
      probe_id: 'prb_ask', probe_reference: 'RM-0010', agency_id: 'seller-ask-agency',
      property_address: '9 Test Street', property_url: 'https://example.com/9', property_price: '£300,000',
      property_status: 'For Sale', probe_timestamp: '2026-08-01T09:00:00.000Z',
      observation_deadline: '2026-08-05T09:00:00.000Z', probe_status: 'observing', created_at: '2026-08-01T08:00:00.000Z', updated_at: 'X',
    });
    await seedIntelligence(repo, {
      probe_id: 'prb_ask', agency_id: 'seller-ask-agency', auto_acknowledgement: 'TRUE', auto_ack_timestamp: '2026-08-01T09:00:00.000Z',
      first_human_touch: 'yes', first_human_touch_at: '2026-08-01T09:06:00.000Z', human_lag_hours: '0.1',
      follow_up_count: '0', grade: 'C', grade_reason: 'Very fast human contact (≤1h) with 0 genuine follow-up attempts (Source Master §10).',
    });
    const commRows = [{
      communication_id: 'com_ask_1', probe_id: 'prb_ask', occurred_at: '2026-08-01T09:00:00.000Z',
      communication_classification: 'auto_acknowledgement', body_text: 'Do you have a property to sell?',
    }];
    for (const c of commRows) await repo.appendRecord('COMMUNICATIONS', c);

    const { probe: pAsk, intelligence: iAsk, communications: cAsk } = await getProbeIntelligenceForSlug(repo, 'seller-ask-agency');
    assert.strictEqual(cAsk.length, 1, 'communications for this probe are fetched');
    const stateAsk = buildDemoOsState({ slug: 'seller-ask-agency', lead: { company: 'Seller Ask Agency' }, probe: pAsk, intelligence: iAsk, communications: cAsk });
    assert.strictEqual(stateAsk.journeyVariant, 'C_G_SELLER_ASK');
    assert.strictEqual(stateAsk.acknowledgement.sellerAsk, true);
    assert.strictEqual(stateAsk.property.address, '9 Test Street');
    ok('grade C + seller-ask acknowledgement -> C_G_SELLER_ASK, real property intact');

    // Grade G, no seller question, missing price/status (graceful degradation — Part 8 test 4).
    await repo.appendRecord('PROBES', {
      probe_id: 'prb_noask', probe_reference: 'RM-0011', agency_id: 'seller-noask-agency',
      property_address: '', property_url: '', property_price: '', property_status: '',
      probe_timestamp: '2026-08-01T21:04:00.000Z', observation_deadline: '2026-08-05T21:04:00.000Z',
      probe_status: 'observing', created_at: '2026-08-01T20:00:00.000Z', updated_at: 'X',
    });
    await seedIntelligence(repo, {
      probe_id: 'prb_noask', agency_id: 'seller-noask-agency', auto_acknowledgement: 'TRUE', auto_ack_timestamp: '2026-08-01T21:04:00.000Z',
      first_human_touch: 'no', follow_up_count: '0', grade: 'G',
      grade_reason: 'Automated acknowledgement only; no human contact observed (Source Master §10).',
    });
    await repo.appendRecord('COMMUNICATIONS', {
      communication_id: 'com_noask_1', probe_id: 'prb_noask',
      occurred_at: '2026-08-01T21:04:00.000Z', communication_classification: 'auto_acknowledgement',
      body_text: 'We have received your enquiry and will be in touch.',
    });
    const { probe: pNoAsk, intelligence: iNoAsk, communications: cNoAsk } = await getProbeIntelligenceForSlug(repo, 'seller-noask-agency');
    const stateNoAsk = buildDemoOsState({ slug: 'seller-noask-agency', lead: { company: 'Seller No-Ask Agency' }, probe: pNoAsk, intelligence: iNoAsk, communications: cNoAsk });
    assert.strictEqual(stateNoAsk.journeyVariant, 'C_G_SELLER_NO_ASK');
    assert.strictEqual(stateNoAsk.acknowledgement.sellerAsk, false);
    assert.strictEqual(stateNoAsk.property.address, '', 'missing address stays empty, never invented');
    assert.strictEqual(stateNoAsk.property.price, '', 'missing price stays empty, never invented');
    assert.strictEqual(stateNoAsk.property.status, '', 'missing status stays empty, never invented');
    ok('grade G + no seller question -> C_G_SELLER_NO_ASK; missing property fields degrade to empty, never fabricated');

    // A grade-C probe with human contact but genuinely NO acknowledgement at all
    // (independent booleans in lib/observation.mjs) -> no premise for this
    // journey, safe fallback, existing default hero behaviour untouched.
    const { probe: pOldC1 } = await getProbeIntelligenceForSlug(repo, 'ashton-white-dxfw').catch(() => ({ probe: null }));
    void pOldC1; // (already covered in Part B; this block only needs the no-ack case)
    await repo.appendRecord('PROBES', {
      probe_id: 'prb_c_no_ack', probe_reference: 'RM-0012', agency_id: 'fast-human-no-ack-agency',
      property_address: '5 Quiet Close', probe_timestamp: '2026-08-01T09:00:00.000Z',
      observation_deadline: '2026-08-05T09:00:00.000Z', probe_status: 'observing', created_at: '2026-08-01T08:00:00.000Z', updated_at: 'X',
    });
    await seedIntelligence(repo, {
      probe_id: 'prb_c_no_ack', agency_id: 'fast-human-no-ack-agency', auto_acknowledgement: 'FALSE',
      first_human_touch: 'yes', first_human_touch_at: '2026-08-01T09:06:00.000Z', human_lag_hours: '0.1',
      follow_up_count: '0', grade: 'C', grade_reason: 'Very fast human contact (≤1h) with 0 genuine follow-up attempts (Source Master §10).',
    });
    const { probe: pNone, intelligence: iNone, communications: cNone } = await getProbeIntelligenceForSlug(repo, 'fast-human-no-ack-agency');
    const stateNone = buildDemoOsState({ slug: 'fast-human-no-ack-agency', lead: { company: 'No Ack Agency' }, probe: pNone, intelligence: iNone, communications: cNone });
    assert.strictEqual(stateNone.grade.value, 'C');
    assert.strictEqual(stateNone.journeyVariant, null, 'grade C with zero acknowledgement evidence never forces the seller-ask story');
    assert.strictEqual(stateNone.problem.key, 'fast_response_no_follow_up', 'the existing grade->problem mapping is untouched');
    ok('grade C with no acknowledgement at all -> journeyVariant null, safe fallback (existing non-C/G behaviour unchanged)');
  }

  // ── Part H: interaction decision copy (index.html's caseDecisionResponse) ──
  // Pure function, no DOM — extracted the same way the inline script's syntax
  // is checked elsewhere in this project, so it's tested without a browser.
  console.log('\nPart H — interaction decision copy (Ring / Email / Leave)');
  {
    const fs = await import('node:fs');
    const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const m = html.match(/function caseDecisionResponse\(choice\) \{[\s\S]*?\n    \}/);
    assert.ok(m, 'caseDecisionResponse() must exist in index.html');
    // eslint-disable-next-line no-new-func
    const caseDecisionResponse = new Function('choice', m[0].replace(/^function caseDecisionResponse\(choice\) \{/, '').replace(/\}$/, ''));

    const ring = caseDecisionResponse('ring');
    const email = caseDecisionResponse('email');
    const leave = caseDecisionResponse('leave');
    assert.ok(ring && email && leave, 'all three choices produce a response');
    assert.notStrictEqual(ring, email);
    assert.notStrictEqual(email, leave);
    assert.notStrictEqual(ring, leave);
    ok('Ring / Email / Leave each produce distinct, real copy — not a progress control');

    assert.ok(!/shame|wrong|bad/i.test(caseDecisionResponse('leave')), '"Leave it" must not shame the prospect (per the brief)');
    ok('"Leave it" response does not shame the prospect');

    assert.strictEqual(caseDecisionResponse('nonsense'), null, 'unknown choice -> null, not a guess');
  }

  console.log(`\n${passed} checks passed.\n`);
}

run().catch((err) => {
  console.error('\nFAILED:', err);
  process.exit(1);
});
