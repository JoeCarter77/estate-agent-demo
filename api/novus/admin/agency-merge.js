// api/novus/admin/agency-merge.js — POST /api/novus/admin/agency-merge
// Body: { retain_agency_id, delete_agency_id, notes_addendum?, dry_run? }
//
// Merges a confirmed-duplicate AGENCIES record into another: repoints every
// dependent PROBES/COMMUNICATIONS/INTELLIGENCE/ACTIONS row, merges list-type
// fields (known_phone_numbers, other_known_emails) and rightmove_* data onto
// the retained row, appends to its notes, then removes the duplicate row.
//
// dry_run DEFAULTS TO TRUE. A dry run performs zero writes and returns the
// exact same dependents-before / patch / warnings the real run will produce.
//
// Which agency_id is "retained" vs "deleted" is a human decision — this
// endpoint does not infer it. See lib/agency-merge.mjs for the safety model
// (never overwrites a non-blank retained field; refuses to delete unless zero
// dependents remain after repointing).

import { getRepo } from '../../../lib/sheets.mjs';
import { planAgencyMerge, executeAgencyMerge } from '../../../lib/agency-merge.mjs';
import { requireAuth } from '../_auth.mjs';

export const maxDuration = 30;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const retain_agency_id = String(body.retain_agency_id || '').trim();
  const delete_agency_id = String(body.delete_agency_id || '').trim();
  const notes_addendum = body.notes_addendum ? String(body.notes_addendum) : undefined;
  const dryRun = body.dry_run === undefined ? true : Boolean(body.dry_run);

  if (!retain_agency_id || !delete_agency_id) {
    return res.status(400).json({ error: 'Both retain_agency_id and delete_agency_id are required' });
  }

  try {
    const repo = getRepo();
    if (dryRun) {
      const plan = await planAgencyMerge(repo, { retain_agency_id, delete_agency_id, notes_addendum });
      return res.status(200).json({ dry_run: true, plan });
    }
    const result = await executeAgencyMerge(repo, { retain_agency_id, delete_agency_id, notes_addendum });
    return res.status(200).json({ dry_run: false, result });
  } catch (err) {
    console.error('agency-merge error:', err);
    return res.status(500).json({ error: err.message || 'Agency merge failed' });
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
