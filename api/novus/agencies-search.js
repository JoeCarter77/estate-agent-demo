// api/novus/agencies-search.js — GET /api/novus/agencies-search?q=...
//
// Powers the agency picker on /novus/probe. Every probe MUST name the agency
// it is probing: an unlinked probe can never be matched to an inbound reply
// (matchProbe filters on agency_id), so it silently collects no evidence.
//
// Read-only, Basic-Auth gated like the rest of the internal surface. Returns
// only the fields the picker needs, plus the two signals that decide whether
// this agency's replies will actually match — so Joe can see BEFORE probing
// that an agency has no usable domain or phone on file.

import { getRepo } from '../../lib/sheets.mjs';
import { requireAuth } from './_auth.mjs';

export const maxDuration = 20;

const LIMIT = 25;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const q = String(req.query?.q || '').trim().toLowerCase();

  try {
    const repo = getRepo();
    const agencies = await repo.getRecords('AGENCIES', 'agency_id');

    const matches = agencies
      .map(({ obj }) => obj)
      // Suppressed agencies (and the synthetic test fixture) must never be
      // offered as a real probe target.
      .filter((a) => String(a.suppression_status || '').toLowerCase() !== 'suppressed')
      .filter((a) => {
        if (!q) return true;
        return [a.agency_name, a.domain, a.location, a.main_phone, a.agency_id]
          .some((v) => String(v || '').toLowerCase().includes(q));
      })
      .slice(0, LIMIT)
      .map((a) => ({
        agency_id: a.agency_id,
        agency_name: a.agency_name,
        domain: a.domain,
        location: a.location,
        main_phone: a.main_phone,
        primary_contact_email: a.primary_contact_email,
        // Surfaced so the operator can see an agency whose replies could only
        // be matched by the per-probe address, before committing to a probe.
        has_match_signal: Boolean(a.domain || a.main_phone),
      }));

    return res.status(200).json({ agencies: matches, count: matches.length });
  } catch (err) {
    console.error('agencies-search error:', err);
    return res.status(500).json({ error: err.message || 'Failed to search agencies' });
  }
}
