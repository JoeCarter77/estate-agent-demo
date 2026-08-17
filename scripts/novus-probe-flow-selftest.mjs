// scripts/novus-probe-flow-selftest.mjs — hermetic end-to-end test of the
// AGENCY → PROBE → COMMUNICATION → INTELLIGENCE → ACTION chain, plus the
// Rightmove URL/migration rules.
//
// No network, no credentials, no real outreach. Everything runs against an
// in-memory fake of the Google Sheets values API seeded with the LIVE
// workbook's confirmed headers (read from NOVUS_Data_V1_Master_v2 on
// 2026-08-17), so a column that doesn't exist in production doesn't exist here.
//
// Run:  npm run novus:probe-flow-selftest

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { __setListingMetaFetcherForTests, parseTitleFacts } from '../lib/rightmove-meta.mjs';
import {
  classifyRightmoveUrl, URL_KIND, RIGHTMOVE_STATUS, normalizeRightmoveStatus,
  agencyProfileUrlOrEmpty,
} from '../lib/rightmove-urls.mjs';
import { migrateRightmove, resolveRow, mapSourceHeaders, RIGHTMOVE_COLUMNS } from '../lib/rightmove-migrate.mjs';
import { nextProbeReference } from '../lib/ids.mjs';
import { parseCsv } from './novus-rightmove-migrate.mjs';

// ── LIVE headers, verbatim ────────────────────────────────────────────────────
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
const INTELLIGENCE_HEADER = [
  'intelligence_id','agency_id','probe_id','observation_status','observation_deadline',
  'auto_acknowledgement','auto_ack_timestamp','crm_detected','crm_name','crm_evidence',
  'first_human_touch','first_human_touch_at','human_lag_hours','callback_attempts',
  'successful_conversations','voicemail_count','inbound_sms_count','email_touch_count',
  'follow_up_count','follow_up_channels','last_touch_at','days_chased','booking_attempt',
  'contact_quality','proactive_reactive','persistence_profile','channels_used','grade',
  'grade_reason','tier','tier_reason','sales_angle','segment','ai_evidence_summary','ai_confidence',
  'manual_override','override_reason','observation_closed_at','created_at','updated_at',
  'contact_attempt_count','observed_problem','commercial_implication','discovery_focus','demo_type',
  'email_strategy','phone_strategy','next_action',
];
const ACTIONS_HEADER = [
  'action_id','agency_id','probe_id','action_type','action_status','priority','due_at',
  'completed_at','owner','trigger','reason','related_communication_id','notes','created_at','updated_at',
];
const RAW_EVENTS_HEADER = [
  'raw_event_id','provider','provider_event_id','channel','event_type','received_at','occurred_at',
  'source_identifier','destination_identifier','payload_reference','processing_status',
  'processed_communication_id','error_message','created_at',
];

// ── In-memory fake of the Sheets values API ───────────────────────────────────
function makeFakeSheet({ withNewColumns = false } = {}) {
  const store = {
    AGENCIES: [withNewColumns ? [...AGENCIES_HEADER, ...RIGHTMOVE_COLUMNS] : AGENCIES_HEADER.slice()],
    PROBES: [withNewColumns ? [...PROBES_HEADER, 'property_type', 'property_bedrooms', 'property_id'] : PROBES_HEADER.slice()],
    COMMUNICATIONS: [COMMUNICATIONS_HEADER.slice()],
    INTELLIGENCE: [INTELLIGENCE_HEADER.slice()],
    ACTIONS: [ACTIONS_HEADER.slice()],
    RAW_EVENTS: [RAW_EVENTS_HEADER.slice()],
  };
  const tabOf = (r) => String(r).split('!')[0];
  const startRowOf = (r) => { const m = String(r).match(/!\D+(\d+)/); return m ? parseInt(m[1], 10) : null; };
  const valuesApi = {
    async get(range) { return (store[tabOf(range)] || []).map((r) => r.slice()); },
    async append(range, rows) {
      const t = tabOf(range); store[t] = store[t] || [];
      for (const r of rows) store[t].push(r.slice());
      return { updates: { updatedRows: rows.length } };
    },
    async update(range, rows) {
      const t = tabOf(range); const start = startRowOf(range); store[t] = store[t] || [];
      rows.forEach((r, i) => { store[t][start - 1 + i] = r.slice(); });
      return { updatedRows: rows.length };
    },
  };
  return { store, valuesApi };
}

function seedAgency(store, fields) {
  const header = store.AGENCIES[0];
  store.AGENCIES.push(header.map((k) => fields[k] ?? ''));
}
function rowsOf(store, tab) {
  const header = store[tab][0];
  return store[tab].slice(1)
    .map((r) => Object.fromEntries(header.map((k, i) => [k, r[i] ?? ''])))
    .filter((o) => Object.values(o).some((v) => v !== ''));
}

// ── req/res doubles (same shape the other NOVUS self-tests use) ───────────────
const AUTH_USER = 'novus-test';
const AUTH_PASS = 'novus-test-pass';
const BASIC = 'Basic ' + Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64');
const INGEST_SECRET = 'test-ingest-secret';

function mockReq({ method = 'POST', body = {}, query = {}, headers = {} } = {}) {
  return {
    method, body, query,
    headers: { 'content-type': 'application/json', authorization: BASIC, ...headers },
  };
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
let failed = 0;
const ok = (m) => { passed += 1; console.log('  ✓ ' + m); };
const bad = (m, e) => { failed += 1; console.log('  ✗ ' + m + '\n      ' + (e?.message || e)); };
async function test(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }

// Synthetic agency + property. Nothing here is real; the domain is example.com
// and the property id is not a live Rightmove listing.
const TEST_AGENCY_ID = 'ag_selftest_fisks';
const TEST_AGENCY_DOMAIN = 'selftest-agency.example.com';
const TEST_PROPERTY_URL = 'https://www.rightmove.co.uk/properties/999000111';
const TEST_AGENCY_PROFILE_URL = 'https://www.rightmove.co.uk/estate-agents/agent/Selftest-Agency/Rayleigh-12345.html';

async function run() {
  process.env.NOVUS_BASIC_AUTH_USER = AUTH_USER;
  process.env.NOVUS_BASIC_AUTH_PASS = AUTH_PASS;
  process.env.NOVUS_INGEST_SECRET = INGEST_SECRET;
  process.env.NOVUS_PROBE_EMAIL = 'novusprobes@gmail.com';
  process.env.NOVUS_PROBE_PHONE = '+447575333064';

  // Hermetic enrichment: no network. Mirrors a real Rightmove og:title.
  __setListingMetaFetcherForTests(async (url) => {
    if (url !== TEST_PROPERTY_URL) return { address: '', price: '', status: '', property_type: '', bedrooms: '', title: '' };
    const title = '3 bedroom semi-detached house for sale in Test Road, Rayleigh, SS6 7AA';
    return {
      address: 'Test Road, Rayleigh, SS6 7AA',
      price: '£450,000',
      status: 'for_sale',
      property_type: 'semi-detached house',
      bedrooms: '3',
      title,
    };
  });

  const probeCreate = (await import('../api/novus/probe-create.js')).default;
  const probeGet = (await import('../api/novus/probe-get.js')).default;
  const probeMarkSent = (await import('../api/novus/probe-mark-sent.js')).default;
  const agencies = (await import('../api/novus/agencies.js')).default;
  const actionCreate = (await import('../api/novus/action-create.js')).default;
  const emailInbound = (await import('../api/novus/webhooks/email-inbound.js')).default;
  const ensureSchema = (await import('../api/novus/admin/ensure-schema.js')).default;

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[1] Rightmove URL classification (Part 4)');
  // ══════════════════════════════════════════════════════════════════════════
  await test('agency profile /estate-agents/agent/... is an AGENCY_PROFILE', () => {
    assert.equal(classifyRightmoveUrl(TEST_AGENCY_PROFILE_URL).kind, URL_KIND.AGENCY_PROFILE);
  });
  await test('agency profile /estate-agents/profile/... is an AGENCY_PROFILE', () => {
    assert.equal(
      classifyRightmoveUrl('https://www.rightmove.co.uk/estate-agents/profile/fisks-ltd/rayleigh').kind,
      URL_KIND.AGENCY_PROFILE,
    );
  });
  await test('individual property /properties/<id> is a PROPERTY', () => {
    const c = classifyRightmoveUrl('https://www.rightmove.co.uk/properties/173617499#/?channel=RES_BUY');
    assert.equal(c.kind, URL_KIND.PROPERTY);
    assert.equal(c.property_id, '173617499');
    assert.equal(c.normalized, 'https://www.rightmove.co.uk/properties/173617499');
  });
  await test('legacy /property-for-sale/property-<id>.html is a PROPERTY', () => {
    assert.equal(
      classifyRightmoveUrl('https://www.rightmove.co.uk/property-for-sale/property-173617499.html').kind,
      URL_KIND.PROPERTY,
    );
  });
  await test('area search /property-for-sale/Rayleigh.html is REJECTED', () => {
    const c = classifyRightmoveUrl('https://www.rightmove.co.uk/property-for-sale/Rayleigh.html');
    assert.equal(c.kind, URL_KIND.PROPERTY_SEARCH);
    assert.equal(c.normalized, '', 'a search URL must never yield a storable value');
  });
  await test('agent search /estate-agents/find.html?... is REJECTED', () => {
    assert.equal(
      classifyRightmoveUrl('https://www.rightmove.co.uk/estate-agents/find.html?searchLocation=Billericay').kind,
      URL_KIND.AGENT_SEARCH,
    );
  });
  await test('agent area index /estate-agents/Essex.html is REJECTED', () => {
    assert.equal(classifyRightmoveUrl('https://www.rightmove.co.uk/estate-agents/Essex.html').kind, URL_KIND.AGENT_SEARCH);
  });
  await test('non-Rightmove host is REJECTED', () => {
    assert.equal(classifyRightmoveUrl('https://www.zoopla.co.uk/for-sale/details/123').kind, URL_KIND.NOT_RIGHTMOVE);
  });
  await test('agencyProfileUrlOrEmpty() returns "" for every generic form', () => {
    for (const u of [
      'https://www.rightmove.co.uk/property-for-sale/Billericay.html',
      'https://www.rightmove.co.uk/estate-agents/find.html?x=1',
      'https://www.rightmove.co.uk/properties/173617499',
      'https://www.rightmove.co.uk/estate-agents/UK.html',
      '', 'not a url',
    ]) assert.equal(agencyProfileUrlOrEmpty(u), '', `should reject: ${u}`);
    assert.equal(agencyProfileUrlOrEmpty(TEST_AGENCY_PROFILE_URL), TEST_AGENCY_PROFILE_URL);
  });

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[2] Rightmove research migration (Part 1)');
  // ══════════════════════════════════════════════════════════════════════════
  await test('status vocabulary normalises the research wording', () => {
    assert.equal(normalizeRightmoveStatus('Confirmed'), RIGHTMOVE_STATUS.CONFIRMED);
    assert.equal(normalizeRightmoveStatus('candidate'), RIGHTMOVE_STATUS.CANDIDATE);
    assert.equal(normalizeRightmoveStatus('unresolved'), RIGHTMOVE_STATUS.UNRESOLVED);
    assert.equal(normalizeRightmoveStatus('lettings only (no sales)'), RIGHTMOVE_STATUS.NOT_APPLICABLE);
    assert.equal(normalizeRightmoveStatus('DO NOT OUTREACH'), RIGHTMOVE_STATUS.NOT_APPLICABLE);
    assert.equal(normalizeRightmoveStatus(''), '', 'empty must stay empty, never invented');
    assert.equal(normalizeRightmoveStatus('some wording we have never seen'), RIGHTMOVE_STATUS.CANDIDATE,
      'unknown wording must never promote to confirmed');
  });

  await test('"confirmed" + generic URL is DOWNGRADED and the URL is not stored', () => {
    const r = resolveRow({
      agency_id: 'ag_x',
      rightmove_sales_branch_url: 'https://www.rightmove.co.uk/property-for-sale/Rayleigh.html',
      rightmove_status: 'confirmed',
    }, { sales_led_lettings_only: '' });
    assert.equal(r.patch.rightmove_sales_branch_url, undefined, 'generic URL must not be written');
    assert.equal(r.patch.rightmove_status, RIGHTMOVE_STATUS.CANDIDATE);
    assert.ok(r.downgraded, 'must record the downgrade');
    assert.match(r.patch.rightmove_notes, /Rejected URL/);
  });

  await test('"confirmed" + genuine profile URL stays confirmed and IS stored', () => {
    const r = resolveRow({
      agency_id: 'ag_x',
      rightmove_sales_branch_url: TEST_AGENCY_PROFILE_URL,
      rightmove_status: 'confirmed',
    }, { sales_led_lettings_only: '' });
    assert.equal(r.patch.rightmove_sales_branch_url, TEST_AGENCY_PROFILE_URL);
    assert.equal(r.patch.rightmove_status, RIGHTMOVE_STATUS.CONFIRMED);
    assert.equal(r.downgraded, null);
  });

  await test('lettings-only reuses the EXISTING sales_led_lettings_only column', () => {
    const r = resolveRow({ agency_id: 'ag_x', rightmove_status: 'lettings only' }, { sales_led_lettings_only: '' });
    assert.equal(r.patch.sales_led_lettings_only, 'lettings_only');
  });
  await test('lettings-only never OVERWRITES an existing sales_led_lettings_only value', () => {
    const r = resolveRow({ agency_id: 'ag_x', rightmove_status: 'lettings only' }, { sales_led_lettings_only: 'sales_led' });
    assert.equal(r.patch.sales_led_lettings_only, undefined);
  });

  await test('header aliasing accepts the research workbook\'s own column names', () => {
    const { map, missing } = mapSourceHeaders(['agency_id', 'Rightmove URL', 'Rightmove Status', 'Notes']);
    assert.deepEqual(missing, []);
    assert.equal(map.rightmove_sales_branch_url, 'Rightmove URL');
    assert.equal(map.rightmove_status, 'Rightmove Status');
  });
  await test('a source file with no agency_id column is REFUSED', () => {
    const { missing } = mapSourceHeaders(['agency_name', 'Rightmove URL']);
    assert.ok(missing.includes('agency_id'));
  });

  // Full migration against a fake live AGENCIES table.
  const migrationFake = makeFakeSheet();
  seedAgency(migrationFake.store, { agency_id: 'ag_a', agency_name: 'Confirmed Agency', domain: 'a.example.com', notes: 'PRESERVE ME' });
  seedAgency(migrationFake.store, { agency_id: 'ag_b', agency_name: 'Generic URL Agency', domain: 'b.example.com' });
  seedAgency(migrationFake.store, { agency_id: 'ag_c', agency_name: 'Lettings Only Agency', domain: 'c.example.com' });
  seedAgency(migrationFake.store, { agency_id: 'ag_d', agency_name: 'Unresolved Agency', domain: 'd.example.com' });
  const migrationRepo = createRepo(migrationFake.valuesApi);

  const sourceRows = [
    { agency_id: 'ag_a', rightmove_sales_branch_url: TEST_AGENCY_PROFILE_URL, rightmove_status: 'confirmed', rightmove_checked_at: '2026-08-16', rightmove_notes: 'Verified sales branch.' },
    { agency_id: 'ag_b', rightmove_sales_branch_url: 'https://www.rightmove.co.uk/property-for-sale/Rayleigh.html', rightmove_status: 'confirmed', rightmove_checked_at: '2026-08-16' },
    { agency_id: 'ag_c', rightmove_sales_branch_url: '', rightmove_status: 'lettings only', rightmove_checked_at: '2026-08-16' },
    { agency_id: 'ag_d', rightmove_sales_branch_url: '', rightmove_status: 'unresolved', rightmove_checked_at: '2026-08-16' },
    { agency_id: 'ag_ghost', rightmove_sales_branch_url: TEST_AGENCY_PROFILE_URL, rightmove_status: 'confirmed' },
    { agency_id: '', rightmove_status: 'confirmed' },
    { agency_id: 'ag_a', rightmove_status: 'confirmed' }, // duplicate in source
  ];

  let migrationReport;
  await test('dry run performs ZERO writes', async () => {
    const before = JSON.stringify(migrationFake.store.AGENCIES);
    const rep = await migrateRightmove(migrationRepo, sourceRows, { dryRun: true });
    assert.equal(JSON.stringify(migrationFake.store.AGENCIES), before, 'dry run must not mutate the sheet');
    assert.deepEqual(rep.columns_added, RIGHTMOVE_COLUMNS, 'dry run reports the columns it would add');
    assert.equal(rep.matched, 4);
  });

  await test('apply run merges and reports accurately', async () => {
    migrationReport = await migrateRightmove(migrationRepo, sourceRows, { dryRun: false });
    assert.deepEqual(migrationReport.columns_added, RIGHTMOVE_COLUMNS);
    assert.equal(migrationReport.matched, 4, 'four of the source ids exist live');
    assert.deepEqual(migrationReport.unmatched_agency_ids, ['ag_ghost']);
    assert.equal(migrationReport.source_rows_without_agency_id, 1);
    assert.deepEqual(migrationReport.duplicate_source_agency_ids, ['ag_a']);
    assert.equal(migrationReport.urls_migrated, 1, 'only the genuine profile URL migrates');
    assert.equal(migrationReport.urls_rejected, 1);
    assert.equal(migrationReport.status_counts.confirmed, 1);
    assert.equal(migrationReport.status_counts.candidate, 1, 'the downgraded row');
    assert.equal(migrationReport.status_counts.not_applicable, 1);
    assert.equal(migrationReport.status_counts.unresolved, 1);
    assert.equal(migrationReport.errors.length, 0);
  });

  await test('unrelated live agency data is PRESERVED', () => {
    const a = rowsOf(migrationFake.store, 'AGENCIES').find((r) => r.agency_id === 'ag_a');
    assert.equal(a.notes, 'PRESERVE ME');
    assert.equal(a.agency_name, 'Confirmed Agency');
    assert.equal(a.domain, 'a.example.com');
    assert.equal(a.rightmove_sales_branch_url, TEST_AGENCY_PROFILE_URL);
    assert.equal(a.rightmove_status, 'confirmed');
  });

  await test('the generic-URL agency has NO rightmove URL stored', () => {
    const b = rowsOf(migrationFake.store, 'AGENCIES').find((r) => r.agency_id === 'ag_b');
    assert.equal(b.rightmove_sales_branch_url, '');
    assert.equal(b.rightmove_status, 'candidate');
    assert.match(b.rightmove_notes, /Rejected URL/);
  });

  await test('migration is IDEMPOTENT — a second apply writes nothing', async () => {
    const before = JSON.stringify(migrationFake.store.AGENCIES);
    const rep2 = await migrateRightmove(migrationRepo, sourceRows, { dryRun: false });
    assert.equal(rep2.rows_written, 0, 'no row should change on re-run');
    assert.equal(rep2.rows_unchanged, 4);
    assert.equal(JSON.stringify(migrationFake.store.AGENCIES), before);
  });

  await test('existing agency columns are neither reordered nor removed', () => {
    const header = migrationFake.store.AGENCIES[0];
    assert.deepEqual(header.slice(0, AGENCIES_HEADER.length), AGENCIES_HEADER);
  });

  await test('CSV parser handles quotes, commas and embedded newlines', () => {
    const { headers, rows } = parseCsv('agency_id,rightmove_notes\nag_1,"Says ""confirmed"", but\nsee note"\n');
    assert.deepEqual(headers, ['agency_id', 'rightmove_notes']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].rightmove_notes, 'Says "confirmed", but\nsee note');
  });

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[3] Schema migration is additive and backwards-compatible (Part 8)');
  // ══════════════════════════════════════════════════════════════════════════
  await test('ensure-schema dry run reports without writing', async () => {
    const fake = makeFakeSheet();
    __setRepoForTests(createRepo(fake.valuesApi));
    const before = JSON.stringify(fake.store);
    const res = mockRes();
    await ensureSchema(mockReq({ body: { dry_run: true } }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.tabs.AGENCIES.would_add, RIGHTMOVE_COLUMNS);
    assert.deepEqual(res.body.tabs.PROBES.would_add, ['property_type', 'property_bedrooms', 'property_id']);
    assert.equal(res.body.tabs.INTELLIGENCE, undefined, 'INTELLIGENCE needs no new columns');
    assert.equal(JSON.stringify(fake.store), before);
  });

  await test('ensure-schema apply adds columns and preserves every existing row', async () => {
    const fake = makeFakeSheet();
    seedAgency(fake.store, { agency_id: 'ag_keep', agency_name: 'Keep Me', notes: 'DO NOT LOSE' });
    __setRepoForTests(createRepo(fake.valuesApi));
    const res = mockRes();
    await ensureSchema(mockReq({ body: { dry_run: false } }), res);
    assert.equal(res.statusCode, 200);
    const kept = rowsOf(fake.store, 'AGENCIES').find((r) => r.agency_id === 'ag_keep');
    assert.equal(kept.notes, 'DO NOT LOSE');
    assert.equal(kept.rightmove_status, '', 'new column present and empty');
    // Re-run is a no-op.
    const res2 = mockRes();
    await ensureSchema(mockReq({ body: { dry_run: false } }), res2);
    assert.deepEqual(res2.body.tabs.AGENCIES.added, []);
  });

  await test('a probe can still be created BEFORE the new columns exist', async () => {
    const fake = makeFakeSheet(); // old headers only
    seedAgency(fake.store, { agency_id: TEST_AGENCY_ID, agency_name: 'Selftest Agency', domain: TEST_AGENCY_DOMAIN });
    __setRepoForTests(createRepo(fake.valuesApi));
    const res = mockRes();
    await probeCreate(mockReq({ body: { agency_id: TEST_AGENCY_ID, url: TEST_PROPERTY_URL } }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.probe.agency_id, TEST_AGENCY_ID);
    const stored = rowsOf(fake.store, 'PROBES')[0];
    assert.equal(stored.property_url, TEST_PROPERTY_URL);
    assert.equal(stored.property_type, undefined, 'column absent → key silently dropped, no crash');
  });

  await test('probe_reference derives from existing references, not a row count', () => {
    // Live PROBES holds HIST-0001..0024 and TEST-0001..2 — a count would mint RM-0027.
    const refs = [...Array(24)].map((_, i) => `HIST-${String(i + 1).padStart(4, '0')}`).concat(['TEST-0001', 'TEST-0002']);
    assert.equal(nextProbeReference(refs, 'rightmove'), 'RM-0001');
    assert.equal(nextProbeReference([...refs, 'RM-0001'], 'rightmove'), 'RM-0002');
    assert.equal(nextProbeReference([...refs, 'RM-0009', 'RM-0010'], 'rightmove'), 'RM-0011');
  });

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[4] Property enrichment (Part 3 step 8, Part 5)');
  // ══════════════════════════════════════════════════════════════════════════
  await test('og:title yields bedrooms + property_type', () => {
    assert.deepEqual(
      parseTitleFacts('3 bedroom semi-detached house for sale in Test Road, Rayleigh, SS6 7AA'),
      { bedrooms: '3', property_type: 'semi-detached house' },
    );
    assert.deepEqual(
      parseTitleFacts('2 bedroom apartment for sale in High Street, Billericay'),
      { bedrooms: '2', property_type: 'apartment' },
    );
  });
  await test('a title with no bedroom count does not invent one', () => {
    assert.deepEqual(parseTitleFacts('Land for sale in Rayleigh'), { bedrooms: '', property_type: 'Land' });
  });
  await test('unparseable title yields empty facts, never a guess', () => {
    assert.deepEqual(parseTitleFacts(''), { bedrooms: '', property_type: '' });
  });

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[5] Probe creation carries agency context (Part 3, Part 6)');
  // ══════════════════════════════════════════════════════════════════════════

  // One shared fake for the full lifecycle test below.
  const fake = makeFakeSheet({ withNewColumns: true });
  seedAgency(fake.store, {
    agency_id: TEST_AGENCY_ID,
    agency_name: 'NOVUS SELFTEST AGENCY — DO NOT OUTREACH',
    domain: TEST_AGENCY_DOMAIN,
    primary_contact_email: `sales@${TEST_AGENCY_DOMAIN}`,
    location: 'Rayleigh',
    rightmove_sales_branch_url: TEST_AGENCY_PROFILE_URL,
    rightmove_status: 'confirmed',
  });
  seedAgency(fake.store, {
    agency_id: 'ag_selftest_suppressed',
    agency_name: 'Suppressed Agency',
    domain: 'suppressed.example.com',
    suppression_status: 'suppressed',
    suppression_reason: 'test fixture',
  });
  seedAgency(fake.store, {
    agency_id: 'ag_selftest_lettings',
    agency_name: 'Lettings Only Agency',
    domain: 'lettings.example.com',
    rightmove_status: 'not_applicable',
  });
  __setRepoForTests(createRepo(fake.valuesApi));

  await test('probe-create REFUSES a probe with no agency_id', async () => {
    const res = mockRes();
    await probeCreate(mockReq({ body: { url: TEST_PROPERTY_URL } }), res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /agency_id/);
  });

  await test('probe-create REFUSES an agency_id that is not in AGENCIES', async () => {
    const res = mockRes();
    await probeCreate(mockReq({ body: { agency_id: 'ag_does_not_exist', url: TEST_PROPERTY_URL } }), res);
    assert.equal(res.statusCode, 404);
  });

  await test('probe-create REFUSES a suppressed agency', async () => {
    const res = mockRes();
    await probeCreate(mockReq({ body: { agency_id: 'ag_selftest_suppressed', url: TEST_PROPERTY_URL } }), res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.suppressed, true);
  });

  await test('probe-create REFUSES an agency-profile URL as the property URL', async () => {
    const res = mockRes();
    await probeCreate(mockReq({ body: { agency_id: TEST_AGENCY_ID, url: TEST_AGENCY_PROFILE_URL } }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.url_kind, URL_KIND.AGENCY_PROFILE);
  });

  await test('probe-create REFUSES a generic area-search URL as the property URL', async () => {
    const res = mockRes();
    await probeCreate(mockReq({
      body: { agency_id: TEST_AGENCY_ID, url: 'https://www.rightmove.co.uk/property-for-sale/Rayleigh.html' },
    }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.url_kind, URL_KIND.PROPERTY_SEARCH);
    assert.equal(rowsOf(fake.store, 'PROBES').length, 0, 'nothing may be written on a rejected URL');
  });

  let probe;
  await test('probe-create stores agency_id, property_url and enrichment', async () => {
    const res = mockRes();
    await probeCreate(mockReq({ body: { agency_id: TEST_AGENCY_ID, url: TEST_PROPERTY_URL } }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    probe = res.body.probe;
    assert.equal(probe.agency_id, TEST_AGENCY_ID, 'agency_id carried automatically');
    assert.equal(probe.property_url, TEST_PROPERTY_URL);
    assert.equal(probe.probe_status, 'draft');
    assert.equal(probe.probe_reference, 'RM-0001');
    assert.equal(probe.property_address, 'Test Road, Rayleigh, SS6 7AA');
    assert.equal(probe.property_price, '£450,000');
    assert.equal(probe.property_type, 'semi-detached house');
    assert.equal(probe.property_bedrooms, '3');
    assert.equal(probe.property_id, '999000111');
    assert.equal(res.body.agency.agency_name, 'NOVUS SELFTEST AGENCY — DO NOT OUTREACH');
    // And it is genuinely persisted with the agency link.
    const stored = rowsOf(fake.store, 'PROBES').find((r) => r.probe_id === probe.probe_id);
    assert.equal(stored.agency_id, TEST_AGENCY_ID);
    assert.equal(stored.property_bedrooms, '3');
  });

  await test('double-submit does NOT create a second probe (race guard)', async () => {
    const [r1, r2] = [mockRes(), mockRes()];
    await Promise.all([
      probeCreate(mockReq({ body: { agency_id: TEST_AGENCY_ID, url: TEST_PROPERTY_URL } }), r1),
      probeCreate(mockReq({ body: { agency_id: TEST_AGENCY_ID, url: TEST_PROPERTY_URL } }), r2),
    ]);
    assert.equal(r1.body.probe.probe_id, probe.probe_id);
    assert.equal(r2.body.probe.probe_id, probe.probe_id);
    assert.equal(r1.body.deduplicated, true);
    assert.equal(rowsOf(fake.store, 'PROBES').length, 1, 'still exactly one probe row');
  });

  await test('a tracking-decorated property URL dedupes to the same probe', async () => {
    const res = mockRes();
    await probeCreate(mockReq({
      body: { agency_id: TEST_AGENCY_ID, url: `${TEST_PROPERTY_URL}#/?channel=RES_BUY&utm_source=email` },
    }), res);
    assert.equal(res.body.probe.probe_id, probe.probe_id, 'URL normalisation makes dedupe work');
    assert.equal(rowsOf(fake.store, 'PROBES').length, 1);
  });

  await test('probe-get rehydrates the probe (deep-link reload path)', async () => {
    const res = mockRes();
    await probeGet(mockReq({ method: 'GET', query: { probe_id: probe.probe_id } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.probe.agency_id, TEST_AGENCY_ID);
    assert.equal(res.body.probe.property_url, TEST_PROPERTY_URL);
  });

  await test('agencies endpoint resolves an agency_id for the deep link', async () => {
    const res = mockRes();
    await agencies(mockReq({ method: 'GET', query: { agency_id: TEST_AGENCY_ID } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.agency.agency_name, 'NOVUS SELFTEST AGENCY — DO NOT OUTREACH');
    assert.equal(res.body.agency.rightmove_sales_branch_url, TEST_AGENCY_PROFILE_URL);
    assert.equal(res.body.probeable, true);
  });

  await test('agencies picker search finds an agency by name', async () => {
    const res = mockRes();
    await agencies(mockReq({ method: 'GET', query: { q: 'selftest' } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.agencies.length, 1);
    assert.equal(res.body.agencies[0].agency_id, TEST_AGENCY_ID);
  });

  await test('probeable=1 excludes suppressed and lettings-only agencies', async () => {
    const res = mockRes();
    await agencies(mockReq({ method: 'GET', query: { probeable: '1' } }), res);
    const ids = res.body.agencies.map((a) => a.agency_id);
    assert.ok(ids.includes(TEST_AGENCY_ID));
    assert.ok(!ids.includes('ag_selftest_suppressed'), 'suppressed must be excluded');
    assert.ok(!ids.includes('ag_selftest_lettings'), 'lettings-only must be excluded');
  });

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[6] Mark as sent opens the observation window');
  // ══════════════════════════════════════════════════════════════════════════
  await test('mark-sent sets observing + timestamps and keeps the agency link', async () => {
    const res = mockRes();
    await probeMarkSent(mockReq({ body: { probe_id: probe.probe_id } }), res);
    assert.equal(res.statusCode, 200);
    probe = res.body.probe;
    assert.equal(probe.probe_status, 'observing');
    assert.ok(probe.probe_timestamp);
    assert.ok(probe.observation_deadline);
    assert.equal(probe.agency_id, TEST_AGENCY_ID, 'agency context survives the update');
    assert.equal(probe.property_bedrooms, '3', 'enrichment survives the update');
  });

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[7] Synthetic reply → COMMUNICATION → INTELLIGENCE (Part 7)');
  // ══════════════════════════════════════════════════════════════════════════
  let communicationId;
  await test('a synthetic inbound reply matches the correct agency AND probe', async () => {
    const res = mockRes();
    await emailInbound(mockReq({
      headers: { 'x-novus-ingest-secret': INGEST_SECRET },
      body: {
        provider: 'gmail',
        provider_event_id: 'selftest-reply-0001',
        event_type: 'message.received',
        from: `sales@${TEST_AGENCY_DOMAIN}`,
        to: 'novusprobes@gmail.com',
        subject: 'RE: Test Road, Rayleigh — happy to help',
        body_text: 'Hi Joe, thanks for your enquiry. Can I call you tomorrow to arrange a viewing and talk about your own property?',
        occurred_at: new Date().toISOString(),
      },
    }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.match_status, 'matched', 'THE critical assertion — this was "unmatched" before the fix');
    assert.equal(res.body.agency_id, TEST_AGENCY_ID);
    assert.equal(res.body.probe_id, probe.probe_id, 'reply attributed to the right probe');
    communicationId = res.body.communication_id;
  });

  await test('the COMMUNICATION row carries both agency_id and probe_id', () => {
    const comm = rowsOf(fake.store, 'COMMUNICATIONS').find((c) => c.communication_id === communicationId);
    assert.ok(comm, 'communication row written');
    assert.equal(comm.agency_id, TEST_AGENCY_ID);
    assert.equal(comm.probe_id, probe.probe_id);
    assert.equal(comm.match_status, 'matched');
    // The synthetic sender IS the agency's primary_contact_email, so the
    // strongest deterministic signal wins: email_exact ahead of domain_exact.
    assert.equal(comm.matching_method, 'email_exact');
  });

  await test('RAW_EVENTS retains the immutable evidence, linked to the communication', () => {
    const raw = rowsOf(fake.store, 'RAW_EVENTS').find((r) => r.provider_event_id === 'selftest-reply-0001');
    assert.ok(raw);
    assert.equal(raw.processing_status, 'processed');
    assert.equal(raw.processed_communication_id, communicationId);
  });

  let intelligence;
  await test('INTELLIGENCE was auto-recomputed against the same probe', () => {
    const rows = rowsOf(fake.store, 'INTELLIGENCE');
    assert.equal(rows.length, 1, 'exactly one intelligence row per probe');
    intelligence = rows[0];
    assert.equal(intelligence.probe_id, probe.probe_id);
    assert.equal(intelligence.agency_id, TEST_AGENCY_ID, 'agency context reaches the intelligence layer');
    assert.ok(intelligence.grade, 'a grade was produced');
    assert.equal(intelligence.observation_status, 'observing');
  });

  await test('contact_attempt_count now persists (column added by ensure-schema)', () => {
    assert.notEqual(intelligence.contact_attempt_count, undefined);
  });

  await test('a second reply updates the SAME intelligence row (no duplicates)', async () => {
    const res = mockRes();
    await emailInbound(mockReq({
      headers: { 'x-novus-ingest-secret': INGEST_SECRET },
      body: {
        provider: 'gmail',
        provider_event_id: 'selftest-reply-0002',
        event_type: 'message.received',
        from: `sales@${TEST_AGENCY_DOMAIN}`,
        to: 'novusprobes@gmail.com',
        subject: 'RE: Test Road — following up',
        body_text: 'Just following up — are you free for a call?',
        occurred_at: new Date().toISOString(),
      },
    }), res);
    assert.equal(res.body.probe_id, probe.probe_id);
    const rows = rowsOf(fake.store, 'INTELLIGENCE');
    assert.equal(rows.length, 1, 'still one intelligence row, updated in place');
    assert.equal(rows[0].intelligence_id, intelligence.intelligence_id);
  });

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[8] ACTION closes the chain (Part 7)');
  // ══════════════════════════════════════════════════════════════════════════
  await test('action-create links the action to the same probe and agency', async () => {
    const res = mockRes();
    await actionCreate(mockReq({
      body: {
        probe_id: probe.probe_id,
        action_type: 'call_back',
        priority: 'high',
        trigger: 'intelligence_grade',
        reason: 'Synthetic self-test action.',
        related_communication_id: communicationId,
      },
    }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.action.agency_id, TEST_AGENCY_ID, 'agency derived from the probe, not the request');
    assert.equal(res.body.action.probe_id, probe.probe_id);
    assert.equal(res.body.action.action_status, 'open');
    assert.equal(res.body.chain.property_url, TEST_PROPERTY_URL);
  });

  await test('action-create rejects an unknown action_status', async () => {
    const res = mockRes();
    await actionCreate(mockReq({ body: { probe_id: probe.probe_id, action_type: 'x', action_status: 'nonsense' } }), res);
    assert.equal(res.statusCode, 400);
  });

  await test('action-create rejects a communication belonging to another probe', async () => {
    // Create a second probe + fabricate a mismatch.
    const res0 = mockRes();
    await probeCreate(mockReq({ body: { agency_id: TEST_AGENCY_ID, url: 'https://www.rightmove.co.uk/properties/999000222' } }), res0);
    const otherProbe = res0.body.probe;
    const res = mockRes();
    await actionCreate(mockReq({
      body: { probe_id: otherProbe.probe_id, action_type: 'call_back', related_communication_id: communicationId },
    }), res);
    assert.equal(res.statusCode, 409, 'must refuse cross-probe evidence');
  });

  await test('actions are listable by probe and by agency', async () => {
    const byProbe = mockRes();
    await actionCreate(mockReq({ method: 'GET', query: { probe_id: probe.probe_id } }), byProbe);
    assert.equal(byProbe.body.count, 1);
    const byAgency = mockRes();
    await actionCreate(mockReq({ method: 'GET', query: { agency_id: TEST_AGENCY_ID } }), byAgency);
    assert.equal(byAgency.body.count, 1);
  });

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[9] The full chain is traversable end to end');
  // ══════════════════════════════════════════════════════════════════════════
  await test('agency → probe → communication → intelligence → action all resolve', () => {
    const agency = rowsOf(fake.store, 'AGENCIES').find((a) => a.agency_id === TEST_AGENCY_ID);
    const p = rowsOf(fake.store, 'PROBES').find((r) => r.probe_id === probe.probe_id);
    const comm = rowsOf(fake.store, 'COMMUNICATIONS').find((c) => c.communication_id === communicationId);
    const itl = rowsOf(fake.store, 'INTELLIGENCE').find((r) => r.probe_id === probe.probe_id);
    const act = rowsOf(fake.store, 'ACTIONS').find((r) => r.probe_id === probe.probe_id);

    assert.ok(agency && p && comm && itl && act, 'every link exists');
    assert.equal(p.agency_id, agency.agency_id);
    assert.equal(comm.probe_id, p.probe_id);
    assert.equal(comm.agency_id, agency.agency_id);
    assert.equal(itl.probe_id, p.probe_id);
    assert.equal(itl.agency_id, agency.agency_id);
    assert.equal(act.probe_id, p.probe_id);
    assert.equal(act.agency_id, agency.agency_id);
    assert.equal(act.related_communication_id, comm.communication_id);
    // And the property is identified, distinctly from the agency's own URL.
    assert.equal(p.property_url, TEST_PROPERTY_URL);
    assert.equal(agency.rightmove_sales_branch_url, TEST_AGENCY_PROFILE_URL);
    assert.notEqual(p.property_url, agency.rightmove_sales_branch_url,
      'property URL and agency URL must never be the same value');
  });

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[10] Regression: the pre-fix failure mode is genuinely gone');
  // ══════════════════════════════════════════════════════════════════════════
  await test('a probe with a BLANK agency_id would be unmatchable (documents the old bug)', async () => {
    const f = makeFakeSheet({ withNewColumns: true });
    seedAgency(f.store, { agency_id: 'ag_blank_test', agency_name: 'Blank Test', domain: 'blank.example.com' });
    const repo = createRepo(f.valuesApi);
    __setRepoForTests(repo);
    // Hand-write the row the OLD probe-create would have produced.
    const now = new Date();
    await repo.appendRecord('PROBES', {
      probe_id: 'prb_old_style', probe_reference: 'RM-9999', agency_id: '', portal: 'rightmove',
      property_url: TEST_PROPERTY_URL, probe_status: 'observing',
      probe_timestamp: new Date(now.getTime() - 3600e3).toISOString(),
      observation_deadline: new Date(now.getTime() + 3 * 86400e3).toISOString(),
    });
    const { matchProbe } = await import('../lib/matching.mjs');
    const result = await matchProbe(repo, 'ag_blank_test', now);
    assert.equal(result.status, 'none', 'confirms a blank agency_id makes a probe permanently unreachable');
    assert.equal(result.probe_id, '');
  });

  await test('duplicate probe rows for one agency cause AMBIGUOUS matching (live-data warning)', async () => {
    const f = makeFakeSheet({ withNewColumns: true });
    seedAgency(f.store, { agency_id: 'ag_dup', agency_name: 'Dup', domain: 'dup.example.com' });
    const repo = createRepo(f.valuesApi);
    const now = new Date();
    const row = {
      probe_reference: 'RM-8000', agency_id: 'ag_dup', portal: 'rightmove',
      property_url: TEST_PROPERTY_URL, probe_status: 'observing',
      probe_timestamp: new Date(now.getTime() - 3600e3).toISOString(),
      observation_deadline: new Date(now.getTime() + 3 * 86400e3).toISOString(),
    };
    await repo.appendRecord('PROBES', { ...row, probe_id: 'prb_dup_a' });
    await repo.appendRecord('PROBES', { ...row, probe_id: 'prb_dup_b' });
    const { matchProbe } = await import('../lib/matching.mjs');
    const result = await matchProbe(repo, 'ag_dup', now);
    assert.equal(result.status, 'ambiguous',
      'two open probes for one agency cannot be told apart — see the report note on the duplicated live fixture rows');
  });

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`${'─'.repeat(70)}\n`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
