// api/novus/intelligence/rebuild-all.js — POST /api/novus/intelligence/rebuild-all
//
// Manual "Rebuild All Intelligence" action — the canonical full-rebuild path
// (V2 schema, docs/V2_COMMS_INTELLIGENCE_DIAGNOSIS_SCHEMA.md §6):
// PROBES -> find matched COMMUNICATIONS -> recompute deterministic evidence
// + A-H grade -> AI-interpret (only where that hasn't run before, or when
// forced) -> create/update INTELLIGENCE, for every probe currently in the
// sheet. Then, for every INTELLIGENCE row whose observation_status is
// 'closed', rebuilds DIAGNOSIS the same way (lib/diagnosis-rebuild.mjs) — a
// pure commercial read of the INTELLIGENCE row just computed, no new
// evidence, no grading, and the grade is never used to select the result.
// Same NOVUS_BASIC_AUTH guard as the rest of /api/novus/*.
//
// Idempotent by construction: both rebuild steps upsert exactly one row per
// probe_id — running this twice produces the same INTELLIGENCE/DIAGNOSIS
// rows both times, never duplicates, and makes zero further AI calls once
// every row has been interpreted/diagnosed.
//
// No body required for the normal full rebuild.
//
// Optional body: { "probe_id": "..." } — SINGLE-PROBE recompute instead of a
// full rebuild (lib/observation-recompute.mjs — the same code path the
// communications webhooks trigger automatically). Returns exactly what that
// path returns, NOT wrapped in the full-rebuild summary shape, and
// short-circuits before touching the full-rebuild path.
//
// Optional body: { "force_ai": true } — re-runs AI interpretation/diagnosis
// on every probe, even ones already interpreted/diagnosed. Use after a
// prompt change; otherwise leave unset so a routine rebuild costs no AI calls.

import { getRepo } from '../../../lib/sheets.mjs';
import { rebuildAllIntelligence } from '../../../lib/intelligence-rebuild.mjs';
import { rebuildAllDiagnosis } from '../../../lib/diagnosis-rebuild.mjs';
import { recomputeProbeObservation } from '../../../lib/observation-recompute.mjs';
import { requireAuth } from '../_auth.mjs';

export const maxDuration = 60;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const probeId = String(body.probe_id || '').trim();
  const forceAi = body.force_ai === true;

  try {
    const repo = getRepo();

    // Single-probe recompute. Entirely separate operation from the full
    // rebuild below; returns immediately.
    if (probeId) {
      const result = await recomputeProbeObservation(repo, probeId);
      if (!result) return res.status(404).json({ error: `Probe ${probeId} not found` });
      return res.status(200).json(result);
    }

    const intelligenceSummary = await rebuildAllIntelligence(repo, { forceAi });

    // DIAGNOSIS prompts need the probe's property/price for context —
    // loaded once here rather than inside the rebuild loop.
    const probeRecords = await repo.getRecords('PROBES', 'probe_id');
    const probesById = new Map(probeRecords.map((r) => [r.obj.probe_id, r.obj]));

    const diagnosisSummary = await rebuildAllDiagnosis(repo, probesById, { forceAi });
    const response = { ...intelligenceSummary, diagnosis: diagnosisSummary };

    return res.status(200).json(response);
  } catch (err) {
    console.error('intelligence rebuild-all error:', err);
    return res.status(500).json({ error: err.message || 'Failed to rebuild intelligence' });
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
