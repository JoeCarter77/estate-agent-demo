// api/novus/probe.js — the probe lifecycle route, consolidated.
//
// GET  /api/novus/probe?probe_id=...        (was probe-get.js)
// GET  /api/novus/probe?agency_id=...        (was probe-get.js)
// GET  /api/novus/probe?next_after=<agency_id>  (was probe-get.js)
// POST /api/novus/probe  { action: "create", url, agency_id? }     (was probe-create.js)
// POST /api/novus/probe  { action: "mark-sent", probe_id }         (was probe-mark-sent.js)
//
// Consolidated from three separate files into one Serverless Function to
// stay within Vercel Hobby's 12-function limit — no behaviour change, no new
// logic. Every handler body below is byte-for-byte the previous file's
// handler, just dispatched to from one entry point instead of three routes.
// Callers: novus/probe.html only (updated alongside this file) — this route
// has never been externally referenced (no third-party webhook/config points
// at these URLs), so renaming/merging it carries none of the live-production
// risk the /api/novus/webhooks/* routes do.

import { getRepo } from '../../lib/sheets.mjs';
import { newProbeId, newProbeReference } from '../../lib/ids.mjs';
import { fetchListingMeta } from '../../lib/rightmove-meta.mjs';
import { requireAuth } from './_auth.mjs';

export const maxDuration = 20;

// ── GET (was probe-get.js) ──────────────────────────────────────────────────

// An agency is probe-eligible when it has a usable Rightmove sales branch page
// to work from and has not been suppressed. Rows marked REVIEW or
// "DELETE - NON-SALES/LETTINGS" carry no branch URL, so the URL check already
// excludes them — this never invents eligibility the sheet doesn't state.
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

    // Next eligible agency, in the sheet's own row order. getRecords preserves
    // that order, so "next" is simply the first eligible row after this one.
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

// Every genuine Rightmove probe enquiry is submitted the same way: "I have
// a property to sell" -> "Yes, it is not yet on the market" — the vendor-
// opportunity branch. Recording that declaration on the PROBES row itself
// (reusing enquiry_text, no new column) is what lets the Intelligence
// pipeline later check whether the agency's replies actually noticed it.
// Matches the exact wording already present on historical imported probes.
const VENDOR_DECLARATION = 'Declared: has a property to sell, yes, it is not yet on the market';

async function handleCreate(body, res) {
  const url = (body.url || '').trim();
  const agencyId = (body.agency_id || '').trim();
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

    // If an agency_id was supplied (e.g. from the agency-launched probe
    // flow), it must correspond to a real AGENCIES row — never guessed,
    // never silently dropped.
    if (agencyId) {
      const agencyRecord = await repo.findById('AGENCIES', 'agency_id', agencyId);
      if (!agencyRecord) return res.status(400).json({ error: 'Unknown agency_id' });
    }

    // Best-effort metadata — never blocks probe creation.
    const meta = await fetchListingMeta(url).catch(() => ({ address: '', price: '', status: '', title: '' }));

    // Human-readable sequence from existing probe count.
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
      // Preserve any other enquiry detail passed in (none exists today — this
      // is forward-compatible), appended after the standing vendor declaration.
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

    // Already sent → return as-is (do not reset the window). Covers both
    // 'observing' (mid-window) and 'closed' (finalised, frozen) — anything
    // other than 'draft' means this probe was already sent once and must
    // never have its probe_timestamp/observation_deadline reset, including
    // a closed probe that must stay frozen, never re-armed.
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

    // Flag the originating agency as probed. The cell is located by the
    // "probe_sent" HEADER NAME, so moving the column in the sheet keeps this
    // working. Best-effort: a failure here (or no probe_sent column yet) is
    // logged, never surfaced — the observation window is the outcome that
    // matters, and it has already been recorded above.
    if (record.obj.agency_id) {
      try {
        await repo.updateCell('AGENCIES', 'agency_id', record.obj.agency_id, 'probe_sent', 'YES');
      } catch (err) {
        console.error('probe (mark-sent): could not set AGENCIES.probe_sent:', err);
      }
    }

    return res.status(200).json({ probe: updated, already_sent: false });
  } catch (err) {
    console.error('probe (mark-sent) error:', err);
    return res.status(500).json({ error: err.message || 'Failed to mark probe as sent' });
  }
}

// ── Entry point ──────────────────────────────────────────────────────────

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
