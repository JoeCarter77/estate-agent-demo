// Hermetic focused tests for the deterministic OUTBOUND compiler.
// No network, Google credentials, Instantly calls or email sends.

import assert from 'node:assert/strict';
import { createRepo } from '../lib/sheets.mjs';
import { deriveFirstName, OUTBOUND_HEADER, rebuildOutbound } from '../lib/outbound.mjs';

const AGENCIES_HEADER = [
  'agency_id', 'clean_agency_name', 'outreach_contact_name',
  'outreach_contact_email', 'email_verification_status',
];
const PROBES_HEADER = ['agency_id', 'probe_id', 'property_street'];
const PERSONALISATION_HEADER = [
  'agency_id', 'probe_id', 'email_observation', 'email_commercial_hook',
  'email_commercial_hook_email_2',
];
const DEMOS_HEADER = [
  'agency_id', 'probe_id', 'demo_slug', 'demo_status',
  'property_image_status', 'enquiry_date', 'enquiry_time',
];

const COMPLETE_MISS = "I didn't receive any human response or follow-up after sending the enquiry.";
const CREATED_AT = '2026-08-28T10:00:00.000Z';
const NOW = '2026-08-29T10:00:00.000Z';

function row(header, obj) {
  return header.map((column) => obj[column] ?? '');
}

function makeWorkbook(overrides = {}, { outboundRows = [] } = {}) {
  const agency = {
    agency_id: 'ag_1',
    clean_agency_name: 'Stanton Hockett',
    outreach_contact_name: 'Bradley Stanton',
    outreach_contact_email: 'bradley@example.com',
    email_verification_status: 'VALID',
    ...(overrides.agency || {}),
  };
  const probe = {
    agency_id: 'ag_1', probe_id: 'prb_1', property_street: '10 High Street',
    ...(overrides.probe || {}),
  };
  const personalisation = {
    agency_id: 'ag_1', probe_id: 'prb_1',
    email_observation: COMPLETE_MISS,
    email_commercial_hook: 'A missed enquiry can become missed revenue.',
    email_commercial_hook_email_2: 'The opportunity remained untouched.',
    ...(overrides.personalisation || {}),
  };
  const demo = {
    agency_id: 'ag_1', probe_id: 'prb_1', demo_slug: 'stanton-high-street',
    demo_status: 'ready', property_image_status: 'ok',
    enquiry_date: '11 August', enquiry_time: '22:27',
    ...(overrides.demo || {}),
  };
  const store = {
    AGENCIES: [AGENCIES_HEADER.slice(), row(AGENCIES_HEADER, agency)],
    PROBES: [PROBES_HEADER.slice(), row(PROBES_HEADER, probe)],
    PERSONALISATION: [PERSONALISATION_HEADER.slice(), row(PERSONALISATION_HEADER, personalisation)],
    DEMOS: [DEMOS_HEADER.slice(), row(DEMOS_HEADER, demo)],
    OUTBOUND: [OUTBOUND_HEADER.slice(), ...outboundRows.map((item) => row(OUTBOUND_HEADER, item))],
  };
  const writes = { append: 0, update: 0, batchUpdate: 0 };
  const tabOf = (range) => String(range).split('!')[0];
  const startRowOf = (range) => Number(String(range).match(/!\D+(\d+)/)?.[1] || 0);
  const valuesApi = {
    async get(range) {
      return (store[tabOf(range)] || []).map((item) => item.slice());
    },
    async append(range, rows) {
      writes.append += 1;
      store[tabOf(range)].push(...rows.map((item) => item.slice()));
    },
    async update(range, rows) {
      writes.update += 1;
      const tab = tabOf(range); const start = startRowOf(range);
      rows.forEach((item, index) => { store[tab][start - 1 + index] = item.slice(); });
    },
    async batchUpdate(data) {
      writes.batchUpdate += 1;
      for (const { range, values } of data) {
        const tab = tabOf(range); const start = startRowOf(range);
        values.forEach((item, index) => { store[tab][start - 1 + index] = item.slice(); });
      }
    },
  };
  return { store, writes, repo: createRepo(valuesApi) };
}

async function dryRun(overrides = {}, options = {}) {
  const workbook = makeWorkbook(overrides, options);
  const result = await rebuildOutbound(workbook.repo, {
    dryRun: true,
    now: () => NOW,
    idFactory: () => 'out_test_1',
  });
  return { ...workbook, result };
}

function outboundObjects(store) {
  return store.OUTBOUND.slice(1).map((item) => Object.fromEntries(
    OUTBOUND_HEADER.map((column, index) => [column, item[index] ?? '']),
  ));
}

let passed = 0;
function ok(message) { passed += 1; console.log(`  ✓ ${message}`); }

{
  const { result } = await dryRun();
  assert.equal(result.eligible_count, 1);
  assert.equal(result.create_count, 1);
  assert.equal(result.rows_to_create[0].outbound_status, 'READY');
  ok('fully eligible prospect compiles to a new READY row');
}

for (const [label, overrides, reason] of [
  ['demo not ready', { demo: { demo_status: 'needs_review' } }, 'demo_status != ready'],
  ['property image not ok', { demo: { property_image_status: 'missing' } }, 'property_image_status != ok'],
  ['missing contact email', { agency: { outreach_contact_email: '' } }, 'missing outreach_contact_email'],
]) {
  const { result } = await dryRun(overrides);
  assert.equal(result.eligible_count, 0);
  assert(result.skipped[0].reasons.includes(reason));
  ok(`${label} is skipped`);
}

for (const status of ['VALID', 'RISKY']) {
  const { result } = await dryRun({ agency: { email_verification_status: status } });
  assert.equal(result.eligible_count, 1);
  ok(`verification ${status} is accepted`);
}

for (const status of ['UNKNOWN', 'INVALID', '']) {
  const { result } = await dryRun({ agency: { email_verification_status: status } });
  assert.equal(result.eligible_count, 0);
  assert(result.skipped[0].reasons.some((reason) => reason.startsWith('email_verification_status ')));
}
ok('UNKNOWN, blank and other verification statuses are skipped');

for (const [label, overrides, reason] of [
  ['missing clean agency name', { agency: { clean_agency_name: '  ' } }, 'missing clean_agency_name'],
  ['missing property street', { probe: { property_street: '' } }, 'missing property_street'],
  ['missing demo slug', { demo: { demo_slug: '' } }, 'missing demo_slug'],
]) {
  const { result } = await dryRun(overrides);
  assert.equal(result.eligible_count, 0);
  assert(result.skipped[0].reasons.includes(reason));
  ok(`${label} is skipped`);
}

for (const field of ['email_observation', 'email_commercial_hook']) {
  const { result } = await dryRun({ personalisation: { [field]: '   ' } });
  assert.equal(result.eligible_count, 0);
  assert(result.skipped[0].reasons.includes(`missing ${field}`));
}
ok('each active personalisation field is independently gated');

{
  const { result } = await dryRun({ personalisation: { email_commercial_hook_email_2: '   ' } });
  assert.equal(result.eligible_count, 1);
  ok('deprecated Hook 2 does not affect OUTBOUND eligibility');
}

for (const field of ['enquiry_date', 'enquiry_time']) {
  const { result } = await dryRun({ demo: { [field]: '' } });
  assert.equal(result.eligible_count, 0);
  assert(result.skipped[0].reasons.includes(`missing ${field}`));
}
ok('missing prospect-facing enquiry date or time is skipped');

assert.equal(deriveFirstName('Bradley Stanton'), 'Bradley');
assert.equal(deriveFirstName('Dr. Amélie O’Neil'), 'Amélie');
assert.equal(deriveFirstName(''), '');
assert.equal(deriveFirstName('team@example.com'), '');
assert.equal(deriveFirstName('Turner Estates'), '');
ok('first_name is conservatively derived from a usable contact name');

{
  const { result } = await dryRun();
  const created = result.rows_to_create[0];
  assert.equal(created.demo_url, 'https://demo.getnovus.co.uk/stanton-high-street');
  assert.equal(created.email_observation, COMPLETE_MISS);
  assert.equal(Buffer.from(created.email_observation).equals(Buffer.from(COMPLETE_MISS)), true);
  ok('demo URL uses the exact live base URL and slug');
  ok('complete-miss email observation is preserved byte-for-byte');
}

{
  const workbook = makeWorkbook();
  let idCalls = 0;
  await rebuildOutbound(workbook.repo, {
    dryRun: false, now: () => CREATED_AT, idFactory: () => `out_${++idCalls}`,
  });
  await rebuildOutbound(workbook.repo, {
    dryRun: false, now: () => NOW, idFactory: () => `out_${++idCalls}`,
  });
  const rows = outboundObjects(workbook.store);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outbound_id, 'out_1');
  assert.equal(rows[0].created_at, CREATED_AT);
  assert.equal(rows[0].updated_at, NOW);
  ok('rerun upserts by agency_id + probe_id without duplication');
  ok('rerun preserves outbound_id and created_at');
}

{
  const sent = {
    outbound_id: 'out_existing', agency_id: 'ag_1', probe_id: 'prb_1',
    outbound_status: 'SENT', instantly_lead_id: 'lead_123',
    instantly_added_at: '2026-08-28T12:00:00.000Z', last_error: 'historic error',
    created_at: CREATED_AT, updated_at: CREATED_AT,
  };
  const workbook = makeWorkbook({}, { outboundRows: [sent] });
  await rebuildOutbound(workbook.repo, { dryRun: false, now: () => NOW, idFactory: () => 'must_not_replace' });
  const updated = outboundObjects(workbook.store)[0];
  assert.equal(updated.outbound_status, 'SENT');
  assert.equal(updated.instantly_lead_id, 'lead_123');
  assert.equal(updated.instantly_added_at, sent.instantly_added_at);
  assert.equal(updated.last_error, 'historic error');
  ok('existing SENT status and every Instantly execution field are preserved');
}

{
  const suppressed = {
    outbound_id: 'out_suppressed', agency_id: 'ag_1', probe_id: 'prb_1',
    outbound_status: 'SUPPRESSED', created_at: CREATED_AT,
  };
  const { result } = await dryRun({}, { outboundRows: [suppressed] });
  assert.equal(result.update_count, 1);
  assert.equal(result.rows_to_update[0].outbound_status, 'SUPPRESSED');
  ok('existing SUPPRESSED status is never reset');
}

{
  const { writes, result } = await dryRun();
  assert.equal(result.create_count, 1);
  assert.deepEqual(writes, { append: 0, update: 0, batchUpdate: 0 });
  ok('dry-run performs no writes');
}

console.log(`\n✅ NOVUS OUTBOUND self-test passed (${passed} focused assertions).`);
