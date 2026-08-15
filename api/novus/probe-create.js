// api/novus/probe-create.js — POST /api/novus/probe-create
// Body: { agency_id, url, force? }
//
// Creates a DRAFT probe:
//   • REQUIRES agency_id — a probe with no agency can never be matched to a
//     reply, so it would silently collect nothing (see below)
//   • generates probe_id + human-readable probe_reference
//   • generates the per-probe plus-addressed reply email (joe+rm0007@…)
//   • derives portal + property_id from the URL (never fails)
//   • best-effort property metadata, with an EXPLICIT extraction status
//   • refuses a duplicate probe against the same listing unless force=true
//   • writes one PROBES row with probe_status = "draft"
//
// It does NOT start the observation window. Only MARK AS SENT does that.
//
// WHY agency_id IS MANDATORY
// Inbound matching resolves a communication to a probe by way of the agency
// (matchProbe filters PROBES on agency_id) or by the probe's own reply
// address. A probe created without an agency_id fails the first path outright
// and cannot report the agency on the second. It would look like a working
// probe, run its full four days, and produce no intelligence. Refusing at
// creation is the only place this can be caught before evidence is lost.

import { getRepo } from '../../lib/sheets.mjs';
import { newProbeId, newProbeReference } from '../../lib/ids.mjs';
import { fetchListingMeta, portalFromUrl, propertyIdFromUrl } from '../../lib/rightmove-meta.mjs';
import { buildProbeEmail } from '../../lib/probe-identity.mjs';
import { requireAuth } from './_auth.mjs';

export const maxDuration = 20;

// A probe is "live" (and so blocks a duplicate) while it is a draft awaiting
// submission or inside its observation window. A closed probe does not block
// re-probing the same listing later.
const LIVE_STATUSES = new Set(['draft', 'observing']);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const url = (body.url || '').trim();
  const agencyId = String(body.agency_id || '').trim();
  const force = body.force === true || body.force === 'true';

  if (!agencyId) {
    return res.status(400).json({
      error: 'Missing agency_id. Select the agency being probed — a probe with no agency cannot be matched to its replies.',
    });
  }
  if (!url) return res.status(400).json({ error: 'Missing url' });
  if (!/^https?:\/\/|^www\./i.test(url) && !url.includes('.')) {
    return res.status(400).json({ error: 'That does not look like a valid URL' });
  }

  const portal = portalFromUrl(url) || 'rightmove';
  const propertyId = propertyIdFromUrl(url);

  try {
    const repo = getRepo();

    // The agency must actually exist. Accepting an unknown id would create a
    // probe whose agency_id matches nothing — the same silent dead end as no
    // agency at all.
    const agencyRecord = await repo.findById('AGENCIES', 'agency_id', agencyId);
    if (!agencyRecord) {
      return res.status(404).json({ error: `Unknown agency_id "${agencyId}" — import the agency before probing it.` });
    }

    // Duplicate prevention. Two live probes against the same listing make the
    // agency's reply ambiguous (matchProbe returns 'ambiguous' for 2+ active
    // probes), which would send genuine evidence to the review queue instead
    // of scoring it. Overridable, because deliberately re-probing is valid.
    const existingProbes = await repo.getRecords('PROBES', 'probe_id');
    if (!force) {
      const clash = existingProbes.find(({ obj }) => {
        if (!LIVE_STATUSES.has(String(obj.probe_status || '').toLowerCase())) return false;
        if (propertyId && obj.property_id) return obj.property_id === propertyId;
        return String(obj.property_url || '').trim() === url;
      });
      if (clash) {
        return res.status(409).json({
          error: `A live probe already exists for this listing (${clash.obj.probe_reference}, status ${clash.obj.probe_status}). Re-send with force=true to probe it again anyway.`,
          existing_probe: clash.obj,
        });
      }
    }

    // A second live probe against the SAME AGENCY makes every sender-matched
    // reply ambiguous, even for a different property. Allowed, but the
    // operator is told, because it changes what the evidence can prove.
    const liveForAgency = existingProbes.filter(
      ({ obj }) => obj.agency_id === agencyId && LIVE_STATUSES.has(String(obj.probe_status || '').toLowerCase()),
    );

    // Best-effort metadata — never blocks probe creation, but its outcome is
    // reported explicitly rather than collapsing into blank fields.
    const meta = await fetchListingMeta(url).catch((err) => ({
      property_id: propertyId,
      portal,
      address: '', postcode: '', price: '', property_type: '', bedrooms: '',
      title: '', description: '', image_url: '', agent_name: '', status: '',
      extraction_status: 'unavailable',
      extraction_error: err?.message || 'Extraction threw',
    }));

    // Human-readable sequence from existing probe count.
    const sequence = existingProbes.length;
    const probeReference = newProbeReference(sequence, portal);

    const now = new Date().toISOString();
    const probe = {
      probe_id: newProbeId(),
      probe_reference: probeReference,
      agency_id: agencyId,
      portal,
      property_id: meta.property_id || propertyId,
      property_address: meta.address || '',
      property_postcode: meta.postcode || '',
      property_url: url,
      property_price: meta.price || '',
      property_type: meta.property_type || '',
      property_bedrooms: meta.bedrooms || '',
      property_status: meta.status || '',
      listing_agent_name: meta.agent_name || '',
      listing_image_url: meta.image_url || '',
      extraction_status: meta.extraction_status,
      extraction_error: meta.extraction_error || '',
      enquiry_text: '',
      // Per-probe reply address: the deterministic key for inbound email.
      probe_email: buildProbeEmail(process.env.NOVUS_PROBE_EMAIL || '', probeReference),
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

    return res.status(200).json({
      probe,
      agency: {
        agency_id: agencyRecord.obj.agency_id,
        agency_name: agencyRecord.obj.agency_name,
        domain: agencyRecord.obj.domain,
        main_phone: agencyRecord.obj.main_phone,
        has_match_signal: Boolean(agencyRecord.obj.domain || agencyRecord.obj.main_phone),
      },
      extraction_status: meta.extraction_status,
      extraction_error: meta.extraction_error || '',
      warnings: buildWarnings(meta, agencyRecord.obj, liveForAgency),
    });
  } catch (err) {
    console.error('probe-create error:', err);
    return res.status(500).json({ error: err.message || 'Failed to create probe' });
  }
}

// Everything the operator needs to know BEFORE submitting the real enquiry.
// These are surfaced, never swallowed — each one degrades what the probe can
// prove, and all of them are cheap to fix at this point and impossible to fix
// after the enquiry has been sent.
function buildWarnings(meta, agency, liveForAgency) {
  const warnings = [];
  if (meta.extraction_status === 'blocked') {
    warnings.push('Rightmove refused the metadata request, so property details could not be read automatically. The probe is still valid — confirm the address and price from the listing yourself.');
  } else if (meta.extraction_status === 'unavailable') {
    warnings.push(`Property metadata could not be fetched (${meta.extraction_error}). The probe is still valid — confirm details from the listing.`);
  } else if (meta.extraction_status === 'empty') {
    warnings.push('The listing page was fetched but contained no readable property details (client-rendered). Confirm the address and price yourself.');
  }
  if (!meta.property_id) {
    warnings.push('No portal property id could be derived from that URL — check it is a listing URL, not a search results page.');
  }
  if (!agency.domain && !agency.main_phone) {
    warnings.push(`${agency.agency_name} has neither a domain nor a phone number on record. Replies can only be matched by the probe email address — do not use a different address when submitting the enquiry.`);
  }
  if (liveForAgency.length) {
    warnings.push(`${agency.agency_name} already has ${liveForAgency.length} live probe(s) (${liveForAgency.map((r) => r.obj.probe_reference).join(', ')}). Replies matched by sender alone will be ambiguous; matching will rely on the per-probe email address.`);
  }
  return warnings;
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
