// api/novus/webhooks/voice-recording.js
//
// Shared Twilio callback for two deliberately small voice paths:
//
// 1) Existing inbound NOVUS voicemail:
//    recording callback + Twilio transcription callback.
// 2) Operator outbound sales calls:
//    <Number> call-progress callbacks + <Dial> recording callback. Meaningful
//    completed recordings are transcribed and analysed once.
//
// Both paths persist the raw provider event first, then patch the one canonical
// COMMUNICATIONS row for the call. Twilio signatures protect this public route.

import { getRepo } from '../../../lib/sheets.mjs';
import { newRawEventId } from '../../../lib/ids.mjs';
import { classifyCommunication } from '../../../lib/classification.mjs';
import { matchInboundCommunication } from '../../../lib/inbound-matching.mjs';
import { requireTwilioSignature, parseTwilioBody } from '../../../lib/twilio-webhook.mjs';
import { recomputeProbeObservation } from '../../../lib/observation-recompute.mjs';
import { isDeletedCommunication } from '../../../lib/communication-status.mjs';
import {
  analyseSalesTranscript,
  shouldAnalyseCall,
  transcribeSalesCall,
} from '../../../lib/call-intelligence.mjs';

export const maxDuration = 60;

const WEBHOOK_PATH = '/api/novus/webhooks/voice-recording';

function text(value) { return String(value ?? '').trim(); }
function isOverridden(comm) {
  return comm.manual_override === 'TRUE' || comm.manual_override === true;
}
function isOutboundSalesCall(comm) {
  return text(comm.direction).toLowerCase() === 'outbound'
    && text(comm.communication_type).toLowerCase() === 'sales_call';
}
function statusEventId(body) {
  return [
    'call-status',
    text(body.CallSid),
    text(body.CallStatus || 'unknown'),
    text(body.SequenceNumber || ''),
  ].join(':');
}
function meaningfulOutcome(analysis) {
  return analysis?.decision_maker_reached === true
    || ['OWNER_CONVERSATION','MEETING_BOOKED','NOT_INTERESTED','CALL_LATER']
      .includes(text(analysis?.call_outcome).toUpperCase());
}
function safeStringify(o) { try { return JSON.stringify(o); } catch { return ''; } }

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = parseTwilioBody(req);
  if (!requireTwilioSignature(req, res, WEBHOOK_PATH, body)) return;

  const provider = 'twilio';
  const isTranscription = Boolean(body.TranscriptionSid);
  const isRecording = Boolean(body.RecordingSid) && !isTranscription;
  const isStatus = !isRecording && !isTranscription && Boolean(body.CallStatus);
  const callSid = text(body.CallSid);
  // Child-leg progress events carry ParentCallSid; recordings normally use
  // the parent CallSid directly. Preferring ParentCallSid when present makes
  // the correlation robust to either Twilio callback shape.
  const targetCallSid = text(body.ParentCallSid || body.CallSid);
  const providerEventId = isTranscription
    ? text(body.TranscriptionSid)
    : isRecording
      ? text(body.RecordingSid)
      : statusEventId(body);

  if (!callSid) return res.status(400).json({ error: 'Missing CallSid' });
  if (!providerEventId) return res.status(400).json({ error: 'Missing callback event id' });

  try {
    const repo = getRepo();
    const existingEvents = await repo.getRecords('RAW_EVENTS', 'raw_event_id');
    const duplicate = existingEvents.find(
      (r) => r.obj.provider === provider && r.obj.provider_event_id === providerEventId
    );

    // A fully processed Twilio retry is a no-op. An ERROR/RECEIVED row is
    // intentionally retried using the same RAW_EVENT id so a transient OpenAI
    // failure cannot permanently strand an otherwise valid recording.
    if (duplicate && text(duplicate.obj.processing_status).toLowerCase() === 'processed') {
      return res.status(200).json({ duplicate: true });
    }

    const nowIso = new Date().toISOString();
    const eventType = isTranscription
      ? 'call.transcription'
      : isRecording
        ? 'call.recording'
        : `call.${text(body.CallStatus || 'status')}`;

    let rawEventId = duplicate?.obj?.raw_event_id || '';
    if (!rawEventId) {
      rawEventId = newRawEventId();
      await repo.appendRecord('RAW_EVENTS', {
        raw_event_id: rawEventId,
        provider,
        provider_event_id: providerEventId,
        channel: 'voice',
        event_type: eventType,
        received_at: nowIso,
        occurred_at: nowIso,
        source_identifier: targetCallSid || callSid,
        destination_identifier: '',
        payload_reference: safeStringify(body).slice(0, 45000),
        processing_status: 'received',
        processed_communication_id: '',
        error_message: '',
        created_at: nowIso,
      });
    } else {
      await repo.updateById('RAW_EVENTS', 'raw_event_id', rawEventId, {
        received_at: nowIso,
        payload_reference: safeStringify(body).slice(0, 45000),
        processing_status: 'received',
        error_message: '',
      });
    }

    const communications = await repo.getRecords('COMMUNICATIONS', 'communication_id');
    const target = communications.find((r) => r.obj.interaction_id === targetCallSid);

    if (!target) {
      await repo.updateById('RAW_EVENTS', 'raw_event_id', rawEventId, {
        processing_status: 'error',
        error_message: `No COMMUNICATIONS row found for CallSid ${targetCallSid}`,
      });
      return res.status(200).json({ matched: false, raw_event_id: rawEventId });
    }

    const comm = target.obj;
    if (isDeletedCommunication(comm)) {
      await repo.updateById('RAW_EVENTS', 'raw_event_id', rawEventId, {
        processing_status: 'processed',
        processed_communication_id: '',
        error_message: `Communication ${comm.communication_id} was deleted; callback discarded`,
      });
      return res.status(200).json({ matched: false, deleted: true, raw_event_id: rawEventId });
    }

    // ── OUTBOUND OPERATOR CALL PROGRESS ────────────────────────────────
    if (isStatus && isOutboundSalesCall(comm)) {
      const status = text(body.CallStatus).toLowerCase();
      const answered = ['in-progress', 'completed'].includes(status);
      const terminalNoContact = ['busy', 'failed', 'no-answer', 'canceled'].includes(status);
      const patch = {
        call_status: status || comm.call_status,
        updated_at: nowIso,
      };
      if (body.CallDuration !== undefined && body.CallDuration !== '') {
        patch.duration_seconds = text(body.CallDuration);
      }
      if (answered) patch.human_contact = 'TRUE';
      if (terminalNoContact) {
        patch.human_contact = 'FALSE';
        patch.successful_conversation = 'FALSE';
      }
      await repo.updateById('COMMUNICATIONS', 'communication_id', comm.communication_id, patch);
      await repo.updateById('RAW_EVENTS', 'raw_event_id', rawEventId, {
        processing_status: 'processed',
        processed_communication_id: comm.communication_id,
      });
      return res.status(200).json({
        matched: true,
        communication_id: comm.communication_id,
        call_status: patch.call_status,
      });
    }

    // A status callback on the old inbound path is not part of its contract.
    if (isStatus) {
      await repo.updateById('RAW_EVENTS', 'raw_event_id', rawEventId, {
        processing_status: 'processed',
        processed_communication_id: comm.communication_id,
      });
      return res.status(200).json({ matched: true, ignored_status: true });
    }

    // ── OUTBOUND OPERATOR CALL RECORDING + AI ──────────────────────────
    if (isRecording && isOutboundSalesCall(comm)) {
      const durationSeconds = text(body.RecordingDuration || comm.duration_seconds || '');
      const recordingReference = text(body.RecordingUrl || body.RecordingSid);
      const meaningful = shouldAnalyseCall(durationSeconds);
      const recordingPatch = {
        recording_reference: recordingReference,
        duration_seconds: durationSeconds,
        voicemail_present: 'FALSE',
        call_status: 'completed',
        human_contact: 'TRUE',
        successful_conversation: meaningful ? 'TRUE' : 'FALSE',
        updated_at: nowIso,
      };
      await repo.updateById('COMMUNICATIONS', 'communication_id', comm.communication_id, recordingPatch);

      // Short calls are still logged and playable; they simply do not incur
      // transcription/model cost.
      if (!meaningful) {
        await repo.updateById('RAW_EVENTS', 'raw_event_id', rawEventId, {
          processing_status: 'processed',
          processed_communication_id: comm.communication_id,
        });
        return res.status(200).json({
          matched: true,
          communication_id: comm.communication_id,
          ai_processed: false,
          reason: 'short_call',
        });
      }

      // If a previous callback attempt already completed both stages, the retry
      // only needs to close its RAW_EVENT. This also prevents duplicate model
      // spend if Twilio redelivers after a response-edge failure.
      if (text(comm.transcript) && text(comm.ai_summary)) {
        await repo.updateById('RAW_EVENTS', 'raw_event_id', rawEventId, {
          processing_status: 'processed',
          processed_communication_id: comm.communication_id,
          error_message: '',
        });
        return res.status(200).json({
          matched: true,
          communication_id: comm.communication_id,
          ai_processed: true,
          reused_existing_intelligence: true,
        });
      }

      // The telephony path must remain usable before the optional OpenAI secret
      // is configured. The recording stays persisted and clearly flags that
      // intelligence has not run.
      if (!text(process.env.OPENAI_API_KEY)) {
        await repo.updateById('COMMUNICATIONS', 'communication_id', comm.communication_id, {
          ai_model: 'OPENAI_NOT_CONFIGURED',
          updated_at: nowIso,
        });
        await repo.updateById('RAW_EVENTS', 'raw_event_id', rawEventId, {
          processing_status: 'processed',
          processed_communication_id: comm.communication_id,
        });
        return res.status(200).json({
          matched: true,
          communication_id: comm.communication_id,
          ai_processed: false,
          reason: 'openai_not_configured',
        });
      }

      try {
        const agencyRecord = comm.agency_id
          ? await repo.findById('AGENCIES', 'agency_id', comm.agency_id)
          : null;
        const agencyName = text(
          agencyRecord?.obj?.agency_name
          || agencyRecord?.obj?.name
          || ''
        );

        // Persist transcription before analysis. If the second model call
        // fails, a Twilio retry reuses this transcript instead of paying to
        // transcribe the same audio again.
        let transcript = text(comm.transcript);
        const transcribeModel = text(process.env.NOVUS_CALL_TRANSCRIBE_MODEL) || 'gpt-transcribe';
        if (!transcript) {
          transcript = await transcribeSalesCall({ recordingReference });
          await repo.updateById('COMMUNICATIONS', 'communication_id', comm.communication_id, {
            transcript,
            ai_model: `${transcribeModel}+PENDING`,
            updated_at: new Date().toISOString(),
          });
        }

        const analysed = await analyseSalesTranscript({
          transcript,
          agencyName,
          contactName: text(comm.display_name),
        });
        const analysis = analysed.analysis || {};
        const aiPatch = {
          transcript,
          ai_summary: safeStringify(analysis).slice(0, 45000),
          ai_confidence: analysis.confidence ?? '',
          ai_model: `${transcribeModel}+${analysed.model}`,
          intent: text(analysis.main_constraint || analysis.agency_priority || ''),
          contact_quality: analysis.decision_maker_reached === true
            ? 'DECISION_MAKER'
            : text(analysis.call_outcome).toUpperCase() === 'GATEKEEPER'
              ? 'GATEKEEPER'
              : '',
          booking_attempt: analysis.meeting_booked ? 'TRUE' : 'FALSE',
          communication_classification: text(analysis.call_outcome || 'OUTBOUND_SALES_CALL'),
          successful_conversation: meaningfulOutcome(analysis) ? 'TRUE' : 'FALSE',
          updated_at: new Date().toISOString(),
        };
        await repo.updateById('COMMUNICATIONS', 'communication_id', comm.communication_id, aiPatch);
        await repo.updateById('RAW_EVENTS', 'raw_event_id', rawEventId, {
          processing_status: 'processed',
          processed_communication_id: comm.communication_id,
          error_message: '',
        });
        return res.status(200).json({
          matched: true,
          communication_id: comm.communication_id,
          ai_processed: true,
          call_outcome: analysis.call_outcome || '',
        });
      } catch (err) {
        console.error('outbound call intelligence failed:', err);
        await repo.updateById('RAW_EVENTS', 'raw_event_id', rawEventId, {
          processing_status: 'error',
          processed_communication_id: comm.communication_id,
          error_message: text(err?.message || 'Call intelligence failed').slice(0, 1000),
        });
        // 500 asks Twilio to retry a transient processing failure. The
        // recording itself is already safely attached above, and the retry
        // path reuses this RAW_EVENT instead of duplicating it.
        return res.status(500).json({
          matched: true,
          communication_id: comm.communication_id,
          error: err?.message || 'Call intelligence failed',
        });
      }
    }

    // ── EXISTING INBOUND VOICEMAIL PATH ────────────────────────────────
    const patch = {};

    if (isRecording) {
      patch.recording_reference = text(body.RecordingUrl || providerEventId);
      patch.duration_seconds = text(body.RecordingDuration || '');
      patch.voicemail_present = 'TRUE';
      patch.call_status = 'voicemail';
    } else if (isTranscription) {
      patch.transcript = text(body.TranscriptionText || '');

      if (!isOverridden(comm)) {
        const occurredAt = new Date(comm.occurred_at || nowIso);
        const matchAt = Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt;
        const match = await matchInboundCommunication(repo, {
          channel: 'voice',
          sender_phone: comm.source_identifier_raw,
          display_name: comm.display_name,
          transcript: patch.transcript,
        }, matchAt);

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
      error_message: '',
    });

    const recomputeProbeId = patch.probe_id || comm.probe_id;
    if (recomputeProbeId) {
      try {
        await recomputeProbeObservation(repo, recomputeProbeId);
      } catch (err) {
        console.error('voice-recording: auto-recompute failed:', err);
      }
    }

    return res.status(200).json({
      matched: true,
      communication_id: comm.communication_id,
      raw_event_id: rawEventId,
    });
  } catch (err) {
    console.error('voice-recording error:', err);
    return res.status(500).json({ error: err.message || 'Failed to process recording/transcription callback' });
  }
}
