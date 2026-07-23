#!/usr/bin/env node
/**
 * scraper-bench.mjs — standalone scraper-reliability benchmark.
 *
 * NOT the production scraper. Tries multiple scraping methods against a list of
 * UK estate-agent sites and, per site x method, extracts STRUCTURED listing
 * cards (price + beds + address + listing URL) and reports:
 *   - ok:        did we get >= MIN_FULL real listings with all four fields
 *   - full/N:    full-field cards / total candidate cards found
 *   - status:    HTTP status (or error kind)
 *   - ms:        wall-clock time
 *
 * Run from an UNRESTRICTED network (laptop / VPS) — NOT the Claude sandbox.
 *
 * Setup:
 *   npm i node-html-parser          # required (structured extraction)
 *   npm i playwright && npx playwright install chromium   # optional, method d
 *
 * Usage:
 *   node --env-file=.env.local scraper-bench.mjs            # a,b,c,e (+d if installed)
 *   node --env-file=.env.local scraper-bench.mjs --api      # + f (Scrape.do) & g (Bright Data)
 *   node --env-file=.env.local scraper-bench.mjs --only=a,f
 *   node --env-file=.env.local scraper-bench.mjs --zones    # list your Bright Data zones & exit
 *
 * Methods:
 *   a plain fetch + Chrome UA   b rotating UAs   c Googlebot UA spoof
 *   d headless Playwright       e screenshot-then-parse (thum.io)
 *   f Scrape.do API             g Bright Data Web Unlocker API
 *
 * Env (only for the methods you enable):
 *   SCRAPEDO_KEY (or SCRAPERAPI_KEY)         # method f
 *   BRIGHTDATA_KEY [+ BRIGHTDATA_ZONE]       # method g (zone auto-discovered if unset)
 */

const MIN_FULL = 3; // ✅ requires >= this many cards with price+beds+address+url

const TARGETS = [
  { name: 'Parabar Estates',        url: 'https://parabar.co.uk/' },
  { name: 'Ashton White',           url: 'https://ashtonwhite.co.uk/' },
  { name: 'Tyler Estates',          url: 'https://www.tylerestates.co.uk/' },
  { name: 'Henton Kirkman',         url: 'https://www.hentonkirkman.co.uk/' },
  { name: 'Keith Ashton',           url: 'https://www.keithashton.co.uk/' }, // replaces dead Brentwood EA
  { name: 'WN Properties',          url: 'https://www.wnproperties.co.uk/' },
  { name: 'HS Estate Agents',       url: 'https://www.hs-estateagents.co.uk/' },
  { name: 'Smooth Move Estates',    url: 'https://smoothmoveestates.co.uk/' },
  { name: 'IPS Property Services',  url: 'https://ipschelmsford.co.uk/' },
  { name: 'Charles David Casson',   url: 'https://www.charlesdavidcasson.co.uk/' },
];

const TIMEOUT_MS = 15000;
const API_TIMEOUT_MS = 30000;

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const UA_POOL = [
  CHROME_UA,
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
];

const GOOGLEBOT_UA =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

let parseHTML = null;     // node-html-parser, loaded in main()
let BD_ZONE = process.env.BRIGHTDATA_ZONE || null; // resolved in main()

function browserHeaders(ua) {
  return {
    'User-Agent': ua,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-GB,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Ch-Ua': '"Chromium";v="120", "Not:A-Brand";v="99"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
  };
}

// ---- Structured listing extraction --------------------------------------

// hrefs that look like an individual property-detail page (not a category page)
const LISTING_HREF =
  /(property-for-sale|property-to-rent|property-details|propertydetails|-pi-|prop[_-]?id=|propertyid=|\/property\/|\/properties\/[^/]+\/|\/for-sale\/[^/]+\/|\/to-let\/[^/]+\/|\/sales?\/[^/]+\/|\/lettings?\/[^/]+\/|property\.aspx\?)/i;

const ROAD =
  /\b(Road|Rd|Street|St|Avenue|Ave|Lane|Ln|Close|Drive|Dr|Way|Court|Ct|Gardens|Gdns|Crescent|Cres|Place|Pl|Terrace|Grove|Hill|Rise|Mews|Park|Green|Row|Walk|End|Chase|Meadow|View|Fields?|Hatch|Common|Heath|Wood)\b/i;
const POSTCODE = /\b[A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2}\b/i;

// node-html-parser's .text concatenates adjacent elements with NO separator
// (e.g. "£499,995" + "3 bedroom" → "£499,9953 bedroom"), which corrupts number
// parsing. Rebuild text from innerHTML with tag boundaries as spaces.
function decodeEntities(s) {
  return s
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&pound;|&#163;/gi, '£')
    .replace(/&amp;|&#38;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');
}
function cleanText(el) {
  const raw = el && (el.innerHTML || el.text) ? (el.innerHTML || el.text) : '';
  return decodeEntities(raw.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function extractPrice(text) {
  const m = text.match(
    /£\s?(\d{1,3}(?:,\d{3})+|\d{4,})(\s?(?:pcm|pw|per\s+(?:month|week)))?/i
  );
  return m ? m[0].replace(/\s+/g, ' ').trim() : null;
}
function extractBeds(text) {
  const m =
    text.match(/(\d{1,2})\s*(?:bed\b|beds\b|bedroom)/i) ||
    text.match(/bed(?:room)?s?\s*[:\-]?\s*(\d{1,2})\b/i);
  return m ? parseInt(m[1], 10) : null;
}
function isAddress(s) {
  if (!s) return false;
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length < 6 || s.length > 120) return false;
  if (/^£/.test(s)) return false;
  if (/\b(featured|latest|properties|search|view|details|for sale|to let)\b/i.test(s) && !/,/.test(s))
    return false;
  return ROAD.test(s) || POSTCODE.test(s) || (s.includes(',') && /[A-Za-z]/.test(s));
}

function findCard(anchor) {
  let el = anchor;
  for (let depth = 0; el && depth < 6; depth++) {
    const t = cleanText(el);
    if (extractPrice(t) && t.length < 2000) return el; // tightest ancestor holding a price
    el = el.parentNode;
  }
  return null;
}
function pickAddress(card, anchor) {
  const cands = [];
  for (const h of card.querySelectorAll('h1,h2,h3,h4,h5')) cands.push(cleanText(h));
  for (const e of card.querySelectorAll('*')) {
    const cls = (e.getAttribute && e.getAttribute('class')) || '';
    if (/address|street|location|prop.*title|property.*title/i.test(cls)) cands.push(cleanText(e));
  }
  for (const img of card.querySelectorAll('img')) {
    const a = img.getAttribute('alt');
    if (a) cands.push(decodeEntities(a));
  }
  cands.push(cleanText(anchor));
  for (const c of cands) if (isAddress(c)) return c.replace(/\s+/g, ' ').trim();
  return null;
}

function extractListings(html, baseUrl) {
  const root = parseHTML(html);
  const seen = new Set();
  const listings = [];
  for (const a of root.querySelectorAll('a')) {
    const href = a.getAttribute('href');
    if (!href || !LISTING_HREF.test(href)) continue;
    let url;
    try {
      url = new URL(href, baseUrl).href.split('#')[0];
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    const card = findCard(a);
    if (!card) continue;
    const ct = cleanText(card);
    const price = extractPrice(ct);
    const beds = extractBeds(ct);
    const address = pickAddress(card, a);
    seen.add(url);
    listings.push({ address, price, beds, url, full: !!(price && beds != null && address) });
  }
  return listings;
}

function analyse(html, baseUrl) {
  if (!html) return { ok: false, listings: [], full: 0, count: 0, phone: null, hint: 'empty body' };
  const flat = html.replace(/\s+/g, ' ');
  const challenged =
    /just a moment|attention required|cf-browser-verification|challenge-platform|enable javascript and cookies|checking your browser/i.test(
      flat
    );
  const phone = (flat.match(/\b0(?:1\d{3}|2\d)\s?\d{3}\s?\d{3,4}\b/) || [])[0] || null;
  if (challenged)
    return { ok: false, listings: [], full: 0, count: 0, phone, hint: 'anti-bot challenge page' };

  const listings = extractListings(html, baseUrl);
  const full = listings.filter((l) => l.full).length;
  const count = listings.length;
  const ok = full >= MIN_FULL;
  const sample = (listings.find((l) => l.full) || listings[0] || {}).address;
  let hint = `${full}/${count} full cards`;
  if (sample) hint += ` · ${sample.slice(0, 40)}`;
  if (count > full && full < MIN_FULL) {
    const noBeds = listings.filter((l) => l.price && l.address && l.beds == null).length;
    if (noBeds) hint += ` (${noBeds} missing beds)`;
  }
  return { ok, listings, full, count, phone, hint };
}

// ---- fetch helpers -------------------------------------------------------

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}
async function timedFetch(url, opts, timeout = TIMEOUT_MS, baseUrl = url) {
  const t0 = Date.now();
  const { signal, done } = withTimeout(timeout);
  try {
    const r = await fetch(url, { redirect: 'follow', signal, ...opts });
    const body = await r.text();
    done();
    const a = analyse(body, baseUrl); // resolve listing hrefs against the TARGET site
    return { ok: r.ok && a.ok, reachable: r.ok, status: r.status, ms: Date.now() - t0, bytes: body.length, ...a };
  } catch (e) {
    done();
    return {
      ok: false,
      reachable: false,
      status: e.name === 'AbortError' ? 'timeout' : e.code || e.name,
      ms: Date.now() - t0,
      bytes: 0,
      listings: [],
      full: 0,
      count: 0,
      phone: null,
      hint: e.message?.slice(0, 60),
    };
  }
}

// ---- Methods -------------------------------------------------------------

const methods = {
  a: (url) => timedFetch(url, { headers: browserHeaders(CHROME_UA) }),

  b: async (url) => {
    let last;
    for (const ua of UA_POOL) {
      last = await timedFetch(url, { headers: browserHeaders(ua) });
      if (last.ok) return { ...last, hint: `won with UA: ${ua.slice(0, 24)}…` };
    }
    return last;
  },

  c: (url) => timedFetch(url, { headers: { ...browserHeaders(GOOGLEBOT_UA), From: 'googlebot(at)googlebot.com' } }),

  d: async (url) => {
    let chromium;
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      return { ok: false, status: 'SKIP', ms: 0, bytes: 0, listings: [], full: 0, count: 0, phone: null, hint: 'playwright not installed' };
    }
    const t0 = Date.now();
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const ctx = await browser.newContext({ userAgent: CHROME_UA, locale: 'en-GB' });
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
      await page.waitForTimeout(2500);
      const html = await page.content();
      await browser.close();
      const a = analyse(html, url);
      return { ok: a.ok, reachable: true, status: 200, ms: Date.now() - t0, bytes: html.length, ...a };
    } catch (e) {
      if (browser) await browser.close().catch(() => {});
      return { ok: false, reachable: false, status: e.name, ms: Date.now() - t0, bytes: 0, listings: [], full: 0, count: 0, phone: null, hint: e.message?.slice(0, 60) };
    }
  },

  // screenshot-then-parse: yields pixels, NOT structured cards → never ✅ here.
  // Reported as 🟡 (reachable) to show it clears the block; real extraction
  // would need a vision/OCR pass over the image.
  e: async (url) => {
    const shot = `https://image.thum.io/get/width/1200/noanimate/${url}`;
    const t0 = Date.now();
    const { signal, done } = withTimeout(TIMEOUT_MS);
    try {
      const r = await fetch(shot, { signal });
      const buf = Buffer.from(await r.arrayBuffer());
      done();
      const gotImage = r.ok && buf.length > 15000;
      return { ok: false, reachable: gotImage, status: r.status, ms: Date.now() - t0, bytes: buf.length, listings: [], full: 0, count: 0, phone: null, hint: gotImage ? 'image captured — needs vision OCR (no structured data)' : 'placeholder/failed image' };
    } catch (e) {
      done();
      return { ok: false, reachable: false, status: e.name, ms: Date.now() - t0, bytes: 0, listings: [], full: 0, count: 0, phone: null, hint: e.message?.slice(0, 60) };
    }
  },

  f: async (url) => {
    const sd = process.env.SCRAPEDO_KEY;
    const sa = process.env.SCRAPERAPI_KEY;
    let api;
    if (sd) api = `https://api.scrape.do/?token=${sd}&url=${encodeURIComponent(url)}&render=true&geoCode=gb`;
    else if (sa) api = `https://api.scraperapi.com/?api_key=${sa}&url=${encodeURIComponent(url)}&render=true&country_code=uk`;
    else return { ok: false, status: 'SKIP', ms: 0, bytes: 0, listings: [], full: 0, count: 0, phone: null, hint: 'set SCRAPEDO_KEY or SCRAPERAPI_KEY' };
    // baseUrl = the real target so listing hrefs resolve to the agent site, not api.scrape.do
    return timedFetch(api, {}, API_TIMEOUT_MS, url);
  },

  g: async (url) => {
    const key = process.env.BRIGHTDATA_KEY;
    if (!key) return { ok: false, status: 'SKIP', ms: 0, bytes: 0, listings: [], full: 0, count: 0, phone: null, hint: 'set BRIGHTDATA_KEY' };
    const zone = BD_ZONE || 'web_unlocker1';
    const t0 = Date.now();
    const { signal, done } = withTimeout(API_TIMEOUT_MS);
    try {
      const r = await fetch('https://api.brightdata.com/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ zone, url, format: 'raw', country: 'gb' }),
        signal,
      });
      const body = await r.text();
      done();
      const a = analyse(body, url);
      const zoneErr = !r.ok && /zone|unknown|not found|auth/i.test(body) ? ` (zone="${zone}"? ${body.slice(0, 50)})` : '';
      return { ok: r.ok && a.ok, reachable: r.ok, status: r.status, ms: Date.now() - t0, bytes: body.length, ...a, hint: (a.hint || '') + zoneErr };
    } catch (e) {
      done();
      return { ok: false, reachable: false, status: e.name, ms: Date.now() - t0, bytes: 0, listings: [], full: 0, count: 0, phone: null, hint: e.message?.slice(0, 60) };
    }
  },
};

// ---- Bright Data zone discovery -----------------------------------------

async function brightDataZones(key) {
  const { signal, done } = withTimeout(10000);
  try {
    const r = await fetch('https://api.brightdata.com/zone/get_active_zones', {
      headers: { Authorization: `Bearer ${key}` },
      signal,
    });
    const body = await r.text();
    done();
    if (!r.ok) return { error: `${r.status} ${body.slice(0, 100)}` };
    let zones;
    try {
      zones = JSON.parse(body);
    } catch {
      return { error: `unparseable: ${body.slice(0, 80)}` };
    }
    return { zones: Array.isArray(zones) ? zones : zones?.zones || [] };
  } catch (e) {
    done();
    return { error: e.message };
  }
}
function pickUnlockerZone(zones) {
  const byType = zones.find((z) => /unblock|unlock/i.test(z.type || ''));
  const byName = zones.find((z) => /unlock|unblock/i.test(z.name || ''));
  return (byType || byName || zones[0])?.name || null;
}

// ---- Runner --------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const wantApi = args.includes('--api');
  let ids = onlyArg ? onlyArg.split('=')[1].split(',') : ['a', 'b', 'c', 'd', 'e'];
  if (wantApi) {
    if (!ids.includes('f')) ids.push('f');
    if (!ids.includes('g')) ids.push('g');
  }
  return { ids: ids.filter((id) => methods[id]), zonesOnly: args.includes('--zones') };
}

function fmt(r) {
  const flag = r.ok ? '✅' : r.reachable ? '🟡' : '❌';
  return `${flag} ${String(r.status).padEnd(7)} ${`${r.ms}ms`.padStart(7)}  ${r.hint || ''}`.trim();
}

async function main() {
  const { ids, zonesOnly } = parseArgs();

  // Bright Data zone discovery / listing
  if (zonesOnly || (ids.includes('g') && process.env.BRIGHTDATA_KEY && !BD_ZONE)) {
    const key = process.env.BRIGHTDATA_KEY;
    if (!key) {
      console.log('BRIGHTDATA_KEY not set.');
      if (zonesOnly) return;
    } else {
      const { zones, error } = await brightDataZones(key);
      if (error) console.log(`Bright Data zone lookup failed: ${error}`);
      else {
        console.log('Bright Data zones:', zones.map((z) => `${z.name}${z.type ? ` (${z.type})` : ''}`).join(', ') || '(none)');
        BD_ZONE = pickUnlockerZone(zones);
        console.log(`→ using zone: ${BD_ZONE || '(none found — create a Web Unlocker zone)'}`);
      }
      if (zonesOnly) return;
    }
  }

  // structured extraction needs node-html-parser
  try {
    ({ parse: parseHTML } = await import('node-html-parser'));
  } catch {
    console.error('\nMissing dependency. Run:  npm i node-html-parser\n');
    process.exit(1);
  }

  console.log(`\nScraper benchmark — methods: ${ids.join(', ')} — ✅ = ${MIN_FULL}+ cards with price+beds+address+url`);
  console.log('Legend: ✅ structured listings  🟡 reachable but <3 full cards / challenge / image  ❌ blocked/error\n');

  const results = [];
  const tally = Object.fromEntries(ids.map((id) => [id, { ok: 0, reachable: 0 }]));

  for (const site of TARGETS) {
    console.log(`\n■ ${site.name}  (${site.url})`);
    for (const id of ids) {
      const r = await methods[id](site.url);
      results.push({ site: site.name, url: site.url, method: id, ...r });
      if (r.ok) tally[id].ok++;
      if (r.reachable) tally[id].reachable++;
      console.log(`   ${id})  ${fmt(r)}`);
    }
  }

  console.log('\n\n=== SUCCESS RATE  (✅ structured listings / 🟡 reachable, out of ' + TARGETS.length + ') ===');
  for (const id of ids) console.log(`  ${id}:  ✅ ${tally[id].ok}   🟡 ${tally[id].reachable}`);

  const fs = await import('node:fs');
  fs.writeFileSync('scraper-bench-results.json', JSON.stringify(results, null, 2));
  console.log('\nStructured results (incl. per-listing arrays) → scraper-bench-results.json\n');
}

// exported for unit tests; run main() only when invoked directly
export { analyse, extractListings, isAddress, extractPrice, extractBeds };
export async function _loadParser() {
  if (!parseHTML) ({ parse: parseHTML } = await import('node-html-parser'));
}

// Robust "is this the entry script?" check. Compares real filesystem paths
// (not hand-built file:// URLs) so it works on Windows, with relative paths,
// and through symlinks. `IS_IMPORTED_FOR_TEST` lets the fixture test skip main.
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
function isEntryScript() {
  if (process.env.IS_IMPORTED_FOR_TEST) return false;
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // fall back to basename match if realpath fails (e.g. odd launcher)
    return entry.endsWith('scraper-bench.mjs');
  }
}

if (isEntryScript()) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
