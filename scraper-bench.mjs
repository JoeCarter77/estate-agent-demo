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
 * Usage (keys are auto-loaded from .env.local in the cwd — NO --env-file needed;
 * a missing .env.local just warns and continues):
 *   node scraper-bench.mjs            # a,b,c,e (+d if installed)
 *   node scraper-bench.mjs --api      # + f (Scrape.do) & g (Bright Data)
 *   node scraper-bench.mjs --only=a,f
 *   node scraper-bench.mjs --zones    # list your Bright Data zones & exit
 *   node scraper-bench.mjs --dump=ipschelmsford   # dump a site's card HTML + what
 *                                                 # the parser extracted (diagnostic)
 *   (or: npm run bench:api / npm run bench:zones / npm test)
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

// Load .env.local OURSELVES rather than relying on `node --env-file`.
// `node --env-file=.env.local` ABORTS with exit 9 and no stdout when the file
// is missing (and .env.local is gitignored, so it's absent on a clean clone) —
// that was the recurring "zero output" bug. Self-loading degrades gracefully:
// a missing file just warns and the run continues.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
let ENV_LOADED = null;
function loadEnvLocal() {
  const candidates = ['.env.local']; // cwd first
  try {
    candidates.push(new URL('.env.local', import.meta.url)); // then next to the script
  } catch {}
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const raw = readFileSync(p, 'utf8').replace(/^﻿/, ''); // strip BOM
      for (const line of raw.split(/\r?\n/)) {
        const s = line.trim();
        if (!s || s.startsWith('#')) continue;
        const eq = s.indexOf('=');
        if (eq === -1) continue;
        const k = s.slice(0, eq).trim();
        let v = s.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (k && process.env[k] === undefined) process.env[k] = v; // don't override real env
      }
      ENV_LOADED = typeof p === 'string' ? p : p.pathname;
      return;
    } catch {}
  }
}
loadEnvLocal();

let BD_ZONE = process.env.BRIGHTDATA_ZONE || null; // resolved after loadEnvLocal()

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

// ---- Structured extraction (shared with production api/scrape.js) --------
import {
  MIN_FULL, analyse, extractListings, discoverListingsUrl, debugCards,
  isAddress, extractPrice, extractBeds, isUnavailable, statusUnavailable, cleanText, stripBadges,
} from './lib/extract.mjs';

// ---- fetch helpers -------------------------------------------------------

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}
// A transport fetches ONE url and returns raw HTML (+ status). Extraction and
// the homepage→listings-page follow are handled once, centrally, in runScrape.
async function timedText(url, opts, timeout = TIMEOUT_MS) {
  const t0 = Date.now();
  const { signal, done } = withTimeout(timeout);
  try {
    const r = await fetch(url, { redirect: 'follow', signal, ...opts });
    const html = await r.text();
    done();
    return { reachable: r.ok, status: r.status, ms: Date.now() - t0, html };
  } catch (e) {
    done();
    return { reachable: false, status: e.name === 'AbortError' ? 'timeout' : e.code || e.name, ms: Date.now() - t0, html: '' };
  }
}

const tA = (url) => timedText(url, { headers: browserHeaders(CHROME_UA) });
const tC = (url) => timedText(url, { headers: { ...browserHeaders(GOOGLEBOT_UA), From: 'googlebot(at)googlebot.com' } });
async function tB(url) {
  let last = { reachable: false, status: '?', ms: 0, html: '' };
  for (const ua of UA_POOL) {
    last = await timedText(url, { headers: browserHeaders(ua) });
    if (last.reachable) return last;
  }
  return last;
}
async function tD(url) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return { reachable: false, status: 'SKIP', ms: 0, html: '', hint: 'playwright not installed (npm i playwright)' };
  }
  const t0 = Date.now();
  let browser;
  try {
    try {
      browser = await chromium.launch({ headless: true });
    } catch {
      // preinstalled browser whose build differs from the npm package's pin
      const ep = process.env.PLAYWRIGHT_CHROMIUM || '/opt/pw-browsers/chromium';
      browser = await chromium.launch({ headless: true, executablePath: ep });
    }
    const ctx = await browser.newContext({ userAgent: CHROME_UA, locale: 'en-GB' });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    await page.waitForTimeout(2500);
    const html = await page.content();
    await browser.close();
    return { reachable: true, status: 200, ms: Date.now() - t0, html };
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    const missing = /Executable doesn't exist|Failed to launch/i.test(e.message || '');
    return { reachable: false, status: missing ? 'SKIP' : e.name, ms: Date.now() - t0, html: '', hint: missing ? 'run: npx playwright install chromium' : e.message?.slice(0, 60) };
  }
}
async function tF(url) {
  const sd = process.env.SCRAPEDO_KEY;
  const sa = process.env.SCRAPERAPI_KEY;
  let api;
  if (sd) api = `https://api.scrape.do/?token=${sd}&url=${encodeURIComponent(url)}&render=true&geoCode=gb`;
  else if (sa) api = `https://api.scraperapi.com/?api_key=${sa}&url=${encodeURIComponent(url)}&render=true&country_code=uk`;
  else return { reachable: false, status: 'SKIP', ms: 0, html: '', hint: 'set SCRAPEDO_KEY or SCRAPERAPI_KEY' };
  return timedText(api, {}, API_TIMEOUT_MS);
}
async function tG(url) {
  const key = process.env.BRIGHTDATA_KEY;
  if (!key) return { reachable: false, status: 'SKIP', ms: 0, html: '', hint: 'set BRIGHTDATA_KEY' };
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
    const html = await r.text();
    done();
    const zoneErr = !r.ok && /zone|unknown|not found|auth/i.test(html) ? `zone="${zone}"? ${html.slice(0, 50)}` : '';
    return { reachable: r.ok, status: r.status, ms: Date.now() - t0, html, hint: zoneErr };
  } catch (e) {
    done();
    return { reachable: false, status: e.name, ms: Date.now() - t0, html: '', hint: e.message?.slice(0, 60) };
  }
}

function skipResult(hint) {
  return { ok: false, reachable: false, status: 'SKIP', ms: 0, bytes: 0, listings: [], full: 0, count: 0, dropped: 0, phone: null, hint };
}

// Fetch the start URL; if it yields < MIN_FULL listing cards, discover the
// site's for-sale/listings page and fetch that too, keeping whichever gave
// more full cards. Many agent homepages only tease a few (or zero) listings.
async function runScrape(transport, url) {
  const t0 = Date.now();
  const r1 = await transport(url);
  if (r1.status === 'SKIP') return { ...skipResult(r1.hint || 'skipped'), ms: r1.ms || 0 };

  let best = analyse(r1.html, url);
  let usedHtml = r1.html;
  let followedTo = null;
  if (best.full < MIN_FULL && r1.html) {
    const listingsUrl = discoverListingsUrl(r1.html, url);
    if (listingsUrl && listingsUrl !== url) {
      const r2 = await transport(listingsUrl);
      if (r2.html) {
        const a2 = analyse(r2.html, listingsUrl);
        if (a2.full > best.full || (a2.full === best.full && a2.count > best.count)) {
          best = a2;
          usedHtml = r2.html;
          followedTo = listingsUrl;
        }
      }
    }
  }
  let hint = best.hint || '';
  if (followedTo) {
    try {
      hint += ` [followed → ${new URL(followedTo).pathname}]`;
    } catch {}
  }
  if (r1.hint) hint = `${r1.hint}; ${hint}`;
  return { ok: r1.reachable && best.ok, reachable: r1.reachable, status: r1.status, ms: Date.now() - t0, bytes: (usedHtml || '').length, listings: best.listings, full: best.full, count: best.count, dropped: best.dropped, phone: best.phone, hint };
}

// ---- Methods -------------------------------------------------------------

const methods = {
  a: (url) => runScrape(tA, url),
  b: (url) => runScrape(tB, url),
  c: (url) => runScrape(tC, url),
  d: (url) => runScrape(tD, url),

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
      return { ok: false, reachable: gotImage, status: r.status, ms: Date.now() - t0, bytes: buf.length, listings: [], full: 0, count: 0, dropped: 0, phone: null, hint: gotImage ? 'image captured — needs vision OCR (no structured data)' : 'placeholder/failed image' };
    } catch (e) {
      done();
      return { ok: false, reachable: false, status: e.name, ms: Date.now() - t0, bytes: 0, listings: [], full: 0, count: 0, dropped: 0, phone: null, hint: e.message?.slice(0, 60) };
    }
  },

  f: (url) => runScrape(tF, url),
  g: (url) => runScrape(tG, url),
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
    // Decision: fetch-first primary, Bright Data (g) as the block fallback.
    // Scrape.do (f) dropped from the pipeline (slower, worse hit rate); still
    // runnable on demand via --only=f for comparison.
    if (!ids.includes('g')) ids.push('g');
  }
  const dumpArg = args.find((a) => a.startsWith('--dump='));
  return {
    ids: ids.filter((id) => methods[id]),
    zonesOnly: args.includes('--zones'),
    dump: dumpArg ? dumpArg.split('=').slice(1).join('=') : null,
  };
}

function fmt(r) {
  const flag = r.ok ? '✅' : r.reachable ? '🟡' : '❌';
  return `${flag} ${String(r.status).padEnd(7)} ${`${r.ms}ms`.padStart(7)}  ${r.hint || ''}`.trim();
}

// --dump=<name|url>: fetch a site (plain fetch + listings-page follow) and print
// each candidate card's outerHTML + what the parser extracted, and save the raw
// HTML. Lets a failing site's exact markup be inspected to fix extraction.
async function dumpSite(target) {
  const site = TARGETS.find(
    (t) => t.url.includes(target) || t.name.toLowerCase().includes(String(target).toLowerCase())
  );
  const startUrl = site ? site.url : /^https?:/i.test(target) ? target : `https://${target}`;
  console.log(`\n=== DUMP ${site ? site.name : startUrl} ===`);
  const r1 = await tA(startUrl);
  console.log(`homepage: ${startUrl} → status ${r1.status}, ${(r1.html || '').length} bytes`);
  let html = r1.html;
  let page = startUrl;
  let cards = debugCards(html, startUrl);
  // Only follow when the homepage has NO candidate cards — otherwise we'd chase
  // a guessed /for-sale/ link (which 404s on some sites) and hide the homepage
  // cards we actually need to see. When we do follow, keep whichever page has more.
  if (cards.length === 0 && html) {
    const lu = discoverListingsUrl(html, startUrl);
    if (lu && lu !== startUrl) {
      const r2 = await tA(lu);
      const c2 = debugCards(r2.html, lu);
      console.log(`followed → ${lu} → status ${r2.status}, ${(r2.html || '').length} bytes, ${c2.length} cards`);
      if (c2.length > cards.length) {
        html = r2.html;
        page = lu;
        cards = c2;
      }
    } else {
      console.log('no listings-page link discovered from the homepage');
    }
  }
  const a = analyse(html, page);
  const host = (() => {
    try {
      return new URL(page).host;
    } catch {
      return 'site';
    }
  })();
  const file = `dump-${host}.html`;
  try {
    writeFileSync(file, html || '');
  } catch {}
  console.log(`parsed page: ${page}`);
  console.log(`analyse: full=${a.full}/${a.count} dropped=${a.dropped} hint="${a.hint}"`);
  console.log(`raw HTML → ${file}`);
  console.log(`\n${cards.length} candidate card(s) — showing up to 6:\n`);
  for (const c of cards.slice(0, 6)) {
    console.log(`• price=${c.price}  beds=${c.beds}  unavailable=${c.unavailable}  addr=${JSON.stringify(c.address)}`);
    console.log(`  url=${c.url}`);
    console.log(`  parent=${c.parent}`);
    if (c.unavailable) console.log(`  WHY-UNAVAILABLE: ${c.evidence}`);
    console.log(`  html: ${c.html}\n`);
  }
  if (!cards.length)
    console.log(`(no candidate cards found — open ${file} and paste me the first listing <div>/<article> block)`);
}

async function main() {
  const { ids, zonesOnly, dump } = parseArgs();
  // Unconditional first output — so a run is NEVER silent, whatever follows.
  console.log(`scraper-bench starting — ${dump ? `dump ${dump}` : zonesOnly ? 'zones' : `methods ${ids.join(',')}`} — node ${process.version}`);
  console.log(ENV_LOADED ? `env: loaded ${ENV_LOADED}` : 'env: no .env.local found (methods f/g will skip without keys)');

  if (dump) {
    await dumpSite(dump);
    return;
  }

  // Bright Data zone discovery / listing (never fatal to the run)
  if (zonesOnly || (ids.includes('g') && process.env.BRIGHTDATA_KEY && !BD_ZONE)) {
    const key = process.env.BRIGHTDATA_KEY;
    if (!key) {
      console.log('BRIGHTDATA_KEY not set.');
      if (zonesOnly) return;
    } else {
      try {
        const { zones, error } = await brightDataZones(key);
        if (error) console.log(`Bright Data zone lookup failed: ${error}`);
        else {
          console.log('Bright Data zones:', zones.map((z) => `${z.name}${z.type ? ` (${z.type})` : ''}`).join(', ') || '(none)');
          BD_ZONE = pickUnlockerZone(zones);
          console.log(`→ using zone: ${BD_ZONE || '(none found — create a Web Unlocker zone)'}`);
        }
      } catch (e) {
        console.log(`Bright Data zone lookup errored (continuing): ${e.message}`);
      }
      if (zonesOnly) return;
    }
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
export { analyse, extractListings, isAddress, extractPrice, extractBeds, discoverListingsUrl, isUnavailable, debugCards, statusUnavailable, stripBadges };
export { runScrape, tD };
export async function _loadParser() { /* parser is imported statically via lib/extract.mjs */ }

// Run main() whenever the file is executed. We DON'T compare argv[1] to
// import.meta.url — that path-matching idiom silently failed on Windows
// (drive-letter casing / 8.3 short names / npm shims), which is why this
// script kept exiting 0 with no output. Instead, the only importer (the test
// suite) sets IS_IMPORTED_FOR_TEST=1 before importing, which suppresses main.
// Global handlers guarantee that nothing ever exits silently.
if (!process.env.IS_IMPORTED_FOR_TEST) {
  process.on('unhandledRejection', (e) => {
    console.error('Unhandled rejection:', e);
    process.exit(1);
  });
  process.on('uncaughtException', (e) => {
    console.error('Uncaught exception:', e);
    process.exit(1);
  });
  main().catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
  });
}
