// api/lead.js - Vercel Serverless Function
// GET /api/lead?slug=ashton-white-dxfw
// GET /api/lead?call_context=1&agency_id=...   (internal NOVUS only)
//
// Stable prospect fields (company/url/town/first_name) come from the committed
// api/_leads.mjs. Probe data for the public demo is pulled LIVE from Google
// Sheets per request. Calling Mode can also ask for a small, authenticated
// context projection from PROBES + INTELLIGENCE so the operator can see what
// actually happened before making a claim on the phone.
import { LEADS } from './_leads.mjs';
import { getProbeData } from '../lib/probes.mjs';
import { buildProbeLine } from '../lib/probeCopy.mjs';
import { getRepo } from '../lib/sheets.mjs';
import { resolvePropertyStreet } from '../lib/property-reference.mjs';
import { resolveCaller, sendUnauthorized } from './novus/_auth.mjs';

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();
const ts = (value) => (Number.isFinite(Date.parse(text(value))) ? Date.parse(text(value)) : null);

function isGenuineProbe(row) {
  return ['OBSERVING', 'ACTIVE', 'CLOSED'].includes(upper(row?.probe_status));
}

function numberOrNull(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function getCallingContext(agencyId) {
  const repo = getRepo();
  const [probes, intelligence] = await Promise.all([
    repo.getRecords('PROBES', 'probe_id').catch(() => []),
    repo.getRecords('INTELLIGENCE', 'probe_id').catch(() => []),
  ]);

  const probeRec = probes
    .filter((record) => text(record.obj?.agency_id) === agencyId && isGenuineProbe(record.obj))
    .sort((a, b) => (ts(b.obj?.probe_timestamp) ?? 0) - (ts(a.obj?.probe_timestamp) ?? 0))[0] || null;

  if (!probeRec) return { found: false, agency_id: agencyId };

  const probe = probeRec.obj || {};
  const probeId = text(probe.probe_id);
  const intelRec = intelligence
    .filter((record) => text(record.obj?.probe_id) === probeId)
    .sort((a, b) => (ts(b.obj?.updated_at) ?? 0) - (ts(a.obj?.updated_at) ?? 0))[0] || null;
  const intel = intelRec?.obj || {};

  return {
    found: true,
    agency_id: agencyId,
    probe_id: probeId,
    property: resolvePropertyStreet(probe),
    probe_sent_at: text(probe.probe_timestamp),
    seller_recognition: text(intel.seller_recognition),
    contact_attempts: numberOrNull(intel.contact_attempts),
    follow_ups: numberOrNull(intel.follow_ups),
    channels_used: text(intel.channels_used),
    human_contact: text(intel.human_contact),
    response_hours: text(intel.response_hours),
    grade: text(intel.grade),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const callContext = String(req.query.call_context || '') === '1';
  const agencyId = text(req.query.agency_id);
  if (callContext || agencyId) {
    if (!callContext || !agencyId) return res.status(400).json({ error: 'call_context=1 requires agency_id' });
    // Outside middleware.js's matcher, so the caller is resolved in full
    // here: a login session (server-side record + USERS row) or the admin
    // machine credential. Read-only calling data for the lead being called,
    // so a SETTER may read it too (Calling Mode's context panel).
    if (!(await resolveCaller(req))) return sendUnauthorized(req, res);
    try {
      return res.status(200).json({ call_context: await getCallingContext(agencyId) });
    } catch (err) {
      console.error('calling context error:', err);
      return res.status(500).json({ error: err?.message || 'Failed to load calling context' });
    }
  }

  const slug = (req.query.slug || '').toString().trim().toLowerCase();
  if (!slug) return res.status(400).json({ error: 'Missing slug' });

  const rec = LEADS[slug];
  if (!rec) return res.status(404).json({ error: 'Not found' });

  // Live probe lookup - null when the sheet isn't configured or has no usable row.
  const probe = await getProbeData(slug);
  const probeLine = buildProbeLine(probe);

  const out = {
    company: rec.company || '',
    url: rec.url || '',
    town: rec.town || '',
    first_name: rec.first_name || '',
  };
  if (probeLine) out.probe_line = probeLine;

  return res.status(200).json(out);
}
