// api/novus/intelligence/rebuild-all.js
// Existing rebuild/outbound host plus protected communication-resolution
// operations. No new Vercel Serverless Function is created.

import { getRepo } from '../../../lib/sheets.mjs';
import { runRebuildPass } from '../../../lib/rebuild-pass.mjs';
import { recomputeProbeObservation } from '../../../lib/observation-recompute.mjs';
import { rebuildOutbound } from '../../../lib/outbound.mjs';
import {
  INSTANTLY_BULK_CONFIRMATION,
  buildInstantlyDryRun,
  uploadEligibleOutboundLeads,
  uploadSingleOutboundLead,
} from '../../../lib/instantly-outbound.mjs';
import { requireAuth } from '../_auth.mjs';
import { inboundMatchDryRunOptions, runInboundMatchDryRun } from '../../../lib/inbound-match-review.mjs';
import { runInboundMatchBackfill } from '../../../lib/inbound-match-backfill.mjs';
import { confirmInboundCommunicationMatch } from '../../../lib/inbound-match-manual.mjs';
import { fetchTwilioRecording } from '../../../lib/twilio-recording.mjs';

export const maxDuration = 60;
const DEFAULT_BATCH_SIZE = 15;

function parseBody(req) {
  const raw = req.body;
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw;
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON body: ${err.message}`);
  }
}

function normalizeProbeIds(raw) {
  if (raw === undefined) return { present: false, ids: null, invalid: false };
  const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(',') : null);
  if (list === null) return { present: true, ids: null, invalid: true };
  const ids = list.map((id) => String(id ?? '').trim()).filter(Boolean);
  return { present: true, ids, invalid: ids.length === 0 };
}

async function handleInboundRecordingAudio(req, res) {
  const communicationId = String(req.query?.communication_id || '').trim();
  if (!communicationId) return res.status(400).json({ error: 'Missing communication_id' });
  try {
    const record = await getRepo().findById('COMMUNICATIONS', 'communication_id', communicationId);
    if (!record) return res.status(404).json({ error: 'Communication not found' });
    const reference = String(record.obj.recording_reference || '').trim();
    if (!reference) return res.status(404).json({ error: 'No recording available for this communication' });
    const recording = await fetchTwilioRecording(reference);
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Content-Type', recording.contentType);
    res.setHeader('Content-Length', recording.contentLength);
    res.setHeader('Content-Disposition', 'inline');
    return res.status(200).send(recording.bytes);
  } catch (err) {
    console.error('inbound recording audio error:', err?.message || String(err));
    const status = Number(err?.statusCode);
    return res.status(Number.isInteger(status) && status >= 400 && status < 600 ? status : 500)
      .json({ error: err?.message || 'Failed to fetch recording' });
  }
}

async function handleInboundManualMatch(req, res) {
  let body;
  try { body = parseBody(req); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  try {
    const result = await confirmInboundCommunicationMatch(getRepo(), body);
    return res.status(result.status || (result.ok ? 200 : 400)).json(result);
  } catch (err) {
    console.error('inbound manual match error:', err?.message || String(err));
    return res.status(500).json({ ok: false, error: err?.message || 'Failed to confirm communication match' });
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = String(req.query?.action || '').trim();

  // Read-only review inbox used by /novus/communications.html.
  if (req.method === 'GET' && action === 'inbound-match-dry-run') {
    if (!requireAuth(req, res)) return;
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    try {
      const result = await runInboundMatchDryRun(getRepo(), inboundMatchDryRunOptions(req));
      return res.status(200).json(result);
    } catch (err) {
      console.error('inbound match dry-run error:', err?.message || String(err));
      return res.status(500).json({ error: err?.message || 'Failed to run inbound match dry-run' });
    }
  }

  // Protected audio proxy. Credentials stay server-side; the browser never
  // receives recording_reference or Twilio auth material.
  if (req.method === 'GET' && action === 'inbound-match-audio') {
    if (!requireAuth(req, res)) return;
    return handleInboundRecordingAudio(req, res);
  }

  // Existing deterministic bulk recovery. It fills blanks only.
  if (req.method === 'POST' && action === 'inbound-match-backfill') {
    if (!requireAuth(req, res)) return;
    res.setHeader('Cache-Control', 'no-store');
    try {
      const result = await runInboundMatchBackfill(getRepo(), inboundMatchDryRunOptions(req));
      return res.status(200).json(result);
    } catch (err) {
      console.error('inbound match backfill error:', err?.message || String(err));
      return res.status(500).json({ error: err?.message || 'Failed to run inbound match backfill' });
    }
  }

  // Deliberate human override from the Command Centre. The module validates
  // agency/probe ownership before touching COMMUNICATIONS.
  if (req.method === 'POST' && action === 'inbound-match-confirm') {
    if (!requireAuth(req, res)) return;
    res.setHeader('Cache-Control', 'no-store');
    return handleInboundManualMatch(req, res);
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  let body;
  try {
    body = parseBody(req);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const probeId = String(body.probe_id || '').trim();

  if (body.operation === 'rebuild_outbound') {
    try {
      const result = await rebuildOutbound(getRepo(), { dryRun: body.dry_run !== false });
      return res.status(200).json(result);
    } catch (err) {
      console.error('outbound rebuild error:', err);
      return res.status(500).json({ error: err.message || 'Failed to rebuild OUTBOUND' });
    }
  }

  if (body.operation === 'instantly_outbound') {
    try {
      const repo = getRepo();
      if (body.dry_run !== false) {
        const result = await buildInstantlyDryRun(repo, {
          campaignId: process.env.INSTANTLY_CAMPAIGN_ID,
          sampleLimit: body.sample_limit,
        });
        return res.status(200).json(result);
      }
      if (body.bulk === true) {
        if (body.confirmation !== INSTANTLY_BULK_CONFIRMATION) {
          return res.status(400).json({
            error: `Bulk live mode requires confirmation=${INSTANTLY_BULK_CONFIRMATION}`,
          });
        }
        const result = await uploadEligibleOutboundLeads(repo, {
          apiKey: process.env.INSTANTLY_API_KEY,
          campaignId: process.env.INSTANTLY_CAMPAIGN_ID,
        });
        return res.status(200).json(result);
      }
      const result = await uploadSingleOutboundLead(repo, {
        outboundId: body.outbound_id,
        confirmation: body.confirmation,
        ...(body.test_email !== undefined ? { testEmail: body.test_email } : {}),
        apiKey: process.env.INSTANTLY_API_KEY,
        campaignId: process.env.INSTANTLY_CAMPAIGN_ID,
      });
      return res.status(200).json(result);
    } catch (err) {
      console.error('instantly outbound error:', err?.message || String(err));
      return res.status(400).json({ error: err?.message || 'Instantly OUTBOUND handoff failed' });
    }
  }

  const probeIdsField = probeId ? { present: false, ids: null, invalid: false } : normalizeProbeIds(body.probe_ids);
  if (probeIdsField.invalid) {
    return res.status(400).json({
      error: 'probe_ids must be a non-empty array of probe_id strings (or a non-empty comma-separated string)',
    });
  }
  const probeIds = probeIdsField.ids;
  const forceAi = body.force_ai === true;
  const batchSize = Number.isFinite(Number(body.batch_size)) && Number(body.batch_size) > 0
    ? Number(body.batch_size)
    : Number(process.env.NOVUS_REBUILD_BATCH_SIZE) || DEFAULT_BATCH_SIZE;

  try {
    const repo = getRepo();
    if (probeId) {
      const result = await recomputeProbeObservation(repo, probeId);
      if (!result) return res.status(404).json({ error: `Probe ${probeId} not found` });
      return res.status(200).json(result);
    }

    const summary = await runRebuildPass(repo, {
      forceAi,
      maxAiCalls: batchSize,
      probeIds: probeIds || undefined,
      rebuildOutbound: true,
    });

    return res.status(200).json({ ...summary, batch_size: batchSize, ...(probeIds ? { targeted_probe_ids: probeIds } : {}) });
  } catch (err) {
    console.error('intelligence rebuild-all error:', err);
    return res.status(500).json({ error: err.message || 'Failed to rebuild intelligence' });
  }
}
