// api/novus/probe-mark-sent.js — POST /api/novus/probe-mark-sent
// Body: { probe_id }
//
// Joe submits the genuine Rightmove enquiry MANUALLY, then clicks MARK AS SENT.
// This is the moment the observation window opens. The server (not the client)
// records the timestamp so it is authoritative and tamper-resistant:
//
//   probe_status         = "observing"
//   probe_timestamp      = server now (ISO)
//   observation_deadline = probe_timestamp + 7 days (ISO)
//
// Idempotent: if the probe is already observing, the original timestamp/deadline
// are preserved and returned unchanged.

import { getRepo } from '../../lib/sheets.mjs';
import { requireAuth } from './_auth.mjs';

const OBSERVATION_DAYS = 7;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const probeId = (body.probe_id || '').trim();
  if (!probeId) return res.status(400).json({ error: 'Missing probe_id' });

  try {
    const repo = getRepo();
    const record = await repo.findById('PROBES', 'probe_id', probeId);
    if (!record) return res.status(404).json({ error: 'Probe not found' });

    // Already sent → return as-is (do not reset the window).
    if (record.obj.probe_status === 'observing' && record.obj.probe_timestamp) {
      return res.status(200).json({ probe: record.obj, already_sent: true });
    }

    const sentAt = new Date();
    const deadline = new Date(sentAt.getTime() + OBSERVATION_DAYS * 24 * 60 * 60 * 1000);

    const updated = await repo.updateById('PROBES', 'probe_id', probeId, {
      probe_status: 'observing',
      probe_timestamp: sentAt.toISOString(),
      observation_deadline: deadline.toISOString(),
      updated_at: sentAt.toISOString(),
    });
    if (!updated) return res.status(404).json({ error: 'Probe not found' });

    return res.status(200).json({ probe: updated, already_sent: false });
  } catch (err) {
    console.error('probe-mark-sent error:', err);
    return res.status(500).json({ error: err.message || 'Failed to mark probe as sent' });
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
