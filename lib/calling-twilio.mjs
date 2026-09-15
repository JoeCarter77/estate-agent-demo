// lib/calling-twilio.mjs — browser calling through Twilio Voice for the
// calling workspace: the access-token operation the page calls, and the three
// webhooks Twilio calls back (outbound TwiML, call status, recording status).
//
// ROUTING. All four are ?novus_operation= branches on
// api/novus/personalisation.js (the 12-function ceiling). The three webhooks
// are reached through vercel.json rewrites from
//   /api/novus/webhooks/voice-outbound            → twilio-voice-outbound
//   /api/novus/webhooks/voice-outbound-status     → twilio-voice-status
//   /api/novus/webhooks/voice-outbound-recording  → twilio-voice-recording
// so middleware.js's /api/novus/webhooks/* exclusion keeps Basic Auth off
// them, and each one is authenticated by Twilio's request signature against
// that public path — exactly like voice-inbound.js and voice-recording.js.
//
// THE CALL RECORD COMES FIRST. The browser opens the CALLS row (calling-start)
// BEFORE it connects, and hands Twilio only the call_id as a custom parameter.
// The TwiML handler then dials the number stored on that row — never a number
// supplied by the request — and every later callback finds the row by the
// parent CallSid it stamped. Recording is switched on by the <Dial> itself
// (record-from-answer-dual), so there is no manual recording step and the
// post-call workflow never waits for it: the recording callback patches the
// row whenever Twilio is done.

import { getRepo } from './sheets.mjs';
import { normalizePhone } from './normalize.mjs';
import { requireTwilioSignature, parseTwilioBody, sendTwiml, escapeXml } from './twilio-webhook.mjs';
import { fetchTwilioRecording } from './twilio-recording.mjs';
import { createVoiceAccessToken, twilioCallingConfig } from './twilio-access-token.mjs';
import { CALLS_TAB, patchCallCells } from './calling-store.mjs';
import { invalidateCallingCache } from './calling-handlers.mjs';

const text = (value) => String(value ?? '').trim();
const noStore = (res) => res.setHeader('Cache-Control', 'private, no-store, max-age=0');

export const VOICE_OUTBOUND_PATH = '/api/novus/webhooks/voice-outbound';
export const VOICE_STATUS_PATH = '/api/novus/webhooks/voice-outbound-status';
export const VOICE_RECORDING_PATH = '/api/novus/webhooks/voice-outbound-recording';
export const OPERATOR_IDENTITY = 'novus-operator';
const TOKEN_TTL_SECONDS = 3600;

function baseUrl() { return text(process.env.NOVUS_PUBLIC_BASE_URL).replace(/\/$/, ''); }

// ── GET twilio-token (Basic Auth) ──────────────────────────────────────────
// Tells the page whether browser calling is configured and, if so, hands it
// a one-hour token. Never errors when unconfigured: the page falls back to
// manual mode and shows which variables are missing.
export async function handleTwilioToken(req, res) {
  noStore(res);
  const config = twilioCallingConfig();
  if (!config.enabled) return res.status(200).json({ success: true, enabled: false, missing: config.missing });
  try {
    const minted = createVoiceAccessToken({
      accountSid: process.env.TWILIO_ACCOUNT_SID, apiKeySid: process.env.TWILIO_API_KEY_SID, apiKeySecret: process.env.TWILIO_API_KEY_SECRET,
      twimlAppSid: process.env.TWILIO_TWIML_APP_SID, identity: OPERATOR_IDENTITY, ttlSeconds: TOKEN_TTL_SECONDS,
    });
    return res.status(200).json({ success: true, enabled: true, token: minted.token, expires_at: minted.expires_at, identity: minted.identity, caller_id: config.caller_id, ttl_seconds: TOKEN_TTL_SECONDS });
  } catch (err) {
    return res.status(500).json({ success: false, enabled: false, error: err?.message || 'Could not mint a Twilio token' });
  }
}

// ── POST /api/novus/webhooks/voice-outbound (Twilio signature) ─────────────
// The TwiML App's Voice Request URL. Twilio calls it when the browser Device
// connects; the response tells Twilio what to dial and how to record.
export async function handleVoiceOutbound(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = parseTwilioBody(req);
  if (!requireTwilioSignature(req, res, VOICE_OUTBOUND_PATH, body)) return;
  const callId = text(body.call_id);
  const parentSid = text(body.CallSid);
  const reject = (why) => sendTwiml(res, `<Say voice="alice">${escapeXml(why)}</Say><Hangup/>`);
  if (!callId || !parentSid) return reject('This call cannot be placed: missing call reference.');
  try {
    const repo = getRepo();
    const record = await repo.findById(CALLS_TAB, 'call_id', callId);
    if (!record) return reject('This call cannot be placed: unknown call record.');
    if (text(record.obj.outcome)) return reject('This call has already been completed.');
    const to = normalizePhone(record.obj.phone);
    if (!/^\+[1-9]\d{6,14}$/.test(to)) return reject('This call cannot be placed: the stored number is not dialable.');
    const callerId = text(process.env.TWILIO_CALLER_ID);
    if (!callerId) return reject('This call cannot be placed: no caller ID is configured.');
    const now = new Date().toISOString();
    await patchCallCells(repo, callId, {
      twilio_call_sid: parentSid, call_status: 'initiated', call_mode: 'TWILIO',
      started_at: text(record.obj.started_at) || now, updated_at: now,
    });
    invalidateCallingCache();
    const base = baseUrl();
    const status = `${base}${VOICE_STATUS_PATH}`;
    const recording = `${base}${VOICE_RECORDING_PATH}`;
    return sendTwiml(res, [
      `<Dial callerId="${escapeXml(callerId)}" answerOnBridge="true" timeout="35"`,
      ` record="record-from-answer-dual" recordingStatusCallback="${escapeXml(recording)}" recordingStatusCallbackEvent="completed"`,
      ` action="${escapeXml(status)}">`,
      `<Number statusCallback="${escapeXml(status)}" statusCallbackEvent="initiated ringing answered completed">${escapeXml(to)}</Number>`,
      '</Dial>',
    ].join(''));
  } catch (err) {
    console.error('voice-outbound error:', err);
    return reject('This call cannot be placed right now.');
  }
}

// Status precedence, so an out-of-order redelivery never moves a call
// backwards from completed to ringing.
const STATUS_RANK = { queued: 0, initiated: 1, ringing: 2, 'in-progress': 3, answered: 3, completed: 4, busy: 4, 'no-answer': 4, failed: 4, canceled: 4 };

// ── POST /api/novus/webhooks/voice-outbound-status (Twilio signature) ──────
// Two callers share this URL: the <Number> statusCallback (child leg events:
// initiated / ringing / answered / completed, with ParentCallSid) and the
// <Dial> action (the parent, once the dial ends, with DialCallStatus). Both
// resolve to the same CALLS row through the parent CallSid.
export async function handleVoiceStatus(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = parseTwilioBody(req);
  if (!requireTwilioSignature(req, res, VOICE_STATUS_PATH, body)) return;
  const isDialAction = Boolean(text(body.DialCallStatus));
  const parentSid = text(body.ParentCallSid) || text(body.CallSid);
  const status = (isDialAction ? text(body.DialCallStatus) : text(body.CallStatus)).toLowerCase();
  const done = () => (isDialAction ? sendTwiml(res, '') : res.status(200).json({ ok: true }));
  if (!parentSid) return done();
  try {
    const repo = getRepo();
    const record = await repo.findById(CALLS_TAB, 'twilio_call_sid', parentSid);
    if (!record) return done();
    const row = record.obj;
    const now = new Date().toISOString();
    const patch = { updated_at: now };
    const current = text(row.call_status).toLowerCase();
    if ((STATUS_RANK[status] ?? -1) >= (STATUS_RANK[current] ?? -1) && status) patch.call_status = status === 'answered' ? 'in-progress' : status;
    if ((status === 'in-progress' || status === 'answered') && !text(row.connected_at)) patch.connected_at = now;
    if (STATUS_RANK[status] === 4) {
      if (!text(row.ended_at)) patch.ended_at = now;
      const duration = Number(isDialAction ? body.DialCallDuration : body.CallDuration);
      if (Number.isFinite(duration) && !text(row.duration_seconds)) patch.duration_seconds = Math.round(duration);
    }
    if (Object.keys(patch).length > 1) {
      // Cell writes, not a row rewrite: the recording callback and the
      // operator's save may be patching the same row at the same moment.
      await patchCallCells(repo, row.call_id, patch);
      invalidateCallingCache();
    }
    return done();
  } catch (err) {
    console.error('voice-outbound-status error:', err);
    return done();
  }
}

// ── POST /api/novus/webhooks/voice-outbound-recording (Twilio signature) ───
export async function handleVoiceRecording(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = parseTwilioBody(req);
  if (!requireTwilioSignature(req, res, VOICE_RECORDING_PATH, body)) return;
  const parentSid = text(body.CallSid);
  const recordingSid = text(body.RecordingSid);
  if (!parentSid || !recordingSid) return res.status(200).json({ ok: true, ignored: true });
  try {
    const repo = getRepo();
    const record = await repo.findById(CALLS_TAB, 'twilio_call_sid', parentSid);
    if (!record) return res.status(200).json({ ok: true, matched: false });
    const now = new Date().toISOString();
    const duration = Number(body.RecordingDuration);
    // ONLY THE IDENTIFIER IS STORED. Twilio's RecordingUrl is a media URL
    // that, unless "Enforce HTTP Auth on media URLs" is switched on in the
    // Console, plays for anyone holding it. The workbook keeps the
    // RecordingSid; playback goes through the Basic-Auth calling-recording
    // operation, which rebuilds the URL and authenticates with the account
    // credentials server-side (lib/twilio-recording.mjs).
    await patchCallCells(repo, record.obj.call_id, {
      recording_sid: recordingSid,
      recording_url: '',
      recording_status: text(body.RecordingStatus) || 'completed',
      recording_duration_seconds: Number.isFinite(duration) ? Math.round(duration) : text(record.obj.recording_duration_seconds),
      updated_at: now,
    });
    invalidateCallingCache();
    return res.status(200).json({ ok: true, matched: true, call_id: record.obj.call_id });
  } catch (err) {
    console.error('voice-outbound-recording error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to record the recording callback' });
  }
}

// ── GET calling-recording&call_id=... (Basic Auth) ─────────────────────────
// Streams the recording audio through the server so Twilio credentials never
// reach the browser; lib/twilio-recording.mjs only accepts Twilio's own API
// host and Recording resources.
export async function handleCallingRecording(req, res) {
  noStore(res);
  const callId = text(req.query?.call_id);
  if (!callId) return res.status(400).json({ success: false, error: 'call_id is required' });
  try {
    const record = await getRepo().findById(CALLS_TAB, 'call_id', callId);
    if (!record) return res.status(404).json({ success: false, error: 'Call not found' });
    const reference = text(record.obj.recording_sid) || text(record.obj.recording_url);
    if (!reference) return res.status(404).json({ success: false, error: 'No recording on this call yet' });
    const audio = await fetchTwilioRecording(reference);
    res.setHeader('Content-Type', audio.contentType);
    res.setHeader('Content-Length', audio.contentLength);
    return res.status(200).send(audio.bytes);
  } catch (err) {
    return res.status(err?.statusCode === 404 ? 404 : 500).json({ success: false, error: err?.message || 'Could not fetch the recording' });
  }
}
