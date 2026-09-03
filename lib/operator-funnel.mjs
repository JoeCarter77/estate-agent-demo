// Pure acquisition-wide projection. Unlike the legacy OUTBOUND-centric
// operator aggregator, this starts from AGENCIES so an unprobed agency cannot
// disappear merely because it has no downstream row yet.
import { buildOperatorLeads } from './operator-leads.mjs';
import { demoSentEvidence, isProbeQueueEligible, resolveLifecycleStage, TERMINAL_STAGES } from './acquisition-stage.mjs';
import { actionQueue, deriveExpectedActions, isManualSalesAction } from './acquisition-actions.mjs';
import { parseActionRecords } from './actions-store.mjs';
import { parseSalesMessageRecords } from './sales-messages.mjs';
// CANONICAL OUTREACH EXECUTION. Read-only, supplied by the caller. This module
// never fetches it: buildAgencyEvidence stays as pure as it was, and the one
// bounded Instantly read lives with its cache in the module below.
import { lookupOutreachExecution, unavailableExecution } from './instantly-execution-state.mjs';

export const ACQUISITION_REQUIRED_TABS = Object.freeze([
  'AGENCIES', 'PROBES', 'INTELLIGENCE', 'PERSONALISATION', 'DEMOS', 'OUTBOUND', 'REPLY_EVENTS',
]);
export const ACQUISITION_OPTIONAL_TABS = Object.freeze(['SALES_MESSAGES', 'ACTIONS']);
export const ACQUISITION_TABS = Object.freeze([...ACQUISITION_REQUIRED_TABS, ...ACQUISITION_OPTIONAL_TABS]);

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();
const ts = (value) => Number.isFinite(Date.parse(text(value))) ? Date.parse(text(value)) : -Infinity;

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
function latest(rows, fields = ['updated_at', 'created_at']) {
  return [...(rows || [])].sort((a, b) => {
    for (const field of fields) {
      const delta = ts(b[field]) - ts(a[field]);
      if (delta) return delta;
    }
    return text(b.probe_id || b.outbound_id).localeCompare(text(a.probe_id || a.outbound_id));
  })[0] || null;
}
function blankLead(agency) {
  return {
    outbound_id: '', agency_id: text(agency.agency_id), probe_id: '', agency_name: text(agency.clean_agency_name || agency.agency_name),
    contact: { name: text(agency.outreach_contact_name || agency.primary_contact_name), email: text(agency.outreach_contact_email || agency.primary_contact_email), email_verification_status: text(agency.email_verification_status), resolution_status: text(agency.contact_resolution_status), contact_type: 'UNKNOWN', decision_maker_confidence: 'UNKNOWN', phone: text(agency.main_phone) },
    current_state: 'UNKNOWN', current_state_reason: '', priority: null, needs_human: false,
    outreach: { instantly_lead_id: '', instantly_added_at: '', outbound_status: '', handed_to_instantly: false, last_error: '' },
    latest_event: { type: null, at: null, summary: '' }, next_action: { type: null, status: null, requires_human: false, due_at: null },
    reply: { reply_event_id: '', classification: '', confidence: '', classifier_reason: '', suppression_type: '', text: '', received_at: '', reply_count: 0, error: '', notes: '' },
    demo: { slug: '', url: '', preview_url: '', status: '', first_viewed_at: '', last_viewed_at: '', view_count: 0, cta_clicked_at: '', meeting_booked_at: '', engagement: 'NONE' },
    probe_summary: { probe_reference: '', grade: '', grade_reason: '', human_contact: '', response_hours: '', main_finding: '', email_observation: '', property_street: '' },
    other_journeys: [],
  };
}

export function enforceNextActionInvariant(stage, currentAction) {
  return !TERMINAL_STAGES.has(stage) && !currentAction ? 'NO_NEXT_ACTION' : stage;
}

export function buildAgencyEvidence(tables, { now = new Date().toISOString(), execution = null } = {}) {
  const agencies = records(tables.AGENCIES, 'agency_id');
  const probes = group(records(tables.PROBES, 'probe_id'), 'agency_id');
  const outbound = group(records(tables.OUTBOUND, 'outbound_id'), 'agency_id');
  const replies = group(records(tables.REPLY_EVENTS, 'reply_event_id'), 'agency_id');
  const demos = group(records(tables.DEMOS, 'demo_id'), 'agency_id');
  const intelligence = group(records(tables.INTELLIGENCE, 'intelligence_id'), 'probe_id');
  const personalisation = group(records(tables.PERSONALISATION, 'probe_id'), 'probe_id');
  const sales = group(parseSalesMessageRecords(tables.SALES_MESSAGES).map((record) => record.obj), 'agency_id');
  const actions = group(parseActionRecords(tables.ACTIONS).map((record) => record.obj), 'agency_id');

  return agencies.map((agency) => {
    const agencyId = text(agency.agency_id);
    const probe = latest(probes.get(agencyId), ['probe_timestamp', 'updated_at', 'created_at']);
    const probeId = text(probe?.probe_id);
    const journeys = outbound.get(agencyId) || [];
    const primary = latest(journeys, ['instantly_added_at', 'updated_at', 'created_at']);
    const demo = (demos.get(agencyId) || []).find((row) => text(row.probe_id) === probeId) || latest(demos.get(agencyId));
    const intel = latest(intelligence.get(probeId));
    const person = latest(personalisation.get(probeId));
    const contactReady = Boolean(text(agency.outreach_contact_email)) && ['VALID', 'RISKY'].includes(upper(agency.email_verification_status));
    const demoReady = upper(demo?.demo_status) === 'READY' && Boolean(text(demo?.demo_slug));
    const personalisationReady = Boolean(person);
    const preparation = [];
    if (!contactReady) preparation.push('contact resolution');
    if (!personalisationReady) preparation.push('personalisation');
    if (!demoReady) preparation.push('demo creation/review');
    // The lead was uploaded to Instantly under OUTBOUND.outreach_contact_email
    // (see mapOutboundToInstantly), so that is the address Instantly's own
    // events correlate on. AGENCIES is the fallback for a row compiled before
    // the copy existed.
    const outreachEmail = text(primary?.outreach_contact_email) || text(agency.outreach_contact_email);
    const handedToInstantly = Boolean(text(primary?.instantly_lead_id));
    const evidence = {
      agency, probe, outbound: primary, otherOutbound: journeys.filter((row) => row !== primary),
      execution: handedToInstantly
        ? lookupOutreachExecution(execution, { email: outreachEmail, handed: true })
        : unavailableExecution('lead is not handed to Instantly'),
      replyEvents: replies.get(agencyId) || [], salesMessages: sales.get(agencyId) || [],
      demo, intelligence: intel, personalisation: person, actions: actions.get(agencyId) || [],
      outreachReady: contactReady && demoReady && personalisationReady,
      preparationReason: preparation.length ? `waiting for ${preparation.join(', ')}` : '',
      now, nowMs: Date.parse(now),
    };
    const resolved = resolveLifecycleStage(evidence);
    evidence.stage = resolved.stage;
    evidence.stageReason = resolved.reason;
    return evidence;
  });
}

function conversion(numerator, denominator) {
  return { numerator, denominator, percent: denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null };
}

// Aggregated from the ONE canonical per-lead execution object, so a Pipeline
// stage count and an Analytics total are two views of the same evidence.
export function emailExecutionMetrics(evidenceRows) {
  const rows = evidenceRows || [];
  const handed = rows.filter((row) => Boolean(text(row.outbound?.instantly_lead_id)));
  const live = handed.filter((row) => row.execution?.source === 'INSTANTLY');
  const sum = (fn) => live.reduce((total, row) => total + (Number(fn(row)) || 0), 0);
  const totalSent = sum((row) => row.execution.emails_sent_count);
  const firstSent = live.filter((row) => row.execution.emails_sent_count >= 1).length;
  return {
    execution_available: live.length > 0,
    execution_leads_covered: live.length,
    leads_added_to_outreach: handed.length,
    waiting_for_first_email: live.filter((row) => row.execution.emails_sent_count === 0).length,
    first_emails_sent: firstSent,
    // Total minus one per lead that has had at least one send: exactly the
    // number of sequence emails after email 1.
    followup_emails_sent: Math.max(0, totalSent - firstSent),
    total_emails_sent: totalSent,
    manual_emails_sent: sum((row) => row.execution.manual_emails_sent_count),
  };
}

export function buildFunnelMetrics(evidenceRows) {
  const rows = evidenceRows || [];
  const stageCounts = {};
  for (const row of rows) stageCounts[row.stage] = (stageCounts[row.stage] || 0) + 1;
  const hasProbe = (e) => Boolean(e.probe);
  const outreach = (e) => Boolean(e.outbound);
  const replied = (e) => e.replyEvents.length > 0;
  const positive = (e) => e.replyEvents.some((r) => ['POSITIVE_SEND_DEMO', 'POSITIVE_MEETING'].includes(upper(r.classification)));
  const demoSent = (e) => demoSentEvidence(e).sent;
  const demoOpen = (e) => Boolean(text(e.demo?.first_viewed_at));
  const meeting = (e) => e.stage === 'MEETING_BOOKED';
  const count = (fn) => rows.filter(fn).length;
  const totals = {
    total_agencies: rows.length,
    total_active_agencies: count((e) => !TERMINAL_STAGES.has(e.stage)),
    ready_to_probe: stageCounts.READY_TO_PROBE || 0,
    // Physical Prober queue depth: AGENCIES.probe_sent blank + normal
    // exclusions. Same canonical rule the Prober's next-agency lookup uses.
    probe_queue: count((e) => isProbeQueueEligible(e.agency)),
    probed: count(hasProbe), probe_observing: stageCounts.PROBE_OBSERVING || 0,
    probe_complete: count((e) => hasProbe(e) && ['CLOSED'].includes(upper(e.probe?.probe_status))),
    ready_outbound: count(outreach), sequence_running: stageCounts.SEQUENCE_RUNNING || 0,
    replied: count(replied), positive_replies: count(positive), demo_sent: count(demoSent),
    demo_opened: count(demoOpen), cta_clicked: count((e) => Boolean(text(e.demo?.cta_clicked_at))),
    // ── REAL EMAIL EXECUTION ────────────────────────────────────────────
    // Every figure below is Instantly's count of emails that actually left.
    // "Added to outreach" is deliberately a SEPARATE number from "first emails
    // sent": conflating them is what previously reported a 100-lead handoff as
    // 100 emails. execution_available says whether these can be trusted at all.
    ...emailExecutionMetrics(rows),
    call_due: stageCounts.CALL_DUE || 0,
    call_completed: rows.reduce((n, e) => n + e.actions.filter((a) => ['CALL_PROSPECT', 'RETRY_CALL'].includes(upper(a.action_type)) && upper(a.action_status) === 'COMPLETED').length, 0),
    meeting_booked: count(meeting), by_stage: stageCounts,
  };
  totals.conversions = {
    probe_to_outreach: conversion(count(outreach), count(hasProbe)),
    // Added-to-outreach is a handoff, not a send. Both rates are kept: the
    // first answers "of everyone we queued", the second answers the question
    // that actually measures the campaign — "of everyone we actually emailed".
    // The send-based rate has no denominator at all until Instantly execution
    // state is available, and conversion() reports that as blank rather than 0.
    outreach_to_reply: conversion(count(replied), count(outreach)),
    first_email_to_reply: conversion(count((e) => replied(e) && (e.execution?.emails_sent_count || 0) >= 1), totals.first_emails_sent),
    reply_to_positive: conversion(count(positive), count(replied)),
    positive_to_demo_sent: conversion(count(demoSent), count(positive)),
    demo_sent_to_open: conversion(count(demoOpen), count(demoSent)),
    demo_open_to_meeting: conversion(count(meeting), count(demoOpen)),
    outreach_to_meeting: conversion(count(meeting), count(outreach)),
  };
  return totals;
}

export function buildAcquisitionDashboard(tables, { now = new Date().toISOString(), actionsAvailable = Boolean(tables.ACTIONS?.header?.length), execution = null } = {}) {
  const warnings = [];
  const legacy = buildOperatorLeads(tables, { now });
  const legacyByAgency = new Map(legacy.leads.map((lead) => [text(lead.agency_id), lead]));
  const evidenceRows = buildAgencyEvidence(tables, { now, execution });
  const leads = evidenceRows.map((evidence) => {
    const lead = structuredClone(legacyByAgency.get(text(evidence.agency.agency_id)) || blankLead(evidence.agency));
    if (!lead.contact.phone) lead.contact.phone = text(evidence.agency.main_phone);
    const expected = deriveExpectedActions(evidence, now);
    const active = evidence.actions.filter((row) => ['PENDING', 'DUE', 'IN_PROGRESS'].includes(upper(row.action_status)));
    const failed = evidence.actions.filter((row) => upper(row.action_status) === 'FAILED');
    const candidates = active.length ? active : expected;
    // A live manual sales action outranks probe-queue and system work, so the
    // lead's headline action is the one a human would actually act on.
    const queueRank = (row) => ({ JOE: 0, PROBER: 1, SYSTEM: 2 }[actionQueue(row)] ?? 3);
    candidates.sort((a, b) => queueRank(a) - queueRank(b) || ts(a.due_at) - ts(b.due_at));
    const current = candidates[0] || null;
    const stage = enforceNextActionInvariant(evidence.stage, current);
    const exceptions = [];
    if (stage === 'NO_NEXT_ACTION') exceptions.push('NO_NEXT_ACTION');
    if (stage === 'ERROR') exceptions.push('STATE_CONFLICT');
    if (failed.length) exceptions.push('ACTION_FAILED');
    if (evidence.salesMessages.some((row) => upper(row.send_outcome) === 'AMBIGUOUS')) exceptions.push('AMBIGUOUS_SEND');
    if (stage === 'PREPARING_OUTREACH' && !text(evidence.agency.outreach_contact_email)) exceptions.push('MISSING_CONTACT');
    if (stage === 'PREPARING_OUTREACH' && !evidence.demo) exceptions.push('MISSING_DEMO');
    lead.current_stage = stage;
    lead.current_stage_reason = evidence.stageReason;
    lead.current_action = current ? { ...current, persisted: active.includes(current) } : null;
    // Agency identity fields the acquisition views need but the legacy
    // OUTBOUND-centric lead shape never carried.
    lead.location = text(evidence.agency.location);
    lead.rightmove_url = text(evidence.agency.rightmove_sales_branch_url);
    lead.action_queue = current ? actionQueue(current) : null;
    lead.next_action = current ? { type: current.action_type, status: current.action_status, owner: current.action_owner, due_at: current.due_at, reason: current.reason, queue: lead.action_queue, requires_human: upper(current.action_owner) === 'JOE' } : { type: null, status: null, owner: null, due_at: null, reason: '', queue: null, requires_human: false };
    // needs_human is the DAILY MANUAL SALES QUEUE, not "owned by Joe".
    // Probe-queue work (PROBE_AGENCY/COMPLETE_PROBE) is Joe-owned but belongs
    // to the Prober, so it must never surface as "needs your attention".
    lead.needs_human = isManualSalesAction(current);
    lead.probe_queue_eligible = isProbeQueueEligible(evidence.agency);
    // The canonical outreach status object, verbatim. Pipeline stages, the
    // Analytics email totals and this per-lead detail are all the same numbers.
    lead.outreach_execution = evidence.execution;
    if (lead.needs_human && !lead.priority) {
      lead.priority = current.action_type === 'CALL_PROSPECT' && text(evidence.demo?.cta_clicked_at) ? 'HIGH'
        : current.action_type === 'RESOLVE_EXCEPTION' ? 'HIGH' : 'NORMAL';
    }
    lead.action_history = evidence.actions.slice().sort((a, b) => ts(b.created_at) - ts(a.created_at));
    lead.exceptions = exceptions;
    lead.probe = evidence.probe ? { sent_at: text(evidence.probe.probe_timestamp), observation_deadline: text(evidence.probe.observation_deadline), status: text(evidence.probe.probe_status), observation_closed_at: text(evidence.probe.observation_closed_at) } : null;
    return lead;
  });
  const globalExceptions = [];
  if (!actionsAvailable) {
    warnings.push({ code: 'actions_unavailable', detail: 'ACTIONS tab is missing or has the wrong header; expected actions are projected but not yet durable' });
    globalExceptions.push({ type: 'ACTION_LEDGER_UNAVAILABLE', reason: 'Create the ACTIONS tab with npm run novus:actions-setup before relying on durable checkpoints' });
  }
  // The execution read is additive and fails soft. When it is unavailable every
  // handed lead stays on the pre-existing stored-evidence stage, so the page is
  // never wrong — but it is incomplete, and it says so out loud rather than
  // presenting a handoff count as a send count.
  if (execution && execution.available !== true) {
    warnings.push({ code: 'outreach_execution_unavailable', detail: execution.error || 'Instantly execution state could not be read; email-send figures are unavailable and handed leads fall back to stored evidence' });
  }
  if (execution && execution.available === true && execution.truncated) {
    warnings.push({ code: 'outreach_execution_truncated', detail: `Instantly execution sweep hit its ${execution.pages}-page bound; email counts are lower bounds` });
  }
  if ((legacy.counts?.orphan_reply_events || 0) > 0) {
    globalExceptions.push({ type: 'UNMATCHED_REPLY', reason: `${legacy.counts.orphan_reply_events} REPLY_EVENTS row(s) have no matching OUTBOUND journey` });
  }
  const metrics = buildFunnelMetrics(evidenceRows);
  const counts = {
    ...legacy.counts, total: leads.length, active: metrics.total_active_agencies,
    needs_attention: leads.filter((lead) => lead.needs_human).length,
    exceptions: leads.filter((lead) => lead.exceptions.length).length + globalExceptions.length,
    ready_to_probe: metrics.ready_to_probe, probe_queue: metrics.probe_queue,
    probe_observing: metrics.probe_observing,
    preparing_outreach: metrics.by_stage.PREPARING_OUTREACH || 0,
    waiting_first_email: metrics.by_stage.WAITING_FOR_FIRST_EMAIL || 0,
    leads_added_to_outreach: metrics.leads_added_to_outreach,
    first_emails_sent: metrics.first_emails_sent,
    followup_emails_sent: metrics.followup_emails_sent,
    total_emails_sent: metrics.total_emails_sent,
    outreach_execution_available: metrics.execution_available,
    sequence_running: metrics.sequence_running, replied: metrics.replied,
    demos_sent: metrics.demo_sent, demos_opened: metrics.demo_opened,
    calls_due: metrics.call_due, meetings: metrics.meeting_booked,
    by_stage: metrics.by_stage,
  };
  const priorityRank = { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
  const nowMs = Date.parse(now);
  leads.sort((a, b) => {
    if (a.needs_human !== b.needs_human) return a.needs_human ? -1 : 1;
    const aOverdue = ts(a.next_action.due_at) <= nowMs ? 0 : 1;
    const bOverdue = ts(b.next_action.due_at) <= nowMs ? 0 : 1;
    return aOverdue - bOverdue
      || (priorityRank[a.priority] ?? 4) - (priorityRank[b.priority] ?? 4)
      || ts(a.next_action.due_at) - ts(b.next_action.due_at)
      || a.agency_name.localeCompare(b.agency_name);
  });
  return { leads, counts, metrics, global_exceptions: globalExceptions, warnings: [...legacy.warnings, ...warnings], generated_at: now };
}

export const _internal = { records, group, latest };
