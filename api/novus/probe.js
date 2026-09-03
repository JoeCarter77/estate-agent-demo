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
import { reconcileAgencyActionsBestEffort } from '../../lib/action-engine.mjs';
import { isProbeQueueEligible } from '../../lib/acquisition-stage.mjs';

export const maxDuration = 20;

// ── GET (was probe-get.js) ──────────────────────────────────────────────────

// PROBER QUEUE ELIGIBILITY.
//
// The hard gate is the physical AGENCIES.probe_sent cell being blank. Any
// non-blank value ("YES", a timestamp, a stray note) means the row is already
// probed and is skipped. This deliberately does NOT consult PROBES history:
// that inference is what handed already-probed agencies back to the operator
// whenever a PROBES row was missing, deleted or logged out of band.
//
// The normal exclusions (no Rightmove sales branch URL, suppressed, closed,
// excluded, meeting booked, not interested) still apply on top.
export function isProbeEligible(agency) {
  return isProbeQueueEligible(agency);
}

// The gate is a real column. If AGENCIES has no probe_sent column at all, every
// row would read as blank and the queue would silently re-serve probed
// agencies — exactly the failure being fixed. Say so instead of guessing.
export function hasProbeSentColumn(records) {
  return (records || []).some((record) => Object.prototype.hasOwnProperty.call(record.obj || {}, 'probe_sent'));
}

// Cheap queue telemetry for the Prober header. AGENCIES is already in memory
// for the next-agency lookup; PROBES is only read for the "today" figure.
export function queueStats(agencies, probes = null, now = new Date()) {
  const remaining = (agencies || []).filter((record) => isProbeEligible(record.obj)).length;
  const stats = { remaining, completed_today: null };
  if (probes) {
    const dayStart = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
    stats.completed_today = probes.filter((record) => {
      const sentAt = Date.parse(String(record.obj.probe_timestamp || '').trim());
      return Number.isFinite(sentAt) && sentAt >= dayStart;
    }).length;
  }
  return stats;
}

async function handleGet(req, res) {
  const probeId = (req.query?.probe_id || '').trim();
  const agencyId = (req.query?.agency_id || '').trim();
  const nextAfter = (req.query?.next_after || '').trim();
  const next = String(req.query?.next || '') === '1';
  const queueOnly = String(req.query?.queue || '') === '1';
  if (!probeId && !agencyId && !nextAfter && !next && !queueOnly) {
    return res.status(400).json({ error: 'Missing probe_id, agency_id, next_after, next=1 or queue=1' });
  }

  try {
    const repo = getRepo();

    // Queue telemetry only — no probe is created, advanced or sent.
    if (queueOnly) {
      const [agencies, probes] = await Promise.all([
        repo.getRecords('AGENCIES', 'agency_id'),
        repo.getRecords('PROBES', 'probe_id').catch(() => []),
      ]);
      return res.status(200).json({ queue: queueStats(agencies, probes) });
    }

    if (nextAfter || next) {
      const agencies = await repo.getRecords('AGENCIES', 'agency_id');
      if (!hasProbeSentColumn(agencies)) {
        return res.status(409).json({ error: 'AGENCIES has no probe_sent column — the Prober queue cannot verify which agencies were already probed. Add the column before probing.' });
      }
      const from = nextAfter ? agencies.findIndex((r) => String(r.obj.agency_id || '').trim() === nextAfter) : -1;
      if (nextAfter && from === -1) return res.status(404).json({ error: 'Agency not found' });
      // Sheet order, first row whose probe_sent is genuinely blank.
      const found = agencies.slice(from + 1).find((r) => isProbeEligible(r.obj));
      if (!found) return res.status(404).json({ error: nextAfter ? 'No further eligible agency in the list' : 'No eligible agency is ready to probe' });
      return res.status(200).json({ agency: found.obj, queue: queueStats(agencies) });
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

    const actions = await reconcileAgencyActionsBestEffort(repo, record.obj.agency_id, 'probe sent');

    return res.status(200).json({ probe: updated, already_sent: false, actions });
  } catch (err) {
    console.error('probe (mark-sent) error:', err);
    return res.status(500).json({ error: err.message || 'Failed to mark probe as sent' });
  }
}

const DOWNSTREAM_TABS = [
  ['PROBES', 'probe_id'], ['COMMUNICATIONS', 'communication_id'], ['INTELLIGENCE', 'intelligence_id'],
  ['PERSONALISATION', 'probe_id'], ['DEMOS', 'demo_id'], ['OUTBOUND', 'outbound_id'],
  ['REPLY_EVENTS', 'reply_event_id'], ['SALES_MESSAGES', 'sales_message_id'], ['ACTIONS', 'action_id'],
];

async function recordsOrEmpty(repo, tab, idColumn) {
  try { return await repo.getRecords(tab, idColumn); } catch { return []; }
}

async function handleSkipAgency(body, res) {
  const agencyId = String(body.agency_id || '').trim();
  if (!agencyId) return res.status(400).json({ error: 'Missing agency_id' });
  if (String(body.confirm || '').trim() !== 'DELETE_UNWORKED_AGENCY') {
    return res.status(400).json({ error: 'Missing confirm=DELETE_UNWORKED_AGENCY' });
  }
  try {
    const repo = getRepo();
    const agency = await repo.findById('AGENCIES', 'agency_id', agencyId);
    if (!agency) return res.status(404).json({ error: 'Agency not found' });
    if (body.expected_updated_at && String(agency.obj.updated_at || '').trim() !== String(body.expected_updated_at).trim()) {
      return res.status(409).json({ error: 'Agency changed since it was loaded; refresh before deleting' });
    }
    const agencyRows = await repo.getRecords('AGENCIES', 'agency_id');
    const agencyIndex = agencyRows.findIndex((record) => String(record.obj.agency_id || '').trim() === agencyId);
    // Skip advances through the identical blank-probe_sent rule as Send & Next.
    const nextAgency = agencyRows.slice(agencyIndex + 1).find((record) => isProbeEligible(record.obj));
    const dependencies = [];
    for (const [tab, idColumn] of DOWNSTREAM_TABS) {
      const rows = await recordsOrEmpty(repo, tab, idColumn);
      const count = rows.filter((record) => String(record.obj.agency_id || '').trim() === agencyId).length;
      if (count) dependencies.push({ tab, count });
    }
    if (dependencies.length) {
      return res.status(409).json({
        error: 'Agency cannot be hard-deleted because downstream history exists',
        agency_id: agencyId, dependencies,
      });
    }
    const contacts = (await recordsOrEmpty(repo, 'CONTACTS', 'contact_id'))
      .filter((record) => String(record.obj.agency_id || '').trim() === agencyId);
    // CONTACTS are agency-scoped in the existing schema, so these are the
    // allowed exclusive upstream records. Delete bottom-up, then the agency.
    if (contacts.length) await repo.deleteRows('CONTACTS', contacts.map((record) => record.rowNumber));
    await repo.deleteRows('AGENCIES', [agency.rowNumber]);
    // The skip reason is operator context for the audit log only. There is no
    // safe place to persist it: skipping hard-deletes the AGENCIES row, so any
    // column that could hold it disappears with the record.
    const skipReason = String(body.reason || '').trim().slice(0, 120);
    console.info('probe skip: deleted unworked agency', {
      agency_id: agencyId, agency_name: agency.obj.agency_name,
      contacts_deleted: contacts.length, reason: skipReason || 'unspecified',
    });
    return res.status(200).json({
      deleted: true, agency_id: agencyId, contacts_deleted: contacts.length,
      reason: skipReason, reason_persisted: false,
      next_agency_id: String(nextAgency?.obj?.agency_id || '').trim(),
      queue: queueStats(agencyRows.filter((record) => String(record.obj.agency_id || '').trim() !== agencyId)),
    });
  } catch (err) {
    console.error('probe skip agency error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to delete unworked agency' });
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
    if (body.action === 'skip-agency') return handleSkipAgency(body, res);
    return res.status(400).json({ error: 'Missing or unknown action — expected "create" or "mark-sent"' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
