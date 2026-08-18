// api/novus/intelligence/rebuild-all.js — POST /api/novus/intelligence/rebuild-all
//
// Manual "Rebuild All Intelligence" action — the canonical full-rebuild path:
// PROBES -> find matched COMMUNICATIONS -> calculate evidence -> calculate
// A-H grade -> create/update INTELLIGENCE, for every probe currently in the
// sheet. Same NOVUS_BASIC_AUTH guard as the rest of /api/novus/*.
//
// Idempotent by construction: it calls the same recomputeProbeObservation()
// used everywhere else, which upserts exactly one INTELLIGENCE row per
// probe_id — running this twice produces the same INTELLIGENCE rows both
// times, never duplicates.
//
// No body required.

import { getRepo } from '../../../lib/sheets.mjs';
import { rebuildAllIntelligence } from '../../../lib/intelligence-rebuild.mjs';
import { requireAuth } from '../_auth.mjs';

export const maxDuration = 60;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  try {
    const repo = getRepo();
    const summary = await rebuildAllIntelligence(repo);
    return res.status(200).json(summary);
  } catch (err) {
    console.error('intelligence rebuild-all error:', err);
    return res.status(500).json({ error: err.message || 'Failed to rebuild intelligence' });
  }
}
