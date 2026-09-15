// lib/calling-analytics.mjs — PURE read model behind the Calling Analytics
// page. No I/O: takes already-loaded tables and returns every figure the page
// shows. Nothing here writes, nothing is modelled or extrapolated — every
// number is a count over immutable CALLS rows joined to
// CALL_OBJECTION_EVENTS, SCRIPTS, OBJECTIONS and ACTIONS.
//
// DENOMINATORS, SPELT OUT (the whole point of the page is that these are
// right):
//   calls                 classified CALLS rows (outcome set) whose started_at
//                         falls in the London-local date range. An opened-but-
//                         never-classified Twilio row is not a call; it is
//                         reported separately as `unclassified`.
//   connected             calls with connected=TRUE (every outcome but NO_ANSWER)
//   gatekeeper reached    calls with gatekeeper_reached=TRUE (the answer-screen
//                         classification)
//   owner reached         calls where the decision-maker was on the line:
//                         owner_reached=TRUE (outcome-derived) OR the operator
//                         classified the answerer as OWNER / got through to the
//                         owner (owner_reach_source set). A call can be both
//                         gatekeeper-reached and owner-reached.
//   pitched               calls with pitched=TRUE (outcome-derived)
//   meetings              calls with outcome=BOOKED_MEETING
//   gatekeeper → owner %  gatekeeper reached AND owner reached / gatekeeper reached
//   owner → meeting %     meetings / owner reached
//   pitch → meeting %     meetings / pitched
//   objection frequency   unique OWNER calls containing the objection / owner calls
//   objection → meeting % meetings on calls containing the objection / unique
//                         calls containing the objection
// A NO_ANSWER call is never a failed pitch (it is not in `pitched`), and a
// gatekeeper encounter is never a final outcome when the owner was reached on
// the same call (the reach fields are read independently of the outcome).
//
// FOLLOW-UP LINKS are only counted where a real key exists: an ACTIONS row's
// metadata_json.call_id names the call that created it, and its
// completion_reason "CALL_OUTCOME:<outcome> (<call_id>)" — or the later
// call's source_action_id — names the call that answered it. No agency-level
// "a meeting happened later" inference.

import { CALL_OUTCOMES, OUTCOME_LABEL } from './calling-outcomes.mjs';
import { callRecords, currentScript, objectionEventRecords, objectionRecords, scriptRecords } from './calling-store.mjs';
import { parseActionRecords } from './actions-store.mjs';
import { londonParts, londonTimeOn, londonWeekday } from './london-time.mjs';

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();
const ts = (value) => (Number.isFinite(Date.parse(text(value))) ? Date.parse(text(value)) : null);
const flag = (row, key) => upper(row?.[key]) === 'TRUE';
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

export const RANGE_KEYS = Object.freeze(['today', '7d', '30d', 'all', 'custom']);
export const WEEKDAY_LABEL = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
// Outcomes that can only be reached with the decision-maker on the line, so
// "% of owner conversations" is a meaningful figure for them.
const OWNER_OUTCOMES = new Set(['MORE_INFO_REQUESTED', 'NOT_INTERESTED', 'BOOKED_MEETING', 'CALLBACK_REQUESTED', 'DO_NOT_CALL']);
// Below this many calls a script's rates are shown but flagged as a small sample.
export const SMALL_SAMPLE = 20;
export const EXPLORER_ROW_CAP = 1500;

function records(table, idColumn) {
  const header = table?.header || [];
  const at = header.indexOf(idColumn);
  if (at < 0) return [];
  return (table.rows || []).flatMap((row) => {
    const id = text(row[at]);
    if (!id || id === 'SCHEMA NOTE') return [];
    return [Object.fromEntries(header.map((key, i) => [key, row[i] ?? '']))];
  });
}
function metadata(row) {
  try { return JSON.parse(text(row?.metadata_json) || '{}'); } catch { return {}; }
}

// ── date range ─────────────────────────────────────────────────────────────
// London-local calendar days. `from` is inclusive London midnight; `to` is
// the exclusive London midnight AFTER the last day, so a range never
// straddles a day boundary differently in BST and GMT.
function londonMidnightOfDate(yyyyMmDd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(yyyyMmDd));
  if (!m) return null;
  const noon = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  if (!Number.isFinite(noon)) return null;
  return londonTimeOn(noon, { hour: 0 });
}
export function resolveRange({ range = 'all', from = '', to = '' } = {}, nowMs = Date.now()) {
  const key = RANGE_KEYS.includes(text(range).toLowerCase()) ? text(range).toLowerCase() : 'all';
  const todayStart = londonTimeOn(nowMs, { hour: 0 });
  const tomorrowStart = londonTimeOn(nowMs, { hour: 0, addDays: 1 });
  let fromMs = null; let toMs = null;
  if (key === 'today') { fromMs = todayStart; toMs = tomorrowStart; }
  else if (key === '7d') { fromMs = londonTimeOn(nowMs, { hour: 0, addDays: -6 }); toMs = tomorrowStart; }
  else if (key === '30d') { fromMs = londonTimeOn(nowMs, { hour: 0, addDays: -29 }); toMs = tomorrowStart; }
  else if (key === 'custom') {
    fromMs = londonMidnightOfDate(from);
    const toStart = londonMidnightOfDate(to);
    toMs = toStart === null ? null : londonTimeOn(toStart, { hour: 0, addDays: 1 });
  }
  return {
    key, from: fromMs === null ? '' : new Date(fromMs).toISOString(), to: toMs === null ? '' : new Date(toMs).toISOString(),
    from_ms: fromMs, to_ms: toMs,
  };
}
// A row whose started_at cannot be parsed still exists: it is kept in the
// unbounded all-time view (and reported under timing.untimed) but cannot be
// placed in any bounded window.
function inRange(ms, range) {
  if (ms === null) return range.from_ms === null && range.to_ms === null;
  if (range.from_ms !== null && ms < range.from_ms) return false;
  if (range.to_ms !== null && ms >= range.to_ms) return false;
  return true;
}

// ── per-call facts ─────────────────────────────────────────────────────────
// The one place the reach semantics live. `owner_reached` on the row is the
// outcome-derived column; `owner_reach_source` is the operator's live
// classification. Either is evidence the owner was on the line.
export function callFacts(row) {
  const outcome = upper(row.outcome);
  const gatekeeper = flag(row, 'gatekeeper_reached');
  const source = upper(row.owner_reach_source);
  const owner = flag(row, 'owner_reached') || source === 'DIRECT' || source === 'VIA_GATEKEEPER';
  const duration = Number(row.duration_seconds);
  return {
    outcome,
    connected: flag(row, 'connected'),
    gatekeeper_reached: gatekeeper,
    owner_reached: owner,
    // DIRECT / VIA_GATEKEEPER when classified live; UNKNOWN for an owner call
    // saved before the answer screen existed (never guessed from the
    // gatekeeper flag); '' when the owner was not reached.
    reach_source: owner ? (source === 'DIRECT' || source === 'VIA_GATEKEEPER' ? source : 'UNKNOWN') : '',
    pitched: flag(row, 'pitched'),
    meeting: outcome === 'BOOKED_MEETING',
    duration_seconds: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
    started_ms: ts(row.started_at) ?? ts(row.created_at),
  };
}

function countBy(rows, keyOf) {
  const out = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === undefined || key === null || key === '') continue;
    out.set(key, (out.get(key) || 0) + 1);
  }
  return out;
}
function topEntries(map, limit) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, limit);
}
function averageDuration(calls) {
  const sample = calls.map((c) => c.f.duration_seconds).filter((d) => d !== null);
  return { avg_duration_seconds: sample.length ? Math.round(sample.reduce((a, b) => a + b, 0) / sample.length) : null, duration_sample: sample.length };
}

// ── the read model ─────────────────────────────────────────────────────────
export function buildCallingAnalytics(tables, { now = new Date().toISOString(), range = 'all', from = '', to = '', script_id: scriptFilter = '' } = {}) {
  const nowMs = Date.parse(now);
  const window = resolveRange({ range, from, to }, nowMs);
  const scripts = scriptRecords(tables.SCRIPTS);
  const scriptById = new Map(scripts.map((row) => [text(row.script_id), row]));
  const current = currentScript(scripts);
  const currentId = current ? text(current.script_id) : '';
  const objections = objectionRecords(tables.OBJECTIONS);
  // Objection versions collapse onto their family; the newest version's title
  // is the display title so a reworded objection is one line, not two.
  const familyTitle = new Map();
  for (const row of [...objections].sort((a, b) => (Number(a.version) || 1) - (Number(b.version) || 1))) familyTitle.set(text(row.objection_key), text(row.title));
  const agencyName = new Map(records(tables.AGENCIES, 'agency_id').map((row) => [text(row.agency_id), text(row.clean_agency_name || row.agency_name)]));

  // Every classified call, with its facts, then the date/script window.
  const allCalls = callRecords(tables.CALLS).map((row) => ({ row, f: callFacts(row) }));
  const allClassified = allCalls.filter((c) => c.f.outcome);
  const unclassified = allCalls.filter((c) => !c.f.outcome && inRange(c.f.started_ms, window)).length;
  const calls = allClassified.filter((c) => inRange(c.f.started_ms, window) && (!scriptFilter || text(c.row.script_id) === text(scriptFilter)));
  const callById = new Map(calls.map((c) => [text(c.row.call_id), c]));
  const anyCallById = new Map(allClassified.map((c) => [text(c.row.call_id), c]));

  // Objection events joined onto the calls in the window; unique per call +
  // family for the primary metric, raw events kept for the event count.
  const events = objectionEventRecords(tables.CALL_OBJECTION_EVENTS).filter((e) => callById.has(text(e.call_id)));
  const eventsByCall = new Map();
  for (const e of events) {
    const id = text(e.call_id);
    if (!eventsByCall.has(id)) eventsByCall.set(id, []);
    eventsByCall.get(id).push(e);
  }
  const objectionFamiliesOf = (callId) => [...new Set((eventsByCall.get(callId) || []).map((e) => text(e.objection_key) || text(e.objection_id)))];
  const titleOf = (family, fallbackEvent) => familyTitle.get(family) || text(fallbackEvent?.objection_title) || family;

  // ACTIONS created by a call in the window (metadata_json.call_id), plus the
  // follow-up call that closed each one, where a key links them.
  const actions = parseActionRecords(tables.ACTIONS || { header: [], rows: [] }).map((r) => r.obj);
  const actionsByCall = new Map();
  const actionById = new Map();
  for (const a of actions) {
    actionById.set(text(a.action_id), a);
    const callId = text(metadata(a).call_id);
    if (!callId) continue;
    if (!actionsByCall.has(callId)) actionsByCall.set(callId, []);
    actionsByCall.get(callId).push(a);
  }
  const callsBySourceAction = new Map();
  for (const c of allClassified) {
    const src = text(c.row.source_action_id);
    if (src && !callsBySourceAction.has(src)) callsBySourceAction.set(src, c);
  }
  const followupCallOf = (action) => {
    const bySource = callsBySourceAction.get(text(action.action_id));
    if (bySource) return bySource;
    const m = /\(([^)]+)\)\s*$/.exec(text(action.completion_reason));
    return m ? anyCallById.get(text(m[1])) || null : null;
  };

  // ── summary + funnel ────────────────────────────────────────────────────
  const n = {
    calls: calls.length,
    connected: calls.filter((c) => c.f.connected).length,
    gatekeeper_reached: calls.filter((c) => c.f.gatekeeper_reached).length,
    owner_reached: calls.filter((c) => c.f.owner_reached).length,
    gatekeeper_then_owner: calls.filter((c) => c.f.gatekeeper_reached && c.f.owner_reached).length,
    owner_direct: calls.filter((c) => c.f.reach_source === 'DIRECT').length,
    owner_via_gatekeeper: calls.filter((c) => c.f.reach_source === 'VIA_GATEKEEPER').length,
    owner_unclassified: calls.filter((c) => c.f.reach_source === 'UNKNOWN').length,
    pitched: calls.filter((c) => c.f.pitched).length,
    meetings: calls.filter((c) => c.f.meeting).length,
  };
  const followupActionsCreated = calls.reduce((sum, c) => sum + (actionsByCall.get(text(c.row.call_id)) || []).length, 0);
  const summary = {
    ...n, ...averageDuration(calls),
    unclassified,
    followup_actions_created: followupActionsCreated,
    gatekeeper_to_owner_pct: pct(n.gatekeeper_then_owner, n.gatekeeper_reached),
    owner_to_meeting_pct: pct(n.meetings, n.owner_reached),
    pitch_to_meeting_pct: pct(n.meetings, n.pitched),
    connect_rate_pct: pct(n.connected, n.calls),
    owner_rate_pct: pct(n.owner_reached, n.calls),
  };
  const funnel = {
    steps: [
      { key: 'calls', label: 'Calls', count: n.calls },
      { key: 'connected', label: 'Connected', count: n.connected },
      { key: 'owner_reached', label: 'Owner reached', count: n.owner_reached },
      { key: 'pitched', label: 'Pitched', count: n.pitched },
      { key: 'meetings', label: 'Meetings', count: n.meetings },
    ].map((step) => ({ ...step, pct_of_calls: pct(step.count, n.calls) })),
    reach: {
      owner_direct: n.owner_direct, owner_via_gatekeeper: n.owner_via_gatekeeper, owner_unclassified: n.owner_unclassified,
      gatekeeper_reached: n.gatekeeper_reached, gatekeeper_then_owner: n.gatekeeper_then_owner,
      gatekeeper_to_owner_pct: summary.gatekeeper_to_owner_pct,
    },
  };

  // ── outcomes ────────────────────────────────────────────────────────────
  const outcomeCounts = countBy(calls, (c) => c.f.outcome);
  const ownerOutcomeCounts = countBy(calls.filter((c) => c.f.owner_reached), (c) => c.f.outcome);
  const outcomeKeys = [...new Set([...CALL_OUTCOMES, ...outcomeCounts.keys()])];
  const outcomes = outcomeKeys.map((key) => ({
    outcome: key, label: OUTCOME_LABEL[key] || key.replace(/_/g, ' ').toLowerCase(),
    count: outcomeCounts.get(key) || 0,
    pct_of_calls: pct(outcomeCounts.get(key) || 0, n.calls),
    owner_count: ownerOutcomeCounts.get(key) || 0,
    pct_of_owner_calls: OWNER_OUTCOMES.has(key) ? pct(ownerOutcomeCounts.get(key) || 0, n.owner_reached) : null,
  })).sort((a, b) => b.count - a.count || CALL_OUTCOMES.indexOf(a.outcome) - CALL_OUTCOMES.indexOf(b.outcome));

  // ── objections ──────────────────────────────────────────────────────────
  const families = new Map();
  for (const e of events) {
    const family = text(e.objection_key) || text(e.objection_id);
    if (!families.has(family)) families.set(family, { family, title: titleOf(family, e), events: [], calls: new Set(), versions: new Set() });
    const entry = families.get(family);
    entry.events.push(e);
    entry.calls.add(text(e.call_id));
    if (text(e.objection_id)) entry.versions.add(text(e.objection_id));
  }
  const objectionRows = [...families.values()].map((entry) => {
    const its = [...entry.calls].map((id) => callById.get(id)).filter(Boolean);
    const ownerCalls = its.filter((c) => c.f.owner_reached);
    const meetings = its.filter((c) => c.f.meeting).length;
    const byScript = new Map();
    for (const c of its) {
      const id = text(c.row.script_id);
      byScript.set(id, (byScript.get(id) || 0) + 1);
    }
    const byDay = countBy(its, (c) => (c.f.started_ms === null ? '' : londonDate(c.f.started_ms)));
    return {
      objection_key: entry.family, title: entry.title, versions: [...entry.versions],
      event_count: entry.events.length, call_count: its.length, owner_call_count: ownerCalls.length,
      pct_of_owner_calls: pct(ownerCalls.length, n.owner_reached),
      meetings, meeting_pct: pct(meetings, its.length),
      outcomes: topEntries(countBy(its, (c) => c.f.outcome), 5).map(([outcome, count]) => ({ outcome, label: OUTCOME_LABEL[outcome] || outcome, count })),
      scripts: [...byScript.entries()].map(([id, count]) => ({ script_id: id, name: text(scriptById.get(id)?.name) || (id ? 'Unknown script' : 'No script'), version: Number(scriptById.get(id)?.version) || null, calls: count })).sort((a, b) => b.calls - a.calls),
      by_day: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, count]) => ({ day, calls: count })),
    };
  }).sort((a, b) => b.call_count - a.call_count || b.event_count - a.event_count || a.title.localeCompare(b.title));
  const callsWithObjection = calls.filter((c) => eventsByCall.has(text(c.row.call_id))).length;

  // ── scripts ─────────────────────────────────────────────────────────────
  const callsByScript = new Map();
  for (const c of calls) {
    const id = text(c.row.script_id);
    if (!callsByScript.has(id)) callsByScript.set(id, []);
    callsByScript.get(id).push(c);
  }
  const scriptRow = (row, id, its) => {
    const owner = its.filter((c) => c.f.owner_reached);
    const pitched = its.filter((c) => c.f.pitched).length;
    const meetings = its.filter((c) => c.f.meeting).length;
    const withObjection = owner.filter((c) => eventsByCall.has(text(c.row.call_id))).length;
    const objectionFamilies = new Map();
    for (const c of owner) for (const family of objectionFamiliesOf(text(c.row.call_id))) objectionFamilies.set(family, (objectionFamilies.get(family) || 0) + 1);
    return {
      script_id: id, script_key: text(row?.script_key), name: row ? text(row.name) : (id ? 'Unknown script' : 'No script'),
      version: row ? (Number(row.version) || 1) : null, status: row ? upper(row.status) : '', is_current: Boolean(id) && id === currentId,
      calls: its.length, connected: its.filter((c) => c.f.connected).length, owner_reached: owner.length, pitched, meetings,
      owner_to_meeting_pct: pct(meetings, owner.length), pitch_to_meeting_pct: pct(meetings, pitched),
      // Objection rate: owner conversations on this script that hit ≥1 objection / owner conversations.
      objection_rate_pct: pct(withObjection, owner.length), objection_calls: withObjection,
      top_objections: topEntries(objectionFamilies, 3).map(([family, count]) => ({ objection_key: family, title: familyTitle.get(family) || family, calls: count })),
      ...averageDuration(its),
      small_sample: its.length < SMALL_SAMPLE,
    };
  };
  const scriptRows = scripts.map((row) => scriptRow(row, text(row.script_id), callsByScript.get(text(row.script_id)) || []));
  for (const [id, its] of callsByScript) if (!scriptById.has(id)) scriptRows.push(scriptRow(null, id, its));
  scriptRows.sort((a, b) => Number(b.is_current) - Number(a.is_current) || b.calls - a.calls || a.name.localeCompare(b.name) || (b.version || 0) - (a.version || 0));

  // ── gatekeeper ──────────────────────────────────────────────────────────
  const gkCalls = calls.filter((c) => c.f.gatekeeper_reached);
  const gatekeeper = {
    encounters: gkCalls.length,
    owners_reached_after: n.gatekeeper_then_owner,
    not_past: gkCalls.length - n.gatekeeper_then_owner,
    gatekeeper_to_owner_pct: summary.gatekeeper_to_owner_pct,
    gatekept_outcomes: outcomeCounts.get('GATEKEPT') || 0,
    owner_unavailable_outcomes: outcomeCounts.get('OWNER_UNAVAILABLE') || 0,
    meetings_after_gatekeeper: gkCalls.filter((c) => c.f.meeting).length,
    outcomes_after_gatekeeper: topEntries(countBy(gkCalls, (c) => c.f.outcome), 10).map(([outcome, count]) => ({ outcome, label: OUTCOME_LABEL[outcome] || outcome, count })),
    pct_of_connected: pct(gkCalls.length, n.connected),
  };

  // ── timing (Europe/London wall clock) ───────────────────────────────────
  const timed = calls.filter((c) => c.f.started_ms !== null);
  const cell = () => ({ calls: 0, owner_reached: 0, meetings: 0 });
  const byWeekday = Array.from({ length: 7 }, cell);
  const byHour = Array.from({ length: 24 }, cell);
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, cell));
  for (const c of timed) {
    const wd = londonWeekday(c.f.started_ms);
    const hr = londonParts(c.f.started_ms).hour;
    for (const target of [byWeekday[wd], byHour[hr], grid[wd][hr]]) {
      target.calls += 1;
      if (c.f.owner_reached) target.owner_reached += 1;
      if (c.f.meeting) target.meetings += 1;
    }
  }
  const withRates = (t) => ({ ...t, owner_pct: pct(t.owner_reached, t.calls), meeting_pct: pct(t.meetings, t.calls) });
  const timing = {
    timezone: 'Europe/London',
    reliable: timed.length > 0, sample: timed.length, untimed: calls.length - timed.length,
    by_weekday: byWeekday.map((t, weekday) => ({ weekday, label: WEEKDAY_LABEL[weekday], ...withRates(t) })),
    by_hour: byHour.map((t, hour) => ({ hour, ...withRates(t) })),
    grid: grid.map((row) => row.map((t) => [t.calls, t.owner_reached, t.meetings])),
  };

  // ── follow-ups ──────────────────────────────────────────────────────────
  const followupGroup = (outcome, actionTypes) => {
    const origin = calls.filter((c) => c.f.outcome === outcome);
    const created = origin.flatMap((c) => (actionsByCall.get(text(c.row.call_id)) || []).filter((a) => actionTypes.includes(upper(a.action_type))));
    const completed = created.filter((a) => upper(a.action_status) === 'COMPLETED');
    const linked = created.map((a) => ({ action: a, call: followupCallOf(a) })).filter((x) => x.call);
    const meetingCalls = new Set(linked.filter((x) => x.call.f.meeting).map((x) => text(x.call.row.call_id)));
    const originWithMeeting = new Set(linked.filter((x) => x.call.f.meeting).map((x) => text(metadata(x.action).call_id)));
    return {
      outcome, label: OUTCOME_LABEL[outcome] || outcome, action_types: actionTypes,
      requests: origin.length, actions_created: created.length, actions_completed: completed.length,
      followup_calls_linked: linked.length, meetings_after: meetingCalls.size,
      meeting_pct: pct(originWithMeeting.size, origin.length),
    };
  };
  const followups = {
    method: 'ACTIONS.metadata_json.call_id links an action to the call that created it; the answering call is linked by CALLS.source_action_id or the action\'s completion_reason "(call_id)". Nothing is inferred from agency-level status.',
    callbacks: followupGroup('CALLBACK_REQUESTED', ['CALL_PROSPECT']),
    owner_unavailable: followupGroup('OWNER_UNAVAILABLE', ['CALL_PROSPECT']),
    more_info: { ...followupGroup('MORE_INFO_REQUESTED', ['CALL_PROSPECT']), send_information: followupGroup('MORE_INFO_REQUESTED', ['SEND_INFORMATION']) },
  };

  // ── explorer rows ───────────────────────────────────────────────────────
  const sorted = [...calls].sort((a, b) => (b.f.started_ms ?? 0) - (a.f.started_ms ?? 0));
  const explorerRows = sorted.slice(0, EXPLORER_ROW_CAP).map((c) => {
    const id = text(c.row.call_id);
    const script = scriptById.get(text(c.row.script_id));
    const meta = metadata(c.row);
    return {
      call_id: id, started_at: text(c.row.started_at), agency_id: text(c.row.agency_id),
      agency_name: agencyName.get(text(c.row.agency_id)) || '', contact_name: text(c.row.contact_name), contact_role: text(c.row.contact_role),
      phone: text(c.row.phone), call_mode: upper(c.row.call_mode), attempt_number: Number(c.row.attempt_number) || null,
      gatekeeper_reached: c.f.gatekeeper_reached, owner_reached: c.f.owner_reached, reach_source: c.f.reach_source,
      script_id: text(c.row.script_id), script_name: script ? text(script.name) : '', script_version: script ? (Number(script.version) || 1) : null,
      pitched: c.f.pitched, outcome: c.f.outcome, outcome_label: OUTCOME_LABEL[c.f.outcome] || c.f.outcome,
      objections: objectionFamiliesOf(id).map((family) => ({ objection_key: family, title: familyTitle.get(family) || text((eventsByCall.get(id) || []).find((e) => (text(e.objection_key) || text(e.objection_id)) === family)?.objection_title) || family })),
      duration_seconds: c.f.duration_seconds,
      followups: (actionsByCall.get(id) || []).map((a) => ({ action_id: text(a.action_id), action_type: upper(a.action_type), action_status: upper(a.action_status), due_at: text(a.due_at) })),
      followups_state: text(meta.followups),
      recording: Boolean(text(c.row.recording_sid) || text(c.row.recording_url)),
      callback_at: text(c.row.callback_at), meeting_at: text(c.row.meeting_at),
      not_interested_reason: text(c.row.not_interested_reason), more_info_type: text(c.row.more_info_type),
      main_priority: text(c.row.main_priority), main_constraint: text(c.row.main_constraint), note: text(c.row.useful_note),
    };
  });

  return {
    generated_at: now,
    range: { key: window.key, from: window.from, to: window.to, timezone: 'Europe/London' },
    filters: { script_id: text(scriptFilter) },
    summary, funnel, outcomes,
    objections: { rows: objectionRows, calls_with_objection: callsWithObjection, owner_calls: n.owner_reached, event_count: events.length },
    scripts: scriptRows,
    gatekeeper, timing, followups,
    explorer: { rows: explorerRows, total: calls.length, truncated: calls.length > EXPLORER_ROW_CAP, cap: EXPLORER_ROW_CAP },
    enums: {
      outcomes: CALL_OUTCOMES.map((key) => ({ outcome: key, label: OUTCOME_LABEL[key] })),
      scripts: scripts.map((row) => ({ script_id: text(row.script_id), name: text(row.name), version: Number(row.version) || 1, status: upper(row.status), is_current: text(row.script_id) === currentId }))
        .sort((a, b) => Number(b.is_current) - Number(a.is_current) || a.name.localeCompare(b.name) || b.version - a.version),
      objections: [...familyTitle.entries()].map(([objection_key, title]) => ({ objection_key, title })).sort((a, b) => a.title.localeCompare(b.title)),
    },
  };
}

// YYYY-MM-DD of the London calendar date of an instant.
function londonDate(ms) {
  const p = londonParts(ms);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export const _internal = { londonDate, londonMidnightOfDate, inRange, callFacts };
