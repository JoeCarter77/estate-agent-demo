# Scraper reliability research — findings & recommendation

_Prepared 2026-07-23. Nothing here is deployed. `api/scrape.js` and the live
site are untouched. Await go-ahead before changing production._

## TL;DR

- **The block is not a User-Agent problem — it's an IP-reputation + JS-challenge
  problem.** Every one of these small UK agent sites that I could reach sat
  behind bot protection (Cloudflare-style) that returns **403 to generic
  datacenter fetches regardless of UA**. Confirmed by probing all 10 sites from
  Anthropic's network: **9/9 that resolved returned HTTP 403** to a plain
  fetch; 1 (`brentwoodestateagents.co.uk`) failed DNS entirely.
- **Methods a, b, and c (plain fetch / rotating UA / Googlebot spoof) will not
  give you a reliable scraper.** They fail on the exact protection these sites
  use. The Googlebot spoof is worse than useless against Cloudflare — see below.
- **A managed unblocker/scraping API is the only approach that hits the
  reliability + ~5s targets across mixed platforms.** Recommendation:
  **Scrape.do** (~$0.80/1k successful calls, ~0.8–2s typical, 99% success,
  built-in Cloudflare bypass + GB geo). Runner-up: **Bright Data Web Unlocker**
  (pricier, ~$1.30–1.50/1k, strongest unblocking, 5k/mo free tier).
- **Headless-on-Vercel (method d) is a trap for this use case.** It fits under
  the size limit via `@sparticuz/chromium`, but it runs from Vercel's datacenter
  IPs — the same IPs Cloudflare flags — so it doesn't fix the block, and cold
  starts blow the ~5s budget.

## What I could and couldn't test from here

The Claude sandbox egress is allow-listed to github/npm/pypi/anthropic only, so
I **could not run the benchmark script against the live sites from this
environment** (every outbound request is 403'd by the proxy, not by the sites).
Two things I _could_ do:

1. **WebFetch** (runs on Anthropic's network, a neutral third-party datacenter,
   with a generic fetcher UA) — a fair proxy for "does this site block generic
   server fetches."
2. **WebSearch** (reads Google's index; Googlebot crawls from verified Google
   IPs) — confirms the data exists and is crawlable by a _verified_ bot.

The `scraper-bench.mjs` script is built to be run by you from an unrestricted
network to get the precise per-method, per-site table. **Please run it on your
laptop / a VPS** — see "How to run the benchmark" below.

## Evidence: the 403 wall (WebFetch probe, Anthropic network)

| # | Site | Plain fetch (WebFetch) |
|---|------|------------------------|
| 1 | parabar.co.uk | **403** |
| 2 | ashtonwhite.co.uk | **403** |
| 3 | www.tylerestates.co.uk | **403** |
| 4 | www.hentonkirkman.co.uk | **403** (matches prior session) |
| 5 | brentwoodestateagents.co.uk | **DNS ENOTFOUND** (both apex + www) |
| 6 | www.wnproperties.co.uk | **403** |
| 7 | www.hs-estateagents.co.uk | **403** |
| 8 | smoothmoveestates.co.uk | **403** |
| 9 | ipschelmsford.co.uk | **403** |
| 10 | www.charlesdavidcasson.co.uk | **403** |

**9 of 9 resolving sites blocked a generic fetch.** This is the single most
important finding: the Henton Kirkman block is **not a one-off** — it's the norm
for this segment. UK small-agent sites are overwhelmingly built by web-design
shops that put Cloudflare (free tier, "Bot Fight Mode" / managed challenge) in
front by default.

> Caveat, stated honestly: a WebFetch 403 can't fully separate "site blocks all
> datacenter IPs" from "site blocks Anthropic's specific fetcher IP/UA." But the
> uniformity across 9 independent sites, plus the prior session's independent
> confirmation on Henton Kirkman (sandbox egress + WebFetch homepage + WebFetch
> listing page all 403), makes "these sites broadly block generic server
> fetches" the only consistent explanation. The benchmark script exists to
> nail the exact numbers from a clean IP.

## Method-by-method verdict

### a) Plain fetch + realistic Chrome UA — ❌ not viable
Already implemented in production (`scrape.js` sends a full Chrome UA + headers)
and already failing. 9/9 sites 403. A good UA is necessary but nowhere near
sufficient.

### b) Rotating realistic UAs — ❌ not viable
UA rotation only helps against naive `if UA == X block` rules. It does nothing
against IP reputation, TLS/JA3 fingerprinting, or JS challenges — which is what
Cloudflare actually uses. Same 403.

### c) Googlebot UA spoof — ❌ not viable, often *counter-productive*
This is the one people reach for, and it's a trap against Cloudflare.
Cloudflare's managed ruleset **verifies Googlebot by reverse-DNS / ASN**, not by
UA string. A request claiming to be Googlebot from a non-Google IP is flagged as
a **fake bot and blocked harder** (deterministic 403), where a normal browser UA
might only get a challenge. (Cloudflare WAF docs: "fake bot" managed rules;
`searchengineland`/`almcorp` Googlebot-fraud guides.)

Why the prior session saw "Googlebot got through" on Henton Kirkman: that was
**Google's *index* (WebSearch) returning the data**, i.e. the _real_ Googlebot
from Google IPs having crawled it — not a spoofed-UA fetch succeeding. Real
Googlebot passes because its IPs are allow-listed; you can't replicate that by
copying the UA string. Keep the method in the bench for completeness, but expect
it to **lower** the success rate on Cloudflare sites, not raise it.

### d) Headless browser (Playwright) — ⚠️ works sometimes, wrong tool on Vercel
A real headless Chromium renders SPA/Wix/Squarespace content and can solve
_some_ JS challenges. But:
- **It runs from Vercel's datacenter IPs** — the same reputation bucket
  Cloudflare blocks. It fixes JS-render blocks, **not IP blocks**, so on these
  Cloudflare sites it will still frequently 403 / hit "Just a moment…".
- **Serverless fit:** `playwright-core` (~5MB) + `@sparticuz/chromium` (~40MB)
  squeaks under Vercel's 50MB function limit, but **cold starts unpack Chromium
  to `/tmp` and routinely take 3–8s+ before the first navigation** — that alone
  blows the ~5s budget on the click spinner. Warm starts are better but not
  guaranteed on a low-traffic demo.
- **Verdict:** viable only as a _separate persistent scraping service_ (a
  long-running box with residential egress), not inline in the Vercel request
  path. Not worth it when a managed API does the same thing plus residential IPs.

### e) Screenshot-then-parse (thum.io & similar) — 🟡 keep, but as a fallback, not the data source
thum.io already works for your hero mockup because its renderer reaches sites
that block you (it's a real browser from allow-listed/residential-ish infra).
You _could_ screenshot a listings page and run a **vision model** over the image
to extract listings. Tradeoffs:
- ✅ Reaches sites that 403 you; no HTML parsing per platform.
- ❌ Lossy and slow: you get pixels, so you need an OCR/vision pass
  (claude-haiku vision or similar) → extra latency + token cost, and structured
  fields (price/beds/address/url) come back fuzzier than from HTML.
- ❌ You don't get listing **URLs** (needed to deep-link), only what's on screen.
- **Verdict:** great as the **AMBER/RED graceful-degradation path** (you already
  screenshot the homepage — a vision pass on it can yield town + "has listings"
  signal cheaply), not as the primary structured-data source.

### f) Managed scraping API / unblocker — ✅ recommended winner
Offloads IP rotation (residential proxies), TLS/JA3 fingerprinting, JS
rendering, and Cloudflare challenge-solving to a provider. ~10-line change in
`fetchPage()` (swap the `fetch(url)` for `fetch(apiEndpoint(url))`), keeps the
Vercel function tiny and fast, and is the only option that plausibly clears
**all** these sites within ~5s.

## Scraping API options (2026 pricing)

| Provider | Entry | Per 1k (JS+proxy) | Typical speed | CF bypass | Notes |
|---|---|---|---|---|---|
| **Scrape.do** ✅ | $29/mo (250k) | **~$0.80** | **0.8–2s** (heavy pages 10–13s) | Yes | Cheapest + fastest + 99% success. `geoCode=gb`. **Top pick.** |
| Scrapfly | $30/mo | ~$3.88 | mid | Yes | 99% success in benchmarks; good docs. |
| ScrapingBee | $49/mo | ~$3.90 (JS 5×) | mid | Yes | JS on by default (5× credits). |
| Bright Data Web Unlocker | PAYG | ~$1.30–1.50 | fast | **Strongest** | 5k/mo free tier; best on the nastiest WAFs; pricier. Good runner-up. |
| ScraperAPI | $49/mo | ~$8.49 | **~15.7s avg ❌** | Yes | Too slow for the 5s target; skip. |
| ZenRows | $69/mo | 25 credits on protected sites | mid | Yes | Auto-forces render+premium proxy (no opt-out) → cost spikes. |

**Cost sanity check for the demo model:** you scrape once per prospect (on demo
generation, ideally pre-warmed at send-time, not on the live click). Even at
100 prospects/day that's ~3k calls/mo → **well within Scrape.do's $29 tier**, or
free on Bright Data's 5k tier. This is a per-scrape cost model and it's cheap.

## Recommended architecture (for when you say go)

1. **Primary:** route `fetchPage()` through **Scrape.do** with `render=true` +
   `geoCode=gb`. Key in an env var (`SCRAPEDO_KEY`). Keep the existing parsing
   logic — you're only swapping how the HTML is fetched.
2. **Don't scrape on the click.** Pre-warm the scrape at **send-time** for the
   warm/priority list, cache the result (listings JSON + phone) keyed by URL, so
   the demo loads instantly and grades GREEN. Fall back to a live call only for
   cold/unknown prospects.
3. **Graceful degradation (the tier grader from `novusdemotierspec.md`):** if the
   API still returns nothing, drop to **AMBER** using the homepage screenshot +
   a cheap vision/town-detection pass, not a broken-looking RED. This is what
   saves Henton Kirkman (really GREEN, but any single-provider hiccup shouldn't
   make it look broken).
4. **Keep headless out of the Vercel request path.** If you ever want to
   self-host scraping, do it as a separate always-on service with residential
   egress — but the managed API removes that need.
5. **Log `{company, url, tier, listings_found, method, ms}` per prospect** so you
   can see real success rates once live.

## How to run the benchmark (`scraper-bench.mjs`)

From your laptop or a VPS (NOT this sandbox):

```bash
node scraper-bench.mjs                 # methods a,b,c,e  (+ d if playwright installed)
node scraper-bench.mjs --only=a,c,e    # pick a subset

# headless method d:
npm i playwright && npx playwright install chromium
node scraper-bench.mjs --only=d

# managed API method f (the one that should win):
SCRAPEDO_KEY=xxxxx node scraper-bench.mjs --api --only=f
# or
SCRAPERAPI_KEY=xxxxx node scraper-bench.mjs --api --only=f
```

It prints a per-site × per-method table (✅ got listings / 🟡 reachable but
no data or challenge page / ❌ blocked) plus a success-rate summary, and writes
`scraper-bench-results.json`. Expected shape of results based on this research:
a/b/c mostly ❌, d mixed 🟡/❌ (and slow), e mostly ✅-reachable but no
structured listings, **f mostly ✅**.

## Sources

- Scraping API pricing/speed: [Scrape.do pricing](https://scrape.do/pricing/),
  [Scrapfly (Prospeo)](https://prospeo.io/s/scrapfly-pricing-reviews-pros-and-cons),
  [ScraperAPI review](https://thunderbit.com/blog/scraper-api-review),
  [Bright Data alternatives](https://scrape.do/blog/bright-data-alternatives/)
- Cloudflare fake-Googlebot handling:
  [Cloudflare WAF fake-bot rules](https://developers.cloudflare.com/waf/troubleshooting/fake-bot-managed-rules/),
  [Verified bots](https://developers.cloudflare.com/bots/concepts/bot/verified-bots/),
  [Googlebot fraud guide](https://searchengineland.com/guide/what-is-googlebot-fraud)
- Headless on Vercel: [@sparticuz/chromium](https://www.npmjs.com/package/@sparticuz/chromium),
  [ZenRows: Playwright on Vercel](https://www.zenrows.com/blog/playwright-vercel)
- Henton Kirkman data (via Google index): phone **01277 500800**, The Horseshoes,
  137a High Street, Billericay CM12 9AB; Rightmove `BRANCH^141971`.
