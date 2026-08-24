// lib/property-image.mjs — the listing's hero photo, extracted ONCE.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: the prospect's browser never touches
// Rightmove. The image URL is resolved when a demo row is built (or by the
// backfill utility), stored on DEMOS.property_image_url, and served from that
// row from then on. Opening a demo triggers no portal request of any kind.
//
// FAILURE IS NORMAL AND NEVER BLOCKS. Rightmove blocks datacentre IPs, renders
// client-side, and takes listings down. Every path here returns '' rather than
// throwing, and buildDemoRow() treats a blank image as a warning, not an error
// — demo.html falls back to the drawn placeholder it already had.
//
// TWO EXTRACTION PATHS, deliberately separate:
//   fetchPropertyImageUrl()          one short HTTP fetch. Safe in a serverless
//                                    function. Often returns '' on Rightmove.
//   fetchPropertyImageUrlViaBrowser() Playwright. NEVER called from an API
//                                    route — it is for the CLI backfill only
//                                    (scripts/novus-demo.mjs), where a real
//                                    browser and a real IP are available.
//
// extractPropertyImageUrl() is pure over already-fetched HTML, so both paths
// share one extractor and it can be tested against saved markup with no
// network access at all.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT_MS = 8000;
const BROWSER_TIMEOUT_MS = 25000;

// Rightmove serves branch logos, agent badges and static UI art from the same
// media host as property photography. None of them is a hero image.
const NOT_A_PROPERTY_PHOTO = /(logo|brand|placeholder|sprite|icon|favicon|watermark|_epc|epcgraph|floorplan|_flp_|\/company\/)/i;

const IMAGE_EXTENSION = /\.(jpe?g|png|webp|avif)(\?|$)/i;

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x2F;/gi, '/')
    .trim();
}

function jsonUnescape(raw) {
  try { return JSON.parse(`"${raw}"`); } catch { return raw; }
}

// An acceptable hero image: absolute http(s), an image by extension (or a
// known media host that omits one), and not obviously chrome.
export function isUsablePropertyImage(url) {
  const value = String(url || '').trim();
  if (!/^https?:\/\//i.test(value)) return false;
  if (NOT_A_PROPERTY_PHOTO.test(value)) return false;
  if (IMAGE_EXTENSION.test(value)) return true;
  // Portal CDNs that serve photos from extensionless paths.
  return /(media\.rightmove\.co\.uk|lid\.zoocdn\.com|lc\.zoocdn\.com|media\.onthemarket\.com)/i.test(value);
}

// Rightmove's PAGE_MODEL images carry both a canonical `url` and a
// `resizedImageUrls` map. Prefer the largest named size — a 135x100 thumbnail
// in a full-bleed hero is the one visibly-wrong outcome here.
function preferLargest(image) {
  if (!image || typeof image !== 'object') return '';
  const resized = image.resizedImageUrls || image.resizedImages || null;
  if (resized && typeof resized === 'object') {
    const bySize = Object.entries(resized)
      .map(([key, value]) => {
        const m = String(key).match(/(\d+)\s*x\s*(\d+)/);
        return { area: m ? Number(m[1]) * Number(m[2]) : 0, value: String(value || '') };
      })
      .filter((entry) => isUsablePropertyImage(entry.value))
      .sort((a, b) => b.area - a.area);
    if (bySize.length) return bySize[0].value;
  }
  for (const key of ['url', 'srcUrl', 'imageUrl', 'masterUrl']) {
    const candidate = String(image[key] || '');
    if (isUsablePropertyImage(candidate)) return candidate;
  }
  return '';
}

// window.PAGE_MODEL = {...} (Rightmove) / __NEXT_DATA__ (several portals).
// Parsed properly where the JSON is well-formed; the regex sweeps below are
// the fallback for a page whose script block will not parse whole.
function fromEmbeddedJson(html) {
  const blocks = [];
  const pageModel = String(html || '').match(/window\.PAGE_MODEL\s*=\s*(\{[\s\S]*?\})\s*<\/script>/i);
  if (pageModel) blocks.push(pageModel[1]);
  const nextData = String(html || '').match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextData) blocks.push(nextData[1]);

  for (const block of blocks) {
    let data;
    try { data = JSON.parse(block); } catch { continue; }
    const images = findImagesArray(data);
    if (!images) continue;
    for (const image of images) {
      const url = typeof image === 'string' ? image : preferLargest(image);
      if (isUsablePropertyImage(url)) return url;
    }
  }
  return '';
}

// Depth-limited hunt for the property's own images[] array. Bounded so a
// pathological page can never turn extraction into a long walk.
function findImagesArray(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findImagesArray(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const key of ['images', 'propertyImages', 'photos']) {
    const value = node[key];
    if (Array.isArray(value) && value.length) return value;
    if (value && typeof value === 'object' && Array.isArray(value.images) && value.images.length) return value.images;
  }
  for (const value of Object.values(node)) {
    const found = findImagesArray(value, depth + 1);
    if (found) return found;
  }
  return null;
}

// "images":[{"url":"https://media.rightmove.co.uk/...jpeg", ...
function fromImagesRegex(html) {
  const source = String(html || '');
  const arrayMatch = source.match(/"(?:images|propertyImages|photos)"\s*:\s*\[([\s\S]{0,4000}?)\]/i);
  const scope = arrayMatch ? arrayMatch[1] : '';
  if (!scope) return '';
  const urls = scope.match(/"(?:url|srcUrl|imageUrl|masterUrl)"\s*:\s*"((?:[^"\\]|\\.)*)"/gi) || [];
  for (const raw of urls) {
    const m = raw.match(/:\s*"((?:[^"\\]|\\.)*)"/);
    if (!m) continue;
    const url = jsonUnescape(m[1]);
    if (isUsablePropertyImage(url)) return url;
  }
  return '';
}

function metaContent(html, prop) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = String(html || '').match(re);
    if (m) return decodeEntities(m[1]);
  }
  return '';
}

// schema.org listings expose `image` as a string or an array of strings.
function fromJsonLd(html) {
  const blocks = String(html || '').match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of blocks) {
    const jsonText = block.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim();
    let data;
    try { data = JSON.parse(jsonText); } catch { continue; }
    const items = Array.isArray(data) ? data : [data];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const image = item.image || item.photo;
      const candidates = Array.isArray(image) ? image : [image];
      for (const candidate of candidates) {
        const url = typeof candidate === 'string' ? candidate : String(candidate?.url || '');
        if (isUsablePropertyImage(url)) return url;
      }
    }
  }
  return '';
}

// Last resort: the first portal-media URL anywhere on the page.
function fromMediaHostSweep(html) {
  const urls = String(html || '').match(
    /https?:\/\/(?:media\.rightmove\.co\.uk|lid\.zoocdn\.com|lc\.zoocdn\.com|media\.onthemarket\.com)[^"'\\\s<>)]+/gi,
  ) || [];
  for (const raw of urls) {
    const url = decodeEntities(jsonUnescape(raw));
    if (isUsablePropertyImage(url)) return url;
  }
  return '';
}

// PURE. Given a listing page's HTML, the hero photo URL, or '' when the page
// carries nothing trustworthy. Order is most-specific-first: the property's
// own media array beats a social-card image, which beats a blind sweep.
export function extractPropertyImageUrl(html) {
  const candidates = [
    fromEmbeddedJson(html),
    fromImagesRegex(html),
    fromJsonLd(html),
    metaContent(html, 'og:image'),
    metaContent(html, 'twitter:image'),
    fromMediaHostSweep(html),
  ];
  for (const candidate of candidates) {
    const url = decodeEntities(candidate);
    if (isUsablePropertyImage(url)) return url;
  }
  return '';
}

// ── path 1: one short HTTP fetch (serverless-safe) ───────────────────────────

// Never throws. `fetchImpl` is injectable so the self-test exercises the real
// control flow with no network.
export async function fetchPropertyImageUrl(url, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const target = String(url || '').trim();
  if (!target) return '';
  const absolute = /^https?:\/\//i.test(target) ? target : `https://${target}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(absolute, {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-GB,en;q=0.9',
        },
        signal: controller.signal,
        redirect: 'follow',
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res || !res.ok) return '';
    const contentType = res.headers?.get?.('content-type') || '';
    if (contentType && !contentType.includes('html')) return '';
    const html = await res.text();
    return extractPropertyImageUrl(html);
  } catch {
    return ''; // blocked / timeout / network — a blank image is a fallback, not a failure
  }
}

// ── path 2: a real browser (CLI backfill only) ───────────────────────────────

// Rightmove routinely serves datacentre IPs a challenge page that carries no
// listing media at all, which is exactly what path 1 returns '' for. This is
// the escalation: a real Chromium, a real render, then the SAME pure
// extractor. Playwright is an optionalDependency, so a missing install is a
// blank result, never a crash.
//
// Deliberately not importable-by-accident into an API route: it is only
// referenced from scripts/novus-demo.mjs.
export async function fetchPropertyImageUrlViaBrowser(url, { timeoutMs = BROWSER_TIMEOUT_MS } = {}) {
  const target = String(url || '').trim();
  if (!target) return '';
  const absolute = /^https?:\/\//i.test(target) ? target : `https://${target}`;

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return ''; // playwright not installed — caller falls back to path 1's result
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: UA,
      locale: 'en-GB',
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(absolute, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    // The media array is in the page payload, not behind an interaction — a
    // short settle is enough, and a timeout here must not lose what did load.
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    const html = await page.content();
    return extractPropertyImageUrl(html);
  } catch {
    return '';
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// The one entry point a caller should normally use: try the cheap path, and
// escalate to a browser only when asked to and only outside a serverless
// runtime. Always resolves to a string.
export async function resolvePropertyImageUrl(url, { allowBrowser = false } = {}) {
  const direct = await fetchPropertyImageUrl(url);
  if (direct) return direct;
  if (!allowBrowser) return '';
  return fetchPropertyImageUrlViaBrowser(url);
}

export const _internal = {
  fromEmbeddedJson, fromImagesRegex, fromJsonLd, fromMediaHostSweep, preferLargest, metaContent,
};
