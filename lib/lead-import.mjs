// lib/lead-import.mjs — pure reconciliation logic for importing the source
// lead database into the existing NOVUS AGENCIES/PROBES tabs.
//
// NOVUS rule: deterministic reconciliation only. Domain is the strongest
// identity signal; normalized name and phone are supporting signals only.
// A domain match is treated as the same agency (idempotent skip/merge); a
// same-phone-different-domain collision is never silently merged — it is
// flagged for manual review and both agencies are kept distinct, because we
// cannot be sure from this evidence alone whether they are one business
// with two web identities or two different businesses sharing a reception
// line.
//
// This module never builds COMMUNICATIONS or INTELLIGENCE rows: the lead
// database is a partial historical observation, not the authoritative raw
// evidence log those tables require (see the NOVUS evidence rule).

import { normalizePhone, canonicalTimestamp } from './normalize.mjs';
import { newAgencyId, newProbeId } from './ids.mjs';

export const SYNTHETIC_MARKER = 'SYNTHETIC TEST FIXTURE';
export const OBSERVATION_DAYS = 4; // must match api/novus/probe-mark-sent.js
export const HISTORICAL_SOURCE_TAG = 'historical_import';

// ── Normalization ──────────────────────────────────────────────────────────

export function normalizeWebsiteDomain(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let host;
  try {
    host = new URL(withScheme).hostname.toLowerCase();
  } catch {
    return '';
  }
  return host.startsWith('www.') ? host.slice(4) : host;
}

const NAME_STOPWORDS = /\b(estate agents?|letting agents?|lettings?|limited|ltd|llp|estates?|properties|property|group|residential|homes?|and|co)\b/g;

export function normalizeAgencyName(raw) {
  const spaced = String(raw ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  return spaced.replace(NAME_STOPWORDS, ' ').replace(/\s+/g, ' ').trim();
}

export function isSyntheticAgency(obj) {
  return String(obj.suppression_status ?? '') === 'suppressed'
    && String(obj.notes ?? '').includes(SYNTHETIC_MARKER);
}

// ── Schema guard ────────────────────────────────────────────────────────────
// Refuses to silently drop a field the live sheet header doesn't have — the
// caller must either add the column first or remove the field.
export function assertRecordMatchesHeader(header, obj, tab) {
  const unknown = Object.keys(obj).filter((k) => !header.includes(k));
  if (unknown.length) {
    throw new Error(
      `Refusing to write to ${tab}: column(s) not present in the live sheet header: ${unknown.join(', ')}.`
    );
  }
}

// ── Source row shaping ──────────────────────────────────────────────────────
// `row` is a plain object keyed by the exact source CSV headers (Slug, Firm,
// Town, Address, Phone, Website, Email, Director, First Name, Last Name,
// Listing URL, Rating, Reviews, Branches Found, Flags, Search Term,
// Place ID, Probe Sent, Probe Address, First Reply, Lag (hrs), Uses CRM?,
// FU?, Firm (Shortened)).

function cleanNumeric(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  return s.replace(/\.0$/, '');
}

function contactName(row) {
  const first = String(row['First Name'] ?? '').trim();
  const last = String(row['Last Name'] ?? '').trim();
  if (first || last) return [first, last].filter(Boolean).join(' ');
  return String(row.Director ?? '').trim();
}

// Values a genuine "Uses CRM?" / "FU?" cell could plausibly hold. Anything
// else (e.g. a street name that landed in the wrong column) is dirty source
// data — preserved verbatim, never trusted as CRM/follow-up evidence.
const PLAUSIBLE_YES_NO = new Set(['y', 'n', 'yes', 'no', 'true', 'false', '']);

function isDirty(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return v !== '' && !PLAUSIBLE_YES_NO.has(v);
}

// Builds the free-text provenance block written into notes/observation_notes.
// This is how source information is preserved WITHOUT adding new canonical
// columns — every raw field is labeled as an unverified historical source
// value, and anything dirty is flagged for manual review inline.
function buildProvenanceNote({ label, slug, fields }) {
  const lines = [`[${label} source=LEAD_DATABASE_1.xlsx slug=${slug}]`];
  const flags = [];
  for (const [key, val] of Object.entries(fields)) {
    if (val === '' || val === null || val === undefined) continue;
    lines.push(`${key}(raw, unverified)=${val}`);
    if (key === 'Uses CRM?' || key === 'FU?') {
      if (isDirty(val)) flags.push(`${key}="${val}" is not a plausible yes/no value`);
    }
  }
  if (flags.length) lines.push(`MANUAL REVIEW: ${flags.join('; ')}`);
  return lines.join(' | ');
}

// ── AGENCIES reconciliation ─────────────────────────────────────────────────
//
// existingRecords: [{ obj }] from repo.getRecords('AGENCIES', 'agency_id').
// sourceRows: array of raw source row objects (144 real agencies).
//
// Returns:
//   toCreate        new AGENCIES row objects to append
//   toMerge         [{ agency_id, patch }] — blank-field-only enrichment of an
//                    already-existing (non-synthetic) real agency row
//   alreadyExisting count of source rows that already resolved to a real
//                    agency (matched-and-unchanged + matched-and-merged)
//   ambiguousPhoneGroups groups of 2+ agencies (existing+new) sharing one
//                    normalized phone across DIFFERENT domains — flagged,
//                    never merged
//   domainIndex     Map(domain -> agency_id) after this reconciliation, for
//                    the caller to resolve historical probes' agency_id
//   skipped         [{ slug, reason }] rows that could not be identified
export function reconcileAgencies(existingRecords, sourceRows, { now = new Date().toISOString() } = {}) {
  const liveExisting = existingRecords.filter((r) => !isSyntheticAgency(r.obj));

  const domainIndex = new Map();
  for (const r of liveExisting) {
    const d = normalizeWebsiteDomain(r.obj.domain || r.obj.website);
    if (d) domainIndex.set(d, r.obj.agency_id);
  }

  const toCreate = [];
  const toMerge = [];
  const skipped = [];
  let alreadyExisting = 0;

  // phone_norm -> [{ agency_id, domain, slug }]
  const phoneGroups = new Map();
  const recordPhone = (phoneNorm, agencyId, domain, slug) => {
    if (!phoneNorm) return;
    const list = phoneGroups.get(phoneNorm) || [];
    list.push({ agency_id: agencyId, domain, slug });
    phoneGroups.set(phoneNorm, list);
  };
  for (const r of liveExisting) {
    recordPhone(normalizePhone(r.obj.main_phone), r.obj.agency_id, normalizeWebsiteDomain(r.obj.domain || r.obj.website), '(existing)');
  }

  for (const row of sourceRows) {
    const slug = String(row.Slug ?? '').trim();
    const domain = normalizeWebsiteDomain(row.Website);
    const phoneNorm = normalizePhone(row.Phone);

    if (!domain) {
      skipped.push({ slug, reason: 'no usable website/domain — cannot apply the strongest identity signal' });
      continue;
    }

    const existingAgencyId = domainIndex.get(domain);
    if (existingAgencyId) {
      alreadyExisting += 1;
      recordPhone(phoneNorm, existingAgencyId, domain, slug);

      const existingObj = liveExisting.find((r) => r.obj.agency_id === existingAgencyId).obj;
      const patch = {};
      const fillIfBlank = (field, value) => {
        if (value && !String(existingObj[field] ?? '').trim()) patch[field] = value;
      };
      fillIfBlank('primary_contact_name', contactName(row));
      fillIfBlank('primary_contact_email', String(row.Email ?? '').trim());
      fillIfBlank('main_phone', phoneNorm);
      fillIfBlank('location', String(row.Town ?? '').trim());
      fillIfBlank('branch_count', cleanNumeric(row['Branches Found']));
      if (Object.keys(patch).length) {
        patch.updated_at = now;
        toMerge.push({ agency_id: existingAgencyId, patch });
      }
      continue;
    }

    const agencyId = newAgencyId();
    domainIndex.set(domain, agencyId);
    recordPhone(phoneNorm, agencyId, domain, slug);

    const provenance = buildProvenanceNote({
      label: 'AGENCY',
      slug,
      fields: {
        Address: row.Address,
        Rating: cleanNumeric(row.Rating),
        Reviews: cleanNumeric(row.Reviews),
        'Search Term': row['Search Term'],
        'Place ID': row['Place ID'],
        Flags: row.Flags,
        'Uses CRM?': row['Uses CRM?'],
      },
    });

    toCreate.push({
      agency_id: agencyId,
      agency_name: String(row.Firm ?? '').trim(),
      website: String(row.Website ?? '').trim(),
      domain,
      location: String(row.Town ?? '').trim(),
      branch_count: cleanNumeric(row['Branches Found']),
      main_phone: phoneNorm,
      known_phone_numbers: '',
      primary_contact_name: contactName(row),
      primary_contact_email: String(row.Email ?? '').trim(),
      other_known_emails: '',
      owner_md: String(row.Director ?? '').trim(),
      independent_franchise_corporate: '',
      sales_led_lettings_only: '',
      years_trading: '',
      incorporation_date: '',
      live_listing_count: '',
      crm_name: '',
      crm_evidence: '',
      qualification_segment: '',
      current_pipeline_status: '',
      suppression_status: '',
      suppression_reason: '',
      notes: provenance,
      created_at: now,
      updated_at: now,
      _slug: slug, // internal only — stripped before writing, used to resolve probes below
    });
  }

  const ambiguousPhoneGroups = [...phoneGroups.entries()]
    .map(([phone, entries]) => ({ phone, entries: dedupeEntries(entries) }))
    .filter((g) => g.entries.length > 1 && new Set(g.entries.map((e) => e.domain)).size > 1);

  return { toCreate, toMerge, alreadyExisting, ambiguousPhoneGroups, domainIndex, skipped };
}

function dedupeEntries(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    if (seen.has(e.agency_id)) continue;
    seen.add(e.agency_id);
    out.push(e);
  }
  return out;
}

// ── PROBES (historical) reconciliation ──────────────────────────────────────
//
// domainIndex: Map(domain -> agency_id) as returned by reconcileAgencies
// (already includes both pre-existing and newly-created agencies).
// existingProbeRecords: [{ obj }] from repo.getRecords('PROBES', 'probe_id').
//
// Returns:
//   toCreate            new PROBES row objects to append
//   discovered          count of source rows with a non-blank "Probe Sent"
//   duplicatesAvoided   count of historical probes that already exist
//   skipped             [{ slug, reason }]
export function buildHistoricalProbes(sourceRows, domainIndex, existingProbeRecords, syntheticAgencyIds, { now = new Date().toISOString() } = {}) {
  const realExistingProbes = existingProbeRecords.filter((r) => !syntheticAgencyIds.has(r.obj.agency_id));
  // equivalence key: same agency + same probe_timestamp = the same probe.
  const existingKeys = new Set(
    realExistingProbes.map((r) => `${r.obj.agency_id}|${canonicalTimestamp(r.obj.probe_timestamp) || r.obj.probe_timestamp}`)
  );

  const toCreate = [];
  const skipped = [];
  let discovered = 0;
  let duplicatesAvoided = 0;
  let sequence = 0;

  for (const row of sourceRows) {
    const slug = String(row.Slug ?? '').trim();
    const probeSentRaw = String(row['Probe Sent'] ?? '').trim();
    if (!probeSentRaw) continue;
    discovered += 1;

    const domain = normalizeWebsiteDomain(row.Website);
    const agencyId = domainIndex.get(domain);
    if (!agencyId) {
      skipped.push({ slug, reason: 'agency could not be resolved (no domain match) — probe not imported' });
      continue;
    }

    const probeTimestamp = canonicalTimestamp(probeSentRaw);
    if (!probeTimestamp) {
      skipped.push({ slug, reason: `unparseable Probe Sent value: "${probeSentRaw}"` });
      continue;
    }

    const key = `${agencyId}|${probeTimestamp}`;
    if (existingKeys.has(key)) {
      duplicatesAvoided += 1;
      continue;
    }
    existingKeys.add(key); // guards against duplicate rows within this same source file

    const deadline = new Date(new Date(probeTimestamp).getTime() + OBSERVATION_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const provenance = buildProvenanceNote({
      label: 'PROBE',
      slug,
      fields: {
        'First Reply': row['First Reply'],
        'Lag (hrs)': row['Lag (hrs)'],
        'Uses CRM?': row['Uses CRM?'],
        'FU?': row['FU?'],
        'Probe Address (raw)': row['Probe Address'],
      },
    });

    sequence += 1;
    toCreate.push({
      probe_id: newProbeId(),
      probe_reference: `HIST-${String(sequence).padStart(4, '0')}`,
      agency_id: agencyId,
      portal: row['Listing URL'] ? 'agency_website' : 'unknown',
      property_address: String(row['Probe Address'] ?? '').trim(),
      property_url: String(row['Listing URL'] ?? '').trim(),
      property_price: '',
      property_status: '',
      enquiry_text: '',
      probe_email: '',
      probe_phone: '',
      probe_timestamp: probeTimestamp,
      observation_deadline: deadline,
      probe_status: 'observing',
      compromised: 'FALSE',
      compromise_reason: '',
      observation_closed_at: '',
      sent_from: HISTORICAL_SOURCE_TAG,
      observation_notes: provenance,
      created_at: now,
      updated_at: now,
    });
  }

  return { toCreate, discovered, duplicatesAvoided, skipped };
}

