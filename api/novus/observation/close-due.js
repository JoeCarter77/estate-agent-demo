// api/novus/observation/close-due.js — POST|GET /api/novus/observation/close-due
//
// Closes every probe whose four-day observation window has expired.
//
// WHY THIS ENDPOINT IS NECESSARY
// Intelligence was previously recomputed ONLY when a matched communication
// arrived. That leaves the single most commercially significant outcome
// unreachable: a probe that gets NO response never triggers a recompute, so it
// never gets an INTELLIGENCE row, and Grade H — "no meaningful response after
// the four-day window closes" — could never actually be assigned. The worst
// agencies looked identical to probes that had not finished yet.
//
// Closing is time-driven, not event-driven, so it needs its own trigger. This
// endpoint is that trigger: it sweeps PROBES for expired windows, recomputes
// each one from whatever evidence exists (none, in the H case), and marks the
// probe closed so it stops competing for inbound matches.
//
// AUTH: dual. Vercel Cron calls carry a bearer token (CRON_SECRET) and no
// human password; a human re-running the sweep uses NOVUS_BASIC_AUTH. Either
// is sufficient, neither is bypassable.
//
// Idempotent: a probe already closed is skipped, so repeated runs (cron retry,
// manual re-run) never double-write or reopen anything.

import crypto from 'node:crypto';
import { getRepo } from '../../../lib/sheets.mjs';
import { recomputeProbeObservation } from '../../../lib/observation-recompute.mjs';
import { requireAuth } from '../_auth.mjs';

export const maxDuration = 60;

// Probes eligible for closing. A draft never started, so it cannot expire.
const CLOSEABLE_STATUSES = new Set(['observing']);

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`.
function isCronRequest(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = String(req.headers?.authorization || '');
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return false;
  return safeEqual(token, secret);
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Cron first — a scheduled call has no human credentials to offer.
  if (!isCronRequest(req)) {
    if (!requireAuth(req, res)) return;
  }

  const now = new Date();

  try {
    const repo = getRepo();
    const probes = await repo.getRecords('PROBES', 'probe_id');

    const due = probes.filter(({ obj }) => {
      if (!CLOSEABLE_STATUSES.has(String(obj.probe_status || '').toLowerCase())) return false;
      if (String(obj.observation_closed_at || '').trim()) return false; // already closed
      const deadline = obj.observation_deadline ? new Date(obj.observation_deadline) : null;
      if (!deadline || Number.isNaN(deadline.getTime())) return false;
      return now.getTime() >= deadline.getTime();
    });

    const closed = [];
    const failed = [];

    for (const { obj } of due) {
      try {
        // Recompute FIRST, while the probe is still 'observing'. The grading
        // engine derives "window closed" from the deadline, not the status, so
        // this produces the final grade (H when there is no evidence) and
        // writes the INTELLIGENCE row that a silent probe would otherwise
        // never get.
        const result = await recomputeProbeObservation(repo, obj.probe_id);

        await repo.updateById('PROBES', 'probe_id', obj.probe_id, {
          probe_status: 'closed',
          observation_closed_at: obj.observation_deadline || now.toISOString(),
          updated_at: now.toISOString(),
        });

        closed.push({
          probe_id: obj.probe_id,
          probe_reference: obj.probe_reference,
          agency_id: obj.agency_id,
          grade: result?.grade || '',
          grade_reason: result?.grade_reason || '',
        });
      } catch (err) {
        // One bad probe must not abort the sweep — the rest still close, and
        // this one is reported rather than silently skipped.
        console.error(`close-due: failed to close ${obj.probe_id}:`, err);
        failed.push({ probe_id: obj.probe_id, probe_reference: obj.probe_reference, error: err?.message || String(err) });
      }
    }

    const status = failed.length ? 207 : 200;
    return res.status(status).json({
      checked: probes.length,
      due: due.length,
      closed_count: closed.length,
      closed,
      failed,
      ran_at: now.toISOString(),
    });
  } catch (err) {
    console.error('close-due error:', err);
    return res.status(500).json({ error: err.message || 'Failed to close due observations' });
  }
}
