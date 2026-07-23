// api/scrape.js — Vercel Serverless Function
// POST /api/scrape   Body: { url }
// Returns: { tier, listings, summary, phone, company, location, text }
//
// Uses the SHARED, TEST-VALIDATED extraction logic in lib/extract.mjs (the same
// code the benchmark and the 22 fixtures exercise) — card-based, price-anchored
// detection with multi-strategy beds, loose-text-node addresses, sold/agreed
// filtering, challenge detection, and a homepage→listings-page follow.
//
// Tiering (returned so the frontend can pick buttons + prompt):
//   ULTRA_GREEN 3+ full listings · GREEN 1–2 · AMBER 0 full but context · RED nothing.

import { analyse, discoverListingsUrl, classifyTier, extractPhone } from '../lib/extract.mjs';

// Allow headroom for the Bright Data fallback (Vercel Pro honours this; Hobby is
// capped at 10s, in which case the unlocker fallback may time out and we degrade).
export const maxDuration = 30;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Upgrade-Insecure-Requests': '1',
};

const PAGE_TIMEOUT_MS = 7000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing url' });

  try {
    const baseUrl = url.startsWith('http') ? url : `https://${url}`;
    let via = 'fetch';

    // 1. Fetch-first (free, fast): homepage, then follow to a listings page if thin.
    const homeHtml = (await fetchPage(baseUrl)) || '';
    let best = analyse(homeHtml, baseUrl);
    let usedHtml = homeHtml;
    if (best.full < 3 && homeHtml) {
      const listingsUrl = discoverListingsUrl(homeHtml, baseUrl);
      if (listingsUrl && listingsUrl !== baseUrl) {
        const html2 = await fetchPage(listingsUrl);
        if (html2) {
          const a2 = analyse(html2, listingsUrl);
          if (a2.full > best.full || (a2.full === best.full && a2.count > best.count)) { best = a2; usedHtml = html2; }
        }
      }
    }

    // 2. Fallback (paid, slower): only for GENUINE blocks — plain fetch returned
    //    nothing usable. Bright Data Web Unlocker uses residential IPs to get past
    //    the datacenter-IP blocks that stop Vercel's own fetch. Fetch-first stays
    //    primary; Scrape.do is intentionally NOT used (slower, worse hit rate).
    if (best.full === 0 && process.env.BRIGHTDATA_KEY) {
      const bdHome = await brightDataFetch(baseUrl);
      if (bdHome) {
        let a = analyse(bdHome, baseUrl);
        let used = bdHome;
        if (a.full < 3) {
          const lu = discoverListingsUrl(bdHome, baseUrl);
          if (lu && lu !== baseUrl) {
            const bd2 = await brightDataFetch(lu);
            if (bd2) { const a2 = analyse(bd2, lu); if (a2.full > a.full || (a2.full === a.full && a2.count > a.count)) { a = a2; used = bd2; } }
          }
        }
        if (a.full > best.full || (best.count === 0 && a.count > best.count)) { best = a; usedHtml = used; via = 'brightdata'; }
      }
    }

    // 3. Context for AMBER/RED and general questions.
    // Use the HTML we actually extracted from as a fallback source (the homepage
    // may have been blocked and only the Bright Data HTML has content).
    const company = extractCompany(homeHtml) || extractCompany(usedHtml);
    const location = extractLocation(best.listings, homeHtml) || extractLocation(best.listings, usedHtml);
    const phone = extractPhone(homeHtml) || best.phone || extractPhone(usedHtml) || '';
    const tier = classifyTier(best, { company, location, phone });

    const listings = best.listings.map((l) => ({
      address: l.address || '',
      price: l.price || '',
      priceValue: priceValue(l.price),
      beds: l.beds ?? null,
      url: l.url || '',
      full: !!l.full,
    }));

    // Per-prospect observability (shows in Vercel logs).
    console.log(JSON.stringify({ scrape: baseUrl, company, tier, listings_found: listings.length, via }));

    // CACHE SEAM: for a paying client, persist this result keyed by domain (KV/edge)
    // and refresh on a cron rather than re-scraping on every page load.
    return res.status(200).json({
      tier,
      listings,
      summary: buildSummary(listings),
      phone,
      company,
      location,
      source: via,
      text: proseText(homeHtml, usedHtml),
    });
  } catch (err) {
    console.error('Scrape error:', err);
    // Always 200 so the widget degrades gracefully (RED tier).
    return res.status(200).json({ tier: 'RED', listings: [], summary: '', phone: '', company: '', location: '', text: '' });
  }
}

// ── Fetch ────────────────────────────────────────────────────────────────────
async function fetchPage(pageUrl) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
    const r = await fetch(pageUrl, { headers: BROWSER_HEADERS, signal: controller.signal, redirect: 'follow' });
    clearTimeout(timeout);
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    if (ct && !ct.includes('html') && !ct.includes('xml')) return null;
    return await r.text();
  } catch {
    return null;
  }
}

// Bright Data Web Unlocker — residential-IP fetch for sites that block Vercel.
// Needs BRIGHTDATA_KEY and a Web Unlocker zone (BRIGHTDATA_ZONE, default web_unlocker1)
// set in the Vercel project env. Returns null on any failure so we degrade cleanly.
async function brightDataFetch(url) {
  const key = process.env.BRIGHTDATA_KEY;
  if (!key) return null;
  const zone = process.env.BRIGHTDATA_ZONE || 'web_unlocker1';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const r = await fetch('https://api.brightdata.com/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ zone, url, format: 'raw', country: 'gb' }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

// ── Context helpers ───────────────────────────────────────────────────────────
function decode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&pound;/g, '£')
    .replace(/&nbsp;/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

// Agency name — prefer og:site_name, else the first segment of <title>.
function extractCompany(html) {
  const og = String(html || '').match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
  if (og) return decode(og[1]).slice(0, 60);
  const t = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!t) return '';
  return decode(t[1]).split(/\s[|\-–]\s/)[0].trim().slice(0, 60);
}

// Best-effort town: the most common trailing address segment across listings,
// else an "in {Town}" phrase from the homepage.
function extractLocation(listings, homeHtml) {
  const counts = new Map();
  for (const l of listings || []) {
    if (!l.address) continue;
    for (const seg of l.address.split(',').map((s) => s.trim()).slice(-2)) {
      const town = seg.replace(/\b[A-Z]{1,2}\d{1,2}[A-Z]?\s*\d?[A-Z]{0,2}\b/g, '').trim();
      if (town && /^[A-Za-z][A-Za-z .'-]+$/.test(town) && town.length >= 3 && town.length <= 30) {
        counts.set(town, (counts.get(town) || 0) + 1);
      }
    }
  }
  let best = '';
  let bestN = 0;
  for (const [t, n] of counts) if (n > bestN) { bestN = n; best = t; }
  if (best) return best;
  const m = String(homeHtml || '').replace(/<[^>]+>/g, ' ').match(/\bin\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\b/);
  return m ? m[1] : '';
}

function priceValue(p) {
  const m = String(p || '').match(/£\s?([\d,]+)/);
  if (!m) return null;
  const v = parseInt(m[1].replace(/,/g, ''), 10);
  return v >= 1000 ? v : null;
}

function buildSummary(listings) {
  if (!listings.length) return '';
  const withPrice = listings.filter((l) => l.priceValue).map((l) => l.priceValue).sort((a, b) => a - b);
  let s = `${listings.length} live listing${listings.length === 1 ? '' : 's'} found`;
  if (withPrice.length) s += `; prices £${withPrice[0].toLocaleString('en-GB')}–£${withPrice[withPrice.length - 1].toLocaleString('en-GB')}`;
  return s + '.';
}

function stripText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&pound;/g, '£')
    .replace(/\s{2,}/g, ' ').trim();
}
function proseText(homeHtml, usedHtml) {
  const parts = [stripText(homeHtml)];
  if (usedHtml && usedHtml !== homeHtml) parts.push(stripText(usedHtml));
  return parts.filter(Boolean).join('\n\n').slice(0, 7000);
}
