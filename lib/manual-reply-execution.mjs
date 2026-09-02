// Phase 3B live execution for one human-authored reply.
//
// Ordering is deliberate and irreversible-action aware:
// fresh reads + gate -> KV claim -> Instantly POST -> SALES_MESSAGES append ->
// REPLY_EVENTS execution completion. SENT and AMBIGUOUS claims are held to
// expiry; only a definite 4xx REJECTED result releases its claim.

import {
  manualReplyClaimKey,
  normalizeManualReplyBody,
} from './manual-reply.mjs';
import { evaluateManualReplyRequest } from './manual-reply-context.mjs';
import {
  buildInstantlyReplyPayload,
  sendInstantlyReply,
  safeDetail,
  SEND_TIMEOUT_MS,
  AMBIGUOUS_ERROR,
} from './instantly-reply-send.mjs';
import {
  getClaimStore,
  SEND_CLAIM_TTL_SECONDS,
} from './reply-claim.mjs';
import {
  appendSalesMessage,
  newSalesMessageId,
  resolveThreadContinuity,
} from './sales-messages.mjs';
import { updateReplyEventExecution } from './reply-router.mjs';

export const MANUAL_REPLY_LIVE_CONFIRMATION = 'SEND_ONE_MANUAL_REPLY';

function text(value) { return String(value ?? '').trim(); }

export function buildManualReplySentNote(existingNotes, {
  instantlyEmailId = '', threadId = '', at = '',
} = {}) {
  const note = `MANUAL_REPLY sent at=${text(at)} instantly_email_id=${text(instantlyEmailId) || 'unknown'} thread_id=${text(threadId) || 'unknown'}`;
  const existing = text(existingNotes);
  return existing ? `${existing}\n${note}` : note;
}

export function buildManualSalesMessage({
  gate,
  replyEvent,
  sendResult,
  now,
  salesMessageId = newSalesMessageId(),
} = {}) {
  const outcome = text(sendResult?.outcome).toUpperCase();
  if (!['SENT', 'AMBIGUOUS'].includes(outcome)) {
    throw new Error(`manual sales message cannot record outcome ${outcome || '(blank)'}`);
  }
  const returnedThreadId = text(sendResult?.response?.thread_id);
  return {
    sales_message_id: salesMessageId,
    outreach_id: gate.resolved.outreach_id,
    agency_id: gate.resolved.agency_id,
    reply_event_id: gate.resolved.reply_event_id,
    direction: 'OUTBOUND',
    message_type: 'MANUAL_REPLY',
    eaccount: gate.resolved.eaccount,
    in_reply_to_email_id: gate.resolved.reply_to_uuid,
    instantly_email_id: text(sendResult?.response?.id),
    instantly_thread_id: returnedThreadId,
    instantly_message_id: text(sendResult?.response?.message_id),
    thread_continuity: resolveThreadContinuity(gate.resolved.thread_id, returnedThreadId),
    subject: gate.resolved.subject,
    body_text: gate.body.text,
    send_outcome: outcome,
    instantly_status: sendResult?.status == null ? '' : String(sendResult.status),
    error: text(sendResult?.error),
    sent_by: 'joe',
    sent_at: outcome === 'SENT' ? text(now) : '',
    created_at: text(now),
  };
}

function blockedBase(id, gate, inputs) {
  return {
    dry_run: false,
    sent: false,
    eligible: gate.eligible,
    would_send: gate.would_send,
    blocked_reason: gate.blocked_reason,
    blocked_reasons: gate.blocked_reasons,
    send_outcome: null,
    instantly_status: null,
    instantly_response: null,
    error: null,
    action_status: text(inputs.replyEvent?.action_status) || 'PENDING',
    action_completed_at: '',
    target: {
      agency_id: gate.resolved.agency_id,
      prospect_email: inputs.leadEmail,
      sending_inbox: gate.resolved.eaccount,
      reply_event_id: gate.resolved.reply_event_id || id,
      outreach_id: gate.resolved.outreach_id,
      thread_id: gate.resolved.thread_id,
      received_at: gate.received_at || '',
    },
    newest_reply_event_id: gate.newest_reply_event_id || '',
    newest_received_at: gate.newest_received_at || '',
    sales_message: null,
    sales_message_append: null,
    persistence_error: null,
    action_update: null,
    action_update_error: null,
    thread_continuity: null,
    claim_acquired: false,
    claim_released: false,
    claim_error: null,
    warnings: inputs.warnings || [],
  };
}

export async function executeManualReply({
  repo,
  replyEventId,
  body,
  expectedReceivedAt = '',
  apiKey,
  fetchImpl = globalThis.fetch,
  sendImpl = sendInstantlyReply,
  claimStore = null,
  appendImpl = appendSalesMessage,
  updateImpl = updateReplyEventExecution,
  now = new Date().toISOString(),
  timeoutMs = SEND_TIMEOUT_MS,
  mailboxes,
} = {}) {
  const id = text(replyEventId);
  if (!id) throw new Error('reply_event_id is required');
  const replyText = normalizeManualReplyBody(body).trim();

  const { inputs, gate } = await evaluateManualReplyRequest({
    repo,
    replyEventId: id,
    body: replyText,
    expectedReceivedAt,
    apiKey,
    fetchImpl,
    mailboxes,
  });
  const base = blockedBase(id, gate, inputs);
  if (!inputs.record) {
    return {
      ...base,
      eligible: false,
      blocked_reason: 'REPLY_EVENT_NOT_FOUND',
      blocked_reasons: ['REPLY_EVENT_NOT_FOUND'],
    };
  }
  if (!gate.eligible) return base;

  let store = claimStore;
  if (!store) {
    try {
      store = getClaimStore();
    } catch (err) {
      return {
        ...base,
        eligible: false,
        would_send: false,
        blocked_reason: 'CLAIM_STORE_UNAVAILABLE',
        blocked_reasons: ['CLAIM_STORE_UNAVAILABLE'],
        claim_error: safeDetail(err?.message || 'claim store unavailable'),
      };
    }
  }

  const claimKey = manualReplyClaimKey({
    instantlyEmailId: gate.resolved.reply_to_uuid,
    body: gate.body.text,
  });
  const claim = await store.acquire(claimKey, SEND_CLAIM_TTL_SECONDS);
  if (!claim.acquired) {
    const unavailable = Boolean(claim.error);
    return {
      ...base,
      eligible: false,
      would_send: false,
      blocked_reason: unavailable ? 'CLAIM_STORE_UNAVAILABLE' : 'DUPLICATE_MANUAL_REPLY',
      blocked_reasons: [unavailable ? 'CLAIM_STORE_UNAVAILABLE' : 'DUPLICATE_MANUAL_REPLY'],
      claim_error: claim.error || null,
    };
  }

  const payload = buildInstantlyReplyPayload({
    replyToUuid: gate.resolved.reply_to_uuid,
    eaccount: gate.resolved.eaccount,
    subject: inputs.replyEvent.subject,
    body: gate.body,
  });

  let sendResult;
  try {
    sendResult = await sendImpl({ apiKey, payload, fetchImpl, timeoutMs });
  } catch (err) {
    // A throw after the transport was invoked is uncertainty, never a safe
    // rejection. Hold the claim and persist the ambiguity.
    sendResult = {
      outcome: 'AMBIGUOUS',
      status: null,
      response: null,
      error: `${AMBIGUOUS_ERROR}: transport ${safeDetail(err?.message || 'unknown error')}`,
    };
  }

  let claimReleased = false;
  let claimReleaseError = null;
  if (sendResult.outcome === 'REJECTED') {
    try {
      claimReleased = await store.release(claimKey, claim.token);
    } catch (err) {
      claimReleaseError = safeDetail(err?.message || 'claim release failed');
    }
    return {
      ...base,
      eligible: true,
      would_send: true,
      send_outcome: 'REJECTED',
      instantly_status: sendResult.status,
      error: sendResult.error,
      action_status: 'PENDING',
      claim_acquired: true,
      claim_released: claimReleased,
      claim_release_error: claimReleaseError,
    };
  }

  const salesMessage = buildManualSalesMessage({
    gate, replyEvent: inputs.replyEvent, sendResult, now,
  });
  let salesMessageAppend = null;
  let persistenceError = null;
  try {
    salesMessageAppend = await appendImpl(repo, salesMessage);
  } catch (err) {
    persistenceError = safeDetail(err?.message || 'SALES_MESSAGES append failed');
  }

  const common = {
    ...base,
    eligible: true,
    would_send: true,
    sent: sendResult.outcome === 'SENT',
    send_outcome: sendResult.outcome,
    instantly_status: sendResult.status,
    instantly_response: sendResult.response,
    error: sendResult.error,
    action_status: sendResult.outcome === 'SENT' && !persistenceError ? 'COMPLETED' : 'PENDING',
    sales_message: salesMessage,
    sales_message_append: salesMessageAppend,
    persistence_error: persistenceError,
    thread_continuity: salesMessage.thread_continuity,
    claim_acquired: true,
    claim_released: false,
    claim_release_error: null,
  };

  // AMBIGUOUS is durably recorded but never completes the human action.
  if (sendResult.outcome === 'AMBIGUOUS') return common;

  // A confirmed send whose audit append failed is irreversible. Stop here,
  // hold the claim, and do not falsely complete the action without its durable
  // sent-message record.
  if (persistenceError) return common;

  const patch = {
    action_status: 'COMPLETED',
    action_completed_at: text(now),
    error: '',
    notes: buildManualReplySentNote(inputs.replyEvent.notes, {
      instantlyEmailId: sendResult.response?.id || gate.resolved.reply_to_uuid,
      threadId: sendResult.response?.thread_id || gate.resolved.thread_id,
      at: now,
    }),
  };
  let actionUpdate = null;
  let actionUpdateError = null;
  try {
    actionUpdate = await updateImpl(id, patch, { repo, dryRun: false });
    if (!actionUpdate?.updated) {
      actionUpdateError = `REPLY_EVENTS completion was not applied (${actionUpdate?.skipped || 'unknown reason'})`;
    }
  } catch (err) {
    actionUpdateError = safeDetail(err?.message || 'REPLY_EVENTS completion failed');
  }

  return {
    ...common,
    action_status: actionUpdateError ? 'PENDING' : 'COMPLETED',
    action_completed_at: actionUpdateError ? '' : text(now),
    action_update: actionUpdate,
    action_update_error: actionUpdateError,
  };
}
