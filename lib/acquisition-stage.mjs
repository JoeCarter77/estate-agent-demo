// Pure, top-down lifecycle resolver. It consumes only stored evidence assembled
// by operator-funnel/action-engine; it performs no I/O and makes no model calls.

export const ACQUISITION_STAGES = Object.freeze([
  'MEETING_BOOKED',
  'OPTED_OUT',
  'NOT_INTERESTED',
  'CLOSED',
  'REPLIED_NEEDS_HUMAN',
  'MEETING_INTENT',
  'DEMO_REQUESTED',
  'MANUAL_REPLY_SENT_WAITING',
  'CALL_DUE',
  'DEMO_FOLLOWUP_SENT',
  'DEMO_ENGAGED',
  'DEMO_OPENED',
  'DEMO_SENT_UNOPENED',
  'SEQUENCE_RUNNING',
  'WAITING_FOR_FIRST_EMAIL',
  'READY_FOR_OUTREACH',
  'PREPARING_OUTREACH',
  'PROBE_COMPLETE',
  'PROBE_OBSERVING',
  'PROBE_IN_PROGRESS',
  'READY_TO_PROBE',
  'LEAD_POOL',
  'NO_NEXT_ACTION',
  'ERROR',
]);

export const TERMINAL_STAGES = new Set(['MEETING_BOOKED', 'OPTED_OUT', 'NOT_INTERESTED', 'CLOSED']);

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();
const time = (value) => {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : null;
};

export function newestBy(rows, fields) {
  return [...(rows || [])].sort((a, b) => {
    const at = fields.map((f) => time(a?.[f])).find((v) => v !== null) ?? -Infinity;
    const bt = fields.map((f) => time(b?.[f])).find((v) => v !== null) ?? -Infinity;
    return bt - at;
  })[0] || null;
}

export function demoSentEvidence(evidence) {
  const reply = (evidence.replyEvents || []).filter((row) =>
    upper(row.next_action) === 'SEND_DEMO' && upper(row.action_status) === 'COMPLETED');
  const sent = (evidence.salesMessages || []).filter((row) =>
    upper(row.message_type) === 'DEMO_REPLY' && upper(row.send_outcome) === 'SENT');
  const row = newestBy([...reply, ...sent], ['sent_at', 'action_completed_at', 'created_at']);
  return { sent: Boolean(row), at: text(row?.sent_at || row?.action_completed_at || row?.created_at), row };
}

export function latestInbound(evidence) {
  return newestBy(evidence.replyEvents, ['received_at', 'processed_at']);
}

export function latestSentMessage(evidence, type = '') {
  return newestBy((evidence.salesMessages || []).filter((row) => {
    if (upper(row.send_outcome) !== 'SENT') return false;
    return !type || upper(row.message_type) === type;
  }), ['sent_at', 'created_at']);
}

export function isEligibleForProbe(agency) {
  const url = text(agency?.rightmove_sales_branch_url);
  const pipeline = upper(agency?.current_pipeline_status);
  const suppressed = upper(agency?.suppression_status) === 'SUPPRESSED';
  return /^https?:\/\//i.test(url) && !suppressed && !['CLOSED', 'EXCLUDED', 'MEETING_BOOKED', 'NOT_INTERESTED'].includes(pipeline);
}

// CANONICAL PROBER QUEUE RULE.
//
// The Prober queue is gated on the PHYSICAL AGENCIES.probe_sent cell and
// nothing else. It deliberately does not consult PROBES history, the resolved
// lifecycle stage, probe completion or any downstream state: those can all
// disagree with the sheet (a deleted PROBES row, a re-imported agency, a probe
// logged out of band), and disagreeing with the sheet is exactly how an
// already-probed agency was being handed back to the operator.
//
// ANY non-blank value in probe_sent means "already probed" — not just "YES".
export function isProbeSentBlank(agency) {
  return text(agency?.probe_sent) === '';
}

export function isProbeQueueEligible(agency) {
  return isProbeSentBlank(agency) && isEligibleForProbe(agency);
}

export function resolveLifecycleStage(evidence) {
  const agency = evidence.agency || {};
  const probe = evidence.probe || null;
  const outbound = evidence.outbound || null;
  const demo = evidence.demo || null;
  const latest = latestInbound(evidence);
  const classification = upper(latest?.classification);
  const anyPermanentOptOut = (evidence.replyEvents || []).some((row) => upper(row.suppression_type) === 'PERMANENT' || upper(row.classification) === 'OPT_OUT');
  const priorNotInterested = (evidence.replyEvents || []).some((row) => upper(row.classification) === 'NOT_INTERESTED' && row !== latest);
  const pipeline = upper(agency.current_pipeline_status);
  const suppression = upper(latest?.suppression_type);
  const sentDemo = demoSentEvidence(evidence);
  const manual = latestSentMessage(evidence, 'MANUAL_REPLY');
  const followup = latestSentMessage(evidence, 'FOLLOW_UP');
  const latestInboundAt = time(latest?.received_at || latest?.processed_at);
  const manualAt = time(manual?.sent_at || manual?.created_at);
  const followupAt = time(followup?.sent_at || followup?.created_at);

  // Terminal evidence always wins.
  if (pipeline === 'MEETING_BOOKED' || text(demo?.meeting_booked_at)) {
    return { stage: 'MEETING_BOOKED', reason: pipeline === 'MEETING_BOOKED'
      ? 'AGENCIES.current_pipeline_status is MEETING_BOOKED' : 'DEMOS.meeting_booked_at is set' };
  }
  if (anyPermanentOptOut || suppression === 'PERMANENT' || classification === 'OPT_OUT') {
    return { stage: 'OPTED_OUT', reason: 'reply history records permanent opt-out' };
  }
  if (classification === 'NOT_INTERESTED' || pipeline === 'NOT_INTERESTED') {
    return { stage: 'NOT_INTERESTED', reason: classification === 'NOT_INTERESTED'
      ? 'latest reply classification is NOT_INTERESTED' : 'AGENCIES.current_pipeline_status is NOT_INTERESTED' };
  }
  if (['CLOSED', 'EXCLUDED'].includes(pipeline) || upper(agency.suppression_status) === 'SUPPRESSED') {
    return { stage: 'CLOSED', reason: `agency is ${pipeline || 'suppressed'}` };
  }

  // A newer inbound invalidates every earlier waiting state.
  if (latest && (!manualAt || latestInboundAt >= manualAt) && (!followupAt || latestInboundAt >= followupAt)) {
    if (priorNotInterested) return { stage: 'REPLIED_NEEDS_HUMAN', reason: 'new inbound followed a previous NOT_INTERESTED closure; manual review is required before reopening' };
    if (classification === 'POSITIVE_MEETING') return { stage: 'MEETING_INTENT', reason: 'latest reply classification is POSITIVE_MEETING' };
    if (classification === 'POSITIVE_SEND_DEMO' && !sentDemo.sent) return { stage: 'DEMO_REQUESTED', reason: 'latest reply requests the demo and no send is recorded' };
    const positiveAfterExistingDemo = classification === 'POSITIVE_SEND_DEMO' && sentDemo.sent
      && (text(sentDemo.row?.reply_event_id) !== text(latest.reply_event_id)
        || (time(sentDemo.at) !== null && latestInboundAt > time(sentDemo.at)));
    if (['QUESTION', 'OTHER_UNCLEAR', 'NOT_NOW'].includes(classification) || positiveAfterExistingDemo) {
      return { stage: 'REPLIED_NEEDS_HUMAN', reason: classification === 'POSITIVE_SEND_DEMO'
        ? 'prospect replied after/with an already-sent demo; duplicate send is blocked'
        : `latest reply classification is ${classification}` };
    }
  }

  // A due call is considered only after current genuine inbound handling. This
  // is deliberate: a new question/positive/not-now reply must supersede and
  // cancel a no-response call action during reconciliation. Automated OOO
  // events do not create a human-reply stage; action derivation replaces the
  // stale human task with its explicit SYSTEM waiting checkpoint.
  const activeCall = (evidence.actions || []).find((row) =>
    ['CALL_PROSPECT', 'RETRY_CALL'].includes(upper(row.action_type)) && ['PENDING', 'DUE', 'IN_PROGRESS'].includes(upper(row.action_status)));
  if (activeCall && time(activeCall.due_at) !== null && time(activeCall.due_at) <= evidence.nowMs) {
    return { stage: 'CALL_DUE', reason: `${upper(activeCall.action_type)} is due` };
  }

  if (manual && (!latestInboundAt || manualAt > latestInboundAt)) {
    return { stage: 'MANUAL_REPLY_SENT_WAITING', reason: 'latest NOVUS sales message is a manual reply with no newer inbound' };
  }
  if (followup && (!latestInboundAt || followupAt > latestInboundAt)) {
    return { stage: 'DEMO_FOLLOWUP_SENT', reason: 'demo follow-up sent with no newer inbound reply' };
  }

  if (sentDemo.sent) {
    if (text(demo?.cta_clicked_at) || Number(demo?.view_count || 0) >= 2) {
      return { stage: 'DEMO_ENGAGED', reason: text(demo?.cta_clicked_at)
        ? 'DEMOS.cta_clicked_at is set' : 'DEMOS records multiple genuine non-preview views' };
    }
    const viewedAt = time(demo?.first_viewed_at);
    const sentAt = time(sentDemo.at);
    if (viewedAt !== null && (sentAt === null || viewedAt >= sentAt)) {
      return { stage: 'DEMO_OPENED', reason: 'first genuine demo view is at/after the recorded demo send' };
    }
    return { stage: 'DEMO_SENT_UNOPENED', reason: 'demo send is recorded and no post-send genuine view exists' };
  }

  if (outbound) {
    if (text(outbound.instantly_lead_id)) {
      if (upper(outbound.outbound_status) === 'SENT') return { stage: 'SEQUENCE_RUNNING', reason: 'OUTBOUND is SENT and has an Instantly lead id' };
      return { stage: 'WAITING_FOR_FIRST_EMAIL', reason: 'lead is in Instantly but no stored first-email evidence exists' };
    }
    if (upper(outbound.outbound_status) === 'READY') return { stage: 'READY_FOR_OUTREACH', reason: 'OUTBOUND is READY and not handed to Instantly' };
    if (upper(outbound.outbound_status) === 'ERROR') return { stage: 'ERROR', reason: `OUTBOUND error: ${text(outbound.last_error) || 'unspecified'}` };
  }

  if (probe) {
    const status = upper(probe.probe_status);
    if (['OBSERVING', 'ACTIVE'].includes(status)) return { stage: 'PROBE_OBSERVING', reason: `probe observation runs until ${text(probe.observation_deadline) || 'an unknown deadline'}` };
    if (status === 'DRAFT') return { stage: 'PROBE_IN_PROGRESS', reason: 'a draft probe exists and has not been marked sent' };
    if (status === 'CLOSED' || text(probe.observation_closed_at)) {
      if (!evidence.intelligence) return { stage: 'PROBE_COMPLETE', reason: 'probe observation is closed; downstream intelligence is not yet present' };
      if (evidence.outreachReady) return { stage: 'READY_FOR_OUTREACH', reason: 'contact, personalisation and demo evidence are ready' };
      return { stage: 'PREPARING_OUTREACH', reason: evidence.preparationReason || 'probe is complete and downstream preparation is incomplete' };
    }
  }

  if (isEligibleForProbe(agency)) return { stage: 'READY_TO_PROBE', reason: 'agency has an eligible Rightmove sales branch and no probe' };
  return { stage: 'LEAD_POOL', reason: 'agency exists but is not currently eligible to probe' };
}
