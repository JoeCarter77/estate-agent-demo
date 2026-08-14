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

function makeFakeSheet() {
  const store = {
    PROBES: [PROBES_HEADER.slice(), ['SCHEMA NOTE', 'probes']],
    INTELLIGENCE: [INTELLIGENCE_HEADER.slice(), ['SCHEMA NOTE', 'intelligence']],
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
    assert.deepStrictEqual(none, { probe: null, intelligence: null });
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

    // ── Part D: the dev-only /d/test-c1-fast-response fixture ──
    // Reuses the SAME fake repo/__setRepoForTests from Part C (still active),
    // deliberately, to prove the fixture slug never touches it while a real
    // linked slug (ashton-white-dxfw, created above) still goes through the
    // normal Sheets-backed path untouched by the fixture's existence.
    console.log('\nPart D — dev-only C1 test fixture (/d/test-c1-fast-response)');
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
    ok('/d/test-c1-fast-response resolves grade C / fast_response_no_follow_up via a self-contained fixture');

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

  console.log(`\n${passed} checks passed.\n`);
}

run().catch((err) => {
  console.error('\nFAILED:', err);
  process.exit(1);
});
