// api/novus/webhooks/voice-inbound.js — POST /api/novus/webhooks/voice-inbound
//
// Twilio's Voice webhook for the dedicated NOVUS number (+447575333064).
// NOT wired up in the Twilio console by this change — the code is ready, the
// console configuration is a separate, deliberate step.
//
// NOVUS Project Source Master §16 originally said "V1 does not answer calls
// or ring Joe's personal phone" — calls were captured as missed/voicemail
// evidence only. Since the calling workspace exists, an inbound call is now
// treated as a CALLBACK: after the evidence below is written exactly as
// before, lib/calling-inbound.mjs matches the caller id to its lead(s), opens
// a CALLS row and rings the operator's BROWSER (never a personal phone) with
// the identification attached. If nobody answers, or browser calling is not
// configured, the caller still gets the same voicemail prompt as before, so
// nothing about the evidence path changes. The COMMUNICATIONS row written
// here is still the ringing-time record (successful_conversation FALSE at
// this point); the conversation itself is recorded on the CALLS row.
//
// AUTH: verified by Twilio's request signature (TWILIO_AUTH_TOKEN), never the
// human NOVUS_BASIC_AUTH and never the email webhook's NOVUS_INGEST_SECRET —
// this endpoint lives under /api/novus/webhooks/*, already excluded from
// Basic Auth by middleware.js.
//
// Flow: RAW_EVENTS (idempotent on provider+CallSid) -> deterministic caller/
// transcript/property evidence reconciliation ->
// COMMUNICATIONS -> automatic observation/intelligence recompute (only if
// matched to an active probe) -> TwiML instructing Twilio to record a
// voicemail. The recording/transcript arrive later via voice-recording.js,
// which triggers its own recompute once the transcript patches this row.

import { getRepo } from '../../../lib/sheets.mjs';
import { newRawEventId, newCommunicationId } from '../../../lib/ids.mjs';
import { normalizePhone, canonicalTimestamp } from '../../../lib/normalize.mjs';
import { matchInboundCommunication } from '../../../lib/inbound-matching.mjs';
import { classifyCommunication } from '../../../lib/classification.mjs';
import { requireTwilioSignature, parseTwilioBody, sendTwiml } from '../../../lib/twilio-webhook.mjs';
import { recomputeProbeObservation } from '../../../lib/observation-recompute.mjs';
import { ringInboundCall, voicemailTwimlBody } from '../../../lib/calling-inbound.mjs';
import { twilioCallingConfig } from '../../../lib/twilio-access-token.mjs';

export const maxDuration = 20;

const WEBHOOK_PATH = '/api/novus/webhooks/voice-inbound';

function voicemailTwiml(res) {
  sendTwiml(res, voicemailTwimlBody());
}

// Ring the browser with the matched lead attached (lib/calling-inbound.mjs).
// Only when browser calling is configured — otherwise there is no Device to
// ring and the caller goes straight to voicemail as before. Any failure here
// also falls back to voicemail: Twilio must always get valid TwiML.
async function ringOrVoicemail(res, repo, params) {
  if (!twilioCallingConfig().enabled) return voicemailTwiml(res);
  try {
    const ring = await ringInboundCall(repo, params);
    return sendTwiml(res, ring.twiml);
  } catch (err) {
    console.error('voice-inbound: could not ring the browser, falling back to voicemail:', err);
    return voicemailTwiml(res);
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = parseTwilioBody(req);
  if (!requireTwilioSignature(req, res, WEBHOOK_PATH, body)) return;

  const provider = 'twilio';
  const callSid = String(body.CallSid || '').trim();
  const fromRaw = String(body.From || '').trim();

  if (!callSid) return res.status(400).json({ error: 'Missing CallSid' });
  if (!fromRaw) return res.status(400).json({ error: 'Missing From' });

  try {
    const repo = getRepo();

    // Idempotency: Twilio may retry this webhook — one logical call, one
    // RAW_EVENTS row, one COMMUNICATIONS row. Twilio always needs valid TwiML
    // back regardless, so a duplicate still gets the voicemail TwiML.
    const existingEvents = await repo.getRecords('RAW_EVENTS', 'raw_event_id');
    const dup = existingEvents.find((r) => r.obj.provider === provider && r.obj.provider_event_id === callSid);
    if (dup) {
      // ringInboundCall is idempotent on CallSid too: the same ring TwiML
      // comes back for the CALLS row already opened for this call.
      return ringOrVoicemail(res, repo, { callSid, from: fromRaw, to: String(body.To || '').trim(), rawEventId: dup.obj.raw_event_id, communicationId: dup.obj.processed_communication_id });
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const occurredAt = canonicalTimestamp(body.Timestamp) || nowIso;

    // 1) Immutable raw evidence, written before any interpretation happens.
    const rawEventId = newRawEventId();
    await repo.appendRecord('RAW_EVENTS', {
      raw_event_id: rawEventId,
      provider,
      provider_event_id: callSid,
      channel: 'voice',
      event_type: `call.${String(body.CallStatus || 'ringing').trim()}`,
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

    // 2) At ringing time caller number is the available evidence. The same
    // shared matcher is rerun when a transcript arrives.
    const match = await matchInboundCommunication(repo, {
      channel: 'voice', sender_phone: fromRaw,
    }, now);
    const matchStatus = match.match_status;
    const matchingMethod = match.matching_method;
    const matchScore = match.match_score;
    const agencyId = match.agency_id;
    const probeId = match.probe_id;
    const probeTimestamp = match.probe_timestamp;

    // 3) The Communication Event. A phone call is, on its face, made by a
    // person — classifyCommunication defaults voice/SMS to human contact
    // unless a known auto-ack signal is present (there is none at ringing time,
    // before any transcript exists — see voice-recording.js for re-classification).
    const normalizedFrom = normalizePhone(fromRaw);
    const tags = classifyCommunication(
      { channel: 'voice', source_identifier_raw: fromRaw, source_identifier_normalized: normalizedFrom, subject: '', body_text: '', occurred_at: occurredAt },
      { probeTimestamp }
    );

    const communicationId = newCommunicationId();
    await repo.appendRecord('COMMUNICATIONS', {
      communication_id: communicationId,
      agency_id: agencyId,
      probe_id: probeId,
      interaction_id: callSid,
      occurred_at: occurredAt,
      received_at: nowIso,
      channel: 'voice',
      direction: 'inbound',
      communication_type: 'call',
      provider,
      provider_event_id: callSid,
      source_identifier_raw: fromRaw,
      source_identifier_normalized: normalizedFrom,
      destination_identifier: String(body.To || '').trim(),
      display_name: '',
      call_status: String(body.CallStatus || 'ringing').trim(),
      duration_seconds: '',
      voicemail_present: 'FALSE', // set TRUE by voice-recording.js once a recording actually exists
      recording_reference: '',
      transcript: '',
      raw_payload_reference: rawEventId,
      matching_method: matchingMethod,
      match_score: matchScore,
      match_status: matchStatus,
      automated_or_human: tags.automated_or_human,
      human_contact: tags.human_contact ? 'TRUE' : 'FALSE',
      callback_attempt: 'TRUE', // every inbound call is evidence of a callback attempt (S11)
      successful_conversation: 'FALSE', // V1 never connects a live conversation (S16) — deterministic, not a guess
      follow_up: 'FALSE', // sequence-aware flag, set by the observation recompute pass
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

    // Automatic recompute: only when this call deterministically matched an
    // active probe. Never blocks the TwiML response Twilio needs back.
    if (probeId) {
      try {
        await recomputeProbeObservation(repo, probeId);
      } catch (err) {
        console.error('voice-inbound: auto-recompute failed:', err);
      }
    }

    return ringOrVoicemail(res, repo, { callSid, from: fromRaw, to: String(body.To || '').trim(), communicationId, rawEventId, now: nowIso });
  } catch (err) {
    console.error('voice-inbound error:', err);
    // Twilio still needs valid TwiML even on our own failure, or the caller
    // hears an error tone with no fallback.
    return voicemailTwiml(res);
  }
}

function safeStringify(o) { try { return JSON.stringify(o); } catch { return ''; } }
