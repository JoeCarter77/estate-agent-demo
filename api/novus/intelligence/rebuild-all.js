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
// Optional body: { "force_ai": true } — re-runs AI interpretation on every
// probe that isn't yet finalised, even ones already interpreted. Use after a
// prompt change; otherwise leave unset so a routine rebuild costs no AI calls.
// Has no effect on DIAGNOSIS: once a probe is finalised (closed, with a
// non-blank DIAGNOSIS.diagnosis_summary) it is frozen for good — see the
// probe-lifecycle comments in lib/diagnosis-rebuild.mjs and
// lib/intelligence-rebuild.mjs. force_ai only ever touches probes that
// haven't been finalised yet.
//
// BATCHING (fixes 504 FUNCTION_INVOCATION_TIMEOUT on large historical
// datasets): the deterministic pass and the sheet writes are cheap and
// batched, but the AI interpretation/diagnosis calls are awaited one probe
// at a time and are the only part slow enough to blow the maxDuration below.
// So each invocation only runs up to `batch_size` AI calls total (shared
// between interpretation and diagnosis), then returns with `complete: false`
// and a `remaining` count instead of pushing through the whole dataset.
// Resumability needs no cursor: "needs AI" is defined by a blank
// communication_quality/diagnosis_summary field on the row itself
// (lib/intelligence-rebuild.mjs, lib/diagnosis-rebuild.mjs), so simply
// calling this endpoint again continues from wherever the last call stopped
// — same idempotent upsert-by-probe_id as before, safe to rerun, never
// duplicates a row, never touches manual_override'd communications. The
// Apps Script button (google-apps-script/RebuildIntelligence.gs) loops this
// call until `complete: true` and reports one aggregated final result.
//
// Optional body: { "batch_size": N } — override the per-invocation AI-call
// budget (default below / NOVUS_REBUILD_BATCH_SIZE). Mainly for tests.

import { getRepo } from '../../../lib/sheets.mjs';
import { runRebuildPass } from '../../../lib/rebuild-pass.mjs';
import { recomputeProbeObservation } from '../../../lib/observation-recompute.mjs';
import { requireAuth } from '../_auth.mjs';

export const maxDuration = 60;

// Conservative default: ~2-3s per AI call observed in practice, so 15 calls
// leaves comfortable headroom under the 60s maxDuration for the batch's
// reads/writes and any slower-than-average calls.
const DEFAULT_BATCH_SIZE = 15;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const probeId = String(body.probe_id || '').trim();
  const forceAi = body.force_ai === true;
  const batchSize = Number.isFinite(Number(body.batch_size)) && Number(body.batch_size) > 0
    ? Number(body.batch_size)
    : Number(process.env.NOVUS_REBUILD_BATCH_SIZE) || DEFAULT_BATCH_SIZE;

  try {
    const repo = getRepo();

    // Single-probe recompute. Entirely separate operation from the full
    // rebuild below; returns immediately.
    if (probeId) {
      const result = await recomputeProbeObservation(repo, probeId);
      if (!result) return res.status(404).json({ error: `Probe ${probeId} not found` });
      return res.status(200).json(result);
    }

    const summary = await runRebuildPass(repo, { forceAi, maxAiCalls: batchSize });

    return res.status(200).json({ ...summary, batch_size: batchSize });
  } catch (err) {
    console.error('intelligence rebuild-all error:', err);
    return res.status(500).json({ error: err.message || 'Failed to rebuild intelligence' });
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
