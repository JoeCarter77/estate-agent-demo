// lib/rightmove-meta.mjs — BEST-EFFORT property metadata for a pasted listing URL.
//
// SCOPE GUARDRAILS (deliberate, per NOVUS product rules):
//   • This is NOT scraping infrastructure. One short, single fetch of the public
//     page's <meta>/JSON-LD tags. No browser automation, no retries, no proxy
//     rotation, no listing enumeration, no crawling.
//   • Rightmove frequently blocks datacentre IPs and renders client-side, so this
//     will OFTEN return nothing. That is expected and fine: every field is
//     optional and the probe is created regardless. Joe can fill/confirm details
//     manually. The only required input to create a probe is the URL itself.
//
// Returns { address, price, status, title } with '' for anything not found.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT_MS = 6000;

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

// Pull address/price out of a JSON-LD block if present (schema.org RealEstate/Offer).
function fromJsonLd(html) {
  const out = { address: '', price: '' };
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
        }
      }
      const offers = item.offers || item.priceSpecification;
      const price = offers && (offers.price || offers.priceSpecification?.price);
      if (!out.price && price) out.price = firstPrice(`£${price}`) || `£${price}`;
    }
  }
  return out;
}

export async function fetchListingMeta(url) {
  const empty = { address: '', price: '', status: '', title: '' };
  if (!url) return empty;
  const target = url.startsWith('http') ? url : `https://${url}`;

  let html = '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(target, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-GB,en;q=0.9' },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) return empty; // blocked / not found → graceful empty
    const ct = res.headers.get('content-type') || '';
    if (ct && !ct.includes('html')) return empty;
    html = await res.text();
  } catch {
    return empty; // timeout / network / abort → graceful empty
  }

  const title = metaContent(html, 'og:title');
  const ld = fromJsonLd(html);
  const ogDesc = metaContent(html, 'og:description');

  const address = ld.address || title || '';
  const price = ld.price || firstPrice(title) || firstPrice(ogDesc) || '';

  return { address, price, status: '', title };
}
