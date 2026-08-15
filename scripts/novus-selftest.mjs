// scripts/novus-selftest.mjs — hermetic Milestone 1 test (no network, no creds).
//
// Exercises the REAL code paths — lib/sheets.mjs row logic + the API handlers —
// against an in-memory fake that faithfully mimics the Google Sheets values API
// (get / append / update) and the real workbook layout:
//   row 1 = header, row 2 = "SCHEMA NOTE ...", row 3+ = data.
//
// Run:  npm run novus:selftest   (or: node scripts/novus-selftest.mjs)

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { newProbeReference } from '../lib/ids.mjs';

const PROBES_HEADER = [
  'probe_id','probe_reference','agency_id','portal','property_id','property_address',
  'property_postcode','property_url','property_price','property_type','property_bedrooms',
  'property_status','listing_agent_name','listing_image_url','extraction_status',
  'extraction_error','enquiry_text','probe_email','probe_phone',
  'probe_timestamp','observation_deadline','probe_status','compromised','compromise_reason',
  'observation_closed_at','sent_from','observation_notes','created_at','updated_at',
];

const AGENCIES_HEADER = [
  'agency_id','agency_name','website','domain','location','branch_count','main_phone',
  'known_phone_numbers','primary_contact_name','primary_contact_email','other_known_emails',
  'suppression_status','suppression_reason','created_at','updated_at',
];

// ── In-memory fake of the Google Sheets values API ────────────────────────────
function makeFakeSheet() {
  const store = {
    PROBES: [
      PROBES_HEADER.slice(),
      ['SCHEMA NOTE', 'One row per actual probe. probe_reference is the human-readable identifier.'],
    ],
    AGENCIES: [
      AGENCIES_HEADER.slice(),
      ['SCHEMA NOTE', 'Stable identity only.'],
      // One real, probe-able agency with both matching signals present.
      ['ag_test-agency', 'Test Agency Ltd', 'https://testagency.co.uk', 'testagency.co.uk',
       'Billericay', '1', '+441277000000', '+441277000000', 'Dir', 'hello@testagency.co.uk',
       '', '', '', 'X', 'X'],
    ],
  };
  function tabOf(range) { return String(range).split('!')[0]; }
  function startRowOf(range) {
    const m = String(range).match(/!\D+(\d+)/); // e.g. PROBES!A3:U3 -> 3
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
      const start = startRowOf(range); // 1-based sheet row
      store[tab] = store[tab] || [];
      rows.forEach((r, i) => { store[tab][start - 1 + i] = r.slice(); });
      return { updatedRows: rows.length };
    },
  };
  return { store, valuesApi };
}

// ── Minimal req/res doubles for the Vercel handler signature ──────────────────
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

async function run() {
  // Shared env for handlers.
  process.env.NOVUS_BASIC_AUTH_USER = 'novus';
  process.env.NOVUS_BASIC_AUTH_PASS = 'testpass';
  process.env.NOVUS_PROBE_EMAIL = 'novusprobes@gmail.com';
  process.env.NOVUS_PROBE_PHONE = '+441234567890';

  // ── Part A: repo logic directly against the fake ──
  console.log('\nPart A — lib/sheets.mjs repo logic');
  {
    const { store, valuesApi } = makeFakeSheet();
    const repo = createRepo(valuesApi);

    assert.strictEqual(await repo.count('PROBES', 'probe_id'), 0);
    ok('count() ignores header + SCHEMA NOTE rows (0 to start)');

    await repo.appendRecord('PROBES', {
      probe_id: 'prb_test_1', probe_reference: 'RM-0001', portal: 'rightmove',
      property_url: 'https://example.com/1', probe_status: 'draft',
      probe_email: 'novusprobes@gmail.com', created_at: 'X', updated_at: 'X',
    });
    assert.strictEqual(store.PROBES.length, 3, 'appended to row 3 (after schema note)');
    assert.strictEqual(store.PROBES[1][0], 'SCHEMA NOTE', 'schema note row untouched');
    ok('appendRecord() lands on row 3 and preserves the SCHEMA NOTE row');

    assert.strictEqual(await repo.count('PROBES', 'probe_id'), 1);
    ok('count() is 1 after one append');

    const found = await repo.findById('PROBES', 'probe_id', 'prb_test_1');
    assert.ok(found && found.rowNumber === 3, 'found at sheet row 3');
    assert.strictEqual(found.obj.probe_status, 'draft');
    ok('findById() resolves the record at the correct sheet row');

    const merged = await repo.updateById('PROBES', 'probe_id', 'prb_test_1', {
      probe_status: 'observing', probe_timestamp: 'T', observation_deadline: 'D',
    });
    assert.strictEqual(merged.probe_status, 'observing');
    assert.strictEqual(merged.property_url, 'https://example.com/1', 'unpatched fields preserved');
    const colOf = (name) => PROBES_HEADER.indexOf(name);
    assert.strictEqual(store.PROBES[2][colOf('probe_status')], 'observing', 'underlying cell updated in place');
    assert.strictEqual(store.PROBES[2][colOf('property_url')], 'https://example.com/1', 'other cells intact');
    ok('updateById() patches only given fields and preserves the rest');

    assert.strictEqual(await repo.findById('PROBES', 'probe_id', 'nope'), null);
    ok('findById() returns null for a missing id');
  }

  // ── Part B: reference format ──
  console.log('\nPart B — probe_reference format');
  {
    assert.strictEqual(newProbeReference(0, 'rightmove'), 'RM-0001');
    assert.strictEqual(newProbeReference(16, 'rightmove'), 'RM-0017');
    ok('newProbeReference() zero-pads a Rightmove sequence (RM-0001, RM-0017)');
  }

  // ── Part C: full flow through the real handlers ──
  console.log('\nPart C — end-to-end handler flow (create → mark-sent)');
  {
    const { store, valuesApi } = makeFakeSheet();
    __setRepoForTests(createRepo(valuesApi));

    const { default: createHandler } = await import('../api/novus/probe-create.js');
    const { default: markHandler } = await import('../api/novus/probe-mark-sent.js');
    const { default: getHandler } = await import('../api/novus/probe-get.js');

    // Auth: a bad password is rejected.
    const bad = mockRes();
    await createHandler(mockReq({ body: { agency_id: 'ag_test-agency', url: 'https://www.rightmove.co.uk/properties/1' }, auth: 'Basic ' + Buffer.from('novus:wrong').toString('base64') }), bad);
    assert.strictEqual(bad.statusCode, 401, 'wrong password rejected');
    ok('Basic Auth rejects a wrong password (401)');

    // Create draft (real fetch to Rightmove will fail/blank in this sandbox — fine).
    const cRes = mockRes();
    await createHandler(mockReq({ body: { agency_id: 'ag_test-agency', url: 'https://www.rightmove.co.uk/properties/159273000' } }), cRes);
    assert.strictEqual(cRes.statusCode, 200, 'create returned 200');
    const probe = cRes.body.probe;
    assert.ok(probe.probe_id.startsWith('prb_'), 'probe_id generated');
    assert.strictEqual(probe.probe_reference, 'RM-0001', 'first reference is RM-0001');
    assert.strictEqual(probe.portal, 'rightmove');
    assert.strictEqual(probe.probe_status, 'draft', 'created as draft');
    assert.strictEqual(probe.agency_id, 'ag_test-agency', 'probe linked to its agency');
    assert.strictEqual(probe.property_id, '159273000', 'property id derived from the URL without a fetch');
    assert.strictEqual(probe.probe_email, 'novusprobes+rm0001@gmail.com', 'per-probe plus-addressed reply email attached');
    assert.strictEqual(probe.probe_phone, '+441234567890', 'probe phone attached');
    assert.strictEqual(probe.probe_timestamp, '', 'draft has no timestamp yet');
    assert.strictEqual(probe.observation_deadline, '', 'draft has no deadline yet');
    assert.strictEqual(store.PROBES.length, 3, 'exactly one PROBES data row written');
    ok('probe-create writes a draft row with ids, portal, email/phone, no timestamp');

    // Read it back.
    const gRes = mockRes();
    await getHandler(mockReq({ method: 'GET', query: { probe_id: probe.probe_id } }), gRes);
    assert.strictEqual(gRes.statusCode, 200);
    assert.strictEqual(gRes.body.probe.probe_status, 'draft');
    ok('probe-get reads the draft back');

    // Mark as sent.
    const before = Date.now();
    const mRes = mockRes();
    await markHandler(mockReq({ body: { probe_id: probe.probe_id } }), mRes);
    const after = Date.now();
    assert.strictEqual(mRes.statusCode, 200, 'mark-sent returned 200');
    const sent = mRes.body.probe;
    assert.strictEqual(sent.probe_status, 'observing', 'status flipped to observing');
    assert.ok(sent.probe_timestamp, 'timestamp recorded');
    const ts = new Date(sent.probe_timestamp).getTime();
    assert.ok(ts >= before - 1000 && ts <= after + 1000, 'timestamp is server "now"');
    const dl = new Date(sent.observation_deadline).getTime();
    const days = (dl - ts) / (24 * 60 * 60 * 1000);
    assert.strictEqual(days, 4, 'deadline is exactly +4 days');
    ok('mark-sent sets observing + server timestamp + exact +4 day deadline');

    // Persisted to the sheet.
    assert.strictEqual(store.PROBES[2][PROBES_HEADER.indexOf('probe_status')], 'observing', 'sheet cell shows observing');
    assert.ok(store.PROBES[2][PROBES_HEADER.indexOf('probe_timestamp')], 'sheet cell shows timestamp');
    ok('the observing state is persisted to the PROBES row');

    // Idempotent second call.
    const m2 = mockRes();
    await markHandler(mockReq({ body: { probe_id: probe.probe_id } }), m2);
    assert.strictEqual(m2.body.already_sent, true, 'second mark-sent is idempotent');
    assert.strictEqual(m2.body.probe.probe_timestamp, sent.probe_timestamp, 'timestamp not reset');
    ok('mark-sent is idempotent (window not reset on re-click)');

    // Second probe increments the reference and gets its own reply address.
    const c2 = mockRes();
    await createHandler(mockReq({ body: { agency_id: 'ag_test-agency', url: 'https://www.rightmove.co.uk/properties/222222222' } }), c2);
    assert.strictEqual(c2.statusCode, 200, 'second create returned 200');
    assert.strictEqual(c2.body.probe.probe_reference, 'RM-0002', 'second reference is RM-0002');
    assert.strictEqual(c2.body.probe.probe_email, 'novusprobes+rm0002@gmail.com', 'second probe gets its own reply address');
    ok('a second probe gets RM-0002 and a distinct per-probe reply address');

    // Missing id / not found.
    const nf = mockRes();
    await markHandler(mockReq({ body: { probe_id: 'prb_missing' } }), nf);
    assert.strictEqual(nf.statusCode, 404, 'unknown probe → 404');
    ok('mark-sent returns 404 for an unknown probe');

    __setRepoForTests(null);
  }

  // ── Part D: the guards that stop a probe collecting nothing ──
  console.log('\nPart D — probe guards (agency linkage + duplicates)');
  {
    const { valuesApi } = makeFakeSheet();
    __setRepoForTests(createRepo(valuesApi));
    const { default: createHandler } = await import('../api/novus/probe-create.js');
    const { default: markHandler } = await import('../api/novus/probe-mark-sent.js');

    // No agency → refused. This is the failure that previously produced a
    // probe that ran its full window and could never be matched.
    const noAgency = mockRes();
    await createHandler(mockReq({ body: { url: 'https://www.rightmove.co.uk/properties/333333333' } }), noAgency);
    assert.strictEqual(noAgency.statusCode, 400, 'probe with no agency_id is refused');
    assert.match(noAgency.body.error, /agency/i);
    ok('probe-create refuses a probe with no agency_id');

    // Unknown agency → refused (would be an unmatchable dead end too).
    const badAgency = mockRes();
    await createHandler(mockReq({ body: { agency_id: 'ag_does-not-exist', url: 'https://www.rightmove.co.uk/properties/333333333' } }), badAgency);
    assert.strictEqual(badAgency.statusCode, 404, 'unknown agency_id is refused');
    ok('probe-create refuses an agency_id that is not in AGENCIES');

    // First probe against a listing succeeds.
    const first = mockRes();
    await createHandler(mockReq({ body: { agency_id: 'ag_test-agency', url: 'https://www.rightmove.co.uk/properties/444444444' } }), first);
    assert.strictEqual(first.statusCode, 200);

    // Same listing again → 409, because two live probes on one listing make
    // the agency's reply ambiguous instead of scoreable.
    const dup = mockRes();
    await createHandler(mockReq({ body: { agency_id: 'ag_test-agency', url: 'https://www.rightmove.co.uk/properties/444444444' } }), dup);
    assert.strictEqual(dup.statusCode, 409, 'duplicate live probe refused');
    assert.ok(dup.body.existing_probe, 'the clashing probe is reported back');
    ok('probe-create refuses a second live probe on the same listing (409)');

    // ...but an explicit force overrides it.
    const forced = mockRes();
    await createHandler(mockReq({ body: { agency_id: 'ag_test-agency', url: 'https://www.rightmove.co.uk/properties/444444444', force: true } }), forced);
    assert.strictEqual(forced.statusCode, 200, 'force=true creates the probe anyway');
    assert.ok(
      forced.body.warnings.some((w) => /already has \d+ live probe/i.test(w)),
      'the operator is warned that matching will now rely on the probe address',
    );
    ok('force=true overrides the duplicate guard but warns about ambiguity');

    // A probe whose agency was cleared by hand cannot start its window.
    const orphan = mockRes();
    await createHandler(mockReq({ body: { agency_id: 'ag_test-agency', url: 'https://www.rightmove.co.uk/properties/555555555' } }), orphan);
    const orphanId = orphan.body.probe.probe_id;
    const repo = createRepo(valuesApi);
    await repo.updateById('PROBES', 'probe_id', orphanId, { agency_id: '' });
    const blocked = mockRes();
    await markHandler(mockReq({ body: { probe_id: orphanId } }), blocked);
    assert.strictEqual(blocked.statusCode, 409, 'unlinked probe cannot be marked sent');
    ok('mark-sent refuses a probe whose agency_id was removed');

    __setRepoForTests(null);
  }

  // ── Part E: URL-derived property facts survive extraction failure ──
  console.log('\nPart E — extraction degrades explicitly, never silently');
  {
    const { propertyIdFromUrl, portalFromUrl, postcodeFrom, bedroomsAndTypeFrom } =
      await import('../lib/rightmove-meta.mjs');

    assert.strictEqual(propertyIdFromUrl('https://www.rightmove.co.uk/properties/159889523'), '159889523');
    assert.strictEqual(propertyIdFromUrl('https://www.rightmove.co.uk/properties/159889523#/?channel=RES_BUY'), '159889523');
    assert.strictEqual(propertyIdFromUrl('https://www.rightmove.co.uk/property-for-sale/property-164912345.html'), '164912345');
    assert.strictEqual(propertyIdFromUrl('https://www.rightmove.co.uk/property-for-sale/find.html?searchLocation=x'), '', 'a search page yields no property id');
    ok('property id is derived from the URL in every listing shape, with no network call');

    assert.strictEqual(portalFromUrl('https://www.zoopla.co.uk/for-sale/details/1/'), 'zoopla');
    assert.strictEqual(postcodeFrom('Wedgwood Way, Billericay, CM12 9XY'), 'CM12 9XY');
    const bt = bedroomsAndTypeFrom('3 bedroom semi-detached house for sale in Billericay');
    assert.strictEqual(bt.bedrooms, '3');
    assert.strictEqual(bt.property_type, 'semi-detached house');
    ok('portal, postcode, bedrooms and property type parse from listing text');
  }

  console.log(`\n✅ All ${passed} checks passed.\n`);
}

run().catch((err) => { console.error('\n❌ SELFTEST FAILED:\n', err); process.exit(1); });
