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
// No body required for the normal rebuild — behaviour is completely
// unchanged from before.
//
// Optional body: { "backfill_contact_quality": true } additionally runs the
// one-off historical COMMUNICATIONS.contact_quality backfill
// (lib/communications-backfill.mjs) in the same request. This flag exists so
// the backfill can be triggered once against the live sheet WITHOUT adding a
// dedicated Serverless Function (Vercel Hobby's 12-function limit — a
// standalone /api/novus/communications/backfill-contact-quality route was
// removed for exactly this reason). It reuses this route's existing
// NOVUS_BASIC_AUTH gate and live Sheets credentials; every other call to this
// endpoint (no body, or backfill_contact_quality omitted/false) behaves
// exactly as it always has. Safe to leave in place — backfillContactQuality()
// is itself idempotent (see that file) — but remove this branch once the
// one-off backfill has run and been verified, if you'd rather keep this
// route back to doing exactly one thing.

import { getRepo } from '../../../lib/sheets.mjs';
import { rebuildAllIntelligence } from '../../../lib/intelligence-rebuild.mjs';
import { rebuildAllDiagnosis } from '../../../lib/diagnosis-rebuild.mjs';
import { backfillContactQuality } from '../../../lib/communications-backfill.mjs';
import { requireAuth } from '../_auth.mjs';

export const maxDuration = 60;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};

  try {
    const repo = getRepo();
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
