#!/usr/bin/env node
// Offline transition test: Instantly reply → REPLY_EVENTS → lifecycle/ACTIONS
// → Calling Mode projection → call outcome follow-up plan.
import assert from 'node:assert/strict';
import { createMemoryClaimStore, __setClaimStoreForTests } from '../lib/reply-claim.mjs';
import { pollInstantlyReplies } from '../lib/instantly-reply-poll.mjs';
import { matchOutboundDeterministically } from '../lib/instantly-reply-poll.mjs';
import { reconcileActionEngine } from '../lib/action-engine.mjs';
import { buildCallingWorkspace } from '../lib/calling-queue.mjs';
import { handleCallingActionReview, applyCallFollowups } from '../lib/calling-handlers.mjs';
import { __setRepoForTests } from '../lib/sheets.mjs';
import { planOutcome, normaliseOutcomeInput } from '../lib/calling-outcomes.mjs';
import { reconcileActions } from '../lib/acquisition-actions.mjs';
import { deriveExpectedActions } from '../lib/acquisition-actions.mjs';
import { buildAgencyEvidence } from '../lib/operator-funnel.mjs';
import { classifyReply } from '../lib/reply-classification.mjs';
import { replyPhoneNumbers, replyCallbackTiming } from '../lib/reply-call-context.mjs';
import { ACTIONS_HEADER } from '../lib/actions-store.mjs';
import { CALLS_HEADER } from '../lib/calling-store.mjs';
import { REPLY_EVENTS_HEADER } from '../lib/reply-router.mjs';
import { CAMPAIGN_EVENTS_HEADER } from '../lib/campaign-store.mjs';
import { buildLeadTimeline } from '../lib/lead-timeline.mjs';
import { OUTBOUND_HEADER } from '../lib/outbound.mjs';

const NOW = '2026-09-21T12:05:00.000Z';
const row = (header, obj) => header.map((key) => obj[key] ?? '');
const table = (header, objects = []) => ({ header: [...header], rows: objects.map((obj) => row(header, obj)) });
const objs = (t) => t.rows.map((values) => Object.fromEntries(t.header.map((key, i) => [key, values[i] ?? ''])));
const store = {
  AGENCIES: table(['agency_id', 'agency_name', 'clean_agency_name', 'main_phone', 'outreach_contact_name', 'outreach_contact_email', 'current_pipeline_status', 'updated_at'], [
    { agency_id: 'ag_demo', agency_name: 'Example Estate Agents', main_phone: '01277 123456', outreach_contact_name: 'James', outreach_contact_email: 'james@example.test' },
    { agency_id: 'ag_cold', agency_name: 'Cold Branch', main_phone: '01277 111111' },
  ]),
  CONTACTS: table(['contact_id', 'agency_id', 'email', 'contact_name', 'contact_role'], [
    { contact_id: 'ct_james', agency_id: 'ag_demo', email: 'james@example.test', contact_name: 'James', contact_role: 'Owner' },
  ]),
  OUTBOUND: table(OUTBOUND_HEADER, [{ outbound_id: 'ob_demo', agency_id: 'ag_demo', probe_id: 'pr_demo', outreach_contact_email: 'james@example.test', instantly_lead_id: 'lead_demo' }]),
  PROBES: table(['probe_id', 'agency_id', 'probe_status', 'probe_timestamp', 'property_street'], [
    { probe_id: 'pr_demo', agency_id: 'ag_demo', probe_status: 'CLOSED', probe_timestamp: '2026-09-15T09:00:00Z', property_street: '10 Test Street' },
    { probe_id: 'pr_cold', agency_id: 'ag_cold', probe_status: 'CLOSED', probe_timestamp: '2026-09-14T09:00:00Z' },
  ]),
  REPLY_EVENTS: table(REPLY_EVENTS_HEADER), ACTIONS: table(ACTIONS_HEADER),
  INTELLIGENCE: table(['intelligence_id', 'agency_id', 'probe_id']),
  PERSONALISATION: table(['personalisation_id', 'agency_id', 'probe_id']),
  DEMOS: table(['demo_id', 'agency_id', 'probe_id']),
  SALES_MESSAGES: table(['sales_message_id', 'agency_id', 'outreach_id', 'send_outcome']),
  CALLS: table(CALLS_HEADER),
  SCRIPTS: table(['script_id', 'name', 'version', 'status']),
  OBJECTIONS: table(['objection_id']), CALL_OBJECTION_EVENTS: table(['event_id']),
  CAMPAIGNS: table(['campaign_id', 'instantly_campaign_id', 'name'], [{ campaign_id: 'cmp_demo', instantly_campaign_id: 'inst_campaign', name: 'Enquiry → Quick Call V1' }]),
  CAMPAIGN_EVENTS: table(CAMPAIGN_EVENTS_HEADER, [{ event_id: 'cev_reply', agency_id: 'ag_demo', campaign_id: 'cmp_demo',
    event_type: 'REPLY_RECEIVED', instantly_email_id: 'mail_1', occurred_at: '2026-09-16T12:00:00.000Z' }]),
};
const repo = {
  async getTable(tab) { if (!store[tab]) throw new Error(`missing ${tab}`); return store[tab]; },
  async getRecords(tab) { return objs(await this.getTable(tab)).map((obj, index) => ({ obj, rowNumber: index + 2 })); },
  async findById(tab, key, value) { return (await this.getRecords(tab)).find((record) => record.obj[key] === value) || null; },
  async updateCell(tab, key, value, column, next) {
    const index = objs(store[tab]).findIndex((item) => item[key] === value);
    if (index < 0 || !store[tab].header.includes(column)) return false;
    store[tab].rows[index][store[tab].header.indexOf(column)] = next;
    return true;
  },
  async appendRecord(tab, obj) { store[tab].rows.push(row(store[tab].header, obj)); },
  async appendRowsBatch(tab, rows) { store[tab].rows.push(...rows); },
  async writeCellsBatch(writes) { for (const w of writes) store[w.tab].rows[w.rowNumber - 2][w.columnNumber - 1] = w.value; },
  async writeRowsBatch(writes) { for (const w of writes) store[w.tab].rows[w.rowNumber - 2] = w.row; },
  async updateById(tab, key, value, patch) {
    const target = objs(store[tab]).find((item) => item[key] === value);
    if (!target) return null;
    Object.assign(target, patch);
    store[tab].rows[objs(store[tab]).findIndex((item) => item[key] === value)] = row(store[tab].header, target);
    return target;
  },
};
__setClaimStoreForTests(createMemoryClaimStore());
__setRepoForTests(repo);

const raw = (id, body, extra = {}) => ({
  id, ue_type: 2, timestamp_email: '2026-09-16T12:00:00.000Z',
  from_address_email: 'james@example.test', to_address_email_list: 'joe@novushq.co.uk',
  lead: 'james@example.test', lead_id: 'lead_demo', eaccount: 'joe@novushq.co.uk',
  campaign_id: 'inst_campaign', thread_id: 'thread_demo', subject: 'Re: quick call', content_preview: body,
  ...extra,
});
const inbox = [raw('mail_1', 'Hi Joe, yes give me a bell whenever. My number is 07700 900123. Cheers, James.')];
const fetchImpl = async (url) => ({ ok: true, text: async () => JSON.stringify(url.includes('email_type=received') ? { items: inbox } : { items: [] }) });
const poll = () => pollInstantlyReplies({ repo, apiKey: 'test-only', fetchImpl, dryRun: false, classify: true,
  minTimestampCreated: '2026-09-14T00:00:00.000Z', now: NOW });

const first = await poll();
assert.equal(first.persisted, 1);
assert.equal(objs(store.REPLY_EVENTS)[0].classification, 'CALL_REQUESTED');
assert.equal(objs(store.REPLY_EVENTS)[0].agency_id, 'ag_demo');
const created = await reconcileActionEngine(repo, { now: NOW, agencyId: 'ag_demo', execution: { available: true } });
assert.equal(created.created, 1);
const action = objs(store.ACTIONS)[0];
const meta = JSON.parse(action.metadata_json);
assert.equal(action.action_type, 'CALL_PROSPECT');
assert.equal(action.reply_event_id, objs(store.REPLY_EVENTS)[0].reply_event_id);
assert.equal(meta.phone.normalised, '+447700900123');
assert.equal(meta.contact_id, 'ct_james');
assert.equal(meta.source, 'EMAIL_REPLY');
const workspace = buildCallingWorkspace(store, { now: NOW });
assert.equal(workspace.queue[0].agency_id, 'ag_demo');
assert.equal(workspace.queue[1].agency_id, 'ag_cold');
assert.equal(workspace.queue[0].phone, '07700 900123');
assert.equal(workspace.queue[0].phone_e164, '+447700900123');
assert.equal(workspace.queue[0].action_id, action.action_id);
assert.equal(workspace.queue[0].context.campaign_name, 'Enquiry → Quick Call V1');
assert.match(workspace.queue[0].context.call_reply, /give me a bell whenever/);
const secondCallAction = { ...action, action_id: 'act_second_call', dedupe_key: 'second_call',
  metadata_json: JSON.stringify({ ...meta, phone: { raw: '01277 123456', normalised: '+441277123456', source: 'EMAIL_REPLY' } }) };
const twoCalls = buildCallingWorkspace({ ...store, ACTIONS: table(ACTIONS_HEADER, [action, secondCallAction]) }, { now: NOW });
assert.equal(twoCalls.call_actions.find((item) => item.action_id === action.action_id).phone_e164, '+447700900123');
assert.equal(twoCalls.call_actions.find((item) => item.action_id === secondCallAction.action_id).phone_e164, '+441277123456');

const second = await poll();
assert.equal(second.duplicates_skipped, 1);
assert.equal((await reconcileActionEngine(repo, { now: NOW, agencyId: 'ag_demo', execution: { available: true } })).created, 0);
assert.equal(store.ACTIONS.rows.length, 1);
assert.equal(reconcileActions([{ ...action, action_status: 'COMPLETED' }], [{ ...action, action_status: 'DUE' }], NOW).create.length, 0);
const olderManual = { action_id: 'manual_old', agency_id: 'ag_demo', outreach_id: 'ob_demo', action_type: 'HUMAN_REPLY',
  action_status: 'PENDING', dedupe_key: 'manual_old', created_at: '2026-09-15T09:00:00Z', metadata_json: '{"manual":true}' };
assert.equal(reconcileActions([olderManual], [action], NOW).cancel.length, 1);
assert.equal(reconcileActions([{ ...olderManual, created_at: '2026-09-17T09:00:00Z' }], [action], NOW).cancel.length, 0);
const manualCallback = { ...olderManual, action_id: 'manual_callback', action_type: 'CALL_PROSPECT',
  dedupe_key: 'manual_callback', created_at: '2026-09-17T09:00:00Z' };
const manuallyHandled = { ...store, ACTIONS: table(ACTIONS_HEADER, [manualCallback]) };
assert.equal(deriveExpectedActions(buildAgencyEvidence(manuallyHandled, { now: NOW })[0], NOW)[0].action_id, 'manual_callback');
const shared = matchOutboundDeterministically([
  { obj: { outbound_id: 'ob_north', agency_id: 'ag_north', outreach_contact_email: 'shared@example.test' } },
  { obj: { outbound_id: 'ob_south', agency_id: 'ag_south', outreach_contact_email: 'shared@example.test' } },
], { lead_email: 'shared@example.test' });
assert.equal(shared.status, 'AMBIGUOUS');
assert.equal(shared.match, null);

assert.deepEqual(replyPhoneNumbers('Call me on 07700 900123 or 01277 123456').map((p) => p.normalised), ['+447700900123', '+441277123456']);
assert.equal(replyPhoneNumbers('Yes give me a call').length, 0);
assert.equal(replyCallbackTiming('Call me Thursday at 2', NOW, NOW).due_at, '2026-09-24T13:00:00.000Z');
assert.equal(replyCallbackTiming('Call tomorrow morning', NOW, NOW).precision, 'WINDOW');
assert.equal(replyCallbackTiming('Call me after 3', NOW, NOW).needs_review, true);
assert.equal(replyCallbackTiming('Try next week', NOW, NOW).precision, 'WINDOW');
assert.equal(replyCallbackTiming('Try next month', NOW, NOW).precision, 'BROAD');
assert.equal(replyCallbackTiming('Try next month', NOW, NOW).needs_review, true);
assert.equal(replyCallbackTiming('Call me Thursday at 2', '2026-09-21T12:00:00Z', '2026-09-25T12:00:00Z').warning, 'Requested time has passed');

const noPhone = buildCallingWorkspace({ ...store, ACTIONS: table(ACTIONS_HEADER, [{ ...action, metadata_json: JSON.stringify({ ...meta, phone: null, phone_candidates: [] }) }]) }, { now: NOW });
assert.equal(noPhone.queue[0].phone, '01277 123456');
const ambiguous = buildCallingWorkspace({ ...store, ACTIONS: table(ACTIONS_HEADER, [{ ...action, metadata_json: JSON.stringify({ ...meta, phone: null, phone_candidates: replyPhoneNumbers('07700 900123 or 01277 123456'), needs_review: true }) }]) }, { now: NOW });
assert.equal(ambiguous.call_actions[0].no_phone, true);
assert.equal(ambiguous.queue.some((lead) => lead.agency_id === 'ag_demo'), false);
const ambiguousTime = buildCallingWorkspace({ ...store, ACTIONS: table(ACTIONS_HEADER, [{ ...action,
  metadata_json: JSON.stringify({ ...meta, timing: { language: 'after 3', needs_review: true }, needs_review: true }) }]) }, { now: NOW });
assert.equal(ambiguousTime.call_actions[0].needs_review, true);
assert.equal(ambiguousTime.queue.some((lead) => lead.agency_id === 'ag_demo'), false);
const ambiguousMeta = { ...meta, phone: null, phone_candidates: replyPhoneNumbers('07700 900123 or 01277 123456'), needs_review: true };
store.ACTIONS.rows[0] = row(ACTIONS_HEADER, { ...action, metadata_json: JSON.stringify(ambiguousMeta) });
const reviewRes = { statusCode: 0, body: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
await handleCallingActionReview({ body: { confirm: 'REVIEW_CALL_ACTION', action_id: action.action_id, phone: '01277 123456' } }, reviewRes);
assert.equal(reviewRes.statusCode, 200, JSON.stringify(reviewRes.body));
assert.equal(JSON.parse(objs(store.ACTIONS)[0].metadata_json).phone.normalised, '+441277123456');
assert.equal(buildCallingWorkspace(store, { now: NOW }).queue[0].phone, '01277 123456');
assert.equal((await reconcileActionEngine(repo, { now: NOW, agencyId: 'ag_demo', execution: { available: true } })).created, 0);
assert.equal(JSON.parse(objs(store.ACTIONS)[0].metadata_json).reviewed, true);
const timeMeta = { ...JSON.parse(objs(store.ACTIONS)[0].metadata_json), needs_review: true,
  timing: { language: 'next month', due_at: '', precision: 'BROAD', needs_review: true } };
store.ACTIONS.rows[0] = row(ACTIONS_HEADER, { ...objs(store.ACTIONS)[0], metadata_json: JSON.stringify(timeMeta) });
const timeRes = { statusCode: 0, body: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
await handleCallingActionReview({ body: { confirm: 'REVIEW_CALL_ACTION', action_id: action.action_id, phone: '01277 123456', due_london: '2036-01-07T09:00' } }, timeRes);
assert.equal(timeRes.statusCode, 200, JSON.stringify(timeRes.body));
assert.equal(objs(store.ACTIONS)[0].due_at, '2036-01-07T09:00:00.000Z');
await reconcileActionEngine(repo, { now: NOW, agencyId: 'ag_demo', execution: { available: true } });
assert.equal(objs(store.ACTIONS)[0].due_at, '2036-01-07T09:00:00.000Z');
const beforeOutcomes = structuredClone(store);
const savedCall = { call_id: 'call_email_1', agency_id: 'ag_demo', source_action_id: action.action_id,
  contact_name: 'James', phone: '01277 123456', outcome: 'NO_ANSWER', attempt_number: '1', started_at: NOW, metadata_json: '{}' };
store.CALLS.rows.push(row(CALLS_HEADER, savedCall));
const followups = await applyCallFollowups(repo, savedCall, { nowMs: Date.parse(NOW), outreachId: 'ob_demo', probeId: 'pr_demo' });
assert.equal(followups.complete, true, JSON.stringify(followups.warnings));
assert.equal(objs(store.ACTIONS).find((item) => item.action_id === action.action_id).action_status, 'COMPLETED');
assert.equal(objs(store.REPLY_EVENTS)[0].action_status, 'COMPLETED');
assert.equal(objs(store.ACTIONS).find((item) => item.action_type === 'RETRY_CALL').action_status, 'PENDING');
assert.equal((await applyCallFollowups(repo, savedCall, { nowMs: Date.parse(NOW), outreachId: 'ob_demo', probeId: 'pr_demo' })).actions_created.length, 0);
const history = buildLeadTimeline(store, 'ag_demo', { now: NOW });
assert.equal(history.entries.filter((item) => item.type === 'REPLY_RECEIVED').length, 1);
assert.equal(history.entries.filter((item) => item.type === 'CALL_REQUESTED_ACTION_CREATED').length, 1);

Object.assign(store, structuredClone(beforeOutcomes));
const meetingCall = { ...savedCall, call_id: 'call_email_meeting', outcome: 'BOOKED_MEETING', meeting_at: '2026-09-25T10:00:00Z' };
store.CALLS.rows.push(row(CALLS_HEADER, meetingCall));
const meetingResult = await applyCallFollowups(repo, meetingCall, { nowMs: Date.parse(NOW), outreachId: 'ob_demo', probeId: 'pr_demo' });
assert.equal(meetingResult.complete, true, JSON.stringify(meetingResult.warnings));
assert.equal(objs(store.ACTIONS).find((item) => item.action_id === action.action_id).action_status, 'COMPLETED');
assert.equal(objs(store.ACTIONS).some((item) => item.action_type === 'PREPARE_MEETING'), true);
assert.equal(objs(store.AGENCIES)[0].current_pipeline_status, 'MEETING_BOOKED');

Object.assign(store, structuredClone(beforeOutcomes));
const negativeCall = { ...savedCall, call_id: 'call_email_negative', outcome: 'NOT_INTERESTED', not_interested_reason: 'NO_NEED' };
store.CALLS.rows.push(row(CALLS_HEADER, negativeCall));
const negativeResult = await applyCallFollowups(repo, negativeCall, { nowMs: Date.parse(NOW), outreachId: 'ob_demo', probeId: 'pr_demo' });
assert.equal(negativeResult.complete, true, JSON.stringify(negativeResult.warnings));
assert.equal(objs(store.AGENCIES)[0].current_pipeline_status, 'NOT_INTERESTED');
assert.equal(objs(store.ACTIONS).find((item) => item.action_id === action.action_id).action_status, 'COMPLETED');
assert.equal(buildCallingWorkspace(store, { now: NOW }).queue.some((lead) => lead.agency_id === 'ag_demo'), false);
Object.assign(store, structuredClone(beforeOutcomes));

for (const [body, classification] of [['Remove me', 'OPT_OUT'], ['Out of office until Friday', 'OOO_AUTOMATED'], ['What is this about?', 'QUESTION'], ['Book me in next week', 'POSITIVE_MEETING']]) {
  const answer = await classifyReply({ cleaned_reply_text: body, subject: '', is_auto_reply: false }, { aiCall: async () => ({ classification: body.includes('?') ? 'QUESTION' : 'POSITIVE_MEETING', confidence: 0.96, reason: 'test' }) });
  assert.equal(answer.classification, classification);
  assert.notEqual(answer.next_action, 'CALL_PROSPECT');
}
for (const [body, classification, nextAction] of [
  ['Send me more information', 'INFO_REQUESTED', 'SEND_INFORMATION'],
  ["We've already got Lifesycle", 'OBJECTION', 'HUMAN_REPLY'],
  ['Not interested', 'NOT_INTERESTED', 'CLOSE'],
  ['Call me on +44 7700 900123', 'CALL_REQUESTED', 'CALL_PROSPECT'],
]) {
  const answer = await classifyReply({ cleaned_reply_text: body, subject: '', is_auto_reply: false }, { aiCall: async () => { throw new Error('AI unavailable'); } });
  assert.equal(answer.classification, classification);
  assert.equal(answer.next_action, nextAction);
}
const actionForReply = (classification, body) => {
  const reply = { ...objs(store.REPLY_EVENTS)[0], classification, cleaned_reply_text: body, received_at: NOW };
  const snapshot = { ...store, REPLY_EVENTS: table(REPLY_EVENTS_HEADER, [reply]), ACTIONS: table(ACTIONS_HEADER) };
  const evidence = buildAgencyEvidence(snapshot, { now: NOW })[0];
  return deriveExpectedActions(evidence, NOW)[0] || null;
};
assert.equal(actionForReply('INFO_REQUESTED', 'Send me more information').action_type, 'SEND_INFORMATION');
assert.equal(actionForReply('QUESTION', "What's this about?").action_type, 'HUMAN_REPLY');
assert.equal(actionForReply('OBJECTION', "We've already got Lifesycle").action_type, 'HUMAN_REPLY');
assert.equal(actionForReply('POSITIVE_MEETING', 'Book me in next week').action_type, 'HUMAN_REPLY');
assert.equal(actionForReply('NOT_NOW', 'Try me next month').action_type, 'SET_NEXT_STEP');
assert.equal(actionForReply('NOT_INTERESTED', 'Not interested'), null);
assert.equal(actionForReply('OPT_OUT', 'Remove me'), null);
assert.notEqual(actionForReply('OOO_AUTOMATED', 'Out of office').action_type, 'CALL_PROSPECT');
const call = { call_id: 'call_1', agency_id: 'ag_demo', contact_name: 'James', attempt_number: '1' };
assert.equal(planOutcome(call, { outcome: 'NO_ANSWER' }, { nowMs: Date.parse(NOW) }).call_actions[0].action_type, 'RETRY_CALL');
assert.equal(planOutcome(call, { outcome: 'BOOKED_MEETING', meeting_at: '2026-09-25T10:00:00Z' }, { nowMs: Date.parse(NOW) }).actions[0].action_type, 'PREPARE_MEETING');
assert.equal(planOutcome(call, { outcome: 'NOT_INTERESTED' }, { nowMs: Date.parse(NOW) }).terminal, 'NOT_INTERESTED');
assert.equal(planOutcome(call, normaliseOutcomeInput({ outcome: 'MORE_INFO_REQUESTED', more_info_type: 'DEMO' }, Date.parse(NOW)).normalised, { nowMs: Date.parse(NOW) }).actions[0].action_type, 'SEND_INFORMATION');

console.log('✅ Email reply → calling action → Calling Mode → outcome self-test passed');
