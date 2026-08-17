// api/novus/probe-create.js — POST /api/novus/probe-create
// Body: { agency_id, url }
//
// Creates a DRAFT probe for a KNOWN agency:
//   • agency_id comes from the agency the probe was launched from and is
//     validated against AGENCIES — it is never guessed and never blank
//   • url is the INDIVIDUAL property URL and is validated as such
//   • generates probe_id + collision-checked probe_reference
//   • attaches NOVUS_PROBE_EMAIL + NOVUS_PROBE_PHONE automatically
//   • best-effort property enrichment (gracefully blank if unavailable)
//   • writes one PROBES row with probe_status = "draft"
//
// It does NOT start the observation window. Only MARK AS SENT does that.
//
// ── WHY agency_id IS NOW REQUIRED ────────────────────────────────────────────
// This handler previously wrote `agency_id: ''` on every probe. That silently
// broke the whole downstream chain, because probe matching is keyed on the
// agency: lib/matching.mjs matchProbe() (and lib/phone-matching.mjs
// matchActiveProbe()) select PROBES rows WHERE agency_id === <matched agency>
// AND the observation window is open. With a blank agency_id no row could ever
// satisfy that, so every reply to a UI-created probe resolved to
// match_status='unmatched' — no probe_id on the COMMUNICATION, no INTELLIGENCE
// recompute, no ACTION. Only the imported historical rows (which carry an
// agency_id) worked. Requiring and validating agency_id here is the fix, and
// it is what makes AGENCY → PROBE → COMMUNICATION → INTELLIGENCE → ACTION hold.
//
// ── WHY THE PROPERTY URL IS VALIDATED ────────────────────────────────────────
// PROBES.property_url must be a specific property. An agency-profile URL or an
// area search ("...property-for-sale/Rayleigh.html") is not evidence of any
// individual listing, cannot be enriched, and would make the probe unauditable.
// lib/rightmove-urls.mjs rejects those kinds by name so the operator gets told
// exactly what they pasted.

import { getRepo } from '../../lib/sheets.mjs';
import { newProbeId, nextProbeReference } from '../../lib/ids.mjs';
import { fetchListingMeta } from '../../lib/rightmove-meta.mjs';
import { classifyRightmoveUrl, URL_KIND } from '../../lib/rightmove-urls.mjs';
import { requireAuth } from './_auth.mjs';

export const maxDuration = 20;

// Human-readable rejection copy per URL kind, so the operator can self-correct.
const URL_REJECTION = {
  [URL_KIND.AGENCY_PROFILE]:
    "That's the agency's Rightmove profile, not a property. Open the profile, click into a specific listing, and paste that URL instead.",
  [URL_KIND.PROPERTY_SEARCH]:
    "That's a Rightmove search/area results page, not a specific property. Open one listing and paste its URL (e.g. https://www.rightmove.co.uk/properties/123456789).",
  [URL_KIND.AGENT_SEARCH]:
    "That's a Rightmove estate-agent search page, not a property. Paste an individual property URL instead.",
  [URL_KIND.EMPTY]: 'Missing url',
  [URL_KIND.UNKNOWN]: 'That does not look like an individual Rightmove property URL.',
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const agencyId = String(body.agency_id || '').trim();
  const url = String(body.url || '').trim();

  if (!agencyId) {
    return res.status(400).json({
      error: 'Missing agency_id. A probe must be launched from an agency so replies can be attributed back to it.',
    });
  }
  if (!url) return res.status(400).json({ error: 'Missing url' });

  const portal = /rightmove\./i.test(url) ? 'rightmove'
    : /zoopla\./i.test(url) ? 'zoopla'
    : /onthemarket\./i.test(url) ? 'onthemarket'
    : 'rightmove';

  // Only Rightmove URLs are structurally classified (that is the portal NOVUS
  // probes today). Other portals keep the previous permissive check so this
  // change cannot regress a Zoopla/OTM probe.
  let propertyUrl = url;
  let propertyId = '';
  if (portal === 'rightmove') {
    const classified = classifyRightmoveUrl(url);
    if (classified.kind !== URL_KIND.PROPERTY) {
      return res.status(400).json({
        error: URL_REJECTION[classified.kind] || URL_REJECTION[URL_KIND.UNKNOWN],
        url_kind: classified.kind,
        url_reason: classified.reason,
      });
    }
    propertyUrl = classified.normalized;
    propertyId = classified.property_id;
  } else if (!/^https?:\/\/|^www\./i.test(url) && !url.includes('.')) {
    return res.status(400).json({ error: 'That does not look like a valid URL' });
  }

  try {
    const repo = getRepo();

    // ── 1) Validate the agency EXISTS. Never store an agency_id that does not
    // resolve — that would recreate the broken-foreign-key problem in a new form.
    const agency = await repo.findById('AGENCIES', 'agency_id', agencyId);
    if (!agency) {
      return res.status(404).json({ error: `Unknown agency_id "${agencyId}" — no such record in AGENCIES.` });
    }

    // Respect the existing suppression flag rather than inventing a new gate.
    if (String(agency.obj.suppression_status || '').trim().toLowerCase() === 'suppressed') {
      return res.status(409).json({
        error: `${agency.obj.agency_name || agencyId} is suppressed (${agency.obj.suppression_reason || 'no reason recorded'}). Probing it is blocked.`,
        agency_id: agencyId,
        suppressed: true,
      });
    }

    // ── 2) Duplicate guard. Two clicks of CREATE PROBE, a double-submit, or a
    // retry after a slow enrichment fetch must not mint two probes for the same
    // agency + property. An existing DRAFT for this pair is returned as-is.
    // A probe already 'observing' is NOT reused — re-probing the same property
    // later is legitimate — but it is reported so the operator sees it.
    const existingProbes = await repo.getRecords('PROBES', 'probe_id');
    const samePair = existingProbes.filter(
      (r) => r.obj.agency_id === agencyId && String(r.obj.property_url || '').trim() === propertyUrl,
    );
    const openDraft = samePair.find((r) => r.obj.probe_status === 'draft');
    if (openDraft) {
      return res.status(200).json({
        probe: openDraft.obj,
        agency: publicAgency(agency.obj),
        deduplicated: true,
        meta_source: 'existing',
      });
    }

    // ── 3) Best-effort enrichment — never blocks probe creation.
    const meta = await fetchListingMeta(propertyUrl).catch(() => ({
      address: '', price: '', status: '', property_type: '', bedrooms: '', title: '',
    }));

    // ── 4) Reference from existing references (not a row count) + collision step.
    const usedRefs = new Set(existingProbes.map((r) => String(r.obj.probe_reference || '').trim()));
    let reference = nextProbeReference([...usedRefs], portal);
    let guard = 0;
    while (usedRefs.has(reference) && guard < 50) {
      reference = nextProbeReference([...usedRefs, reference], portal);
      guard += 1;
    }

    const now = new Date().toISOString();
    const probe = {
      probe_id: newProbeId(),
      probe_reference: reference,
      agency_id: agencyId,
      portal,
      property_address: meta.address || '',
      property_url: propertyUrl,
      property_price: meta.price || '',
      property_status: meta.status || '',
      // New columns. repo.appendRecord maps onto the live header and DROPS keys
      // the sheet does not have, so these are forward-compatible: they persist
      // the moment the columns are added and are harmless until then.
      property_type: meta.property_type || '',
      property_bedrooms: meta.bedrooms || '',
      property_id: propertyId,
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

    return res.status(200).json({
      probe,
      agency: publicAgency(agency.obj),
      deduplicated: false,
      reprobe_of_existing: samePair.length > 0,
      meta_source: meta.address || meta.price ? 'fetched' : 'unavailable',
    });
  } catch (err) {
    console.error('probe-create error:', err);
    return res.status(500).json({ error: err.message || 'Failed to create probe' });
  }
}

// Only the fields the probe UI needs. Avoids shipping the full agency record
// (contact emails, notes) to the browser for no reason.
function publicAgency(obj) {
  return {
    agency_id: obj.agency_id || '',
    agency_name: obj.agency_name || '',
    location: obj.location || '',
    domain: obj.domain || '',
    rightmove_sales_branch_url: obj.rightmove_sales_branch_url || '',
    rightmove_status: obj.rightmove_status || '',
  };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
