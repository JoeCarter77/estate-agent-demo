#!/usr/bin/env node
// scripts/novus-calling-analytics-selftest.mjs — hermetic test of the Calling
// Analytics read model (lib/calling-analytics.mjs) and its GET operation on
// api/novus/personalisation.js. In-memory workbook, no network, no writes.
//
// Every assertion is a denominator check: the page is only useful if the
// figures divide the right things by the right things.
//
// Run:  npm run novus:calling-analytics-selftest

import assert from 'node:assert/strict';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { ACTIONS_HEADER } from '../lib/actions-store.mjs';
import { CALLS_HEADER, SCRIPTS_HEADER, OBJECTIONS_HEADER, CALL_OBJECTION_EVENTS_HEADER } from '../lib/calling-store.mjs';
import { buildCallingAnalytics, resolveRange, callFacts, SMALL_SAMPLE } from '../lib/calling-analytics.mjs';

let passed = 0;
const ok = (msg) => { passed += 1; console.log(`  ✓ ${msg}`); };

const iso = (ms) => new Date(ms).toISOString();
const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-15T14:00:00.000Z'); // Tue 15:00 BST
const table = (header, objs) => ({ header: [...header], rows: objs.map((o) => header.map((k) => o[k] ?? '')) });
const blank = (header) => Object.fromEntries(header.map((k) => [k, '']));

let seq = 0;
function callRow(o) {
  seq += 1;
  return { ...blank(CALLS_HEADER), call_id: `cal_${seq}`, agency_id: 'ag_1', call_mode: 'MANUAL', started_at: iso(NOW - HOUR), created_at: iso(NOW - HOUR), updated_at: iso(NOW - HOUR), connected: 'TRUE', owner_reached: 'FALSE', pitched: 'FALSE', gatekeeper_reached: 'FALSE', metadata_json: '{"followups":"COMPLETE"}', ...o };
}
function eventRow(callId, key, o = {}) {
  seq += 1;
  return { ...blank(CALL_OBJECTION_EVENTS_HEADER), event_id: `coe_${seq}`, call_id: callId, agency_id: 'ag_1', objection_id: `${key}_v1`, objection_key: key, objection_title: key, clicked_at: iso(NOW - HOUR), source: 'LIVE', created_at: iso(NOW - HOUR), ...o };
}
function actionRow(o) {
  seq += 1;
  return { ...blank(ACTIONS_HEADER), action_id: `act_${seq}`, agency_id: 'ag_1', action_owner: 'JOE', action_status: 'PENDING', source_stage: 'CALLING', created_at: iso(NOW - HOUR), updated_at: iso(NOW - HOUR), metadata_json: '{}', ...o };
}
const scripts = [
  { ...blank(SCRIPTS_HEADER), script_id: 'scr_a1', script_key: 'fam_a', name: 'Seller Opportunity', version: 1, status: 'ARCHIVED', created_at: iso(NOW - 30 * DAY), updated_at: iso(NOW - 30 * DAY) },
  { ...blank(SCRIPTS_HEADER), script_id: 'scr_a2', script_key: 'fam_a', name: 'Seller Opportunity', version: 2, status: 'CURRENT', created_at: iso(NOW - 10 * DAY), updated_at: iso(NOW - 10 * DAY) },
  { ...blank(SCRIPTS_HEADER), script_id: 'scr_b1', script_key: 'fam_b', name: 'Lettings', version: 1, status: 'TESTING', created_at: iso(NOW - 5 * DAY), updated_at: iso(NOW - 5 * DAY) },
];
const objections = [
  { ...blank(OBJECTIONS_HEADER), objection_id: 'busy_v1', objection_key: 'busy', title: "We're too busy", version: 1, active: 'FALSE', created_at: iso(NOW - 30 * DAY), updated_at: iso(NOW - 30 * DAY) },
  { ...blank(OBJECTIONS_HEADER), objection_id: 'busy_v2', objection_key: 'busy', title: 'Too busy right now', version: 2, active: 'TRUE', created_at: iso(NOW - 3 * DAY), updated_at: iso(NOW - 3 * DAY) },
  { ...blank(OBJECTIONS_HEADER), objection_id: 'send_v1', objection_key: 'send', title: 'Send me something', version: 1, active: 'TRUE', created_at: iso(NOW - 30 * DAY), updated_at: iso(NOW - 30 * DAY) },
  { ...blank(OBJECTIONS_HEADER), objection_id: 'crm_v1', objection_key: 'crm', title: 'We already use our CRM', version: 1, active: 'TRUE', created_at: iso(NOW - 30 * DAY), updated_at: iso(NOW - 30 * DAY) },
];
const build = (calls, events = [], actions = [], opts = {}) => buildCallingAnalytics({
  SCRIPTS: table(SCRIPTS_HEADER, scripts), OBJECTIONS: table(OBJECTIONS_HEADER, objections),
  CALLS: table(CALLS_HEADER, calls), CALL_OBJECTION_EVENTS: table(CALL_OBJECTION_EVENTS_HEADER, events),
  ACTIONS: table(ACTIONS_HEADER, actions), AGENCIES: { header: ['agency_id', 'clean_agency_name'], rows: [['ag_1', 'Tinsley & Co']] },
}, { now: iso(NOW), ...opts });

// ── 1. empty dataset ───────────────────────────────────────────────────────
{
  const a = build([]);
  assert.equal(a.summary.calls, 0);
  assert.equal(a.summary.gatekeeper_to_owner_pct, null);
  assert.equal(a.summary.owner_to_meeting_pct, null);
  assert.equal(a.summary.pitch_to_meeting_pct, null);
  assert.equal(a.summary.avg_duration_seconds, null);
  assert.deepEqual(a.funnel.steps.map((s) => s.count), [0, 0, 0, 0, 0]);
  assert.equal(a.outcomes.length, 10, 'every system outcome is listed even at zero');
  assert.ok(a.outcomes.every((o) => o.count === 0 && o.pct_of_calls === null));
  assert.deepEqual(a.objections.rows, []);
  assert.equal(a.scripts.length, 3, 'every script version is listed even with no calls');
  assert.equal(a.timing.reliable, false);
  assert.deepEqual(a.explorer.rows, []);
  ok('empty dataset: zero counts, null rates (never 0% or NaN), every enum still enumerated');
}

// ── 2. per-call reach facts ────────────────────────────────────────────────
{
  const direct = callFacts(callRow({ outcome: 'NOT_INTERESTED', owner_reached: 'TRUE', pitched: 'TRUE', owner_reach_source: 'DIRECT' }));
  assert.equal(direct.owner_reached, true); assert.equal(direct.gatekeeper_reached, false); assert.equal(direct.reach_source, 'DIRECT');
  const gkOnly = callFacts(callRow({ outcome: 'GATEKEPT', gatekeeper_reached: 'TRUE' }));
  assert.equal(gkOnly.owner_reached, false); assert.equal(gkOnly.gatekeeper_reached, true); assert.equal(gkOnly.reach_source, ''); assert.equal(gkOnly.pitched, false);
  const gkThenOwner = callFacts(callRow({ outcome: 'BOOKED_MEETING', owner_reached: 'TRUE', pitched: 'TRUE', gatekeeper_reached: 'TRUE', owner_reach_source: 'VIA_GATEKEEPER' }));
  assert.equal(gkThenOwner.owner_reached, true); assert.equal(gkThenOwner.gatekeeper_reached, true); assert.equal(gkThenOwner.reach_source, 'VIA_GATEKEEPER'); assert.equal(gkThenOwner.meeting, true);
  // Classified as owner on the answer screen, outcome later says owner unavailable: the classification still counts as reach.
  const classifiedOnly = callFacts(callRow({ outcome: 'CALLBACK_REQUESTED', owner_reached: 'FALSE', owner_reach_source: 'DIRECT' }));
  assert.equal(classifiedOnly.owner_reached, true);
  // Legacy row from before the answer screen: owner reached by outcome, source unknown — never guessed.
  const legacy = callFacts(callRow({ outcome: 'NOT_INTERESTED', owner_reached: 'TRUE', pitched: 'TRUE', gatekeeper_reached: '', owner_reach_source: '' }));
  assert.equal(legacy.owner_reached, true); assert.equal(legacy.reach_source, 'UNKNOWN');
  const noAnswer = callFacts(callRow({ outcome: 'NO_ANSWER', connected: 'FALSE' }));
  assert.equal(noAnswer.connected, false); assert.equal(noAnswer.pitched, false); assert.equal(noAnswer.owner_reached, false);
  assert.equal(callFacts(callRow({ duration_seconds: '0' })).duration_seconds, null);
  assert.equal(callFacts(callRow({ duration_seconds: '95.4' })).duration_seconds, 95);
  ok('direct owner / gatekeeper-only / gatekeeper→owner / legacy-unclassified / no-answer facts derive correctly');
}

// ── 3. funnel, gatekeeper conversion, pitched-vs-owner denominators ────────
{
  const calls = [
    callRow({ outcome: 'NO_ANSWER', connected: 'FALSE' }),
    callRow({ outcome: 'NO_ANSWER', connected: 'FALSE' }),
    callRow({ outcome: 'GATEKEPT', gatekeeper_reached: 'TRUE' }),                                                                       // gk only
    callRow({ outcome: 'OWNER_UNAVAILABLE', gatekeeper_reached: 'TRUE', callback_at: iso(NOW + DAY) }),                                 // gk only
    callRow({ outcome: 'BOOKED_MEETING', owner_reached: 'TRUE', pitched: 'TRUE', gatekeeper_reached: 'TRUE', owner_reach_source: 'VIA_GATEKEEPER', duration_seconds: 300 }), // gk → owner → meeting
    callRow({ outcome: 'NOT_INTERESTED', owner_reached: 'TRUE', pitched: 'TRUE', owner_reach_source: 'DIRECT', duration_seconds: 100 }),
    callRow({ outcome: 'CALLBACK_REQUESTED', owner_reached: 'FALSE', pitched: 'FALSE', owner_reach_source: 'DIRECT' }),                 // owner classified, not pitched (no DM conversation per outcome)
    callRow({ outcome: 'BOOKED_MEETING', owner_reached: 'TRUE', pitched: 'TRUE', owner_reach_source: 'DIRECT', duration_seconds: 200 }),
    callRow({ outcome: 'WRONG_NUMBER' }),
    callRow({ outcome: '', started_at: iso(NOW - 2 * HOUR) }),                                                                            // opened, never classified
  ];
  const a = build(calls);
  assert.equal(a.summary.calls, 9, 'the unclassified row is not a call');
  assert.equal(a.summary.unclassified, 1);
  assert.equal(a.summary.connected, 7);
  assert.equal(a.summary.gatekeeper_reached, 3);
  assert.equal(a.summary.owner_reached, 4, 'owner_reached=TRUE or classified OWNER, never double counted');
  assert.equal(a.summary.gatekeeper_then_owner, 1);
  assert.equal(a.summary.gatekeeper_to_owner_pct, 33.3, '1 of 3 gatekeeper encounters got through');
  assert.equal(a.summary.pitched, 3);
  assert.equal(a.summary.meetings, 2);
  assert.equal(a.summary.owner_to_meeting_pct, 50, '2 meetings / 4 owner calls');
  assert.equal(a.summary.pitch_to_meeting_pct, 66.7, '2 meetings / 3 pitched — NO_ANSWER and gatekept calls are not failed pitches');
  assert.equal(a.summary.avg_duration_seconds, 200); assert.equal(a.summary.duration_sample, 3);
  assert.deepEqual(a.funnel.steps.map((s) => s.count), [9, 7, 4, 3, 2]);
  assert.deepEqual(a.funnel.reach, { owner_direct: 3, owner_via_gatekeeper: 1, owner_unclassified: 0, gatekeeper_reached: 3, gatekeeper_then_owner: 1, gatekeeper_to_owner_pct: 33.3 });
  assert.equal(a.gatekeeper.encounters, 3); assert.equal(a.gatekeeper.owners_reached_after, 1); assert.equal(a.gatekeeper.not_past, 2);
  assert.equal(a.gatekeeper.gatekept_outcomes, 1); assert.equal(a.gatekeeper.owner_unavailable_outcomes, 1); assert.equal(a.gatekeeper.meetings_after_gatekeeper, 1);
  ok('funnel + gatekeeper→owner + owner→meeting + pitch→meeting use the documented denominators');

  const byOutcome = Object.fromEntries(a.outcomes.map((o) => [o.outcome, o]));
  assert.equal(byOutcome.NO_ANSWER.count, 2); assert.equal(byOutcome.NO_ANSWER.pct_of_calls, 22.2); assert.equal(byOutcome.NO_ANSWER.pct_of_owner_calls, null, 'no owner share for a non-owner outcome');
  assert.equal(byOutcome.BOOKED_MEETING.count, 2); assert.equal(byOutcome.BOOKED_MEETING.pct_of_calls, 22.2); assert.equal(byOutcome.BOOKED_MEETING.pct_of_owner_calls, 50);
  assert.equal(byOutcome.CALLBACK_REQUESTED.owner_count, 1); assert.equal(byOutcome.CALLBACK_REQUESTED.pct_of_owner_calls, 25);
  assert.equal(a.outcomes[0].outcome, 'NO_ANSWER', 'sorted by count, ties by system order');
  assert.equal(a.outcomes[1].outcome, 'BOOKED_MEETING');
  ok('outcome percentages: % of calls for every outcome, % of owner conversations only where the outcome implies one');
}

// ── 4. objections: repeats, multiples, versions, script split ──────────────
{
  const calls = [
    callRow({ call_id: 'c_a', script_id: 'scr_a1', outcome: 'NOT_INTERESTED', owner_reached: 'TRUE', pitched: 'TRUE', owner_reach_source: 'DIRECT' }),
    callRow({ call_id: 'c_b', script_id: 'scr_a2', outcome: 'BOOKED_MEETING', owner_reached: 'TRUE', pitched: 'TRUE', owner_reach_source: 'DIRECT' }),
    callRow({ call_id: 'c_c', script_id: 'scr_a2', outcome: 'MORE_INFO_REQUESTED', owner_reached: 'TRUE', pitched: 'TRUE', owner_reach_source: 'DIRECT' }),
    callRow({ call_id: 'c_d', script_id: 'scr_b1', outcome: 'GATEKEPT', gatekeeper_reached: 'TRUE' }),
    callRow({ call_id: 'c_e', script_id: 'scr_a2', outcome: 'NOT_INTERESTED', owner_reached: 'TRUE', pitched: 'TRUE', owner_reach_source: 'DIRECT' }),
  ];
  const events = [
    eventRow('c_a', 'busy', { objection_id: 'busy_v1', objection_title: "We're too busy" }),   // v1 of the family
    eventRow('c_a', 'busy', { objection_id: 'busy_v1', objection_title: "We're too busy" }),   // same objection clicked twice on one call
    eventRow('c_a', 'send'),                                                                    // second objection on the same call
    eventRow('c_b', 'busy', { objection_id: 'busy_v2', objection_title: 'Too busy right now' }), // v2 of the family, on a meeting call
    eventRow('c_c', 'send'),
    eventRow('c_d', 'crm'),                                                                     // a gatekeeper call — not an owner conversation
    eventRow('c_zzz', 'crm'),                                                                   // orphan event for a call that does not exist
  ];
  const a = build(calls, events);
  const busy = a.objections.rows.find((o) => o.objection_key === 'busy');
  assert.equal(busy.title, 'Too busy right now', 'family shows its latest version title');
  assert.equal(busy.event_count, 3); assert.equal(busy.call_count, 2, 'repeat clicks on one call do not inflate the primary metric');
  assert.deepEqual(busy.versions.sort(), ['busy_v1', 'busy_v2']);
  assert.equal(busy.owner_call_count, 2); assert.equal(busy.pct_of_owner_calls, 50, '2 of 4 owner conversations');
  assert.equal(busy.meetings, 1); assert.equal(busy.meeting_pct, 50);
  assert.deepEqual(busy.outcomes.map((o) => [o.outcome, o.count]), [['BOOKED_MEETING', 1], ['NOT_INTERESTED', 1]]);
  assert.deepEqual(busy.scripts.map((s) => [s.script_id, s.version, s.calls]).sort(), [['scr_a1', 1, 1], ['scr_a2', 2, 1]]);
  assert.deepEqual(busy.by_day, [{ day: '2026-09-15', calls: 2 }]);
  const send = a.objections.rows.find((o) => o.objection_key === 'send');
  assert.equal(send.call_count, 2); assert.equal(send.meetings, 0); assert.equal(send.meeting_pct, 0);
  const crm = a.objections.rows.find((o) => o.objection_key === 'crm');
  assert.equal(crm.event_count, 1, 'orphan event ignored'); assert.equal(crm.call_count, 1); assert.equal(crm.owner_call_count, 0); assert.equal(crm.pct_of_owner_calls, 0);
  assert.equal(a.objections.calls_with_objection, 4); assert.equal(a.objections.owner_calls, 4); assert.equal(a.objections.event_count, 6);
  assert.deepEqual(a.objections.rows.map((o) => o.objection_key), ['busy', 'send', 'crm'], 'ranked by unique calls');
  const rowA = a.explorer.rows.find((r) => r.call_id === 'c_a');
  assert.deepEqual(rowA.objections.map((o) => o.title), ['Too busy right now', 'Send me something']);
  ok('objections: event vs unique-call counts, versions merged by family, owner denominator, per-script split, outcomes after, by-day trend');

  const byId = Object.fromEntries(a.scripts.map((s) => [s.script_id, s]));
  assert.equal(a.scripts[0].script_id, 'scr_a2', 'current script first'); assert.equal(a.scripts[0].is_current, true);
  assert.equal(byId.scr_a2.calls, 3); assert.equal(byId.scr_a2.owner_reached, 3); assert.equal(byId.scr_a2.pitched, 3); assert.equal(byId.scr_a2.meetings, 1);
  assert.equal(byId.scr_a2.owner_to_meeting_pct, 33.3); assert.equal(byId.scr_a2.pitch_to_meeting_pct, 33.3);
  assert.equal(byId.scr_a2.objection_rate_pct, 66.7, '2 of 3 owner conversations on v2 hit an objection');
  assert.deepEqual(byId.scr_a2.top_objections.map((o) => [o.objection_key, o.calls]), [['busy', 1], ['send', 1]]);
  assert.equal(byId.scr_a1.calls, 1, 'historical call stays on the exact version it was made with, not the current one');
  assert.equal(byId.scr_b1.calls, 1); assert.equal(byId.scr_b1.owner_reached, 0); assert.equal(byId.scr_b1.owner_to_meeting_pct, null); assert.equal(byId.scr_b1.objection_rate_pct, null);
  assert.ok(a.scripts.every((s) => s.small_sample === true), `every script is under the ${SMALL_SAMPLE}-call sample threshold`);
  ok('script conversion metrics use CALLS.script_id exactly; rates are null with a zero denominator; small samples are flagged');

  const filtered = build(calls, events, [], { script_id: 'scr_a2' });
  assert.equal(filtered.summary.calls, 3); assert.equal(filtered.objections.rows.find((o) => o.objection_key === 'busy').call_count, 1);
  assert.equal(filtered.filters.script_id, 'scr_a2');
  ok('script_id filter narrows every section');
}

// ── 5. London-local timing and date ranges ─────────────────────────────────
{
  const calls = [
    callRow({ outcome: 'NO_ANSWER', connected: 'FALSE', started_at: '2026-09-14T08:30:00.000Z' }), // Mon 09:30 BST
    callRow({ outcome: 'BOOKED_MEETING', owner_reached: 'TRUE', pitched: 'TRUE', started_at: '2026-09-14T23:30:00.000Z' }), // Tue 00:30 BST — Monday in UTC
    callRow({ outcome: 'NOT_INTERESTED', owner_reached: 'TRUE', pitched: 'TRUE', started_at: '2026-01-12T09:15:00.000Z' }), // Mon 09:15 GMT
    callRow({ outcome: 'GATEKEPT', gatekeeper_reached: 'TRUE', started_at: 'not a date', created_at: 'also not' }),
  ];
  const a = build(calls);
  assert.equal(a.timing.reliable, true); assert.equal(a.timing.sample, 3); assert.equal(a.timing.untimed, 1);
  assert.equal(a.timing.by_weekday[1].calls, 2, 'two Mondays (one BST, one GMT)');
  assert.equal(a.timing.by_weekday[2].calls, 1, '23:30Z on Monday is Tuesday 00:30 in London');
  assert.equal(a.timing.by_weekday[2].meeting_pct, 100);
  assert.equal(a.timing.by_hour[9].calls, 2, '08:30Z BST and 09:15Z GMT are both 09:xx London');
  assert.equal(a.timing.by_hour[0].calls, 1);
  assert.equal(a.timing.by_hour[9].owner_pct, 50);
  assert.deepEqual(a.timing.grid[2][0], [1, 1, 1]);
  assert.equal(a.summary.calls, 4, 'an untimed call still counts in an all-time range');
  ok('timing groups by Europe/London weekday and hour across BST and GMT; untimed rows are counted but excluded from timing');

  const r7 = resolveRange({ range: '7d' }, NOW);
  assert.equal(r7.from, '2026-09-08T23:00:00.000Z', 'London midnight 9 Sep (BST) = 23:00Z on the 8th');
  assert.equal(r7.to, '2026-09-15T23:00:00.000Z');
  assert.equal(resolveRange({ range: 'today' }, NOW).from, '2026-09-14T23:00:00.000Z');
  assert.equal(resolveRange({ range: 'all' }, NOW).from, '');
  const custom = resolveRange({ range: 'custom', from: '2026-01-12', to: '2026-01-12' }, NOW);
  assert.equal(custom.from, '2026-01-12T00:00:00.000Z', 'GMT: London midnight is 00:00Z'); assert.equal(custom.to, '2026-01-13T00:00:00.000Z');
  assert.equal(resolveRange({ range: 'custom', from: 'junk', to: '' }, NOW).from, '');
  ok('ranges resolve to London-local calendar days in both BST and GMT');

  const today = build(calls, [], [], { range: 'today' });
  assert.equal(today.summary.calls, 1, '23:30Z on the 14th is 00:30 London on the 15th — today');
  assert.equal(today.summary.meetings, 1);
  const week = build(calls, [], [], { range: '7d' });
  assert.equal(week.summary.calls, 2, 'the 7-day window keeps the two September calls, drops January and the untimed row');
  assert.equal(week.summary.meetings, 1);
  const jan = build(calls, [], [], { range: 'custom', from: '2026-01-12', to: '2026-01-12' });
  assert.equal(jan.summary.calls, 1); assert.equal(jan.explorer.rows[0].outcome, 'NOT_INTERESTED');
  assert.equal(build(calls, [], [], { range: 'custom', from: '2026-01-13', to: '2026-01-13' }).summary.calls, 0, 'to is inclusive of its own day only');
  ok('date-range filtering respects London day boundaries and applies to every section');
}

// ── 6. follow-ups — only where a key links the two calls ───────────────────
{
  const calls = [
    callRow({ call_id: 'c_cb1', outcome: 'CALLBACK_REQUESTED', owner_reached: 'TRUE', pitched: 'TRUE', callback_at: iso(NOW + DAY), started_at: iso(NOW - 5 * DAY) }),
    callRow({ call_id: 'c_cb2', outcome: 'CALLBACK_REQUESTED', owner_reached: 'TRUE', pitched: 'TRUE', callback_at: iso(NOW + DAY), started_at: iso(NOW - 4 * DAY) }),
    callRow({ call_id: 'c_cb3', outcome: 'CALLBACK_REQUESTED', owner_reached: 'TRUE', pitched: 'TRUE', callback_at: iso(NOW + DAY), started_at: iso(NOW - 3 * DAY) }),
    callRow({ call_id: 'c_mi1', outcome: 'MORE_INFO_REQUESTED', owner_reached: 'TRUE', pitched: 'TRUE', more_info_type: 'PRICING', started_at: iso(NOW - 3 * DAY) }),
    // follow-up calls
    callRow({ call_id: 'c_f1', outcome: 'BOOKED_MEETING', owner_reached: 'TRUE', pitched: 'TRUE', source_action_id: 'act_cb1', started_at: iso(NOW - 2 * DAY) }),   // linked by source_action_id
    callRow({ call_id: 'c_f2', outcome: 'NOT_INTERESTED', owner_reached: 'TRUE', pitched: 'TRUE', started_at: iso(NOW - DAY) }),                                    // linked by completion_reason only
    callRow({ call_id: 'c_f3', outcome: 'BOOKED_MEETING', owner_reached: 'TRUE', pitched: 'TRUE', started_at: iso(NOW - HOUR) }),                                  // a meeting on the same agency with NO link — must not be counted
  ];
  const actions = [
    actionRow({ action_id: 'act_cb1', action_type: 'CALL_PROSPECT', action_status: 'COMPLETED', completion_reason: 'CALL_OUTCOME:BOOKED_MEETING (c_f1)', metadata_json: JSON.stringify({ manual: true, call_action: true, call_id: 'c_cb1' }) }),
    actionRow({ action_id: 'act_cb2', action_type: 'CALL_PROSPECT', action_status: 'COMPLETED', completion_reason: 'CALL_OUTCOME:NOT_INTERESTED (c_f2)', metadata_json: JSON.stringify({ manual: true, call_action: true, call_id: 'c_cb2' }) }),
    actionRow({ action_id: 'act_cb3', action_type: 'CALL_PROSPECT', action_status: 'PENDING', metadata_json: JSON.stringify({ manual: true, call_action: true, call_id: 'c_cb3' }) }),
    actionRow({ action_id: 'act_mi_send', action_type: 'SEND_INFORMATION', action_status: 'COMPLETED', completion_reason: 'done', metadata_json: JSON.stringify({ manual: true, call_id: 'c_mi1' }) }),
    actionRow({ action_id: 'act_mi_call', action_type: 'CALL_PROSPECT', action_status: 'PENDING', metadata_json: JSON.stringify({ manual: true, call_action: true, call_id: 'c_mi1' }) }),
    actionRow({ action_id: 'act_engine', action_type: 'CALL_PROSPECT', action_status: 'PENDING', metadata_json: '{}' }), // engine action with no call link
  ];
  const a = build(calls, [], actions);
  assert.equal(a.summary.followup_actions_created, 5, 'only actions that name a call in the window');
  const cb = a.followups.callbacks;
  assert.equal(cb.requests, 3); assert.equal(cb.actions_created, 3); assert.equal(cb.actions_completed, 2);
  assert.equal(cb.followup_calls_linked, 2); assert.equal(cb.meetings_after, 1, 'the unlinked meeting on c_f3 is not attributed'); assert.equal(cb.meeting_pct, 33.3);
  const mi = a.followups.more_info;
  assert.equal(mi.requests, 1); assert.equal(mi.actions_created, 1); assert.equal(mi.actions_completed, 0); assert.equal(mi.meetings_after, 0);
  assert.equal(mi.send_information.actions_created, 1); assert.equal(mi.send_information.actions_completed, 1);
  assert.equal(a.followups.owner_unavailable.requests, 0);
  const row = a.explorer.rows.find((r) => r.call_id === 'c_cb1');
  assert.deepEqual(row.followups.map((f) => [f.action_type, f.action_status]), [['CALL_PROSPECT', 'COMPLETED']]);
  assert.equal(a.explorer.rows[0].call_id, 'c_f3', 'explorer is newest first');
  assert.equal(a.explorer.rows[0].agency_name, 'Tinsley & Co');
  ok('follow-ups count callback / more-info actions and attribute meetings only through source_action_id or completion_reason links');
}

// ── 7. the operation on personalisation.js ────────────────────────────────
{
  const store = {
    AGENCIES: [['agency_id', 'clean_agency_name'], ['ag_1', 'Tinsley & Co']],
    ACTIONS: [ACTIONS_HEADER.slice(), ACTIONS_HEADER.map((_, i) => (i === 0 ? 'SCHEMA NOTE' : ''))],
    SCRIPTS: [SCRIPTS_HEADER.slice(), ...scripts.map((o) => SCRIPTS_HEADER.map((k) => o[k] ?? ''))],
    OBJECTIONS: [OBJECTIONS_HEADER.slice(), ...objections.map((o) => OBJECTIONS_HEADER.map((k) => o[k] ?? ''))],
    CALLS: [CALLS_HEADER.slice(), CALLS_HEADER.map((k) => callRow({ outcome: 'BOOKED_MEETING', owner_reached: 'TRUE', pitched: 'TRUE', owner_reach_source: 'DIRECT', script_id: 'scr_a2' })[k]),
      CALLS_HEADER.map((k) => callRow({ outcome: 'NO_ANSWER', connected: 'FALSE', started_at: '2026-01-05T10:00:00.000Z' })[k])],
    CALL_OBJECTION_EVENTS: [CALL_OBJECTION_EVENTS_HEADER.slice()],
  };
  let reads = 0;
  const api = {
    async get(range) { reads += 1; const tab = String(range).split('!')[0]; if (!(tab in store)) throw new Error(`Unable to parse range: ${tab}`); return store[tab].map((r) => r.slice()); },
    async append() { throw new Error('analytics must never write'); },
    async update() { throw new Error('analytics must never write'); },
    async batchUpdate() { throw new Error('analytics must never write'); },
    async listTabs() { return Object.keys(store); },
    async addTab() { throw new Error('analytics must never create tabs'); },
  };
  __setRepoForTests(createRepo(api));
  process.env.NOVUS_BASIC_AUTH_USER = 'novus'; process.env.NOVUS_BASIC_AUTH_PASS = 'testpass';
  const { default: handler } = await import('../api/novus/personalisation.js');
  const basic = 'Basic ' + Buffer.from('novus:testpass').toString('base64');
  const response = () => ({ statusCode: 200, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; }, setHeader(k, v) { this.headers[k] = v; } });
  const call = async (method, query, headers = { authorization: basic }) => { const res = response(); await handler({ method, query: { novus_operation: 'calling-analytics', ...query }, headers, body: null }, res); return res; };

  const denied = await call('GET', {}, {});
  assert.equal(denied.statusCode, 401);
  const wrongMethod = await call('POST', {});
  assert.notEqual(wrongMethod.statusCode, 200, 'POST never reaches the analytics handler');
  ok('calling-analytics requires Basic Auth and is GET-only');

  let res = await call('GET', { refresh: '1' });
  assert.equal(res.statusCode, 200); assert.equal(res.body.success, true); assert.equal(res.body.cached, false);
  assert.equal(res.headers['Cache-Control'], 'private, no-store, max-age=0');
  for (const key of ['summary', 'funnel', 'outcomes', 'objections', 'scripts', 'gatekeeper', 'timing', 'followups', 'explorer', 'enums', 'range']) assert.ok(key in res.body, `payload has ${key}`);
  assert.equal(res.body.summary.calls, 2); assert.equal(res.body.range.key, 'all'); assert.equal(res.body.setup.available, true);
  assert.equal(res.body.enums.scripts[0].script_id, 'scr_a2');
  const readsForOne = reads;
  assert.ok(readsForOne <= 6, `at most six tab reads per build (was ${readsForOne})`);
  ok('payload carries every section, read from six tabs at most, with no-store caching headers');

  res = await call('GET', {});
  assert.equal(res.body.cached, true, 'a second identical request within 30s is served from cache');
  assert.equal(reads, readsForOne, 'no extra Sheets reads for a cached response');
  res = await call('GET', { range: '30d' });
  assert.equal(res.body.cached, false, 'a different filter set is not served from the other set\'s cache');
  assert.equal(res.body.summary.calls, 1); assert.equal(res.body.range.key, '30d');
  res = await call('GET', { range: 'custom', from: '2026-01-01', to: '2026-01-31' });
  assert.equal(res.statusCode, 200); assert.equal(res.body.summary.calls, 1); assert.equal(res.body.explorer.rows[0].outcome, 'NO_ANSWER');
  res = await call('GET', { range: 'custom', from: 'nope' });
  assert.equal(res.statusCode, 400);
  res = await call('GET', { range: 'all', script_id: 'scr_a2', refresh: '1' });
  assert.equal(res.body.summary.calls, 1); assert.equal(res.body.filters.script_id, 'scr_a2');
  ok('range / custom / script_id query params are honoured, validated, and cached per filter set');

  __setRepoForTests(null);
}

console.log(`\nNOVUS calling analytics self-test passed (${passed} checks).`);
