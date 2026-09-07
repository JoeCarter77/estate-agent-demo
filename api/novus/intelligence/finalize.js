// api/novus/intelligence/finalize.js — nightly acquisition finaliser.
//
// Closes expired probe windows, completes the acquisition assets, hands newly
// eligible rows to Instantly, then reconciles operator actions. The whole
// invocation shares one request-scoped Sheets cache so those stages do not
// repeatedly download the same tabs.

import crypto from 'node:crypto';
import { getRepo } from '../../../lib/sheets.mjs';
import { createCachedRepo } from '../../../lib/cached-repo.mjs';
import { runRebuildPass } from '../../../lib/rebuild-pass.mjs';
import { uploadEligibleOutboundLeads } from '../../../lib/instantly-outbound.mjs';
import { reconcileActionEngine } from '../../../lib/action-engine.mjs';

export const maxDuration = 60;
const DEFAULT_BATCH_SIZE = 15;

export async function runNightlyFinalizer(repo, {
  batchSize = DEFAULT_BATCH_SIZE,
  rebuild = runRebuildPass,
  handoff = uploadEligibleOutboundLeads,
  instantlyOptions = {},
} = {}) {
  const workRepo = createCachedRepo(repo);
  const summary = await rebuild(workRepo, {
    maxAiCalls: batchSize,
    rebuildOutbound: true,
  });
  if (!summary?.outbound) throw new Error('Nightly OUTBOUND rebuild did not complete');

  // OUTBOUND writes are mirrored into the request cache, so the handoff sees
  // the exact freshly-compiled state without another Google Sheets GET.
  const instantly = await handoff(workRepo, instantlyOptions);
  return { ...summary, instantly, batch_size: batchSize };
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function requireCronSecret(req, res) {
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
    // One cache for rebuild -> OUTBOUND -> Instantly marker writes -> ACTIONS.
    // createCachedRepo is idempotent, so runRebuildPass can safely call it too.
    const repo = createCachedRepo(getRepo());
    const summary = await runNightlyFinalizer(repo, {
      batchSize,
      instantlyOptions: {
        apiKey: process.env.INSTANTLY_API_KEY,
        campaignId: process.env.INSTANTLY_CAMPAIGN_ID,
      },
    });

    let actions;
    try {
      actions = await reconcileActionEngine(repo);
    } catch (err) {
      console.error('nightly action reconciliation failed:', err?.message || err);
      actions = { available: false, error: err?.message || 'action reconciliation failed' };
    }
    return res.status(200).json({ ...summary, actions });
  } catch (err) {
    console.error('intelligence finalize (cron) error:', err);
    return res.status(500).json({ error: err.message || 'Failed to finalise expired probes' });
  }
}
