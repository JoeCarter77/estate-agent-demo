// api/novus/intelligence/finalize.js — GET /api/novus/intelligence/finalize
//
// Vercel Cron entry point (see the "crons" entry in vercel.json) that
// automatically closes/finalises probes once their 4-day observation window
// has elapsed — the probe lifecycle:
//
//   PROBE SENT -> communications arrive -> INTELLIGENCE updates in real time
//   (api/novus/webhooks/*.js -> lib/observation-recompute.mjs, unchanged)
//   -> 4 days after the probe was sent, the probe closes -> final
//   INTELLIGENCE is calculated from everything received during those 4 days
//   -> final DIAGNOSIS is generated once -> DIAGNOSIS is frozen.
//
// WHY A CRON, AND WHY *THIS* ENDPOINT: closing a probe on schedule needs
// something to actually run at/after its deadline even when nothing else
// happens to it. A probe that receives communications gets recomputed every
// time one arrives (lib/observation-recompute.mjs, unchanged by this file),
// and that recompute already closes+diagnoses it the moment a recompute
// happens to land on/after the deadline. But a probe that receives ZERO
// communications during its window has nothing to trigger a recompute at
// all — lib/grading.mjs's grade for it stays 'pending' forever unless
// something re-evaluates it after the deadline passes. This endpoint is that
// "something": it is exactly lib/rebuild-pass.mjs's runRebuildPass() (the
// SAME combined Intelligence-then-Diagnosis pass the human "Rebuild
// Intelligence" button runs) called on a Cron schedule instead of a click.
// No new evidence pipeline, no new close logic — every closed-and-diagnosed
// probe here went through the identical lib/intelligence-fields.mjs +
// lib/probe-diagnosis.mjs code the rest of the system already uses.
//
// Calling this repeatedly is cheap and safe: lib/intelligence-rebuild.mjs
// only spends an AI call on a probe that's never been interpreted (or is
// forced — this endpoint never forces), lib/diagnosis-rebuild.mjs only ever
// diagnoses a probe once (never regenerates a written diagnosis_summary, no
// matter how many times this fires), and a finalised probe (closed + a
// non-blank DIAGNOSIS.diagnosis_summary) is skipped entirely by both steps —
// it is frozen. Bounded to `batch_size` AI calls per invocation, same
// reasoning as api/novus/intelligence/rebuild-all.js's BATCHING note: if a
// tick can't finish everything newly-eligible for closure, the next tick
// simply continues where this one left off (idempotent upsert-by-probe_id,
// no cursor needed).
//
// AUTH: Cron requests aren't a human with the NOVUS_BASIC_AUTH password, and
// they aren't a provider webhook with a payload to verify either — Vercel
// calls this on its own schedule. Verified with a shared secret sent as
// `Authorization: Bearer <secret>`, matching Vercel's own documented
// convention for securing Cron Job endpoints. Vercel ONLY auto-attaches that
// header — on both its scheduled firing AND the dashboard's manual "Run"
// button — when the env var holding the secret is named EXACTLY
// `CRON_SECRET` (see https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs).
// A differently-named var (e.g. the NOVUS_CRON_SECRET this endpoint used to
// check) never gets attached at all, so every invocation — cron or manual
// Run — 401s before runRebuildPass() ever runs, silently leaving every
// probe stuck at 'observing' no matter how expired its deadline is. Set
// CRON_SECRET as a Vercel env var. NOVUS_CRON_SECRET is still accepted as a
// fallback name (for anyone who already configured it under the old name),
// but only CRON_SECRET gets Vercel's automatic header — this handler checks
// it explicitly either way, the same requireIngestSecret-style pattern
// api/novus/webhooks/email-inbound.js uses.
//
// Schedule granularity: see the "crons" entry in vercel.json. Vercel Hobby
// projects are limited to once-daily Cron invocations; Pro/Enterprise allow
// much finer granularity. Whichever cadence is configured, a probe closes
// correctly and idempotently the next time this fires at/after its deadline
// — the schedule only controls how much lateness ("4 days" becomes "4 days
// plus up to one tick") is acceptable, never correctness.

import crypto from 'node:crypto';
import { getRepo } from '../../../lib/sheets.mjs';
import { runRebuildPass } from '../../../lib/rebuild-pass.mjs';

export const maxDuration = 60;

// Same conservative reasoning as api/novus/intelligence/rebuild-all.js's
// DEFAULT_BATCH_SIZE.
const DEFAULT_BATCH_SIZE = 15;

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function requireCronSecret(req, res) {
  // CRON_SECRET must come first: it's the only name Vercel will ever
  // auto-attach an Authorization header for. NOVUS_CRON_SECRET is a
  // fallback for a value already configured under the old name.
  const expected = process.env.CRON_SECRET || process.env.NOVUS_CRON_SECRET;
  if (!expected) {
    res.status(500).json({ error: 'CRON_SECRET is not configured' });
    return false;
  }
  const header = req.headers?.authorization || '';
  const [scheme, provided] = header.split(' ');
  if (scheme === 'Bearer' && provided && safeEqual(provided, expected)) return true;
  res.status(401).json({ error: 'Invalid or missing cron secret' });
  return false;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireCronSecret(req, res)) return;

  const batchSize = Number(process.env.NOVUS_REBUILD_BATCH_SIZE) || DEFAULT_BATCH_SIZE;

  try {
    const repo = getRepo();
    const summary = await runRebuildPass(repo, {
      maxAiCalls: batchSize,
      rebuildOutbound: true,
    });
    return res.status(200).json({ ...summary, batch_size: batchSize });
  } catch (err) {
    console.error('intelligence finalize (cron) error:', err);
    return res.status(500).json({ error: err.message || 'Failed to finalise expired probes' });
  }
}
