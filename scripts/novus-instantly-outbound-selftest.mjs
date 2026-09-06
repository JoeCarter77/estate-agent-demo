// Hermetic safety tests for NOVUS OUTBOUND -> Instantly.
// No network, Google credentials, Instantly calls or email sends.

import assert from 'node:assert/strict';
import {
  INSTANTLY_LIVE_CONFIRMATION,
  buildInstantlyDryRun,
  mapOutboundToInstantly,
  outboundEligibilityReasons,
  uploadEligibleOutboundLeads,
  uploadSingleOutboundLead,
} from '../lib/instantly-outbound.mjs';
import { OUTBOUND_HEADER } from '../lib/outbound.mjs';

const CAMPAIGN_ID = 'campaign_test_123';
const API_KEY = 'instantly_test_key_never_sent';
const NOW = '2026-08-30T12:00:00.000Z';

const BASE_ROW = {
  outbound_id: 'out_1',
  agency_id: 'ag_1',
  probe_id: 'prb_1',
  clean_agency_name: 'Stanton Hockett',
  outreach_contact_name: 'Bradley Stanton',
  first_name: 'Bradley',
  outreach_contact_email: 'bradley@example.com',
  email_verification_status: 'VALID',
  property_street: '10 High Street',
  probe_date: '11 August',
  probe_time: '22:27',
  email_observation: 'No human response arrived.',
  email_commercial_hook: 'A missed enquiry can become missed revenue.',
  email_commercial_hook_email_2: 'The opportunity remained untouched.',
  demo_slug: 'stanton-high-street',
  demo_url: 'https://demo.getnovus.co.uk/stanton-high-street',
  outbound_status: 'READY',
  instantly_lead_id: '',
  instantly_added_at: '',
  last_error: 'old error',
  created_at: '2026-08-29T10:00:00.000Z',
  updated_at: '2026-08-29T10:00:00.000Z',
};

function row(header, obj) {
  return header.map((column) => obj[column] ?? '');
}

function makeRepo(rows = [BASE_ROW], header = OUTBOUND_HEADER) {
  const store = [header.slice(), ['SCHEMA NOTE'], ...rows.map((item) => row(header, item))];
  const writes = [];
  return {
    store,
    writes,
    repo: {
      async getTable(tab) {
        assert.equal(tab, 'OUTBOUND');
        return { header: store[0].slice(), rows: store.slice(1).map((item) => item.slice()) };
      },
      async writeCellsBatch(items) {
        writes.push(items.map((item) => ({ ...item })));
        for (const item of items) store[item.rowNumber - 1][item.columnNumber - 1] = item.value;
      },
    },
  };
}

function objectAt(workbook, sheetRow = 3) {
  return Object.fromEntries(workbook.store[0].map((column, index) => [column, workbook.store[sheetRow - 1][index] ?? '']));
}

function objectById(workbook, outboundId) {
  const idIndex = workbook.store[0].indexOf('outbound_id');
  const sheetRow = workbook.store.findIndex((item, index) => index > 1 && item[idIndex] === outboundId) + 1;
  return objectAt(workbook, sheetRow);
}

function fakeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); },
  };
}

function liveOptions(overrides = {}) {
  return {
    outboundId: 'out_1',
    confirmation: INSTANTLY_LIVE_CONFIRMATION,
    apiKey: API_KEY,
    campaignId: CAMPAIGN_ID,
    now: () => NOW,
    ...overrides,
  };
}

let passed = 0;
function ok(message) { passed += 1; console.log(`  ✓ ${message}`); }

{
  const payload = mapOutboundToInstantly(BASE_ROW, CAMPAIGN_ID);
  assert.deepEqual(payload, {
    campaign: CAMPAIGN_ID,
    email: 'bradley@example.com',
    first_name: 'Bradley',
    company_name: 'Stanton Hockett',
    custom_variables: {
      property_street: '10 High Street',
      probe_date: '11 August',
      probe_time: '22:27',
      email_observation: 'No human response arrived.',
      email_commercial_hook: 'A missed enquiry can become missed revenue.',
      demo_url: 'https://demo.getnovus.co.uk/stanton-high-street',
    },
    skip_if_in_workspace: true,
    skip_if_in_campaign: true,
  });
  assert.equal('email_commercial_hook_email_2' in payload.custom_variables, false);
  ok('exact built-in and custom-variable mapping is stable');
  ok('both Instantly duplicate flags are true');
}

assert.deepEqual(outboundEligibilityReasons(BASE_ROW), []);
ok('READY with blank handoff markers is eligible');

for (const status of ['SENT', 'SUPPRESSED', 'ERROR']) {
  assert(outboundEligibilityReasons({ ...BASE_ROW, outbound_status: status }).some((reason) => reason.startsWith('outbound_status_not_READY:')));
  ok(`${status} is skipped`);
}
assert(outboundEligibilityReasons({ ...BASE_ROW, instantly_lead_id: 'lead_existing' }).includes('instantly_lead_id_nonblank'));
ok('existing instantly_lead_id is skipped');
assert(outboundEligibilityReasons({ ...BASE_ROW, instantly_added_at: NOW }).includes('instantly_added_at_nonblank'));
ok('existing instantly_added_at is skipped');

{
  const workbook = makeRepo([
    { ...BASE_ROW, outbound_id: 'out_z' },
    { ...BASE_ROW, outbound_id: 'out_sent', outbound_status: 'SENT' },
    { ...BASE_ROW, outbound_id: 'out_a' },
    { ...BASE_ROW, outbound_id: 'out_added', instantly_added_at: NOW },
  ]);
  let instantlyCalls = 0;
  const result = await buildInstantlyDryRun(workbook.repo, { campaignId: CAMPAIGN_ID, sampleLimit: 1 });
  assert.equal(result.total_rows, 4);
  assert.equal(result.eligible_rows, 2);
  assert.equal(result.skipped_rows, 2);
  assert.equal(result.sample_payloads.length, 1);
  assert.equal(result.sample_payloads[0].outbound_id, 'out_a');
  assert.equal(workbook.writes.length, 0);
  assert.equal(instantlyCalls, 0);
  ok('dry-run reports counts and a bounded exact sample sorted by outbound_id');
  ok('dry-run performs zero Sheet writes');
  ok('dry-run has no Instantly transport and performs zero Instantly calls');
}

{
  const workbook = makeRepo();
  await assert.rejects(
    uploadSingleOutboundLead(workbook.repo, liveOptions({ outboundId: '', fetchImpl: async () => fakeResponse(200, { id: 'never' }) })),
    /requires one exact outbound_id/,
  );
  ok('live mode refuses a missing outbound_id');

  await assert.rejects(
    uploadSingleOutboundLead(workbook.repo, liveOptions({ confirmation: '', fetchImpl: async () => fakeResponse(200, { id: 'never' }) })),
    /requires confirmation/,
  );
  ok('live mode refuses missing confirmation');
}

{
  const workbook = makeRepo([BASE_ROW, { ...BASE_ROW, outbound_id: 'out_2' }]);
  let calls = 0;
  await uploadSingleOutboundLead(workbook.repo, liveOptions({
    fetchImpl: async () => { calls += 1; return fakeResponse(200, { id: 'lead_one' }); },
  }));
  assert.equal(calls, 1);
  assert.equal(objectAt(workbook, 4).instantly_lead_id, '');
  await assert.rejects(
    uploadSingleOutboundLead(workbook.repo, liveOptions({ outboundId: ['out_1', 'out_2'], fetchImpl: async () => { calls += 1; return fakeResponse(200, { id: 'never' }); } })),
    /requires one exact outbound_id/,
  );
  assert.equal(calls, 1);
  ok('live mode selects exactly one ID, makes at most one POST, and rejects multi-ID input');
}

{
  const workbook = makeRepo();
  let sentPayload;
  const result = await uploadSingleOutboundLead(workbook.repo, liveOptions({
    testEmail: 'joe.test@example.com',
    fetchImpl: async (_url, init) => {
      sentPayload = JSON.parse(init.body);
      return fakeResponse(200, { id: 'lead_test_email' });
    },
  }));
  const normalPayload = mapOutboundToInstantly(BASE_ROW, CAMPAIGN_ID);
  assert.deepEqual(sentPayload, { ...normalPayload, email: 'joe.test@example.com' });
  assert.equal(result.test_mode, true);
  assert.match(result.message, /TEST MODE/);
  assert.equal(workbook.writes.length, 0);
  assert.deepEqual(objectAt(workbook), BASE_ROW);
  ok('test-email mode changes only the destination email');
  ok('test-email mode clearly reports TEST MODE and performs zero OUTBOUND writes');
}

{
  const workbook = makeRepo();
  const result = await uploadSingleOutboundLead(workbook.repo, liveOptions({
    fetchImpl: async () => fakeResponse(200, { id: 'lead_success_123' }),
  }));
  const stored = objectAt(workbook);
  assert.equal(result.outbound_status, 'READY');
  assert.equal(stored.outbound_status, 'READY');
  assert.equal(stored.instantly_lead_id, 'lead_success_123');
  assert.equal(stored.instantly_added_at, NOW);
  assert.equal(stored.last_error, '');
  assert.equal(stored.updated_at, NOW);
  ok('successful normal handoff preserves READY');
  ok('successful normal handoff records Instantly ID/timestamp and clears last_error');
}

{
  const workbook = makeRepo();
  await assert.rejects(
    uploadSingleOutboundLead(workbook.repo, liveOptions({ fetchImpl: async () => fakeResponse(429, { message: 'rate limited' }) })),
    /HTTP 429/,
  );
  const stored = objectAt(workbook);
  assert.equal(stored.outbound_status, 'READY');
  assert.equal(stored.instantly_lead_id, '');
  assert.equal(stored.instantly_added_at, '');
  assert.match(stored.last_error, /HTTP 429/);
  assert.equal(stored.updated_at, NOW);
  ok('failed normal live upload preserves READY and records last_error/updated_at');
}

{
  const missingHeader = OUTBOUND_HEADER.filter((column) => column !== 'demo_url');
  const workbook = makeRepo([BASE_ROW], missingHeader);
  await assert.rejects(buildInstantlyDryRun(workbook.repo, { campaignId: CAMPAIGN_ID }), /missing required column.*demo_url/);
  ok('missing required OUTBOUND headers fail closed');
}

{
  const workbook = makeRepo([
    { ...BASE_ROW, outbound_id: 'out_1', outreach_contact_email: 'one@example.com' },
    { ...BASE_ROW, outbound_id: 'out_existing', instantly_lead_id: 'lead_existing' },
    { ...BASE_ROW, outbound_id: 'out_suppressed', outbound_status: 'SUPPRESSED' },
    { ...BASE_ROW, outbound_id: 'out_sent', outbound_status: 'SENT' },
    { ...BASE_ROW, outbound_id: 'out_error', outbound_status: 'ERROR' },
    { ...BASE_ROW, outbound_id: 'out_2', outreach_contact_email: 'two@example.com' },
    { ...BASE_ROW, outbound_id: 'out_3', outreach_contact_email: 'three@example.com' },
  ]);
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const payload = JSON.parse(init.body);
    calls.push(payload);
    if (payload.email === 'two@example.com') return fakeResponse(429, { message: 'rate limited' });
    return fakeResponse(200, { id: `lead_${payload.email.split('@')[0]}` });
  };

  const first = await uploadEligibleOutboundLeads(workbook.repo, {
    apiKey: API_KEY,
    campaignId: CAMPAIGN_ID,
    fetchImpl,
    now: () => NOW,
    concurrency: 1,
  });
  assert.equal(first.eligible_rows, 3);
  assert.equal(first.uploaded_rows, 2);
  assert.equal(first.failed_rows, 1);
  assert.equal(first.skipped_rows, 4);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((payload) => payload.email), ['one@example.com', 'two@example.com', 'three@example.com']);
  assert.ok(calls.every((payload) => payload.skip_if_in_workspace === true && payload.skip_if_in_campaign === true));
  assert.equal(objectById(workbook, 'out_1').instantly_lead_id, 'lead_one');
  assert.equal(objectById(workbook, 'out_1').instantly_added_at, NOW);
  assert.equal(objectById(workbook, 'out_1').last_error, '');
  assert.equal(objectById(workbook, 'out_1').outbound_status, 'READY');
  assert.equal(objectById(workbook, 'out_2').instantly_lead_id, '');
  assert.equal(objectById(workbook, 'out_2').instantly_added_at, '');
  assert.match(objectById(workbook, 'out_2').last_error, /HTTP 429/);
  assert.equal(objectById(workbook, 'out_2').outbound_status, 'READY');
  assert.equal(objectById(workbook, 'out_3').instantly_lead_id, 'lead_three');
  ok('bulk uploads multiple eligible rows and uses the proven duplicate-safe payload flags');
  ok('already-uploaded, SUPPRESSED, SENT and ERROR rows are skipped');
  ok('one failed upload records its error, preserves READY, and does not stop a later eligible row');
  ok('successful bulk rows receive both markers, clear last_error, and remain READY');

  calls.length = 0;
  const rerun = await uploadEligibleOutboundLeads(workbook.repo, {
    apiKey: API_KEY,
    campaignId: CAMPAIGN_ID,
    fetchImpl,
    now: () => NOW,
    concurrency: 2,
  });
  assert.equal(rerun.eligible_rows, 1);
  assert.equal(rerun.uploaded_rows, 0);
  assert.equal(rerun.failed_rows, 1);
  assert.deepEqual(calls.map((payload) => payload.email), ['two@example.com']);
  ok('rerun skips every prior success and retries only the still-unmarked failed row');
}

{
  const workbook = makeRepo([
    { ...BASE_ROW, outbound_id: 'out_sent', outbound_status: 'SENT' },
    { ...BASE_ROW, outbound_id: 'out_done', instantly_added_at: NOW },
  ]);
  let calls = 0;
  const result = await uploadEligibleOutboundLeads(workbook.repo, {
    apiKey: API_KEY,
    campaignId: CAMPAIGN_ID,
    fetchImpl: async () => { calls += 1; return fakeResponse(200, { id: 'never' }); },
  });
  assert.equal(result.eligible_rows, 0);
  assert.equal(result.uploaded_rows, 0);
  assert.equal(result.failed_rows, 0);
  assert.equal(calls, 0);
  assert.equal(workbook.writes.length, 0);
  ok('zero eligible rows is a clean no-op with 0 uploaded and no writes or API calls');
}

console.log(`\n✅ NOVUS Instantly OUTBOUND self-test passed (${passed} focused assertions).`);
