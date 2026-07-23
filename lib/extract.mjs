// lib/extract.mjs — shared listing-extraction logic.
//
// SINGLE SOURCE OF TRUTH used by BOTH the production scraper (api/scrape.js) and
// the benchmark (scraper-bench.mjs). The 22 fixtures in parser-test.mjs validate
// this module, so production and the benchmark can never diverge. Ported verbatim
// from the proven benchmark logic — do not re-derive.
import { parse as parseHTML } from 'node-html-parser';

export const MIN_FULL = 3; // ✅ requires >= this many cards with price+beds+address+url

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

// A listing is "unavailable" (sold / let-agreed / under offer) — exclude it.
const UNAVAILABLE = /\b(sold(?:\s*s?tc)?|sstc|under\s*offer|let\s*agreed|now\s*let|tenancy\s*agreed|reserved|withdrawn|let\s*by)\b/i;
function isUnavailable(text) {
  return UNAVAILABLE.test(text);
}

const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
function bedsFromText(t) {
  let m = t.match(/(\d{1,2})\s*(?:bed(?:room)?s?\b|bed\b)/i); // "3 bed", "3 beds", "3 bedroom(s)"
  if (m) return +m[1];
  m = t.match(/(\d{1,2})\s*(?:double|single|dbl)\s*bed/i); // "3 double bedrooms"
  if (m) return +m[1];
  m = t.match(/bed(?:room)?s?\s*[:\-]?\s*(\d{1,2})\b/i); // "Bedrooms: 3", "beds 3"
  if (m) return +m[1];
  // spelled-out numbers, e.g. "Three-Bedrooms Terraced House" (Charles David Casson)
  m = t.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[\s\-]*bed(?:room)?s?\b/i);
  if (m) return WORD_NUM[m[1].toLowerCase()];
  if (/\bstudio\b/i.test(t)) return 0; // studio flat = 0 bedrooms
  return null;
}
// Multi-strategy bed extraction: data-attrs, aria/title labels, class/icon
// markup (e.g. <i class="icon-bed"></i> 3 with no "bed" text), then plain text.
// Different platforms encode beds very differently, so text alone misses many.
function extractBeds(card) {
  if (!card || !card.querySelectorAll) return bedsFromText(cleanText(card));
  const els = [card, ...card.querySelectorAll('*')]; // include the card node's own attrs
  // 1) data attributes + aria/title labels
  for (const e of els) {
    const g = e.getAttribute ? e.getAttribute.bind(e) : () => null;
    for (const k of ['data-bedrooms', 'data-beds', 'data-bedroom', 'data-bed']) {
      const v = g(k);
      if (v && /^\s*\d{1,2}\s*$/.test(v)) return +v.trim();
    }
    const lab = `${g('aria-label') || ''} ${g('title') || ''}`;
    const lm = lab.match(/(\d{1,2})\s*bed/i) || lab.match(/bed[a-z]*\s*[:\-]?\s*(\d{1,2})/i);
    if (lm) return +lm[1];
  }
  // 2) icon markup: an element that REFERS to a bed — via class token, an
  //    <img src=".../bed.svg">, or an <svg><use href="#icon-bed">. The number
  //    is usually a sibling text node, so read the element's parent scope.
  for (const e of els) {
    const g = e.getAttribute ? e.getAttribute.bind(e) : () => null;
    const tag = (e.rawTagName || '').toLowerCase();
    const cls = (g('class') || '').toLowerCase();
    const classBed = cls.split(/[\s_\-]+/).some((tok) => /^bed/.test(tok));
    const imgBed = tag === 'img' && /bed/i.test(g('src') || '');
    const useBed = tag === 'use' && /bed/i.test(g('href') || g('xlink:href') || '');
    if (classBed || imgBed || useBed) {
      // widen scope for icon-only markup: self, parent, grandparent
      const scope = `${cleanText(e)} ${cleanText(e.parentNode)} ${cleanText(e.parentNode && e.parentNode.parentNode)}`;
      const m = scope.match(/\b(\d{1,2})\b/);
      if (m) return +m[1];
    }
    if (tag === 'img') {
      const am = (g('alt') || '').match(/(\d{1,2})\s*bed/i);
      if (am) return +am[1];
    }
  }
  // 3) plain text of the card
  return bedsFromText(cleanText(card));
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

function isElement(n) {
  // node-html-parser gives text nodes nodeType 3 and an EMPTY-string rawTagName,
  // so guard on nodeType 1 / a non-empty tag name (not just "is it a string").
  return !!n && (n.nodeType === 1 || (typeof n.rawTagName === 'string' && n.rawTagName.length > 0));
}
function isNavHref(h) {
  return !h || /^(#|tel:|mailto:|javascript:|data:)/i.test(h);
}
function distinctPrices(text) {
  const m = text.match(/£\s?(?:\d{1,3}(?:,\d{3})+|\d{4,})/g);
  return m ? new Set(m.map((x) => x.replace(/\s+/g, ''))).size : 0;
}
function distinctListingHrefs(el) {
  if (!el || !el.querySelectorAll) return 0;
  const s = new Set();
  for (const a of el.querySelectorAll('a')) {
    const h = a.getAttribute && a.getAttribute('href');
    if (h && LISTING_HREF.test(h)) s.add(h.split('#')[0].replace(/\/+$/, ''));
  }
  return s.size;
}
// An element that spans 2+ DISTINCT listings (different detail URLs or prices)
// is a grid/list container, not a single card — climbing into it collapses many
// listings into one (the IPS bug). Counting DISTINCT (not raw) is essential:
// one rich card often links to the same property several times (image, title,
// "view") — Expert Agent "eapow" rows — which raw counting mistook for a
// multi-card container, stopping the climb early and dropping beds (WN bug).
function isMultiCardContainer(el, text) {
  return distinctListingHrefs(el) >= 2 || distinctPrices(text) >= 2;
}

// Loose text-node strings inside a card. Some themes drop the address as bare
// text with no wrapping tag/class (Parabar: "St. Lawrence Road, Upminster" sits
// directly in the card div), so element-only scanning misses it.
function cardTextNodes(card) {
  const out = [];
  const walk = (el) => {
    for (const n of el.childNodes || []) {
      if (n.nodeType === 3) {
        const t = decodeEntities(n.text || n.rawText || '').replace(/\s+/g, ' ').trim();
        if (t.length >= 6) out.push(t);
      } else if (n.childNodes && n.childNodes.length) {
        walk(n);
      }
    }
  };
  walk(card);
  return out;
}

function addressCandidates(card, withTextNodes) {
  const cands = [];
  for (const h of card.querySelectorAll('h1,h2,h3,h4,h5')) cands.push(cleanText(h));
  for (const e of card.querySelectorAll('*')) {
    const cls = (e.getAttribute && e.getAttribute('class')) || '';
    if (/address|street|location|prop.*title|property.*title|displayaddress/i.test(cls)) cands.push(cleanText(e));
  }
  if (withTextNodes) for (const t of cardTextNodes(card)) cands.push(t); // bare text-node addresses
  for (const a of card.querySelectorAll('a')) cands.push(cleanText(a));
  for (const img of card.querySelectorAll('img')) {
    const alt = img.getAttribute && img.getAttribute('alt');
    if (alt) cands.push(decodeEntities(alt));
  }
  return cands;
}
// Strip listing-tier badges / ALL-CAPS marketing prefixes that agents wedge in
// front of the real address, e.g. "** SIGNATURE HOMES ** Cory Drive" or
// "★ GUIDE PRICE ★ Cory Drive" or "NEW INSTRUCTION - Cory Drive". A real address
// starts with a house number or a Title-Case street word, never an ALL-CAPS badge.
function stripBadges(s) {
  let a = String(s || '')
    .replace(/[*★☆■◆●♦▪▶◀«»|]+/g, ' ')      // decorative symbols → space
    .replace(/\s+/g, ' ')
    .trim();
  // "BADGE - address" / "BADGE: address" where BADGE is an ALL-CAPS marketing run
  const sep = a.match(/^(.*?)\s[-–—:]\s+(.+)$/);
  if (sep && /[A-Z]{2}/.test(sep[1]) && !/[a-z]/.test(sep[1])) a = sep[2];
  // leading ALL-CAPS words before a Title-Case street word (≥1 word)…
  a = a.replace(/^(?:[A-Z][A-Z&'.\-]{1,}\s+){1,6}(?=[A-Z][a-z])/, '');
  // …or before a house number (≥2 words, so legit "FLAT 3"/"UNIT 5" are kept)
  a = a.replace(/^(?:[A-Z][A-Z&'.\-]{1,}\s+){2,6}(?=\d)/, '');
  return a.replace(/\s+/g, ' ').trim();
}

function firstAddress(cands) {
  for (const c of cands) {
    const cleaned = stripBadges(c);
    if (isAddress(cleaned)) return cleaned;
  }
  return null;
}
// Full extractor (text-node aware) — used to fill the address FIELD.
function pickAddress(card) {
  if (!card || !card.querySelectorAll) return null;
  return firstAddress(addressCandidates(card, true));
}
// Element-only — used for card-BOUNDARY detection. Critical: adding text-node
// scanning to boundary detection shrank card scopes and excluded the beds
// element (WN Properties 12/12 → 0/23 regression). Boundaries must stay on the
// pre-existing element-only signal so the text-node change is purely additive.
function pickAddressStrict(card) {
  if (!card || !card.querySelectorAll) return null;
  return firstAddress(addressCandidates(card, false));
}

// The tightest price-bearing leaf elements (a card can hold several nested
// nodes with the price string; keep only the innermost one).
function priceElements(root) {
  const out = [];
  for (const el of root.querySelectorAll('*')) {
    const t = cleanText(el);
    if (t.length > 45 || !extractPrice(t)) continue;
    const childHasPrice = (el.childNodes || []).some(
      (c) => isElement(c) && extractPrice(cleanText(c))
    );
    if (!childHasPrice) out.push(el);
  }
  return out;
}

// Walk up from a price node to the smallest ancestor that also holds a real
// link AND an address — that ancestor is the listing card. Link-anchored
// detection (the old approach) missed sites whose card URLs don't match a
// known pattern; price-anchoring is markup-agnostic.
function cardFromPrice(priceEl) {
  let el = priceEl;
  let best = null;
  for (let d = 0; el && d < 7; d++) {
    const t = cleanText(el);
    if (t.length > 12000) break; // backstop only; isMultiCardContainer is the real stop
    if (el !== priceEl && isMultiCardContainer(el, t)) break; // stop before merging listings
    const links = el.querySelectorAll ? el.querySelectorAll('a') : [];
    const hasLink = links.some((a) => !isNavHref(a.getAttribute && a.getAttribute('href')));
    const hasAddr = !!pickAddressStrict(el);
    if (el !== priceEl && hasLink && hasAddr) return el;
    if (hasLink || hasAddr) best = el;
    el = el.parentNode;
  }
  return best;
}

function listingUrl(card, base) {
  if (!card || !card.querySelectorAll) return null;
  const hrefs = card
    .querySelectorAll('a')
    .map((a) => a.getAttribute && a.getAttribute('href'))
    .filter((h) => h && !isNavHref(h));
  const host = (() => {
    try {
      return new URL(base).host;
    } catch {
      return '';
    }
  })();
  let pick =
    hrefs.find((h) => LISTING_HREF.test(h)) ||
    hrefs.find((h) => {
      try {
        return new URL(h, base).host === host;
      } catch {
        return false;
      }
    }) ||
    hrefs[0];
  if (!pick) return null;
  try {
    return new URL(pick, base).href.split('#')[0];
  } catch {
    return null;
  }
}

// Link-anchored card: climb from a property-detail <a> to the smallest
// ancestor that also has an address (and ideally a price). Complements
// price-anchoring so sites whose price isn't in a tidy leaf are still found.
function cardFromLink(anchor) {
  let el = anchor;
  let best = null;
  for (let d = 0; el && d < 6; d++) {
    const t = cleanText(el);
    if (t.length > 12000) break; // backstop only; isMultiCardContainer is the real stop
    if (el !== anchor && isMultiCardContainer(el, t)) break; // stop before merging listings
    const hasAddr = !!pickAddressStrict(el);
    const hasPrice = !!extractPrice(t);
    if (el !== anchor && hasAddr && hasPrice) return el;
    if (hasAddr || hasPrice) best = el;
    el = el.parentNode;
  }
  return best;
}

// "Sold / Let Agreed / Under Offer" — but ONLY from a dedicated status element
// or a small card, never from a large card scope (which bleeds a page-wide
// badge into every listing — the Parabar bug).
function statusUnavailable(card) {
  if (!card || !card.querySelectorAll) return false;
  for (const e of [card, ...card.querySelectorAll('*')]) {
    const cls = (e.getAttribute && e.getAttribute('class')) || '';
    if (/status|ribbon|flag|availab|badge|banner|\btag\b|sticker|overlay|label/i.test(cls)) {
      if (UNAVAILABLE.test(cleanText(e))) return true;
    }
  }
  const ct = cleanText(card);
  return ct.length < 300 && UNAVAILABLE.test(ct);
}

function buildListing(card, base) {
  const ct = cleanText(card);
  const price = extractPrice(ct);
  const url = listingUrl(card, base);
  const address = pickAddress(card);
  const beds = extractBeds(card);
  const unavailable = statusUnavailable(card);
  return { address, price, beds, url, unavailable, full: !!(price && beds != null && address && url) };
}
const fieldScore = (l) => (l.price ? 1 : 0) + (l.beds != null ? 1 : 0) + (l.address ? 1 : 0) + (l.url ? 1 : 0);

// Collect candidate card elements from BOTH price anchors and listing-link
// anchors, then keep the richest listing per unique url/address.
function collectCards(root) {
  const cards = new Set();
  for (const pe of priceElements(root)) {
    const c = cardFromPrice(pe);
    if (c) cards.add(c);
  }
  for (const a of root.querySelectorAll('a')) {
    const href = a.getAttribute && a.getAttribute('href');
    if (href && LISTING_HREF.test(href)) {
      const c = cardFromLink(a);
      if (c) cards.add(c);
    }
  }
  return cards;
}

function extractListings(html, baseUrl) {
  const root = parseHTML(html);
  const byKey = new Map();
  for (const card of collectCards(root)) {
    const l = buildListing(card, baseUrl);
    if (!l.price && !l.url) continue; // junk
    const key = l.url || `${l.price}|${l.address || ''}`;
    const prev = byKey.get(key);
    if (!prev || fieldScore(l) > fieldScore(prev)) byKey.set(key, l);
  }
  const all = [...byKey.values()];
  const available = all.filter((l) => !l.unavailable);
  // Safety net: if EVERY candidate is flagged unavailable, that's a shared
  // page badge bleeding into scope, not a page of 100% sold stock — keep them.
  if (all.length >= 2 && available.length === 0) return { listings: all, dropped: 0 };
  return { listings: available, dropped: all.length - available.length };
}

// Which element/branch made a card look unavailable — so a --dump reveals
// whether "Let Agreed" is the card's OWN status or bleeding in from scope.
function unavailableEvidence(card) {
  if (!card || !card.querySelectorAll) return null;
  for (const e of [card, ...card.querySelectorAll('*')]) {
    const cls = (e.getAttribute && e.getAttribute('class')) || '';
    if (/status|ribbon|flag|availab|badge|banner|\btag\b|sticker|overlay|label/i.test(cls)) {
      const m = cleanText(e).match(UNAVAILABLE);
      if (m) return `status-el <${(e.rawTagName || '?').toLowerCase()} class="${cls}">: "${m[0]}"`;
    }
  }
  const ct = cleanText(card);
  const m = ct.length < 300 && ct.match(UNAVAILABLE);
  return m ? `small-card(${ct.length}c) text match: "${m[0]}"` : null;
}

// Diagnostic: per-card HTML + what the parser extracted. Used by --dump so the
// exact markup of a failing site can be inspected without live access. Images
// are collapsed (their srcset/data URIs otherwise eat the whole budget and hide
// the beds markup), and status-match provenance is included.
function debugCards(html, baseUrl) {
  const root = parseHTML(html);
  const out = [];
  for (const card of collectCards(root)) {
    const l = buildListing(card, baseUrl);
    const raw = (card.outerHTML || card.toString() || '')
      .replace(/<img\b[^>]*>/gi, '<img>')                       // drop srcset/src noise
      .replace(/<(svg)\b[^>]*>[\s\S]*?<\/svg>/gi, '<svg/>')     // collapse inline svg (keep marker)
      .replace(/\s+(style|srcset|data-[\w-]+)="[^"]*"/gi, '')   // drop noisy attrs
      .replace(/\s+/g, ' ')
      .trim();
    const parent = card.parentNode;
    out.push({
      ...l,
      evidence: unavailableEvidence(card),
      parent: parent ? `<${(parent.rawTagName || '?').toLowerCase()} class="${(parent.getAttribute && parent.getAttribute('class')) || ''}">` : null,
      html: raw.slice(0, 1800),
    });
  }
  return out;
}

const CHALLENGE =
  /just a moment|attention required|cf-browser-verification|challenge-platform|enable javascript and cookies|checking your browser|cf_chl_/i;

function analyse(html, baseUrl) {
  if (!html) return { ok: false, listings: [], full: 0, count: 0, dropped: 0, phone: null, hint: 'empty body' };
  const flat = html.replace(/\s+/g, ' ');
  const phone = (flat.match(/\b0(?:1\d{3}|2\d)\s?\d{3}\s?\d{3,4}\b/) || [])[0] || null;
  const { listings, dropped } = extractListings(html, baseUrl);
  const count = listings.length;
  // Only treat as a challenge if we found NOTHING — a rendered page with
  // listings can still contain "enable javascript" in a cookie/noscript banner.
  if (count === 0 && CHALLENGE.test(flat))
    return { ok: false, listings: [], full: 0, count: 0, dropped, phone, hint: 'anti-bot challenge page' };

  const full = listings.filter((l) => l.full).length;
  const ok = full >= MIN_FULL;
  const sample = (listings.find((l) => l.full) || listings[0] || {}).address;
  let hint = `${full}/${count} full cards`;
  if (sample) hint += ` · ${sample.slice(0, 38)}`;
  if (count > full && full < MIN_FULL) {
    const noBeds = listings.filter((l) => l.price && l.address && l.beds == null).length;
    if (noBeds) hint += ` (${noBeds} missing beds)`;
  }
  if (dropped) hint += ` [${dropped} sold/agreed skipped]`;
  return { ok, listings, full, count, dropped, phone, hint };
}

// Find the site's "properties for sale" / search page from a homepage, so we
// can follow to it when the homepage itself carries too few listing cards.
function discoverListingsUrl(html, base) {
  const root = parseHTML(html);
  const host = (() => {
    try {
      return new URL(base).host;
    } catch {
      return '';
    }
  })();
  let best = null;
  let bestScore = 0;
  for (const a of root.querySelectorAll('a')) {
    const href = a.getAttribute && a.getAttribute('href');
    if (isNavHref(href)) continue;
    let u;
    try {
      u = new URL(href, base);
    } catch {
      continue;
    }
    if (host && u.host && u.host !== host) continue; // same site only
    const path = u.pathname.toLowerCase();
    const txt = cleanText(a).toLowerCase();
    let s = 0;
    if (/for-?sale/.test(path)) s += 5;
    if (/properties?\.aspx|search\.aspx/.test(path)) s += 4;
    if (/\/properties?\b|property-search|propertysearch|\/search\b|\/buy\b|\/sales?\b|to-?let|lettings?/.test(path)) s += 3;
    if (/for sale|properties for sale|our properties|view properties|search|buy|browse/.test(txt)) s += 2;
    if (path === '/' || path === '') s = 0;
    if (s > bestScore) {
      bestScore = s;
      best = u.href.split('#')[0];
    }
  }
  return bestScore >= 3 ? best : null;
}

// ── Tier classification ──────────────────────────────────────────────────────
// ULTRA_GREEN: 3+ full listings · GREEN: 1–2 · AMBER: 0 full but context · RED: nothing
export function classifyTier(analysis, meta = {}) {
  const full = (analysis && analysis.full) || 0;
  if (full >= 3) return 'ULTRA_GREEN';
  if (full >= 1) return 'GREEN';
  const hasContext = !!(meta.company || meta.location || meta.phone);
  return hasContext ? 'AMBER' : 'RED';
}

// Contact number: prefer a tel: link, else a UK-format number in the page text.
export function extractPhone(html) {
  const s = String(html || '');
  const tel = s.match(/href=["']tel:([+\d][\d\s()-]{7,})["']/i);
  if (tel) return normalisePhone(tel[1]);
  const text = s.replace(/<[^>]+>/g, ' ');
  const m = text.match(/(\+44\s?\(?0?\)?[\d\s-]{9,13}|\b0\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}\b)/);
  return m ? normalisePhone(m[1]) : '';
}
function normalisePhone(p) {
  return String(p).replace(/[^\d+]/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 20);
}

export {
  analyse, extractListings, discoverListingsUrl, debugCards,
  isAddress, extractPrice, extractBeds, isUnavailable, statusUnavailable, cleanText, stripBadges,
};
