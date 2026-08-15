// lib/rightmove-meta.mjs — property metadata for a pasted listing URL.
//
// TWO DIFFERENT KINDS OF FIELD LIVE HERE, AND THE DIFFERENCE MATTERS:
//
//   1. DERIVED FROM THE URL — the portal and the portal's property id. These
//      are parsed from the string Joe pasted, involve no network call, and
//      therefore ALWAYS work. property_id is the stable key that ties a probe
//      to a specific listing, so it must never depend on a fetch succeeding.
//
//   2. FETCHED FROM THE PAGE — address, price, bedrooms, agent name, etc.
//      Best-effort only. Rightmove blocks datacentre IPs and renders much of
//      the page client-side, so a serverless fetch frequently returns nothing.
//      That is expected, not a bug.
//
// SCOPE GUARDRAILS (deliberate): this is NOT scraping infrastructure. One
// short single fetch of the public page's meta/JSON-LD. No browser automation,
// no retries, no proxy rotation, no listing enumeration, no crawling.
//
// The one thing this must never do is fail SILENTLY. Previously every failure
// mode — blocked, timeout, 404, non-HTML — collapsed into the same empty
// object, so a probe row with a blank address was indistinguishable from a
// probe against a page that genuinely had no address. Every return now carries
// an explicit `extraction_status` and, on failure, `extraction_error`.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT_MS = 6000;

// extraction_status vocabulary:
//   'fetched'     page fetched, at least one useful field recovered
//   'empty'       page fetched but nothing useful in it (client-rendered)
//   'blocked'     the fetch was refused (403/429/451) — Rightmove or a proxy
//   'unavailable' network error, timeout, 404, or non-HTML response
//   'skipped'     no URL supplied
export const EXTRACTION_STATUS = ['fetched', 'empty', 'blocked', 'unavailable', 'skipped'];

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

function firstPrice(text) {
  const m = String(text || '').match(/£\s?([\d,]{3,})/);
  if (!m) return '';
  const v = parseInt(m[1].replace(/,/g, ''), 10);
  return v >= 1000 ? `£${v.toLocaleString('en-GB')}` : '';
}

// ── URL-derived facts (no network, always available) ─────────────────────────

// Rightmove listing URLs come in several shapes, all carrying the same id:
//   https://www.rightmove.co.uk/properties/159889523
//   https://www.rightmove.co.uk/properties/159889523#/?channel=RES_BUY
//   https://www.rightmove.co.uk/property-for-sale/property-159889523.html
// Returns '' when no id is present rather than guessing one.
export function propertyIdFromUrl(url) {
  const value = String(url ?? '');
  const patterns = [
    /rightmove\.co\.uk\/properties\/(\d{6,})/i,
    /\/property-(?:for-sale|to-rent)\/property-(\d{6,})\.html/i,
    /[?&](?:propertyId|id)=(\d{6,})/i,
  ];
  for (const re of patterns) {
    const m = value.match(re);
    if (m) return m[1];
  }
  return '';
}

export function portalFromUrl(url) {
  const value = String(url ?? '').toLowerCase();
  if (/rightmove\./.test(value)) return 'rightmove';
  if (/zoopla\./.test(value)) return 'zoopla';
  if (/onthemarket\./.test(value)) return 'onthemarket';
  return '';
}

// UK postcode (full or outward-only) from free text. Anchored to word
// boundaries so it doesn't pull digits out of a house number.
export function postcodeFrom(text) {
  const m = String(text ?? '').toUpperCase().match(
    /\b([A-Z]{1,2}\d[A-Z\d]?)\s?(\d[A-Z]{2})\b/,
  );
  if (m) return `${m[1]} ${m[2]}`;
  const outward = String(text ?? '').toUpperCase().match(/\b([A-Z]{1,2}\d[A-Z\d]?)\b(?!\s?\d)/);
  return outward ? outward[1] : '';
}

// "3 bedroom semi-detached house for sale in ..." -> { bedrooms: '3', type: 'semi-detached house' }
export function bedroomsAndTypeFrom(text) {
  const value = String(text ?? '');
  const beds = value.match(/(\d+)\s*bed(?:room)?s?\b/i);
  const type = value.match(
    /\b(detached bungalow|semi-detached bungalow|terraced bungalow|detached house|semi-detached house|terraced house|end of terrace house|town house|link-detached house|mews house|cottage|bungalow|apartment|flat|maisonette|studio|penthouse|land|park home)\b/i,
  );
  return {
    bedrooms: beds ? beds[1] : '',
    property_type: type ? type[1].toLowerCase() : '',
  };
}

// ── JSON-LD ──────────────────────────────────────────────────────────────────
function fromJsonLd(html) {
  const out = { address: '', price: '', agent_name: '', image: '' };
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
          out.address = decode(
            [addr.streetAddress, addr.addressLocality, addr.addressRegion, addr.postalCode]
              .filter(Boolean).join(', '),
          );
        }
      }

      const offers = item.offers || item.priceSpecification;
      const price = offers && (offers.price || offers.priceSpecification?.price);
      if (!out.price && price) out.price = firstPrice(`£${price}`) || `£${price}`;

      // The listing agent, where schema.org exposes it.
      const seller = item.seller || item.provider || item.realEstateAgent || item.broker;
      if (!out.agent_name && seller) {
        const name = typeof seller === 'string' ? seller : seller.name;
        if (name) out.agent_name = decode(name);
      }

      if (!out.image && item.image) {
        out.image = Array.isArray(item.image) ? String(item.image[0] || '') : String(item.image);
      }
    }
  }
  return out;
}

// Rightmove embeds the branch in its client-side page model. Read-only regex
// over the served HTML — no execution, no crawling. Absent on a blocked page,
// which is exactly why nothing downstream may depend on it.
function agentFromPageModel(html) {
  const value = String(html || '');
  const patterns = [
    /"customer"\s*:\s*\{[^{}]*"branchDisplayName"\s*:\s*"([^"]+)"/i,
    /"branchDisplayName"\s*:\s*"([^"]+)"/i,
    /"companyName"\s*:\s*"([^"]+)"/i,
  ];
  for (const re of patterns) {
    const m = value.match(re);
    if (m) return decode(m[1]);
  }
  return '';
}

// ── Public entry point ───────────────────────────────────────────────────────
//
// Always returns the full shape. URL-derived fields are populated even when the
// fetch fails; fetched fields are '' with an explicit status explaining why.
export async function fetchListingMeta(url) {
  const portal = portalFromUrl(url);
  const propertyId = propertyIdFromUrl(url);

  const base = {
    property_id: propertyId,
    portal,
    address: '',
    postcode: '',
    price: '',
    property_type: '',
    bedrooms: '',
    title: '',
    description: '',
    image_url: '',
    agent_name: '',
    status: '',
    extraction_status: 'skipped',
    extraction_error: '',
  };

  if (!url) return base;
  const target = url.startsWith('http') ? url : `https://${url}`;

  let html = '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(target, {
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-GB,en;q=0.9' },
        signal: controller.signal,
        redirect: 'follow',
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 403 || res.status === 429 || res.status === 451) {
      return { ...base, extraction_status: 'blocked', extraction_error: `HTTP ${res.status} — listing page refused the request` };
    }
    if (!res.ok) {
      return { ...base, extraction_status: 'unavailable', extraction_error: `HTTP ${res.status}` };
    }
    const ct = res.headers.get('content-type') || '';
    if (ct && !ct.includes('html')) {
      return { ...base, extraction_status: 'unavailable', extraction_error: `Unexpected content-type: ${ct}` };
    }
    html = await res.text();
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return {
      ...base,
      extraction_status: 'unavailable',
      extraction_error: aborted ? `Timed out after ${TIMEOUT_MS}ms` : (err?.message || 'Network error'),
    };
  }

  const title = metaContent(html, 'og:title');
  const ogDesc = metaContent(html, 'og:description');
  const ogImage = metaContent(html, 'og:image');
  const ld = fromJsonLd(html);

  const address = ld.address || title || '';
  const price = ld.price || firstPrice(title) || firstPrice(ogDesc) || '';
  const { bedrooms, property_type } = bedroomsAndTypeFrom(`${title} ${ogDesc}`);
  const agentName = ld.agent_name || agentFromPageModel(html);

  const result = {
    ...base,
    address,
    postcode: postcodeFrom(address) || postcodeFrom(ogDesc),
    price,
    property_type,
    bedrooms,
    title,
    description: ogDesc,
    image_url: ld.image || ogImage || '',
    agent_name: agentName,
  };

  const gotSomething = Boolean(
    result.address || result.price || result.title || result.agent_name || result.bedrooms,
  );
  result.extraction_status = gotSomething ? 'fetched' : 'empty';
  if (!gotSomething) {
    result.extraction_error = 'Page fetched but no listing fields found (likely client-rendered)';
  }
  return result;
}
