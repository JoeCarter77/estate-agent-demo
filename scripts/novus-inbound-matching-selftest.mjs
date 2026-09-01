// Hermetic tests for deterministic multi-signal inbound reconciliation.
// Run: node scripts/novus-inbound-matching-selftest.mjs

import assert from 'node:assert/strict';
import { matchInboundCommunication } from '../lib/inbound-matching.mjs';

const NOW = new Date('2026-09-01T09:00:00.000Z');

function repoFor({ agencies = [], probes = [] }) {
  return {
    async getRecords(tab) {
      const rows = tab === 'AGENCIES' ? agencies : tab === 'PROBES' ? probes : [];
      return rows.map((obj, index) => ({ obj, rowNumber: index + 3 }));
    },
  };
}

function probe(overrides) {
  return {
    probe_id: 'prb_1', agency_id: 'ag_1', probe_status: 'observing',
    probe_timestamp: '2026-08-31T09:00:00.000Z',
    observation_deadline: '2026-09-05T09:00:00.000Z',
    property_address: 'Mill Lane, Colne Engaine, Colchester, CO6',
    property_url: '', ...overrides,
  };
}

function agency(overrides) {
  return {
    agency_id: 'ag_1', agency_name: 'Example Estates', domain: 'example.co.uk',
    primary_contact_email: 'hello@example.co.uk', other_known_emails: '',
    main_phone: '01787 479988', known_phone_numbers: '', ...overrides,
  };
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

await check('house number absent from probe: street + locality/town + outward postcode matches', async () => {
  const result = await matchInboundCommunication(repoFor({ agencies: [agency()], probes: [probe()] }), {
    channel: 'email', sender_email: 'crm@platform.invalid',
    body_text: 'Regarding 9, Mill Lane, Colne Engaine, Colchester, CO6 2HY',
  }, NOW);
  assert.equal(result.match_status, 'matched');
  assert.equal(result.probe_id, 'prb_1');
  assert.equal(result.agency_id, 'ag_1');
  assert.equal(result.matching_method, 'property_address_exact');
});

await check('exact Rightmove property id is the strongest probe match', async () => {
  const result = await matchInboundCommunication(repoFor({ agencies: [agency()], probes: [probe({ property_url: 'https://www.rightmove.co.uk/properties/89887794#/' })] }), {
    channel: 'email', body_text: 'See https://www.rightmove.co.uk/properties/89887794 for the listing.',
  }, NOW);
  assert.equal(result.probe_id, 'prb_1');
  assert.equal(result.matching_method, 'rightmove_property_id_exact');
});

await check('unknown sender + signature phone + property reconciles agency and probe', async () => {
  const result = await matchInboundCommunication(repoFor({ agencies: [agency()], probes: [probe()] }), {
    channel: 'email', sender_email: 'notifications@crm-platform.invalid',
    body_text: '9 Mill Lane, Colne Engaine, Colchester, CO6 2HY\nT: 01787 479988',
  }, NOW);
  assert.equal(result.match_status, 'matched');
  assert.equal(result.agency_id, 'ag_1');
  assert.equal(result.probe_id, 'prb_1');
  assert.equal(result.matching_method, 'multi_signal_exact');
  assert.ok(result.evidence.some((item) => item.method === 'content_phone_exact'));
});

await check('alphanumeric SMS sender resolves through strong address evidence', async () => {
  const result = await matchInboundCommunication(repoFor({ agencies: [agency()], probes: [probe()] }), {
    channel: 'sms', sender_phone: 'Viewing',
    body_text: 'Thanks for enquiring about 9, Mill Lane, Colne Engaine, Colchester, CO6 2HY!',
  }, NOW);
  assert.equal(result.match_status, 'matched');
  assert.equal(result.probe_id, 'prb_1');
  assert.equal(result.agency_id, 'ag_1');
});

await check('domain-only generic newsletter identifies agency but does not attach probe', async () => {
  const result = await matchInboundCommunication(repoFor({ agencies: [agency()], probes: [probe()] }), {
    channel: 'email', sender_email: 'marketing@example.co.uk',
    subject: 'September market newsletter', body_text: 'Local market news and company updates.',
  }, NOW);
  assert.equal(result.match_status, 'unmatched');
  assert.equal(result.agency_id, 'ag_1');
  assert.equal(result.probe_id, '');
  assert.equal(result.matching_method, 'domain_exact');
});

await check('agency identity contradicting canonical probe agency returns conflict', async () => {
  const agencies = [agency({ agency_id: 'ag_a', domain: 'agency-a.co.uk', primary_contact_email: 'reply@agency-a.co.uk' }), agency({ agency_id: 'ag_b', domain: 'agency-b.co.uk' })];
  const result = await matchInboundCommunication(repoFor({ agencies, probes: [probe({ agency_id: 'ag_b' })] }), {
    channel: 'email', sender_email: 'reply@agency-a.co.uk',
    body_text: '9 Mill Lane, Colne Engaine, Colchester, CO6 2HY',
  }, NOW);
  assert.equal(result.match_status, 'ambiguous');
  assert.equal(result.matching_method, 'conflict');
  assert.equal(result.agency_id, '');
  assert.equal(result.probe_id, '');
});

await check('generic street name alone never resolves either of two probes', async () => {
  const probes = [
    probe({ probe_id: 'prb_a', property_address: 'High Street, Billericay, CM12' }),
    probe({ probe_id: 'prb_b', agency_id: 'ag_2', property_address: 'High Street, Chelmsford, CM1' }),
  ];
  const result = await matchInboundCommunication(repoFor({ agencies: [agency(), agency({ agency_id: 'ag_2' })], probes }), {
    channel: 'sms', sender_phone: 'Property', body_text: 'Calling about High Street.',
  }, NOW);
  assert.equal(result.match_status, 'unmatched');
  assert.equal(result.probe_id, '');
});

await check('different house number still matches when street/locality/postcode agree', async () => {
  const result = await matchInboundCommunication(repoFor({ agencies: [agency()], probes: [probe({ property_address: '14 Station Road, Earls Colne, Colchester, CO6' })] }), {
    channel: 'email', body_text: 'Re: 99 Station Rd, Earls Colne, Colchester, CO6 2ER',
  }, NOW);
  assert.equal(result.match_status, 'matched');
  assert.equal(result.probe_id, 'prb_1');
});

await check('unknown voicemail caller resolves from transcript street + postcode', async () => {
  const result = await matchInboundCommunication(repoFor({ agencies: [agency()], probes: [probe()] }), {
    channel: 'voice', sender_phone: '+447700900999',
    transcript: 'Hello, this is about 9 Mill Lane in Colne Engaine, postcode CO6 2HY. Please call back.',
  }, NOW);
  assert.equal(result.match_status, 'matched');
  assert.equal(result.agency_id, 'ag_1');
  assert.equal(result.probe_id, 'prb_1');
});

const RACE_PROBE_TIMESTAMP = '2026-09-01T09:00:00.000Z';
const raceProbe = (overrides = {}) => probe({
  probe_timestamp: RACE_PROBE_TIMESTAMP,
  observation_deadline: '2026-09-05T09:00:00.000Z',
  property_url: 'https://www.rightmove.co.uk/properties/89887794',
  ...overrides,
});

await check('exact Rightmove id one second before probe timestamp is eligible and matches', async () => {
  const result = await matchInboundCommunication(repoFor({ agencies: [agency()], probes: [raceProbe()] }), {
    channel: 'email', sender_email: 'automation@crm.invalid',
    body_text: 'https://www.rightmove.co.uk/properties/89887794',
  }, new Date('2026-09-01T08:59:59.000Z'));
  assert.equal(result.match_status, 'matched');
  assert.equal(result.probe_id, 'prb_1');
  assert.equal(result.matching_method, 'rightmove_property_id_exact');
});

await check('strong property address 30 seconds before probe timestamp is eligible and matches', async () => {
  const result = await matchInboundCommunication(repoFor({ agencies: [agency()], probes: [raceProbe()] }), {
    channel: 'email', sender_email: 'automation@crm.invalid',
    body_text: '9 Mill Lane, Colne Engaine, Colchester, CO6 2HY',
  }, new Date('2026-09-01T08:59:30.000Z'));
  assert.equal(result.match_status, 'matched');
  assert.equal(result.probe_id, 'prb_1');
  assert.equal(result.matching_method, 'property_address_exact');
});

await check('exact Rightmove id four minutes before probe timestamp is eligible and matches', async () => {
  const result = await matchInboundCommunication(repoFor({ agencies: [agency()], probes: [raceProbe()] }), {
    channel: 'email', body_text: 'https://www.rightmove.co.uk/properties/89887794',
  }, new Date('2026-09-01T08:56:00.000Z'));
  assert.equal(result.match_status, 'matched');
  assert.equal(result.probe_id, 'prb_1');
});

await check('exact Rightmove id ten minutes before probe timestamp is outside tolerance', async () => {
  const result = await matchInboundCommunication(repoFor({ agencies: [agency()], probes: [raceProbe()] }), {
    channel: 'email', body_text: 'https://www.rightmove.co.uk/properties/89887794',
  }, new Date('2026-09-01T08:50:00.000Z'));
  assert.equal(result.match_status, 'unmatched');
  assert.equal(result.probe_id, '');
});

await check('generic agency newsletter one minute before probe timestamp does not attach probe', async () => {
  const result = await matchInboundCommunication(repoFor({ agencies: [agency()], probes: [raceProbe()] }), {
    channel: 'email', sender_email: 'marketing@example.co.uk',
    subject: 'September market newsletter', body_text: 'Local market news and company updates.',
  }, new Date('2026-09-01T08:59:00.000Z'));
  assert.equal(result.match_status, 'unmatched');
  assert.equal(result.agency_id, 'ag_1');
  assert.equal(result.probe_id, '');
  assert.equal(result.matching_method, 'domain_exact');
});

console.log(`\n✅ ${passed} deterministic inbound matching checks passed.`);
