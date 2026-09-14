// lib/operator-calls.mjs — minimal outbound sales-call bridge for the NOVUS Command Centre.
//
// V0 deliberately uses PSTN click-to-call rather than a browser softphone:
// NOVUS calls Joe's configured operator mobile first; once he answers, Twilio
// dials the prospect. The prospect sees NOVUS_CALLER_ID (which may be Joe's
// verified mobile), while NOVUS gets deterministic status + recording callbacks.
//
// This module owns only call initiation + initial persistence. Status, recording,
// transcription and AI analysis are handled by the existing voice-recording
// webhook so we do not add another Vercel Serverless Function.

import { newCommunicationId, newRawEventId } from './ids.mjs';
import { normalizePhone } from './normalize.mjs';
import { escapeXml } from './twilio-webhook.mjs';

const TWILIO_CALLS_BASE = 'https://api.twilio.com/2010-04-01/Accounts';

function text(value) { return String(value ?? '').trim(); }

function requireE164(value, label) {
  const normalized = normalizePhone(value);
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new Error(`${label} must be a valid E.164 phone number`);
  }
  return normalized;
}

function callbackUrl(baseUrl) {
  const base = text(baseUrl).replace(/\/$/, '');
  if (!/^https:\/\//i.test(base)) throw new Error('NOVUS_PUBLIC_BASE_URL must be an https URL');
  return `${base}/api/novus/webhooks/voice-recording`;
}

export function buildOperatorDialTwiml({ prospectPhone, callerId, callback }) {
  const to = requireE164(prospectPhone, 'Prospect phone');
  const from = requireE164(callerId, 'Caller ID');
  const cb = text(callback);
  if (!/^https:\/\//i.test(cb)) throw new Error('Twilio callback URL must be https');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `<Dial callerId="${escapeXml(from)}" record="record-from-answer-dual" recordingStatusCallback="${escapeXml(cb)}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed">`,
    `<Number statusCallback="${escapeXml(cb)}" statusCallbackEvent="initiated ringing answered completed" statusCallbackMethod="POST">${escapeXml(to)}</Number>`,
    '</Dial>',
    '</Response>',
  ].join('');
}

async function createTwilioCall({ accountSid, authToken, from, to, twiml, fetchImpl }) {
  const url = `${TWILIO_CALLS_BASE}/${encodeURIComponent(accountSid)}/Calls.json`;
  const form = new URLSearchParams({ To: to, From: from, Twiml: twiml });
  const authorization = Buffer.from(`${accountSid}:${authToken}`, 'utf8').toString('base64');
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${authorization}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.sid) {
    throw new Error(data?.message || `Twilio call creation failed (${response.status})`);
  }
  return data;
}

export async function startOperatorCall({
  repo,
  agencyId,
  prospectPhone,
  actionId = '',
  probeId = '',
  baseUrl,
  fetchImpl = globalThis.fetch,
  env = process.env,
}) {
  if (!repo) throw new Error('repo is required');
  const agency = text(agencyId);
  if (!agency) throw new Error('agency_id is required');

  // A stale browser row must not be able to initiate an untracked call for an
  // agency that no longer exists in the canonical workbook.
  const agencyRecord = await repo.findById('AGENCIES', 'agency_id', agency);
  if (!agencyRecord) throw new Error('Agency not found');

  const accountSid = text(env.TWILIO_ACCOUNT_SID);
  const authToken = text(env.TWILIO_AUTH_TOKEN);
  const twilioPhone = requireE164(env.TWILIO_PHONE_NUMBER, 'TWILIO_PHONE_NUMBER');
  const operatorPhone = requireE164(env.NOVUS_OPERATOR_PHONE, 'NOVUS_OPERATOR_PHONE');
  const callerId = requireE164(env.NOVUS_CALLER_ID || env.TWILIO_PHONE_NUMBER, 'NOVUS_CALLER_ID');
  if (!accountSid || !authToken) throw new Error('Twilio credentials are not configured');

  const to = requireE164(prospectPhone, 'Prospect phone');
  const callback = callbackUrl(baseUrl || env.NOVUS_PUBLIC_BASE_URL);
  const twiml = buildOperatorDialTwiml({ prospectPhone: to, callerId, callback });

  const created = await createTwilioCall({
    accountSid,
    authToken,
    from: twilioPhone,
    to: operatorPhone,
    twiml,
    fetchImpl,
  });

  const now = new Date().toISOString();
  const rawEventId = newRawEventId();
  const communicationId = newCommunicationId();
  const callSid = text(created.sid);

  await repo.appendRecord('RAW_EVENTS', {
    raw_event_id: rawEventId,
    provider: 'twilio',
    provider_event_id: callSid,
    channel: 'voice',
    event_type: 'call.operator_started',
    received_at: now,
    occurred_at: now,
    source_identifier: callerId,
    destination_identifier: to,
    payload_reference: JSON.stringify({
      agency_id: agency,
      action_id: text(actionId),
      probe_id: text(probeId),
      operator_phone: operatorPhone,
      provider_status: text(created.status || 'queued'),
    }).slice(0, 45000),
    processing_status: 'processed',
    processed_communication_id: communicationId,
    error_message: '',
    created_at: now,
  });

  await repo.appendRecord('COMMUNICATIONS', {
    communication_id: communicationId,
    agency_id: agency,
    probe_id: text(probeId),
    interaction_id: callSid,
    occurred_at: now,
    received_at: now,
    channel: 'voice',
    direction: 'outbound',
    communication_type: 'sales_call',
    provider: 'twilio',
    provider_event_id: callSid,
    source_identifier_raw: callerId,
    source_identifier_normalized: normalizePhone(callerId),
    destination_identifier: to,
    display_name: '',
    call_status: text(created.status || 'queued'),
    duration_seconds: '',
    voicemail_present: 'FALSE',
    recording_reference: '',
    transcript: '',
    email_message_id: '',
    email_thread_id: '',
    subject: '',
    body_text: '',
    raw_content: JSON.stringify({ action_id: text(actionId) }),
    raw_payload_reference: rawEventId,
    matching_method: 'operator_selected',
    match_score: '1',
    match_status: 'matched',
    automated_or_human: 'human',
    human_contact: 'FALSE',
    callback_attempt: 'FALSE',
    successful_conversation: 'FALSE',
    follow_up: 'FALSE',
    booking_attempt: 'FALSE',
    communication_classification: 'OUTBOUND_SALES_CALL',
    intent: '',
    contact_quality: '',
    ai_summary: '',
    ai_confidence: '',
    ai_model: '',
    manual_review_status: 'not_required',
    manual_override: 'FALSE',
    override_reason: '',
    created_at: now,
    updated_at: now,
  });

  return {
    call_sid: callSid,
    communication_id: communicationId,
    status: text(created.status || 'queued'),
    prospect_phone: to,
    caller_id: callerId,
  };
}
