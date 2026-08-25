// api/novus/personalisation.js — GET /api/novus/personalisation?probe_id=...
//                                 GET /api/novus/personalisation?agency_id=...
//
// Read-only lookup for the PERSONALISATION row lib/personalisation-rebuild.mjs
// writes (via the existing /api/novus/intelligence/rebuild-all + cron finalize
// rebuild flow — this file never triggers generation, only reads what's
// already there). One row per probe_id; ?agency_id= returns that agency's
// most recently created row, since an agency can have more than one probe.
//
// This is the single feed point for Instantly variables and the demo compiler.
// Instantly owns the fixed template; NOVUS supplies property_reference,
// email_observation and email_commercial_hook. Both email prose fields come
// from the row's one traceable DIAGNOSIS_FINDINGS selection. This route does
// not touch index.html/api/lead.js's separate legacy demo data source.
//
// Same NOVUS_BASIC_AUTH guard as the rest of /api/novus/*.

import { getRepo } from '../../lib/sheets.mjs';
import { requireAuth } from './_auth.mjs';

export const maxDuration = 20;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const probeId = (req.query?.probe_id || '').trim();
  const agencyId = (req.query?.agency_id || '').trim();
  if (!probeId && !agencyId) {
    return res.status(400).json({ error: 'Missing probe_id or agency_id' });
  }

  try {
    const repo = getRepo();

    if (probeId) {
      const record = await repo.findById('PERSONALISATION', 'probe_id', probeId);
      if (!record) return res.status(404).json({ error: 'No Personalisation found for this probe (probe may not be diagnosed yet)' });
      return res.status(200).json({ personalisation: record.obj });
    }

    const records = await repo.getRecords('PERSONALISATION', 'probe_id');
    const forAgency = records.filter((r) => r.obj.agency_id === agencyId);
    if (forAgency.length === 0) {
      return res.status(404).json({ error: 'No Personalisation found for this agency' });
    }
    forAgency.sort((a, b) => new Date(b.obj.created_at) - new Date(a.obj.created_at));
    return res.status(200).json({ personalisation: forAgency[0].obj });
  } catch (err) {
    console.error('personalisation (get) error:', err);
    return res.status(500).json({ error: err.message || 'Failed to fetch personalisation' });
  }
}
