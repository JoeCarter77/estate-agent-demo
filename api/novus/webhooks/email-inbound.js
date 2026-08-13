// api/novus/webhooks/email-inbound.js — POST /api/novus/webhooks/email-inbound
//
// Milestone 1 entry point for the email adapter (e.g. Make watching the
// joe.novus2@gmail.com probe inbox). The adapter POSTs a canonical JSON event;
// this handler is the ONLY thing that talks to lib/sheets.mjs for it — Make
// (or any adapter) never writes to Google Sheets directly.
//
// Flow: RAW_EVENTS (idempotent on provider+provider_event_id) → deterministic
// Agency match → deterministic Probe match (only if Agency matched) →
// COMMUNICATIONS. AI classification/summarisation/Intelligence/Actions are
// explicitly out of scope for this milestone and are not touched here.
//
// AUTH: this lives under /api/novus/webhooks/*, which middleware.js already
// excludes from the human NOVUS_BASIC_AUTH — webhooks are verified by a
// shared secret instead (NOVUS_INGEST_SECRET), never the human password.
//
// Body (adapter-normalised, not a raw Gmail payload):
//   provider            e.g. "gmail"                          (default "gmail")
//   provider_event_id   adapter/provider event id — REQUIRED, drives idempotency
//   channel             must be "email" in this milestone      (default "email")
//   event_type          e.g. "message.received"                (default "message.received")
//   occurred_at         when the email was actually sent/received (ISO-ish)
//   received_at         when the adapter observed it (ISO-ish); defaults to occurred_at/now
//   from                sender email address                   REQUIRED
//   to                  destination identifier (the probe inbox)
//   display_name        sender display name, if known
//   subject, body_text  email evidence
//   email_message_id, email_thread_id
//   raw_content         full raw evidence if the adapter has more than body_text

import crypto from 'node:crypto';
import { getRepo } from '../../../lib/sheets.mjs';
import { newRawEventId, newCommunicationId } from '../../../lib/ids.mjs';
import { normalizeEmail, canonicalTimestamp } from '../../../lib/normalize.mjs';
import { matchAgency, matchProbe } from '../../../lib/matching.mjs';

export const maxDuration = 20;

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Returns true if authorised; otherwise writes the response and returns false.
function requireIngestSecret(req, res) {
  const expected = process.env.NOVUS_INGEST_SECRET;
  if (!expected) {
    res.status(500).json({ error: 'NOVUS_INGEST_SECRET is not configured' });
    return false;
  }
  const provided = req.headers?.['x-novus-ingest-secret'] || '';
  if (!provided || !safeEqual(provided, expected)) {
    res.status(401).json({ error: 'Invalid or missing ingest secret' });
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireIngestSecret(req, res)) return;

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};

  const provider = String(body.provider || 'gmail').trim();
  const providerEventId = String(body.provider_event_id || '').trim();
  const channel = String(body.channel || 'email').trim();
  const fromRaw = String(body.from || '').trim();

  if (channel !== 'email') {
    return res.status(400).json({ error: 'This endpoint only accepts channel="email" in Milestone 1' });
  }
  if (!providerEventId) return res.status(400).json({ error: 'Missing provider_event_id' });
  if (!fromRaw) return res.status(400).json({ error: 'Missing from' });

  try {
    const repo = getRepo();

    // Idempotency: a redelivered provider event must stay ONE logical event —
    // no second RAW_EVENTS row, no second COMMUNICATIONS row.
    const existingEvents = await repo.getRecords('RAW_EVENTS', 'raw_event_id');
    const dup = existingEvents.find(
      (r) => r.obj.provider === provider && r.obj.provider_event_id === providerEventId
    );
    if (dup) {
      return res.status(200).json({
        duplicate: true,
        raw_event_id: dup.obj.raw_event_id,
        processing_status: dup.obj.processing_status,
        processed_communication_id: dup.obj.processed_communication_id || '',
      });
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const occurredAt = canonicalTimestamp(body.occurred_at) || nowIso;
    const receivedAt = canonicalTimestamp(body.received_at) || nowIso;

    // 1) Immutable raw evidence, written before any interpretation happens.
    const rawEventId = newRawEventId();
    await repo.appendRecord('RAW_EVENTS', {
      raw_event_id: rawEventId,
      provider,
      provider_event_id: providerEventId,
      channel,
      event_type: String(body.event_type || 'message.received').trim(),
      received_at: receivedAt,
      occurred_at: occurredAt,
      source_identifier: fromRaw,
      destination_identifier: String(body.to || '').trim(),
      payload_reference: safeStringify(body).slice(0, 45000),
      processing_status: 'received',
      processed_communication_id: '',
      error_message: '',
      created_at: nowIso,
    });

    // 2) Deterministic Agency match, then (only if matched) deterministic
    // Probe match. Neither step ever guesses — ambiguous/unmatched stays that way.
    const senderEmail = normalizeEmail(fromRaw);
    const agencyResult = await matchAgency(repo, senderEmail);

    let matchStatus = agencyResult.match_status;
    let matchingMethod = agencyResult.matching_method;
    let matchScore = agencyResult.match_score;
    const agencyId = agencyResult.agency_id;
    let probeId = '';

    if (agencyResult.match_status === 'matched') {
      const probeResult = await matchProbe(repo, agencyId, now);
      if (probeResult.status === 'matched') {
        probeId = probeResult.probe_id;
        matchStatus = 'matched';
      } else if (probeResult.status === 'ambiguous') {
        // Agency is unambiguous but the probe isn't — the communication as a
        // whole is not fully resolved, so it is not reported as fully matched.
        matchStatus = 'ambiguous';
        matchingMethod = '';
        matchScore = 0;
      } else {
        // Agency known, but no active probe to attach — never guessed.
        matchStatus = 'unmatched';
        matchingMethod = '';
        matchScore = 0;
      }
    }

    // 3) The Communication Event. Only exact-signal outcomes reach here.
    const communicationId = newCommunicationId();
    await repo.appendRecord('COMMUNICATIONS', {
      communication_id: communicationId,
      agency_id: agencyId,
      probe_id: probeId,
      occurred_at: occurredAt,
      received_at: receivedAt,
      channel: 'email',
      direction: 'inbound',
      communication_type: 'email',
      provider,
      provider_event_id: providerEventId,
      source_identifier_raw: senderEmail.raw,
      source_identifier_normalized: senderEmail.normalized,
      destination_identifier: String(body.to || '').trim(),
      display_name: String(body.display_name || '').trim(),
      email_message_id: String(body.email_message_id || '').trim(),
      email_thread_id: String(body.email_thread_id || '').trim(),
      subject: String(body.subject || '').trim(),
      body_text: body.body_text || '',
      raw_content: body.raw_content || body.body_text || '',
      raw_payload_reference: rawEventId,
      matching_method: matchingMethod,
      match_score: matchScore,
      match_status: matchStatus,
      manual_review_status: matchStatus === 'matched' ? 'not_required' : 'pending',
      created_at: nowIso,
      updated_at: nowIso,
    });

    await repo.updateById('RAW_EVENTS', 'raw_event_id', rawEventId, {
      processing_status: 'processed',
      processed_communication_id: communicationId,
    });

    return res.status(200).json({
      duplicate: false,
      raw_event_id: rawEventId,
      communication_id: communicationId,
      match_status: matchStatus,
      matching_method: matchingMethod,
      agency_id: agencyId,
      probe_id: probeId,
    });
  } catch (err) {
    console.error('email-inbound error:', err);
    return res.status(500).json({ error: err.message || 'Failed to ingest email event' });
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
function safeStringify(o) { try { return JSON.stringify(o); } catch { return ''; } }
