// scripts/novus-agency-merge-selftest.mjs — hermetic test of the agency-merge
// admin endpoint, including the new lib/sheets.mjs deleteRecordRow() capability
// (the first genuinely destructive write path in this codebase — see the
// comment on deleteRecordRow for why it's scoped the way it is).
//
// No network, no credentials, no real Sheets access.
//
// Run:  npm run novus:agency-merge-selftest

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { resolveAgencyMerge } from '../lib/agency-merge.mjs';

const AGENCIES_HEADER = [
  'agency_id', 'agency_name', 'website', 'domain', 'location', 'branch_count', 'main_phone',
  'known_phone_numbers', 'primary_contact_name', 'primary_contact_email', 'other_known_emails',
  'owner_md', 'independent_franchise_corporate', 'sales_led_lettings_only', 'years_trading',
  'incorporation_date', 'live_listing_count', 'crm_name', 'crm_evidence', 'qualification_segment',
  'current_pipeline_status', 'suppression_status', 'suppression_reason', 'notes', 'created_at', 'updated_at',
  'rightmove_sales_branch_url', 'rightmove_status', 'rightmove_checked_at', 'rightmove_notes',
];
const PROBES_HEADER = ['probe_id', 'probe_reference', 'agency_id', 'portal', 'property_url', 'probe_status', 'created_at', 'updated_at'];
const COMMUNICATIONS_HEADER = ['communication_id', 'agency_id', 'probe_id', 'channel', 'match_status', 'created_at', 'updated_at'];
const INTELLIGENCE_HEADER = ['intelligence_id', 'agency_id', 'probe_id', 'grade', 'created_at', 'updated_at'];
const ACTIONS_HEADER = ['action_id', 'agency_id', 'probe_id', 'action_type', 'action_status', 'created_at', 'updated_at'];

// Fake sheet that ALSO implements getSheetMeta/batchUpdate, so
// deleteRecordRow's full path (find current row -> resolve gridId -> delete)
// runs against real repo logic, not a stub of it.
function makeFakeSheet() {
  const store = {
    AGENCIES: [AGENCIES_HEADER.slice()],
    PROBES: [PROBES_HEADER.slice()],
    COMMUNICATIONS: [COMMUNICATIONS_HEADER.slice()],
    INTELLIGENCE: [INTELLIGENCE_HEADER.slice()],
    ACTIONS: [ACTIONS_HEADER.slice()],
  };
  const GRID_IDS = { AGENCIES: 100, PROBES: 200, COMMUNICATIONS: 300, INTELLIGENCE: 400, ACTIONS: 500 };
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
    async getSheetMeta() {
      return Object.entries(GRID_IDS).map(([title, sheetId]) => ({ title, sheetId }));
    },
    async batchUpdate(requests) {
      for (const r of requests) {
        const d = r.deleteDimension;
        if (!d || !d.range || d.range.dimension !== 'ROWS') throw new Error('fake batchUpdate only supports ROWS deleteDimension');
        const tab = Object.entries(GRID_IDS).find(([, id]) => id === d.range.sheetId)?.[0];
        if (!tab) throw new Error(`unknown sheetId ${d.range.sheetId}`);
        // startIndex/endIndex are 0-based, end-exclusive, matching the real API.
        store[tab].splice(d.range.startIndex, d.range.endIndex - d.range.startIndex);
      }
      return {};
    },
  };
  return { store, valuesApi };
}

function seedRow(store, tab, header, fields) {
  store[tab].push(header.map((k) => fields[k] ?? ''));
}
function rowsOf(store, tab, header) {
  return store[tab].slice(1)
    .map((r) => Object.fromEntries(header.map((k, i) => [k, r[i] ?? ''])))
    .filter((o) => Object.values(o).some((v) => v !== ''));
}

const AUTH_USER = 'novus-test', AUTH_PASS = 'novus-test-pass';
const BASIC = 'Basic ' + Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64');
function mockReq(body) { return { method: 'POST', body, query: {}, headers: { authorization: BASIC } }; }
function mockRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    end() { return this; },
    setHeader() {},
  };
}

let passed = 0, failed = 0;
const ok = (m) => { passed += 1; console.log('  ✓ ' + m); };
const bad = (m, e) => { failed += 1; console.log('  ✗ ' + m + '\n      ' + (e?.message || e)); };
async function test(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }

async function run() {
  process.env.NOVUS_BASIC_AUTH_USER = AUTH_USER;
  process.env.NOVUS_BASIC_AUTH_PASS = AUTH_PASS;

  const mergeHandler = (await import('../api/novus/_admin/agency-merge.js')).default;

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[1] resolveAgencyMerge() — pure decision logic');
  // ══════════════════════════════════════════════════════════════════════════
  await test('never touches agency_name or other single-value identity fields', () => {
    const retain = { agency_id: 'ag_r', agency_name: 'Keep This Exact Name', domain: 'r.example.com', primary_contact_email: 'r@r.example.com', notes: '' };
    const del = { agency_id: 'ag_d', agency_name: 'Delete Me Name', domain: 'd.example.com', primary_contact_email: 'd@d.example.com', notes: '' };
    const { patch } = resolveAgencyMerge(retain, del, { notesAddendum: 'merged' });
    assert.equal(patch.agency_name, undefined);
    assert.equal(patch.domain, undefined);
    assert.equal(patch.primary_contact_email, undefined);
  });

  await test('merges known_phone_numbers, deduplicated', () => {
    const retain = { agency_id: 'ag_r', main_phone: '01268 573035', known_phone_numbers: '01268 573035' };
    const del = { agency_id: 'ag_d', main_phone: '01268 733421', known_phone_numbers: '01268 733421, 01268 573035' };
    const { patch } = resolveAgencyMerge(retain, del, { notesAddendum: 'x' });
    assert.equal(patch.known_phone_numbers, '01268 573035, 01268 733421');
  });

  await test('preserves the deleted email via other_known_emails', () => {
    const retain = { agency_id: 'ag_r', primary_contact_email: 'shared@x.com', other_known_emails: '' };
    const del = { agency_id: 'ag_d', primary_contact_email: 'shared@x.com', other_known_emails: 'extra@d.com' };
    const { patch } = resolveAgencyMerge(retain, del, { notesAddendum: 'x' });
    assert.equal(patch.other_known_emails, 'extra@d.com');
  });

  await test('appends to existing notes rather than replacing them', () => {
    const retain = { agency_id: 'ag_r', notes: 'Pre-existing note.' };
    const del = { agency_id: 'ag_d' };
    const { patch } = resolveAgencyMerge(retain, del, { notesAddendum: 'Merge note.' });
    assert.equal(patch.notes, 'Pre-existing note.\nMerge note.');
  });

  await test('rightmove_* is inherited ONLY when the deleted row ranks higher', () => {
    const retainWorse = { agency_id: 'ag_r', rightmove_status: 'unresolved' };
    const delBetter = { agency_id: 'ag_d', rightmove_status: 'confirmed', rightmove_sales_branch_url: 'https://rightmove.co.uk/estate-agents/agent/X/Y-1.html', rightmove_checked_at: 'T', rightmove_notes: 'verified' };
    const r1 = resolveAgencyMerge(retainWorse, delBetter, { notesAddendum: 'x' });
    assert.equal(r1.patch.rightmove_status, 'confirmed');
    assert.ok(r1.warnings.some((w) => w.includes('Inherited rightmove_*')));

    const retainBetter = { agency_id: 'ag_r', rightmove_status: 'confirmed', rightmove_sales_branch_url: 'https://rightmove.co.uk/estate-agents/agent/KEEP/1.html' };
    const delWorse = { agency_id: 'ag_d', rightmove_status: 'unresolved' };
    const r2 = resolveAgencyMerge(retainBetter, delWorse, { notesAddendum: 'x' });
    assert.equal(r2.patch.rightmove_status, undefined, 'must not overwrite a higher-ranked retained value');
  });

  await test('warns about the domain_exact matching gap when domains differ', () => {
    const retain = { agency_id: 'ag_r', domain: 'r.example.com' };
    const del = { agency_id: 'ag_d', domain: 'd.example.com' };
    const { warnings } = resolveAgencyMerge(retain, del, { notesAddendum: 'x' });
    assert.ok(warnings.some((w) => w.includes('domain_exact')));
  });

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[2] deleteRecordRow() — the new physical-delete capability');
  // ══════════════════════════════════════════════════════════════════════════
  await test('deletes exactly the targeted row and shifts nothing else incorrectly', async () => {
    const { store, valuesApi } = makeFakeSheet();
    const repo = createRepo(valuesApi);
    seedRow(store, 'AGENCIES', AGENCIES_HEADER, { agency_id: 'ag_1', agency_name: 'One' });
    seedRow(store, 'AGENCIES', AGENCIES_HEADER, { agency_id: 'ag_2', agency_name: 'Two' });
    seedRow(store, 'AGENCIES', AGENCIES_HEADER, { agency_id: 'ag_3', agency_name: 'Three' });
    const deleted = await repo.deleteRecordRow('AGENCIES', 'agency_id', 'ag_2');
    assert.equal(deleted.agency_name, 'Two');
    const remaining = rowsOf(store, 'AGENCIES', AGENCIES_HEADER).map((r) => r.agency_id);
    assert.deepEqual(remaining, ['ag_1', 'ag_3']);
  });

  await test('returns null for an id that does not exist, deletes nothing', async () => {
    const { store, valuesApi } = makeFakeSheet();
    const repo = createRepo(valuesApi);
    seedRow(store, 'AGENCIES', AGENCIES_HEADER, { agency_id: 'ag_1', agency_name: 'One' });
    const before = JSON.stringify(store.AGENCIES);
    const deleted = await repo.deleteRecordRow('AGENCIES', 'agency_id', 'ag_missing');
    assert.equal(deleted, null);
    assert.equal(JSON.stringify(store.AGENCIES), before);
  });

  await test('a transport without batchUpdate/getSheetMeta refuses cleanly (never silently no-ops)', async () => {
    const repo = createRepo({
      async get() { return [AGENCIES_HEADER.slice(), ['ag_1', 'One']]; },
      async append() { return {}; },
      async update() { return {}; },
      // no getSheetMeta/batchUpdate — simulates a transport that hasn't been upgraded
    });
    await assert.rejects(() => repo.deleteRecordRow('AGENCIES', 'agency_id', 'ag_1'), /does not support row deletion/);
  });

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[3] End-to-end merge via the admin endpoint');
  // ══════════════════════════════════════════════════════════════════════════
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  __setRepoForTests(repo);

  seedRow(store, 'AGENCIES', AGENCIES_HEADER, {
    agency_id: 'ag_temme', agency_name: 'Temme English Estate Agents Wickford',
    domain: 'temmeenglish.co.uk', main_phone: '01268 573035', known_phone_numbers: '01268 573035',
    primary_contact_email: 'basildon@temmeenglish.co.uk',
    rightmove_status: 'confirmed', rightmove_sales_branch_url: 'https://www.rightmove.co.uk/estate-agents/agent/Temme-English/Wickford-87155.html',
    rightmove_checked_at: '2026-08-17T11:19:25.000Z', rightmove_notes: 'Rightmove sales profile verified in prior pass.',
    notes: '',
  });
  seedRow(store, 'AGENCIES', AGENCIES_HEADER, {
    agency_id: 'ag_carterward', agency_name: 'Carter & Ward',
    domain: 'carterandward.co.uk', main_phone: '01268 733421', known_phone_numbers: '01268 733421',
    primary_contact_email: 'basildon@temmeenglish.co.uk',
    rightmove_status: 'unresolved', notes: '',
  });
  // Unrelated third agency — must be completely unaffected.
  seedRow(store, 'AGENCIES', AGENCIES_HEADER, { agency_id: 'ag_other', agency_name: 'Untouched Agency' });

  // A dependent on the row being deleted, to prove repointing works even
  // though the real Carter & Ward / Gates Parish pairs happen to have zero.
  seedRow(store, 'PROBES', PROBES_HEADER, { probe_id: 'prb_1', probe_reference: 'RM-0001', agency_id: 'ag_carterward', portal: 'rightmove', probe_status: 'observing' });
  seedRow(store, 'COMMUNICATIONS', COMMUNICATIONS_HEADER, { communication_id: 'com_1', agency_id: 'ag_carterward', probe_id: 'prb_1' });
  seedRow(store, 'INTELLIGENCE', INTELLIGENCE_HEADER, { intelligence_id: 'itl_1', agency_id: 'ag_carterward', probe_id: 'prb_1' });
  seedRow(store, 'ACTIONS', ACTIONS_HEADER, { action_id: 'act_1', agency_id: 'ag_carterward', probe_id: 'prb_1' });

  await test('dry run reports the plan and writes nothing', async () => {
    const before = JSON.stringify(store);
    const res = mockRes();
    await mergeHandler(mockReq({ retain_agency_id: 'ag_temme', delete_agency_id: 'ag_carterward', dry_run: true }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.dry_run, true);
    assert.equal(res.body.plan.dependents_before.PROBES, 1);
    assert.equal(res.body.plan.dependents_before.COMMUNICATIONS, 1);
    assert.equal(res.body.plan.dependents_before.INTELLIGENCE, 1);
    assert.equal(res.body.plan.dependents_before.ACTIONS, 1);
    assert.equal(res.body.plan.patch.known_phone_numbers, '01268 573035, 01268 733421');
    assert.equal(res.body.plan.patch.agency_name, undefined, 'agency_name must not appear in the patch at all');
    assert.equal(JSON.stringify(store), before, 'dry run must not mutate anything');
  });

  await test('apply repoints every dependent, patches, and deletes the duplicate', async () => {
    const res = mockRes();
    await mergeHandler(mockReq({
      retain_agency_id: 'ag_temme', delete_agency_id: 'ag_carterward',
      notes_addendum: 'Merged with ag_carterward (Carter & Ward) — same underlying business.',
      dry_run: false,
    }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const r = res.body.result;
    assert.equal(r.deleted, true);
    assert.deepEqual(r.repointed, { PROBES: 1, COMMUNICATIONS: 1, INTELLIGENCE: 1, ACTIONS: 1 });
    assert.deepEqual(r.dependents_after, { PROBES: 0, COMMUNICATIONS: 0, INTELLIGENCE: 0, ACTIONS: 0 });
  });

  await test('the retained agency_name is untouched', () => {
    const retained = rowsOf(store, 'AGENCIES', AGENCIES_HEADER).find((r) => r.agency_id === 'ag_temme');
    assert.equal(retained.agency_name, 'Temme English Estate Agents Wickford');
  });

  await test('the retained row carries the merged phones and notes', () => {
    const retained = rowsOf(store, 'AGENCIES', AGENCIES_HEADER).find((r) => r.agency_id === 'ag_temme');
    assert.equal(retained.known_phone_numbers, '01268 573035, 01268 733421');
    assert.match(retained.notes, /Merged with ag_carterward/);
  });

  await test('the retained row kept its own (higher-ranked) rightmove data', () => {
    const retained = rowsOf(store, 'AGENCIES', AGENCIES_HEADER).find((r) => r.agency_id === 'ag_temme');
    assert.equal(retained.rightmove_status, 'confirmed');
    assert.match(retained.rightmove_sales_branch_url, /Temme-English/);
  });

  await test('the duplicate row is physically gone', () => {
    const ids = rowsOf(store, 'AGENCIES', AGENCIES_HEADER).map((r) => r.agency_id);
    assert.ok(!ids.includes('ag_carterward'));
  });

  await test('the unrelated third agency is completely unaffected', () => {
    const other = rowsOf(store, 'AGENCIES', AGENCIES_HEADER).find((r) => r.agency_id === 'ag_other');
    assert.ok(other, 'ag_other must still exist');
    assert.equal(other.agency_name, 'Untouched Agency');
    assert.equal(rowsOf(store, 'AGENCIES', AGENCIES_HEADER).length, 2, 'exactly the two surviving agencies remain');
  });

  await test('every dependent now points at the retained agency_id, none orphaned', () => {
    assert.equal(rowsOf(store, 'PROBES', PROBES_HEADER).find((r) => r.probe_id === 'prb_1').agency_id, 'ag_temme');
    assert.equal(rowsOf(store, 'COMMUNICATIONS', COMMUNICATIONS_HEADER).find((r) => r.communication_id === 'com_1').agency_id, 'ag_temme');
    assert.equal(rowsOf(store, 'INTELLIGENCE', INTELLIGENCE_HEADER).find((r) => r.intelligence_id === 'itl_1').agency_id, 'ag_temme');
    assert.equal(rowsOf(store, 'ACTIONS', ACTIONS_HEADER).find((r) => r.action_id === 'act_1').agency_id, 'ag_temme');
  });

  await test('re-running the same merge fails cleanly (delete_agency_id no longer exists)', async () => {
    const res = mockRes();
    await mergeHandler(mockReq({ retain_agency_id: 'ag_temme', delete_agency_id: 'ag_carterward', dry_run: true }), res);
    assert.equal(res.statusCode, 500);
    assert.match(res.body.error, /not found/);
  });

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[4] Refusal cases');
  // ══════════════════════════════════════════════════════════════════════════
  await test('rejects retain_agency_id === delete_agency_id', async () => {
    const res = mockRes();
    await mergeHandler(mockReq({ retain_agency_id: 'ag_temme', delete_agency_id: 'ag_temme', dry_run: true }), res);
    assert.equal(res.statusCode, 500);
    assert.match(res.body.error, /must be different/);
  });

  await test('rejects an unknown retain_agency_id', async () => {
    const res = mockRes();
    await mergeHandler(mockReq({ retain_agency_id: 'ag_nope', delete_agency_id: 'ag_other', dry_run: true }), res);
    assert.equal(res.statusCode, 500);
    assert.match(res.body.error, /not found/);
  });

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[5] Router dispatch — api/novus/admin.js (Vercel Hobby 12-function consolidation)');
  // ══════════════════════════════════════════════════════════════════════════
  // Everything above calls the agency-merge handler directly. This section
  // proves the ACTUAL router that Vercel serves (api/novus/admin.js) dispatches
  // to it — and to the other four consolidated resources — correctly by
  // `resource`, since that dispatch is itself new code with its own failure
  // modes (wrong key, missing query parsing, swallowed method, etc.).
  const adminRouter = (await import('../api/novus/admin.js')).default;
  function routerReq({ method = 'POST', resource, body = {}, query = {} } = {}) {
    return { method, body, query: { resource, ...query }, headers: { authorization: BASIC } };
  }

  await test('router: OPTIONS short-circuits to 200 regardless of resource', async () => {
    const res = mockRes();
    await adminRouter(routerReq({ method: 'OPTIONS', resource: undefined }), res);
    assert.equal(res.statusCode, 200);
  });

  await test('router: missing "resource" query param is rejected with the full list', async () => {
    const res = mockRes();
    await adminRouter({ method: 'GET', body: {}, query: {}, headers: { authorization: BASIC } }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /agencies/);
    assert.match(res.body.error, /rightmove-migrate/);
  });

  await test('router: unknown "resource" value is rejected the same way', async () => {
    const res = mockRes();
    await adminRouter(routerReq({ method: 'POST', resource: 'not-a-real-resource' }), res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /Missing or unknown/);
  });

  await test('router: resource=ensure-schema dispatches to the real handler (dry run, same fake sheet)', async () => {
    const res = mockRes();
    await adminRouter(routerReq({ method: 'POST', resource: 'ensure-schema', body: { dry_run: true } }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok(res.body.tabs, 'ensure-schema response shape reached the client untouched');
  });

  await test('router: resource=agencies (GET) dispatches to the real handler', async () => {
    const res = mockRes();
    await adminRouter(routerReq({ method: 'GET', resource: 'agencies', query: { agency_id: 'ag_temme' } }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.agency.agency_name, 'Temme English Estate Agents Wickford');
  });

  await test('router: resource=actions (GET) dispatches to the real handler', async () => {
    const res = mockRes();
    await adminRouter(routerReq({ method: 'GET', resource: 'actions', query: { agency_id: 'ag_temme' } }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    // 1, not 0: section [3] above seeded an ACTIONS row against ag_carterward and
    // then merged it, which repoints agency_id to ag_temme — so this also
    // double-checks that repointed action is still findable through the router.
    assert.equal(res.body.count, 1);
    assert.equal(res.body.actions[0].agency_id, 'ag_temme');
  });

  await test('router: resource=rightmove-migrate dispatches to the real handler', async () => {
    const res = mockRes();
    await adminRouter(routerReq({
      method: 'POST', resource: 'rightmove-migrate',
      body: { dry_run: true, rows: [{ agency_id: 'ag_other', rightmove_status: 'unresolved' }] },
    }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.report.matched, 1);
  });

  await test('router: resource=agency-merge dispatches to the real handler and hits the same refusal path', async () => {
    const res = mockRes();
    await adminRouter(routerReq({ method: 'POST', resource: 'agency-merge', body: { retain_agency_id: 'ag_temme', delete_agency_id: 'ag_temme', dry_run: true } }), res);
    assert.equal(res.statusCode, 500);
    assert.match(res.body.error, /must be different/);
  });

  console.log(`\n${'─'.repeat(70)}\n  ${passed} passed, ${failed} failed\n${'─'.repeat(70)}\n`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
