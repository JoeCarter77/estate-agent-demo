// api/novus/webhooks/sms-inbound.js — POST /api/novus/webhooks/sms-inbound
//
// Twilio's SMS webhook for the dedicated NOVUS number (+447575333064).
// NOT wired up in the Twilio console by this change.
//
// V1 does not promise two-way SMS conversations (that is a Tier 2 item —
// Source Master §4 "Two-way SMS and WhatsApp conversations" under "Tier 2
// adds", explicitly out of scope here). This handler captures inbound SMS as
// evidence only and replies with empty TwiML — no auto-reply, nothing invented.
//
// AUTH: Twilio request signature, same as the voice webhooks.
//
// Flow: RAW_EVENTS (idempotent on provider+MessageSid) -> deterministic
// agency/property evidence extraction + reconciliation
// -> COMMUNICATIONS -> automatic observation/intelligence recompute (only if
// matched to an active probe) -> empty TwiML.

import { getRepo } from '../../../lib/sheets.mjs';
import { newRawEventId, newCommunicationId } from '../../../lib/ids.mjs';
import { normalizePhone, canonicalTimestamp } from '../../../lib/normalize.mjs';
import { matchInboundCommunication } from '../../../lib/inbound-matching.mjs';
import { classifyCommunication } from '../../../lib/classification.mjs';
import { requireTwilioSignature, parseTwilioBody, sendTwiml } from '../../../lib/twilio-webhook.mjs';
import { recomputeProbeObservation } from '../../../lib/observation-recompute.mjs';

export const maxDuration = 20;

const WEBHOOK_PATH = '/api/novus/webhooks/sms-inbound';

function emptyTwiml(res) {
  sendTwiml(res, '');
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = parseTwilioBody(req);
  if (!requireTwilioSignature(req, res, WEBHOOK_PATH, body)) return;

  const provider = 'twilio';
  const messageSid = String(body.MessageSid || body.SmsSid || '').trim();
  const fromRaw = String(body.From || '').trim();

  if (!messageSid) return res.status(400).json({ error: 'Missing MessageSid' });
  if (!fromRaw) return res.status(400).json({ error: 'Missing From' });

  try {
    const repo = getRepo();

    const existingEvents = await repo.getRecords('RAW_EVENTS', 'raw_event_id');
    const dup = existingEvents.find((r) => r.obj.provider === provider && r.obj.provider_event_id === messageSid);
    if (dup) return emptyTwiml(res);

    const nowIso = new Date().toISOString();
    const occurredAt = canonicalTimestamp(body.Timestamp) || nowIso;
    const bodyText = String(body.Body || '');

    // 1) Immutable raw evidence.
    const rawEventId = newRawEventId();
    await repo.appendRecord('RAW_EVENTS', {
      raw_event_id: rawEventId,
      provider,
      provider_event_id: messageSid,
      channel: 'sms',
      event_type: 'message.received',
      received_at: nowIso,
      occurred_at: occurredAt,
      source_identifier: fromRaw,
      destination_identifier: String(body.To || '').trim(),
      payload_reference: safeStringify(body).slice(0, 45000),
      processing_status: 'received',
      processed_communication_id: '',
      error_message: '',
      created_at: nowIso,
    });

    // 2) The sender may be a number or an alphanumeric label. Reconcile
    // external identity, embedded phones and property evidence in one pass.
    const match = await matchInboundCommunication(repo, {
      channel: 'sms', sender_phone: fromRaw, body_text: bodyText, raw_content: bodyText,
    }, new Date());
    const matchStatus = match.match_status;
    const matchingMethod = match.matching_method;
    const matchScore = match.match_score;
    const agencyId = match.agency_id;
    const probeId = match.probe_id;
    const probeTimestamp = match.probe_timestamp;

    // 3) The Communication Event.
    const normalizedFrom = normalizePhone(fromRaw);
    const tags = classifyCommunication(
      { channel: 'sms', source_identifier_raw: fromRaw, source_identifier_normalized: normalizedFrom, subject: '', body_text: bodyText, occurred_at: occurredAt },
      { probeTimestamp }
    );

    const communicationId = newCommunicationId();
    await repo.appendRecord('COMMUNICATIONS', {
      communication_id: communicationId,
      agency_id: agencyId,
      probe_id: probeId,
      interaction_id: messageSid,
      occurred_at: occurredAt,
      received_at: nowIso,
      channel: 'sms',
      direction: 'inbound',
      communication_type: 'sms',
      provider,
      provider_event_id: messageSid,
      source_identifier_raw: fromRaw,
      source_identifier_normalized: normalizedFrom,
      destination_identifier: String(body.To || '').trim(),
      body_text: bodyText,
      raw_content: bodyText,
      raw_payload_reference: rawEventId,
      matching_method: matchingMethod,
      match_score: matchScore,
      match_status: matchStatus,
      automated_or_human: tags.automated_or_human,
      human_contact: tags.human_contact ? 'TRUE' : 'FALSE',
      callback_attempt: 'FALSE', // SMS is not a phone callback; distinct evidence channel
      successful_conversation: 'FALSE',
      follow_up: 'FALSE',
      booking_attempt: tags.booking_attempt ? 'TRUE' : 'FALSE',
      communication_classification: tags.communication_classification,
      manual_review_status: matchStatus === 'matched' ? 'not_required' : 'pending',
      created_at: nowIso,
      updated_at: nowIso,
    });

    await repo.updateById('RAW_EVENTS', 'raw_event_id', rawEventId, {
      processing_status: 'processed',
      processed_communication_id: communicationId,
    });

    // Automatic recompute: only when this communication deterministically
    // matched an active probe (probeId is non-empty only when matchStatus is
    // 'matched', never for ambiguous/unmatched). Never blocks the Twilio
    // response — a recompute failure is logged, not surfaced to the caller.
    if (probeId) {
      try {
        await recomputeProbeObservation(repo, probeId);
      } catch (err) {
        console.error('sms-inbound: auto-recompute failed:', err);
      }
    }

    return emptyTwiml(res);
  } catch (err) {
    console.error('sms-inbound error:', err);
    return emptyTwiml(res);
  }
}

function safeStringify(o) { try { return JSON.stringify(o); } catch { return ''; } }
