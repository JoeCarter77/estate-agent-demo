// api/novus/intelligence/rebuild-all.js — POST /api/novus/intelligence/rebuild-all
//
// Manual "Rebuild All Intelligence" action — the canonical full-rebuild path:
// PROBES -> find matched COMMUNICATIONS -> calculate evidence -> calculate
// A-H grade -> create/update INTELLIGENCE, for every probe currently in the
// sheet. Then, for every INTELLIGENCE row whose observation_status is
// 'closed', rebuilds DIAGNOSIS the same way (lib/diagnosis-rebuild.mjs) — a
// pure commercial read of the grade just computed, no new evidence/grading.
// Same NOVUS_BASIC_AUTH guard as the rest of /api/novus/*.
//
// Idempotent by construction: both rebuild steps upsert exactly one row per
// probe_id — running this twice produces the same INTELLIGENCE/DIAGNOSIS
// rows both times, never duplicates.
//
// No body required.

import { getRepo } from '../../../lib/sheets.mjs';
import { rebuildAllIntelligence } from '../../../lib/intelligence-rebuild.mjs';
import { rebuildAllDiagnosis } from '../../../lib/diagnosis-rebuild.mjs';
import { requireAuth } from '../_auth.mjs';

export const maxDuration = 60;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  try {
    const repo = getRepo();
    const intelligenceSummary = await rebuildAllIntelligence(repo);
    const diagnosisSummary = await rebuildAllDiagnosis(repo);
    return res.status(200).json({ ...intelligenceSummary, diagnosis: diagnosisSummary });
  } catch (err) {
    console.error('intelligence rebuild-all error:', err);
    return res.status(500).json({ error: err.message || 'Failed to rebuild intelligence' });
  }
}
