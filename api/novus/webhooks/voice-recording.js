// api/novus/webhooks/voice-recording.js — POST /api/novus/webhooks/voice-recording
//
// Twilio posts here TWICE per voicemail, from the same <Record> verb in
// voice-inbound.js's TwiML: once as recordingStatusCallback (RecordingSid,
// RecordingUrl, RecordingDuration) when the recording finishes, and once as
// transcribeCallback (TranscriptionSid, TranscriptionText) when the legacy
// Record-level transcription completes. This single handler distinguishes
// the two by which fields are present and patches the matching COMMUNICATIONS
// row (found by interaction_id === CallSid) rather than creating a new one —
// the "Communication" is the call, already written by voice-inbound.js.
//
// V1 uses Twilio's built-in <Record transcribe="true"> rather than a
// separate transcription service — the simplest option that needs no extra
// provider (Source Master §28: "V1 should be simple and reliable rather than
// over-engineered"). Swapping to Twilio Voice Intelligence or another STT
// provider later only touches this file.
//
// AUTH: Twilio request signature, same as voice-inbound.js.
// Not wired up in the Twilio console by this change.
//
// After patching the COMMUNICATIONS row, triggers an automatic observation/
// intelligence recompute for the call's probe_id (if any) — the recording/
// transcript can change voicemail_present, recording_reference, transcript,
// and (on the transcription callback) classification.

import { getRepo } from '../../../lib/sheets.mjs';
import { newRawEventId } from '../../../lib/ids.mjs';
import { classifyCommunication } from '../../../lib/classification.mjs';
import { matchInboundCommunication } from '../../../lib/inbound-matching.mjs';
import { requireTwilioSignature, parseTwilioBody } from '../../../lib/twilio-webhook.mjs';
import { recomputeProbeObservation } from '../../../lib/observation-recompute.mjs';
import { isDeletedCommunication } from '../../../lib/communication-status.mjs';

export const maxDuration = 20;

const WEBHOOK_PATH = '/api/novus/webhooks/voice-recording';

function isOverridden(comm) {
  return comm.manual_override === 'TRUE' || comm.manual_override === true;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = parseTwilioBody(req);
  if (!requireTwilioSignature(req, res, WEBHOOK_PATH, body)) return;

  const provider = 'twilio';
  const callSid = String(body.CallSid || '').trim();
  const isTranscription = Boolean(body.TranscriptionSid);
  const providerEventId = isTranscription ? String(body.TranscriptionSid).trim() : String(body.RecordingSid || '').trim();

  if (!callSid) return res.status(400).json({ error: 'Missing CallSid' });
  if (!providerEventId) return res.status(400).json({ error: 'Missing RecordingSid/TranscriptionSid' });

  try {
    const repo = getRepo();

    // Idempotency: a redelivered callback for the same recording/transcription
    // must not double-write.
    const existingEvents = await repo.getRecords('RAW_EVENTS', 'raw_event_id');
    const dup = existingEvents.find((r) => r.obj.provider === provider && r.obj.provider_event_id === providerEventId);
    if (dup) return res.status(200).json({ duplicate: true });

    const nowIso = new Date().toISOString();

    // 1) Immutable raw evidence.
    const rawEventId = newRawEventId();
    await repo.appendRecord('RAW_EVENTS', {
      raw_event_id: rawEventId,
      provider,
      provider_event_id: providerEventId,
      channel: 'voice',
      event_type: isTranscription ? 'call.transcription' : 'call.recording',
      received_at: nowIso,
      occurred_at: nowIso,
      source_identifier: callSid,
      destination_identifier: '',
      payload_reference: safeStringify(body).slice(0, 45000),
      processing_status: 'received',
      processed_communication_id: '',
      error_message: '',
      created_at: nowIso,
    });

    // 2) Find the Communication this recording/transcription belongs to.
    const communications = await repo.getRecords('COMMUNICATIONS', 'communication_id');
    const target = communications.find((r) => r.obj.interaction_id === callSid);

    if (!target) {
      await repo.updateById('RAW_EVENTS', 'raw_event_id', rawEventId, {
        processing_status: 'error',
        error_message: `No COMMUNICATIONS row found for CallSid ${callSid}`,
      });
      // Still 200 — Twilio does not need a retry for evidence that cannot be
      // matched, and RAW_EVENTS already preserves the raw payload for review.
      return res.status(200).json({ matched: false, raw_event_id: rawEventId });
    }

    const comm = target.obj;

    // The Communication this recording/transcript belongs to was deliberately
    // deleted (no useful evidence). A late-arriving recording/transcript must
    // never resurrect it — record the raw evidence and stop.
    if (isDeletedCommunication(comm)) {
      await repo.updateById('RAW_EVENTS', 'raw_event_id', rawEventId, {
        processing_status: 'processed',
        processed_communication_id: '',
        error_message: `Communication ${comm.communication_id} was deleted; recording/transcript discarded`,
      });
      return res.status(200).json({ matched: false, deleted: true, raw_event_id: rawEventId });
    }

    const patch = {};

    if (!isTranscription) {
      patch.recording_reference = String(body.RecordingUrl || providerEventId);
      patch.duration_seconds = String(body.RecordingDuration || '');
      patch.voicemail_present = 'TRUE';
      patch.call_status = 'voicemail';
    } else {
      patch.transcript = String(body.TranscriptionText || '');

      if (!isOverridden(comm)) {
        // Reconcile the original caller number with numbers/property/address
        // evidence found in the transcript. Use the call time so a delayed
        // transcription callback still sees the observation window that was
        // active when the communication occurred.
        const occurredAt = new Date(comm.occurred_at || nowIso);
        const matchAt = Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt;
        const match = await matchInboundCommunication(repo, {
          channel: 'voice', sender_phone: comm.source_identifier_raw,
          display_name: comm.display_name, transcript: patch.transcript,
        }, matchAt);
        // Never erase a safe match merely because the asynchronous transcript
        // arrived after the probe window closed. New matched or conflicting
        // evidence is still applied; an evidence-free downgrade is ignored.
        const preserveExistingMatch = comm.match_status === 'matched'
          && match.match_status !== 'matched'
          && match.matching_method !== 'conflict';
        if (!preserveExistingMatch) {
          patch.agency_id = match.agency_id;
          patch.probe_id = match.probe_id;
          patch.match_status = match.match_status;
          patch.matching_method = match.matching_method;
          patch.match_score = match.match_score;
          patch.manual_review_status = match.match_status === 'matched' ? 'not_required' : 'pending';
        }

        const linkedProbeId = patch.probe_id || comm.probe_id;
        let probeTimestamp;
        if (linkedProbeId) {
          const probeRecord = await repo.findById('PROBES', 'probe_id', linkedProbeId);
          probeTimestamp = probeRecord?.obj?.probe_timestamp;
        }

        // Re-classify now that transcript text (and possibly a newly
        // resolved agency/probe) is available, unless a human already
        // corrected this row.
        const tags = classifyCommunication(
          { ...comm, ...patch, channel: 'voice', body_text: patch.transcript },
          { probeTimestamp }
        );
        patch.automated_or_human = tags.automated_or_human;
        patch.human_contact = tags.human_contact ? 'TRUE' : 'FALSE';
        patch.communication_classification = tags.communication_classification;
        patch.booking_attempt = tags.booking_attempt ? 'TRUE' : 'FALSE';
      }
    }
    patch.updated_at = nowIso;

    await repo.updateById('COMMUNICATIONS', 'communication_id', comm.communication_id, patch);
    await repo.updateById('RAW_EVENTS', 'raw_event_id', rawEventId, {
      processing_status: 'processed',
      processed_communication_id: comm.communication_id,
    });

    // Automatic recompute: only when the call this recording/transcription
    // belongs to was matched to an active probe — including a probe newly
    // resolved above via the transcript's content-based agency fallback.
    // Covers both callbacks — the recording landing (voicemail_present/
    // recording_reference) and the transcript landing (which can also
    // change matching and classification above).
    const recomputeProbeId = patch.probe_id || comm.probe_id;
    if (recomputeProbeId) {
      try {
        await recomputeProbeObservation(repo, recomputeProbeId);
      } catch (err) {
        console.error('voice-recording: auto-recompute failed:', err);
      }
    }

    return res.status(200).json({ matched: true, communication_id: comm.communication_id, raw_event_id: rawEventId });
  } catch (err) {
    console.error('voice-recording error:', err);
    return res.status(500).json({ error: err.message || 'Failed to process recording/transcription callback' });
  }
}

function safeStringify(o) { try { return JSON.stringify(o); } catch { return ''; } }
