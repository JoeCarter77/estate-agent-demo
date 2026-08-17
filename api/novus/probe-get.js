// api/novus/probe-get.js — GET /api/novus/probe-get?probe_id=...
//                       or  GET /api/novus/probe-get?agency_id=...
// Returns a single probe by id (so the PROBE READY view survives a page
// reload), or a single agency by id (so the agency-launched probe flow can
// display the agency name without a separate endpoint/serverless function —
// deliberately folded into this existing route rather than adding a new one).

import { getRepo } from '../../lib/sheets.mjs';
import { requireAuth } from './_auth.mjs';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const probeId = (req.query?.probe_id || '').trim();
  const agencyId = (req.query?.agency_id || '').trim();
  if (!probeId && !agencyId) return res.status(400).json({ error: 'Missing probe_id or agency_id' });

  try {
    const repo = getRepo();

    if (agencyId) {
      const record = await repo.findById('AGENCIES', 'agency_id', agencyId);
      if (!record) return res.status(404).json({ error: 'Agency not found' });
      return res.status(200).json({ agency: record.obj });
    }

    const record = await repo.findById('PROBES', 'probe_id', probeId);
    if (!record) return res.status(404).json({ error: 'Probe not found' });
    return res.status(200).json({ probe: record.obj });
  } catch (err) {
    console.error('probe-get error:', err);
    return res.status(500).json({ error: err.message || 'Failed to fetch probe/agency' });
  }
}
