// scripts/novus-agency-probe-selftest.mjs — hermetic test for the
// agency → probe launch workflow (no network, no creds).
//
// Covers the three connected pieces of that workflow:
//   1. agency_id survives unchanged: launch URL → probe.html → probe-create →
//      the PROBES row, and is validated against a real AGENCIES row.
//   2. property_address is the listing's real address, never the og:title
//      marketing headline ("Check out this 4 bedroom detached house ...").
//   3. the agency's Rightmove branch page is resolved from the existing
//      AGENCIES.rightmove_sales_branch_url column for the one-click launch.
//
// AGENCIES/PROBES headers below mirror the live workbook exactly.
//
// Run:  npm run novus:agency-probe-selftest

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { extractListingAddress } from '../lib/rightmove-meta.mjs';

const AGENCIES_HEADER = [
  'agency_id','agency_name','website','domain','location','branch_count','main_phone',
  'known_phone_numbers','primary_contact_name','primary_contact_email','other_known_emails',
  'owner_md','independent_franchise_corporate','sales_led_lettings_only','years_trading',
  'incorporation_date','live_listing_count','crm_name','crm_evidence','qualification_segment',
  'current_pipeline_status','suppression_status','suppression_reason','notes','created_at','updated_at',
  'rightmove_sales_branch_url','rightmove_status','rightmove_checked_at','rightmove_notes',
];
const PROBES_HEADER = [
  'probe_id','probe_reference','agency_id','portal','property_address','property_url',
  'property_price','property_status','enquiry_text','probe_email','probe_phone',
  'probe_timestamp','observation_deadline','probe_status','compromised','compromise_reason',
  'observation_closed_at','sent_from','observation_notes','created_at','updated_at',
];

// The test agency, exactly as the workflow will be driven in production.
const ANDREW_GRANGER_ID = 'ag_test_andrewgranger';
const ANDREW_GRANGER_NAME = 'Andrew Granger Estate Agents';
const ANDREW_GRANGER_RM = 'https://www.rightmove.co.uk/estate-agents/agent/Andrew-Granger/Loughborough-265508.html#ram';

function makeFakeSheet() {
  const store = {
    AGENCIES: [AGENCIES_HEADER.slice(), ['SCHEMA NOTE', 'Stable identity only.']],
    PROBES: [PROBES_HEADER.slice(), ['SCHEMA NOTE', 'One row per actual probe.']],
  };
  const tabOf = (range) => String(range).split('!')[0];
  const startRowOf = (range) => { const m = String(range).match(/!\D+(\d+)/); return m ? parseInt(m[1], 10) : null; };
  return { store, valuesApi: {
    async get(range) { return (store[tabOf(range)] || []).map((r) => r.slice()); },
    async append(range, rows) { const t = tabOf(range); store[t] = store[t] || []; for (const r of rows) store[t].push(r.slice()); return {}; },
    async update(range, rows) { const t = tabOf(range); const s = startRowOf(range); rows.forEach((r, i) => { store[t][s - 1 + i] = r.slice(); }); return {}; },
  }};
}

function agencyRow(overrides = {}) {
  const obj = {
    agency_id: ANDREW_GRANGER_ID,
    agency_name: ANDREW_GRANGER_NAME,
    rightmove_sales_branch_url: ANDREW_GRANGER_RM,
    rightmove_status: 'CONFIRMED',
    ...overrides,
  };
  return AGENCIES_HEADER.map((k) => obj[k] ?? '');
}

const BASIC = 'Basic ' + Buffer.from('novus:testpass').toString('base64');
const mockReq = ({ method = 'POST', body = {}, query = {} } = {}) =>
  ({ method, body, query, headers: { authorization: BASIC } });
const mockRes = () => ({
  statusCode: 200, body: null,
  status(c) { this.statusCode = c; return this; },
  json(o) { this.body = o; return this; },
  end() { return this; }, setHeader() {},
});

let passed = 0;
const ok = (msg) => { passed++; console.log('  ✓ ' + msg); };

async function run() {
  process.env.NOVUS_BASIC_AUTH_USER = 'novus';
  process.env.NOVUS_BASIC_AUTH_PASS = 'testpass';
  process.env.NOVUS_PROBE_EMAIL = 'novusprobes@gmail.com';
  process.env.NOVUS_PROBE_PHONE = '+447575333064';

  // ── Part A: property address extraction ──
  console.log('\nPart A — property address extraction (never the og:title headline)');
  {
    // The exact failure being fixed: Rightmove's og:title is marketing copy.
    const junkOnly = `
      <html><head>
        <meta property="og:title" content="Check out this 4 bedroom detached house for sale on Rightmove" />
      </head><body></body></html>`;
    assert.strictEqual(extractListingAddress(junkOnly), '',
      'og:title headline must never be returned as an address');
    ok('the "Check out this ... on Rightmove" headline is rejected, not stored as the address');

    // Normal Rightmove listing: displayAddress in the embedded page JSON.
    const withDisplayAddress = `
      <html><head>
        <meta property="og:title" content="Check out this 4 bedroom detached house for sale on Rightmove" />
        <title>4 bedroom detached house for sale in Greys Drive, Groby, Leicester LE6 | Rightmove</title>
      </head><body>
        <script>window.PAGE_MODEL = {"propertyData":{"address":{"displayAddress":"Greys Drive, Groby"}}}</script>
      </body></html>`;
    assert.strictEqual(extractListingAddress(withDisplayAddress), 'Greys Drive, Groby');
    ok('displayAddress from the listing JSON wins: "Greys Drive, Groby"');

    // House number is preserved when Rightmove publishes it.
    const withNumber = withDisplayAddress.replace('"Greys Drive, Groby"', '"12 Greys Drive, Groby"');
    assert.strictEqual(extractListingAddress(withNumber), '12 Greys Drive, Groby');
    ok('house number is preserved when present: "12 Greys Drive, Groby"');

    // JSON-LD address (passed in by fetchListingMeta) is preferred over the title tag.
    assert.strictEqual(
      extractListingAddress(junkOnly, '15 Wedgwood Way, Ashingdon, Rochford, SS4 3AS'),
      '15 Wedgwood Way, Ashingdon, Rochford, SS4 3AS');
    ok('JSON-LD address is used when the page JSON has no displayAddress');

    // Falls back to the <title> tag on listings without either.
    const titleOnly = `
      <html><head>
        <meta property="og:title" content="Check out this 3 bedroom semi-detached house for sale on Rightmove" />
        <title>3 bedroom semi-detached house for sale in Southend Road, Billericay, Essex, CM11 2RA | Rightmove</title>
      </head><body></body></html>`;
    assert.strictEqual(extractListingAddress(titleOnly), 'Southend Road, Billericay, Essex, CM11 2RA');
    ok('the <title> tag address is used as a fallback (generic, not listing-specific)');
  }

  // ── Part B: agency_id integrity through the full chain ──
  console.log('\nPart B — agency_id survives launch URL → probe-create → PROBES');
  {
    const { store, valuesApi } = makeFakeSheet();
    store.AGENCIES.push(agencyRow());
    __setRepoForTests(createRepo(valuesApi));

    const { default: createHandler } = await import('../api/novus/probe-create.js');
    const { default: getHandler } = await import('../api/novus/probe-get.js');

    // 1) What the launch link resolves for display: the agency name + its
    //    Rightmove branch page (the two things one click needs).
    const aRes = mockRes();
    await getHandler(mockReq({ method: 'GET', query: { agency_id: ANDREW_GRANGER_ID } }), aRes);
    assert.strictEqual(aRes.statusCode, 200);
    assert.strictEqual(aRes.body.agency.agency_name, ANDREW_GRANGER_NAME);
    ok(`launch link resolves agency_name: "${ANDREW_GRANGER_NAME}" (not "—")`);

    assert.strictEqual(aRes.body.agency.rightmove_sales_branch_url, ANDREW_GRANGER_RM);
    ok('launch link resolves the agency\'s own rightmove_sales_branch_url for the second tab');

    // 2) Creating the probe with that agency_id.
    const cRes = mockRes();
    await createHandler(mockReq({ body: {
      url: 'https://www.rightmove.co.uk/properties/159273000',
      agency_id: ANDREW_GRANGER_ID,
    }}), cRes);
    assert.strictEqual(cRes.statusCode, 200, 'probe created');
    assert.strictEqual(cRes.body.probe.agency_id, ANDREW_GRANGER_ID);
    ok('probe-create returns the exact agency_id it was given');

    // 3) The value actually written into the PROBES sheet row.
    const agencyIdx = PROBES_HEADER.indexOf('agency_id');
    const writtenRow = store.PROBES[2];
    assert.strictEqual(writtenRow[agencyIdx], ANDREW_GRANGER_ID,
      'PROBES.agency_id cell holds the originating agency_id');
    ok(`PROBES row is relationally linked: agency_id cell = "${ANDREW_GRANGER_ID}"`);

    // 4) That id resolves back to the originating AGENCIES row (the relation
    //    the workbook relies on — agency_name is NOT duplicated into PROBES).
    const repo = createRepo(valuesApi);
    const linked = await repo.findById('AGENCIES', 'agency_id', writtenRow[agencyIdx]);
    assert.ok(linked, 'PROBES.agency_id resolves to a real AGENCIES row');
    assert.strictEqual(linked.obj.agency_name, ANDREW_GRANGER_NAME);
    ok('PROBES.agency_id joins back to the AGENCIES row and its agency_name');

    // 5) A bad agency_id is rejected outright — never written, never guessed.
    const before = store.PROBES.length;
    const badRes = mockRes();
    await createHandler(mockReq({ body: {
      url: 'https://www.rightmove.co.uk/properties/1', agency_id: 'ag_does_not_exist',
    }}), badRes);
    assert.strictEqual(badRes.statusCode, 400);
    assert.strictEqual(store.PROBES.length, before, 'no PROBES row written for an unknown agency');
    ok('an unknown agency_id is rejected (400) and writes nothing');

    // 6) Probes created without an agency (the pre-existing flow) still work.
    const noAgency = mockRes();
    await createHandler(mockReq({ body: { url: 'https://www.rightmove.co.uk/properties/2' } }), noAgency);
    assert.strictEqual(noAgency.statusCode, 200);
    assert.strictEqual(noAgency.body.probe.agency_id, '');
    ok('creating a probe with no agency_id is unchanged (stays empty, no regression)');

    // 7) Rehydration returns the same probe, with its agency link intact.
    const probeId = cRes.body.probe.probe_id;
    const rRes = mockRes();
    await getHandler(mockReq({ method: 'GET', query: { probe_id: probeId } }), rRes);
    assert.strictEqual(rRes.statusCode, 200);
    assert.strictEqual(rRes.body.probe.probe_id, probeId);
    assert.strictEqual(rRes.body.probe.agency_id, ANDREW_GRANGER_ID);
    assert.strictEqual(store.PROBES.length, before + 1, 'rehydration created no new probe row');
    ok('?probe_id= rehydrates the existing probe (agency link intact, no new row)');

    __setRepoForTests(null);
  }

  console.log(`\n✅ All ${passed} checks passed.\n`);
}

run().catch((err) => { console.error('\n❌ SELFTEST FAILED:\n', err); process.exit(1); });
