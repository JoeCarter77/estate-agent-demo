#!/usr/bin/env node
// Founding-pilot acquisition test: three locked presets (A1 outcome-led, A2
// refund upfront, B probe-led) on the existing campaign layer. No network, no Sheets.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  FOUNDING_OUTCOME_TYPE, FOUNDING_OUTCOME_NAME, FOUNDING_OUTCOME_SEQUENCE,
  FOUNDING_OUTCOME_UPFRONT_TYPE, FOUNDING_OUTCOME_UPFRONT_NAME, FOUNDING_OUTCOME_UPFRONT_SEQUENCE,
  FOUNDING_PROBE_TYPE, FOUNDING_PROBE_NAME, FOUNDING_PROBE_SEQUENCE, FOUNDING_CALL_SCRIPT,
} from '../lib/founding-pilot-campaign.mjs';
import { CAMPAIGN_PRESETS, lockedPreset, isLockedCampaignType, presetForCampaignName, isPresetSequence, isMatchingInstantlyPresetCampaign } from '../lib/campaign-presets.mjs';
import { PROBE_CALL_CAMPAIGN_TYPE } from '../lib/probe-call-campaign.mjs';
import { CAMPAIGN_TYPES } from '../lib/campaign-store.mjs';
import { normaliseSequence, buildInstantlyCampaignPayload, DEFAULT_SCHEDULE, DEFAULT_SENDING } from '../lib/campaign-handlers.mjs';
import { evaluateEligibility } from '../lib/campaign-eligibility.mjs';
import { classifyReply } from '../lib/reply-classification.mjs';
import { deriveExpectedActions } from '../lib/acquisition-actions.mjs';
import { pollInstantlyReplies } from '../lib/instantly-reply-poll.mjs';
import { probeCallMetrics } from '../lib/probe-call-analytics.mjs';
import { REPLY_EVENTS_HEADER } from '../lib/reply-router.mjs';
import { buildCallingWorkspace } from '../lib/calling-queue.mjs';
import { createMemoryClaimStore, __setClaimStoreForTests } from '../lib/reply-claim.mjs';
import { preparedCohort } from '../lib/campaign-cohorts.mjs';
import { instantlyConfigurationDifferences } from '../lib/campaign-handlers.mjs';

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; console.log(`  ✓ ${label}`); };
const NOW = '2026-10-01T09:00:00.000Z';
const nowMs = Date.parse(NOW);
const table = (objects) => ({ header: [...new Set(objects.flatMap(Object.keys))], rows: objects.map((obj) => [...new Set(objects.flatMap(Object.keys))].map((key) => obj[key] ?? '')) });

const campA = { campaign_id: 'cmp_a', instantly_campaign_id: 'inst_a', campaign_type: FOUNDING_OUTCOME_TYPE, name: FOUNDING_OUTCOME_NAME };
const campB = { campaign_id: 'cmp_b', instantly_campaign_id: 'inst_b', campaign_type: FOUNDING_PROBE_TYPE, name: FOUNDING_PROBE_NAME };
const probe = { probe_id: 'pr_1', probe_status: 'closed', probe_timestamp: '2026-09-07T09:00:00Z', property_address: '10 High Street, London', probe_reference: 'RM123', enquiry_text: 'Declared: has a property to sell, not yet on the market.' };
const agency = { agency_id: 'ag_1', agency_name: 'Oak Estates', email_verification_status: 'VALID' };
const contact = { contact_id: 'ct_1', email: 'owner@oak.test', contact_name: 'Jane Smith', name: 'Jane Smith', role: 'Owner', verification_status: 'VALID', contact_type: 'OWNER_DIRECT' };
const STRICT = { requires_probe: false, allow_risky_email: false, block_active_campaign: true, block_active_conversation: true, block_active_followup: true, block_prior_negative: true, block_meeting_booked: true, block_opted_out: true };
const cand = (campaign, extra = {}) => ({ agency, contact, probe: null, campaign, replyEvents: [], actions: [], memberships: [], campaignEvents: [], salesMessages: [], stage: 'READY_TO_PROBE', ...extra });
const elig = (campaign, extra) => evaluateEligibility(cand(campaign, extra), { policy: { ...STRICT, requires_probe: lockedPreset(campaign.campaign_type).requires_probe }, nowMs });

console.log('1. Copy and presets');
const all = (seq) => seq.steps.map((s) => `${s.variants[0].subject}\n${s.variants[0].body}`).join('\n');
const body = (seq, i) => seq.steps[i].variants[0].body;
const ARMS = [FOUNDING_OUTCOME_SEQUENCE, FOUNDING_OUTCOME_UPFRONT_SEQUENCE, FOUNDING_PROBE_SEQUENCE];
const privateFiles = ['cohort-a1-refund-later.txt', 'cohort-a2-refund-upfront.txt', 'cohort-b-probe-led.txt'];
const privateIds = await Promise.all(privateFiles.map(async (filename) => (await readFile(new URL(`../docs/commercial-reset/cohorts/${filename}`, import.meta.url), 'utf8')).split(/[\s,]+/).filter(Boolean)));
const privateEnv = Object.fromEntries(['A1', 'A2', 'B'].map((key, i) => [`NOVUS_FOUNDING_COHORT_${key}_IDS`, privateIds[i].join(',')]));
await assert.rejects(() => preparedCohort(FOUNDING_OUTCOME_TYPE, {}), /not configured/);
await assert.rejects(() => preparedCohort(FOUNDING_OUTCOME_TYPE, { ...privateEnv, NOVUS_FOUNDING_COHORT_A1_IDS: 'ag_dummy' }), /incomplete/);
await assert.rejects(() => preparedCohort(FOUNDING_OUTCOME_TYPE, { ...privateEnv, NOVUS_FOUNDING_COHORT_B_IDS: [privateIds[0][0], ...privateIds[2].slice(1)].join(',') }), /overlapping/);
Object.assign(process.env, privateEnv);
const cohorts = await Promise.all([FOUNDING_OUTCOME_TYPE, FOUNDING_OUTCOME_UPFRONT_TYPE, FOUNDING_PROBE_TYPE].map((type) => preparedCohort(type)));
check('prepared cohorts contain 75, 75 and 55 unique, separate agency IDs', () => {
  assert.deepEqual(cohorts.map((c) => c.count), [75, 75, 55]);
  cohorts.forEach((cohort, i) => assert.deepEqual(cohort.ids, privateIds[i]));
  const ids = cohorts.flatMap((c) => c.ids);
  assert.equal(new Set(ids).size, ids.length);
});
check('provider read-back detects missing steps, changed copy, timing, threading and sending settings', () => {
  const expected = buildInstantlyCampaignPayload({ name: FOUNDING_OUTCOME_NAME, sequence: FOUNDING_OUTCOME_SEQUENCE, schedule: DEFAULT_SCHEDULE, sending: { ...DEFAULT_SENDING, email_list: ['joe@novushq.co.uk'] } });
  const remote = structuredClone(expected);
  assert.deepEqual(instantlyConfigurationDifferences(expected, remote), []);
  remote.sequences[0].steps[0].variants[0].body = `<div>${remote.sequences[0].steps[0].variants[0].body}</div>`;
  assert.deepEqual(instantlyConfigurationDifferences(expected, remote), []);
  remote.sequences[0].steps[2].variants[0].body += ' Changed';
  remote.sequences[0].steps[1].variants[0].subject = 'New thread';
  remote.sequences[0].steps[0].delay = 9;
  remote.daily_limit = 100;
  const differences = instantlyConfigurationDifferences(expected, remote);
  for (const part of ['step 3 body 1', 'step 2 subject 1', 'step 1 delay', 'daily_limit']) assert.ok(differences.includes(part), part);
  remote.sequences[0].steps.pop();
  assert.ok(instantlyConfigurationDifferences(expected, remote).includes('step count'));
});
check('all three founding arms are registered, locked, storable and in one cohort', () => {
  for (const type of [FOUNDING_OUTCOME_TYPE, FOUNDING_OUTCOME_UPFRONT_TYPE, FOUNDING_PROBE_TYPE, PROBE_CALL_CAMPAIGN_TYPE]) {
    assert.ok(isLockedCampaignType(type)); assert.ok(CAMPAIGN_TYPES.includes(type));
  }
  assert.equal(isLockedCampaignType('GENERAL'), false);
  for (const name of [FOUNDING_OUTCOME_NAME, FOUNDING_OUTCOME_UPFRONT_NAME, FOUNDING_PROBE_NAME]) assert.equal(presetForCampaignName(name).call_script, FOUNDING_CALL_SCRIPT);
  assert.equal(new Set([FOUNDING_OUTCOME_NAME, FOUNDING_OUTCOME_UPFRONT_NAME, FOUNDING_PROBE_NAME]).size, 3);
  assert.equal(new Set([FOUNDING_OUTCOME_TYPE, FOUNDING_OUTCOME_UPFRONT_TYPE, FOUNDING_PROBE_TYPE].map((t) => lockedPreset(t).cohort)).size, 1);
  assert.equal(lockedPreset(FOUNDING_OUTCOME_UPFRONT_TYPE).forbids_probe, true);
});
check('email 1 is the approved copy for each arm; A2 differs from A1 only by the refund', () => {
  for (const seq of ARMS) {
    assert.deepEqual(seq.steps.map((s) => s.delay_days), [0, 3, 5]);
    assert.deepEqual(seq.steps.slice(1).map((s) => s.variants[0].subject), ['', '']);
    assert.equal(body(seq, 1), body(FOUNDING_OUTCOME_SEQUENCE, 1), 'email 2 shared');
  }
  assert.equal(FOUNDING_OUTCOME_SEQUENCE.steps[0].variants[0].subject, 'Another 10 valuations?');
  assert.equal(FOUNDING_OUTCOME_UPFRONT_SEQUENCE.steps[0].variants[0].subject, 'Another 10 valuations?');
  assert.equal(FOUNDING_PROBE_SEQUENCE.steps[0].variants[0].subject, 'Quick one {{firstName}}');
  assert.match(body(FOUNDING_OUTCOME_SEQUENCE, 0), /^Hi \{\{firstName\}\},\n\nWhere would an extra 10 valuations over the next few weeks come from at \{\{agency\}\}\?/);
  assert.match(body(FOUNDING_OUTCOME_SEQUENCE, 0), /We're looking for a few founding agencies to start with\. Would it be worth me explaining how\?\n\nJoe$/);
  assert.equal(body(FOUNDING_OUTCOME_UPFRONT_SEQUENCE, 0).replace(', and we back it: £250 back for every valuation we don\'t hit.', '.'), body(FOUNDING_OUTCOME_SEQUENCE, 0));
  const b1 = body(FOUNDING_PROBE_SEQUENCE, 0).split('\n\n');
  assert.deepEqual(b1, ['Hi {{firstName}},',
    'If you could put another 10 valuations in the diary over the next few weeks, without spending more on generating enquiries, would that be of interest?',
    'I recently put a test enquiry through on one of your properties, mentioning that I had a house to sell as well.',
    "It's part of why I thought {{agency}} could be a good fit for what we're working on.",
    'Worth me sending over a little more detail?', 'Joe']);
  // B keeps A1's follow-ups; A2 has the refund in email 1, so email 3 is the soft close.
  assert.deepEqual(FOUNDING_OUTCOME_SEQUENCE.steps.slice(1), FOUNDING_PROBE_SEQUENCE.steps.slice(1));
  assert.doesNotMatch(body(FOUNDING_OUTCOME_SEQUENCE, 0) + body(FOUNDING_PROBE_SEQUENCE, 0), /£/);
  assert.match(body(FOUNDING_OUTCOME_SEQUENCE, 2), /refund £250 of the fee/);
  assert.doesNotMatch(body(FOUNDING_OUTCOME_UPFRONT_SEQUENCE, 2), /£/);
});
check('the copy never pitches the price and makes no claims we cannot support', () => {
  for (const seq of ARMS) {
    const copy = all(seq);
    assert.doesNotMatch(copy, /£2,500|£1,500/, 'no price to a stranger');
    assert.doesNotMatch(copy, /pay you|we'?re working with|our clients|case stud|guarantee|missed|ignored|failed|nobody|no-one|our view|AI\b/i);
    assert.match(copy, /won't email again/);
    // £250 is always a refund of the fee, never a payment.
    for (const m of copy.match(/[^.]*£250[^.]*/g) || []) assert.match(m, /refund £250 of the fee|£250 back for every valuation/);
  }
  assert.doesNotMatch(all(FOUNDING_OUTCOME_SEQUENCE) + all(FOUNDING_OUTCOME_UPFRONT_SEQUENCE), /\{\{property|test enquiry/);
  assert.doesNotMatch(all(FOUNDING_PROBE_SEQUENCE), /\{\{property/, 'no property merge field to go wrong');
});
check('Instantly payload round-trips and the draft check rejects drift', () => {
  for (const type of [FOUNDING_OUTCOME_TYPE, FOUNDING_OUTCOME_UPFRONT_TYPE, FOUNDING_PROBE_TYPE]) {
    const preset = lockedPreset(type);
    assert.ok(isPresetSequence(preset, normaliseSequence(preset.sequence).sequence));
    const payload = buildInstantlyCampaignPayload({ name: preset.name, sequence: preset.sequence, schedule: DEFAULT_SCHEDULE, sending: DEFAULT_SENDING });
    assert.deepEqual(payload.sequences[0].steps.map((s) => s.delay), [3, 5, 0]);
    assert.equal(payload.stop_on_reply, true);
    assert.equal(isMatchingInstantlyPresetCampaign(preset, { ...payload, status: 0 }), true);
    assert.equal(isMatchingInstantlyPresetCampaign(preset, { ...payload, status: 1 }), false, 'already active');
    assert.equal(isMatchingInstantlyPresetCampaign(preset, { ...payload, status: 0, stop_on_reply: false }), false);
  }
  const payloadA = buildInstantlyCampaignPayload({ name: FOUNDING_OUTCOME_NAME, sequence: FOUNDING_OUTCOME_SEQUENCE, schedule: DEFAULT_SCHEDULE, sending: DEFAULT_SENDING });
  // Instantly re-wrapping the same words in its own HTML is still the approved copy…
  const rewrap = (p, fn) => ({ ...p, status: 0, sequences: [{ steps: p.sequences[0].steps.map((s) => ({ ...s, variants: s.variants.map((v) => ({ ...v, body: fn(v.body) })) })) }] });
  const html = (b) => b.split('<br/>').map((line) => `<div>${line.replace(/£/g, '&pound;').replace(/'/g, '&#39;') || '<br>'}</div>`).join('');
  assert.equal(isMatchingInstantlyPresetCampaign(CAMPAIGN_PRESETS[FOUNDING_OUTCOME_TYPE], rewrap(payloadA, html)), true, 'Instantly markup');
  // …but a changed word is not.
  assert.equal(isMatchingInstantlyPresetCampaign(CAMPAIGN_PRESETS[FOUNDING_OUTCOME_TYPE], rewrap(payloadA, (b) => b.replace('£250', '£500'))), false, 'edited copy');
  assert.equal(isMatchingInstantlyPresetCampaign(CAMPAIGN_PRESETS[FOUNDING_PROBE_TYPE], { ...payloadA, status: 0 }), false, 'A1 copy under the B check');
  assert.equal(isMatchingInstantlyPresetCampaign(CAMPAIGN_PRESETS[FOUNDING_OUTCOME_UPFRONT_TYPE], { ...payloadA, name: FOUNDING_OUTCOME_UPFRONT_NAME, status: 0 }), false, 'A1 copy under the A2 check');
});

console.log('2. Cohort eligibility');
check('A takes a never-probed owner; B needs a closed probe with a seller signal', () => {
  assert.equal(elig(campA).status, 'READY');
  assert.ok(elig(campA, { probe }).blocks.includes('HAS_PROBE'));
  assert.equal(elig(campB, { probe, stage: 'PROBE_COMPLETE' }).status, 'READY');
  assert.ok(elig(campB).blocks.includes('MISSING_PROBE'));
  assert.ok(elig(campB, { probe: { ...probe, enquiry_text: '' } }).blocks.includes('NO_SELLER_SIGNAL'));
  assert.ok(elig(campB, { probe: { ...probe, probe_status: 'sent' } }).blocks.includes('PROBE_NOT_CLOSED'));
  assert.ok(elig(campA, { contact: { ...contact, email: 'bad' } }).blocks.includes('INVALID_EMAIL_FORMAT'));
});
check('an agency can never sit in both arms, even while the other is still a draft', () => {
  const inB = { campaign_id: campB.campaign_id, campaign_type: FOUNDING_PROBE_TYPE, campaign_status: 'DRAFT', member_status: 'SELECTED' };
  const inA = { campaign_id: campA.campaign_id, campaign_type: FOUNDING_OUTCOME_TYPE, campaign_status: 'COMPLETED', member_status: 'PUSHED', instantly_lead_status: 'COMPLETED' };
  assert.ok(elig(campA, { memberships: [inB] }).blocks.includes('IN_OTHER_COHORT'));
  assert.ok(elig(campB, { probe, memberships: [inA] }).blocks.includes('IN_OTHER_COHORT'));
  const campA2 = { campaign_id: 'cmp_a2', campaign_type: FOUNDING_OUTCOME_UPFRONT_TYPE };
  assert.ok(elig(campA2, { memberships: [inA] }).blocks.includes('IN_OTHER_COHORT'), 'A1 and A2 never overlap');
  assert.ok(elig(campA2, { probe }).blocks.includes('HAS_PROBE'));
  assert.ok(!elig(campA, { memberships: [{ ...inB, member_status: 'EXCLUDED' }] }).blocks.includes('IN_OTHER_COHORT'), 'an excluded row is not membership');
  assert.ok(!elig(campA, { memberships: [{ campaign_id: 'cmp_gen', campaign_type: 'GENERAL', campaign_status: 'COMPLETED', member_status: 'PUSHED', instantly_lead_status: 'COMPLETED' }] }).blocks.includes('IN_OTHER_COHORT'));
  // Its own membership is handled by ALREADY_IN_CAMPAIGN, not the cohort rule.
  assert.ok(!elig(campA, { memberships: [{ campaign_id: campA.campaign_id, campaign_type: FOUNDING_OUTCOME_TYPE, member_status: 'SELECTED' }] }).blocks.includes('IN_OTHER_COHORT'));
});
check('the probe-call preset is untouched by the cohort rules', () => {
  const probeCall = { campaign_id: 'cmp_p', campaign_type: PROBE_CALL_CAMPAIGN_TYPE };
  const r = evaluateEligibility(cand(probeCall, { probe, stage: 'PROBE_COMPLETE', memberships: [{ campaign_id: campA.campaign_id, campaign_type: FOUNDING_OUTCOME_TYPE, member_status: 'SELECTED' }] }), { policy: { ...STRICT, requires_probe: true }, nowMs });
  assert.ok(!r.blocks.includes('IN_OTHER_COHORT') && !r.blocks.includes('HAS_PROBE'));
});

console.log('3. Replies → call actions → Calling Mode');
const decides = (body) => classifyReply({ cleaned_reply_text: body, raw_body_text: body, is_auto_reply: false }, { aiCall: async () => { throw new Error('no AI'); } });
for (const body of ['Yes, happy to chat.', 'Give me a ring on 07700 900123.']) {
  const decision = await decides(body);
  check(`"${body}" is a call request without AI`, () => assert.equal(decision.classification, 'CALL_REQUESTED'));
}

const members = [
  { member_id: 'mem_a', campaign_id: campA.campaign_id, agency_id: 'ag_a', email: 'a@owner.test', instantly_lead_id: 'lead_a' },
  { member_id: 'mem_b', campaign_id: campB.campaign_id, agency_id: 'ag_b', probe_id: probe.probe_id, email: 'b@owner.test', instantly_lead_id: 'lead_b' },
];
const replyStore = { OUTBOUND: table([]), CAMPAIGNS: table([campA, campB]), CAMPAIGN_MEMBERS: table(members), REPLY_EVENTS: { header: [...REPLY_EVENTS_HEADER], rows: [] } };
const replyRepo = {
  async getTable(name) { if (!replyStore[name]) throw new Error(`Missing ${name}`); return replyStore[name]; },
  async getRecords(name) { const source = await this.getTable(name); return source.rows.map((row, index) => ({ rowNumber: index + 2, obj: Object.fromEntries(source.header.map((key, i) => [key, row[i] ?? ''])) })); },
  async appendRecord(name, obj) { const source = await this.getTable(name); source.rows.push(source.header.map((key) => obj[key] ?? '')); },
  async writeCellsBatch(writes) { for (const write of writes) replyStore[write.tab].rows[write.rowNumber - 2][write.columnNumber - 1] = write.value; },
};
__setClaimStoreForTests(createMemoryClaimStore());
const mail = (id, from, leadId, campaignId, text) => ({ id, ue_type: 2, timestamp_email: NOW, from_address_email: from, to_address_email_list: 'joe@novushq.co.uk', lead: from, lead_id: leadId, eaccount: 'joe@novushq.co.uk', campaign_id: campaignId, thread_id: `t_${id}`, subject: 'Re: 10 more valuations?', content_preview: text });
const inbox = [mail('m_a', 'a@owner.test', 'lead_a', 'inst_a', 'Yes, happy to chat.'), mail('m_b', 'b@owner.test', 'lead_b', 'inst_b', 'Call me on 07700 900123.')];
const fetchImpl = async (url) => ({ ok: true, text: async () => JSON.stringify(url.includes('email_type=received') ? { items: inbox } : { items: [] }) });
// classify:false is production: semantic classification is off, locked presets still classify deterministically.
const poll = await pollInstantlyReplies({ repo: replyRepo, apiKey: 'test-only', fetchImpl, dryRun: false, classify: false, now: NOW, mailboxes: ['joe@novushq.co.uk'] });
check('replies to both arms are matched to their member, classified and marked CRITICAL', () => {
  assert.equal(poll.persisted, 2);
  const byAgency = Object.fromEntries(poll.events.map((e) => [e.row.agency_id, e.row]));
  for (const [agencyId, type] of [['ag_a', FOUNDING_OUTCOME_TYPE], ['ag_b', FOUNDING_PROBE_TYPE]]) {
    assert.equal(byAgency[agencyId].classification, 'CALL_REQUESTED');
    assert.equal(byAgency[agencyId].priority, 'CRITICAL');
    assert.equal(JSON.parse(byAgency[agencyId].notes).source_campaign_type, type);
  }
  assert.equal(JSON.parse(byAgency.ag_b.notes).probe_id, probe.probe_id);
});

const actionFor = (campaign, body, extra = {}) => deriveExpectedActions({
  ...cand(campaign), contacts: [contact], probes: [], stage: 'MEETING_INTENT', now: NOW, nowMs,
  replyEvents: [{ reply_event_id: 'rep_1', classification: 'CALL_REQUESTED', lead_email: contact.email, body_text: body, cleaned_reply_text: body, received_at: NOW, campaign_id: campaign.instantly_campaign_id, notes: JSON.stringify({ source_campaign_type: campaign.campaign_type, source_campaign_name: campaign.name, probe_id: '' }) }],
  ...extra,
}, NOW)[0];
check('an outcome-led reply with no probe still becomes a CRITICAL call action', () => {
  const action = actionFor(campA, 'Call me on 07700 900123.');
  const meta = JSON.parse(action.metadata_json);
  assert.equal(action.action_type, 'CALL_PROSPECT');
  assert.equal(meta.priority, 'CRITICAL');
  assert.equal(meta.phone.normalised, '+447700900123');
  const noNumber = JSON.parse(actionFor(campA, 'Yes, happy to chat.').metadata_json);
  assert.equal(noNumber.number_required, true);
  assert.match(actionFor(campA, 'Yes, happy to chat.').reason, /owner accepted a call — obtain a callback number/);
});

check('an unfinished founding sequence holds the agency out of the cold-call pool, and releases it when done', () => {
  const tables = (memberPatch = {}, campaignPatch = {}) => ({
    AGENCIES: table([{ agency_id: 'ag_b', agency_name: 'Birch', main_phone: '020 7946 0000' }, { agency_id: 'ag_c', agency_name: 'Cedar', main_phone: '020 7946 0001' }]),
    PROBES: table([{ probe_id: 'p_b', agency_id: 'ag_b', probe_status: 'closed', probe_timestamp: '2026-09-07T09:00:00Z' }, { probe_id: 'p_c', agency_id: 'ag_c', probe_status: 'closed', probe_timestamp: '2026-09-07T09:00:00Z' }]),
    CAMPAIGNS: table([{ ...campB, status: 'ACTIVE', ...campaignPatch }]),
    CAMPAIGN_MEMBERS: table([{ member_id: 'mem_b', campaign_id: campB.campaign_id, agency_id: 'ag_b', member_status: 'PUSHED', instantly_lead_status: 'ACTIVE', ...memberPatch }]),
  });
  const pool = (t) => buildCallingWorkspace(t, { now: NOW });
  const held = pool(tables());
  assert.deepEqual(held.queue.map((l) => l.agency_id), ['ag_c']);
  assert.equal(held.counts.in_email_test, 1);
  assert.deepEqual(pool(tables({ instantly_lead_status: 'COMPLETED' })).queue.map((l) => l.agency_id).sort(), ['ag_b', 'ag_c']);
  assert.deepEqual(pool(tables({}, { status: 'COMPLETED' })).queue.map((l) => l.agency_id).sort(), ['ag_b', 'ag_c']);
  assert.deepEqual(pool(tables({}, { campaign_type: 'GENERAL' })).queue.map((l) => l.agency_id).sort(), ['ag_b', 'ag_c']);
});

console.log('3b. Interested replies, ambiguity and timed deferrals');
{
  const { reconcileActions } = await import('../lib/acquisition-actions.mjs');
  const { replyCallbackTiming } = await import('../lib/reply-call-context.mjs');
  const ctx = (seq) => ({ previous_novus_message: seq.steps[0].variants[0].body });
  const cls = async (b, c) => (await classifyReply({ cleaned_reply_text: b, raw_body_text: b, is_auto_reply: false }, { context: c, aiCall: async () => { throw new Error('no AI'); } })).classification;
  const interested = [['Yes please', ctx(FOUNDING_OUTCOME_SEQUENCE)], ['Go on then', ctx(FOUNDING_PROBE_SEQUENCE)], ['Sure, send it over', ctx(FOUNDING_PROBE_SEQUENCE)], ['Sounds interesting', null], ['Sounds interesting, how does it work?', null], ["We'd be interested", null], ['Tell me more', null]];
  const results = await Promise.all(interested.map(([b, c]) => cls(b, c)));
  check('clear interest is POSITIVE_INTEREST without AI (and never a demo send)', () => results.forEach((r, i) => assert.equal(r, 'POSITIVE_INTEREST', interested[i][0])));
  const ambiguous = await Promise.all([['yes', null], ['Maybe, not sure', ctx(FOUNDING_OUTCOME_SEQUENCE)], ['Who are you?', ctx(FOUNDING_OUTCOME_SEQUENCE)], ['Not interested', ctx(FOUNDING_OUTCOME_SEQUENCE)], ['Sounds interesting but not right now', null]].map(([b, c]) => cls(b, c)));
  check('ambiguity stays in review; negatives and hedges are not interest', () => {
    assert.deepEqual(ambiguous.slice(0, 3), ['OTHER_UNCLEAR', 'OTHER_UNCLEAR', 'OTHER_UNCLEAR']);
    assert.equal(ambiguous[3], 'NOT_INTERESTED');
    assert.notEqual(ambiguous[4], 'POSITIVE_INTEREST');
  });
  const replyRow = (classification, body) => ({ reply_event_id: 'rep_i', classification, lead_email: contact.email, body_text: body, cleaned_reply_text: body, received_at: NOW, campaign_id: campA.instantly_campaign_id,
    notes: JSON.stringify({ source_campaign_type: campA.campaign_type, source_campaign_name: campA.name, probe_id: '' }) });
  const derive = (classification, body, actions = []) => deriveExpectedActions({ ...cand(campA), contacts: [contact], probes: [], actions, stage: 'REPLIED_NEEDS_HUMAN', stageReason: `latest reply classification is ${classification}`, now: NOW, nowMs, replyEvents: [replyRow(classification, body)] }, NOW)[0];
  const action = derive('POSITIVE_INTEREST', 'Yes please');
  check('an interested reply is a HIGH-priority reply action carrying the reply and campaign', () => {
    assert.equal(action.action_type, 'HUMAN_REPLY');
    assert.equal(action.action_owner, 'JOE');
    assert.equal(action.reply_event_id, 'rep_i');
    const meta = JSON.parse(action.metadata_json);
    assert.equal(meta.priority, 'HIGH'); assert.equal(meta.interested, true);
    assert.equal(meta.reply_text, 'Yes please'); assert.equal(meta.reply_event_id, 'rep_i');
    assert.equal(meta.campaign_name, FOUNDING_OUTCOME_NAME);
    const info = JSON.parse(derive('INFO_REQUESTED', 'Send me more details').metadata_json);
    assert.equal(info.priority, 'HIGH'); assert.equal(info.interested, true);
    assert.equal(derive('OTHER_UNCLEAR', 'yes').action_type, 'MANUAL_REVIEW');
    assert.equal(derive('OTHER_UNCLEAR', 'yes').metadata_json, '{}');
  });
  check('reconciliation is idempotent for the interested action (same dedupe key, no duplicate)', () => {
    const stored = { ...action, action_id: 'act_i', action_status: 'DUE' };
    const plan = reconcileActions([stored], [derive('POSITIVE_INTEREST', 'Yes please', [stored])], NOW);
    assert.equal(plan.create.length, 0); assert.equal(plan.cancel.length, 0);
  });
  const deferral = await cls('Try me in January', ctx(FOUNDING_OUTCOME_SEQUENCE));
  check('"Try me in January" is NOT_NOW, scheduled for the first working day of January', () => {
    assert.equal(deferral, 'NOT_NOW');
    const a = derive('NOT_NOW', 'Try me in January');
    assert.equal(a.action_type, 'SET_NEXT_STEP');
    assert.equal(a.due_at, '2027-01-04T09:00:00.000Z');
    assert.equal(replyCallbackTiming('you may want to look', NOW, NOW).precision, 'NOW', 'modal "may" is not May');
    assert.equal(replyCallbackTiming('try me in October', NOW, NOW).due_at, '', 'current month goes to review');
  });
}

console.log('3c. Lead profile and unified timeline');
{
  const { buildLeadProfile, buildLeadTimeline } = await import('../lib/lead-timeline.mjs');
  const T = {
    AGENCIES: table([{ agency_id: 'ag_p', agency_name: 'Pine Estates', location: 'Ely', main_phone: '01353 000000', website: 'pine.test', outreach_contact_email: 'sam@pine.test', outreach_contact_name: 'Sam' }]),
    CONTACTS: table([{ contact_id: 'ct_p', agency_id: 'ag_p', contact_name: 'Sam Pine', contact_role: 'Director', email: 'sam@pine.test', verification_status: 'VALID' }]),
    PROBES: table([{ probe_id: 'pr_p', agency_id: 'ag_p', probe_status: 'closed', probe_timestamp: '2026-09-05T09:00:00Z', property_street: 'Mill Lane', enquiry_text: 'Buyer with a property to sell' }]),
    INTELLIGENCE: table([{ intelligence_id: 'in_p', probe_id: 'pr_p', agency_id: 'ag_p', human_contact: 'yes', response_hours: '2', seller_recognition: 'none' }]),
    REPLY_EVENTS: table([{ reply_event_id: 'r_p', agency_id: 'ag_p', lead_email: 'sam@pine.test', classification: 'POSITIVE_INTEREST', cleaned_reply_text: 'Yes please', received_at: '2026-10-01T08:00:00Z' }]),
    SALES_MESSAGES: table([{ sales_message_id: 'sm_p', agency_id: 'ag_p', outreach_id: 'cmm_p', send_outcome: 'SENT', message_type: 'MANUAL_REPLY', body_text: 'Great', sent_at: '2026-10-01T09:30:00Z' }]),
    CALLS: table([{ call_id: 'c1', agency_id: 'ag_p', started_at: '2026-10-02T10:00:00Z', outcome: 'BOOKED_MEETING', owner_reached: 'TRUE', gatekeeper_reached: 'TRUE', script_id: 's1', useful_note: 'Keen' },
      { call_id: 'c2', agency_id: 'ag_p', started_at: '2026-10-02T09:00:00Z', outcome: '', call_status: 'discarded' }]),
    SCRIPTS: table([{ script_id: 's1', name: 'Founding Pilot — Owner', version: '1' }]),
    CALL_OBJECTION_EVENTS: table([{ event_id: 'oe1', agency_id: 'ag_p', objection_title: 'How much does it cost?' }]),
    ACTIONS: table([{ action_id: 'a1', agency_id: 'ag_p', action_type: 'HUMAN_REPLY', action_status: 'DUE', due_at: '2026-09-30T08:00:00Z', action_owner: 'JOE', metadata_json: JSON.stringify({ priority: 'HIGH', interested: true }) },
      { action_id: 'a2', agency_id: 'ag_p', action_type: 'CALL_PROSPECT', action_status: 'COMPLETED', completed_at: '2026-10-02T10:05:00Z' }]),
    DISCOVERY_SESSIONS: table([{ session_id: 'dsc_p', agency_id: 'ag_p', meeting_at: '2026-10-09T10:00:00Z', status: 'COMPLETED', outcome: 'FOLLOW_UP_REQUIRED', completed_at: '2026-10-09T10:45:00Z', follow_up_at: '2026-11-02T09:00:00Z',
      conclusion_json: JSON.stringify({ agreement: { f1: { status: 'AGREED' }, f2: { status: 'CORRECTED' } } }) }]),
  };
  const P = buildLeadProfile(T, 'ag_p', { now: NOW });
  check('the profile carries identity, contacts, probes, email, calls, work and meetings from stored rows only', () => {
    assert.equal(P.identity.agency_name, 'Pine Estates'); assert.equal(P.identity.main_phone, '01353 000000');
    assert.equal('branch_count' in P.identity, false, 'absent data stays absent');
    assert.equal(P.contacts[0].contact_role, 'Director');
    assert.equal(P.probes[0].property_street, 'Mill Lane'); assert.equal(P.probes[0].assessment.seller_recognition, 'none');
    assert.deepEqual([P.email.replies_received, P.email.manual_replies_sent], [1, 1]);
    assert.deepEqual([P.calls.attempts, P.calls.owner_conversations, P.calls.gatekeeper_conversations], [1, 1, 1], 'discarded calls excluded');
    assert.equal(P.calls.recent[0].script, 'Founding Pilot — Owner v1');
    assert.deepEqual(P.calls.objections, ['How much does it cost?']);
    assert.equal(P.work.open.length, 1); assert.equal(P.work.open[0].interested, true); assert.equal(P.work.open[0].overdue, true);
    assert.equal(P.work.completed_count, 1);
    assert.equal(P.meetings[0].findings_agreed, 1); assert.equal(P.meetings[0].findings_corrected, 1);
    assert.equal(P.suppression.email_opted_out, false);
    assert.equal(buildLeadProfile(T, 'nope', { now: NOW }), null);
  });
  const TL = buildLeadTimeline(T, 'ag_p', { now: NOW });
  check('the timeline interleaves probe, reply, sent reply, call and meeting with their original timestamps', () => {
    const kinds = TL.entries.filter((e) => !e.future).map((e) => e.kind);
    assert.deepEqual([...new Set(kinds)], ['probe', 'reply', 'sales', 'call', 'action', 'meeting']);
    assert.ok(TL.entries.some((e) => e.type === 'DISCOVERY_COMPLETED' && e.at === '2026-10-09T10:45:00Z'));
    assert.ok(TL.entries.some((e) => e.type === 'MEETING_FOLLOW_UP' && e.future));
    assert.equal(TL.counts.meeting, 3);
  });
}

console.log('4. Funnel metrics');
check('human replies exclude out-of-office; every stage is counted from its own record', () => {
  const m = probeCallMetrics(campA, [{ agency_id: 'ag_a', meeting_booked_at: NOW }], [{ event_type: 'EMAIL_SENT' }, { event_type: 'EMAIL_SENT' }], {
    REPLY_EVENTS: table([
      { reply_event_id: 'r1', agency_id: 'ag_a', campaign_id: 'inst_a', classification: 'CALL_REQUESTED', body_text: 'yes' },
      { reply_event_id: 'r2', agency_id: 'ag_x', campaign_id: 'inst_a', classification: 'OOO_AUTOMATED', body_text: 'away' },
      { reply_event_id: 'r3', agency_id: 'ag_y', campaign_id: 'inst_a', classification: 'NOT_INTERESTED', body_text: 'no' },
      { reply_event_id: 'r4', agency_id: 'ag_z', campaign_id: 'inst_b', classification: 'CALL_REQUESTED', body_text: 'other arm' },
    ]),
    ACTIONS: table([]), CALLS: table([]),
    DISCOVERY_SESSIONS: table([{ session_id: 's1', agency_id: 'ag_a', status: 'COMPLETED', outcome: 'FOLLOW_UP_REQUIRED' }]),
  });
  assert.deepEqual([m.actual_emails_sent, m.human_replies, m.interested_replies, m.meetings_booked, m.meetings_attended, m.pilots_agreed, m.pilots_sold], [2, 2, 1, 1, 1, 0, null]);
});

console.log(`\n✅ novus-founding-pilot-selftest: ${checks} checks passed`);
