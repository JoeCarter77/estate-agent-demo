// api/novus/probe-create.js — POST /api/novus/probe-create
// Body: { agency_id, url, property?, enquiry_text?, extraction_source?, force? }
//
// Creates a DRAFT probe:
//   • REQUIRES a resolvable AGENCIES.agency_id (from the agency-specific probe
//     URL) — an orphan probe with a blank agency_id can never be matched to a
//     communication, so it is refused rather than created
//   • generates probe_id + human-readable probe_reference
//   • attaches NOVUS_PROBE_EMAIL + NOVUS_PROBE_PHONE automatically
//   • stores the CONFIRMED property data the UI sends (from the automatic
//     Rightmove read or the screenshot fallback — same path either way); if the
//     caller sends none, it falls back to a best-effort server-side read
//   • writes one PROBES row with probe_status = "draft"
//
// It does NOT start the observation window. Only MARK AS SENT does that.

import { getRepo } from '../../lib/sheets.mjs';
import { newProbeId, newProbeReference } from '../../lib/ids.mjs';
import { fetchListingFields } from '../../lib/rightmove-meta.mjs';
import { resolveAgency, agencyErrorMessage } from '../../lib/agencies.mjs';
import { requireAuth } from './_auth.mjs';

export const maxDuration = 30;

// Property attributes beyond the four PROBES columns that exist today.
// repo.appendRecord maps by header name and silently drops keys the sheet does
// not have, so writing these is forward-compatible: they start persisting the
// moment the columns are added, and until then the same values are preserved
// human-readably in observation_notes (below). No new tab, no new schema.
function propertyColumns(p) {
  return {
    property_bedrooms: p.bedrooms ?? '',
    property_bathrooms: p.bathrooms ?? '',
    property_type: p.property_type || '',
    property_street: p.street || '',
    property_postcode: p.postcode || '',
    property_agent_branch: p.agent_branch || '',
    property_title: p.title || '',
    property_details: p.details || '',
  };
}

function propertySummary(p, source) {
  const parts = [
    p.property_type && `Type: ${p.property_type}`,
    (p.bedrooms ?? '') !== '' && `Beds: ${p.bedrooms}`,
    (p.bathrooms ?? '') !== '' && `Baths: ${p.bathrooms}`,
    p.street && `Street: ${p.street}`,
    p.postcode && `Postcode: ${p.postcode}`,
    p.agent_branch && `Agent/branch: ${p.agent_branch}`,
    p.title && `Listing: ${p.title}`,
  ].filter(Boolean);
  if (source) parts.push(`Property data source: ${source}`);
  return parts.join(' · ');
}

function normaliseProperty(input) {
  const p = input && typeof input === 'object' ? input : {};
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  const int = (v) => {
    const n = typeof v === 'number' ? v : parseInt(String(v ?? '').replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) && n >= 0 && n < 100 ? n : '';
  };
  return {
    address: str(p.address, 200),
    street: str(p.street, 120),
    postcode: str(p.postcode, 12).toUpperCase(),
    price: str(p.price, 60),
    bedrooms: int(p.bedrooms),
    bathrooms: int(p.bathrooms),
    property_type: str(p.property_type, 60),
    listing_status: str(p.listing_status, 60),
    agent_branch: str(p.agent_branch, 120),
    title: str(p.title, 200),
    details: str(p.details, 1000),
  };
}

// Same listing, same agency, still live (draft or observing) = almost certainly a
// double-submit or a refreshed tab. Returned instead of creating a second probe,
// unless the caller explicitly asks to force a new one.
function findLiveDuplicate(probes, agencyId, url) {
  const target = normaliseUrl(url);
  return probes.find(({ obj }) =>
    obj.agency_id === agencyId &&
    normaliseUrl(obj.property_url) === target &&
    (obj.probe_status === 'draft' || obj.probe_status === 'observing')
  ) || null;
}

function normaliseUrl(u) {
  const s = String(u || '').trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
  return s.replace(/^https?:\/\//, '').replace(/^www\./, '');
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const url = String(body.url || '').trim();
  const rawAgencyId = String(body.agency_id || '').trim();

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

    // 1) AGENCY IDENTITY — resolved deterministically, never guessed, never blank.
    const resolved = await resolveAgency(repo, rawAgencyId);
    if (!resolved.ok) {
      const status = resolved.reason === 'missing' ? 400 : 404;
      return res.status(status).json({ error: agencyErrorMessage(resolved.reason, rawAgencyId), reason: resolved.reason });
    }
    const agencyId = resolved.agency.agency_id; // canonical workbook value

    // 2) Duplicate guard — one live probe per agency + listing.
    const existingProbes = await repo.getRecords('PROBES', 'probe_id');
    if (!body.force) {
      const dup = findLiveDuplicate(existingProbes, agencyId, url);
      if (dup) {
        return res.status(200).json({
          probe: dup.obj,
          duplicate: true,
          message: `A ${dup.obj.probe_status} probe already exists for this listing and agency (${dup.obj.probe_reference}).`,
        });
      }
    }

    // 3) PROPERTY DATA — the confirmed fields from the UI (automatic extraction
    // OR the screenshot fallback: identical path from here on). Only if the
    // caller sent nothing do we make a best-effort server-side read, and even
    // that never blocks creation.
    let property = normaliseProperty(body.property);
    let source = String(body.extraction_source || '').trim();
    const hasConfirmed = Object.values(property).some((v) => v !== '' && v !== null);
    if (!hasConfirmed) {
      const fetched = await fetchListingFields(url).catch(() => null);
      if (fetched) {
        const { _source, _blocked, ...fields } = fetched;
        property = normaliseProperty(fields);
        source = source || _source;
      }
    }
    if (!source) source = hasConfirmed ? 'confirmed' : 'unavailable';

    const sequence = existingProbes.length;
    const now = new Date().toISOString();
    const probe = {
      probe_id: newProbeId(),
      probe_reference: newProbeReference(sequence, portal),
      agency_id: agencyId,
      portal,
      property_address: property.address,
      property_url: url,
      property_price: property.price,
      property_status: property.listing_status,
      enquiry_text: String(body.enquiry_text || '').trim().slice(0, 2000),
      probe_email: process.env.NOVUS_PROBE_EMAIL || '',
      probe_phone: process.env.NOVUS_PROBE_PHONE || '',
      probe_timestamp: '',
      observation_deadline: '',
      probe_status: 'draft',
      compromised: 'FALSE',
      compromise_reason: '',
      observation_closed_at: '',
      sent_from: '',
      observation_notes: propertySummary(property, source),
      ...propertyColumns(property),
      created_at: now,
      updated_at: now,
    };

    await repo.appendRecord('PROBES', probe);

    return res.status(200).json({
      probe,
      duplicate: false,
      agency: { agency_id: agencyId, agency_name: resolved.agency.agency_name || '' },
      property,
      meta_source: source,
    });
  } catch (err) {
    console.error('probe-create error:', err);
    return res.status(500).json({ error: err.message || 'Failed to create probe' });
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
