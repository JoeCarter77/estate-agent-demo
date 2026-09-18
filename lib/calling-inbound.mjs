// lib/calling-inbound.mjs — automatic callback recognition: an incoming call
// on the NOVUS number is matched to its lead(s), rings the operator's browser
// with that identification attached, and — once answered — becomes an
// ordinary CALLS row that the existing Calling Mode saves exactly like an
// outbound call. Plus the ⌘K lead-search operation, because both sit on the
// one lead index in lib/lead-search.mjs.
//
// FLOW.  Twilio → api/novus/webhooks/voice-inbound.js (unchanged entry point,
// still writes RAW_EVENTS + COMMUNICATIONS) → ringInboundCall() here:
//   1. findLeadsByPhone + rankPhoneMatches on the caller id
//   2. open a CALLS row NOW (metadata_json.direction=INBOUND, the ranked
//      candidates, the parent CallSid) — the same "record first, then
//      connect" rule as outbound calling-start
//   3. answer TwiML: <Dial><Client>novus-operator</Client></Dial> carrying the
//      call_id as a custom parameter. The Twilio Voice SDK delivers that to
//      whichever NOVUS page is open as its `incoming` event — that IS the
//      real-time channel; no polling, no sockets, nothing new to run.
// The browser then reads GET calling-inbound&call_id for the overlay, and
// POSTs calling-inbound-intent (decline / handoff / answer / link).
//
// HANDOFF BETWEEN PAGES. The Calling Mode screen lives on calling.html. When
// Joe answers from another page, that page flags intent=handoff, REJECTS the
// ring and navigates to /novus/calling.html?inbound=<call_id>. Rejecting ends
// the <Dial>, Twilio calls the Dial action (handleVoiceInboundAction), which
// sees the handoff flag and rings the client again — by then the calling page
// has registered its Device and auto-answers. The same re-ring covers a
// browser refresh mid-ring (Dial fails because the client vanished) and the
// window before any page has registered. Bounded: MAX_RING_ATTEMPTS, then the
// caller gets the voicemail prompt voice-inbound.js always played.
//
// ROUTING. The Dial action is /api/novus/webhooks/voice-inbound-action, a
// vercel.json rewrite onto personalisation.js?novus_operation=twilio-voice-
// inbound-action (12-function ceiling) — Basic-Auth-exempt via middleware.js,
// signature-verified here. The <Client> status and the recording callbacks
// reuse the OUTBOUND status/recording handlers untouched: they find the CALLS
// row by the parent CallSid, which is exactly the inbound call's own SID.

import { getRepo } from './sheets.mjs';
import { requireTwilioSignature, parseTwilioBody, sendTwiml, escapeXml } from './twilio-webhook.mjs';
import { CALLS_HEADER, CALLS_TAB, callRecords, isDiscardedCall, newCallId, patchCallCells, rowFor } from './calling-store.mjs';
import { invalidateCallingCache } from './calling-handlers.mjs';
import { OPERATOR_IDENTITY, VOICE_STATUS_PATH, VOICE_RECORDING_PATH } from './calling-twilio.mjs';
import { findLeadsByPhone, formatPhoneForDisplay, invalidateLeadIndex, leadSummary, loadLeadIndex, normalizePhoneNumber, rankPhoneMatches, searchLeads } from './lead-search.mjs';

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();
const noStore = (res) => res.setHeader('Cache-Control', 'private, no-store, max-age=0');

export const VOICE_INBOUND_ACTION_PATH = '/api/novus/webhooks/voice-inbound-action';
export const VOICE_RECORDING_CALLBACK_PATH = '/api/novus/webhooks/voice-recording'; // voicemail <Record>, api/novus/webhooks/voice-recording.js
export const RING_TIMEOUT_SECONDS = 25;
export const MAX_RING_ATTEMPTS = 8;
export const HANDOFF_WINDOW_MS = 75_000;
export const RETRY_WINDOW_MS = 45_000;
export const INBOUND_INTENTS = Object.freeze(['decline', 'handoff', 'answer', 'link']);

function baseUrl() { return text(process.env.NOVUS_PUBLIC_BASE_URL).replace(/\/$/, ''); }
function metadataOf(row) { try { return JSON.parse(text(row?.metadata_json) || '{}'); } catch { return {}; } }
export function isInboundCall(row) { return upper(metadataOf(row).direction) === 'INBOUND'; }

// The voicemail prompt voice-inbound.js has always played (moved here so the
// ring path and the fallback share one definition). Recording + transcript go
// to voice-recording.js, which patches the COMMUNICATIONS row by CallSid.
export function voicemailTwimlBody() {
  const base = baseUrl();
  const callbackUrl = base ? `${base}${VOICE_RECORDING_CALLBACK_PATH}` : VOICE_RECORDING_CALLBACK_PATH;
  return [
    '<Say voice="alice">Thanks for calling. Please leave a brief message after the tone and we will get back to you.</Say>',
    `<Record maxLength="120" playBeep="true" transcribe="true" transcribeCallback="${escapeXml(callbackUrl)}" recordingStatusCallback="${escapeXml(callbackUrl)}" recordingStatusCallbackEvent="completed" />`,
    '<Say voice="alice">Thank you, goodbye.</Say>',
  ].join('');
}

// <Dial> to the operator's browser identity. answerOnBridge keeps the caller
// hearing ringback (not silence) until the browser accepts; the call is
// recorded from answer exactly like an outbound dial; the <Client> leg's
// status events and the recording land on the same CALLS row through the
// existing outbound handlers.
export function ringTwimlBody({ callId, from, greet = '' }) {
  const base = baseUrl();
  const action = `${base}${VOICE_INBOUND_ACTION_PATH}`;
  const status = `${base}${VOICE_STATUS_PATH}`;
  const recording = `${base}${VOICE_RECORDING_PATH}`;
  return [
    greet ? `<Say voice="alice">${escapeXml(greet)}</Say>` : '',
    `<Dial timeout="${RING_TIMEOUT_SECONDS}" answerOnBridge="true" action="${escapeXml(action)}"`,
    ` record="record-from-answer-dual" recordingStatusCallback="${escapeXml(recording)}" recordingStatusCallbackEvent="completed">`,
    `<Client statusCallback="${escapeXml(status)}" statusCallbackEvent="initiated ringing answered completed">`,
    `<Identity>${escapeXml(OPERATOR_IDENTITY)}</Identity>`,
    `<Parameter name="call_id" value="${escapeXml(callId)}"/>`,
    `<Parameter name="from" value="${escapeXml(from)}"/>`,
    '</Client></Dial>',
  ].join('');
}

// ── ring: match + open the CALLS row + TwiML ───────────────────────────────
export async function ringInboundCall(repo, { callSid, from, to = '', communicationId = '', rawEventId = '', now = new Date().toISOString() }) {
  const e164 = normalizePhoneNumber(from);
  const calls = callRecords(await repo.getTable(CALLS_TAB));
  const existing = calls.find((row) => text(row.twilio_call_sid) === text(callSid));
  if (existing) return { call_id: text(existing.call_id), reused: true, twiml: ringTwimlBody({ callId: text(existing.call_id), from: e164 || text(from) }) };

  let candidates = [];
  try {
    const index = await loadLeadIndex(repo, { now });
    candidates = rankPhoneMatches(findLeadsByPhone(index, from), { nowMs: Date.parse(now) || Date.now() });
  } catch (err) {
    console.error('voice-inbound: lead lookup failed, ringing as unknown caller:', err);
  }
  const chosen = candidates.find((c) => c.preselected) || null;
  const callId = newCallId();
  const row = {
    ...Object.fromEntries(CALLS_HEADER.map((key) => [key, ''])),
    call_id: callId, agency_id: text(chosen?.agency_id), script_id: '',
    contact_name: text(chosen?.contact_name).slice(0, 120), contact_role: text(chosen?.contact_role).slice(0, 120),
    phone: e164 ? formatPhoneForDisplay(e164) : text(from).slice(0, 40),
    call_mode: 'TWILIO', twilio_call_sid: text(callSid), started_at: now, call_status: 'ringing',
    metadata_json: JSON.stringify({
      direction: 'INBOUND',
      inbound: {
        from: e164 || text(from), to: text(to), communication_id: communicationId, raw_event_id: rawEventId,
        ring_started_at: now, attempts: 1,
        candidates: candidates.map(({ agency_id, agency_name, contact_name, contact_role, score, reasons, preselected, matched_number, matched_source }) => ({ agency_id, agency_name, contact_name, contact_role, score, reasons, preselected: Boolean(preselected), matched_number, matched_source })),
      },
    }),
    created_at: now, updated_at: now,
  };
  await repo.appendRowsBatch(CALLS_TAB, [rowFor(CALLS_HEADER, row)]);
  invalidateCallingCache(); invalidateLeadIndex();
  return { call_id: callId, reused: false, candidates, twiml: ringTwimlBody({ callId, from: e164 || text(from) }) };
}

// ── POST /api/novus/webhooks/voice-inbound-action (Twilio signature) ───────
// The <Dial>'s action: what happens once ringing the browser ends.
//   completed            the conversation happened and has ended → hang up
//   declined (flag)      → voicemail
//   handoff (flag)       → ring again (calling.html is loading)
//   failed / canceled    → ring again while inside the retry window
//                          (client not registered yet, page refreshed)
//   otherwise            → voicemail (nobody answered)
export function planInboundDialAction(row, { status, nowMs }) {
  const meta = metadataOf(row);
  const inbound = meta.inbound || {};
  const attempts = Number(inbound.attempts) || 1;
  const since = (iso) => (Number.isFinite(Date.parse(text(iso))) ? nowMs - Date.parse(text(iso)) : Infinity);
  if (status === 'completed' || status === 'answered') return { action: 'hangup', result: 'answered' };
  if (inbound.declined_at) return { action: 'voicemail', result: 'declined' };
  if (attempts < MAX_RING_ATTEMPTS && inbound.handoff?.at && since(inbound.handoff.at) <= HANDOFF_WINDOW_MS) {
    return { action: 'ring', result: '', greet: inbound.handoff_rings ? '' : 'Connecting you now.', reason: 'handoff' };
  }
  if (attempts < MAX_RING_ATTEMPTS && ['failed', 'canceled'].includes(status) && since(inbound.ring_started_at) <= RETRY_WINDOW_MS) {
    return { action: 'ring', result: '', greet: '', reason: 'retry' };
  }
  return { action: 'voicemail', result: status === 'busy' ? 'busy' : status === 'no-answer' ? 'missed' : (status || 'missed') };
}

export async function handleVoiceInboundAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = parseTwilioBody(req);
  if (!requireTwilioSignature(req, res, VOICE_INBOUND_ACTION_PATH, body)) return;
  const callSid = text(body.CallSid);
  const status = text(body.DialCallStatus).toLowerCase();
  const voicemail = () => sendTwiml(res, voicemailTwimlBody());
  if (!callSid) return voicemail();
  try {
    const repo = getRepo();
    const record = await repo.findById(CALLS_TAB, 'twilio_call_sid', callSid);
    if (!record) return voicemail();
    const row = record.obj;
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const plan = planInboundDialAction(row, { status, nowMs });
    const meta = metadataOf(row);
    meta.inbound = meta.inbound || {};
    const patch = { updated_at: now };
    if (plan.action === 'ring') {
      meta.inbound.attempts = (Number(meta.inbound.attempts) || 1) + 1;
      if (plan.reason === 'handoff') meta.inbound.handoff_rings = (Number(meta.inbound.handoff_rings) || 0) + 1;
      patch.metadata_json = JSON.stringify(meta);
      if (!isDiscardedCall(row)) patch.call_status = 'ringing';
      await patchCallCells(repo, row.call_id, patch);
      invalidateCallingCache();
      return sendTwiml(res, ringTwimlBody({ callId: text(row.call_id), from: text(meta.inbound.from), greet: plan.greet }));
    }
    meta.inbound.result = plan.result;
    meta.inbound.ended_at = now;
    patch.metadata_json = JSON.stringify(meta);
    if (!text(row.ended_at)) patch.ended_at = now;
    if (!isDiscardedCall(row)) {
      if (plan.action === 'hangup') {
        patch.call_status = 'completed';
        const duration = Number(body.DialCallDuration);
        if (Number.isFinite(duration) && !text(row.duration_seconds)) patch.duration_seconds = Math.round(duration);
      } else {
        patch.call_status = plan.result === 'busy' ? 'busy' : plan.result === 'declined' ? 'no-answer' : (['no-answer', 'busy', 'failed', 'canceled'].includes(status) ? status : 'no-answer');
      }
    }
    await patchCallCells(repo, row.call_id, patch);
    invalidateCallingCache(); invalidateLeadIndex();
    return plan.action === 'hangup' ? sendTwiml(res, '<Hangup/>') : voicemail();
  } catch (err) {
    console.error('voice-inbound-action error:', err);
    return voicemail();
  }
}

// ── GET calling-inbound&call_id=… (Basic Auth) ─────────────────────────────
// Everything the overlay shows: the caller, the ranked candidates (re-read
// from the live index so "called 45 minutes ago" is current), and the flags.
export async function handleCallingInbound(req, res) {
  noStore(res);
  const callId = text(req.query?.call_id);
  if (!callId) return res.status(400).json({ success: false, error: 'call_id is required' });
  try {
    const repo = getRepo();
    const record = await repo.findById(CALLS_TAB, 'call_id', callId);
    if (!record || !isInboundCall(record.obj)) return res.status(404).json({ success: false, error: 'Inbound call not found' });
    const row = record.obj;
    const meta = metadataOf(row);
    const inbound = meta.inbound || {};
    const index = await loadLeadIndex(repo);
    const byId = new Map(index.map((entry) => [entry.agency_id, entry]));
    const stored = Array.isArray(inbound.candidates) ? inbound.candidates : [];
    const candidates = stored.map((c) => {
      const entry = byId.get(text(c.agency_id));
      return { ...(entry ? leadSummary(entry) : { agency_id: text(c.agency_id), agency_name: text(c.agency_name) }), ...c };
    });
    const linked = text(row.agency_id) ? byId.get(text(row.agency_id)) : null;
    return res.status(200).json({
      success: true,
      call: {
        call_id: text(row.call_id), agency_id: text(row.agency_id), contact_name: text(row.contact_name), contact_role: text(row.contact_role),
        phone: text(row.phone), call_status: text(row.call_status), started_at: text(row.started_at), connected_at: text(row.connected_at), ended_at: text(row.ended_at),
        twilio_call_sid: text(row.twilio_call_sid), outcome: text(row.outcome), script_id: text(row.script_id),
      },
      caller: { e164: text(inbound.from), display: formatPhoneForDisplay(text(inbound.from)) || text(row.phone) },
      inbound: { ...inbound, candidates: undefined },
      candidates,
      linked_lead: linked ? leadSummary(linked) : null,
    });
  } catch (err) {
    console.error('calling-inbound error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Could not read the inbound call' });
  }
}

// ── POST calling-inbound-intent (Basic Auth) ───────────────────────────────
// decline  → the Dial action sends the caller to voicemail
// handoff  → the Dial action rings again; the calling page answers on arrival
// answer   → this lead (or none, for an unknown caller) is on the line now
// link     → associate the number/call with a lead during or after the call
export async function handleCallingInboundIntent(req, res) {
  noStore(res);
  if (text(req.body?.confirm) !== 'INBOUND_CALL') return res.status(400).json({ success: false, error: 'Missing confirm=INBOUND_CALL' });
  const callId = text(req.body?.call_id);
  const intent = text(req.body?.intent).toLowerCase();
  if (!callId) return res.status(400).json({ success: false, error: 'call_id is required' });
  if (!INBOUND_INTENTS.includes(intent)) return res.status(400).json({ success: false, error: `intent must be one of ${INBOUND_INTENTS.join(', ')}` });
  try {
    const repo = getRepo();
    const record = await repo.findById(CALLS_TAB, 'call_id', callId);
    if (!record || !isInboundCall(record.obj)) return res.status(404).json({ success: false, error: 'Inbound call not found' });
    const row = record.obj;
    if (isDiscardedCall(row)) return res.status(409).json({ success: false, error: 'This call was discarded' });
    const now = new Date().toISOString();
    const meta = metadataOf(row);
    meta.inbound = meta.inbound || {};
    const patch = { updated_at: now };
    const agencyId = text(req.body?.agency_id);
    const selection = { agency_id: agencyId, contact_name: text(req.body?.contact_name).slice(0, 120), contact_role: text(req.body?.contact_role).slice(0, 120), script_id: text(req.body?.script_id).slice(0, 80) };

    if (intent === 'decline') meta.inbound.declined_at = now;
    if (intent === 'handoff') meta.inbound.handoff = { at: now, ...selection };
    if (intent === 'answer' || intent === 'link') {
      if (agencyId) {
        const [agency, callsTable] = await Promise.all([repo.findById('AGENCIES', 'agency_id', agencyId), repo.getTable(CALLS_TAB)]);
        if (!agency) return res.status(404).json({ success: false, error: 'Agency not found' });
        patch.agency_id = agencyId;
        if (selection.contact_name || text(row.agency_id) !== agencyId) patch.contact_name = selection.contact_name;
        if (selection.contact_role || text(row.agency_id) !== agencyId) patch.contact_role = selection.contact_role;
        if (selection.script_id) patch.script_id = selection.script_id;
        patch.attempt_number = callRecords(callsTable).filter((c) => text(c.agency_id) === agencyId && text(c.outcome) && !isDiscardedCall(c) && text(c.call_id) !== callId).length + 1;
        meta.inbound.linked_at = now;
      }
      if (intent === 'answer') {
        meta.inbound.answered_at = meta.inbound.answered_at || now;
        meta.inbound.result = 'answered';
        if (!text(row.connected_at)) patch.connected_at = now;
        if (!['in-progress', 'completed'].includes(text(row.call_status).toLowerCase())) patch.call_status = 'in-progress';
      }
    }
    patch.metadata_json = JSON.stringify(meta);
    const saved = await patchCallCells(repo, callId, patch);
    invalidateCallingCache(); invalidateLeadIndex();
    return res.status(200).json({ success: true, intent, call: saved });
  } catch (err) {
    console.error('calling-inbound-intent error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Could not record the inbound intent' });
  }
}

// ── GET lead-search&q=… (Basic Auth) ───────────────────────────────────────
// READ-ONLY. The ⌘K palette. Same index, same phone path as the ring above.
export async function handleLeadSearch(req, res) {
  noStore(res);
  const q = text(req.query?.q).slice(0, 120);
  const limit = Math.min(30, Math.max(1, Number(req.query?.limit) || 12));
  const started = Date.now();
  try {
    const repo = getRepo();
    const index = await loadLeadIndex(repo, { refresh: String(req.query?.refresh || '') === '1' });
    const results = q ? searchLeads(index, q, { limit, nowMs: Date.now() }) : [];
    return res.status(200).json({ success: true, query: q, results, total_leads: index.length, took_ms: Date.now() - started });
  } catch (err) {
    console.error('lead-search error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Search failed' });
  }
}
