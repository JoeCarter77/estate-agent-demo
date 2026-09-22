#!/usr/bin/env node
import assert from 'node:assert/strict';
import { PROBE_CALL_CAMPAIGN_NAME, PROBE_CALL_CAMPAIGN_TYPE, PROBE_CALL_SEQUENCE, PROBE_CALL_SCRIPT, isProbeCallSequence, isMatchingInstantlyProbeCallCampaign } from '../lib/probe-call-campaign.mjs';
import { normaliseSequence, buildInstantlyCampaignPayload, DEFAULT_SCHEDULE, DEFAULT_SENDING } from '../lib/campaign-handlers.mjs';
import { evaluateEligibility } from '../lib/campaign-eligibility.mjs';
import { leadPayloadFor } from '../lib/campaign-audience.mjs';
import { classifyReply } from '../lib/reply-classification.mjs';
import { replyPhoneNumbers, replyCallbackTiming } from '../lib/reply-call-context.mjs';
import { deriveExpectedActions, reconcileActions } from '../lib/acquisition-actions.mjs';
import { matchCampaignMemberDeterministically, matchReplyDeterministically, pollInstantlyReplies } from '../lib/instantly-reply-poll.mjs';
import { probeCallMetrics } from '../lib/probe-call-analytics.mjs';
import { REPLY_EVENTS_HEADER } from '../lib/reply-router.mjs';
import { createMemoryClaimStore, __setClaimStoreForTests } from '../lib/reply-claim.mjs';

const NOW = '2026-09-22T09:00:00.000Z';
const campaign = { campaign_id: 'cmp_probe', instantly_campaign_id: 'inst_probe', campaign_type: PROBE_CALL_CAMPAIGN_TYPE, name: PROBE_CALL_CAMPAIGN_NAME };
const probe = { probe_id: 'pr_1', probe_status: 'closed', probe_timestamp: '2026-09-20T09:00:00Z', property_address: '10 High Street, London', probe_reference: 'RM123', enquiry_text: 'Declared: has a property to sell, not yet on the market.' };
const agency = { agency_id: 'ag_1', agency_name: 'Oak Estates', email_verification_status: 'VALID' };
const contact = { contact_id: 'ct_1', email: 'owner@oak.test', contact_name: 'Jane Smith', name: 'Jane Smith', role: 'Owner', verification_status: 'VALID', contact_type: 'OWNER_DIRECT' };
const base = () => ({ agency, contact, probe, campaign, replyEvents: [], actions: [], memberships: [], campaignEvents: [], salesMessages: [], stage: 'PROBE_COMPLETE' });
const decides = (body, context = {}) => classifyReply({ cleaned_reply_text: body, raw_body_text: body, is_auto_reply: false }, { context, aiCall: async () => { throw new Error('no AI'); } });
const table = (objects) => ({ header: [...new Set(objects.flatMap(Object.keys))], rows: objects.map((obj) => [...new Set(objects.flatMap(Object.keys))].map((key) => obj[key] ?? '')) });

assert.equal(PROBE_CALL_SEQUENCE.steps.length, 4);
assert.deepEqual(PROBE_CALL_SEQUENCE.steps.map((step) => step.delay_days), [0, 2, 4, 5]);
assert.ok(isProbeCallSequence(normaliseSequence(PROBE_CALL_SEQUENCE).sequence));
const payload = buildInstantlyCampaignPayload({ name: campaign.name, sequence: PROBE_CALL_SEQUENCE, schedule: DEFAULT_SCHEDULE, sending: DEFAULT_SENDING });
assert.deepEqual(payload.sequences[0].steps.map((step) => step.delay), [2, 4, 5, 0]);
assert.deepEqual(payload.sequences[0].steps.map((step) => step.variants[0].subject), ['Quick one about {{property}}', '', '', '']);
assert.equal(payload.stop_on_reply, true);
assert.equal(isMatchingInstantlyProbeCallCampaign({ ...payload, status: 0 }), true);
assert.equal(isMatchingInstantlyProbeCallCampaign({ ...payload, status: 1 }), false);
assert.equal(isMatchingInstantlyProbeCallCampaign({ ...payload, status: 0, stop_on_reply: false }), false);
assert.match(PROBE_CALL_SCRIPT, /discovery and demonstration meeting/);
assert.equal(leadPayloadFor({ agency_id: 'ag_1', agency_name: 'Oak Estates', contact: { email: contact.email, first_name: 'Jane' }, probe: { property: '10 High Street' } }, { campaignId: campaign.campaign_id }).custom_variables.property, '10 High Street');
assert.equal(evaluateEligibility(base(), { nowMs: Date.parse(NOW) }).status, 'READY');
for (const [change, reason] of [
  [{ probe: { ...probe, probe_status: 'draft' } }, 'MISSING_PROBE'],
  [{ probe: { ...probe, property_address: '' } }, 'MISSING_PROPERTY'],
  [{ probe: { ...probe, enquiry_text: '' } }, 'NO_SELLER_SIGNAL'],
  [{ contact: { ...contact, email: 'bad', verification_status: 'VALID' } }, 'INVALID_EMAIL_FORMAT'],
  [{ replyEvents: [{ classification: 'CALL_REQUESTED' }] }, 'ACTIVE_CONVERSATION'],
  [{ replyEvents: [{ classification: 'OPT_OUT', suppression_type: 'PERMANENT' }] }, 'OPTED_OUT'],
  [{ memberships: [{ campaign_id: 'cmp_other', campaign_status: 'ACTIVE', member_status: 'PUSHED', instantly_lead_status: 'ACTIVE' }] }, 'IN_ACTIVE_CAMPAIGN'],
  [{ stage: 'MEETING_BOOKED' }, 'MEETING_BOOKED'],
]) assert.ok(evaluateEligibility({ ...base(), ...change }, { nowMs: Date.parse(NOW) }).blocks.includes(reason), reason);

for (const body of ['Yeah Joe, give me a ring on 07700 900123.', 'Sure, my mobile is +44 7700 900123.', 'Call me tomorrow on 07700 900123.', 'Yes, happy to chat.']) {
  assert.equal((await decides(body)).classification, 'CALL_REQUESTED', body);
}
assert.equal(replyPhoneNumbers('Sure, my mobile is +44 7700 900123.')[0].normalised, '+447700900123');
assert.deepEqual(replyPhoneNumbers('Yes, happy to chat.\nRegards,\nJane\n07700 900123'), []);
assert.deepEqual(replyPhoneNumbers('Yes, happy to chat.\nOn Mon, 21 Sep 2026 at 09:00, Joe wrote:\n> Call 07700 900123'), []);
assert.deepEqual(replyPhoneNumbers('Address: 07700 900123'), []);
assert.equal(replyCallbackTiming('Call me on 25 September 2026 at 2pm', NOW, NOW).due_at, '2026-09-25T13:00:00.000Z');
assert.equal((await decides('Please remove me from your list')).classification, 'OPT_OUT');

const sourceNotes = JSON.stringify({ source_campaign_type: PROBE_CALL_CAMPAIGN_TYPE, source_campaign_name: campaign.name, probe_id: probe.probe_id });
const evidence = (body, actionRows = []) => ({ ...base(), contacts: [contact], probes: [probe], intelligence: { grade_reason: 'Potential seller opportunity in the enquiry' },
  replyEvents: [{ reply_event_id: 'rep_1', classification: 'CALL_REQUESTED', lead_email: contact.email, body_text: body, cleaned_reply_text: body, received_at: NOW, campaign_id: campaign.instantly_campaign_id, notes: sourceNotes }],
  actions: actionRows, stage: 'MEETING_INTENT', now: NOW, nowMs: Date.parse(NOW) });
const action = deriveExpectedActions(evidence('Sure, my mobile is 07700 900123.'), NOW)[0];
const meta = JSON.parse(action.metadata_json);
assert.equal(action.action_type, 'CALL_PROSPECT');
assert.equal(meta.priority, 'CRITICAL');
assert.equal(meta.phone.normalised, '+447700900123');
assert.equal(action.probe_id, probe.probe_id);
assert.equal(meta.property, '10 High Street');
assert.equal(meta.probe_reference, 'RM123');
assert.equal(meta.campaign_name, campaign.name);
const noNumber = deriveExpectedActions(evidence('Yes, happy to chat.'), NOW)[0];
assert.equal(JSON.parse(noNumber.metadata_json).number_required, true);
assert.equal(JSON.parse(noNumber.metadata_json).needs_review, true);
assert.equal(reconcileActions([action], [action], NOW).create.length, 0);
assert.equal(reconcileActions([{ ...action, action_id: 'act_1', metadata_json: '{}' }], [action], NOW).update.length, 1);
assert.equal(reconcileActions([{ ...action, action_id: 'act_1', action_status: 'PENDING' }], [], NOW).cancel.length, 1);
assert.deepEqual(deriveExpectedActions({ ...evidence('Yes, happy to chat.'), stage: 'MEETING_BOOKED' }, NOW), []);

const matched = matchCampaignMemberDeterministically(
  [{ obj: campaign }],
  [{ obj: { member_id: 'mem_1', campaign_id: campaign.campaign_id, agency_id: agency.agency_id, probe_id: probe.probe_id, email: contact.email, instantly_lead_id: 'lead_1' } }],
  { campaign_id: campaign.instantly_campaign_id, lead_id: 'lead_1', lead_email: contact.email },
);
assert.equal(matched.status, 'MATCHED');
assert.equal(matched.match.agency_id, agency.agency_id);
assert.equal(matched.match.probe_id, probe.probe_id);
assert.equal(matchReplyDeterministically({
  outboundRecords: [{ obj: { outbound_id: 'old_outbound', agency_id: 'wrong_agency', outreach_contact_email: contact.email } }],
  campaignRecords: [{ obj: campaign }],
  campaignMemberRecords: [{ obj: { member_id: 'mem_1', campaign_id: campaign.campaign_id, agency_id: agency.agency_id, probe_id: probe.probe_id, email: contact.email, instantly_lead_id: 'lead_1' } }],
  reply: { campaign_id: campaign.instantly_campaign_id, lead_id: 'lead_1', lead_email: contact.email },
}).match.agency_id, agency.agency_id);
assert.equal(matchCampaignMemberDeterministically([{ obj: campaign }], [{ obj: { member_id: 'mem_2', campaign_id: campaign.campaign_id, agency_id: 'ag_2', email: contact.email } }, { obj: { member_id: 'mem_3', campaign_id: campaign.campaign_id, agency_id: 'ag_3', email: contact.email } }], { campaign_id: campaign.instantly_campaign_id, lead_email: contact.email }).status, 'AMBIGUOUS');
const replyStore = {
  OUTBOUND: table([]),
  CAMPAIGNS: table([campaign]),
  CAMPAIGN_MEMBERS: table([{ member_id: 'mem_1', campaign_id: campaign.campaign_id, agency_id: agency.agency_id, probe_id: probe.probe_id, email: contact.email, instantly_lead_id: 'lead_1' }]),
  REPLY_EVENTS: { header: [...REPLY_EVENTS_HEADER], rows: [] },
};
const replyRepo = {
  async getTable(name) { if (!replyStore[name]) throw new Error(`Missing ${name}`); return replyStore[name]; },
  async getRecords(name) { const source = await this.getTable(name); return source.rows.map((row, index) => ({ rowNumber: index + 2, obj: Object.fromEntries(source.header.map((key, i) => [key, row[i] ?? ''])) })); },
  async appendRecord(name, obj) { const source = await this.getTable(name); source.rows.push(source.header.map((key) => obj[key] ?? '')); },
  async writeCellsBatch(writes) { for (const write of writes) replyStore[write.tab].rows[write.rowNumber - 2][write.columnNumber - 1] = write.value; },
};
__setClaimStoreForTests(createMemoryClaimStore());
const inbox = [{ id: 'reply_mail_1', ue_type: 2, timestamp_email: NOW, from_address_email: contact.email, to_address_email_list: 'joe@novushq.co.uk', lead: contact.email, lead_id: 'lead_1', eaccount: 'joe@novushq.co.uk', campaign_id: campaign.instantly_campaign_id, thread_id: 'thread_1', subject: 'Re: Quick one about 10 High Street', content_preview: 'Sure, my mobile is 07700 900123.' }];
const fetchImpl = async (url) => ({ ok: true, text: async () => JSON.stringify(url.includes('email_type=received') ? { items: inbox } : { items: [] }) });
const pollOptions = { repo: replyRepo, apiKey: 'test-only', fetchImpl, dryRun: false, classify: false, now: NOW, mailboxes: ['joe@novushq.co.uk'] };
const firstPoll = await pollInstantlyReplies(pollOptions);
assert.equal(firstPoll.persisted, 1);
assert.equal(firstPoll.events[0].row.classification, 'CALL_REQUESTED');
assert.equal(firstPoll.events[0].row.priority, 'CRITICAL');
assert.equal(firstPoll.events[0].row.agency_id, agency.agency_id);
assert.equal(JSON.parse(firstPoll.events[0].row.notes).source_campaign_type, PROBE_CALL_CAMPAIGN_TYPE);
assert.equal((await pollInstantlyReplies(pollOptions)).duplicates_skipped, 1);
assert.equal(replyStore.REPLY_EVENTS.rows.length, 1);
const metrics = probeCallMetrics(campaign, [{ agency_id: agency.agency_id, meeting_booked_at: NOW }], [{ event_type: 'EMAIL_SENT', instantly_email_id: 'mail_1' }], {
  REPLY_EVENTS: table([{ reply_event_id: 'rep_1', agency_id: agency.agency_id, campaign_id: campaign.instantly_campaign_id, classification: 'CALL_REQUESTED', body_text: 'Call me on 07700 900123' }]),
  ACTIONS: table([{ action_id: 'act_1', action_type: 'CALL_PROSPECT', metadata_json: action.metadata_json }]),
  CALLS: table([{ call_id: 'call_1', source_action_id: 'act_1', agency_id: agency.agency_id, outcome: 'BOOKED_MEETING', owner_reached: 'TRUE' }]),
  DISCOVERY_SESSIONS: table([{ session_id: 'session_1', agency_id: agency.agency_id, status: 'COMPLETED', outcome: 'PILOT_AGREED' }]),
});
assert.deepEqual([metrics.actual_emails_sent, metrics.interested_replies, metrics.explicit_phone_replies, metrics.critical_call_actions, metrics.critical_calls_attempted, metrics.owners_reached, metrics.meetings_booked, metrics.meetings_attended, metrics.pilots_agreed, metrics.pilots_sold], [1, 1, 1, 1, 1, 1, 1, 1, 1, null]);

console.log('Probe-led five-minute-call campaign self-test passed.');
