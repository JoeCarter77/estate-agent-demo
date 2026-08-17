// lib/rightmove-meta.mjs — BEST-EFFORT property metadata for a pasted listing URL.
//
// SCOPE GUARDRAILS (deliberate, per NOVUS product rules):
//   • This is NOT scraping infrastructure. One short fetch of the public listing
//     page (plus, only when that is blocked, the SAME Bright Data Web Unlocker
//     credential the existing /api/scrape demo already uses — no new provider,
//     no new account). No browser automation, no retries, no proxy rotation, no
//     listing enumeration, no crawling.
//   • Rightmove frequently blocks datacentre IPs, so this will OFTEN return
//     little or nothing. That is expected: extraction is never a hard dependency
//     for probe creation. When it fails or returns too little, the caller falls
//     back to the CTRL+V screenshot path — the probe is created either way.
//
// Returns a flat field bag; every key is always present, '' / null when unknown:
//   address, street, postcode, price, bedrooms, bathrooms, property_type,
//   listing_status, agent_branch, title, details
// plus { _source, _blocked } diagnostics for the caller.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT_MS = 8000;
const BRIGHTDATA_TIMEOUT_MS = 12000;

export const EMPTY_FIELDS = Object.freeze({
  address: '',
  street: '',
  postcode: '',
  price: '',
  bedrooms: null,
  bathrooms: null,
  property_type: '',
  listing_status: '',
  agent_branch: '',
  title: '',
  details: '',
});

function emptyFields() { return { ...EMPTY_FIELDS }; }

function decode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&quot;/g, '"')
    .replace(/&pound;/g, '£')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function metaContent(html, prop) {
  // Handles both property="og:x" and name="x", attribute order-independent.
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = String(html || '').match(re);
    if (m) return decode(m[1]);
  }
  return '';
}

function formatPrice(value) {
  const n = typeof value === 'number' ? value : parseInt(String(value).replace(/[^\d]/g, ''), 10);
  if (!Number.isFinite(n) || n < 1000) return '';
  return `£${n.toLocaleString('en-GB')}`;
}

function firstPrice(text) {
  const m = String(text || '').match(/£\s?([\d,]{3,})/);
  return m ? formatPrice(m[1]) : '';
}

// UK postcode (full or outcode) as it appears in a display address.
export function extractPostcode(text) {
  const s = String(text || '').toUpperCase();
  const full = s.match(/\b([A-Z]{1,2}\d{1,2}[A-Z]?)\s?(\d[A-Z]{2})\b/);
  if (full) return `${full[1]} ${full[2]}`;
  const out = s.match(/\b([A-Z]{1,2}\d{1,2}[A-Z]?)\b(?=\s*(?:,|$))/);
  return out ? out[1] : '';
}

// First comma-separated segment of a display address is the street line.
function streetFrom(address) {
  const first = String(address || '').split(',')[0].trim();
  return first && first.length <= 80 ? first : '';
}

function intOrNull(v) {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) && n >= 0 && n < 100 ? n : null;
}

// Pulls the JS object literal assigned to `window.<name>` out of an inline
// <script>, by brace-balancing from the first '{'. Rightmove's property detail
// page ships its whole model this way (window.PAGE_MODEL).
export function extractWindowJson(html, name) {
  const src = String(html || '');
  const at = src.indexOf(`window.${name}`);
  if (at === -1) return null;
  const start = src.indexOf('{', at);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(src.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

// Rightmove's own model — by far the richest source when the page isn't blocked.
function fromPageModel(html) {
  const out = emptyFields();
  const model = extractWindowJson(html, 'PAGE_MODEL');
  const p = model && (model.propertyData || model.property || null);
  if (!p || typeof p !== 'object') return out;

  const addr = p.address || {};
  out.address = decode(addr.displayAddress || '');
  out.street = streetFrom(out.address);
  const outIn = [addr.outcode, addr.incode].filter(Boolean).join(' ').trim();
  out.postcode = outIn || extractPostcode(out.address);

  out.price = formatPrice(p.prices?.primaryPrice ?? p.prices?.displayPrice ?? p.price ?? '') ||
    firstPrice(p.prices?.primaryPrice || p.prices?.displayPrice || '');
  out.bedrooms = intOrNull(p.bedrooms);
  out.bathrooms = intOrNull(p.bathrooms);
  out.property_type = decode(p.propertySubType || p.propertyType || '');

  const status = p.status || {};
  if (status.archived === true) out.listing_status = 'archived';
  else if (p.transactionType && /let|rent/i.test(String(p.transactionType))) out.listing_status = 'to let';
  else if (p.tags && Array.isArray(p.tags) && p.tags.length) out.listing_status = decode(String(p.tags[0]));
  else if (status.published === true) out.listing_status = 'live';

  const c = p.customer || {};
  out.agent_branch = decode([c.companyName, c.branchDisplayName || c.branchName].filter(Boolean).join(' — '));

  const text = p.text || {};
  out.title = decode(p.propertySubType ? `${p.bedrooms ?? ''} bed ${p.propertySubType}`.trim() : '');
  out.details = decode(String(text.description || text.propertyPhrase || '').replace(/<[^>]+>/g, ' ')).slice(0, 1200);
  return out;
}

// schema.org JSON-LD (Residence / Offer) — present on some listing variants.
function fromJsonLd(html) {
  const out = emptyFields();
  const blocks = String(html || '').match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of blocks) {
    const jsonText = block.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim();
    let data;
    try { data = JSON.parse(jsonText); } catch { continue; }
    const items = Array.isArray(data) ? data : [data];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const addr = item.address;
      if (!out.address && addr) {
        if (typeof addr === 'string') out.address = decode(addr);
        else if (typeof addr === 'object') {
          out.address = decode([addr.streetAddress, addr.addressLocality, addr.postalCode].filter(Boolean).join(', '));
          if (!out.street && addr.streetAddress) out.street = decode(addr.streetAddress);
          if (!out.postcode && addr.postalCode) out.postcode = decode(addr.postalCode);
        }
      }
      const offers = item.offers || item.priceSpecification;
      const price = offers && (offers.price || offers.priceSpecification?.price);
      if (!out.price && price) out.price = formatPrice(price);
      if (out.bedrooms === null) out.bedrooms = intOrNull(item.numberOfRooms ?? item.numberOfBedrooms);
      if (out.bathrooms === null) out.bathrooms = intOrNull(item.numberOfBathroomsTotal ?? item.numberOfBathrooms);
      if (!out.property_type && item['@type'] && item['@type'] !== 'Product') out.property_type = decode(String(item['@type']));
    }
  }
  return out;
}

// Last resort: the og: tags Rightmove renders server-side even on some
// otherwise-JS pages.
function fromOpenGraph(html) {
  const out = emptyFields();
  const title = metaContent(html, 'og:title');
  const desc = metaContent(html, 'og:description');
  out.title = title;
  out.details = desc.slice(0, 600);
  out.address = title.replace(/^\d+\s+bed(room)?\s+\w+\s+for sale\s*(in|,)?\s*/i, '').trim() || title;
  out.price = firstPrice(title) || firstPrice(desc);
  const beds = (title.match(/(\d+)\s*bed/i) || desc.match(/(\d+)\s*bed/i));
  if (beds) out.bedrooms = intOrNull(beds[1]);
  const baths = (title.match(/(\d+)\s*bath/i) || desc.match(/(\d+)\s*bath/i));
  if (baths) out.bathrooms = intOrNull(baths[1]);
  const type = title.match(/\b(detached|semi-detached|terraced|flat|apartment|bungalow|maisonette|cottage|studio|townhouse|land)\b/i);
  if (type) out.property_type = type[1].toLowerCase();
  if (/\bfor sale\b/i.test(title)) out.listing_status = 'for sale';
  else if (/\bto rent\b|\bto let\b/i.test(title)) out.listing_status = 'to let';
  return out;
}

// Later sources only fill gaps — an earlier, richer source is never overwritten.
function mergeFields(...sources) {
  const out = emptyFields();
  for (const src of sources) {
    if (!src) continue;
    for (const key of Object.keys(out)) {
      const val = src[key];
      const empty = out[key] === '' || out[key] === null;
      const has = val !== undefined && val !== null && val !== '';
      if (empty && has) out[key] = val;
    }
  }
  if (!out.street && out.address) out.street = streetFrom(out.address);
  if (!out.postcode && out.address) out.postcode = extractPostcode(out.address);
  return out;
}

// "Enough to confirm a property" = an address (or title) AND at least one other
// concrete attribute. Anything less and the caller should offer the screenshot
// fallback rather than ask Joe to confirm a near-empty card.
export function isSufficient(fields) {
  if (!fields) return false;
  const hasIdentity = Boolean(fields.address || fields.title);
  const extras = [fields.price, fields.bedrooms, fields.bathrooms, fields.property_type, fields.postcode]
    .filter((v) => v !== null && v !== undefined && v !== '').length;
  return hasIdentity && extras >= 1;
}

async function fetchHtml(target) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(target, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-GB,en;q=0.9' },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) return { html: '', blocked: res.status === 403 || res.status === 429 || res.status >= 500 };
    const ct = res.headers.get('content-type') || '';
    if (ct && !ct.includes('html')) return { html: '', blocked: false };
    return { html: await res.text(), blocked: false };
  } catch {
    return { html: '', blocked: true }; // timeout / network / abort
  }
}

// Reuses the EXISTING Bright Data Web Unlocker credential already used by
// api/scrape.js. No new provider, no new account, no new env var beyond the
// ones the demo scraper already documents. Absent key → simply skipped.
async function brightDataFetch(url) {
  const key = process.env.BRIGHTDATA_KEY;
  if (!key) return '';
  const zone = process.env.BRIGHTDATA_ZONE || 'web_unlocker1';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BRIGHTDATA_TIMEOUT_MS);
    const r = await fetch('https://api.brightdata.com/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ zone, url, format: 'raw', country: 'gb' }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return '';
    return await r.text();
  } catch {
    return '';
  }
}

// Pure parsing half — exported so tests can exercise every source without network.
export function parseListingHtml(html) {
  return mergeFields(fromPageModel(html), fromJsonLd(html), fromOpenGraph(html));
}

// Full best-effort extraction. NEVER throws: on any failure it returns empty
// fields with _blocked/_source set so the caller can activate the screenshot
// fallback immediately.
export async function fetchListingFields(url) {
  if (!url) return { ...emptyFields(), _source: 'none', _blocked: false };
  const target = url.startsWith('http') ? url : `https://${url}`;

  const direct = await fetchHtml(target);
  let fields = direct.html ? parseListingHtml(direct.html) : emptyFields();
  let source = direct.html ? 'fetch' : 'none';

  if (!isSufficient(fields)) {
    const bdHtml = await brightDataFetch(target);
    if (bdHtml) {
      const bdFields = parseListingHtml(bdHtml);
      const merged = mergeFields(bdFields, fields);
      if (isSufficient(merged) || !isSufficient(fields)) {
        fields = merged;
        source = 'brightdata';
      }
    }
  }

  return { ...fields, _source: source, _blocked: direct.blocked && source !== 'brightdata' };
}
