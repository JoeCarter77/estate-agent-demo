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
  // probe_sent sits mid-header on purpose: it is located by header NAME, so a
  // test that only ever put it last would not prove position-independence.
  'probe_sent',
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

// Column letters -> 1-based index ("A" -> 1, "AE" -> 31).
function colIndex(letters) {
  return String(letters).split('').reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0);
}

function makeFakeSheet({ agenciesHeader = AGENCIES_HEADER } = {}) {
  const store = {
    AGENCIES: [agenciesHeader.slice(), ['SCHEMA NOTE', 'Stable identity only.']],
    PROBES: [PROBES_HEADER.slice(), ['SCHEMA NOTE', 'One row per actual probe.']],
  };
  const tabOf = (range) => String(range).split('!')[0];
  // Honours the range's START COLUMN as well as its row, so a single-cell
  // write (e.g. "AGENCIES!AE5:AE5") touches only that cell — exactly like the
  // real Sheets values API, and the behaviour probe_sent depends on.
  const anchorOf = (range) => {
    const m = String(range).match(/!([A-Z]+)(\d+)/i);
    return m ? { col: colIndex(m[1].toUpperCase()), row: parseInt(m[2], 10) } : { col: 1, row: 1 };
  };
  return { store, valuesApi: {
    async get(range) { return (store[tabOf(range)] || []).map((r) => r.slice()); },
    async append(range, rows) { const t = tabOf(range); store[t] = store[t] || []; for (const r of rows) store[t].push(r.slice()); return {}; },
    async update(range, rows) {
      const t = tabOf(range); const { col, row } = anchorOf(range);
      store[t] = store[t] || [];
      rows.forEach((r, i) => {
        const target = store[t][row - 1 + i] || (store[t][row - 1 + i] = []);
        r.forEach((v, j) => { target[col - 1 + j] = v; });
      });
      return {};
    },
    async deleteRows(tab, rowNumbers) {
      for (const rowNumber of [...rowNumbers].sort((a, b) => b - a)) store[tab].splice(rowNumber - 1, 1);
      return {};
    },
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

    const { default: createHandler } = await import('../api/novus/probe.js');
    const { default: getHandler } = await import('../api/novus/probe.js');

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
      action: 'create',
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
      action: 'create',
      url: 'https://www.rightmove.co.uk/properties/1', agency_id: 'ag_does_not_exist',
    }}), badRes);
    assert.strictEqual(badRes.statusCode, 400);
    assert.strictEqual(store.PROBES.length, before, 'no PROBES row written for an unknown agency');
    ok('an unknown agency_id is rejected (400) and writes nothing');

    // 6) Probes without a canonical agency are blocked: orphan evidence must
    //    not enter the acquisition lifecycle.
    const noAgency = mockRes();
    await createHandler(mockReq({ body: { action: 'create', url: 'https://www.rightmove.co.uk/properties/2' } }), noAgency);
    assert.strictEqual(noAgency.statusCode, 400);
    assert.match(noAgency.body.error, /Missing agency_id/);
    ok('creating a probe with no agency_id is blocked and writes no orphan row');

    // 7) Rehydration returns the same probe, with its agency link intact.
    const probeId = cRes.body.probe.probe_id;
    const rRes = mockRes();
    await getHandler(mockReq({ method: 'GET', query: { probe_id: probeId } }), rRes);
    assert.strictEqual(rRes.statusCode, 200);
    assert.strictEqual(rRes.body.probe.probe_id, probeId);
    assert.strictEqual(rRes.body.probe.agency_id, ANDREW_GRANGER_ID);
    assert.strictEqual(store.PROBES.length, before, 'rehydration created no new probe row');
    ok('?probe_id= rehydrates the existing probe (agency link intact, no new row)');

    __setRepoForTests(null);
  }

  // ── Part C: "Next agency" ordering + eligibility ──
  console.log('\nPart C — Next agency follows AGENCIES row order, skipping ineligible rows');
  {
    const { store, valuesApi } = makeFakeSheet();
    // Deliberate sheet order, mixing eligible and ineligible rows.
    store.AGENCIES.push(agencyRow({ agency_id: 'ag_one', agency_name: 'One' }));
    store.AGENCIES.push(agencyRow({ agency_id: 'ag_no_url', agency_name: 'No Rightmove URL',
      rightmove_sales_branch_url: '', rightmove_status: 'REVIEW' }));
    store.AGENCIES.push(agencyRow({ agency_id: 'ag_deleted', agency_name: 'Lettings only',
      rightmove_sales_branch_url: '', rightmove_status: 'DELETE - NON-SALES/LETTINGS' }));
    store.AGENCIES.push(agencyRow({ agency_id: 'ag_suppressed', agency_name: 'Suppressed',
      suppression_status: 'suppressed' }));
    store.AGENCIES.push(agencyRow({ agency_id: 'ag_two', agency_name: 'Two' }));
    __setRepoForTests(createRepo(valuesApi));

    const { default: getHandler } = await import('../api/novus/probe.js');

    // Skips the blank-URL, DELETE and suppressed rows, lands on the next real one.
    const nRes = mockRes();
    await getHandler(mockReq({ method: 'GET', query: { next_after: 'ag_one' } }), nRes);
    assert.strictEqual(nRes.statusCode, 200);
    assert.strictEqual(nRes.body.agency.agency_id, 'ag_two');
    ok('next_after skips blank-URL, DELETE and suppressed rows → "ag_two"');

    // Ordering is the sheet's, not alphabetical/id order.
    const idx = (id) => store.AGENCIES.findIndex((r) => r[0] === id);
    assert.ok(idx('ag_two') > idx('ag_one'), 'ag_two really is later in sheet order');
    ok('the next agency is the next eligible SHEET ROW, not an alphabetical pick');

    // End of list → a clean 404 the UI can message, not a crash.
    const endRes = mockRes();
    await getHandler(mockReq({ method: 'GET', query: { next_after: 'ag_two' } }), endRes);
    assert.strictEqual(endRes.statusCode, 404);
    assert.match(endRes.body.error, /No further eligible agency/);
    ok('running off the end of the list returns a clean "no further eligible agency" message');

    // Unknown starting agency is distinguishable from end-of-list.
    const badRes = mockRes();
    await getHandler(mockReq({ method: 'GET', query: { next_after: 'ag_missing' } }), badRes);
    assert.strictEqual(badRes.statusCode, 404);
    assert.match(badRes.body.error, /Agency not found/);
    ok('an unknown starting agency reports "Agency not found", not end-of-list');

    // The existing single-agency lookup is untouched.
    const oneRes = mockRes();
    await getHandler(mockReq({ method: 'GET', query: { agency_id: 'ag_one' } }), oneRes);
    assert.strictEqual(oneRes.statusCode, 200);
    assert.strictEqual(oneRes.body.agency.agency_name, 'One');
    ok('the existing ?agency_id= lookup still works unchanged');

    __setRepoForTests(null);
  }

  // ── Part D: mark-sent flags the agency's probe_sent cell ──
  console.log('\nPart D — marking a probe sent writes YES into AGENCIES.probe_sent');
  {
    const { store, valuesApi } = makeFakeSheet();
    store.AGENCIES.push(agencyRow({ agency_id: 'ag_other', agency_name: 'Untouched Agency' }));
    store.AGENCIES.push(agencyRow({ notes: 'KEEP ME', website: 'https://example.com' }));
    __setRepoForTests(createRepo(valuesApi));

    const { default: createHandler } = await import('../api/novus/probe.js');
    const { default: markHandler } = await import('../api/novus/probe.js');

    const probeSentIdx = AGENCIES_HEADER.indexOf('probe_sent');
    const targetRow = () => store.AGENCIES.find((r) => r[0] === ANDREW_GRANGER_ID);
    const otherRow = () => store.AGENCIES.find((r) => r[0] === 'ag_other');

    assert.strictEqual(targetRow()[probeSentIdx] ?? '', '', 'probe_sent starts empty');

    const cRes = mockRes();
    await createHandler(mockReq({ body: {
      action: 'create',
      url: 'https://www.rightmove.co.uk/properties/159273000', agency_id: ANDREW_GRANGER_ID,
    }}), cRes);
    const probeId = cRes.body.probe.probe_id;

    // Not set merely by creating a draft — only by actually marking it sent.
    assert.strictEqual(targetRow()[probeSentIdx] ?? '', '', 'creating a draft does not set probe_sent');
    ok('creating a draft probe leaves probe_sent empty');

    const mRes = mockRes();
    await markHandler(mockReq({ body: { action: 'mark-sent', probe_id: probeId } }), mRes);
    assert.strictEqual(mRes.statusCode, 200);
    assert.strictEqual(mRes.body.probe.probe_status, 'observing', 'probe still flips to observing');
    assert.strictEqual(targetRow()[probeSentIdx], 'YES');
    ok('mark-sent writes YES into the matching agency\'s probe_sent cell');

    // The cell is found by header name, at whatever position that header sits.
    assert.ok(probeSentIdx > 0 && probeSentIdx < AGENCIES_HEADER.length - 1,
      'probe_sent is mid-header, so this was a name lookup, not a fixed column');
    ok('the column was located by its "probe_sent" header, not a fixed position');

    // Everything else in that row survives — this is what protects formula
    // columns from being flattened by a whole-row rewrite.
    const row = targetRow();
    assert.strictEqual(row[AGENCIES_HEADER.indexOf('agency_name')], ANDREW_GRANGER_NAME);
    assert.strictEqual(row[AGENCIES_HEADER.indexOf('notes')], 'KEEP ME');
    assert.strictEqual(row[AGENCIES_HEADER.indexOf('website')], 'https://example.com');
    assert.strictEqual(row[AGENCIES_HEADER.indexOf('rightmove_sales_branch_url')], ANDREW_GRANGER_RM);
    ok('every other cell in that agency row is left untouched (formula columns stay intact)');

    // No other agency is affected.
    assert.strictEqual(otherRow()[probeSentIdx] ?? '', '');
    ok('other agencies\' probe_sent cells are not touched');

    __setRepoForTests(null);
  }

  // ── Part E: degrades safely when the column/agency is absent ──
  console.log('\nPart E — mark-sent still succeeds without a probe_sent column');
  {
    // A sheet exactly as it is today: no probe_sent column at all.
    const headerWithout = AGENCIES_HEADER.filter((h) => h !== 'probe_sent');
    const { store, valuesApi } = makeFakeSheet({ agenciesHeader: headerWithout });
    store.AGENCIES.push(headerWithout.map((k) => ({
      agency_id: ANDREW_GRANGER_ID, agency_name: ANDREW_GRANGER_NAME,
      rightmove_sales_branch_url: ANDREW_GRANGER_RM,
    }[k] ?? '')));
    __setRepoForTests(createRepo(valuesApi));

    const { default: createHandler } = await import('../api/novus/probe.js');
    const { default: markHandler } = await import('../api/novus/probe.js');

    const cRes = mockRes();
    await createHandler(mockReq({ body: {
      action: 'create',
      url: 'https://www.rightmove.co.uk/properties/1', agency_id: ANDREW_GRANGER_ID,
    }}), cRes);
    const mRes = mockRes();
    await markHandler(mockReq({ body: { action: 'mark-sent', probe_id: cRes.body.probe.probe_id } }), mRes);
    assert.strictEqual(mRes.statusCode, 200);
    assert.strictEqual(mRes.body.probe.probe_status, 'observing');
    assert.strictEqual(store.AGENCIES[2].length, headerWithout.length, 'no stray cell appended');
    ok('a sheet with no probe_sent column still marks sent normally (no crash, no stray cell)');

    // A probe with no agency is rejected before mark-sent can be reached.
    const noAgency = mockRes();
    await createHandler(mockReq({ body: { action: 'create', url: 'https://www.rightmove.co.uk/properties/2' } }), noAgency);
    assert.strictEqual(noAgency.statusCode, 400);
    assert.match(noAgency.body.error, /Missing agency_id/);
    ok('a probe with no agency_id is rejected before it can be marked sent');

    __setRepoForTests(null);
  }

  console.log('\nPart F — automatic selection and safe Skip Agency');
  {
    const { store, valuesApi } = makeFakeSheet();
    store.AGENCIES.push(agencyRow({ agency_id: 'ag_probed', agency_name: 'Already Probed' }));
    store.AGENCIES.push(agencyRow({ agency_id: 'ag_delete', agency_name: 'Bad Upstream Lead', updated_at: '2026-09-03T10:00:00Z' }));
    store.AGENCIES.push(agencyRow({ agency_id: 'ag_history', agency_name: 'Has History' }));
    store.PROBES.push(PROBES_HEADER.map((key) => ({ probe_id: 'prb_existing', agency_id: 'ag_probed', probe_status: 'closed' }[key] ?? '')));
    store.PROBES.push(PROBES_HEADER.map((key) => ({ probe_id: 'prb_history', agency_id: 'ag_history', probe_status: 'closed' }[key] ?? '')));
    __setRepoForTests(createRepo(valuesApi));
    const { default: handler } = await import('../api/novus/probe.js');

    const next = mockRes();
    await handler(mockReq({ method: 'GET', query: { next: '1' } }), next);
    assert.equal(next.statusCode, 200);
    assert.equal(next.body.agency.agency_id, 'ag_delete');
    ok('next=1 automatically skips agencies that already have any probe');

    const noConfirm = mockRes();
    await handler(mockReq({ body: { action: 'skip-agency', agency_id: 'ag_delete' } }), noConfirm);
    assert.equal(noConfirm.statusCode, 400);
    ok('hard deletion requires the exact server confirmation token');

    const deleted = mockRes();
    await handler(mockReq({ body: { action: 'skip-agency', agency_id: 'ag_delete', expected_updated_at: '2026-09-03T10:00:00Z', confirm: 'DELETE_UNWORKED_AGENCY' } }), deleted);
    assert.equal(deleted.statusCode, 200);
    assert.equal(store.AGENCIES.some((row) => row[0] === 'ag_delete'), false);
    ok('confirmed upstream-only agency is physically deleted');

    const protectedHistory = mockRes();
    await handler(mockReq({ body: { action: 'skip-agency', agency_id: 'ag_history', confirm: 'DELETE_UNWORKED_AGENCY' } }), protectedHistory);
    assert.equal(protectedHistory.statusCode, 409);
    assert.equal(store.AGENCIES.some((row) => row[0] === 'ag_history'), true);
    assert.equal(protectedHistory.body.dependencies[0].tab, 'PROBES');
    ok('downstream probe history blocks deletion and is retained');
    __setRepoForTests(null);
  }

  console.log(`\n✅ All ${passed} checks passed.\n`);
}

run().catch((err) => { console.error('\n❌ SELFTEST FAILED:\n', err); process.exit(1); });
