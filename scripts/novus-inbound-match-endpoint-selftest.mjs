// Hermetic contract test for the production read-only debug endpoint.

import assert from 'node:assert/strict';
import { __setRepoForTests } from '../lib/sheets.mjs';
import handler from '../api/novus/intelligence/rebuild-all.js';

const NOW = Date.now();
const occurredAt = new Date(NOW - 60 * 60 * 1000).toISOString();
const probeStart = new Date(NOW - 24 * 60 * 60 * 1000).toISOString();
const probeEnd = new Date(NOW + 4 * 24 * 60 * 60 * 1000).toISOString();

const agencies = [
  { agency_id: 'ag_a', agency_name: 'Agency A', domain: 'agency-a.co.uk', primary_contact_email: 'reply@agency-a.co.uk', main_phone: '01787 479988' },
  { agency_id: 'ag_b', agency_name: 'Agency B', domain: 'agency-b.co.uk', primary_contact_email: 'reply@agency-b.co.uk' },
];
const probes = [
  { probe_id: 'prb_b', agency_id: 'ag_b', property_address: 'Mill Lane, Colne Engaine, Colchester, CO6', probe_status: 'observing', probe_timestamp: probeStart, observation_deadline: probeEnd },
  { probe_id: 'prb_high_1', agency_id: 'ag_a', property_address: 'High Street, Billericay, CM12', probe_status: 'observing', probe_timestamp: probeStart, observation_deadline: probeEnd },
  { probe_id: 'prb_high_2', agency_id: 'ag_b', property_address: 'High Street, Billericay, CM12', probe_status: 'observing', probe_timestamp: probeStart, observation_deadline: probeEnd },
];
const communications = [
  {
    communication_id: 'com_recoverable', occurred_at: occurredAt, received_at: occurredAt,
    direction: 'inbound', channel: 'sms', source_identifier_raw: 'Viewing', source_identifier_normalized: '',
    body_text: 'Regarding 9 Mill Lane, Colne Engaine, Colchester, CO6 2HY',
    agency_id: '', probe_id: '', matching_method: 'unmatched', match_status: 'unmatched',
  },
  {
    communication_id: 'com_conflict', occurred_at: occurredAt, received_at: occurredAt,
    direction: 'inbound', channel: 'email', source_identifier_raw: 'reply@agency-a.co.uk', source_identifier_normalized: 'reply@agency-a.co.uk',
    subject: 'Re: enquiry', body_text: '9 Mill Lane, Colne Engaine, Colchester, CO6 2HY',
    agency_id: 'ag_a', probe_id: '', matching_method: 'email_exact', match_status: 'ambiguous',
  },
  {
    communication_id: 'com_ambiguous', occurred_at: occurredAt, received_at: occurredAt,
    direction: 'inbound', channel: 'sms', source_identifier_raw: 'Property', source_identifier_normalized: '',
    body_text: 'Calling about High Street, Billericay CM12.',
    agency_id: '', probe_id: '', matching_method: '', match_status: 'unmatched',
  },
  {
    communication_id: 'com_unmatched', occurred_at: occurredAt, received_at: occurredAt,
    direction: 'inbound', channel: 'email', source_identifier_raw: 'unknown@platform.invalid', source_identifier_normalized: 'unknown@platform.invalid',
    subject: 'Hello', body_text: 'No deterministic identity evidence here.',
    agency_id: '', probe_id: '', matching_method: 'unmatched', match_status: 'unmatched',
  },
  {
    communication_id: 'com_resolved_excluded', occurred_at: occurredAt, received_at: occurredAt,
    direction: 'inbound', channel: 'email', source_identifier_raw: 'reply@agency-a.co.uk', source_identifier_normalized: 'reply@agency-a.co.uk',
    agency_id: 'ag_a', probe_id: 'prb_high_1', matching_method: 'email_exact', match_status: 'matched',
  },
  // Legacy pre-matcher rows: both ids already populated, matching_method never
  // backfilled, match_status carries the old grading vocabulary. These must be
  // excluded from the queue regardless of match_status/matching_method.
  {
    communication_id: 'com_legacy_high', occurred_at: occurredAt, received_at: occurredAt,
    direction: 'inbound', channel: 'email', source_identifier_raw: 'old-system@legacy.invalid',
    body_text: 'Historical HIGH-grade communication from before the matcher existed.',
    agency_id: 'ag_a', probe_id: 'prb_high_1', matching_method: '', match_status: 'HIGH',
  },
  {
    communication_id: 'com_legacy_medium', occurred_at: occurredAt, received_at: occurredAt,
    direction: 'inbound', channel: 'email', source_identifier_raw: 'old-system@legacy.invalid',
    body_text: 'Historical MEDIUM-grade communication from before the matcher existed.',
    agency_id: 'ag_b', probe_id: 'prb_b', matching_method: '', match_status: 'MEDIUM',
  },
  {
    communication_id: 'com_legacy_oow', occurred_at: occurredAt, received_at: occurredAt,
    direction: 'inbound', channel: 'email', source_identifier_raw: 'old-system@legacy.invalid',
    body_text: 'Historical out-of-window communication from before the matcher existed.',
    agency_id: 'ag_a', probe_id: 'prb_high_1', matching_method: '', match_status: 'HIGH_AGENCY_OUT_OF_WINDOW',
  },
  // Partial identity: exactly one of agency_id/probe_id is blank. These must
  // stay in the queue no matter what legacy match_status they carry.
  {
    communication_id: 'com_blank_probe', occurred_at: occurredAt, received_at: occurredAt,
    direction: 'inbound', channel: 'sms', source_identifier_raw: 'Unknown',
    body_text: 'Hi, please confirm the details discussed earlier.',
    agency_id: 'ag_b', probe_id: '', matching_method: '', match_status: 'unmatched',
  },
  {
    communication_id: 'com_blank_agency', occurred_at: occurredAt, received_at: occurredAt,
    direction: 'inbound', channel: 'sms', source_identifier_raw: 'Unknown',
    body_text: 'Hi, please confirm the details discussed earlier.',
    agency_id: '', probe_id: 'prb_b', matching_method: '', match_status: 'unmatched',
  },
];

let reads = 0;
const repo = {
  async getRecords(tab) {
    reads++;
    const source = tab === 'COMMUNICATIONS' ? communications : tab === 'AGENCIES' ? agencies : tab === 'PROBES' ? probes : [];
    return source.map((obj, index) => ({ obj, rowNumber: index + 3 }));
  },
  async appendRecord() { throw new Error('WRITE ATTEMPT: appendRecord'); },
  async updateById() { throw new Error('WRITE ATTEMPT: updateById'); },
  async batchUpdate() { throw new Error('WRITE ATTEMPT: batchUpdate'); },
};

function req({ password = 'test-pass', query = {}, method = 'GET', action = 'inbound-match-dry-run' } = {}) {
  return {
    method, query: { action, ...query },
    url: `/api/novus/intelligence/rebuild-all?action=${action}`,
    headers: { authorization: `Basic ${Buffer.from(`test-user:${password}`).toString('base64')}` },
  };
}

function res() {
  return {
    statusCode: 200, body: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
    setHeader(key, value) { this.headers[key] = value; },
  };
}

process.env.NOVUS_BASIC_AUTH_USER = 'test-user';
process.env.NOVUS_BASIC_AUTH_PASS = 'test-pass';
__setRepoForTests(repo);

const denied = res();
await handler(req({ password: 'wrong' }), denied);
assert.equal(denied.statusCode, 401);
assert.equal(reads, 0, 'auth failure occurs before any Sheets read');

const deniedBackfill = res();
await handler(req({ password: 'wrong', method: 'POST', action: 'inbound-match-backfill' }), deniedBackfill);
assert.equal(deniedBackfill.statusCode, 401);
assert.equal(reads, 0, 'backfill auth failure occurs before any Sheets read or write');

const ordinaryGet = res();
await handler({ ...req(), query: {}, url: '/api/novus/intelligence/rebuild-all' }, ordinaryGet);
assert.equal(ordinaryGet.statusCode, 405, 'ordinary GET behaviour remains unchanged');
assert.equal(reads, 0, 'ordinary GET does not touch Sheets');

const response = res();
await handler(req(), response);
assert.equal(response.statusCode, 200);
assert.ok(response.headers['Cache-Control'].includes('no-store'), 'private data response must be no-store');
assert.equal(response.body.read_only, true);
assert.deepEqual(response.body.parameters, { days: 30, limit: 150 });
assert.deepEqual(response.body.summary, {
  reviewed: 6, recoverable: 1, unmatched: 3, ambiguous: 1, conflict: 1,
});
assert.equal(reads, 3, 'exactly one read for each required tab');
assert.equal(response.body.rows.find((row) => row.communication_id === 'com_recoverable').proposed_probe_id, 'prb_b');
assert.equal(response.body.rows.find((row) => row.communication_id === 'com_conflict').status, 'conflict');
assert.ok(!response.body.rows.some((row) => row.communication_id === 'com_resolved_excluded'));
assert.ok(response.body.rows.every((row) => Object.hasOwn(row, 'evidence_reason')));

// Regression: fully-identified rows stay out of the queue regardless of
// legacy match_status/blank matching_method; partially-identified rows
// (exactly one id blank) stay in it no matter what legacy status they carry.
assert.ok(!response.body.rows.some((row) => row.communication_id === 'com_legacy_high'), 'HIGH row with both ids is excluded');
assert.ok(!response.body.rows.some((row) => row.communication_id === 'com_legacy_medium'), 'MEDIUM row with both ids is excluded');
assert.ok(!response.body.rows.some((row) => row.communication_id === 'com_legacy_oow'), 'HIGH_AGENCY_OUT_OF_WINDOW row with both ids is excluded');
assert.ok(response.body.rows.some((row) => row.communication_id === 'com_blank_probe'), 'row missing only probe_id is included');
assert.ok(response.body.rows.some((row) => row.communication_id === 'com_blank_agency'), 'row missing only agency_id is included');

const capped = res();
await handler(req({ query: { days: '999', limit: '999' } }), capped);
assert.deepEqual(capped.body.parameters, { days: 180, limit: 500 });

__setRepoForTests(null);
console.log('✅ Read-only inbound-match debug endpoint contract passed.');
