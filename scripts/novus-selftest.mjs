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
import { __setListingMetaFetcherForTests } from '../lib/rightmove-meta.mjs';

const PROBES_HEADER = [
  'probe_id','probe_reference','agency_id','portal','property_address','property_url',
  'property_price','property_status','enquiry_text','probe_email','probe_phone',
  'probe_timestamp','observation_deadline','probe_status','compromised','compromise_reason',
  'observation_closed_at','sent_from','observation_notes','created_at','updated_at',
];

// probe-create now validates agency_id against AGENCIES, so the fake needs the
// tab. Trimmed to the columns the handler actually reads.
const AGENCIES_HEADER = [
  'agency_id','agency_name','domain','location','sales_led_lettings_only',
  'suppression_status','suppression_reason','notes','created_at','updated_at',
];
const TEST_AGENCY_ID = 'ag_selftest_0001';

// ── In-memory fake of the Google Sheets values API ────────────────────────────
function makeFakeSheet() {
  const store = {
    PROBES: [
      PROBES_HEADER.slice(),
      ['SCHEMA NOTE', 'One row per actual probe. probe_reference is the human-readable identifier.'],
    ],
    AGENCIES: [
      AGENCIES_HEADER.slice(),
      ['SCHEMA NOTE', 'One row per agency.'],
      AGENCIES_HEADER.map((k) => {
        if (k === 'agency_id') return TEST_AGENCY_ID;
        if (k === 'agency_name') return 'Selftest Agency';
        if (k === 'domain') return 'selftest.example.com';
        return '';
      }),
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
    assert.strictEqual(store.PROBES[2][13], 'observing', 'underlying cell updated in place');
    assert.strictEqual(store.PROBES[2][5], 'https://example.com/1', 'other cells intact');
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

    // Hermetic enrichment: probe-create must not reach out to rightmove.co.uk.
    __setListingMetaFetcherForTests(async () => ({
      address: '', price: '', status: '', property_type: '', bedrooms: '', title: '',
    }));

    const { default: createHandler } = await import('../api/novus/probe-create.js');
    const { default: markHandler } = await import('../api/novus/probe-mark-sent.js');
    const { default: getHandler } = await import('../api/novus/probe-get.js');

    // Auth: a bad password is rejected.
    const bad = mockRes();
    await createHandler(mockReq({ body: { agency_id: TEST_AGENCY_ID, url: 'https://www.rightmove.co.uk/properties/159273000' }, auth: 'Basic ' + Buffer.from('novus:wrong').toString('base64') }), bad);
    assert.strictEqual(bad.statusCode, 401, 'wrong password rejected');
    ok('Basic Auth rejects a wrong password (401)');

    // Create draft. agency_id is now REQUIRED — a probe with no agency is
    // unmatchable downstream (see api/novus/probe-create.js).
    const cRes = mockRes();
    await createHandler(mockReq({ body: { agency_id: TEST_AGENCY_ID, url: 'https://www.rightmove.co.uk/properties/159273000' } }), cRes);
    assert.strictEqual(cRes.statusCode, 200, 'create returned 200');
    const probe = cRes.body.probe;
    assert.ok(probe.probe_id.startsWith('prb_'), 'probe_id generated');
    assert.strictEqual(probe.probe_reference, 'RM-0001', 'first reference is RM-0001');
    assert.strictEqual(probe.portal, 'rightmove');
    assert.strictEqual(probe.probe_status, 'draft', 'created as draft');
    assert.strictEqual(probe.agency_id, TEST_AGENCY_ID, 'agency_id carried into the probe');
    assert.strictEqual(probe.probe_email, 'novusprobes@gmail.com', 'probe email attached');
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
    assert.strictEqual(store.PROBES[2][13], 'observing', 'sheet cell shows observing');
    assert.ok(store.PROBES[2][11], 'sheet cell shows timestamp');
    ok('the observing state is persisted to the PROBES row');

    // Idempotent second call.
    const m2 = mockRes();
    await markHandler(mockReq({ body: { probe_id: probe.probe_id } }), m2);
    assert.strictEqual(m2.body.already_sent, true, 'second mark-sent is idempotent');
    assert.strictEqual(m2.body.probe.probe_timestamp, sent.probe_timestamp, 'timestamp not reset');
    ok('mark-sent is idempotent (window not reset on re-click)');

    // Second probe increments the reference.
    const c2 = mockRes();
    await createHandler(mockReq({ body: { agency_id: TEST_AGENCY_ID, url: 'https://www.rightmove.co.uk/properties/159273111' } }), c2);
    assert.strictEqual(c2.body.probe.probe_reference, 'RM-0002', 'second reference is RM-0002');
    ok('a second probe gets RM-0002');

    // Missing id / not found.
    const nf = mockRes();
    await markHandler(mockReq({ body: { probe_id: 'prb_missing' } }), nf);
    assert.strictEqual(nf.statusCode, 404, 'unknown probe → 404');
    ok('mark-sent returns 404 for an unknown probe');

    __setRepoForTests(null);
  }

  console.log(`\n✅ All ${passed} checks passed.\n`);
}

run().catch((err) => { console.error('\n❌ SELFTEST FAILED:\n', err); process.exit(1); });
