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
// No body required for the normal full rebuild — behaviour is completely
// unchanged from before.
//
// Optional body: { "probe_id": "..." } — SINGLE-PROBE recompute instead of a
// full rebuild (was the separate api/novus/observation/recompute.js route,
// folded in here to stay within Vercel Hobby's 12-function limit; the logic
// itself, lib/observation-recompute.mjs, is untouched and is the same code
// path the communications webhooks trigger automatically). Returns exactly
// what that route always returned — NOT wrapped in the full-rebuild summary
// shape — and short-circuits before touching DIAGNOSIS or any backfill.
//
// Optional body: { "backfill_contact_quality": true } additionally runs the
// one-off historical COMMUNICATIONS.contact_quality backfill
// (lib/communications-backfill.mjs) in the same request, on top of a normal
// full rebuild. This flag exists so the backfill can be triggered once
// against the live sheet WITHOUT its own dedicated Serverless Function (a
// standalone /api/novus/communications/backfill-contact-quality route was
// removed for exactly this reason). Safe to leave in place —
// backfillContactQuality() is itself idempotent (see that file) — but remove
// this branch once the one-off backfill has run and been verified, if you'd
// rather keep this route doing fewer things.

import { getRepo } from '../../../lib/sheets.mjs';
import { rebuildAllIntelligence } from '../../../lib/intelligence-rebuild.mjs';
import { rebuildAllDiagnosis } from '../../../lib/diagnosis-rebuild.mjs';
import { backfillContactQuality } from '../../../lib/communications-backfill.mjs';
import { recomputeProbeObservation } from '../../../lib/observation-recompute.mjs';
import { requireAuth } from '../_auth.mjs';

export const maxDuration = 60;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const probeId = String(body.probe_id || '').trim();

  try {
    const repo = getRepo();

    // Single-probe recompute — was observation/recompute.js. Entirely
    // separate operation from the full rebuild below; returns immediately.
    if (probeId) {
      const result = await recomputeProbeObservation(repo, probeId);
      if (!result) return res.status(404).json({ error: `Probe ${probeId} not found` });
      return res.status(200).json(result);
    }

    const intelligenceSummary = await rebuildAllIntelligence(repo);
    const diagnosisSummary = await rebuildAllDiagnosis(repo);
    const response = { ...intelligenceSummary, diagnosis: diagnosisSummary };

    if (body.backfill_contact_quality === true) {
      response.contact_quality_backfill = await backfillContactQuality(repo);
    }

    return res.status(200).json(response);
  } catch (err) {
    console.error('intelligence rebuild-all error:', err);
    return res.status(500).json({ error: err.message || 'Failed to rebuild intelligence' });
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
