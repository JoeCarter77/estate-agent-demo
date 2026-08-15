// lib/agency-import.mjs — pure CSV -> AGENCIES record mapping.
//
// The scraped lead CSV (agent_leads_with_slugs.csv) is the ONLY source of the
// ~150 real agencies. Until those rows exist in the AGENCIES tab, no inbound
// communication can ever match an agency, so nothing downstream works. This
// module turns CSV rows into AGENCIES records; scripts/import-agencies.mjs
// does the I/O.
//
// One Agency ID per agency, forever: agency_id is DERIVED from the CSV Slug
// (`ag_<slug>`), never randomly generated. That makes the import idempotent —
// re-running it updates the same rows instead of creating competing duplicate
// identities for the same agency.
//
// Everything here is deterministic. No AI, no fuzzy matching, no invented
// fields: a column that isn't in the CSV is left blank for a human to fill.

import { normalizePhone } from './normalize.mjs';

// Minimal RFC-4180-ish CSV parser (quoted fields, embedded commas, escaped
// quotes, CRLF) — same shape as scripts/import-leads.mjs, kept local so this
// module has no dependency on the public-demo tooling.
export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c === '\r') {
      // swallow — handled by the following \n
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v !== ''));
}

// Website -> bare lowercase registrable host, e.g.
// "http://www.ashtonwhite.co.uk/?utm_source=x" -> "ashtonwhite.co.uk".
// Returns '' when the cell is empty or unparseable — never a guess.
export function domainFromWebsite(website) {
  const raw = String(website ?? '').trim();
  if (!raw) return '';
  let host = raw;
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // strip scheme
  host = host.split(/[/?#]/)[0];                        // strip path/query/fragment
  host = host.split('@').pop();                         // strip any userinfo
  host = host.split(':')[0];                            // strip port
  host = host.trim().toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  // A registrable host needs at least one dot and no whitespace.
  if (!host.includes('.') || /\s/.test(host)) return '';
  return host;
}

// Email -> lowercase domain, used only as a fallback when Website is unusable.
export function domainFromEmail(email) {
  const at = String(email ?? '').trim().toLowerCase().lastIndexOf('@');
  if (at < 0) return '';
  const domain = String(email).trim().toLowerCase().slice(at + 1);
  return domain.includes('.') ? domain : '';
}

// Free-email hosts must NEVER become an agency's `domain`: dozens of agencies
// can share gmail.com, so a domain_exact match on one would be ambiguous at
// best and wrong at worst. The matcher already refuses to guess when a domain
// maps to 2+ agencies, but keeping these out of the column entirely means the
// signal is never even offered.
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.co.uk', 'outlook.com',
  'outlook.co.uk', 'live.co.uk', 'live.com', 'yahoo.com', 'yahoo.co.uk',
  'aol.com', 'btinternet.com', 'sky.com', 'icloud.com', 'me.com', 'msn.com',
]);

export function isFreeEmailDomain(domain) {
  return FREE_EMAIL_DOMAINS.has(String(domain ?? '').trim().toLowerCase());
}

// Stable, human-legible, permanent primary key derived from the CSV slug.
export function agencyIdFromSlug(slug) {
  const clean = String(slug ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  return clean ? `ag_${clean}` : '';
}

// Normalise a header cell to a comparable key.
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// Maps one parsed CSV row to an AGENCIES record, or null if it has no slug.
// `now` is injected so the caller controls timestamps (and tests stay stable).
export function agencyRecordFromRow(get, now) {
  const slug = get('slug').trim().toLowerCase();
  const agencyId = agencyIdFromSlug(slug);
  if (!agencyId) return null;

  const website = get('website');
  const email = get('email');
  const websiteDomain = domainFromWebsite(website);
  const emailDomain = domainFromEmail(email);

  // Prefer the website's domain; fall back to the email's only when it is a
  // real agency domain rather than a shared free-email host.
  let domain = websiteDomain;
  if (!domain && emailDomain && !isFreeEmailDomain(emailDomain)) domain = emailDomain;
  if (isFreeEmailDomain(domain)) domain = '';

  const phone = normalizePhone(get('phone'));
  const director = get('director');
  const branchCount = get('branches found');

  return {
    agency_id: agencyId,
    agency_name: get('firm'),
    website,
    domain,
    location: get('town') || get('address'),
    branch_count: branchCount,
    main_phone: phone,
    known_phone_numbers: phone,
    primary_contact_name: director || [get('first name'), get('last name')].filter(Boolean).join(' '),
    primary_contact_email: get('email').trim().toLowerCase(),
    other_known_emails: '',
    owner_md: director,
    // Deliberately blank: the CSV does not contain these, and inventing them
    // would create facts NOVUS cannot evidence. Filled by qualification later.
    independent_franchise_corporate: '',
    sales_led_lettings_only: '',
    years_trading: '',
    incorporation_date: '',
    live_listing_count: '',
    crm_name: '',
    crm_evidence: '',
    qualification_segment: '',
    current_pipeline_status: 'not_probed',
    suppression_status: '',
    suppression_reason: '',
    notes: [
      get('place id') ? `google_place_id=${get('place id')}` : '',
      get('rating') ? `rating=${get('rating')}` : '',
      get('reviews') ? `reviews=${get('reviews')}` : '',
      get('listing url') ? `own_site_listing=${get('listing url')}` : '',
      `imported_from=agent_leads_with_slugs.csv slug=${slug}`,
    ].filter(Boolean).join(' | '),
    created_at: now,
    updated_at: now,
  };
}

// Full CSV text -> { records, skipped, duplicateSlugs }.
export function buildAgencyRecords(csvText, now = new Date().toISOString()) {
  const rows = parseCSV(csvText);
  if (!rows.length) return { records: [], skipped: 0, duplicateSlugs: [] };

  const header = rows[0].map(norm);
  const get = (cells) => (label) => {
    const i = header.indexOf(label);
    return i === -1 ? '' : String(cells[i] ?? '').trim();
  };

  const records = [];
  const seen = new Map();
  const duplicateSlugs = [];
  let skipped = 0;

  for (let r = 1; r < rows.length; r++) {
    const record = agencyRecordFromRow(get(rows[r]), now);
    if (!record) { skipped += 1; continue; }
    if (seen.has(record.agency_id)) {
      // Two CSV rows claiming the same identity — never silently merge them.
      duplicateSlugs.push(record.agency_id);
      continue;
    }
    seen.set(record.agency_id, true);
    records.push(record);
  }

  return { records, skipped, duplicateSlugs };
}

// Reports domains/phones shared by 2+ agencies. These are not errors — they
// are exactly the inputs that make deterministic matching return 'ambiguous'
// rather than a wrong Agency ID — but Joe needs to know they exist BEFORE
// probing, because those agencies' replies will land in the review queue.
export function findAmbiguousSignals(records) {
  const byDomain = new Map();
  const byPhone = new Map();
  for (const r of records) {
    if (r.domain) {
      if (!byDomain.has(r.domain)) byDomain.set(r.domain, []);
      byDomain.get(r.domain).push(r.agency_id);
    }
    if (r.main_phone) {
      if (!byPhone.has(r.main_phone)) byPhone.set(r.main_phone, []);
      byPhone.get(r.main_phone).push(r.agency_id);
    }
  }
  const domains = [...byDomain.entries()].filter(([, ids]) => ids.length > 1);
  const phones = [...byPhone.entries()].filter(([, ids]) => ids.length > 1);
  return { domains, phones };
}
