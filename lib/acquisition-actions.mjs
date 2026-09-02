import { ACQUISITION_POLICY, addMs } from './acquisition-policy.mjs';
import { TERMINAL_STAGES, demoSentEvidence, latestInbound, latestSentMessage } from './acquisition-stage.mjs';

export const ACTION_OWNERS = Object.freeze(['NOVUS', 'JOE', 'SYSTEM']);
export const ACTION_STATUSES = Object.freeze(['PENDING', 'DUE', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'FAILED']);
export const ACTION_TYPES = Object.freeze([
  'PROBE_AGENCY', 'COMPLETE_PROBE', 'OBSERVATION_CHECKPOINT', 'PREPARE_OUTREACH',
  'HANDOFF_TO_INSTANTLY', 'FIRST_EMAIL_CHECKPOINT', 'SEQUENCE_CHECKPOINT',
  'HUMAN_REPLY', 'MANUAL_REVIEW', 'SEND_DEMO', 'OUT_OF_OFFICE_CHECKPOINT',
  'DEMO_UNOPENED_FOLLOWUP', 'DEMO_OPENED_FOLLOWUP', 'CALL_PROSPECT', 'RETRY_CALL',
  'FOLLOW_UP_CONVERSATION', 'SET_NEXT_STEP', 'RESOLVE_EXCEPTION',
]);

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();
const at = (value) => Number.isFinite(Date.parse(text(value))) ? Date.parse(text(value)) : null;

function expected(evidence, stage, actionType, owner, dueAt, reason, anchor = '') {
  const agencyId = text(evidence.agency?.agency_id);
  return {
    agency_id: agencyId,
    outreach_id: text(evidence.outbound?.outbound_id),
    probe_id: text(evidence.probe?.probe_id),
    reply_event_id: text(latestInbound(evidence)?.reply_event_id),
    action_type: actionType,
    action_owner: owner,
    action_status: at(dueAt) !== null && at(dueAt) <= evidence.nowMs ? 'DUE' : 'PENDING',
    due_at: dueAt || '',
    reason,
    source_stage: stage,
    dedupe_key: [agencyId, actionType, anchor || stage].join(':'),
    metadata_json: '{}',
  };
}

export function deriveExpectedActions(evidence, now = new Date().toISOString(), policy = ACQUISITION_POLICY) {
  const stage = evidence.stage;
  if (TERMINAL_STAGES.has(stage)) return [];
  const latest = latestInbound(evidence);
  const inboundAt = text(latest?.received_at || latest?.processed_at);
  const sentDemo = demoSentEvidence(evidence);
  const firstViewed = text(evidence.demo?.first_viewed_at);
  const lastViewed = text(evidence.demo?.last_viewed_at) || firstViewed;
  const manual = latestSentMessage(evidence, 'MANUAL_REPLY');
  const followup = latestSentMessage(evidence, 'FOLLOW_UP');
  const anchor = text(latest?.reply_event_id || evidence.outbound?.outbound_id || evidence.probe?.probe_id || evidence.agency?.agency_id);
  const latestInboundAt = at(inboundAt);
  const manualAt = at(manual?.sent_at || manual?.created_at);
  const followupAt = at(followup?.sent_at || followup?.created_at);
  if (upper(latest?.classification) === 'OOO_AUTOMATED'
      && latestInboundAt !== null
      && (manualAt === null || latestInboundAt >= manualAt)
      && (followupAt === null || latestInboundAt >= followupAt)) {
    return [expected(evidence, stage, 'OUT_OF_OFFICE_CHECKPOINT', 'SYSTEM',
      addMs(inboundAt, policy.outOfOfficeCheckpointMs),
      'Automated out-of-office reply recorded; wait before re-evaluating the underlying journey', anchor)];
  }
  const sticky = (evidence.actions || []).find((row) => {
    if (!['PENDING', 'DUE', 'IN_PROGRESS'].includes(upper(row.action_status))) return false;
    try {
      const metadata = JSON.parse(text(row.metadata_json) || '{}');
      return Boolean(metadata.parent_action_id) && (latestInboundAt === null || latestInboundAt <= (at(row.created_at) ?? Infinity));
    } catch { return false; }
  });
  if (sticky) return [{ ...sticky, action_status: at(sticky.due_at) !== null && at(sticky.due_at) <= evidence.nowMs ? 'DUE' : upper(sticky.action_status) }];

  switch (stage) {
    case 'READY_TO_PROBE': return [expected(evidence, stage, 'PROBE_AGENCY', 'JOE', now, 'Agency is eligible and has not been probed', anchor)];
    case 'PROBE_IN_PROGRESS': return [expected(evidence, stage, 'COMPLETE_PROBE', 'JOE', now, 'Draft probe must be submitted and marked sent', anchor)];
    case 'PROBE_OBSERVING': return [expected(evidence, stage, 'OBSERVATION_CHECKPOINT', 'SYSTEM', text(evidence.probe?.observation_deadline), 'Existing four-day observation window is running', anchor)];
    case 'PROBE_COMPLETE':
    case 'PREPARING_OUTREACH': return [expected(evidence, stage, 'PREPARE_OUTREACH', 'NOVUS', now, evidence.preparationReason || 'Complete deterministic downstream preparation', anchor)];
    case 'READY_FOR_OUTREACH': return [expected(evidence, stage, 'HANDOFF_TO_INSTANTLY', 'NOVUS', now, 'Outbound record is ready for existing Instantly handoff', anchor)];
    case 'WAITING_FOR_FIRST_EMAIL': return [expected(evidence, stage, 'FIRST_EMAIL_CHECKPOINT', 'SYSTEM', addMs(evidence.outbound?.instantly_added_at || evidence.outbound?.updated_at, policy.firstEmailCheckpointMs), 'Lead is in Instantly; verify stored evidence progresses', anchor)];
    case 'SEQUENCE_RUNNING': return [expected(evidence, stage, 'SEQUENCE_CHECKPOINT', 'SYSTEM', addMs(evidence.outbound?.instantly_added_at || evidence.outbound?.updated_at, policy.sequenceCheckpointMs), 'Instantly sequence is handling this lead', anchor)];
    case 'MEETING_INTENT':
    case 'REPLIED_NEEDS_HUMAN': {
      const type = upper(latest?.classification) === 'OTHER_UNCLEAR' || /previous NOT_INTERESTED/i.test(evidence.stageReason) ? 'MANUAL_REVIEW'
        : upper(latest?.classification) === 'NOT_NOW' ? 'SET_NEXT_STEP' : 'HUMAN_REPLY';
      return [expected(evidence, stage, type, 'JOE', inboundAt || now, evidence.stageReason, anchor)];
    }
    case 'DEMO_REQUESTED': return [expected(evidence, stage, 'SEND_DEMO', 'NOVUS', inboundAt || now, 'Positive reply requested demo; existing SEND_DEMO gates must pass', anchor)];
    case 'DEMO_SENT_UNOPENED': return [expected(evidence, stage, 'DEMO_UNOPENED_FOLLOWUP', 'NOVUS', addMs(sentDemo.at, policy.demoUnopenedFollowupMs), 'Demo sent and not genuinely opened; no newer inbound reply', sentDemo.at)];
    case 'DEMO_OPENED': return [expected(evidence, stage, 'DEMO_OPENED_FOLLOWUP', 'NOVUS', addMs(lastViewed, policy.demoOpenedFollowupMs), 'Demo genuinely opened; no newer inbound reply or meeting', lastViewed)];
    case 'DEMO_ENGAGED': return [expected(evidence, stage, 'CALL_PROSPECT', 'JOE', text(evidence.demo?.cta_clicked_at) || now, 'Strong demo engagement (CTA click or repeat views)', text(evidence.demo?.cta_clicked_at || lastViewed))];
    case 'DEMO_FOLLOWUP_SENT': return [expected(evidence, stage, 'CALL_PROSPECT', 'JOE', addMs(followup?.sent_at || followup?.created_at, policy.afterDemoFollowupCallMs), 'Demo follow-up received no newer inbound reply', text(followup?.sales_message_id))];
    case 'MANUAL_REPLY_SENT_WAITING': return [expected(evidence, stage, 'FOLLOW_UP_CONVERSATION', 'JOE', addMs(manual?.sent_at || manual?.created_at, policy.afterManualReplyFollowupMs), 'Manual reply received no newer inbound reply', text(manual?.sales_message_id))];
    case 'CALL_DUE': {
      const call = (evidence.actions || []).find((row) => ['CALL_PROSPECT', 'RETRY_CALL'].includes(upper(row.action_type)) && ['PENDING', 'DUE', 'IN_PROGRESS'].includes(upper(row.action_status)));
      return call ? [{ ...call, action_status: 'DUE' }] : [];
    }
    case 'ERROR': return [expected(evidence, stage, 'RESOLVE_EXCEPTION', 'JOE', now, evidence.stageReason || 'Acquisition state error', anchor)];
    case 'LEAD_POOL': return [expected(evidence, stage, 'RESOLVE_EXCEPTION', 'JOE', now, 'Agency has no eligible probe path or explicit closure', anchor)];
    default: return [];
  }
}

export function reconcileActions(existing, expectedRows, now = new Date().toISOString()) {
  const active = new Map((existing || []).filter((row) => ['PENDING', 'DUE', 'IN_PROGRESS'].includes(upper(row.action_status)))
    .map((row) => [text(row.dedupe_key), row]));
  const wanted = new Map((expectedRows || []).map((row) => [text(row.dedupe_key), row]));
  const create = [];
  const update = [];
  const cancel = [];

  for (const [key, row] of wanted) {
    const found = active.get(key);
    if (!found) create.push(row);
    else {
      const status = at(row.due_at) !== null && at(row.due_at) <= Date.parse(now) && upper(found.action_status) === 'PENDING'
        ? 'DUE' : upper(found.action_status);
      if (status !== upper(found.action_status) || text(found.due_at) !== text(row.due_at)
          || text(found.reason) !== text(row.reason)) {
        update.push({ action_id: found.action_id, patch: { due_at: row.due_at, reason: row.reason, action_status: status, updated_at: now } });
      }
    }
  }
  for (const [key, row] of active) {
    if (!wanted.has(key)) cancel.push({ action_id: row.action_id, patch: {
      action_status: 'CANCELLED', cancelled_at: now, updated_at: now,
      completion_reason: 'Lifecycle evidence changed; stale action cancelled',
    }});
  }
  return { create, update, cancel };
}
