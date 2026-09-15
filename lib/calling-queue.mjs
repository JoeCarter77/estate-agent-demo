// lib/calling-queue.mjs — PURE projection of "who should I call next, and
// why". No I/O; takes already-loaded tables and returns the calling queue,
// the Call Actions groups and the per-lead calling context.
//
// PRIORITY IS A RULE, NOT A GUESS. Every queued lead carries the bucket it
// landed in and the reason, so the Calling tab can show "why this one is
// due" and Start Calling never picks at random:
//   1  scheduled callback, overdue (due before today)
//   2  scheduled callback, due today
//   3  no-answer retry, due
//   4  any other call action that is due (engine-derived CALL_PROSPECT etc.)
//   5  general cold-calling pool: never called, no call action pending, and
//      a genuine probe was SENT/COMPLETED for this agency (an agency that
//      merely exists, or whose only PROBES row is still DRAFT, never enters
//      bucket 5 — see isProbeSentOrComplete below). Ranked within the bucket
//      by engagement tier, then oldest probe date — see engagement() below.
// A callback whose time has not arrived yet is NOT in the queue — it is
// scheduled work and lives in Call Actions until it is due.
//
// SUPPRESSION IS DERIVED FROM IMMUTABLE CALLS. A DO_NOT_CALL outcome, a
// WRONG_NUMBER on the only number we hold, a NOT_INTERESTED call, a
// terminal pipeline status, or the agency-level all-contact suppression flag
// remove a lead from the queue. An EMAIL opt-out (REPLY_EVENTS
// suppression_type=PERMANENT / OPT_OUT) is channel-specific — it stops the
// email campaign, not the phone — so it is surfaced as context on the lead,
// never as calling suppression. Nothing is written to AGENCIES to make any
// of this happen.

import { normalizePhone } from './normalize.mjs';
import { TERMINAL_STAGES } from './acquisition-stage.mjs';
import { CALL_ACTION_TYPES, isCallingWorkflowAction } from './acquisition-actions.mjs';
import { parseActionRecords } from './actions-store.mjs';
import { callRecords, currentScript, scriptRecords } from './calling-store.mjs';
import { londonDayNumber } from './london-time.mjs';

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();
const ts = (value) => (Number.isFinite(Date.parse(text(value))) ? Date.parse(text(value)) : null);
const ACTIVE = new Set(['PENDING', 'DUE', 'IN_PROGRESS', 'SNOOZED']);
const TERMINAL_PIPELINE = new Set([...TERMINAL_STAGES, 'EXCLUDED']);

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
function group(rows, key) {
  const out = new Map();
  for (const row of rows) {
    const value = text(row[key]);
    if (!value) continue;
    if (!out.has(value)) out.set(value, []);
    out.get(value).push(row);
  }
  return out;
}
function metadata(row) {
  try { return JSON.parse(text(row?.metadata_json) || '{}'); } catch { return {}; }
}
// Calendar days are LONDON days: "overdue" means due before today in the UK.
const localDay = (ms) => londonDayNumber(ms);

export const QUEUE_BUCKET_LABEL = Object.freeze({
  1: 'Callback overdue', 2: 'Callback due today', 3: 'No-answer retry due', 4: 'Call action due', 5: 'Not yet called',
});

// GENUINE PROBE SENT/COMPLETED EVIDENCE. Gated on probe_status alone, never
// on probe_timestamp: api/novus/probe.js's handleMarkSent writes both
// together in the one update that flips a probe out of 'draft' (status
// 'observing' + probe_timestamp = sentAt, atomically), so probe_timestamp
// DOES mean "sent" on a clean row — but this is a hand-editable Sheet, and
// the codebase already guards elsewhere against a hand-edited/legacy row
// whose fields disagree (handleMarkSent's own draft-with-timestamp check;
// see also the CANONICAL PROBER QUEUE RULE comment on isProbeSentBlank in
// acquisition-stage.mjs). A stray timestamp on a row still marked 'draft' is
// exactly that disagreement, so it is never treated as evidence by itself —
// only OBSERVING/ACTIVE/CLOSED (the states handleMarkSent and the
// observation-recompute self-heal actually produce) count as sent/complete.
function isProbeSentOrComplete(row) {
  return ['OBSERVING', 'ACTIVE', 'CLOSED'].includes(upper(row?.probe_status));
}
function earliestProbeSentAt(rows) {
  const sentAt = (rows || []).filter(isProbeSentOrComplete).map((row) => ts(row.probe_timestamp)).filter((v) => v !== null);
  return sentAt.length ? Math.min(...sentAt) : null;
}

// ENGAGEMENT TIER, for ranking the general cold-calling pool once explicit
// call actions are exhausted. 1 = strong (a real reply, or a demo genuinely
// re-viewed / CTA-clicked), 2 = moderate (a low-signal reply, or a single
// genuine demo view — email-open-equivalent tracking is noisy, so one
// ordinary view never outranks a real interaction), 3 = probe sent, nothing
// back yet, 4 = the email channel came back negative (NOT_INTERESTED /
// OPT_OUT). Tier 4 is NOT phone suppression — REPLY_EVENTS is channel-
// specific and callingSuppression() above never reads it — it only ranks
// these leads below an untouched lead, since a probe with no signal at all
// is a better use of a call than one that already said no by email. Built
// entirely from REPLY_EVENTS.classification (lib/reply-router.mjs) and DEMOS
// view/CTA analytics — no new fields invented.
const STRONG_REPLY = new Set(['POSITIVE_SEND_DEMO', 'POSITIVE_MEETING', 'QUESTION']);
const WEAK_REPLY = new Set(['NOT_NOW', 'OTHER_UNCLEAR']);
const NEGATIVE_REPLY_LABEL = { NOT_INTERESTED: 'Email declined', OPT_OUT: 'Email opt-out' };
function engagement({ replies, demo }) {
  const all = (replies || []).map((row) => upper(row.classification));
  const genuine = all.filter((c) => !['OOO_AUTOMATED', 'OPT_OUT', 'NOT_INTERESTED'].includes(c));
  const strongReply = genuine.some((c) => STRONG_REPLY.has(c));
  const weakReply = genuine.some((c) => WEAK_REPLY.has(c));
  const demoEngaged = Boolean(demo && (text(demo.cta_clicked_at) || Number(demo.view_count || 0) >= 2));
  const demoViewedOnce = Boolean(demo && !demoEngaged && Number(demo.view_count || 0) >= 1);
  if (demoEngaged) return { tier: 1, label: 'Demo viewed' };
  if (strongReply) return { tier: 1, label: 'Replied' };
  if (weakReply || demoViewedOnce) return { tier: 2, label: 'Email activity' };
  if (all.includes('NOT_INTERESTED')) return { tier: 4, label: NEGATIVE_REPLY_LABEL.NOT_INTERESTED };
  if (all.includes('OPT_OUT')) return { tier: 4, label: NEGATIVE_REPLY_LABEL.OPT_OUT };
  return { tier: 3, label: 'No interaction' };
}

// The active call action for an agency, if any. Prefers the calling
// workflow's own rows, then the earliest due.
function activeCallActions(rows) {
  return (rows || [])
    .filter((row) => CALL_ACTION_TYPES.includes(upper(row.action_type)) && ACTIVE.has(upper(row.action_status)))
    .sort((a, b) => (ts(a.due_at) ?? Infinity) - (ts(b.due_at) ?? Infinity));
}

function callbackKind(action) {
  const meta = metadata(action);
  if (upper(action.action_type) === 'RETRY_CALL') return 'RETRY';
  if (meta.call_action) return 'CALLBACK';
  return 'OTHER';
}

// Why the lead is not callable, in operator language, or '' when it is.
// Deliberately does NOT read REPLY_EVENTS: email opt-outs and email "not
// interested" replies are shown on the lead as context (emailSignal below)
// for the operator to weigh, but they are not phone suppression.
export function callingSuppression({ agency, calls }) {
  if (TERMINAL_PIPELINE.has(upper(agency?.current_pipeline_status))) return `pipeline status ${upper(agency.current_pipeline_status)}`;
  if (upper(agency?.suppression_status) === 'SUPPRESSED') return 'agency suppressed';
  if ((calls || []).some((row) => upper(row.outcome) === 'DO_NOT_CALL')) return 'asked not to be called again';
  if ((calls || []).some((row) => upper(row.outcome) === 'NOT_INTERESTED')) return 'not interested on a call';
  if ((calls || []).some((row) => upper(row.outcome) === 'BOOKED_MEETING')) return 'meeting booked on a call';
  return '';
}

// The email channel's verdict on this lead, for the operator to see before
// dialling: '' | 'OPTED_OUT_EMAIL' | 'NOT_INTERESTED_EMAIL'.
export function emailSignal(replies) {
  if ((replies || []).some((row) => upper(row.suppression_type) === 'PERMANENT' || upper(row.classification) === 'OPT_OUT')) return 'OPTED_OUT_EMAIL';
  const latest = [...(replies || [])].sort((a, b) => (ts(b.received_at) ?? 0) - (ts(a.received_at) ?? 0))[0];
  return upper(latest?.classification) === 'NOT_INTERESTED' ? 'NOT_INTERESTED_EMAIL' : '';
}

// The number to dial: a decision-maker referral captured on an earlier call
// overrides the agency's main number; a number marked WRONG_NUMBER is never
// dialled again.
export function resolvePhone({ agency, calls, actions }) {
  const wrong = new Set((calls || []).filter((row) => upper(row.outcome) === 'WRONG_NUMBER').map((row) => normalizePhone(row.phone)).filter(Boolean));
  const override = activeCallActions(actions).map((row) => metadata(row).contact_override).find((ref) => ref && text(ref.phone));
  const candidates = [];
  if (override) candidates.push({ phone: text(override.phone), name: text(override.name), role: text(override.role), source: 'REFERRAL' });
  candidates.push({ phone: text(agency?.main_phone), name: '', role: '', source: 'AGENCY' });
  for (const extra of text(agency?.known_phone_numbers).split(/[;,|]/)) {
    if (text(extra)) candidates.push({ phone: text(extra), name: '', role: '', source: 'AGENCY' });
  }
  const usable = candidates.find((c) => c.phone && !wrong.has(normalizePhone(c.phone)));
  if (!usable) return { phone: '', phone_e164: '', source: '', wrong_numbers: [...wrong], name: '', role: '' };
  return { ...usable, phone_e164: normalizePhone(usable.phone), wrong_numbers: [...wrong] };
}

export function buildCallingWorkspace(tables, { now = new Date().toISOString() } = {}) {
  const nowMs = Date.parse(now);
  const today = localDay(nowMs);
  const agencies = records(tables.AGENCIES, 'agency_id');
  const callsByAgency = group(callRecords(tables.CALLS), 'agency_id');
  const actionsByAgency = group(parseActionRecords(tables.ACTIONS).map((r) => r.obj), 'agency_id');
  const repliesByAgency = group(records(tables.REPLY_EVENTS, 'reply_event_id'), 'agency_id');
  const contactsByAgency = group(records(tables.CONTACTS, 'contact_id'), 'agency_id');
  const intelByAgency = group(records(tables.INTELLIGENCE, 'intelligence_id'), 'agency_id');
  const probesByAgency = group(records(tables.PROBES, 'probe_id'), 'agency_id');
  const demosByAgency = group(records(tables.DEMOS, 'demo_id'), 'agency_id');
  const scripts = scriptRecords(tables.SCRIPTS);
  const scriptById = new Map(scripts.map((row) => [text(row.script_id), row]));
  const current = currentScript(scripts);

  const queue = [];
  const callActions = [];
  const leads = new Map();
  const counts = { callable: 0, suppressed: 0, no_phone: 0, scheduled_later: 0, no_probe: 0, by_bucket: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };

  for (const agency of agencies) {
    const agencyId = text(agency.agency_id);
    // A CALLS row without an outcome is a dial that was opened (Twilio mode)
    // and never classified — a page closed mid-call. It stays in the ledger
    // but it is not a completed attempt, so it never removes a lead from the
    // queue or counts against it.
    const calls = [...(callsByAgency.get(agencyId) || [])]
      .filter((row) => text(row.outcome))
      .sort((a, b) => (ts(b.started_at) ?? 0) - (ts(a.started_at) ?? 0));
    const actions = actionsByAgency.get(agencyId) || [];
    const replies = repliesByAgency.get(agencyId) || [];
    const selectedContact = (contactsByAgency.get(agencyId) || []).find((row) => upper(row.is_selected_for_outreach) === 'TRUE') || null;
    const intel = [...(intelByAgency.get(agencyId) || [])].sort((a, b) => (ts(b.updated_at) ?? 0) - (ts(a.updated_at) ?? 0))[0] || null;
    const latestReply = [...replies].sort((a, b) => (ts(b.received_at) ?? 0) - (ts(a.received_at) ?? 0))[0] || null;
    const demo = [...(demosByAgency.get(agencyId) || [])].sort((a, b) => (ts(b.updated_at) ?? ts(b.created_at) ?? 0) - (ts(a.updated_at) ?? ts(a.created_at) ?? 0))[0] || null;
    const probeSentAt = earliestProbeSentAt(probesByAgency.get(agencyId));
    const engaged = engagement({ replies, demo });
    const lastCall = calls[0] || null;
    const phone = resolvePhone({ agency, calls, actions });
    const suppression = callingSuppression({ agency, calls });
    const signal = emailSignal(replies);
    const active = activeCallActions(actions);
    const dueAction = active.find((row) => (ts(row.due_at) ?? 0) <= nowMs) || null;
    const scheduledAction = active.find((row) => (ts(row.due_at) ?? 0) > nowMs) || null;

    // Script assignment: a lead with no previous call gets whatever is
    // CURRENT now. A lead that has already been called STAYS on the exact
    // version it was called with — even after that version is archived —
    // so a testing cohort is never silently reassigned mid-test. The only
    // way an already-called lead changes script is a deliberate override
    // (the Calling Mode script switcher), which is a fresh call_id with its
    // own script_id and therefore becomes the new "last heard" version.
    const lastScript = lastCall ? scriptById.get(text(lastCall.script_id)) : null;
    const assigned = lastScript || current;

    const lead = {
      agency_id: agencyId,
      agency_name: text(agency.clean_agency_name || agency.agency_name),
      contact_name: phone.name || text(agency.outreach_contact_name || agency.primary_contact_name || selectedContact?.contact_name),
      contact_role: phone.role || text(selectedContact?.contact_role),
      phone: phone.phone, phone_e164: phone.phone_e164, phone_source: phone.source,
      email: text(agency.outreach_contact_email || agency.primary_contact_email),
      email_verification_status: text(agency.email_verification_status),
      location: text(agency.location),
      rightmove_url: text(agency.rightmove_sales_branch_url),
      pipeline_status: text(agency.current_pipeline_status),
      attempts: calls.length,
      last_call: lastCall ? { call_id: text(lastCall.call_id), at: text(lastCall.started_at), outcome: text(lastCall.outcome), note: text(lastCall.useful_note || lastCall.callback_note), script_id: text(lastCall.script_id) } : null,
      calls: calls.slice(0, 8).map((row) => ({ call_id: text(row.call_id), at: text(row.started_at), outcome: text(row.outcome), pitched: upper(row.pitched) === 'TRUE', duration_seconds: Number(row.duration_seconds) || 0, note: text(row.useful_note || row.callback_note || row.more_info_note || row.meeting_note), callback_at: text(row.callback_at), script_id: text(row.script_id), recording: Boolean(text(row.recording_sid) || text(row.recording_url)) })),
      next_call_due: text(dueAction?.due_at || scheduledAction?.due_at),
      script: assigned ? { script_id: text(assigned.script_id), name: text(assigned.name), version: Number(assigned.version) || 1, status: upper(assigned.status) } : null,
      suppression,
      context: {
        email_signal: signal,
        reply_classification: text(latestReply?.classification),
        reply_received_at: text(latestReply?.received_at),
        reply_text: text(latestReply?.cleaned_reply_text || latestReply?.body_text).slice(0, 280),
        probe_grade: text(intel?.grade), probe_grade_reason: text(intel?.grade_reason).slice(0, 240),
        human_contact: text(intel?.human_contact), response_hours: text(intel?.response_hours),
      },
      probe_sent_at: probeSentAt !== null ? new Date(probeSentAt).toISOString() : '',
      engagement_tier: engaged.tier,
      engagement_label: engaged.label,
      action_id: '', bucket: null, due_reason: '',
    };
    leads.set(agencyId, lead);

    // Call Actions tab: every active phone action, due or scheduled.
    for (const action of active) {
      const meta = metadata(action);
      const dueMs = ts(action.due_at);
      const day = dueMs === null ? today : localDay(dueMs);
      callActions.push({
        action_id: text(action.action_id), agency_id: agencyId, agency_name: lead.agency_name,
        contact_name: text(meta.contact_override?.name) || lead.contact_name, contact_role: text(meta.contact_override?.role) || lead.contact_role,
        phone: lead.phone, due_at: text(action.due_at), action_type: upper(action.action_type),
        kind: callbackKind(action), reason: text(meta.callback_reason) || text(action.reason),
        note: text(meta.callback_note), previous_outcome: text(meta.previous_outcome) || text(lastCall?.outcome),
        attempts: calls.length, status: upper(action.action_status),
        group: day < today ? 'overdue' : day === today ? 'today' : day === today + 1 ? 'tomorrow' : 'upcoming',
        suppressed: Boolean(suppression), no_phone: !lead.phone,
      });
    }

    if (suppression) { counts.suppressed += 1; continue; }
    if (!lead.phone) { counts.no_phone += 1; continue; }
    if (scheduledAction && !dueAction) { counts.scheduled_later += 1; continue; }

    let bucket = null;
    let reason = '';
    if (dueAction) {
      const kind = callbackKind(dueAction);
      const dueMs = ts(dueAction.due_at) ?? nowMs;
      const meta = metadata(dueAction);
      const why = text(meta.callback_reason) || text(dueAction.reason);
      if (kind === 'CALLBACK') { bucket = localDay(dueMs) < today ? 1 : 2; reason = why; }
      else if (kind === 'RETRY') { bucket = 3; reason = why || 'No answer last time'; }
      else { bucket = 4; reason = why || `${upper(dueAction.action_type).replace(/_/g, ' ').toLowerCase()} is due`; }
      lead.action_id = text(dueAction.action_id);
      lead.contact_name = text(meta.contact_override?.name) || lead.contact_name;
      lead.contact_role = text(meta.contact_override?.role) || lead.contact_role;
    } else if (calls.length === 0) {
      // GENERAL COLD-CALL POOL. Only a genuinely probed agency belongs here —
      // an agency that merely exists, or whose probe is still DRAFT, has
      // never had outreach sent and is not a cold-call candidate.
      if (probeSentAt === null) { counts.no_probe += 1; continue; }
      bucket = 5;
      reason = engaged.label;
    } else {
      // Called before, nothing scheduled, not suppressed (e.g. referred to a
      // decision-maker with no number). Not in the queue until an action exists.
      continue;
    }
    lead.bucket = bucket;
    lead.due_reason = reason;
    counts.by_bucket[bucket] += 1;
    counts.callable += 1;
    queue.push(lead);
  }

  // GENERAL COLD-CALL RANKING (bucket 5 only; buckets 1-4 keep their existing
  // due-date order untouched — explicit call actions are never reprioritised
  // by engagement). Rank by engagement tier first, then oldest probe
  // sent/completed date within the same tier.
  queue.sort((a, b) => a.bucket - b.bucket
    || (a.bucket === 5
      ? (a.engagement_tier - b.engagement_tier) || ((ts(a.probe_sent_at) ?? Infinity) - (ts(b.probe_sent_at) ?? Infinity))
      : (ts(a.next_call_due) ?? Infinity) - (ts(b.next_call_due) ?? Infinity))
    || 0);
  const groupOrder = { overdue: 0, today: 1, tomorrow: 2, upcoming: 3 };
  callActions.sort((a, b) => groupOrder[a.group] - groupOrder[b.group] || (ts(a.due_at) ?? Infinity) - (ts(b.due_at) ?? Infinity));

  return {
    generated_at: now,
    counts: { ...counts, call_actions: callActions.length, call_actions_due: callActions.filter((row) => row.group === 'overdue' || (row.group === 'today' && (ts(row.due_at) ?? 0) <= nowMs)).length },
    queue,
    call_actions: callActions,
    leads: Object.fromEntries(leads),
    current_script: current ? { script_id: text(current.script_id), name: text(current.name), version: Number(current.version) || 1 } : null,
  };
}

// ── script funnel ──────────────────────────────────────────────────────────
// Every figure is a count over immutable CALLS rows. Nothing is modelled.
export function scriptFunnel(calls) {
  // Only classified calls count as dials; an opened-but-abandoned Twilio row
  // has no outcome and therefore no place in the funnel.
  const rows = (calls || []).filter((row) => upper(row.outcome));
  const is = (row, value) => upper(row.outcome) === value;
  const flag = (row, key) => upper(row[key]) === 'TRUE';
  const dials = rows.length;
  const connected = rows.filter((row) => flag(row, 'connected')).length;
  const owner = rows.filter((row) => flag(row, 'owner_reached')).length;
  const pitched = rows.filter((row) => flag(row, 'pitched')).length;
  const moreInfo = rows.filter((row) => is(row, 'MORE_INFO_REQUESTED')).length;
  const callbacks = rows.filter((row) => is(row, 'CALLBACK_REQUESTED') || is(row, 'OWNER_UNAVAILABLE')).length;
  const notInterested = rows.filter((row) => is(row, 'NOT_INTERESTED')).length;
  const meetings = rows.filter((row) => is(row, 'BOOKED_MEETING')).length;
  const interested = moreInfo + meetings + rows.filter((row) => is(row, 'CALLBACK_REQUESTED') && flag(row, 'owner_reached')).length;
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
  return {
    dials, connected, owner_conversations: owner, pitched, more_info: moreInfo, callbacks, not_interested: notInterested,
    interested, booked_meetings: meetings,
    pitched_to_meeting_pct: pct(meetings, pitched), owner_to_meeting_pct: pct(meetings, owner),
    connect_rate_pct: pct(connected, dials), owner_rate_pct: pct(owner, connected),
  };
}

export const _internal = { records, group, metadata, activeCallActions, callbackKind, isProbeSentOrComplete, earliestProbeSentAt, engagement };
