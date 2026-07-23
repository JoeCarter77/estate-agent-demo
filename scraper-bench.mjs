#!/usr/bin/env node
/**
 * scraper-bench.mjs — standalone scraper-reliability benchmark.
 *
 * NOT the production scraper. This tries multiple scraping methods against a
 * list of UK estate-agent sites and reports, per site x method:
 *   - ok:        did we get real HTML back (2xx + non-trivial body)
 *   - listings:  naive signal that the HTML actually contains property data
 *   - status:    HTTP status (or error kind)
 *   - ms:        wall-clock time
 *   - note:      block reason / detail
 *
 * Run it from an UNRESTRICTED network (your laptop or a Vercel function) —
 * NOT the Claude sandbox, whose egress is allow-listed to github/npm/etc.
 *
 *   node scraper-bench.mjs                 # methods a,b,c,e (+ d if playwright installed)
 *   node scraper-bench.mjs --only=a,c      # subset of methods
 *   SCRAPEDO_KEY=xxx node scraper-bench.mjs --api   # also run method f (scraping API)
 *
 * Optional deps (only needed for the methods you enable):
 *   npm i playwright            # method d (headless). then: npx playwright install chromium
 *   SCRAPEDO_KEY / SCRAPERAPI_KEY env var   # method f
 */

const TARGETS = [
  { name: 'Parabar Estates',        url: 'https://parabar.co.uk/' },
  { name: 'Ashton White',           url: 'https://ashtonwhite.co.uk/' },
  { name: 'Tyler Estates',          url: 'https://www.tylerestates.co.uk/' },
  { name: 'Henton Kirkman',         url: 'https://www.hentonkirkman.co.uk/' },
  { name: 'Brentwood Estate Agents',url: 'https://brentwoodestateagents.co.uk/' },
  { name: 'WN Properties',          url: 'https://www.wnproperties.co.uk/' },
  { name: 'HS Estate Agents',       url: 'https://www.hs-estateagents.co.uk/' },
  { name: 'Smooth Move Estates',    url: 'https://smoothmoveestates.co.uk/' },
  { name: 'IPS Property Services',  url: 'https://ipschelmsford.co.uk/' },
  { name: 'Charles David Casson',   url: 'https://www.charlesdavidcasson.co.uk/' },
];

const TIMEOUT_MS = 15000; // generous for the bench; production target is ~5s

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

// Real Googlebot UA string. NOTE: from a datacenter IP this is USUALLY
// counter-productive against Cloudflare (reverse-DNS verified-bot check → 403).
const GOOGLEBOT_UA =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

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

// Does this HTML actually look like it contains estate-agent listings/contact?
function analyseHtml(html) {
  if (!html) return { listings: false, phone: null, hint: 'empty body' };
  const text = html.replace(/\s+/g, ' ');
  const priceHits = (text.match(/£\s?\d[\d,]{2,}/g) || []).length;
  const bedHits = (text.match(/\b\d\s?(?:bed|bedroom)/gi) || []).length;
  const forSale = /for sale|to let|guide price|offers (?:in|over)|£[\d,]+ pcm/i.test(text);
  const phone = (text.match(/\b0(?:1\d{3}|2\d)\s?\d{3}\s?\d{3,4}\b/) || [])[0] || null;
  // Cloudflare/anti-bot interstitial fingerprints
  const challenged =
    /just a moment|attention required|cf-browser-verification|challenge-platform|enable javascript and cookies|checking your browser/i.test(
      text
    );
  const listings = !challenged && priceHits >= 1 && (bedHits >= 1 || forSale);
  return {
    listings,
    phone,
    hint: challenged
      ? 'JS/anti-bot challenge page'
      : `£×${priceHits} bed×${bedHits} sale=${forSale}`,
  };
}

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

async function timedFetch(url, headers) {
  const t0 = Date.now();
  const { signal, done } = withTimeout(TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers, redirect: 'follow', signal });
    const body = await r.text();
    done();
    const a = analyseHtml(body);
    return {
      ok: r.ok && a.listings,
      reachable: r.ok,
      status: r.status,
      ms: Date.now() - t0,
      bytes: body.length,
      ...a,
    };
  } catch (e) {
    done();
    return {
      ok: false,
      reachable: false,
      status: e.name === 'AbortError' ? 'timeout' : e.code || e.name,
      ms: Date.now() - t0,
      bytes: 0,
      listings: false,
      phone: null,
      hint: e.message?.slice(0, 60),
    };
  }
}

// ---- Methods -------------------------------------------------------------

const methods = {
  // a) plain fetch, realistic Chrome UA + standard headers
  a: (url) => timedFetch(url, browserHeaders(CHROME_UA)),

  // b) rotating realistic UAs — try each until one yields listings
  b: async (url) => {
    let last;
    for (const ua of UA_POOL) {
      last = await timedFetch(url, browserHeaders(ua));
      if (last.ok) return { ...last, hint: `won with UA: ${ua.slice(0, 24)}…` };
    }
    return last;
  },

  // c) Googlebot UA spoof (named method — datacenter IP usually fails Cloudflare)
  c: (url) => timedFetch(url, { ...browserHeaders(GOOGLEBOT_UA), 'From': 'googlebot(at)googlebot.com' }),

  // d) headless browser (Playwright). Skipped automatically if not installed.
  d: async (url) => {
    let chromium;
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      return { ok: false, status: 'SKIP', ms: 0, bytes: 0, listings: false, phone: null, hint: 'playwright not installed' };
    }
    const t0 = Date.now();
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const ctx = await browser.newContext({ userAgent: CHROME_UA, locale: 'en-GB' });
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
      // give client-rendered (Wix/Squarespace/React) listings a moment to paint
      await page.waitForTimeout(2500);
      const html = await page.content();
      const status = 200;
      await browser.close();
      const a = analyseHtml(html);
      return { ok: a.listings, reachable: true, status, ms: Date.now() - t0, bytes: html.length, ...a };
    } catch (e) {
      if (browser) await browser.close().catch(() => {});
      return { ok: false, reachable: false, status: e.name, ms: Date.now() - t0, bytes: 0, listings: false, phone: null, hint: e.message?.slice(0, 60) };
    }
  },

  // e) screenshot-then-parse (thum.io). Confirms the renderer reaches the site;
  //    real listing extraction from the image needs a vision model (not done here).
  e: async (url) => {
    const shot = `https://image.thum.io/get/width/1200/noanimate/${url}`;
    const t0 = Date.now();
    const { signal, done } = withTimeout(TIMEOUT_MS);
    try {
      const r = await fetch(shot, { signal });
      const buf = Buffer.from(await r.arrayBuffer());
      done();
      // thum.io returns a small placeholder PNG when it fails; real shots are larger
      const gotImage = r.ok && buf.length > 15000;
      return {
        ok: gotImage, // "ok" = renderer reached the site; NOT structured data
        reachable: gotImage,
        status: r.status,
        ms: Date.now() - t0,
        bytes: buf.length,
        listings: false,
        phone: null,
        hint: gotImage ? 'image captured — needs vision OCR to extract listings' : 'placeholder/failed image',
      };
    } catch (e) {
      done();
      return { ok: false, reachable: false, status: e.name, ms: Date.now() - t0, bytes: 0, listings: false, phone: null, hint: e.message?.slice(0, 60) };
    }
  },

  // f) managed scraping API (Scrape.do shown; ScraperAPI fallback). Needs env key.
  f: async (url) => {
    const sd = process.env.SCRAPEDO_KEY;
    const sa = process.env.SCRAPERAPI_KEY;
    let api;
    if (sd) api = `https://api.scrape.do/?token=${sd}&url=${encodeURIComponent(url)}&render=true&geoCode=gb`;
    else if (sa) api = `https://api.scraperapi.com/?api_key=${sa}&url=${encodeURIComponent(url)}&render=true&country_code=uk`;
    else return { ok: false, status: 'SKIP', ms: 0, bytes: 0, listings: false, phone: null, hint: 'set SCRAPEDO_KEY or SCRAPERAPI_KEY' };
    const t0 = Date.now();
    const { signal, done } = withTimeout(30000); // APIs can take longer
    try {
      const r = await fetch(api, { signal });
      const body = await r.text();
      done();
      const a = analyseHtml(body);
      return { ok: r.ok && a.listings, reachable: r.ok, status: r.status, ms: Date.now() - t0, bytes: body.length, ...a };
    } catch (e) {
      done();
      return { ok: false, reachable: false, status: e.name, ms: Date.now() - t0, bytes: 0, listings: false, phone: null, hint: e.message?.slice(0, 60) };
    }
  },
};

// ---- Runner --------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const wantApi = args.includes('--api');
  let ids = onlyArg ? onlyArg.split('=')[1].split(',') : ['a', 'b', 'c', 'd', 'e'];
  if (wantApi && !ids.includes('f')) ids.push('f');
  return ids.filter((id) => methods[id]);
}

function fmt(r) {
  const flag = r.ok ? '✅' : r.reachable ? '🟡' : '❌';
  const status = String(r.status).padEnd(7);
  const ms = `${r.ms}ms`.padStart(7);
  return `${flag} ${status} ${ms}  ${r.hint || ''}`.trim();
}

async function main() {
  const ids = parseArgs();
  console.log(`\nScraper benchmark — methods: ${ids.join(', ')} — ${new Date().toISOString()}`);
  console.log('Legend: ✅ got listings  🟡 reachable but no listings/challenge  ❌ blocked/error\n');

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

  console.log('\n\n=== SUCCESS RATE (got real listing data / reachable) ===');
  const n = TARGETS.length;
  for (const id of ids) {
    const t = tally[id];
    console.log(`  ${id}:  listings ${t.ok}/${n}   reachable ${t.reachable}/${n}`);
  }

  const fs = await import('node:fs');
  fs.writeFileSync('scraper-bench-results.json', JSON.stringify(results, null, 2));
  console.log('\nRaw results → scraper-bench-results.json\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
