// api/novus/probe-create.js — POST /api/novus/probe-create
// Body: { url }   (the pasted Rightmove listing URL — the ONLY required input)
//
// Creates a DRAFT probe:
//   • generates probe_id + human-readable probe_reference
//   • attaches NOVUS_PROBE_EMAIL + NOVUS_PROBE_PHONE automatically
//   • best-effort property/agency metadata (gracefully blank if unavailable)
//   • writes one PROBES row with probe_status = "draft"
//
// It does NOT start the observation window. Only MARK AS SENT does that.

import { getRepo } from '../../lib/sheets.mjs';
import { newProbeId, newProbeReference } from '../../lib/ids.mjs';
import { fetchListingMeta } from '../../lib/rightmove-meta.mjs';
import { requireAuth } from './_auth.mjs';

export const maxDuration = 20;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const url = (body.url || '').trim();
  if (!url) return res.status(400).json({ error: 'Missing url' });
  if (!/^https?:\/\/|^www\./i.test(url) && !url.includes('.')) {
    return res.status(400).json({ error: 'That does not look like a valid URL' });
  }

  const portal = /rightmove\./i.test(url) ? 'rightmove'
    : /zoopla\./i.test(url) ? 'zoopla'
    : /onthemarket\./i.test(url) ? 'onthemarket'
    : 'rightmove';

  try {
    const repo = getRepo();

    // Best-effort metadata — never blocks probe creation.
    const meta = await fetchListingMeta(url).catch(() => ({ address: '', price: '', status: '', title: '' }));

    // Human-readable sequence from existing probe count.
    const sequence = await repo.count('PROBES', 'probe_id').catch(() => 0);

    const now = new Date().toISOString();
    const probe = {
      probe_id: newProbeId(),
      probe_reference: newProbeReference(sequence, portal),
      agency_id: '',
      portal,
      property_address: meta.address || '',
      property_url: url,
      property_price: meta.price || '',
      property_status: meta.status || '',
      enquiry_text: '',
      probe_email: process.env.NOVUS_PROBE_EMAIL || '',
      probe_phone: process.env.NOVUS_PROBE_PHONE || '',
      probe_timestamp: '',
      observation_deadline: '',
      probe_status: 'draft',
      compromised: 'FALSE',
      compromise_reason: '',
      observation_closed_at: '',
      sent_from: '',
      observation_notes: '',
      created_at: now,
      updated_at: now,
    };

    await repo.appendRecord('PROBES', probe);

    return res.status(200).json({ probe, meta_source: meta.address || meta.price ? 'fetched' : 'unavailable' });
  } catch (err) {
    console.error('probe-create error:', err);
    return res.status(500).json({ error: err.message || 'Failed to create probe' });
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
