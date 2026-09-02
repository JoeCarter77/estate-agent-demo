// Fresh, server-side input gathering shared by the manual-reply dry run and
// live execution. This module reads only: REPLY_EVENTS, OUTBOUND, and one
// lead-scoped Instantly conversation. It sends and writes nothing.

import { fetchLeadConversation } from './instantly-conversation.mjs';
import { evaluateManualReplyGate } from './manual-reply.mjs';
import { novusMailboxes } from './reply-router.mjs';

function text(value) { return String(value ?? '').trim(); }

export async function gatherManualReplyInputs({
  repo,
  replyEventId,
  apiKey,
  fetchImpl = globalThis.fetch,
  mailboxes = novusMailboxes(),
} = {}) {
  const id = text(replyEventId);
  if (!id) throw new Error('reply_event_id is required');
  if (!repo) throw new Error('manual reply requires a repo');

  const record = await repo.findById('REPLY_EVENTS', 'reply_event_id', id);
  if (!record) {
    return {
      record: null, replyEvent: null, outreachReplyEvents: [], outboundRecords: [],
      liveMessages: [], liveParent: null, leadEmail: '', instantlyAvailable: false,
      instantlyError: null, warnings: [], mailboxes,
    };
  }

  const replyEvent = record.obj;
  const outreachId = text(replyEvent.outreach_id);
  const warnings = [];
  const [allReplies, outboundRecords] = await Promise.all([
    repo.getRecords('REPLY_EVENTS', 'reply_event_id'),
    repo.getRecords('OUTBOUND', 'outbound_id'),
  ]);
  const outreachReplyEvents = outreachId
    ? allReplies.map((item) => item.obj).filter((obj) => text(obj.outreach_id) === outreachId)
    : null;
  if (!outreachReplyEvents) {
    warnings.push({
      code: 'no_outreach_id',
      detail: 'This reply carries no outreach_id, so its journey history could not be loaded',
    });
  }

  const outboundRow = outboundRecords
    .map((item) => item.obj)
    .find((obj) => outreachId && text(obj.outbound_id) === outreachId) || null;
  const leadEmail = text(outboundRow?.outreach_contact_email) || text(replyEvent.lead_email);

  let liveMessages = [];
  let instantlyAvailable = false;
  let instantlyError = null;
  if (!leadEmail) {
    instantlyError = { code: 'no_lead_email', message: 'No lead email to scope the conversation fetch to' };
    warnings.push({ code: 'instantly_unavailable', detail: instantlyError.message });
  } else if (!apiKey) {
    instantlyError = { code: 'no_api_key', message: 'INSTANTLY_REPLY_API_KEY is not set in this environment.' };
    warnings.push({ code: 'instantly_unavailable', detail: instantlyError.message });
  } else {
    try {
      const fetched = await fetchLeadConversation({ apiKey, leadEmail, fetchImpl, mailboxes });
      liveMessages = fetched.messages;
      instantlyAvailable = true;
      fetched.warnings.forEach((warning) => warnings.push(warning));
    } catch (err) {
      instantlyError = err?.instantly_status
        ? {
            code: 'instantly_error',
            instantly_status: err.instantly_status,
            message: String(err.instantly_error).slice(0, 500),
          }
        : { code: 'instantly_unreachable', message: err?.message || 'Request to Instantly failed' };
      warnings.push({
        code: 'instantly_unavailable',
        detail: `Live conversation unavailable: ${instantlyError.message}`,
      });
    }
  }

  const instantlyEmailId = text(replyEvent.instantly_email_id);
  const liveParent = instantlyEmailId
    ? liveMessages.find((message) => text(message.instantly_email_id) === instantlyEmailId) || null
    : null;

  return {
    record,
    replyEvent,
    outreachReplyEvents,
    outboundRecords,
    liveMessages,
    liveParent,
    leadEmail,
    instantlyAvailable,
    instantlyError,
    warnings,
    mailboxes,
  };
}

export async function evaluateManualReplyRequest({
  repo,
  replyEventId,
  body,
  expectedReceivedAt = '',
  apiKey,
  fetchImpl = globalThis.fetch,
  mailboxes = novusMailboxes(),
} = {}) {
  const inputs = await gatherManualReplyInputs({
    repo, replyEventId, apiKey, fetchImpl, mailboxes,
  });
  const gate = evaluateManualReplyGate({
    replyEvent: inputs.replyEvent,
    outreachReplyEvents: inputs.outreachReplyEvents,
    outboundRecords: inputs.outboundRecords,
    liveParent: inputs.liveParent,
    mailboxes: inputs.mailboxes,
    body,
    expectedReceivedAt,
  });
  return { inputs, gate };
}
