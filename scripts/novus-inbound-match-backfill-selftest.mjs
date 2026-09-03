// Hermetic safety/idempotency tests for the explicit inbound backfill action.

import assert from 'node:assert/strict';
import { runInboundMatchBackfill } from '../lib/inbound-match-backfill.mjs';

const now = new Date();
const occurredAt = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
const probeStart = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
const probeEnd = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000).toISOString();

const agencies = [
  { agency_id: 'ag_a', agency_name: 'Agency A', domain: 'agency-a.co.uk', primary_contact_email: 'reply@agency-a.co.uk' },
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
    direction: 'inbound', channel: 'sms', source_identifier_raw: 'Viewing',
    body_text: 'Regarding 9 Mill Lane, Colne Engaine, Colchester, CO6 2HY', raw_content: 'ORIGINAL RAW',
    agency_id: '', probe_id: '', matching_method: 'unmatched', match_score: 0, match_status: 'unmatched', manual_review_status: 'pending',
  },
  {
    communication_id: 'com_ambiguous', occurred_at: occurredAt, received_at: occurredAt,
    direction: 'inbound', channel: 'sms', source_identifier_raw: 'Property',
    body_text: 'Calling about High Street, Billericay CM12.',
    agency_id: '', probe_id: '', matching_method: '', match_status: 'unmatched',
  },
  {
    communication_id: 'com_conflict', occurred_at: occurredAt, received_at: occurredAt,
    direction: 'inbound', channel: 'email', source_identifier_raw: 'reply@agency-a.co.uk',
    body_text: '9 Mill Lane, Colne Engaine, Colchester, CO6 2HY',
    agency_id: 'ag_a', probe_id: '', matching_method: 'email_exact', match_status: 'ambiguous',
  },
  {
    communication_id: 'com_existing_id', occurred_at: occurredAt, received_at: occurredAt,
    direction: 'inbound', channel: 'email', source_identifier_raw: 'automation@crm.invalid',
    body_text: '9 Mill Lane, Colne Engaine, Colchester, CO6 2HY',
    agency_id: 'ag_a', probe_id: '', matching_method: 'unmatched', match_status: 'unmatched',
  },
  {
    communication_id: 'com_newsletter', occurred_at: occurredAt, received_at: occurredAt,
    direction: 'inbound', channel: 'email', source_identifier_raw: 'marketing@agency-a.co.uk',
    subject: 'Market newsletter', body_text: 'Local market news and company updates.',
    agency_id: '', probe_id: '', matching_method: 'domain_exact', match_status: 'unmatched',
  },
];

let writeCount = 0;
const repo = {
  async getRecords(tab) {
    const rows = tab === 'COMMUNICATIONS' ? communications : tab === 'AGENCIES' ? agencies : tab === 'PROBES' ? probes : [];
    return rows.map((obj, index) => ({ obj: { ...obj }, rowNumber: index + 3 }));
  },
  async findById(tab, idColumn, idValue) {
    const rows = tab === 'COMMUNICATIONS' ? communications : [];
    const index = rows.findIndex((row) => row[idColumn] === idValue);
    return index < 0 ? null : { obj: { ...rows[index] }, rowNumber: index + 3 };
  },
  async updateById(tab, idColumn, idValue, patch) {
    assert.equal(tab, 'COMMUNICATIONS');
    const index = communications.findIndex((row) => row[idColumn] === idValue);
    if (index < 0) return null;
    writeCount++;
    communications[index] = { ...communications[index], ...patch };
    return { ...communications[index] };
  },
};

const recomputed = [];
const first = await runInboundMatchBackfill(repo, { days: 14, limit: 100, now }, {
  recompute: async (_repo, probeId) => { recomputed.push(probeId); },
});

// com_existing_id's stored agency_id (ag_a) contradicts the property evidence
// in its body (ag_b's probe), so the matcher itself now classifies it as a
// conflict before the write layer ever sees it — safer than reaching the
// write-time "existing ID" skip, since the contradiction is surfaced earlier.
assert.deepEqual(first.summary, {
  reviewed: 5,
  updated: 1,
  skipped_unmatched: 1,
  skipped_ambiguous: 1,
  skipped_conflict: 2,
  skipped_existing: 0,
  failed: 0,
});
assert.deepEqual(first.updated, [{
  communication_id: 'com_recoverable', agency_id: 'ag_b', probe_id: 'prb_b', matching_method: 'property_address_exact',
}]);
assert.deepEqual(recomputed, ['prb_b'], 'existing single-probe recomputation path runs after the write');

const repaired = communications.find((row) => row.communication_id === 'com_recoverable');
assert.equal(repaired.agency_id, 'ag_b');
assert.equal(repaired.probe_id, 'prb_b');
assert.equal(repaired.match_status, 'matched');
assert.equal(repaired.match_score, 1);
assert.equal(repaired.manual_review_status, 'not_required');
assert.equal(repaired.occurred_at, occurredAt, 'occurred_at is preserved');
assert.equal(repaired.raw_content, 'ORIGINAL RAW', 'raw evidence is preserved');

assert.equal(communications.find((row) => row.communication_id === 'com_ambiguous').probe_id, '', 'ambiguous row is not written');
assert.equal(communications.find((row) => row.communication_id === 'com_conflict').probe_id, '', 'conflict row is not written');
assert.equal(communications.find((row) => row.communication_id === 'com_existing_id').agency_id, 'ag_a', 'existing non-blank agency is not overwritten');
assert.equal(communications.find((row) => row.communication_id === 'com_existing_id').probe_id, '', 'contradictory existing ID prevents partial repair');
assert.equal(communications.find((row) => row.communication_id === 'com_newsletter').probe_id, '', 'generic newsletter gets no probe');

const second = await runInboundMatchBackfill(repo, { days: 14, limit: 100, now }, {
  recompute: async (_repo, probeId) => { recomputed.push(probeId); },
});
assert.equal(second.summary.updated, 0, 'second run writes nothing');
assert.equal(writeCount, 1, 'exactly one total Sheet update across both runs');
assert.deepEqual(recomputed, ['prb_b'], 'second run triggers no duplicate recomputation');

console.log('✅ Inbound match backfill safety and idempotency checks passed.');

