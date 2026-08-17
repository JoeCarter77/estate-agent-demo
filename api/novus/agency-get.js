// api/novus/agency-get.js — GET /api/novus/agency-get?agency_id=...
//
// The agency-specific probe URL resolves through this endpoint: the probe page
// asks "who is this link for?" before it will let a probe be created. It returns
// the CANONICAL AGENCIES.agency_id (not the string from the URL), so the id that
// travels on into probe-create is always the workbook's own value.
//
// 404 with a clear message when the id doesn't resolve — never a fallback agency,
// never a name-based guess.

import { getRepo } from '../../lib/sheets.mjs';
import { resolveAgency, agencyErrorMessage } from '../../lib/agencies.mjs';
import { requireAuth } from './_auth.mjs';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const raw = (req.query?.agency_id || '').toString().trim();

  try {
    const repo = getRepo();
    const resolved = await resolveAgency(repo, raw);
    if (!resolved.ok) {
      const status = resolved.reason === 'missing' ? 400 : 404;
      return res.status(status).json({ error: agencyErrorMessage(resolved.reason, raw), reason: resolved.reason });
    }
    const a = resolved.agency;
    return res.status(200).json({
      agency: {
        agency_id: a.agency_id,
        agency_name: a.agency_name || '',
        website: a.website || '',
        domain: a.domain || '',
        location: a.location || '',
        main_phone: a.main_phone || '',
        primary_contact_email: a.primary_contact_email || '',
      },
    });
  } catch (err) {
    console.error('agency-get error:', err);
    return res.status(500).json({ error: err.message || 'Failed to resolve agency' });
  }
}
