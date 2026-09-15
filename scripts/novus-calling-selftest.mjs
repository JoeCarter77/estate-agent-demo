#!/usr/bin/env node
// scripts/novus-calling-selftest.mjs — hermetic test of the cold-calling
// workflow: tab setup, script/objection versioning, queue prioritisation,
// outcome derivation, the follow-up actions a saved call creates, and the
// idempotent save. No network, no credentials, no Twilio.
//
// Run:  npm run novus:calling-selftest

import assert from 'node:assert/strict';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { ACTIONS_HEADER } from '../lib/actions-store.mjs';
import { actionQueue, isManualSalesAction } from '../lib/acquisition-actions.mjs';
import { CALLS_HEADER, SCRIPTS_HEADER, OBJECTIONS_HEADER, CALL_OBJECTION_EVENTS_HEADER, callRecords } from '../lib/calling-store.mjs';
import { buildCallingWorkspace, scriptFunnel } from '../lib/calling-queue.mjs';
import { derivePitched, deriveOwnerReached, normaliseOutcomeInput, normalisedFromRow, planOutcome, addWorkingDaysMs } from '../lib/calling-outcomes.mjs';
import { createVoiceAccessToken, decodeJwt, twilioCallingConfig } from '../lib/twilio-access-token.mjs';
import { computeTwilioSignature } from '../lib/twilio-signature.mjs';

let passed = 0;
const ok = (msg) => { passed += 1; console.log(`  ✓ ${msg}`); };

// ── in-memory Sheets transport, including tab creation ─────────────────────
function makeStore(initial) {
  const store = structuredClone(initial);
  const api = {
    async get(range) { const tab = String(range).split('!')[0]; if (!(tab in store)) throw new Error(`Unable to parse range: ${tab}`); return store[tab].map((r) => r.slice()); },
    async append(range, rows) { const tab = String(range).split('!')[0]; if (!(tab in store)) throw new Error(`no tab ${tab}`); store[tab].push(...rows.map((r) => r.slice())); },
    async update(range, rows) {
      const [tab, a1] = String(range).split('!');
      const m = a1.match(/^([A-Z]+)(\d+)/);
      const colIdx = m[1].split('').reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;
      const rowIdx = Number(m[2]) - 1;
      rows.forEach((row, i) => {
        while (store[tab].length <= rowIdx + i) store[tab].push([]);
        const target = store[tab][rowIdx + i];
        row.forEach((v, j) => { while (target.length <= colIdx + j) target.push(''); target[colIdx + j] = v; });
      });
    },
    async batchUpdate(data) { for (const { range, values } of data) await api.update(range, values); },
    async listTabs() { return Object.keys(store); },
    async addTab(tab) { store[tab] = []; },
  };
  return { store, repo: createRepo(api) };
}

const T0 = Date.parse('2026-09-14T10:00:00.000Z'); // a Monday
const iso = (ms) => new Date(ms).toISOString();
const DAY = 86_400_000;

// ── 1. pure outcome semantics ──────────────────────────────────────────────
{
  assert.equal(derivePitched('NO_ANSWER'), false);
  assert.equal(derivePitched('GATEKEPT'), false);
  assert.equal(derivePitched('WRONG_NUMBER'), false);
  assert.equal(derivePitched('MORE_INFO_REQUESTED'), true);
  assert.equal(derivePitched('NOT_INTERESTED'), true);
  assert.equal(derivePitched('BOOKED_MEETING'), true);
  assert.equal(derivePitched('CALLBACK_REQUESTED', { owner_reached: true }), true);
  assert.equal(derivePitched('CALLBACK_REQUESTED', { owner_reached: false }), false);
  assert.equal(derivePitched('NOT_THE_DECISION_MAKER'), false);
  assert.equal(derivePitched('NOT_THE_DECISION_MAKER', { pitched_override: true }), true);
  assert.equal(deriveOwnerReached('GATEKEPT'), false);
  assert.equal(deriveOwnerReached('BOOKED_MEETING'), true);
  ok('pitched and owner_reached are derived from the outcome, never typed in');

  const bad = normaliseOutcomeInput({ outcome: 'NOT_INTERESTED' }, T0);
  assert.equal(bad.valid, false); assert.match(bad.errors.join(' '), /reason/);
  const past = normaliseOutcomeInput({ outcome: 'CALLBACK_REQUESTED', callback_at: iso(T0 - DAY) }, T0);
  assert.equal(past.valid, false);
  const info = normaliseOutcomeInput({ outcome: 'MORE_INFO_REQUESTED', more_info_type: 'pricing' }, T0);
  assert.equal(info.valid, true);
  assert.equal(info.normalised.followup_at, iso(addWorkingDaysMs(T0, 2)));
  assert.equal(info.normalised.followup_at, '2026-09-16T08:00:00.000Z'); // Wed 09:00 BST
  assert.equal(info.normalised.callback_at, info.normalised.followup_at, 'follow-up stored on the row as callback_at');
  ok('conditional outcome inputs are validated and defaulted (two working days for more-info, 09:00 London)');

  const call = { call_id: 'cal_1', agency_id: 'ag_1', contact_name: 'Ian', attempt_number: 1 };
  const noAnswer = planOutcome(call, normaliseOutcomeInput({ outcome: 'NO_ANSWER' }, T0).normalised, { nowMs: T0 });
  assert.equal(noAnswer.call_actions.length, 1);
  assert.equal(noAnswer.call_actions[0].action_type, 'RETRY_CALL');
  assert.equal(noAnswer.call_actions[0].due_at, '2026-09-15T08:00:00.000Z', '09:00 BST');
  assert.equal(JSON.parse(noAnswer.call_actions[0].metadata_json).call_action, true);
  assert.equal(actionQueue({ ...noAnswer.call_actions[0], action_status: 'DUE' }), 'CALLING');
  assert.equal(isManualSalesAction({ ...noAnswer.call_actions[0], action_status: 'DUE' }), false);
  ok('NO_ANSWER schedules a next-day RETRY_CALL in the CALLING queue, not the generic Actions list');

  const gate = planOutcome(call, normaliseOutcomeInput({ outcome: 'GATEKEPT' }, T0).normalised, { nowMs: T0 });
  assert.equal(gate.call_actions[0].due_at, '2026-09-28T08:00:00.000Z');
  ok('GATEKEPT retries in +14 days');
  // Across the clock change: a no-answer on Sat 24 Oct 2026 retries Sun 25 Oct at 09:00 GMT = 09:00Z, not 08:00Z.
  const preSwitch = Date.parse('2026-10-24T10:00:00.000Z');
  assert.equal(planOutcome(call, normaliseOutcomeInput({ outcome: 'NO_ANSWER' }, preSwitch).normalised, { nowMs: preSwitch }).call_actions[0].due_at, '2026-10-25T09:00:00.000Z');
  const winter = Date.parse('2026-12-11T10:00:00.000Z'); // a Friday, GMT
  assert.equal(planOutcome(call, normaliseOutcomeInput({ outcome: 'NO_ANSWER' }, winter).normalised, { nowMs: winter }).call_actions[0].due_at, '2026-12-12T09:00:00.000Z');
  assert.equal(normaliseOutcomeInput({ outcome: 'MORE_INFO_REQUESTED', more_info_type: 'DEMO' }, winter).normalised.followup_at, '2026-12-15T09:00:00.000Z', 'Fri + 2 working days = Tue 09:00 GMT');
  ok('automatic callbacks stay at 09:00 UK wall-clock time across BST and GMT');
  const rebuilt = normalisedFromRow({ outcome: 'MORE_INFO_REQUESTED', more_info_type: 'DEMO', callback_at: '2026-12-15T09:00:00.000Z', referred_contact_json: '', metadata_json: JSON.stringify({ owner_reached_input: true }) });
  assert.equal(planOutcome(call, rebuilt, { nowMs: winter }).call_actions[0].due_at, '2026-12-15T09:00:00.000Z');
  ok('a stored CALLS row alone is enough to rebuild its follow-up plan');

  const meeting = planOutcome(call, normaliseOutcomeInput({ outcome: 'BOOKED_MEETING', meeting_at: iso(T0 + 5 * DAY), meeting_note: 'Zoom' }, T0).normalised, { nowMs: T0 });
  assert.equal(meeting.terminal, 'MEETING_BOOKED');
  assert.equal(meeting.actions[0].action_type, 'PREPARE_MEETING');
  assert.equal(actionQueue({ ...meeting.actions[0], action_status: 'PENDING' }), 'JOE');
  const more = planOutcome(call, info.normalised, { nowMs: T0 });
  assert.deepEqual(more.actions.map((a) => a.action_type), ['SEND_INFORMATION']);
  assert.deepEqual(more.call_actions.map((a) => a.action_type), ['CALL_PROSPECT']);
  const dnc = planOutcome(call, normaliseOutcomeInput({ outcome: 'DO_NOT_CALL' }, T0).normalised, { nowMs: T0 });
  assert.equal(dnc.suppress_calling, true); assert.equal(dnc.call_actions.length, 0); assert.equal(dnc.terminal, null);
  const ndm = planOutcome(call, normaliseOutcomeInput({ outcome: 'NOT_THE_DECISION_MAKER', referred_contact: { name: 'Sara', phone: '07700 900123' } }, T0).normalised, { nowMs: T0 });
  assert.equal(ndm.call_actions[0].action_type, 'CALL_PROSPECT');
  assert.equal(JSON.parse(ndm.call_actions[0].metadata_json).contact_override.name, 'Sara');
  ok('meeting / more-info / do-not-call / not-the-DM plans produce the right terminal state and follow-ups');
}

// ── 2. queue prioritisation ────────────────────────────────────────────────
function actionRow(overrides) {
  return { ...Object.fromEntries(ACTIONS_HEADER.map((k) => [k, ''])), action_owner: 'JOE', action_status: 'PENDING', created_at: iso(T0 - DAY), updated_at: iso(T0 - DAY), metadata_json: '{}', ...overrides };
}
function callRow(overrides) {
  return { ...Object.fromEntries(CALLS_HEADER.map((k) => [k, ''])), call_mode: 'MANUAL', created_at: iso(T0 - DAY), updated_at: iso(T0 - DAY), ...overrides };
}
const table = (header, objs) => ({ header: [...header], rows: objs.map((o) => header.map((k) => o[k] ?? '')) });
{
  const AG = ['agency_id', 'clean_agency_name', 'main_phone', 'outreach_contact_name', 'current_pipeline_status', 'suppression_status', 'location'];
  const agencies = [
    { agency_id: 'ag_new', clean_agency_name: 'Never Called', main_phone: '01234 567890', outreach_contact_name: 'Ann' },
    { agency_id: 'ag_new2', clean_agency_name: 'Never Called No Name', main_phone: '01234 567891' },
    { agency_id: 'ag_overdue', clean_agency_name: 'Overdue Callback', main_phone: '01234 567892' },
    { agency_id: 'ag_today', clean_agency_name: 'Today Callback', main_phone: '01234 567893' },
    { agency_id: 'ag_retry', clean_agency_name: 'Retry Due', main_phone: '01234 567894' },
    { agency_id: 'ag_engine', clean_agency_name: 'Engine Call', main_phone: '01234 567895' },
    { agency_id: 'ag_later', clean_agency_name: 'Later Callback', main_phone: '01234 567896' },
    { agency_id: 'ag_dnc', clean_agency_name: 'Do Not Call', main_phone: '01234 567897' },
    { agency_id: 'ag_wrong', clean_agency_name: 'Wrong Number', main_phone: '01234 567898' },
    { agency_id: 'ag_meeting', clean_agency_name: 'Meeting Booked', main_phone: '01234 567899', current_pipeline_status: 'MEETING_BOOKED' },
    { agency_id: 'ag_nophone', clean_agency_name: 'No Phone', main_phone: '' },
    { agency_id: 'ag_referral', clean_agency_name: 'Referred', main_phone: '01234 567800' },
    { agency_id: 'ag_optout', clean_agency_name: 'Email Opt Out', main_phone: '01234 567801' },
    { agency_id: 'ag_allsupp', clean_agency_name: 'All-contact Suppressed', main_phone: '01234 567802', suppression_status: 'SUPPRESSED' },
    { agency_id: 'ag_no_probe', clean_agency_name: 'Never Probed', main_phone: '01234 567803' },
  ];
  const callMeta = (extra) => JSON.stringify({ manual: true, call_action: true, ...extra });
  const actions = [
    actionRow({ action_id: 'a_over', agency_id: 'ag_overdue', action_type: 'CALL_PROSPECT', due_at: iso(T0 - 2 * DAY), metadata_json: callMeta({ callback_reason: 'Callback requested' }) }),
    actionRow({ action_id: 'a_today', agency_id: 'ag_today', action_type: 'CALL_PROSPECT', due_at: iso(T0 - 3600_000), metadata_json: callMeta({ callback_reason: 'Owner unavailable' }) }),
    actionRow({ action_id: 'a_retry', agency_id: 'ag_retry', action_type: 'RETRY_CALL', due_at: iso(T0 - 1000), metadata_json: callMeta({ callback_reason: 'No answer retry' }) }),
    actionRow({ action_id: 'a_engine', agency_id: 'ag_engine', action_type: 'CALL_PROSPECT', due_at: iso(T0 - 1000), reason: 'Strong demo engagement' }),
    actionRow({ action_id: 'a_later', agency_id: 'ag_later', action_type: 'CALL_PROSPECT', due_at: iso(T0 + DAY + 3600_000), metadata_json: callMeta({ callback_reason: 'Callback requested' }) }),
    actionRow({ action_id: 'a_ref', agency_id: 'ag_referral', action_type: 'CALL_PROSPECT', due_at: iso(T0 - 1000), metadata_json: callMeta({ callback_reason: 'Referred to decision-maker', contact_override: { name: 'Sara Owner', role: 'Director', phone: '07700 900123' } }) }),
  ];
  const calls = [
    callRow({ call_id: 'c1', agency_id: 'ag_retry', phone: '01234 567894', started_at: iso(T0 - DAY), outcome: 'NO_ANSWER', connected: 'FALSE', owner_reached: 'FALSE', pitched: 'FALSE', script_id: 'scr_v1' }),
    callRow({ call_id: 'c2', agency_id: 'ag_dnc', phone: '01234 567897', started_at: iso(T0 - DAY), outcome: 'DO_NOT_CALL', connected: 'TRUE', owner_reached: 'TRUE', pitched: 'FALSE' }),
    callRow({ call_id: 'c3', agency_id: 'ag_wrong', phone: '01234 567898', started_at: iso(T0 - DAY), outcome: 'WRONG_NUMBER', connected: 'TRUE', owner_reached: 'FALSE', pitched: 'FALSE' }),
    callRow({ call_id: 'c4', agency_id: 'ag_referral', phone: '01234 567800', started_at: iso(T0 - DAY), outcome: 'NOT_THE_DECISION_MAKER', connected: 'TRUE', owner_reached: 'FALSE', pitched: 'FALSE' }),
  ];
  const scripts = [
    { script_id: 'scr_v1', script_key: 'k', name: 'Seller Opportunity', version: 1, status: 'ARCHIVED' },
    { script_id: 'scr_v2', script_key: 'k', name: 'Seller Opportunity', version: 2, status: 'CURRENT' },
  ];
  const ws = buildCallingWorkspace({
    AGENCIES: table(AG, agencies), ACTIONS: table(ACTIONS_HEADER, actions), CALLS: table(CALLS_HEADER, calls),
    SCRIPTS: table(SCRIPTS_HEADER, scripts), OBJECTIONS: table(OBJECTIONS_HEADER, []), CALL_OBJECTION_EVENTS: table(CALL_OBJECTION_EVENTS_HEADER, []),
    REPLY_EVENTS: table(['reply_event_id', 'agency_id', 'classification', 'suppression_type', 'received_at'], [
      { reply_event_id: 'r1', agency_id: 'ag_optout', classification: 'OPT_OUT', suppression_type: 'PERMANENT', received_at: iso(T0 - DAY) },
    ]), CONTACTS: { header: [], rows: [] }, INTELLIGENCE: { header: [], rows: [] },
    // Every bucket-5 candidate needs a genuine sent/completed probe: without
    // one (ag_no_probe) an otherwise-eligible lead never enters the cold pool.
    PROBES: table(['probe_id', 'agency_id', 'probe_status', 'probe_timestamp'], [
      { probe_id: 'p_new', agency_id: 'ag_new', probe_status: 'CLOSED', probe_timestamp: iso(T0 - 30 * DAY) },
      { probe_id: 'p_new2', agency_id: 'ag_new2', probe_status: 'CLOSED', probe_timestamp: iso(T0 - 20 * DAY) },
      { probe_id: 'p_optout', agency_id: 'ag_optout', probe_status: 'CLOSED', probe_timestamp: iso(T0 - 10 * DAY) },
    ]), DEMOS: { header: [], rows: [] },
  }, { now: iso(T0) });

  assert.deepEqual(ws.queue.map((l) => l.agency_id), ['ag_overdue', 'ag_today', 'ag_referral', 'ag_retry', 'ag_engine', 'ag_new', 'ag_new2', 'ag_optout']);
  assert.deepEqual(ws.queue.map((l) => l.bucket), [1, 2, 2, 3, 4, 5, 5, 5]);
  assert.deepEqual(ws.queue.filter((l) => l.bucket === 5).map((l) => l.due_reason), ['No interaction', 'No interaction', 'Email opt-out']);
  assert.equal(ws.leads.ag_optout.suppression, '', 'an email opt-out is not phone suppression');
  assert.equal(ws.leads.ag_optout.context.email_signal, 'OPTED_OUT_EMAIL', 'but it is shown as context');
  assert.equal(ws.leads.ag_allsupp.suppression, 'agency suppressed', 'the agency-level all-contact flag still suppresses');
  ok('email opt-outs stay visible as context; only all-contact, terminal, DO_NOT_CALL and wrong-number suppress calling');
  ok('queue order: overdue callback → today callback → no-answer retry → other due call actions → untouched cold pool (oldest probe first, no engagement)');
  assert.ok(!ws.queue.some((l) => l.agency_id === 'ag_no_probe'), 'an agency with no genuine PROBES sent/completed evidence never enters the queue');
  assert.equal(ws.leads.ag_no_probe.bucket, null, 'it still appears in the lookup map, just outside the queue');
  assert.equal(ws.counts.no_probe, 1);
  ok('agencies never probed (or only holding a DRAFT probe) are excluded from the general cold-calling pool');
  // COHORT INTEGRITY: a lead already called with scr_v1 stays on scr_v1
  // even though it is now ARCHIVED — testing cohorts must never be silently
  // reassigned to CURRENT just because their version got archived. A
  // never-called lead gets whatever is CURRENT.
  assert.equal(ws.queue.find((l) => l.agency_id === 'ag_retry').script.script_id, 'scr_v1', 'a called lead stays on its exact version even once archived');
  assert.equal(ws.queue.find((l) => l.agency_id === 'ag_retry').script.status, 'ARCHIVED');
  assert.equal(ws.queue.find((l) => l.agency_id === 'ag_new').script.script_id, 'scr_v2', 'a never-called lead gets whatever is CURRENT');
  assert.equal(ws.queue.find((l) => l.agency_id === 'ag_retry').attempts, 1);
  ok('a lead sticks to the exact script version it was called with, even after that version is archived; an unassigned lead gets CURRENT');
  const ref = ws.queue.find((l) => l.agency_id === 'ag_referral');
  assert.equal(ref.phone, '07700 900123'); assert.equal(ref.contact_name, 'Sara Owner'); assert.equal(ref.phone_e164, '+447700900123');
  ok('a decision-maker referral overrides the dialled number and contact');
  assert.equal(ws.leads.ag_dnc.suppression, 'asked not to be called again');
  assert.equal(ws.leads.ag_wrong.phone, '');
  assert.equal(ws.leads.ag_meeting.suppression, 'pipeline status MEETING_BOOKED');
  assert.equal(ws.counts.suppressed, 3); assert.equal(ws.counts.no_phone, 2); assert.equal(ws.counts.scheduled_later, 1);
  ok('do-not-call, wrong-number-only, terminal and phoneless leads never enter the queue');
  assert.deepEqual(ws.call_actions.map((a) => [a.agency_id, a.group]), [['ag_overdue', 'overdue'], ['ag_today', 'today'], ['ag_retry', 'today'], ['ag_engine', 'today'], ['ag_referral', 'today'], ['ag_later', 'tomorrow']]);
  assert.equal(ws.call_actions[0].reason, 'Callback requested');
  assert.equal(ws.call_actions[2].previous_outcome, 'NO_ANSWER');
  ok('Call Actions groups overdue / today / tomorrow / upcoming with reason and previous outcome');

  const f = scriptFunnel([
    callRow({ outcome: 'NO_ANSWER', connected: 'FALSE', owner_reached: 'FALSE', pitched: 'FALSE' }),
    callRow({ outcome: 'GATEKEPT', connected: 'TRUE', owner_reached: 'FALSE', pitched: 'FALSE' }),
    callRow({ outcome: 'NOT_INTERESTED', connected: 'TRUE', owner_reached: 'TRUE', pitched: 'TRUE' }),
    callRow({ outcome: 'BOOKED_MEETING', connected: 'TRUE', owner_reached: 'TRUE', pitched: 'TRUE' }),
  ]);
  assert.deepEqual([f.dials, f.connected, f.owner_conversations, f.pitched, f.booked_meetings, f.pitched_to_meeting_pct, f.owner_to_meeting_pct], [4, 3, 2, 2, 1, 50, 50]);
  ok('script funnel counts derive purely from immutable CALLS rows');
}

// ── 2a. cold-call eligibility and engagement-tier ranking ──────────────────
// Only a genuinely probed agency reaches the general cold-calling pool, and
// within that pool engagement (a real reply, or a genuinely re-viewed/CTA
// -clicked demo) beats a fresher probe date every time; ties within a tier
// go to the oldest probe. Explicit call actions still sit above all of it.
{
  const AG = ['agency_id', 'clean_agency_name', 'main_phone'];
  const agencies = [
    { agency_id: 'ag_never_probed', clean_agency_name: 'Never Probed', main_phone: '01234 700001' },
    { agency_id: 'ag_draft_probe', clean_agency_name: 'Draft Probe Only', main_phone: '01234 700002' },
    { agency_id: 'ag_no_interaction_old', clean_agency_name: 'No Interaction Old', main_phone: '01234 700003' },
    { agency_id: 'ag_no_interaction_new', clean_agency_name: 'No Interaction New', main_phone: '01234 700004' },
    { agency_id: 'ag_weak_reply', clean_agency_name: 'Weak Reply', main_phone: '01234 700005' },
    { agency_id: 'ag_demo_engaged', clean_agency_name: 'Demo Engaged', main_phone: '01234 700006' },
    { agency_id: 'ag_strong_reply_new', clean_agency_name: 'Strong Reply New Probe', main_phone: '01234 700007' },
    { agency_id: 'ag_callback_due', clean_agency_name: 'Explicit Callback', main_phone: '01234 700008' },
    { agency_id: 'ag_not_interested', clean_agency_name: 'Not Interested By Email', main_phone: '01234 700009' },
    { agency_id: 'ag_opt_out', clean_agency_name: 'Opted Out By Email', main_phone: '01234 700010' },
    { agency_id: 'ag_draft_with_timestamp', clean_agency_name: 'Legacy Draft With Timestamp', main_phone: '01234 700011' },
  ];
  const probes = [
    { probe_id: 'pr_draft', agency_id: 'ag_draft_probe', probe_status: 'DRAFT', probe_timestamp: '' },
    { probe_id: 'pr_old', agency_id: 'ag_no_interaction_old', probe_status: 'CLOSED', probe_timestamp: iso(T0 - 60 * DAY) },
    { probe_id: 'pr_new', agency_id: 'ag_no_interaction_new', probe_status: 'CLOSED', probe_timestamp: iso(T0 - 5 * DAY) },
    { probe_id: 'pr_weak', agency_id: 'ag_weak_reply', probe_status: 'CLOSED', probe_timestamp: iso(T0 - 40 * DAY) },
    { probe_id: 'pr_demo', agency_id: 'ag_demo_engaged', probe_status: 'CLOSED', probe_timestamp: iso(T0 - 30 * DAY) },
    { probe_id: 'pr_strong', agency_id: 'ag_strong_reply_new', probe_status: 'OBSERVING', probe_timestamp: iso(T0 - 2 * DAY) },
    { probe_id: 'pr_callback', agency_id: 'ag_callback_due', probe_status: 'CLOSED', probe_timestamp: iso(T0 - 1 * DAY) },
    { probe_id: 'pr_not_interested', agency_id: 'ag_not_interested', probe_status: 'CLOSED', probe_timestamp: iso(T0 - 45 * DAY) },
    { probe_id: 'pr_opt_out', agency_id: 'ag_opt_out', probe_status: 'CLOSED', probe_timestamp: iso(T0 - 45 * DAY) },
    // A hand-edited/legacy row: still 'draft' but carrying a timestamp. This
    // must never count as sent — only probe_status does (see
    // isProbeSentOrComplete in lib/calling-queue.mjs).
    { probe_id: 'pr_draft_ts', agency_id: 'ag_draft_with_timestamp', probe_status: 'DRAFT', probe_timestamp: iso(T0 - 1 * DAY) },
  ];
  const replies = [
    { reply_event_id: 'rw1', agency_id: 'ag_weak_reply', classification: 'NOT_NOW', received_at: iso(T0 - 10 * DAY) },
    { reply_event_id: 'rs1', agency_id: 'ag_strong_reply_new', classification: 'POSITIVE_MEETING', received_at: iso(T0 - 1 * DAY) },
    { reply_event_id: 'rn1', agency_id: 'ag_not_interested', classification: 'NOT_INTERESTED', received_at: iso(T0 - 20 * DAY) },
    { reply_event_id: 'ro1', agency_id: 'ag_opt_out', classification: 'OPT_OUT', received_at: iso(T0 - 20 * DAY) },
  ];
  const demos = [
    { demo_id: 'd1', agency_id: 'ag_demo_engaged', view_count: 3, cta_clicked_at: '', created_at: iso(T0 - 20 * DAY), updated_at: iso(T0 - 20 * DAY) },
  ];
  const actions = [
    actionRow({ action_id: 'a_cb', agency_id: 'ag_callback_due', action_type: 'CALL_PROSPECT', due_at: iso(T0 - 2 * DAY), metadata_json: JSON.stringify({ call_action: true, callback_reason: 'Callback requested' }) }),
  ];
  const ws = buildCallingWorkspace({
    AGENCIES: table(AG, agencies), ACTIONS: table(ACTIONS_HEADER, actions), CALLS: table(CALLS_HEADER, []),
    SCRIPTS: table(SCRIPTS_HEADER, []), OBJECTIONS: table(OBJECTIONS_HEADER, []), CALL_OBJECTION_EVENTS: table(CALL_OBJECTION_EVENTS_HEADER, []),
    REPLY_EVENTS: table(['reply_event_id', 'agency_id', 'classification', 'received_at'], replies),
    PROBES: table(['probe_id', 'agency_id', 'probe_status', 'probe_timestamp'], probes),
    DEMOS: table(['demo_id', 'agency_id', 'view_count', 'cta_clicked_at', 'created_at', 'updated_at'], demos),
    CONTACTS: { header: [], rows: [] }, INTELLIGENCE: { header: [], rows: [] },
  }, { now: iso(T0) });

  assert.ok(!ws.queue.some((l) => l.agency_id === 'ag_never_probed'), 'an agency with no PROBES row at all is excluded');
  assert.ok(!ws.queue.some((l) => l.agency_id === 'ag_draft_probe'), 'a DRAFT-only probe was never sent, so it is excluded too');
  assert.ok(!ws.queue.some((l) => l.agency_id === 'ag_draft_with_timestamp'), 'a DRAFT probe can never become eligible solely because probe_timestamp happens to be populated');
  assert.equal(ws.counts.no_probe, 3);
  ok('cold-call eligibility: no probe, a DRAFT probe, or a DRAFT probe with a stray timestamp, all keep an agency out of the queue — only probe_status counts');

  assert.deepEqual(ws.queue.map((l) => l.agency_id), [
    'ag_callback_due', 'ag_demo_engaged', 'ag_strong_reply_new', 'ag_weak_reply', 'ag_no_interaction_old', 'ag_no_interaction_new',
    'ag_not_interested', 'ag_opt_out',
  ]);
  ok('a sent probe with no reply or demo activity is still included, just ranked behind engagement');
  assert.equal(ws.queue[0].bucket, 1, 'explicit overdue callback still outranks every cold-call candidate');

  const byId = Object.fromEntries(ws.queue.map((l) => [l.agency_id, l]));
  assert.equal(byId.ag_strong_reply_new.engagement_tier, 1);
  assert.equal(byId.ag_strong_reply_new.due_reason, 'Replied');
  assert.equal(byId.ag_demo_engaged.engagement_tier, 1);
  assert.equal(byId.ag_demo_engaged.due_reason, 'Demo viewed');
  assert.equal(byId.ag_weak_reply.engagement_tier, 2);
  assert.equal(byId.ag_weak_reply.due_reason, 'Email activity');
  assert.equal(byId.ag_no_interaction_old.engagement_tier, 3);
  assert.equal(byId.ag_no_interaction_old.due_reason, 'No interaction');
  ok('engagement tiers and their operator-facing labels come from REPLY_EVENTS classification and DEMOS view/CTA analytics only');

  // ag_strong_reply_new's probe (2 days ago) is far newer than
  // ag_no_interaction_old's (60 days ago), yet strong engagement still wins.
  assert.ok(ws.queue.indexOf(byId.ag_strong_reply_new) < ws.queue.indexOf(byId.ag_no_interaction_old));
  ok('strong engagement outranks no engagement even with a much newer probe date');

  // Within tier 3, oldest probe first.
  assert.ok(ws.queue.indexOf(byId.ag_no_interaction_old) < ws.queue.indexOf(byId.ag_no_interaction_new));
  ok('within the same engagement tier, the oldest probe sent/completed date wins');

  // Tier 4 — negative email signal. Still callable (REPLY_EVENTS is
  // channel-specific and never suppresses the phone), but ranked below every
  // ordinary tier-3 "No interaction" lead, even one with a much older probe.
  assert.equal(byId.ag_not_interested.engagement_tier, 4);
  assert.equal(byId.ag_not_interested.due_reason, 'Email declined');
  assert.equal(byId.ag_not_interested.suppression, '', 'NOT_INTERESTED by email is not phone suppression');
  assert.equal(byId.ag_opt_out.engagement_tier, 4);
  assert.equal(byId.ag_opt_out.due_reason, 'Email opt-out');
  assert.equal(byId.ag_opt_out.suppression, '', 'an email OPT_OUT remains callable unless a phone-specific rule also suppresses it');
  assert.ok(ws.queue.indexOf(byId.ag_no_interaction_new) < ws.queue.indexOf(byId.ag_not_interested), 'NOT_INTERESTED by email ranks below an untouched probe');
  assert.ok(ws.queue.indexOf(byId.ag_no_interaction_new) < ws.queue.indexOf(byId.ag_opt_out), 'OPT_OUT by email ranks below an untouched probe');
  ok('a negative email signal (NOT_INTERESTED / OPT_OUT) drops a lead to the lowest cold-call tier without suppressing the phone');
}

// ── 2b. deliberate script override becomes the new "last heard" version ────
{
  const AG = ['agency_id', 'clean_agency_name', 'main_phone'];
  const scripts = [
    { script_id: 'scr_ov1', script_key: 'k2', name: 'Override Test', version: 1, status: 'ARCHIVED' },
    { script_id: 'scr_ov2', script_key: 'k2', name: 'Override Test', version: 2, status: 'CURRENT' },
  ];
  const calls = [
    // Called first with v1 (since archived); later deliberately overridden to v2.
    callRow({ call_id: 'ov1', agency_id: 'ag_override', started_at: iso(T0 - 2 * DAY), outcome: 'NO_ANSWER', script_id: 'scr_ov1' }),
    callRow({ call_id: 'ov2', agency_id: 'ag_override', started_at: iso(T0 - DAY), outcome: 'NO_ANSWER', script_id: 'scr_ov2' }),
  ];
  const ws = buildCallingWorkspace({
    AGENCIES: table(AG, [{ agency_id: 'ag_override', clean_agency_name: 'Override Agency', main_phone: '01234 999000' }]),
    ACTIONS: table(ACTIONS_HEADER, []), CALLS: table(CALLS_HEADER, calls), SCRIPTS: table(SCRIPTS_HEADER, scripts),
    OBJECTIONS: table(OBJECTIONS_HEADER, []), CALL_OBJECTION_EVENTS: table(CALL_OBJECTION_EVENTS_HEADER, []),
    REPLY_EVENTS: { header: [], rows: [] }, CONTACTS: { header: [], rows: [] }, INTELLIGENCE: { header: [], rows: [] },
  }, { now: iso(T0) });
  const lead = ws.leads.ag_override || ws.queue.find((l) => l.agency_id === 'ag_override');
  assert.equal(lead.script.script_id, 'scr_ov2', 'the later, deliberately overridden version is what sticks — never reverting to the first version called with');
  ok('a deliberate script override on a later call becomes the lead\'s new assigned version');
}

// ── 2c. {{property}} — lead.context.property resolves from PROBES ──────────
// Reuses the one existing property_street/property_address rule
// (lib/property-reference.mjs — the same field Instantly's {{property_street}}
// already uses), scoped to whichever probe is genuinely sent/live, most
// recent first — never a hand-invented new field.
{
  const AG = ['agency_id', 'clean_agency_name', 'main_phone'];
  const PROBE_HEADER = ['probe_id', 'agency_id', 'probe_status', 'probe_timestamp', 'property_street', 'property_address'];
  const agencies = [
    { agency_id: 'ag_prop_stored', clean_agency_name: 'Stored Street', main_phone: '01234 800001' },
    { agency_id: 'ag_prop_derived', clean_agency_name: 'Derived Street', main_phone: '01234 800002' },
    { agency_id: 'ag_prop_multi', clean_agency_name: 'Multiple Probes', main_phone: '01234 800003' },
    { agency_id: 'ag_prop_draft_only', clean_agency_name: 'Draft Probe Only', main_phone: '01234 800004' },
    { agency_id: 'ag_prop_no_probe', clean_agency_name: 'No Probe At All', main_phone: '01234 800005' },
    { agency_id: 'ag_prop_unresolvable', clean_agency_name: 'Unresolvable Address', main_phone: '01234 800006' },
  ];
  const probes = [
    { probe_id: 'pp_stored', agency_id: 'ag_prop_stored', probe_status: 'CLOSED', probe_timestamp: iso(T0 - 5 * DAY), property_street: '14 Oak Road', property_address: '' },
    { probe_id: 'pp_derived', agency_id: 'ag_prop_derived', probe_status: 'OBSERVING', probe_timestamp: iso(T0 - 3 * DAY), property_street: '', property_address: '10 High Street, Billericay, CM12 9AB' },
    // Two genuine probes for the same agency: the OLDER one carries a
    // different street. The most recent genuine probe must win.
    { probe_id: 'pp_multi_old', agency_id: 'ag_prop_multi', probe_status: 'CLOSED', probe_timestamp: iso(T0 - 40 * DAY), property_street: 'Old Lane', property_address: '' },
    { probe_id: 'pp_multi_new', agency_id: 'ag_prop_multi', probe_status: 'ACTIVE', probe_timestamp: iso(T0 - 2 * DAY), property_street: 'New Close', property_address: '' },
    // Only a DRAFT probe — never genuinely sent, so it must not supply a property.
    { probe_id: 'pp_draft', agency_id: 'ag_prop_draft_only', probe_status: 'DRAFT', probe_timestamp: '', property_street: 'Should Not Appear', property_address: '' },
    // A genuine probe with neither a usable street nor a usable address.
    { probe_id: 'pp_unresolvable', agency_id: 'ag_prop_unresolvable', probe_status: 'CLOSED', probe_timestamp: iso(T0 - 1 * DAY), property_street: '', property_address: 'Unknown address' },
  ];
  const ws = buildCallingWorkspace({
    AGENCIES: table(AG, agencies), ACTIONS: table(ACTIONS_HEADER, []), CALLS: table(CALLS_HEADER, []),
    SCRIPTS: table(SCRIPTS_HEADER, []), OBJECTIONS: table(OBJECTIONS_HEADER, []), CALL_OBJECTION_EVENTS: table(CALL_OBJECTION_EVENTS_HEADER, []),
    REPLY_EVENTS: { header: [], rows: [] }, CONTACTS: { header: [], rows: [] }, INTELLIGENCE: { header: [], rows: [] },
    PROBES: table(PROBE_HEADER, probes), DEMOS: { header: [], rows: [] },
  }, { now: iso(T0) });

  assert.equal(ws.leads.ag_prop_stored.context.property, '14 Oak Road', 'a stored property_street is used as-is');
  assert.equal(ws.leads.ag_prop_derived.context.property, '10 High Street', 'a blank property_street derives from property_address');
  ok('{{property}} resolves via the existing property_street/property_address rule (lib/property-reference.mjs), not a new field');

  assert.equal(ws.leads.ag_prop_multi.context.property, 'New Close', 'the most recent genuine sent/live probe wins over an older one');
  ok('multiple probes on one agency: the documented rule (genuine sent/live, most recent) decides which property is used');

  assert.equal(ws.leads.ag_prop_draft_only.context.property, '', 'a DRAFT-only probe is never genuine, so it supplies no property');
  assert.equal(ws.leads.ag_prop_no_probe.context.property, '', 'no PROBES row at all resolves to no property');
  assert.equal(ws.leads.ag_prop_unresolvable.context.property, '', 'a genuine probe with no usable street or address still resolves to no property');
  ok('a missing property resolves to an empty context field rather than throwing or inventing a value');
}

// ── 2d. {{property}} — Calling Mode script rendering (novus/calling.html) ──
// Loads the real scriptHtml()/esc()/firstName() functions straight out of
// novus/calling.html (not a hand copy, so this cannot silently drift from
// the shipped code) and exercises the actual substitution + fallback.
{
  const fs = await import('node:fs');
  const url = await import('node:url');
  const callingHtml = fs.readFileSync(url.fileURLToPath(new URL('../novus/calling.html', import.meta.url)), 'utf8');
  const extractFn = (name, { multiline = false } = {}) => {
    const re = multiline
      ? new RegExp(`function ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n\\}`)
      : new RegExp(`function ${name}\\([^)]*\\)\\{.*\\}`);
    const m = callingHtml.match(re);
    assert.ok(m, `could not find function ${name}() in novus/calling.html — has it been renamed?`);
    return m[0];
  };
  const scriptHtml = new Function(
    `${extractFn('esc')}\n${extractFn('firstName')}\n${extractFn('scriptHtml', { multiline: true })}\nreturn scriptHtml;`
  )();

  const leadWithProperty = { contact_name: 'Ian Smith', agency_name: 'Smith & Co', location: 'Billericay', context: { property: '14 Oak Road' } };
  const content = 'Hi, is that {{first_name}}? It was actually on {{property}}. I\'d said in the enquiry that I had a property to sell as well.';
  const rendered = scriptHtml(content, leadWithProperty);
  assert.ok(rendered.includes('<span class="var">14 Oak Road</span>'), 'the resolved property renders as a filled-in variable');
  assert.ok(rendered.includes('<span class="var">Ian</span>'), 'the existing placeholders keep working alongside {{property}}');
  assert.ok(!rendered.includes('{{property}}'), 'the raw template syntax never reaches the screen');
  assert.equal(content, 'Hi, is that {{first_name}}? It was actually on {{property}}. I\'d said in the enquiry that I had a property to sell as well.', 'the stored script content itself is never mutated — substitution happens only in the rendered output');
  ok('{{property}} substitutes the resolved probe property at render time, leaving the stored script untouched');

  const leadWithoutProperty = { contact_name: 'Ian Smith', agency_name: 'Smith & Co', location: 'Billericay', context: { property: '' } };
  const missing = scriptHtml('On {{property}} you mentioned...', leadWithoutProperty);
  assert.ok(missing.includes('[property unavailable]'), 'an unresolved property renders a clear neutral fallback');
  assert.ok(!missing.includes('{{property}}'), 'the raw template syntax never reaches the screen even when unresolved');
  assert.ok(!missing.includes('Smith &amp; Co') && !missing.includes('Smith & Co'), 'a missing property never silently falls back to the agency name or another field');
  ok('a missing property fails gracefully — a labelled fallback, never raw template syntax and never a substituted wrong field');
}

// ── 3. handlers end to end against the in-memory workbook ──────────────────
{
  const AG = ['agency_id', 'clean_agency_name', 'main_phone', 'outreach_contact_name', 'current_pipeline_status', 'updated_at'];
  const { store, repo } = makeStore({
    AGENCIES: [AG, ['ag_1', 'Tinsley & Co', '01277 781030', 'Ian Tinsley', '', ''], ['ag_2', 'Second Agency', '01234 000000', '', '', '']],
    ACTIONS: [ACTIONS_HEADER.slice(), ACTIONS_HEADER.map((_, i) => (i === 0 ? 'SCHEMA NOTE' : ''))],
    REPLY_EVENTS: [['reply_event_id', 'agency_id', 'classification', 'received_at', 'suppression_type']],
    PROBES: [
      ['probe_id', 'agency_id', 'probe_status', 'probe_timestamp'],
      ['pr_1', 'ag_1', 'CLOSED', iso(T0 - 10 * DAY)],
      ['pr_2', 'ag_2', 'CLOSED', iso(T0 - 5 * DAY)],
    ],
  });
  __setRepoForTests(repo);
  process.env.NOVUS_BASIC_AUTH_USER = 'novus'; process.env.NOVUS_BASIC_AUTH_PASS = 'testpass';
  const { default: handler } = await import('../api/novus/personalisation.js');
  const basic = 'Basic ' + Buffer.from('novus:testpass').toString('base64');
  const response = () => ({ statusCode: 200, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; }, setHeader(k, v) { this.headers[k] = v; } });
  const call = async (method, operation, body, query = {}) => { const res = response(); await handler({ method, query: { novus_operation: operation, ...query }, headers: { authorization: basic }, body }, res); return res; };

  const denied = response();
  await handler({ method: 'GET', query: { novus_operation: 'calling-workspace' }, headers: {} }, denied);
  assert.equal(denied.statusCode, 401);
  ok('calling workspace requires Basic Auth');

  let res = await call('GET', 'calling-workspace', null, { refresh: '1' });
  assert.equal(res.statusCode, 200); assert.equal(res.body.setup.available, false);
  assert.deepEqual(res.body.setup.missing.sort(), ['CALLS', 'CALL_OBJECTION_EVENTS', 'OBJECTIONS', 'SCRIPTS']);
  ok('workspace reports missing tabs instead of failing');

  res = await call('POST', 'calling-setup', {});
  assert.equal(res.statusCode, 400);
  res = await call('POST', 'calling-setup', { confirm: 'SETUP_CALLING_TABS' });
  assert.equal(res.statusCode, 200); assert.equal(res.body.seeded.script, true); assert.equal(res.body.seeded.objections, 6);
  assert.deepEqual(store.SCRIPTS[0], SCRIPTS_HEADER.slice()); assert.equal(store.SCRIPTS[1][0], 'SCHEMA NOTE');
  res = await call('POST', 'calling-setup', { confirm: 'SETUP_CALLING_TABS' });
  assert.equal(res.body.seeded.script, false); assert.equal(res.body.tabs.every((t) => t.result === 'exists'), true);
  ok('setup creates the four tabs with header + schema note, seeds once, and is idempotent');

  res = await call('GET', 'calling-workspace', null, { refresh: '1' });
  assert.equal(res.body.setup.available, true);
  assert.equal(res.body.queue.length, 2);
  assert.equal(res.body.queue[0].agency_id, 'ag_1');
  assert.equal(res.body.current_script.name, 'Seller Opportunity');
  assert.equal(res.body.active_objections.length, 6);
  const currentId = res.body.current_script.script_id;
  ok('workspace lists callable leads with the CURRENT script assigned');

  // Script versioning.
  res = await call('POST', 'script-save', { confirm: 'SAVE_SCRIPT', script_id: currentId, name: 'Seller Opportunity', content: 'Hi, is that {{name}}?', notes: '' });
  assert.equal(res.statusCode, 200); assert.equal(res.body.new_version, false);
  ok('a script with no calls can be edited in place');

  // Save a call (manual mode) with objections + commercial fields.
  const objections = res.body && (await call('GET', 'calling-workspace', null, { refresh: '1' })).body.active_objections;
  res = await call('POST', 'calling-save', { confirm: 'SAVE_CALL', agency_id: 'ag_1', outcome: 'MORE_INFO_REQUESTED' });
  assert.equal(res.statusCode, 400);
  ok('a call cannot be saved without its conditional fields');
  res = await call('POST', 'calling-save', {
    confirm: 'SAVE_CALL', client_key: 'ck-1', agency_id: 'ag_1', script_id: currentId, contact_name: 'Ian Tinsley', phone: '01277 781030',
    call_mode: 'MANUAL', started_at: iso(T0), ended_at: iso(T0 + 180_000), duration_seconds: 180,
    outcome: 'MORE_INFO_REQUESTED', more_info_type: 'PRICING', more_info_note: 'wants the tier sheet',
    objections: [{ objection_id: objections[0].objection_id, clicked_at: iso(T0 + 60_000), offset_seconds: 60, source: 'LIVE' }],
    main_priority: 'VALUATIONS', main_constraint: 'TEAM_CAPACITY', useful_note: 'Two branches, owner runs sales himself',
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(res.body.call.pitched, 'TRUE'); assert.equal(res.body.call.owner_reached, 'TRUE'); assert.equal(res.body.call.connected, 'TRUE');
  assert.equal(res.body.call.attempt_number, 1); assert.equal(res.body.call.objections, objections[0].title);
  assert.equal(res.body.objection_events, 1);
  assert.deepEqual(res.body.actions_created.map((a) => a.action_type).sort(), ['CALL_PROSPECT', 'SEND_INFORMATION']);
  assert.equal(store.CALLS.length, 3); assert.equal(store.CALL_OBJECTION_EVENTS.length, 3); assert.equal(store.ACTIONS.length, 4);
  const callId = res.body.call.call_id;
  ok('saving a call writes one immutable CALLS row, its objection event, and both follow-up actions');

  res = await call('POST', 'calling-save', { confirm: 'SAVE_CALL', client_key: 'ck-1', agency_id: 'ag_1', outcome: 'NO_ANSWER' });
  assert.equal(res.statusCode, 200); assert.equal(res.body.reused, true); assert.equal(res.body.call.call_id, callId);
  assert.equal(store.CALLS.length, 3); assert.equal(store.ACTIONS.length, 4);
  ok('a retried save with the same client_key is idempotent');

  // The script now has a call: editing content must version.
  res = await call('POST', 'script-save', { confirm: 'SAVE_SCRIPT', script_id: currentId, name: 'Seller Opportunity', content: 'Hi, is that {{name}}? v2', notes: '' });
  assert.equal(res.statusCode, 409); assert.equal(res.body.has_calls, true);
  res = await call('POST', 'script-save', { confirm: 'SAVE_SCRIPT', script_id: currentId, name: 'Seller Opportunity', content: 'Hi, is that {{name}}? v2', notes: '', as_new_version: true });
  assert.equal(res.statusCode, 200); assert.equal(res.body.new_version, true); assert.equal(res.body.script.version, 2); assert.equal(res.body.script.status, 'CURRENT');
  let ws = (await call('GET', 'calling-workspace', null, { refresh: '1' })).body;
  assert.deepEqual(ws.scripts.map((s) => [s.version, s.status, s.call_count]), [[2, 'CURRENT', 0], [1, 'ARCHIVED', 1]]);
  assert.equal(ws.scripts[1].content, 'Hi, is that {{name}}?', 'historical content untouched');
  assert.equal(ws.scripts[1].funnel.more_info, 1);
  ok('editing a script with calls creates v2 as CURRENT and leaves v1 frozen with its funnel');

  res = await call('POST', 'script-duplicate', { confirm: 'DUPLICATE_SCRIPT', script_id: ws.scripts[0].script_id });
  assert.equal(res.statusCode, 201); assert.equal(res.body.script.version, 3); assert.equal(res.body.script.status, 'TESTING');
  ok('duplicate as new version yields a TESTING v3');

  // Objection versioning after a logged click.
  res = await call('POST', 'objection-save', { confirm: 'SAVE_OBJECTION', objection_id: objections[0].objection_id, title: objections[0].title, response: 'A better response.' });
  assert.equal(res.statusCode, 200); assert.equal(res.body.new_version, true); assert.equal(res.body.objection.version, 2);
  ws = (await call('GET', 'calling-workspace', null, { refresh: '1' })).body;
  assert.equal(ws.active_objections.length, 6);
  assert.equal(ws.objections.find((o) => o.objection_id === objections[0].objection_id).active, false);
  ok('rewording a clicked objection creates a new active version and retires the old one');

  // The lead now has a scheduled follow-up call (2 working days) and is out of the queue.
  ws = (await call('GET', 'calling-workspace', null, { refresh: '1' })).body;
  assert.deepEqual(ws.queue.map((l) => l.agency_id), ['ag_2']);
  assert.equal(ws.call_actions.length, 1); assert.equal(ws.call_actions[0].kind, 'CALLBACK');
  ok('after a saved call the lead leaves the queue until its callback is due');

  // Booked meeting → terminal + PREPARE_MEETING; the pending call action closes.
  res = await call('POST', 'calling-save', {
    confirm: 'SAVE_CALL', client_key: 'ck-2', agency_id: 'ag_1', script_id: ws.scripts[0].script_id, call_mode: 'MANUAL',
    started_at: iso(T0 + DAY), outcome: 'BOOKED_MEETING', meeting_at: iso(T0 + 7 * DAY), meeting_note: 'In person',
  });
  assert.equal(res.statusCode, 201); assert.equal(res.body.terminal, 'MEETING_BOOKED'); assert.equal(res.body.call.attempt_number, 2);
  assert.equal(res.body.actions_completed.length, 1);
  assert.equal(store.AGENCIES[1][4], 'MEETING_BOOKED');
  ws = (await call('GET', 'calling-workspace', null, { refresh: '1' })).body;
  assert.equal(ws.leads.ag_1.suppression, 'pipeline status MEETING_BOOKED');
  assert.equal(ws.call_actions.length, 0);
  assert.equal(ws.followups_pending.length, 0);
  ok('BOOKED_MEETING marks the agency terminal, completes the open call action and creates meeting prep');

  // ── single CURRENT script, enforced server-side ─────────────────────────
  const scriptsBefore = ws.scripts;
  const testing = scriptsBefore.find((x) => x.status === 'TESTING');
  // Hand-edit the sheet into two CURRENT rows: the read must stay deterministic and report it.
  const statusCol = SCRIPTS_HEADER.indexOf('status');
  const testingRow = store.SCRIPTS.find((r) => r[0] === testing.script_id); testingRow[statusCol] = 'CURRENT';
  ws = (await call('GET', 'calling-workspace', null, { refresh: '1' })).body;
  assert.equal(ws.current_script_conflicts.length, 1);
  assert.ok(ws.current_script.script_id, 'exactly one current script is still chosen');
  res = await call('POST', 'script-status', { confirm: 'SET_SCRIPT_STATUS', script_id: testing.script_id, status: 'CURRENT' });
  assert.equal(res.statusCode, 200);
  ws = (await call('GET', 'calling-workspace', null, { refresh: '1' })).body;
  assert.deepEqual(ws.scripts.filter((x) => x.status === 'CURRENT').map((x) => x.script_id), [testing.script_id]);
  assert.equal(ws.current_script_conflicts.length, 0);
  res = await call('POST', 'script-save', { confirm: 'SAVE_SCRIPT', name: 'Lettings', content: 'x', status: 'CURRENT' });
  ws = (await call('GET', 'calling-workspace', null, { refresh: '1' })).body;
  assert.equal(ws.scripts.filter((x) => x.status === 'CURRENT').length, 1);
  assert.equal(ws.current_script.name, 'Lettings');
  assert.equal(ws.scripts.find((x) => x.script_id === testing.script_id).status, 'ARCHIVED');
  ok('making any script CURRENT demotes every other CURRENT row, including hand-edited duplicates');

  // ── partial failure: the CALLS row lands, the ACTIONS write fails ───────
  const realAppend = repo.appendRowsBatch.bind(repo);
  let failActions = true;
  repo.appendRowsBatch = async (tab, rows) => { if (tab === 'ACTIONS' && failActions) throw new Error('simulated Sheets 503'); return realAppend(tab, rows); };
  res = await call('POST', 'calling-save', { confirm: 'SAVE_CALL', client_key: 'ck-fail', agency_id: 'ag_2', call_mode: 'MANUAL', outcome: 'OWNER_UNAVAILABLE', callback_at: iso(T0 + 3 * DAY), callback_note: 'Try Thursday' });
  assert.equal(res.statusCode, 201); assert.equal(res.body.followups_complete, false);
  assert.match(res.body.warnings.join(' '), /simulated Sheets 503/);
  const failedId = res.body.call.call_id;
  assert.equal(store.CALLS.filter((r) => r[0] === failedId).length, 1, 'the call row itself was written');
  ws = (await call('GET', 'calling-workspace', null, { refresh: '1' })).body;
  assert.deepEqual(ws.followups_pending.map((c) => c.call_id), [failedId]);
  assert.equal(ws.call_actions.filter((a) => a.agency_id === 'ag_2').length, 0);
  ok('a follow-up write failure leaves the call saved and flagged PENDING, never silently dropped');
  const actionsBefore = store.ACTIONS.length;
  failActions = false;
  res = await call('POST', 'calling-save', { confirm: 'SAVE_CALL', client_key: 'ck-fail', agency_id: 'ag_2', outcome: 'NO_ANSWER' });
  assert.equal(res.statusCode, 200); assert.equal(res.body.reused, true); assert.equal(res.body.followups_complete, true);
  assert.equal(res.body.actions_created.length, 1); assert.equal(res.body.actions_created[0].action_type, 'CALL_PROSPECT');
  assert.equal(res.body.actions_created[0].due_at, iso(T0 + 3 * DAY));
  assert.equal(JSON.parse(res.body.actions_created[0].metadata_json).callback_note, 'Try Thursday');
  assert.equal(store.ACTIONS.length, actionsBefore + 1);
  assert.equal(store.CALLS.filter((r) => r[0] === failedId).length, 1);
  res = await call('POST', 'calling-save', { confirm: 'SAVE_CALL', client_key: 'ck-fail', agency_id: 'ag_2', outcome: 'NO_ANSWER' });
  assert.equal(res.body.actions_created.length, 0); assert.equal(store.ACTIONS.length, actionsBefore + 1);
  ws = (await call('GET', 'calling-workspace', null, { refresh: '1' })).body;
  assert.equal(ws.followups_pending.length, 0);
  ok('a retried save re-runs only the missing follow-ups from the stored row, exactly once');
  // The repair operation takes the same path for rows left PENDING.
  failActions = true;
  await call('POST', 'calling-save', { confirm: 'SAVE_CALL', client_key: 'ck-fail-2', agency_id: 'ag_2', call_mode: 'MANUAL', outcome: 'GATEKEPT' });
  failActions = false;
  res = await call('POST', 'calling-repair', { confirm: 'REPAIR_CALL_FOLLOWUPS' });
  assert.equal(res.statusCode, 200); assert.equal(res.body.repaired, 1); assert.equal(res.body.still_pending, 0);
  assert.equal(res.body.results[0].actions_created, 1);
  res = await call('POST', 'calling-repair', { confirm: 'REPAIR_CALL_FOLLOWUPS' });
  assert.equal(res.body.repaired, 0);
  ok('calling-repair heals PENDING rows idempotently');
  repo.appendRowsBatch = realAppend;

  // ── 4. Twilio browser calling ──────────────────────────────────────────
  for (const key of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET', 'TWILIO_TWIML_APP_SID', 'TWILIO_CALLER_ID', 'NOVUS_PUBLIC_BASE_URL']) delete process.env[key];
  res = await call('GET', 'twilio-token');
  assert.equal(res.statusCode, 200); assert.equal(res.body.enabled, false); assert.equal(res.body.missing.length, 7);
  ok('twilio-token reports every missing variable instead of failing when browser calling is unconfigured');

  Object.assign(process.env, { TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'authtok', TWILIO_API_KEY_SID: 'SKtest', TWILIO_API_KEY_SECRET: 'sekret', TWILIO_TWIML_APP_SID: 'APtest', TWILIO_CALLER_ID: '+447700900000', NOVUS_PUBLIC_BASE_URL: 'https://novus.test' });
  assert.equal(twilioCallingConfig().enabled, true);
  res = await call('GET', 'twilio-token');
  assert.equal(res.body.enabled, true); assert.equal(res.body.caller_id, '+447700900000');
  const jwt = decodeJwt(res.body.token);
  assert.equal(jwt.header.cty, 'twilio-fpa;v=1'); assert.equal(jwt.header.alg, 'HS256');
  assert.equal(jwt.payload.iss, 'SKtest'); assert.equal(jwt.payload.sub, 'ACtest');
  assert.equal(jwt.payload.grants.voice.outgoing.application_sid, 'APtest'); assert.equal(jwt.payload.grants.voice.incoming.allow, false);
  assert.ok(jwt.payload.exp - jwt.payload.iat === 3600);
  assert.ok(!res.body.token.includes('sekret'));
  const denied2 = response();
  await handler({ method: 'GET', query: { novus_operation: 'twilio-token' }, headers: {} }, denied2);
  assert.equal(denied2.statusCode, 401);
  ok('twilio-token mints a one-hour outgoing-only Voice grant behind Basic Auth, without leaking the secret');
  assert.throws(() => createVoiceAccessToken({ accountSid: 'AC', apiKeySid: '', apiKeySecret: 's', twimlAppSid: 'AP', identity: 'x' }), /apiKeySid/);

  // Open a Twilio-mode call on ag_2.
  res = await call('POST', 'calling-start', { confirm: 'START_CALL', client_key: 'ck-tw', agency_id: 'ag_2', call_mode: 'TWILIO', phone: '01234 000000', started_at: iso(T0 + 2 * DAY) });
  assert.equal(res.statusCode, 201); const twCallId = res.body.call.call_id; assert.equal(res.body.call.call_status, 'queued');
  res = await call('POST', 'calling-start', { confirm: 'START_CALL', client_key: 'ck-tw', agency_id: 'ag_2', call_mode: 'TWILIO' });
  assert.equal(res.body.reused, true); assert.equal(res.body.call.call_id, twCallId);
  ok('calling-start opens the CALLS row once per client_key');

  const webhook = async (operation, path, params, { signed = true } = {}) => {
    const r = { statusCode: 200, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; }, end() { return this; }, setHeader(k, v) { this.headers[k] = v; } };
    const headers = signed ? { 'x-twilio-signature': computeTwilioSignature('authtok', `https://novus.test${path}`, params) } : {};
    await handler({ method: 'POST', query: { novus_operation: operation }, headers, body: params }, r);
    return r;
  };
  res = await webhook('twilio-voice-outbound', '/api/novus/webhooks/voice-outbound', { CallSid: 'CAparent', call_id: twCallId, To: '+449999999999' }, { signed: false });
  assert.equal(res.statusCode, 401);
  ok('outbound TwiML webhook rejects an unsigned request without touching Sheets');
  res = await webhook('twilio-voice-outbound', '/api/novus/webhooks/voice-outbound', { CallSid: 'CAparent', call_id: twCallId, To: '+449999999999' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<Dial callerId="\+447700900000" answerOnBridge="true"/);
  assert.match(res.body, /record="record-from-answer-dual"/);
  assert.match(res.body, /recordingStatusCallback="https:\/\/novus.test\/api\/novus\/webhooks\/voice-outbound-recording"/);
  assert.match(res.body, /<Number statusCallback="https:\/\/novus.test\/api\/novus\/webhooks\/voice-outbound-status"[^>]*>\+441234000000<\/Number>/);
  assert.ok(!res.body.includes('+449999999999'), 'dials the stored number, never the request To');
  const twRow = () => Object.fromEntries(CALLS_HEADER.map((k, i) => [k, store.CALLS.find((r) => r[0] === twCallId)[i] ?? '']));
  assert.equal(twRow().twilio_call_sid, 'CAparent'); assert.equal(twRow().call_status, 'initiated');
  ok('signed outbound webhook returns a recorded <Dial> to the stored number and stamps the parent CallSid');
  res = await webhook('twilio-voice-outbound', '/api/novus/webhooks/voice-outbound', { CallSid: 'CAx', call_id: 'cal_missing' });
  assert.match(res.body, /<Hangup\/>/);

  await webhook('twilio-voice-status', '/api/novus/webhooks/voice-outbound-status', { CallSid: 'CAchild', ParentCallSid: 'CAparent', CallStatus: 'ringing' });
  assert.equal(twRow().call_status, 'ringing');
  await webhook('twilio-voice-status', '/api/novus/webhooks/voice-outbound-status', { CallSid: 'CAchild', ParentCallSid: 'CAparent', CallStatus: 'in-progress' });
  assert.equal(twRow().call_status, 'in-progress'); assert.ok(twRow().connected_at);
  await webhook('twilio-voice-status', '/api/novus/webhooks/voice-outbound-status', { CallSid: 'CAchild', ParentCallSid: 'CAparent', CallStatus: 'completed', CallDuration: '95' });
  assert.equal(twRow().call_status, 'completed'); assert.equal(twRow().duration_seconds, 95); assert.ok(twRow().ended_at);
  await webhook('twilio-voice-status', '/api/novus/webhooks/voice-outbound-status', { CallSid: 'CAchild', ParentCallSid: 'CAparent', CallStatus: 'ringing' });
  assert.equal(twRow().call_status, 'completed', 'late redelivery cannot move the call backwards');
  res = await webhook('twilio-voice-status', '/api/novus/webhooks/voice-outbound-status', { CallSid: 'CAparent', DialCallStatus: 'completed', DialCallDuration: '95' });
  assert.match(res.body, /<Response><\/Response>/);
  ok('status callbacks patch connected_at / ended_at / duration with precedence, and the Dial action gets empty TwiML');

  res = await webhook('twilio-voice-recording', '/api/novus/webhooks/voice-outbound-recording', { CallSid: 'CAparent', RecordingSid: 'REabc', RecordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Recordings/REabc', RecordingStatus: 'completed', RecordingDuration: '93' });
  assert.equal(res.body.matched, true); assert.equal(twRow().recording_sid, 'REabc'); assert.equal(twRow().recording_duration_seconds, 93);
  assert.equal(twRow().recording_url, '', 'the raw media URL is never stored');
  assert.ok(!JSON.stringify(store.CALLS).includes('api.twilio.com'), 'no Twilio media URL anywhere in the workbook');
  const unauth = response();
  await handler({ method: 'GET', query: { novus_operation: 'calling-recording', call_id: twCallId }, headers: {} }, unauth);
  assert.equal(unauth.statusCode, 401);
  ok('recording callback stores only the RecordingSid; playback is Basic-Auth proxied');

  res = await call('POST', 'calling-save', { confirm: 'SAVE_CALL', client_key: 'ck-tw', call_id: twCallId, agency_id: 'ag_2', call_mode: 'TWILIO', outcome: 'GATEKEPT', duration_seconds: 999 });
  assert.equal(res.statusCode, 200); assert.equal(res.body.call.call_id, twCallId);
  assert.equal(store.CALLS.filter((r) => r[0] === twCallId).length, 1);
  assert.equal(twRow().outcome, 'GATEKEPT'); assert.equal(twRow().recording_sid, 'REabc'); assert.equal(twRow().duration_seconds, 95, 'webhook timing wins over the browser clock');
  assert.equal(twRow().twilio_call_sid, 'CAparent'); assert.equal(twRow().call_status, 'completed');
  ok('saving the outcome patches the opened Twilio row in place, keeping webhook-written timing and recording');

  // ── 5. gatekeeper / owner classification (answer-screen tracking) ───────
  store.AGENCIES.push(
    ['ag_gk1', 'Direct Owner Co', '01234100001', '', '', ''],
    ['ag_gk2', 'Gatekeeper Only Co', '01234100002', '', '', ''],
    ['ag_gk3', 'Gatekeeper Then Owner Co', '01234100003', '', '', ''],
    ['ag_gk4', 'Gatekeeper Then Booked Co', '01234100004', '', '', ''],
  );
  const activeObjections = (await call('GET', 'calling-workspace', null, { refresh: '1' })).body.active_objections;

  // 1) Direct owner: OWNER clicked, straight through to a booked meeting.
  res = await call('POST', 'calling-save', {
    confirm: 'SAVE_CALL', client_key: 'ck-gk-direct', agency_id: 'ag_gk1', call_mode: 'MANUAL',
    owner_reached_at: iso(T0), owner_reach_source: 'DIRECT',
    outcome: 'BOOKED_MEETING', meeting_at: iso(T0 + 7 * DAY), meeting_note: 'Zoom',
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.call.gatekeeper_reached, 'FALSE');
  assert.equal(res.body.call.gatekeeper_reached_at, '');
  assert.equal(res.body.call.owner_reach_source, 'DIRECT');
  assert.equal(res.body.call.owner_reached_at, iso(T0));
  assert.equal(res.body.call.owner_reached, 'TRUE', 'the existing outcome-derived column is untouched by this feature');
  ok('direct owner: OWNER clicked once, owner_reach_source=DIRECT, gatekeeper never reached');

  // 2) Gatekeeper only: GATEKEEPER clicked, call ends without ever reaching the owner.
  res = await call('POST', 'calling-save', {
    confirm: 'SAVE_CALL', client_key: 'ck-gk-only', agency_id: 'ag_gk2', call_mode: 'MANUAL',
    gatekeeper_reached: true, gatekeeper_reached_at: iso(T0),
    outcome: 'GATEKEPT',
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.call.gatekeeper_reached, 'TRUE');
  assert.equal(res.body.call.gatekeeper_reached_at, iso(T0));
  assert.equal(res.body.call.owner_reached_at, '');
  assert.equal(res.body.call.owner_reach_source, '');
  assert.equal(res.body.call.owner_reached, 'FALSE');
  assert.equal(res.body.terminal, null);
  assert.equal(res.body.actions_created[0].action_type, 'RETRY_CALL');
  ok('gatekeeper only: gatekeeper_reached=true, owner never classified, GATEKEPT retry still scheduled');

  // 3) Gatekeeper then owner: GATEKEEPER, then "Got through to owner", objection logged
  //    once on the owner screen, outcome requires a real conversation.
  res = await call('POST', 'calling-save', {
    confirm: 'SAVE_CALL', client_key: 'ck-gk-then-owner', agency_id: 'ag_gk3', call_mode: 'MANUAL',
    gatekeeper_reached: true, gatekeeper_reached_at: iso(T0), owner_reached_at: iso(T0 + 60_000), owner_reach_source: 'VIA_GATEKEEPER',
    outcome: 'MORE_INFO_REQUESTED', more_info_type: 'PRICING',
    objections: [{ objection_id: activeObjections[0].objection_id, clicked_at: iso(T0 + 90_000), offset_seconds: 90, source: 'LIVE' }],
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.call.gatekeeper_reached, 'TRUE');
  assert.equal(res.body.call.owner_reached_at, iso(T0 + 60_000));
  assert.equal(res.body.call.owner_reach_source, 'VIA_GATEKEEPER');
  assert.equal(res.body.call.owner_reached, 'TRUE');
  assert.equal(res.body.objection_events, 1);
  assert.equal(res.body.call.objections, activeObjections[0].title);
  ok('gatekeeper then owner: owner_reach_source=VIA_GATEKEEPER, gatekeeper_reached preserved, objection logging on the owner screen still works');

  // 4) Gatekeeper -> owner -> booked meeting on a Twilio call: the row opened
  //    by calling-start is the SAME row the final save patches — no duplicate.
  res = await call('POST', 'calling-start', { confirm: 'START_CALL', client_key: 'ck-gk-booked', agency_id: 'ag_gk4', call_mode: 'TWILIO', phone: '01234100004' });
  assert.equal(res.statusCode, 201);
  const gkBookedCallId = res.body.call.call_id;
  assert.equal(store.CALLS.filter((r) => r[0] === gkBookedCallId).length, 1);
  res = await call('POST', 'calling-save', {
    confirm: 'SAVE_CALL', client_key: 'ck-gk-booked', call_id: gkBookedCallId, agency_id: 'ag_gk4', call_mode: 'TWILIO',
    gatekeeper_reached: true, gatekeeper_reached_at: iso(T0), owner_reached_at: iso(T0 + 60_000), owner_reach_source: 'VIA_GATEKEEPER',
    outcome: 'BOOKED_MEETING', meeting_at: iso(T0 + 7 * DAY), meeting_note: 'In branch',
  });
  assert.equal(res.statusCode, 200); assert.equal(res.body.call.call_id, gkBookedCallId);
  assert.equal(store.CALLS.filter((r) => r[0] === gkBookedCallId).length, 1, 'no duplicate CALLS row for the same call');
  assert.equal(res.body.call.gatekeeper_reached, 'TRUE');
  assert.equal(res.body.call.owner_reach_source, 'VIA_GATEKEEPER');
  assert.equal(res.body.terminal, 'MEETING_BOOKED');
  assert.equal(res.body.actions_created[0].action_type, 'PREPARE_MEETING');
  ok('gatekeeper -> owner -> booked meeting stays one CALLS row: dial, gatekeeper, owner and meeting-booked all recorded together');

  // 5) Repeated saves (e.g. a retried "Save & exit") never duplicate the
  //    classification or the row — the already-saved branch returns exactly
  //    what was first written.
  const beforeRepeat = store.CALLS.length;
  res = await call('POST', 'calling-save', { confirm: 'SAVE_CALL', client_key: 'ck-gk-then-owner', agency_id: 'ag_gk3', outcome: 'NOT_INTERESTED', not_interested_reason: 'TIMING' });
  assert.equal(res.statusCode, 200); assert.equal(res.body.reused, true);
  assert.equal(store.CALLS.length, beforeRepeat, 'no duplicate row on a repeated save');
  assert.equal(res.body.call.owner_reach_source, 'VIA_GATEKEEPER', 'classification from the first save is untouched by the retry');
  assert.equal(res.body.call.owner_reached_at, iso(T0 + 60_000));
  ok('a repeated save of the same call is idempotent and cannot duplicate or overwrite the gatekeeper/owner classification');

  // ── funnel counts the classification feeds ──────────────────────────────
  const gkFunnel = scriptFunnel(callRecords({ header: CALLS_HEADER.slice(), rows: store.CALLS.slice(1) })
    .filter((r) => ['ag_gk1', 'ag_gk2', 'ag_gk3', 'ag_gk4'].includes(r.agency_id)));
  assert.equal(gkFunnel.gatekeeper_reached, 3);
  assert.equal(gkFunnel.owner_reached_direct, 1);
  assert.equal(gkFunnel.owner_reached_via_gatekeeper, 2);
  assert.equal(gkFunnel.booked_meetings, 2);
  ok('scriptFunnel exposes gatekeeper_reached / owner_reached_direct / owner_reached_via_gatekeeper for the conversion counts');

  __setRepoForTests(null);
}

console.log(`\nNOVUS calling self-test passed (${passed} checks).`);
