// api/novus/probe-get.js — GET /api/novus/probe-get?probe_id=...
//                       or  GET /api/novus/probe-get?agency_id=...
//                       or  GET /api/novus/probe-get?next_after=<agency_id>
// Returns a single probe by id (so the PROBE READY view survives a page
// reload), a single agency by id (so the agency-launched probe flow can
// display the agency name), or the NEXT eligible agency after a given one in
// AGENCIES sheet-row order (the "Next agency" workflow). All three modes are
// deliberately folded into this existing route rather than adding new
// serverless functions.

import { getRepo } from '../../lib/sheets.mjs';
import { requireAuth } from './_auth.mjs';

// An agency is probe-eligible when it has a usable Rightmove sales branch page
// to work from and has not been suppressed. Rows marked REVIEW or
// "DELETE - NON-SALES/LETTINGS" carry no branch URL, so the URL check already
// excludes them — this never invents eligibility the sheet doesn't state.
function isProbeEligible(agency) {
  const url = String(agency.rightmove_sales_branch_url ?? '').trim();
  if (!/^https?:\/\//i.test(url)) return false;
  if (String(agency.suppression_status ?? '').trim().toLowerCase() === 'suppressed') return false;
  return true;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const probeId = (req.query?.probe_id || '').trim();
  const agencyId = (req.query?.agency_id || '').trim();
  const nextAfter = (req.query?.next_after || '').trim();
  if (!probeId && !agencyId && !nextAfter) {
    return res.status(400).json({ error: 'Missing probe_id, agency_id or next_after' });
  }

  try {
    const repo = getRepo();

    // Next eligible agency, in the sheet's own row order. getRecords preserves
    // that order, so "next" is simply the first eligible row after this one.
    if (nextAfter) {
      const agencies = await repo.getRecords('AGENCIES', 'agency_id');
      const from = agencies.findIndex((r) => r.obj.agency_id === nextAfter);
      if (from === -1) return res.status(404).json({ error: 'Agency not found' });
      const next = agencies.slice(from + 1).find((r) => isProbeEligible(r.obj));
      if (!next) return res.status(404).json({ error: 'No further eligible agency in the list' });
      return res.status(200).json({ agency: next.obj });
    }

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
