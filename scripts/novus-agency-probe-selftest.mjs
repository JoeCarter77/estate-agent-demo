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
import { isProbeQueueEligible, resolveLifecycleStage } from '../lib/acquisition-stage.mjs';

const AGENCIES_HEADER = [
  'agency_id','agency_name','website','domain','location','branch_count','main_phone',
  'known_phone_numbers','primary_contact_name','primary_contact_email','other_known_emails',
  'outreach_contact_email','email_verification_status',
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
    async batchUpdate(data) {
      for (const { range, values } of data) await this.update(range, values);
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
    outreach_contact_email: 'bradley@andrewgranger.co.uk',
    email_verification_status: 'VALID',
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

    // 8) A RISKY outreach email cannot create a probe at all.
    store.AGENCIES.push(agencyRow({ agency_id: 'ag_risky_create', agency_name: 'Risky Create', email_verification_status: 'RISKY' }));
    const riskyCreate = mockRes();
    await createHandler(mockReq({ body: {
      action: 'create', url: 'https://www.rightmove.co.uk/properties/3', agency_id: 'ag_risky_create',
    }}), riskyCreate);
    assert.strictEqual(riskyCreate.statusCode, 409);
    assert.match(riskyCreate.body.error, /verified VALID/);
    assert.strictEqual(store.PROBES.length, before, 'RISKY email creates no PROBES row');
    ok('RISKY email is blocked server-side before a probe can be created');

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
    store.AGENCIES.push(agencyRow({ agency_id: 'ag_risky', agency_name: 'Risky', email_verification_status: 'RISKY' }));
    store.AGENCIES.push(agencyRow({ agency_id: 'ag_two', agency_name: 'Two' }));
    __setRepoForTests(createRepo(valuesApi));

    const { default: getHandler } = await import('../api/novus/probe.js');

    // Skips blank-URL, DELETE, suppressed and non-VALID rows, lands on next VALID one.
    const nRes = mockRes();
    await getHandler(mockReq({ method: 'GET', query: { next_after: 'ag_one' } }), nRes);
    assert.strictEqual(nRes.statusCode, 200);
    assert.strictEqual(nRes.body.agency.agency_id, 'ag_two');
    ok('next_after skips blank-URL, DELETE, suppressed and RISKY rows → "ag_two"');

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
      outreach_contact_email: 'bradley@andrewgranger.co.uk', email_verification_status: 'VALID',
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

  console.log('\nPart F — Skip keeps the record; Delete only for exact duplicates; brand/branch guard');
  {
    const rm = (slug, id) => `https://www.rightmove.co.uk/estate-agents/agent/${slug}/Branch-${id}.html`;
    // The four live rows from NOVUS_Data_V1_Master_v2, verbatim in the fields
    // the matcher reads (rows 59, 169, 488, 721).
    const POCOCK_NEWMARKET = { agency_id: 'ag_hist_pocock-shaw-m31t', agency_name: 'Pocock + Shaw', website: 'https://www.pocock.co.uk/', domain: 'pocock.co.uk',
      probe_sent: 'YES', location: 'Newmarket', main_phone: '01638 668284', known_phone_numbers: '01638 668284',
      rightmove_sales_branch_url: 'https://www.rightmove.co.uk/estate-agents/agent/Pocock-Shaw/Newmarket-13799.html',
      outreach_contact_email: 'piers@pocock.co.uk', email_verification_status: 'VALID' };
    const POCOCK_ELY = { agency_id: 'ag-pocock-shaw-703', agency_name: 'Pocock & Shaw', website: 'http://www.pocock.co.uk/', domain: 'pocock.co.uk',
      location: 'Ely, Cambridgeshire, 26 High St, ELY CB7 4JU, UK', main_phone: '01353 668091', known_phone_numbers: '01353 668091',
      rightmove_sales_branch_url: 'https://www.rightmove.co.uk/estate-agents/agent/Pocock-and-Shaw/Cottenham-217103.html',
      outreach_contact_email: 'piers@pocock.co.uk', email_verification_status: 'VALID', updated_at: '2026-09-02T23:32:56.315Z' };
    const SJW_ORIGINAL = { agency_id: 'ag-sj-warren-632', agency_name: 'SJ Warren Estate Agents Burnham-On-Crouch', website: 'http://sjwarren.co.uk/', domain: 'sjwarren.co.uk',
      probe_sent: 'YES', location: 'Burnham-on-Crouch, 164 Station Rd, Burnham-on-Crouch CM0 8HJ, UK', main_phone: '01621 734300', known_phone_numbers: '01621 734300',
      rightmove_sales_branch_url: 'https://www.rightmove.co.uk/estate-agents/agent/S-J-Warren/Burnham-On-Crouch-165632.html',
      outreach_contact_email: 'simon@sjwarren.co.uk', email_verification_status: 'VALID' };
    const SJW_DUPLICATE = { agency_id: 'ag-sj-warren-estate-agents-burnham-on-cro-5489', agency_name: 'SJ Warren Estate Agents Burnham-On-Crouch', website: 'http://sjwarren.co.uk/', domain: 'sjwarren.co.uk',
      location: 'Burnham, Buckinghamshire, 164 Station Rd, Burnham-on-Crouch CM0 8HJ, UK', main_phone: '01621 734300', known_phone_numbers: '01621 734300',
      rightmove_sales_branch_url: 'https://www.rightmove.co.uk/estate-agents/agent/S-J-Warren/Essex-165632.html',
      outreach_contact_email: 'info@sjwarren.co.uk', email_verification_status: 'VALID', updated_at: '2026-09-02T23:47:51.251Z' };

    const { store, valuesApi } = makeFakeSheet();
    store.AGENCIES.push(agencyRow(POCOCK_NEWMARKET));
    store.AGENCIES.push(agencyRow(SJW_ORIGINAL));
    store.AGENCIES.push(agencyRow({ agency_id: 'ag_plain', agency_name: 'Plain Unrelated', rightmove_sales_branch_url: rm('Plain', 101), outreach_contact_email: 'a@plain.test' }));
    store.AGENCIES.push(agencyRow(POCOCK_ELY));
    store.AGENCIES.push(agencyRow(SJW_DUPLICATE));
    store.AGENCIES.push(agencyRow({ agency_id: 'ag_next', agency_name: 'Next Unrelated', rightmove_sales_branch_url: rm('Next', 102), outreach_contact_email: 'a@next.test' }));
    // An exact duplicate that HAS its own history (a probe) must not be deletable.
    store.AGENCIES.push(agencyRow({ agency_id: 'ag_dup_history', agency_name: 'SJ Warren', domain: 'sjwarren.co.uk',
      location: '164 Station Rd, Burnham-on-Crouch CM0 8HJ', main_phone: '01621 734300',
      rightmove_sales_branch_url: SJW_ORIGINAL.rightmove_sales_branch_url, outreach_contact_email: 'x@sjwarren.co.uk' }));
    store.PROBES.push(PROBES_HEADER.map((key) => ({ probe_id: 'prb_pocock', probe_reference: 'RM-0029', agency_id: POCOCK_NEWMARKET.agency_id, probe_status: 'closed', probe_timestamp: '2026-08-17T22:33:14.677Z' }[key] ?? '')));
    store.PROBES.push(PROBES_HEADER.map((key) => ({ probe_id: 'prb_sjw', probe_reference: 'RM-0169', agency_id: SJW_ORIGINAL.agency_id, probe_status: 'closed', probe_timestamp: '2026-08-31T23:03:57.722Z' }[key] ?? '')));
    store.PROBES.push(PROBES_HEADER.map((key) => ({ probe_id: 'prb_dup_hist', agency_id: 'ag_dup_history', probe_status: 'draft' }[key] ?? '')));
    const CONTACTS_HEADER = ['contact_id', 'agency_id', 'email', 'is_selected_for_outreach', 'notes', 'updated_at'];
    store.CONTACTS = [CONTACTS_HEADER, ['cnt_sjw_dup', SJW_DUPLICATE.agency_id, 'info@sjwarren.co.uk', 'TRUE', '', '']];
    const ACTIONS_COLS = ['action_id', 'agency_id', 'outreach_id', 'probe_id', 'reply_event_id', 'action_type', 'action_owner', 'action_status',
      'due_at', 'reason', 'source_stage', 'dedupe_key', 'created_at', 'updated_at', 'completed_at', 'cancelled_at', 'completion_reason', 'error', 'metadata_json'];
    store.ACTIONS = [ACTIONS_COLS, ACTIONS_COLS.map((k) => ({ action_id: 'act_sjw_dup', agency_id: SJW_DUPLICATE.agency_id, action_type: 'PROBE_AGENCY',
      action_status: 'DUE', action_owner: 'JOE', dedupe_key: `${SJW_DUPLICATE.agency_id}:PROBE_AGENCY:${SJW_DUPLICATE.agency_id}` }[k] ?? ''))];
    __setRepoForTests(createRepo(valuesApi));
    const { default: handler } = await import('../api/novus/probe.js');
    const call = async (req) => { const res = mockRes(); await handler(mockReq(req), res); return res; };
    const agencyCells = (id) => {
      const header = store.AGENCIES[0];
      const row = store.AGENCIES.find((r) => r[0] === id);
      return row ? Object.fromEntries(header.map((h, i) => [h, row[i] ?? ''])) : null;
    };

    // Pocock & Shaw: row 488 (Ely) is ANOTHER BRANCH of the probed row 59.
    const ely = await call({ method: 'GET', query: { agency_id: POCOCK_ELY.agency_id } });
    assert.equal(ely.statusCode, 200);
    assert.equal(ely.body.relationship.status, 'OTHER_BRANCH');
    assert.equal(ely.body.relationship.probe_decision, 'CONFIRM_RELATED_PROBED');
    assert.equal(ely.body.relationship.related[0].agency_id, POCOCK_NEWMARKET.agency_id);
    assert.deepEqual(ely.body.relationship.related[0].probe_references, ['RM-0029']);
    assert.match(ely.body.relationship_summary, /Another branch of this company has already been probed: Pocock \+ Shaw \(Newmarket\)/);
    assert.equal(ely.body.delete_check.permitted, false);
    ok('Pocock & Shaw Ely (row 488) is shown as another branch of probed Pocock + Shaw Newmarket (row 59, RM-0029)');

    const elyUnconfirmed = await call({ body: { action: 'create', url: 'https://www.rightmove.co.uk/properties/1', agency_id: POCOCK_ELY.agency_id } });
    assert.equal(elyUnconfirmed.statusCode, 409);
    assert.equal(elyUnconfirmed.body.needs_confirmation, true);
    assert.equal(store.PROBES.filter((r) => r[2] === POCOCK_ELY.agency_id).length, 0);
    ok('an unconfirmed probe of another branch is refused and writes nothing');

    const elyConfirmed = await call({ body: { action: 'create', url: 'https://www.rightmove.co.uk/properties/1', agency_id: POCOCK_ELY.agency_id, confirm_related_probe: true } });
    assert.equal(elyConfirmed.statusCode, 200, elyConfirmed.body?.error);
    assert.equal(elyConfirmed.body.probe.probe_status, 'draft');
    ok('a deliberate, confirmed branch-specific probe of Pocock & Shaw Ely is allowed');
    // Tidy: this draft is not part of the remaining scenario.
    store.PROBES = store.PROBES.filter((r) => r[2] !== POCOCK_ELY.agency_id);

    // SJ Warren: row 721 is the SAME BRANCH as probed row 169.
    const dup = await call({ method: 'GET', query: { agency_id: SJW_DUPLICATE.agency_id } });
    assert.equal(dup.body.relationship.status, 'EXACT_DUPLICATE');
    assert.equal(dup.body.relationship.canonical_agency_id, SJW_ORIGINAL.agency_id);
    assert.equal(dup.body.relationship.probe_decision, 'BLOCKED_EXACT_BRANCH_PROBED');
    assert.match(dup.body.relationship_summary, /This exact branch has already been probed .* RM-0169/);
    assert.equal(dup.body.delete_check.permitted, true, dup.body.delete_check.reason);
    ok('SJ Warren row 721 is an exact duplicate of probed row 169 (RM-0169); delete is permitted');

    const dupCreate = await call({ body: { action: 'create', url: 'https://www.rightmove.co.uk/properties/2', agency_id: SJW_DUPLICATE.agency_id, confirm_related_probe: true } });
    assert.equal(dupCreate.statusCode, 409);
    assert.match(dupCreate.body.error, /This exact branch has already been probed/);
    ok('an exact branch already probed cannot be probed again, even with confirmation');

    const original = await call({ method: 'GET', query: { agency_id: SJW_ORIGINAL.agency_id } });
    assert.equal(original.body.relationship.canonical_agency_id, '');
    assert.equal(original.body.delete_check.permitted, false);
    ok('the kept (probed) SJ Warren row 169 is never offered for deletion');

    const histDup = await call({ method: 'GET', query: { agency_id: 'ag_dup_history' } });
    assert.equal(histDup.body.relationship.status, 'EXACT_DUPLICATE');
    assert.equal(histDup.body.delete_check.permitted, false);
    assert.match(histDup.body.delete_check.reason, /Not deletable: this row has its own history \(1 PROBES\)/);
    ok('an exact duplicate with its own history is not deletable, with an informative reason');

    // SKIP — needs a real reason; keeps the row; records status, reason, time.
    const noReason = await call({ body: { action: 'skip-agency', agency_id: 'ag_plain' } });
    assert.equal(noReason.statusCode, 400);
    assert.match(noReason.body.error, /Already probed another branch, Duplicate agency, Unsuitable agency, No suitable Rightmove listing, Other/);
    ok('Skip requires one of the five skip reasons');

    const probesBefore = store.PROBES.length;
    const skipped = await call({ body: { action: 'skip-agency', agency_id: POCOCK_ELY.agency_id, reason: 'Already probed another branch', note: 'Newmarket probed as RM-0029' } });
    assert.equal(skipped.statusCode, 200, skipped.body?.error);
    const elyRow = agencyCells(POCOCK_ELY.agency_id);
    assert.ok(elyRow, 'skipped agency row is kept');
    assert.equal(elyRow.probe_skip_status, 'SKIPPED');
    assert.equal(elyRow.probe_skip_reason, 'Already probed another branch — Newmarket probed as RM-0029');
    assert.ok(Date.parse(elyRow.probe_skipped_at));
    assert.equal(elyRow.probe_sent, '', 'a skip never marks the agency probed');
    assert.equal(store.PROBES.length, probesBefore, 'a skip never creates a PROBES row');
    assert.match(elyRow.notes, /prober skip: Already probed another branch/);
    assert.equal(skipped.body.next_agency_id, SJW_DUPLICATE.agency_id);
    ok('Skip keeps Pocock & Shaw Ely, records status/reason/time + audit note, creates no probe and advances');

    const nextQ = await call({ method: 'GET', query: { next: '1' } });
    assert.equal(nextQ.body.agency.agency_id, 'ag_plain');
    const afterPlain = await call({ method: 'GET', query: { next_after: 'ag_plain' } });
    assert.equal(afterPlain.body.agency.agency_id, SJW_DUPLICATE.agency_id, 'skipped Ely is passed over');
    assert.equal(resolveLifecycleStage({ agency: elyRow }).stage, 'CLOSED');
    ok('a skipped agency is excluded from the queue and raises no PROBE_AGENCY / SORT_LEAD task');

    const skippedCreate = await call({ body: { action: 'create', url: 'https://www.rightmove.co.uk/properties/3', agency_id: POCOCK_ELY.agency_id, confirm_related_probe: true } });
    assert.equal(skippedCreate.statusCode, 409);
    assert.match(skippedCreate.body.error, /skipped .* Restore it/);
    ok('a skipped agency cannot be probed until restored');

    const restored = await call({ body: { action: 'restore-agency', agency_id: POCOCK_ELY.agency_id } });
    assert.equal(restored.statusCode, 200, restored.body?.error);
    assert.equal(agencyCells(POCOCK_ELY.agency_id).probe_skip_status, 'RESTORED');
    assert.equal(agencyCells(POCOCK_ELY.agency_id).probe_skip_reason, 'Already probed another branch — Newmarket probed as RM-0029', 'the skip history is kept');
    const afterRestore = await call({ method: 'GET', query: { next_after: 'ag_plain' } });
    assert.equal(afterRestore.body.agency.agency_id, POCOCK_ELY.agency_id);
    ok('a skipped agency can be restored to the queue, keeping its skip history');

    // DELETE — separate action, exact duplicates only.
    const notDup = await call({ body: { action: 'delete-agency', agency_id: POCOCK_ELY.agency_id, confirm: 'DELETE_EXACT_DUPLICATE' } });
    assert.equal(notDup.statusCode, 409);
    assert.match(notDup.body.error, /Only a confirmed exact duplicate .* Use Skip/);
    assert.ok(agencyCells(POCOCK_ELY.agency_id));
    ok('a different branch cannot be deleted — the refusal says to use Skip instead');

    const keepOriginal = await call({ body: { action: 'delete-agency', agency_id: SJW_ORIGINAL.agency_id, confirm: 'DELETE_EXACT_DUPLICATE' } });
    assert.equal(keepOriginal.statusCode, 409);
    assert.ok(agencyCells(SJW_ORIGINAL.agency_id));
    ok('the canonical probed row can never be deleted');

    const noToken = await call({ body: { action: 'delete-agency', agency_id: SJW_DUPLICATE.agency_id } });
    assert.equal(noToken.statusCode, 400);
    ok('delete requires the exact server confirmation token');

    const del = await call({ body: { action: 'delete-agency', agency_id: SJW_DUPLICATE.agency_id, confirm: 'DELETE_EXACT_DUPLICATE', expected_updated_at: SJW_DUPLICATE.updated_at } });
    assert.equal(del.statusCode, 200, del.body?.error);
    assert.equal(agencyCells(SJW_DUPLICATE.agency_id), null);
    assert.ok(agencyCells(SJW_ORIGINAL.agency_id), 'canonical row kept');
    assert.equal(store.PROBES.filter((r) => r[2] === SJW_ORIGINAL.agency_id).length, 1, 'canonical probe history kept');
    assert.deepEqual(store.CONTACTS[1].slice(0, 4), ['cnt_sjw_dup', SJW_ORIGINAL.agency_id, 'info@sjwarren.co.uk', 'FALSE']);
    const actRow = store.ACTIONS.find((r) => r[0] === 'act_sjw_dup');
    assert.ok(actRow, 'the action row is cancelled, not deleted');
    const act = Object.fromEntries(ACTIONS_COLS.map((k, i) => [k, actRow[i]]));
    assert.equal(act.action_status, 'CANCELLED');
    assert.match(act.completion_reason, /exact duplicate of ag-sj-warren-632/);
    ok('SJ Warren row 721 deletes cleanly: contact re-linked to row 169, its system action cancelled, nothing historical removed');
    __setRepoForTests(null);
  }

  // ── Part G: canonical Prober queue = blank probe_sent + VALID outreach email ──
  console.log('\nPart G — Prober queue requires blank probe_sent AND a verified VALID outreach email');
  {
    const EMAIL = 'bradley@andrewgranger.co.uk';
    const base = { rightmove_sales_branch_url: ANDREW_GRANGER_RM, outreach_contact_email: EMAIL, email_verification_status: 'VALID' };
    assert.equal(isProbeQueueEligible({ ...base, probe_sent: '' }), true);
    ok('blank probe_sent + VALID email is eligible');
    assert.equal(isProbeQueueEligible({ ...base, probe_sent: '   ' }), true);
    ok('whitespace-only probe_sent counts as blank and stays eligible');
    assert.equal(isProbeQueueEligible({ ...base, probe_sent: 'YES' }), false);
    ok('probe_sent = "YES" is not eligible');
    for (const value of ['NO', 'yes', '2026-09-01T10:00:00.000Z', 'sent by hand', '0']) {
      assert.equal(isProbeQueueEligible({ ...base, probe_sent: value }), false, value);
    }
    ok('ANY non-empty probe_sent value is not eligible (including "NO", "0" and free text)');
    assert.equal(isProbeQueueEligible({ ...base, probe_sent: '', current_pipeline_status: 'PROBE_COMPLETE' }), true);
    ok('downstream lifecycle state does not override a blank probe_sent');
    assert.equal(isProbeQueueEligible({ ...base, rightmove_sales_branch_url: '', probe_sent: '' }), false);
    assert.equal(isProbeQueueEligible({ ...base, probe_sent: '', suppression_status: 'suppressed' }), false);
    for (const status of ['CLOSED', 'EXCLUDED', 'MEETING_BOOKED', 'NOT_INTERESTED']) {
      assert.equal(isProbeQueueEligible({ ...base, probe_sent: '', current_pipeline_status: status }), false, status);
    }
    ok('blank probe_sent still respects suppressed / closed / excluded / meeting / not-interested exclusions');

    // Email is a hard pre-probe gate: only VALID can enter.
    assert.equal(isProbeQueueEligible({ ...base, probe_sent: '', outreach_contact_email: '' }), false);
    ok('blank outreach_contact_email is skipped over');
    assert.equal(isProbeQueueEligible({ ...base, probe_sent: '', outreach_contact_email: '   ' }), false);
    ok('whitespace-only outreach_contact_email is skipped over');
    for (const status of ['RISKY', 'UNKNOWN', 'INVALID', 'DISPOSABLE', '']) {
      assert.equal(isProbeQueueEligible({ ...base, probe_sent: '', email_verification_status: status }), false, status);
    }
    ok('RISKY, UNKNOWN, INVALID, DISPOSABLE and blank verification statuses are all skipped');
    assert.equal(isProbeQueueEligible({ ...base, probe_sent: '', outreach_contact_email: '', primary_contact_email: EMAIL, other_known_emails: EMAIL }), false);
    ok('primary_contact_email / other_known_emails do not substitute for outreach_contact_email');
    {
      const row = { rightmove_sales_branch_url: ANDREW_GRANGER_RM, probe_sent: '', outreach_contact_email: '', email_verification_status: '' };
      assert.equal(isProbeQueueEligible(row), false);
      row.outreach_contact_email = EMAIL;
      assert.equal(isProbeQueueEligible(row), false);
      row.email_verification_status = 'VALID';
      assert.equal(isProbeQueueEligible(row), true);
      ok('a row becomes eligible only after both outreach email and VALID verification are present');
    }

    // End-to-end: RISKY/no-email rows are invisible to next/advance/telemetry.
    const { store, valuesApi } = makeFakeSheet();
    store.AGENCIES.push(agencyRow({ agency_id: 'ag_q_sent', agency_name: 'Probed YES', probe_sent: 'YES' }));
    store.AGENCIES.push(agencyRow({ agency_id: 'ag_q_stray', agency_name: 'Probed out of band', probe_sent: '2026-08-30T09:00:00.000Z' }));
    store.AGENCIES.push(agencyRow({ agency_id: 'ag_q_noemail', agency_name: 'No Email Yet', outreach_contact_email: '', email_verification_status: '' }));
    store.AGENCIES.push(agencyRow({ agency_id: 'ag_q_risky', agency_name: 'Risky Email', email_verification_status: 'RISKY' }));
    store.AGENCIES.push(agencyRow({ agency_id: 'ag_q_first', agency_name: 'First Valid' }));
    store.AGENCIES.push(agencyRow({ agency_id: 'ag_q_second', agency_name: 'Second Valid', updated_at: '2026-09-03T10:00:00Z' }));
    store.AGENCIES.push(agencyRow({ agency_id: 'ag_q_third', agency_name: 'Third Valid' }));
    store.PROBES.push(PROBES_HEADER.map((key) => ({ probe_id: 'prb_q1', agency_id: 'ag_q_first', probe_status: 'closed', probe_timestamp: new Date().toISOString() }[key] ?? '')));
    __setRepoForTests(createRepo(valuesApi));
    const { default: handler } = await import('../api/novus/probe.js');

    const first = mockRes();
    await handler(mockReq({ method: 'GET', query: { next: '1' } }), first);
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.agency.agency_id, 'ag_q_first');
    ok('next=1 skips probed, email-less and RISKY rows and returns the first VALID row');

    assert.equal(first.body.queue.remaining, 3);
    ok('queue telemetry counts only blank-probe_sent + VALID-email eligible rows');

    const probeSentIdx = AGENCIES_HEADER.indexOf('probe_sent');
    for (const id of ['ag_q_noemail', 'ag_q_risky']) {
      const untouched = store.AGENCIES.find((r) => r[0] === id);
      assert.equal(untouched[probeSentIdx], '');
    }
    ok('email-less and RISKY rows are ignored without touching probe_sent');

    const advanced = mockRes();
    await handler(mockReq({ method: 'GET', query: { next_after: 'ag_q_first' } }), advanced);
    assert.equal(advanced.body.agency.agency_id, 'ag_q_second');
    ok('auto-advance uses the same VALID-email rule');

    const skipped = mockRes();
    await handler(mockReq({ body: { action: 'skip-agency', agency_id: 'ag_q_second', reason: 'Unsuitable agency' } }), skipped);
    assert.equal(skipped.statusCode, 200, skipped.body?.error);
    assert.equal(skipped.body.next_agency_id, 'ag_q_third');
    assert.equal(skipped.body.reason, 'Unsuitable agency');
    ok('Skip Agency advances by the same VALID-email rule');

    const { store: bare, valuesApi: bareApi } = makeFakeSheet({ agenciesHeader: AGENCIES_HEADER.filter((h) => h !== 'probe_sent') });
    bare.AGENCIES.push(AGENCIES_HEADER.filter((h) => h !== 'probe_sent').map((k) => ({
      agency_id: 'ag_bare', agency_name: 'No Column', rightmove_sales_branch_url: ANDREW_GRANGER_RM,
      outreach_contact_email: EMAIL, email_verification_status: 'VALID',
    }[k] ?? '')));
    __setRepoForTests(createRepo(bareApi));
    const bareRes = mockRes();
    await handler(mockReq({ method: 'GET', query: { next: '1' } }), bareRes);
    assert.equal(bareRes.statusCode, 409);
    assert.match(bareRes.body.error, /no probe_sent column/);
    ok('a sheet with no probe_sent column fails loudly instead of re-serving probed agencies');

    __setRepoForTests(null);
  }

  console.log(`\n✅ All ${passed} checks passed.\n`);
}

run().catch((err) => { console.error('\n❌ SELFTEST FAILED:\n', err); process.exit(1); });