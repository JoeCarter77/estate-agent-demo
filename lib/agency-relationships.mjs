// lib/agency-relationships.mjs — brand / branch identity across AGENCIES.
//
// One company can legitimately appear in AGENCIES more than once: a second
// branch (Pocock & Shaw Ely next to Pocock + Shaw Newmarket) or, by accident, a
// re-import of the very same branch (SJ Warren Burnham-on-Crouch twice, once
// from the 2 Sept import). agency_id cannot tell them apart — every import
// mints a fresh id — so identity is decided here from the evidence the rows
// actually carry: domain, Rightmove branch id and brand slug, phone, postcode,
// outreach email and normalised name.
//
// Pure functions only. Callers pass AGENCIES / PROBES row objects; nothing here
// reads or writes Sheets.
//
// Pair verdicts, strongest first:
//   EXACT_BRANCH   the same physical branch (same Rightmove branch id, or the
//                  same brand plus the same phone/postcode with no conflicting
//                  Rightmove branch id).
//   OTHER_BRANCH   the same company, a different branch (same non-generic
//                  domain with a matching name, or the same outreach mailbox;
//                  different branch evidence).
//   RIGHTMOVE_URL_CONFLICT  the same Rightmove branch page on records that
//                  otherwise disagree (different phone/postcode/domain): one
//                  of them carries the wrong Rightmove URL.
//   AMBIGUOUS      some shared identity, not enough to say which (same phone
//                  under a different brand, same name on different domains,
//                  one domain carrying dissimilar names, same brand + phone
//                  but different Rightmove branch ids).
// No verdict means unrelated.

const text = (value) => String(value ?? '').trim();
const lower = (value) => text(value).toLowerCase();

// Mailbox, portal and site-builder hosts say nothing about who the company is.
const GENERIC_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'live.co.uk',
  'yahoo.com', 'yahoo.co.uk', 'btinternet.com', 'icloud.com', 'me.com', 'aol.com', 'msn.com', 'sky.com',
  'rightmove.co.uk', 'zoopla.co.uk', 'onthemarket.com', 'facebook.com', 'instagram.com', 'linkedin.com',
  'google.com', 'sites.google.com', 'business.site', 'wixsite.com', 'linktr.ee', 'yell.com',
]);

// Words that describe the trade, not the brand.
const NAME_STOPWORDS = new Set([
  'the', 'and', 'estate', 'estates', 'agent', 'agents', 'agency', 'ltd', 'limited', 'llp', 'plc', 'co', 'company',
  'sales', 'lettings', 'letting', 'lets', 'property', 'properties', 'residential', 'homes', 'group',
  'chartered', 'surveyors', 'surveyor', 'uk',
]);

export function normaliseDomain(value) {
  const raw = lower(value).replace(/^mailto:/, '');
  const host = raw.includes('@') ? raw.split('@').pop() : raw.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0];
  return host.replace(/^www\./, '').replace(/\.$/, '');
}

function brandDomain(agency) {
  const domain = normaliseDomain(agency?.domain) || normaliseDomain(agency?.website);
  return domain && !GENERIC_DOMAINS.has(domain) ? domain : '';
}

// "Pocock + Shaw" and "Pocock & Shaw" are the same brand; so are
// "SJ Warren" and "SJ Warren Estate Agents Burnham-On-Crouch" (whole-word
// prefix). "Pococks" is NOT "Pocock + Shaw". Returns space-joined words.
export function normaliseName(value) {
  return lower(value).replace(/[&+]/g, ' and ').replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter((word) => word && !NAME_STOPWORDS.has(word)).join(' ');
}

function namesSimilar(a, b) {
  if (!a || !b) return false;
  if (a.replace(/ /g, '') === b.replace(/ /g, '')) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.replace(/ /g, '').length >= 6 && `${long} `.startsWith(`${short} `);
}

// https://www.rightmove.co.uk/estate-agents/agent/Pocock-and-Shaw/Cottenham-217103.html
//   → { brand: 'pocockshaw', branchId: '217103' }
export function parseRightmoveBranch(url) {
  const match = text(url).match(/\/agent\/([^/]+)\/[^/]*?-(\d+)\.html/i);
  if (!match) return { brand: '', branchId: '' };
  const brand = match[1].toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && w !== 'and').join('');
  return { brand, branchId: match[2] };
}

export function normalisePhone(value) {
  let digits = text(value).replace(/\D/g, '');
  if (digits.startsWith('44')) digits = `0${digits.slice(2)}`;
  return digits.length >= 10 ? digits.slice(-10) : '';
}

const POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;
export function extractPostcode(value) {
  const match = text(value).match(POSTCODE);
  return match ? `${match[1]}${match[2]}`.toUpperCase() : '';
}

function mailbox(value) {
  const email = lower(value);
  return email.includes('@') && !GENERIC_DOMAINS.has(email.split('@').pop()) ? email : '';
}

export function agencyKeys(agency) {
  const rightmove = parseRightmoveBranch(agency?.rightmove_sales_branch_url);
  const phones = new Set([agency?.main_phone, ...text(agency?.known_phone_numbers).split(/[,;/|]/)]
    .map(normalisePhone).filter(Boolean));
  return {
    agency_id: text(agency?.agency_id),
    domain: brandDomain(agency),
    name: normaliseName(agency?.clean_agency_name || agency?.agency_name),
    rmBrand: rightmove.brand,
    rmBranchId: rightmove.branchId,
    phones,
    postcode: extractPostcode(agency?.location),
    outreachEmail: mailbox(agency?.outreach_contact_email),
  };
}

const intersects = (a, b) => [...a].some((value) => b.has(value));

// The verdict for one ordered pair, with the evidence that produced it.
export function comparePair(a, b) {
  const evidence = [];
  const sameRmBranch = a.rmBranchId && a.rmBranchId === b.rmBranchId;
  const rmBranchConflict = a.rmBranchId && b.rmBranchId && a.rmBranchId !== b.rmBranchId;
  const samePhone = intersects(a.phones, b.phones);
  const samePostcode = a.postcode && a.postcode === b.postcode;
  const sameDomain = a.domain && a.domain === b.domain;
  const sameRmBrand = a.rmBrand && a.rmBrand === b.rmBrand;
  const sameMailbox = a.outreachEmail && a.outreachEmail === b.outreachEmail;
  const similarName = namesSimilar(a.name, b.name);

  if (sameRmBranch) evidence.push(`same Rightmove branch id ${a.rmBranchId}`);
  if (sameDomain) evidence.push(`same domain ${a.domain}`);
  if (sameRmBrand) evidence.push('same Rightmove brand');
  if (sameMailbox) evidence.push(`same outreach email ${a.outreachEmail}`);
  if (similarName) evidence.push('matching brand name');
  if (samePhone) evidence.push('same phone number');
  if (samePostcode) evidence.push(`same postcode ${a.postcode}`);
  if (rmBranchConflict) evidence.push(`different Rightmove branch ids (${a.rmBranchId} vs ${b.rmBranchId})`);

  const phoneConflict = a.phones.size && b.phones.size && !samePhone;
  const postcodeConflict = a.postcode && b.postcode && !samePostcode;
  if (phoneConflict) evidence.push('different phone numbers');
  if (postcodeConflict) evidence.push(`different postcodes (${a.postcode} vs ${b.postcode})`);

  // The same Rightmove page is only the same branch when the rest of the
  // record agrees. The 21 Sept import attached other agencies' Rightmove pages
  // to unrelated companies (Hadley & Co Redditch → Statons Hadley Wood); those
  // are not duplicates, but probing that URL would enquire at the other branch.
  if (sameRmBranch) {
    const agrees = samePhone || samePostcode || (sameDomain && !phoneConflict && !postcodeConflict);
    return { verdict: agrees ? 'EXACT_BRANCH' : 'RIGHTMOVE_URL_CONFLICT', evidence };
  }

  // A shared domain with dissimilar names is a franchise network or a portal
  // host, not proof of one company.
  // The Rightmove brand slug is only the display name ("Saxons" in Weston and
  // "Saxons" in Colchester are different firms), so it is name-level evidence.
  const nameLevel = similarName || sameRmBrand;
  const strongBrand = sameMailbox || (sameDomain && (nameLevel || !a.name || !b.name));
  const anyBrand = strongBrand || nameLevel || sameDomain;
  const sameSite = samePhone || samePostcode;

  if (strongBrand && sameSite && !rmBranchConflict) return { verdict: 'EXACT_BRANCH', evidence };
  if (strongBrand && sameSite && rmBranchConflict) return { verdict: 'AMBIGUOUS', evidence };
  if (strongBrand) return { verdict: 'OTHER_BRANCH', evidence };
  if (samePhone) return { verdict: 'AMBIGUOUS', evidence };
  // Two firms that each run their own website are different firms, however
  // alike the names ("Town and Country" in Leigh-on-Sea and in Trowbridge).
  const differentDomains = a.domain && b.domain && !sameDomain;
  if (anyBrand && !differentDomains) return { verdict: 'AMBIGUOUS', evidence };
  return null;
}

// An index so a single agency (or a whole-sheet audit) compares only against
// rows that share at least one key, not against all ~2,500.
// rowNumbers[i] is agencies[i]'s physical sheet row (repo records carry it as
// rowNumber); without it the row is assumed to be position + 2 (header row 1).
export function buildAgencyIndex(agencies, rowNumbers = []) {
  const rows = (agencies || []).map((agency, position) => ({
    agency, sheetRow: rowNumbers[position] ?? position + 2, keys: agencyKeys(agency),
  }));
  const buckets = new Map();
  const add = (key, row) => { if (!key) return; if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(row); };
  for (const row of rows) {
    const k = row.keys;
    add(k.domain && `d:${k.domain}`, row);
    add(k.rmBrand && `rb:${k.rmBrand}`, row);
    add(k.rmBranchId && `ri:${k.rmBranchId}`, row);
    add(k.outreachEmail && `m:${k.outreachEmail}`, row);
    add(k.postcode && `pc:${k.postcode}`, row);
    add(k.name && `n:${k.name.replace(/ /g, '').slice(0, 5)}`, row);
    for (const phone of k.phones) add(`p:${phone}`, row);
  }
  const byId = new Map(rows.map((row) => [row.keys.agency_id, row]));
  return { rows, buckets, byId };
}

function candidatesFor(index, keys) {
  const seen = new Set();
  const out = [];
  const take = (key) => { for (const row of index.buckets.get(key) || []) if (!seen.has(row)) { seen.add(row); out.push(row); } };
  if (keys.domain) take(`d:${keys.domain}`);
  if (keys.rmBrand) take(`rb:${keys.rmBrand}`);
  if (keys.rmBranchId) take(`ri:${keys.rmBranchId}`);
  if (keys.outreachEmail) take(`m:${keys.outreachEmail}`);
  if (keys.postcode) take(`pc:${keys.postcode}`);
  if (keys.name) take(`n:${keys.name.replace(/ /g, '').slice(0, 5)}`);
  for (const phone of keys.phones) take(`p:${phone}`);
  return out;
}

// PROBE HISTORY OF ONE AGENCY. "Probed" is the same physical fact the Prober
// queue trusts (AGENCIES.probe_sent non-blank) OR any PROBES row that left
// draft. A draft-only probe is reported separately: nothing was sent yet.
export function probeHistory(agency, probesByAgency) {
  const probes = probesByAgency?.get(text(agency?.agency_id)) || [];
  const sent = probes.filter((p) => text(p.probe_timestamp) || !['', 'draft'].includes(lower(p.probe_status)));
  return {
    probed: text(agency?.probe_sent) !== '' || sent.length > 0,
    probe_count: sent.length,
    draft_count: probes.length - sent.length,
    probe_references: probes.map((p) => text(p.probe_reference)).filter(Boolean),
    last_probe_at: sent.map((p) => text(p.probe_timestamp)).filter(Boolean).sort().pop() || '',
  };
}

export function groupProbesByAgency(probes) {
  const map = new Map();
  for (const probe of probes || []) {
    const id = text(probe?.agency_id);
    if (!id) continue;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(probe);
  }
  return map;
}

const RANK = { EXACT_BRANCH: 4, RIGHTMOVE_URL_CONFLICT: 3, OTHER_BRANCH: 2, AMBIGUOUS: 1 };

// EVERYTHING NOVUS KNOWS ABOUT HOW ONE AGENCY RELATES TO THE REST.
//
// status: EXACT_DUPLICATE | OTHER_BRANCH | AMBIGUOUS | UNRELATED
// canonical_agency_id: for EXACT_DUPLICATE, the row that should be kept — a
//   probed one first, otherwise the earliest in sheet order. Blank when this
//   row is itself the canonical one.
// probe_decision:
//   BLOCKED_EXACT_BRANCH_PROBED  the same branch has already been probed
//   BLOCKED_RIGHTMOVE_URL_PROBED this record's Rightmove page belongs to a
//                                probed record that is otherwise different
//   CONFIRM_RELATED_PROBED       a related/ambiguous record was probed; a
//                                deliberate branch-specific probe needs
//                                explicit confirmation
//   CLEAR                        nothing related has been probed
export function describeAgencyRelationships(agencyId, index, probesByAgency) {
  const self = index.byId.get(text(agencyId));
  if (!self) return null;
  const related = [];
  for (const other of candidatesFor(index, self.keys)) {
    if (other === self) continue;
    const pair = comparePair(self.keys, other.keys);
    if (!pair) continue;
    const history = probeHistory(other.agency, probesByAgency);
    related.push({
      agency_id: other.keys.agency_id,
      agency_name: text(other.agency.clean_agency_name || other.agency.agency_name),
      location: text(other.agency.location),
      sheet_row: other.sheetRow,
      relationship: pair.verdict,
      evidence: pair.evidence,
      ...history,
    });
  }
  related.sort((a, b) => RANK[b.relationship] - RANK[a.relationship] || a.sheet_row - b.sheet_row);

  const top = related[0]?.relationship || '';
  const status = top === 'EXACT_BRANCH' ? 'EXACT_DUPLICATE'
    : top === 'RIGHTMOVE_URL_CONFLICT' ? 'AMBIGUOUS' : top || 'UNRELATED';
  const selfHistory = probeHistory(self.agency, probesByAgency);

  let canonical = '';
  if (status === 'EXACT_DUPLICATE') {
    const group = [{ agency_id: self.keys.agency_id, sheet_row: self.sheetRow, probed: selfHistory.probed },
      ...related.filter((r) => r.relationship === 'EXACT_BRANCH')];
    group.sort((a, b) => Number(b.probed) - Number(a.probed) || a.sheet_row - b.sheet_row);
    canonical = group[0].agency_id === self.keys.agency_id ? '' : group[0].agency_id;
  }

  // Probing enquires at the Rightmove branch page, so a probed record on the
  // same page blocks the probe whether or not the rest of the record agrees.
  const samePageProbed = related.filter((r) => ['EXACT_BRANCH', 'RIGHTMOVE_URL_CONFLICT'].includes(r.relationship) && r.probed);
  const otherProbed = related.filter((r) => ['OTHER_BRANCH', 'AMBIGUOUS'].includes(r.relationship) && r.probed);
  const probeDecision = samePageProbed.some((r) => r.relationship === 'EXACT_BRANCH') ? 'BLOCKED_EXACT_BRANCH_PROBED'
    : samePageProbed.length ? 'BLOCKED_RIGHTMOVE_URL_PROBED'
      : otherProbed.length ? 'CONFIRM_RELATED_PROBED' : 'CLEAR';

  return {
    agency_id: self.keys.agency_id,
    brand_key: self.keys.domain || self.keys.rmBrand || self.keys.name.replace(/ /g, ''),
    status,
    canonical_agency_id: canonical,
    probe_decision: probeDecision,
    self_probe_history: selfHistory,
    related,
  };
}

// records: repo.getRecords() output ({ obj, rowNumber }).
export function relationshipsForAgency(agencyId, agencyRecords, probeRecords) {
  const index = buildAgencyIndex((agencyRecords || []).map((r) => r.obj), (agencyRecords || []).map((r) => r.rowNumber));
  return describeAgencyRelationships(agencyId, index, groupProbesByAgency((probeRecords || []).map((r) => r.obj)));
}

// The operator sentence for a probe decision — used by the API error and the
// Prober panel so they never drift apart.
export function relationshipSummary(rel) {
  if (!rel) return '';
  const name = (r) => `${r.agency_name}${r.location ? ` (${r.location.split(',')[0]})` : ''}`;
  const refs = (r) => (r.probe_references.length ? ` — ${r.probe_references.join(', ')}` : '');
  if (rel.probe_decision === 'BLOCKED_EXACT_BRANCH_PROBED') {
    const hit = rel.related.find((r) => r.relationship === 'EXACT_BRANCH' && r.probed);
    return `This exact branch has already been probed as ${name(hit)}, sheet row ${hit.sheet_row}${refs(hit)}. It is a duplicate record — skip it or delete it.`;
  }
  if (rel.probe_decision === 'BLOCKED_RIGHTMOVE_URL_PROBED') {
    const hit = rel.related.find((r) => r.relationship === 'RIGHTMOVE_URL_CONFLICT' && r.probed);
    return `This agency's Rightmove URL is the branch page of ${name(hit)}, sheet row ${hit.sheet_row}${refs(hit)}, which has already been probed. The records otherwise disagree, so one of them carries the wrong Rightmove URL — correct it or skip this agency.`;
  }
  if (rel.probe_decision === 'CONFIRM_RELATED_PROBED') {
    const hits = rel.related.filter((r) => ['OTHER_BRANCH', 'AMBIGUOUS'].includes(r.relationship) && r.probed);
    const kind = hits.every((r) => r.relationship === 'OTHER_BRANCH') ? 'Another branch of this company' : 'A possibly related agency';
    return `${kind} has already been probed: ${hits.map((r) => `${name(r)}, row ${r.sheet_row}${refs(r)}`).join('; ')}. Probe this branch only if that is deliberate.`;
  }
  return '';
}
