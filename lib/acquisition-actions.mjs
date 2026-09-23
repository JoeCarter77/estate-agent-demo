import { ACQUISITION_POLICY, addMs } from './acquisition-policy.mjs';
import { TERMINAL_STAGES, demoSentEvidence, latestInbound, latestSentMessage } from './acquisition-stage.mjs';
import { replyPhoneNumbers, replyCallbackTiming } from './reply-call-context.mjs';
import { normalizePhoneNumber } from './lead-search.mjs';
import { isLockedCampaignType } from './campaign-presets.mjs';
import { resolvePropertyStreet } from './property-reference.mjs';

export const ACTION_OWNERS = Object.freeze(['NOVUS', 'JOE', 'SYSTEM']);
export const ACTION_STATUSES = Object.freeze(['PENDING', 'DUE', 'IN_PROGRESS', 'SNOOZED', 'COMPLETED', 'CANCELLED', 'FAILED']);
export const ACTION_TYPES = Object.freeze([
  'PROBE_AGENCY', 'COMPLETE_PROBE', 'OBSERVATION_CHECKPOINT', 'PREPARE_OUTREACH',
  'HANDOFF_TO_INSTANTLY', 'FIRST_EMAIL_CHECKPOINT', 'SEQUENCE_CHECKPOINT',
  'HUMAN_REPLY', 'MANUAL_REVIEW', 'SEND_DEMO', 'OUT_OF_OFFICE_CHECKPOINT',
  'DEMO_UNOPENED_FOLLOWUP', 'DEMO_OPENED_FOLLOWUP', 'CALL_PROSPECT', 'RETRY_CALL',
  'FOLLOW_UP_CONVERSATION', 'SET_NEXT_STEP', 'RESOLVE_EXCEPTION', 'SORT_LEAD',
  'REPLY', 'FOLLOW_UP', 'CALL', 'EMAIL', 'REVIEW', 'BOOK_MEETING', 'OTHER',
  // Created by the cold-calling workflow (lib/calling-outcomes.mjs) for the
  // non-call follow-ups a call produces. They are ordinary manual sales work.
  'SEND_INFORMATION', 'PREPARE_MEETING', 'MEETING_FOLLOW_UP',
]);

// ACTION QUEUE CLASSIFICATION.
//
// action_owner says WHO does the work. It does NOT say which workspace the
// work belongs in, and conflating the two is what put READY_TO_PROBE agencies
// into "Needs your attention". Joe owns PROBE_AGENCY, but probing is bulk
// queue work with its own Prober surface — it is not a manual sales action on
// a live acquisition conversation.
//
// JOE    = a genuine manual commercial action on a specific lead.
// PROBER = physical probe queue work; belongs to the Prober, never the daily
//          action list.
// SYSTEM = pipeline checkpoints and NOVUS-owned automation.
// Commercially meaningful work with no automated executor belongs here too:
// the demo follow-ups and the Instantly handoff are outbound contact with a
// live lead that only Joe can currently perform.
export const MANUAL_SALES_ACTION_TYPES = Object.freeze([
  'HUMAN_REPLY', 'MANUAL_REVIEW', 'CALL_PROSPECT', 'RETRY_CALL',
  'FOLLOW_UP_CONVERSATION', 'SET_NEXT_STEP', 'RESOLVE_EXCEPTION',
  'DEMO_UNOPENED_FOLLOWUP', 'DEMO_OPENED_FOLLOWUP', 'HANDOFF_TO_INSTANTLY',
  'REPLY', 'FOLLOW_UP', 'CALL', 'EMAIL', 'REVIEW', 'BOOK_MEETING', 'OTHER',
  'SEND_INFORMATION', 'PREPARE_MEETING', 'MEETING_FOLLOW_UP',
]);
export const PROBE_QUEUE_ACTION_TYPES = Object.freeze(['PROBE_AGENCY', 'COMPLETE_PROBE']);
// CALLING = phone work scheduled BY the calling workflow: no-answer retries,
// gatekept retries, requested callbacks. It is the Call Actions tab's queue.
// It is deliberately NOT the generic Actions list — a day of callbacks would
// otherwise bury the replies and reviews that list exists for. The marker is
// metadata_json.call_action=true, written by lib/calling-outcomes.mjs; the
// engine-derived CALL_PROSPECT/RETRY_CALL rows (demo engagement, the legacy
// drawer outcome) carry no marker and stay in Joe's manual queue, though the
// calling queue still picks them up as "other due call actions".
export const CALL_ACTION_TYPES = Object.freeze(['CALL_PROSPECT', 'RETRY_CALL', 'CALL']);
export function isCallingWorkflowAction(action) {
  try { return JSON.parse(String(action?.metadata_json ?? '').trim() || '{}').call_action === true; } catch { return false; }
}
// Lead-pool housekeeping: a lead that genuinely cannot progress yet (no
// usable outreach email, no eligible probe path, ...) and needs a human
// decision before it can, but is NOT a commercial acquisition action on a
// live conversation. It gets its own queue so it never inflates Actions/All
// or the sidebar Actions badge alongside genuine replies/calls/reviews.
export const SORT_LEAD_ACTION_TYPES = Object.freeze(['SORT_LEAD']);

// EXECUTION AUTHORITY REGISTRY.
//
// NOVUS decides WHAT should happen next for every lead in the system. That is
// not the same permission as being allowed to DO it. Until an action type has
// a deliberately enabled, tested executor running in production, NOVUS must
// not be recorded as its execution owner — otherwise the Command Centre shows
// a commercially meaningful action as "handled" while nothing is handling it,
// and the action disappears from both the Actions queue and Future actions.
// That is exactly how a live demo follow-up went silently unowned.
//
// executor:
//   'ENABLED' - a real automated execution path exists in production TODAY.
//               Name it. If you cannot name the code that fires it, it is
//               'NONE'.
//   'NONE'    - nothing executes this automatically. A human does.
// commercial:
//   true  - executing it (or failing to) materially affects a live lead:
//           anything that reaches the prospect, or that decides whether they
//           are contacted at all.
//   false - internal pipeline preparation that never touches the prospect.
//
// Only 'ENABLED' entitles NOVUS to own execution. Everything else falls back:
// commercial work becomes Joe's manual work, internal work stays a SYSTEM
// pipeline state. NOVUS remains the recommender in both cases.
export const ACTION_EXECUTION_REGISTRY = Object.freeze({
  // The one genuinely automated commercial send: a POSITIVE_SEND_DEMO reply
  // classified by a live poll pass is executed immediately by runAutoSendDemo()
  // in api/novus/personalisation.js, through executeSendDemo() in
  // lib/reply-send-demo.mjs, behind the same gate as the manual send route.
  SEND_DEMO: { executor: 'ENABLED', via: 'runAutoSendDemo -> executeSendDemo', commercial: true },
  // No executor anywhere in the codebase. Nothing composes, schedules or sends
  // a demo follow-up; the action was NOVUS-owned in name only.
  DEMO_UNOPENED_FOLLOWUP: { executor: 'NONE', commercial: true },
  DEMO_OPENED_FOLLOWUP: { executor: 'NONE', commercial: true },
  // Handoff is cold outbound. Its only execution path is the operator CLI
  // scripts/instantly-outbound.mjs, which requires Joe to type an explicit
  // confirmation phrase. A human-gated CLI is manual execution, not automation.
  HANDOFF_TO_INSTANTLY: { executor: 'NONE', commercial: true },
  // Deterministic downstream preparation (demo build, outbound row). It never
  // contacts the prospect, so it cannot materially affect a live lead — but no
  // scheduler runs it either, so it is not NOVUS-owned execution.
  PREPARE_OUTREACH: { executor: 'NONE', commercial: false },
});

export function hasEnabledExecutor(actionType) {
  return ACTION_EXECUTION_REGISTRY[upper(actionType)]?.executor === 'ENABLED';
}

// THE OWNERSHIP RULE, in one place. Every derived action and every stored
// action row is read through this, so a legacy row written before the rule
// existed cannot keep an owner the rule no longer permits.
export function resolveExecutionOwner(actionType, proposedOwner) {
  const owner = upper(proposedOwner);
  if (owner !== 'NOVUS') return owner || 'JOE';
  if (hasEnabledExecutor(actionType)) return 'NOVUS';
  return ACTION_EXECUTION_REGISTRY[upper(actionType)]?.commercial === false ? 'SYSTEM' : 'JOE';
}

export function effectiveActionOwner(action) {
  return resolveExecutionOwner(action?.action_type, action?.action_owner);
}

// NOVUS derives every action in the ledger, so it is always the recommender —
// including the ones it is not allowed to execute.
export const ACTION_RECOMMENDER = 'NOVUS';
export const ACTIVE_ACTION_STATUSES = Object.freeze(['PENDING', 'DUE', 'IN_PROGRESS']);

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();
const at = (value) => Number.isFinite(Date.parse(text(value))) ? Date.parse(text(value)) : null;

export function isActiveAction(action) {
  const status = upper(action?.action_status);
  if (status === 'SNOOZED') return at(action?.due_at) !== null && at(action.due_at) <= Date.now();
  return ACTIVE_ACTION_STATUSES.includes(status);
}

export function actionQueue(action) {
  if (!action) return null;
  const type = upper(action.action_type);
  if (PROBE_QUEUE_ACTION_TYPES.includes(type)) return 'PROBER';
  if (SORT_LEAD_ACTION_TYPES.includes(type)) return 'SORT';
  if (CALL_ACTION_TYPES.includes(type) && isCallingWorkflowAction(action)) return 'CALLING';
  // effectiveActionOwner, not the stored column: a persisted NOVUS-owned demo
  // follow-up must land in Joe's queue without waiting for a ledger rewrite.
  if (effectiveActionOwner(action) === 'JOE' && MANUAL_SALES_ACTION_TYPES.includes(type)) return 'JOE';
  return 'SYSTEM';
}

// The single predicate behind "Needs your attention". A RESOLVE_EXCEPTION that
// NOVUS owns is not Joe's, and a JOE-owned PROBE_AGENCY is not a sales action.
export function isManualSalesAction(action) {
  return Boolean(action) && actionQueue(action) === 'JOE' && isActiveAction(action);
}

// The single predicate behind the Sort leads queue. Deliberately separate from
// isManualSalesAction: lead-pool housekeeping needs a human decision same as a
// manual sales action does, but it is not commercial acquisition work on a
// live conversation and must never count toward it.
export function isSortLeadAction(action) {
  return Boolean(action) && actionQueue(action) === 'SORT' && isActiveAction(action);
}

// OOO FOLLOW-UP SCHEDULING. An automated out-of-office reply must not be
// dropped just because it needs no reply right now (Instantly stops the
// sequence on any reply, so silence here is silence forever). We try to read
// a genuine return date out of the auto-reply text; when one is found the
// follow-up is scheduled for the next business day after it, otherwise it
// defaults to policy.oooFollowUpFallbackMs (7 days) from the reply.
const OOO_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export function extractOooReturnDateMs(bodyText, referenceMs) {
  const body = text(bodyText);
  if (!body) return null;
  const iso = body.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const ms = Date.parse(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00.000Z`);
    if (Number.isFinite(ms)) return ms;
  }
  const monthPattern = OOO_MONTHS.join('|');
  const dayMonth = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthPattern})\\s*(\\d{4})?\\b`, 'i');
  const monthDay = new RegExp(`\\b(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})?\\b`, 'i');
  let day; let monthName; let year;
  const dm = body.match(dayMonth);
  if (dm) { [, day, monthName, year] = dm; } else {
    const md = body.match(monthDay);
    if (md) { [, monthName, day, year] = md; }
  }
  if (!monthName) return null;
  const monthIdx = OOO_MONTHS.indexOf(monthName.toLowerCase());
  if (monthIdx < 0) return null;
  const ref = Number.isFinite(referenceMs) ? referenceMs : Date.now();
  const refYear = new Date(ref).getUTCFullYear();
  let ms = Date.UTC(refYear, monthIdx, Number(day));
  // No explicit year and the date already looks like it is in the past
  // relative to the reply (e.g. reply arrives in December about a January
  // return): it means next year, not last year.
  if (!year && ms < ref - 24 * 60 * 60 * 1000) ms = Date.UTC(refYear + 1, monthIdx, Number(day));
  else if (year) ms = Date.UTC(Number(year), monthIdx, Number(day));
  return Number.isFinite(ms) ? ms : null;
}

export function nextBusinessDayAfterMs(ms) {
  const d = new Date(ms);
  d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

function expected(evidence, stage, actionType, owner, dueAt, reason, anchor = '') {
  const agencyId = text(evidence.agency?.agency_id);
  return {
    agency_id: agencyId,
    outreach_id: text(evidence.outbound?.outbound_id),
    probe_id: text(evidence.probe?.probe_id),
    reply_event_id: text(latestInbound(evidence)?.reply_event_id),
    action_type: actionType,
    action_owner: resolveExecutionOwner(actionType, owner),
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
    // No current action, no manual review, no send: Instantly has already
    // stopped the sequence on this reply, so the only job left is a future
    // reminder so the lead is not silently lost.
    const returnDateMs = extractOooReturnDateMs(latest?.body_text, latestInboundAt);
    const dueAt = returnDateMs !== null ? nextBusinessDayAfterMs(returnDateMs) : addMs(inboundAt, policy.oooFollowUpFallbackMs);
    const reason = returnDateMs !== null
      ? 'Automated out-of-office reply gave a return date; follow up the next business day after they are back'
      : 'Automated out-of-office reply with no clear return date; default 7-day follow-up so the lead is not lost';
    return [expected(evidence, stage, 'FOLLOW_UP', 'JOE', dueAt, reason, anchor)];
  }
  const sticky = (evidence.actions || []).find((row) => {
    if (!['PENDING', 'DUE', 'IN_PROGRESS'].includes(upper(row.action_status))) return false;
    try {
      const metadata = JSON.parse(text(row.metadata_json) || '{}');
      return Boolean(metadata.parent_action_id) && (latestInboundAt === null || latestInboundAt <= (at(row.created_at) ?? Infinity));
    } catch { return false; }
  });
  if (sticky) return [{ ...sticky, action_owner: effectiveActionOwner(sticky), action_status: at(sticky.due_at) !== null && at(sticky.due_at) <= evidence.nowMs ? 'DUE' : upper(sticky.action_status) }];

  switch (stage) {
    case 'READY_TO_PROBE': return [expected(evidence, stage, 'PROBE_AGENCY', 'JOE', now, 'Agency is eligible and has not been probed', anchor)];
    case 'PROBE_IN_PROGRESS': return [expected(evidence, stage, 'COMPLETE_PROBE', 'JOE', now, 'Draft probe must be submitted and marked sent', anchor)];
    case 'PROBE_OBSERVING': return [expected(evidence, stage, 'OBSERVATION_CHECKPOINT', 'SYSTEM', text(evidence.probe?.observation_deadline), 'Existing four-day observation window is running', anchor)];
    case 'PROBE_COMPLETE':
    case 'PREPARING_OUTREACH': return [expected(evidence, stage, 'PREPARE_OUTREACH', 'NOVUS', now, evidence.preparationReason || 'Complete deterministic downstream preparation', anchor)];
    case 'READY_FOR_OUTREACH': return [expected(evidence, stage, 'HANDOFF_TO_INSTANTLY', 'NOVUS', now, 'Outbound record is ready for existing Instantly handoff', anchor)];
    case 'WAITING_FOR_FIRST_EMAIL': return [expected(evidence, stage, 'FIRST_EMAIL_CHECKPOINT', 'SYSTEM', addMs(evidence.outbound?.instantly_added_at || evidence.outbound?.updated_at, policy.firstEmailCheckpointMs), 'Lead is handed to Instantly and no campaign email has been sent yet', anchor)];
    // An executed sequence step is the same SYSTEM checkpoint at every step, so
    // one lead moving from email 1 to follow-up 1 updates its existing row
    // rather than churning the ledger. The checkpoint now hangs off the LAST
    // OBSERVED SEND — the real clock for "is this sequence still moving" —
    // falling back to the handoff timestamp when execution state is absent.
    case 'EMAIL_1_SENT':
    case 'FOLLOWUP_1_SENT':
    case 'FOLLOWUP_2_SENT':
    case 'SEQUENCE_RUNNING': return [expected(evidence, stage, 'SEQUENCE_CHECKPOINT', 'SYSTEM', addMs(evidence.execution?.last_email_sent_at || evidence.outbound?.instantly_added_at || evidence.outbound?.updated_at, policy.sequenceCheckpointMs), 'Instantly sequence is handling this lead', anchor)];
    case 'MEETING_INTENT':
    case 'REPLIED_NEEDS_HUMAN': {
      if (upper(latest?.classification) === 'CALL_REQUESTED' && stage === 'MEETING_INTENT') {
        const handledByManualCall = (evidence.actions || []).find((row) => {
          if (!['CALL_PROSPECT', 'RETRY_CALL', 'CALL'].includes(upper(row.action_type))
              || !['PENDING', 'DUE', 'IN_PROGRESS', 'SNOOZED'].includes(upper(row.action_status))) return false;
          if (text(row.outreach_id) && text(row.outreach_id) !== text(latest?.outreach_id)) return false;
          try { return JSON.parse(text(row.metadata_json) || '{}').manual === true && at(row.created_at) !== null && at(row.created_at) >= (latestInboundAt ?? Infinity); }
          catch { return false; }
        });
        if (handledByManualCall) return [{ ...handledByManualCall, action_owner: effectiveActionOwner(handledByManualCall) }];
        const body = text(latest?.cleaned_reply_text || latest?.body_text);
        const phones = replyPhoneNumbers(text(latest?.body_text || body));
        const timing = replyCallbackTiming(body, inboundAt, now);
        const sameEmail = (evidence.contacts || []).filter((contact) =>
          text(contact.email).toLowerCase() === text(latest?.lead_email).toLowerCase());
        const contact = sameEmail.length === 1 ? sameEmail[0] : null;
        let replyNotes = {};
        try { replyNotes = JSON.parse(text(latest?.notes) || '{}'); } catch { /* unmatched notes use another shape */ }
        const probeCall = isLockedCampaignType(replyNotes.source_campaign_type);
        const verifiedContactNumber = contact && Object.entries(contact).find(([key, value]) =>
          /^(?:mobile|phone|telephone|phone_number|mobile_number)$/.test(key)
          && normalizePhoneNumber(value)
          && (upper(contact.phone_verified) === 'TRUE' || upper(contact.phone_verification_status) === 'VERIFIED'));
        const storedPhone = phones.length === 1 ? phones[0] : verifiedContactNumber
          ? { raw: text(verifiedContactNumber[1]), normalised: normalizePhoneNumber(verifiedContactNumber[1]), source: 'VERIFIED_CONTACT' } : null;
        const needsReview = phones.length > 1 || timing.needs_review || sameEmail.length > 1 || (probeCall && !storedPhone);
        const action = expected(evidence, stage, 'CALL_PROSPECT', 'JOE', timing.due_at || now,
          probeCall && !storedPhone ? 'CRITICAL: owner accepted a call — obtain a callback number' :
            needsReview ? 'CRITICAL: owner requested a call — check number or timing before dialling' : 'CRITICAL: owner requested a call by email', anchor);
        const sourceOutbound = [evidence.outbound, ...(evidence.otherOutbound || [])]
          .find((row) => text(row?.outbound_id) === text(latest?.outreach_id));
        if (text(latest?.outreach_id)) action.outreach_id = text(latest.outreach_id);
        if (replyNotes.probe_id || sourceOutbound?.probe_id) action.probe_id = text(replyNotes.probe_id || sourceOutbound.probe_id);
        const sourceProbe = (evidence.probes || []).find((row) => text(row.probe_id) === text(action.probe_id)) || evidence.probe;
        action.metadata_json = JSON.stringify({
          call_action: true, source: 'EMAIL_REPLY', priority: 'CRITICAL', reply_event_id: text(latest?.reply_event_id),
          phone: storedPhone, phone_candidates: phones, requires_contact_number: probeCall, number_required: probeCall && !storedPhone,
          contact_id: text(contact?.contact_id), contact_name: text(contact?.contact_name),
          contact_candidates: sameEmail.length > 1 ? sameEmail.map((row) => ({ contact_id: text(row.contact_id), contact_name: text(row.contact_name) })) : [],
          timing, needs_review: needsReview, reply_text: body, original_reply: text(latest?.body_text), campaign_id: text(latest?.campaign_id), campaign_name: text(replyNotes.source_campaign_name), campaign_type: text(replyNotes.source_campaign_type),
          probe_reference: text(sourceProbe?.probe_reference), property: resolvePropertyStreet(sourceProbe), probe_context: text(evidence.intelligence?.grade_reason || sourceProbe?.enquiry_text),
          reply_received_at: inboundAt,
          previous_novus_message: text(replyNotes.previous_novus_message),
        });
        return [action];
      }
      const type = upper(latest?.classification) === 'OTHER_UNCLEAR' || /previous NOT_INTERESTED/i.test(evidence.stageReason) ? 'MANUAL_REVIEW'
        : upper(latest?.classification) === 'NOT_NOW' ? 'SET_NEXT_STEP'
          : upper(latest?.classification) === 'INFO_REQUESTED' ? 'SEND_INFORMATION' : 'HUMAN_REPLY';
      const timing = type === 'SET_NEXT_STEP' ? replyCallbackTiming(text(latest?.cleaned_reply_text || latest?.body_text), inboundAt, now) : null;
      const action = expected(evidence, stage, type, 'JOE', timing?.due_at || inboundAt || now, evidence.stageReason, anchor);
      if (timing) action.metadata_json = JSON.stringify({ timing, reply_event_id: text(latest?.reply_event_id) });
      // A clear expression of interest is a HIGH-priority reply for Joe, with
      // the reply itself carried on the action. Nothing is sent from here.
      if (['POSITIVE_INTEREST', 'INFO_REQUESTED'].includes(upper(latest?.classification)) && type !== 'MANUAL_REVIEW') {
        let replyNotes = {};
        try { replyNotes = JSON.parse(text(latest?.notes) || '{}'); } catch { /* unmatched notes use another shape */ }
        action.metadata_json = JSON.stringify({
          priority: 'HIGH', interested: true, reply_event_id: text(latest?.reply_event_id),
          reply_text: text(latest?.cleaned_reply_text || latest?.body_text), original_reply: text(latest?.body_text),
          reply_received_at: inboundAt, reply_subject: text(latest?.subject),
          campaign_id: text(latest?.campaign_id), campaign_name: text(replyNotes.source_campaign_name), campaign_type: text(replyNotes.source_campaign_type),
        });
      }
      return [action];
    }
    case 'DEMO_REQUESTED': return [expected(evidence, stage, 'SEND_DEMO', 'NOVUS', inboundAt || now, 'Positive reply requested demo; existing SEND_DEMO gates must pass', anchor)];
    case 'DEMO_SENT_UNOPENED': return [expected(evidence, stage, 'DEMO_UNOPENED_FOLLOWUP', 'NOVUS', addMs(sentDemo.at, policy.demoUnopenedFollowupMs), 'Demo sent and not genuinely opened; no newer inbound reply', sentDemo.at)];
    case 'DEMO_OPENED': return [expected(evidence, stage, 'DEMO_OPENED_FOLLOWUP', 'NOVUS', addMs(lastViewed, policy.demoOpenedFollowupMs), 'Demo genuinely opened; no newer inbound reply or meeting', lastViewed)];
    case 'DEMO_ENGAGED': return [expected(evidence, stage, 'CALL_PROSPECT', 'JOE', text(evidence.demo?.cta_clicked_at) || now, 'Strong demo engagement (CTA click or repeat views)', text(evidence.demo?.cta_clicked_at || lastViewed))];
    case 'DEMO_FOLLOWUP_SENT': return [expected(evidence, stage, 'CALL_PROSPECT', 'JOE', addMs(followup?.sent_at || followup?.created_at, policy.afterDemoFollowupCallMs), 'Demo follow-up received no newer inbound reply', text(followup?.sales_message_id))];
    case 'MANUAL_REPLY_SENT_WAITING': return [expected(evidence, stage, 'FOLLOW_UP_CONVERSATION', 'JOE', addMs(manual?.sent_at || manual?.created_at, policy.afterManualReplyFollowupMs), 'Manual reply received no newer inbound reply', text(manual?.sales_message_id))];
    case 'CALL_DUE': {
      const call = (evidence.actions || []).find((row) => ['CALL_PROSPECT', 'RETRY_CALL'].includes(upper(row.action_type)) && ['PENDING', 'DUE', 'IN_PROGRESS'].includes(upper(row.action_status)));
      return call ? [{ ...call, action_owner: effectiveActionOwner(call), action_status: 'DUE' }] : [];
    }
    case 'ERROR': return [expected(evidence, stage, 'RESOLVE_EXCEPTION', 'JOE', now, evidence.stageReason || 'Acquisition state error', anchor)];
    // LEAD_POOL is "not yet eligible to progress", not a commercial exception
    // on a live conversation — see lib/acquisition-stage.mjs's
    // leadPoolBlockReason() for the specific blocker. It belongs in Sort
    // leads, never in the manual sales Actions queue.
    case 'LEAD_POOL': return [expected(evidence, stage, 'SORT_LEAD', 'JOE', now, evidence.stageReason || 'Agency is not currently eligible to progress', anchor)];
    default: return [];
  }
}

export function reconcileActions(existing, expectedRows, now = new Date().toISOString()) {
  const active = new Map((existing || []).filter((row) => ['PENDING', 'DUE', 'IN_PROGRESS', 'SNOOZED'].includes(upper(row.action_status)))
    .map((row) => [text(row.dedupe_key), row]));
  const completed = new Set((existing || []).filter((row) => upper(row.action_status) === 'COMPLETED').map((row) => text(row.dedupe_key)));
  const wanted = new Map((expectedRows || []).map((row) => [text(row.dedupe_key), row]));
  const requestedCall = (expectedRows || []).find((row) => {
    try { return JSON.parse(text(row.metadata_json) || '{}').source === 'EMAIL_REPLY' && upper(row.action_type) === 'CALL_PROSPECT'; }
    catch { return false; }
  });
  let requestedCallMeta = {};
  try { requestedCallMeta = JSON.parse(text(requestedCall?.metadata_json) || '{}'); } catch { /* no source */ }
  const create = [];
  const update = [];
  const cancel = [];

  for (const [key, row] of wanted) {
    const found = active.get(key);
    if (!found && !completed.has(key)) create.push(row);
    else {
      if (!found) continue;
      let reviewedEmailCall = false;
      try { const meta = JSON.parse(text(found.metadata_json) || '{}'); reviewedEmailCall = meta.source === 'EMAIL_REPLY' && meta.reviewed === true; } catch { /* use derived values */ }
      const status = at(row.due_at) !== null && at(row.due_at) <= Date.parse(now) && upper(found.action_status) === 'PENDING'
        ? 'DUE' : upper(found.action_status) === 'SNOOZED' && at(found.due_at) !== null && at(found.due_at) <= Date.parse(now)
          ? 'DUE' : upper(found.action_status);
      // Ownership is reconciled like any other derived field. Rows written
      // before an action type lost (or gained) an enabled executor are
      // rewritten to the owner the registry now permits, so the durable ledger
      // converges on the rule instead of only the read path correcting it.
      const owner = resolveExecutionOwner(row.action_type, row.action_owner);
      const dueAt = reviewedEmailCall ? found.due_at : row.due_at;
      const reason = reviewedEmailCall ? found.reason : row.reason;
      const metadata = reviewedEmailCall ? found.metadata_json : row.metadata_json;
      if (status !== upper(found.action_status) || text(found.due_at) !== text(dueAt)
          || text(found.reason) !== text(reason) || upper(found.action_owner) !== owner || text(found.metadata_json) !== text(metadata)) {
        update.push({ action_id: found.action_id, patch: { due_at: dueAt, reason, metadata_json: metadata, action_owner: owner, action_status: status, updated_at: now } });
      }
    }
  }
  for (const [key, row] of active) {
    let manual = false;
    try { manual = JSON.parse(text(row.metadata_json) || '{}').manual === true; } catch { manual = false; }
    const supersededByCall = requestedCall && ['HUMAN_REPLY', 'FOLLOW_UP_CONVERSATION', 'SET_NEXT_STEP', 'FOLLOW_UP', 'CALL_PROSPECT', 'RETRY_CALL'].includes(upper(row.action_type))
      && (!text(row.outreach_id) || text(row.outreach_id) === text(requestedCall.outreach_id))
      && at(row.created_at) !== null && at(requestedCallMeta.reply_received_at) !== null
      && at(row.created_at) <= at(requestedCallMeta.reply_received_at);
    if (!wanted.has(key) && (!manual || supersededByCall)) cancel.push({ action_id: row.action_id, patch: {
      action_status: 'CANCELLED', cancelled_at: now, updated_at: now,
      completion_reason: 'Lifecycle evidence changed; stale action cancelled',
    }});
  }
  return { create, update, cancel };
}
