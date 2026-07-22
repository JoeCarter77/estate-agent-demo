// api/scrape.js — Vercel Serverless Function
// POST /api/scrape
// Body: { url }
// Returns: { summary, listings: [{address, price, priceValue, beds, baths, type, status, url}], text }
//
// Strategy (estate-agent sites carry live listings, not just prose):
//   1. Discover listing-detail URLs via /sitemap.xml (agent CRMs auto-generate these),
//      falling back to links scraped from the homepage + common index pages.
//   2. Fetch a capped set of listing pages in bounded-concurrency batches, within a
//      time budget that respects the Vercel function timeout.
//   3. Extract STRUCTURED data per listing — prefer JSON-LD (schema.org), fall back to
//      defensive regex over the server-rendered HTML.
//   4. Return { summary, listings[], text } so the assistant can answer specific
//      listing questions instead of guessing.
//
// NOTE: plain fetch only sees server-rendered HTML. Fully client-rendered listing
// sites will yield few/no listings here — the demo then degrades into exactly the
// product ("take your details, the team will confirm").
//
// FUTURE (paying clients): cache structured listings by domain and refresh on a cron.
// One-time scrape on page load is correct for the demo — see CACHE SEAM below.

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
};

// Time + volume budget (Vercel hobby ~10s / pro ~60s). Keep the demo bounded.
const TOTAL_BUDGET_MS = 8500;   // stop launching new fetches after this much wall-clock
const PAGE_TIMEOUT_MS = 6000;   // per-request timeout
const MAX_LISTINGS    = 18;     // cap fetched listing pages
const CONCURRENCY     = 6;      // parallel fetches per batch

// Common index/search pages to harvest listing links from when a sitemap is thin.
const INDEX_PATHS = [
  '/', '/properties', '/property', '/properties-for-sale', '/property-for-sale',
  '/for-sale', '/properties-to-let', '/property-to-let', '/to-let', '/lettings',
  '/search', '/results', '/buy', '/rent',
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing url' });

  const started = Date.now();
  const budgetLeft = () => TOTAL_BUDGET_MS - (Date.now() - started);

  try {
    const baseUrl = url.startsWith('http') ? url : `https://${url}`;
    const origin = new URL(baseUrl).origin;

    // 1. Fetch homepage (needed for links + general prose context).
    const homeHtml = (await fetchPage(baseUrl)) || '';
    const homeText = extractText(homeHtml);

    // 2. Discover candidate listing-detail URLs.
    let candidates = await discoverListingUrls(origin, baseUrl, homeHtml, budgetLeft);

    // 3. Fetch listing pages in bounded-concurrency batches within the time budget.
    candidates = candidates.slice(0, MAX_LISTINGS);
    const listings = [];
    for (let i = 0; i < candidates.length; i += CONCURRENCY) {
      if (budgetLeft() < 1200) break; // leave room to serialise the response
      const batch = candidates.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(async (pageUrl) => {
        const html = await fetchPage(pageUrl);
        return html ? parseListing(html, pageUrl) : null;
      }));
      results.forEach((l) => { if (l && (l.price || l.beds || l.address)) listings.push(l); });
    }

    // 4. General prose context (homepage + a couple of non-listing pages) for
    //    about / fees / branch / contact questions the listings don't cover.
    const prose = await gatherProse(origin, baseUrl, homeHtml, homeText, listings, budgetLeft);

    const summary = buildSummary(listings);

    // CACHE SEAM: for a paying client, persist { summary, listings } keyed by domain
    // here (KV/edge cache) and serve from cache, refreshing on a cron rather than
    // re-scraping on every page load.
    return res.status(200).json({ summary, listings, text: prose });

  } catch (err) {
    console.error('Scrape error:', err);
    // Always 200 so the chatbot degrades gracefully.
    return res.status(200).json({ summary: '', listings: [], text: '' });
  }
}

// ── Fetch ───────────────────────────────────────────────────────────────────
async function fetchPage(pageUrl) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
    const r = await fetch(pageUrl, { headers: BROWSER_HEADERS, signal: controller.signal, redirect: 'follow' });
    clearTimeout(timeout);
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('html') && !ct.includes('xml')) return null;
    return await r.text();
  } catch {
    return null;
  }
}

// ── Listing URL discovery ────────────────────────────────────────────────────
// A URL looks like a listing-detail page if it stays on-site and matches one of
// the common estate-agent CRM patterns: `/property/...`, `property-for-sale/-to-let`,
// or the `-pi-<ref>` detail marker used by several UK agent website providers.
function isListingUrl(href, origin) {
  try {
    const u = new URL(href, origin);
    if (u.origin !== origin) return false;
    const p = u.pathname.toLowerCase();
    if (/\/(property|properties|estate-agents)\/[^/]+/.test(p)) return true;
    if (/property-(for-sale|to-let|for-rent)/.test(p) && /(-pi-|-id-|\d{2,})/.test(p)) return true;
    if (/-pi-[a-z]*\d+/.test(p)) return true;               // ...-pi-hent2481.htm
    if (/\/(property|listing)[-_]?\d{2,}/.test(p)) return true;
    return false;
  } catch {
    return false;
  }
}

// Index/search pages we should crawl one hop deeper to find listing links.
function isIndexUrl(href, origin) {
  try {
    const u = new URL(href, origin);
    if (u.origin !== origin) return false;
    const p = u.pathname.toLowerCase();
    return /(for-sale|to-let|to-rent|lettings|properties|search|results|buy|rent)/.test(p)
      && !isListingUrl(href, origin);
  } catch {
    return false;
  }
}

function extractHrefs(html, base) {
  const links = new Set();
  const re = /href=["']([^"'#]+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try { links.add(new URL(m[1], base).href); } catch {}
  }
  return [...links];
}

async function discoverListingUrls(origin, baseUrl, homeHtml, budgetLeft) {
  const found = new Set();

  // a. Sitemap(s) — including one level of sitemap-index nesting.
  const sitemapUrls = await collectSitemapUrls(origin, budgetLeft);
  sitemapUrls.forEach((u) => { if (isListingUrl(u, origin)) found.add(u); });

  // b. Homepage links.
  extractHrefs(homeHtml, baseUrl).forEach((u) => { if (isListingUrl(u, origin)) found.add(u); });

  // c. If still thin, crawl a few index/search pages one hop deep.
  if (found.size < MAX_LISTINGS && budgetLeft() > 2500) {
    const indexCandidates = new Set();
    INDEX_PATHS.forEach((path) => indexCandidates.add(new URL(path, origin).href));
    extractHrefs(homeHtml, baseUrl).forEach((u) => { if (isIndexUrl(u, origin)) indexCandidates.add(u); });

    const idx = [...indexCandidates].slice(0, 6);
    for (let i = 0; i < idx.length; i += CONCURRENCY) {
      if (found.size >= MAX_LISTINGS || budgetLeft() < 2500) break;
      const batch = idx.slice(i, i + CONCURRENCY);
      const htmls = await Promise.all(batch.map(fetchPage));
      htmls.forEach((html, j) => {
        if (!html) return;
        extractHrefs(html, batch[j]).forEach((u) => { if (isListingUrl(u, origin)) found.add(u); });
      });
    }
  }

  return [...found];
}

async function collectSitemapUrls(origin, budgetLeft) {
  const urls = new Set();
  const roots = [new URL('/sitemap.xml', origin).href, new URL('/sitemap_index.xml', origin).href];
  for (const root of roots) {
    if (budgetLeft() < 3000) break;
    const xml = await fetchPage(root);
    if (!xml) continue;
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
    // If this is a sitemap index, follow the first couple of child sitemaps.
    const childSitemaps = locs.filter((l) => /sitemap.*\.xml/i.test(l)).slice(0, 3);
    if (childSitemaps.length && /<sitemapindex/i.test(xml)) {
      for (const child of childSitemaps) {
        if (budgetLeft() < 3000) break;
        const childXml = await fetchPage(child);
        if (!childXml) continue;
        [...childXml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].forEach((m) => urls.add(m[1]));
      }
    } else {
      locs.forEach((l) => urls.add(l));
    }
    if (urls.size) break; // got a usable sitemap
  }
  return [...urls];
}

// ── Structured listing extraction ────────────────────────────────────────────
function parseListing(html, pageUrl) {
  const fromJsonLd = parseJsonLd(html, pageUrl);
  if (fromJsonLd) return fromJsonLd;

  const text = extractText(html);
  const price = firstPrice(html) || firstPrice(text);
  const beds = matchInt(text, /(\d+)\s*(?:bed|bedroom)/i);
  const baths = matchInt(text, /(\d+)\s*(?:bath|bathroom)/i);

  return {
    address: cleanAddress(titleOf(html)) || cleanAddress(headingOf(html)) || '',
    price: price ? formatPrice(price) : (/(poa|price on application)/i.test(text) ? 'POA' : ''),
    priceValue: price || null,
    beds: beds || null,
    baths: baths || null,
    type: detectType(text),
    status: detectStatus(text, pageUrl),
    url: pageUrl,
  };
}

function parseJsonLd(html, pageUrl) {
  const blocks = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    let data;
    try { data = JSON.parse(b[1].trim()); } catch { continue; }
    const nodes = flattenJsonLd(data);
    for (const node of nodes) {
      const type = String(node['@type'] || '').toLowerCase();
      if (!/residence|apartment|house|singlefamily|product|offer|realestate|place|listing/.test(type)) continue;
      const offer = node.offers || node.Offer || {};
      const priceValue = numeric(node.price || offer.price || node.priceValue);
      const address = typeof node.address === 'string'
        ? node.address
        : addressString(node.address) || node.name || '';
      const beds = numeric(node.numberOfRooms || node.numberOfBedrooms || node.bedrooms);
      const baths = numeric(node.numberOfBathroomsTotal || node.numberOfBathrooms || node.bathrooms);
      if (!priceValue && !address && !beds) continue;
      return {
        address: cleanAddress(address),
        price: priceValue ? formatPrice(priceValue) : '',
        priceValue: priceValue || null,
        beds: beds || null,
        baths: baths || null,
        type: detectType(type + ' ' + (node.name || '')),
        status: (offer.availability || '').toString().toLowerCase().includes('soldout') ? 'sold' : 'available',
        url: pageUrl,
      };
    }
  }
  return null;
}

function flattenJsonLd(data) {
  const out = [];
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') {
      out.push(n);
      if (n['@graph']) walk(n['@graph']);
    }
  };
  walk(data);
  return out;
}

function addressString(addr) {
  if (!addr || typeof addr !== 'object') return '';
  return [addr.streetAddress, addr.addressLocality, addr.addressRegion, addr.postalCode]
    .filter(Boolean).join(', ');
}

// ── Summary ───────────────────────────────────────────────────────────────────
function buildSummary(listings) {
  if (!listings.length) return '';
  const withPrice = listings.filter((l) => l.priceValue);
  const forSale = listings.filter((l) => l.status !== 'to-let' && !/let/i.test(l.status || ''));
  const toLet = listings.filter((l) => /let/i.test(l.status || ''));
  let s = `${listings.length} live listing${listings.length === 1 ? '' : 's'} found`;
  if (toLet.length) s += ` (${forSale.length} for sale, ${toLet.length} to let)`;
  if (withPrice.length) {
    const prices = withPrice.map((l) => l.priceValue).sort((a, b) => a - b);
    s += `; prices ${formatPrice(prices[0])}–${formatPrice(prices[prices.length - 1])}`;
  }
  return s + '.';
}

// ── Prose (non-listing) context ───────────────────────────────────────────────
async function gatherProse(origin, baseUrl, homeHtml, homeText, listings, budgetLeft) {
  const parts = [homeText];
  if (budgetLeft() > 2000) {
    const wanted = ['/about', '/all-about-us', '/fees', '/contact', '/valuation', '/sell', '/selling'];
    const links = extractHrefs(homeHtml, baseUrl)
      .filter((u) => { try { const p = new URL(u).pathname.toLowerCase(); return wanted.some((w) => p.includes(w)); } catch { return false; } })
      .slice(0, 3);
    const htmls = await Promise.all(links.map(fetchPage));
    htmls.forEach((h) => { if (h) parts.push(extractText(h)); });
  }
  return parts.filter(Boolean).join('\n\n').slice(0, 8000);
}

// ── HTML → text / field helpers ───────────────────────────────────────────────
function extractText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&pound;/g, '£')
    .replace(/\s{2,}/g, ' ').trim();
}

function titleOf(html) { const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i); return m ? decode(m[1]) : ''; }
function headingOf(html) { const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i); return m ? decode(m[1].replace(/<[^>]+>/g, ' ')) : ''; }
function decode(s) { return s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&pound;/g, '£').replace(/\s{2,}/g, ' ').trim(); }

// Turn a listing page <title>/<h1> into a clean address.
// Typical UK agent titles: "Property For Sale - {ADDRESS} - {Agency} (ID 2481)".
function cleanAddress(s) {
  if (!s) return '';
  let a = String(s)
    .replace(/property\s+(for\s+sale|to\s+let|for\s+rent)\s*[-–:]?\s*/i, '') // drop leading label
    .replace(/\s*\((?:id|ref)[^)]*\)\s*$/i, '')                              // drop "(ID 2481)"
    .replace(/\s{2,}/g, ' ')
    .trim();
  // If an " - " / " | " separator remains, the tail is usually the agency name — keep the address.
  const parts = a.split(/\s+[-–|]\s+/);
  if (parts.length > 1) a = parts[0].trim();
  return a;
}

function firstPrice(s) {
  const m = String(s || '').match(/£\s?(\d{1,3}(?:,\d{3})+|\d{4,})/);
  if (!m) return null;
  const v = parseInt(m[1].replace(/,/g, ''), 10);
  return v >= 10000 ? v : null; // ignore small figures (fees, sq ft, etc.)
}
function formatPrice(v) { return '£' + Number(v).toLocaleString('en-GB'); }
function matchInt(s, re) { const m = String(s || '').match(re); return m ? parseInt(m[1], 10) : null; }
function numeric(v) { if (v == null) return null; const n = parseInt(String(v).replace(/[^\d]/g, ''), 10); return Number.isFinite(n) ? n : null; }

function detectType(s) {
  const t = String(s || '').toLowerCase();
  if (/\bdetached\b/.test(t) && /\bhouse\b/.test(t)) return 'detached house';
  if (/\bsemi[- ]detached\b/.test(t)) return 'semi-detached house';
  if (/\bterraced?\b/.test(t)) return 'terraced house';
  if (/\bbungalow\b/.test(t)) return 'bungalow';
  if (/\bmaisonette\b/.test(t)) return 'maisonette';
  if (/\b(apartment|flat)\b/.test(t)) return 'apartment';
  if (/\bcottage\b/.test(t)) return 'cottage';
  if (/\bland\b/.test(t)) return 'land';
  if (/\bcommercial\b/.test(t)) return 'commercial';
  if (/\bhouse\b/.test(t)) return 'house';
  return '';
}

function detectStatus(text, pageUrl) {
  const t = (text + ' ' + pageUrl).toLowerCase();
  if (/\bsold\b/.test(t)) return 'sold';
  if (/\b(sstc|under offer)\b/.test(t)) return 'under offer';
  if (/\blet agreed\b/.test(t)) return 'let agreed';
  if (/(to-let|to let|for rent|to rent|lettings)/.test(t)) return 'to-let';
  return 'for sale';
}
