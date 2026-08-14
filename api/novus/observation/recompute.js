// api/novus/observation/recompute.js — POST /api/novus/observation/recompute
//
// Human-triggered HTTP entry point for the Observation & Evidence Engine.
// Uses the same NOVUS_BASIC_AUTH as the rest of the internal /api/novus/*
// surface (requireAuth), not the webhook's ingest secret/signature.
//
// The recompute logic itself lives in lib/observation-recompute.mjs, shared
// with the automatic recompute the communications webhooks trigger after a
// deterministically-matched COMMUNICATIONS row is written — this endpoint is
// a thin req/res wrapper around the exact same code path, kept for manual
// re-runs (e.g. after a manual_override correction) and for anyone driving
// recompute directly rather than waiting for the next inbound communication.
//
// Body: { probe_id }

import { getRepo } from '../../../lib/sheets.mjs';
import { recomputeProbeObservation } from '../../../lib/observation-recompute.mjs';
import { requireAuth } from '../_auth.mjs';

export const maxDuration = 20;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const probeId = String(body.probe_id || '').trim();
  if (!probeId) return res.status(400).json({ error: 'Missing probe_id' });

  try {
    const repo = getRepo();
    const result = await recomputeProbeObservation(repo, probeId);
    if (!result) return res.status(404).json({ error: `Probe ${probeId} not found` });
    return res.status(200).json(result);
  } catch (err) {
    console.error('observation recompute error:', err);
    return res.status(500).json({ error: err.message || 'Failed to recompute observation' });
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
