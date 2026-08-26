// api/novus/probe.js — the probe lifecycle route, consolidated.
//
// GET  /api/novus/probe?probe_id=...        (was probe-get.js)
// GET  /api/novus/probe?agency_id=...        (was probe-get.js)
// GET  /api/novus/probe?next_after=<agency_id>  (was probe-get.js)
// POST /api/novus/probe  { action: "create", url, agency_id }      (was probe-create.js)
// POST /api/novus/probe  { action: "mark-sent", probe_id }         (was probe-mark-sent.js)
//
// Consolidated from three separate files into one Serverless Function to
// stay within Vercel Hobby's 12-function limit.

import { getRepo } from '../../lib/sheets.mjs';
import { newProbeId, newProbeReference } from '../../lib/ids.mjs';
import { fetchListingMeta } from '../../lib/rightmove-meta.mjs';
import { requireAuth } from './_auth.mjs';

export const maxDuration = 20;

// ── GET (was probe-get.js) ──────────────────────────────────────────────────

function isProbeEligible(agency) {
  const url = String(agency.rightmove_sales_branch_url ?? '').trim();
  if (!/^https?:\/\//i.test(url)) return false;
  if (String(agency.suppression_status ?? '').trim().toLowerCase() === 'suppressed') return false;
  return true;
}

async function handleGet(req, res) {
  const probeId = (req.query?.probe_id || '').trim();
  const agencyId = (req.query?.agency_id || '').trim();
  const nextAfter = (req.query?.next_after || '').trim();
  if (!probeId && !agencyId && !nextAfter) {
    return res.status(400).json({ error: 'Missing probe_id, agency_id or next_after' });
  }

  try {
    const repo = getRepo();

    if (nextAfter) {
      const agencies = await repo.getRecords('AGENCIES', 'agency_id');
      const from = agencies.findIndex((r) => r.obj.agency_id === nextAfter);
      if (from === -1) return res.status(404).json({ error: 'Agency not found' });
      const next = agencies.slice(from + 1).find((r) => isProbeEligible(r.obj));
      if (!next) return res.status(404).json({ error: 'No further eligible agency in the list' });
      return res.status(200).json({ agency: next.obj });
    }

    if (agencyId) {
      const record = await repo.findById('AGENCIES', 'agency_id', agencyId);
      if (!record) return res.status(404).json({ error: 'Agency not found' });
      return res.status(200).json({ agency: record.obj });
    }

    const record = await repo.findById('PROBES', 'probe_id', probeId);
    if (!record) return res.status(404).json({ error: 'Probe not found' });
    return res.status(200).json({ probe: record.obj });
  } catch (err) {
    console.error('probe (get) error:', err);
    return res.status(500).json({ error: err.message || 'Failed to fetch probe/agency' });
  }
}

// ── POST action=create (was probe-create.js) ───────────────────────────────

const VENDOR_DECLARATION = 'Declared: has a property to sell, yes, it is not yet on the market';

async function handleCreate(body, res) {
  const url = (body.url || '').trim();
  const agencyId = (body.agency_id || '').trim();

  if (!url) return res.status(400).json({ error: 'Missing url' });
  if (!agencyId) {
    return res.status(400).json({
      error: 'Missing agency_id — probe creation is blocked because every NOVUS probe must belong to an agency',
    });
  }
  if (!/^https?:\/\/|^www\./i.test(url) && !url.includes('.')) {
    return res.status(400).json({ error: 'That does not look like a valid URL' });
  }

  const portal = /rightmove\./i.test(url) ? 'rightmove'
    : /zoopla\./i.test(url) ? 'zoopla'
    : /onthemarket\./i.test(url) ? 'onthemarket'
    : 'rightmove';

  try {
    const repo = getRepo();

    // Agency identity is a hard relational invariant. Never create an orphan
    // PROBES row and never guess an agency from listing metadata.
    const agencyRecord = await repo.findById('AGENCIES', 'agency_id', agencyId);
    if (!agencyRecord) return res.status(400).json({ error: 'Unknown agency_id' });

    const meta = await fetchListingMeta(url).catch(() => ({ address: '', price: '', status: '', title: '' }));
    const sequence = await repo.count('PROBES', 'probe_id').catch(() => 0);

    const now = new Date().toISOString();
    const probe = {
      probe_id: newProbeId(),
      probe_reference: newProbeReference(sequence, portal),
      agency_id: agencyId,
      portal,
      property_address: meta.address || '',
      property_url: url,
      property_price: meta.price || '',
      property_status: meta.status || '',
      enquiry_text: portal === 'rightmove'
        ? [VENDOR_DECLARATION, (body.enquiry_text || '').trim()].filter(Boolean).join(' — ')
        : (body.enquiry_text || '').trim(),
      probe_email: process.env.NOVUS_PROBE_EMAIL || 'joe.novus2@gmail.com',
      probe_phone: process.env.NOVUS_PROBE_PHONE || '+447575333064',
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
    console.error('probe (create) error:', err);
    return res.status(500).json({ error: err.message || 'Failed to create probe' });
  }
}

// ── POST action=mark-sent (was probe-mark-sent.js) ─────────────────────────

const OBSERVATION_DAYS = 4;

async function handleMarkSent(body, res) {
  const probeId = (body.probe_id || '').trim();
  if (!probeId) return res.status(400).json({ error: 'Missing probe_id' });

  try {
    const repo = getRepo();
    const record = await repo.findById('PROBES', 'probe_id', probeId);
    if (!record) return res.status(404).json({ error: 'Probe not found' });

    // Second guard: even a legacy/bad draft row cannot be moved into the live
    // observation pipeline without a canonical agency relationship.
    if (!String(record.obj.agency_id || '').trim()) {
      return res.status(409).json({
        error: 'Probe has no agency_id — Mark as Sent blocked. Re-link this probe to its AGENCIES row before sending.',
      });
    }

    const agencyRecord = await repo.findById('AGENCIES', 'agency_id', String(record.obj.agency_id).trim());
    if (!agencyRecord) {
      return res.status(409).json({
        error: 'Probe agency_id does not resolve to AGENCIES — Mark as Sent blocked to protect probe identity.',
      });
    }

    if (record.obj.probe_status && record.obj.probe_status !== 'draft' && record.obj.probe_timestamp) {
      return res.status(200).json({ probe: record.obj, already_sent: true });
    }

    const sentAt = new Date();
    const deadline = new Date(sentAt.getTime() + OBSERVATION_DAYS * 24 * 60 * 60 * 1000);

    const updated = await repo.updateById('PROBES', 'probe_id', probeId, {
      probe_status: 'observing',
      probe_timestamp: sentAt.toISOString(),
      observation_deadline: deadline.toISOString(),
      updated_at: sentAt.toISOString(),
    });
    if (!updated) return res.status(404).json({ error: 'Probe not found' });

    try {
      await repo.updateCell('AGENCIES', 'agency_id', record.obj.agency_id, 'probe_sent', 'YES');
    } catch (err) {
      console.error('probe (mark-sent): could not set AGENCIES.probe_sent:', err);
    }

    return res.status(200).json({ probe: updated, already_sent: false });
  } catch (err) {
    console.error('probe (mark-sent) error:', err);
    return res.status(500).json({ error: err.message || 'Failed to mark probe as sent' });
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;

  if (req.method === 'GET') return handleGet(req, res);

  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
    if (body.action === 'create') return handleCreate(body, res);
    if (body.action === 'mark-sent') return handleMarkSent(body, res);
    return res.status(400).json({ error: 'Missing or unknown action — expected "create" or "mark-sent"' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
