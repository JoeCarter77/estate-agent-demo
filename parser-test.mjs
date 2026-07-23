import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseHTML } from 'node-html-parser';
// Parse an HTML fragment and return its outer card element (for extractBeds).
const parseCard = (html) => parseHTML(html).querySelector('div,tr,article,section,li');

// Set BEFORE importing so the module's main() is suppressed regardless of how
// this test is launched (npm test, `node parser-test.mjs`, an IDE runner, …).
process.env.IS_IMPORTED_FOR_TEST = '1';
const { analyse, discoverListingsUrl, runScrape, tD, extractBeds, _loadParser } = await import('./scraper-bench.mjs');

await _loadParser();
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✘ FAIL: ${name}  ${detail}`); }
}

// ---- 1. Bed markup variants (the Tyler/Henton/HS/CDC "missing beds" bug) ----
console.log('\n[1] bed-markup variants');

const iconBeds = `<div class="prop"><a href="/property-for-sale-oak-road-pi-hent1.htm"><h3 class="address">Oak Road, Billericay</h3></a>
  <span class="price">£450,000</span>
  <ul class="stats"><li><i class="icon-bed"></i> 3</li><li><i class="icon-bath"></i> 2</li></ul></div>`.repeat(1);
const iconBedsPage = `<html><body>${iconBeds.replace('hent1','hent1').replace('Oak Road','Oak Road')}
  <div class="prop"><a href="/property-for-sale-elm-close-pi-hent2.htm"><h3 class="address">Elm Close, Billericay</h3></a><span class="price">£525,000</span><ul><li><i class="fa-bed"></i> 4</li></ul></div>
  <div class="prop"><a href="/property-for-sale-ash-way-pi-hent3.htm"><h3 class="address">Ash Way, Billericay</h3></a><span class="price">£615,000</span><ul><li><i class="icon-bed"></i> 5</li></ul></div>
  </body></html>`;
let r = analyse(iconBedsPage, 'https://www.hentonkirkman.co.uk/');
check('icon+number beds parse (no "bed" text)', r.full === 3, `got full=${r.full}/${r.count} beds=${r.listings.map(l=>l.beds)}`);

const classBeds = `<html><body>
  <div class="card"><a href="/property/1-a"><span class="displayaddress">1 The Mews, Brentwood</span></a><div class="price">£400,000</div><span class="bedrooms">2</span></div>
  <div class="card"><a href="/property/2-b"><span class="displayaddress">2 The Mews, Brentwood</span></a><div class="price">£410,000</div><span class="bedrooms">3</span></div>
  <div class="card"><a href="/property/3-c"><span class="displayaddress">3 The Mews, Brentwood</span></a><div class="price">£420,000</div><span class="bedrooms">4</span></div>
  </body></html>`;
r = analyse(classBeds, 'https://x.co.uk/');
check('class="bedrooms" number beds parse', r.full === 3, `full=${r.full} beds=${r.listings.map(l=>l.beds)}`);

const dataBeds = `<html><body>
  <article data-bedrooms="2"><a href="/p/1">12 High St, Shenfield</a><span class="price">£375,000</span></article>
  <article data-bedrooms="3"><a href="/p/2">14 High St, Shenfield</a><span class="price">£395,000</span></article>
  <article data-bedrooms="4"><a href="/p/3">16 High St, Shenfield</a><span class="price">£450,000</span></article>
  </body></html>`;
r = analyse(dataBeds, 'https://x.co.uk/');
check('data-bedrooms attribute beds parse', r.full === 3, `full=${r.full} beds=${r.listings.map(l=>l.beds)}`);

const textBeds = `<html><body>
  <div class="l"><a href="/property-details/1">Rose Lane, Chelmsford</a><span>£300,000</span><p>3 Bed semi-detached</p></div>
  <div class="l"><a href="/property-details/2">Tulip Way, Chelmsford</a><span>£320,000</span><p>2 Bedrooms</p></div>
  <div class="l"><a href="/property-details/3">Iris Close, Chelmsford</a><span>£340,000</span><p>Bedrooms: 4</p></div>
  </body></html>`;
r = analyse(textBeds, 'https://x.co.uk/');
check('text bed variants ("3 Bed"/"2 Bedrooms"/"Bedrooms: 4")', r.full === 3, `full=${r.full} beds=${r.listings.map(l=>l.beds)}`);

// ---- 2. Price-anchored extraction (the WN/Smooth/IPS 0/0 bug) ----
console.log('\n[2] price-anchored extraction of unusual card markup');
const unusualLinks = `<html><body><section id="featured">
  <div onclick="go()"><a class="thumb" href="/12345-oak-drive-billericay"><img alt="Oak Drive, Billericay"></a><div class="det"><h4>Oak Drive, Billericay</h4><strong>£499,950</strong><span>3 bed detached</span></div></div>
  <div><a href="/23456-elm-road-billericay"><img alt="Elm Road, Billericay"></a><div><h4>Elm Road, Billericay</h4><strong>£615,000</strong><span>4 bed</span></div></div>
  <div><a href="/34567-ash-grove-billericay"><img alt="Ash Grove, Billericay"></a><div><h4>Ash Grove, Billericay</h4><strong>£725,000</strong><span>5 bed</span></div></div>
  </section></body></html>`;
r = analyse(unusualLinks, 'https://www.wnproperties.co.uk/');
check('price-anchored cards w/ non-standard hrefs', r.full === 3, `full=${r.full}/${r.count}`);

// ---- 3. Sold / Let-Agreed filtering (the Parabar bug) ----
console.log('\n[3] sold / let-agreed filtering');
const withAgreed = `<html><body>
  <div class="card"><a href="/property-for-sale/a">Stock Road, Billericay</a><span class="price">£685,000</span><span>2 bed</span><span class="status">Let Agreed</span></div>
  <div class="card"><a href="/property-for-sale/b">Perry Street, Billericay</a><span class="price">£950,000</span><span>5 bed</span></div>
  <div class="card"><a href="/property-for-sale/c">Chapel Street, Billericay</a><span class="price">£499,995</span><span>3 bed</span><span>SSTC</span></div>
  <div class="card"><a href="/property-for-sale/d">Mill Lane, Billericay</a><span class="price">£800,000</span><span>4 bed</span></div>
  </body></html>`;
r = analyse(withAgreed, 'https://parabar.co.uk/');
const addrs = r.listings.map(l => l.address);
check('Let Agreed + SSTC excluded from results', r.dropped === 2 && !addrs.some(a => /Stock Road|Chapel Street/.test(a)), `dropped=${r.dropped} kept=${addrs}`);
check('available for-sale listings still counted', r.full === 2, `full=${r.full}`);

// ---- 4. Challenge false-positive (the Keith Ashton bug) ----
console.log('\n[4] challenge detection');
const challengeWithContent = `<html><body>
  <div class="cookie">Please enable JavaScript and cookies to continue</div>
  <div class="card"><a href="/property/1">1 Kings Road, Shenfield</a><span class="price">£550,000</span><span>3 bed</span></div>
  <div class="card"><a href="/property/2">2 Kings Road, Shenfield</a><span class="price">£560,000</span><span>4 bed</span></div>
  <div class="card"><a href="/property/3">3 Kings Road, Shenfield</a><span class="price">£570,000</span><span>2 bed</span></div>
  </body></html>`;
r = analyse(challengeWithContent, 'https://www.keithashton.co.uk/');
check('page w/ listings NOT flagged as challenge (false-positive fixed)', r.hint !== 'anti-bot challenge page' && r.full === 3, `hint="${r.hint}"`);

const realChallenge = `<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing. Enable JavaScript and cookies. cf-browser-verification</body></html>`;
r = analyse(realChallenge, 'https://x.co.uk/');
check('genuine challenge (0 cards) still flagged', r.hint === 'anti-bot challenge page');

// ---- 5. Listings-page discovery + follow (the WN/Smooth/IPS homepage bug) ----
console.log('\n[5] homepage → listings-page follow');
const homepage = `<html><body><nav><a href="/">Home</a><a href="/about">About</a><a href="/properties-for-sale">Properties For Sale</a><a href="/contact">Contact</a></nav>
  <h1>Welcome to WN Properties</h1><p>Call 01277 225191</p></body></html>`;
const listingsPage = `<html><body>
  <div class="card"><a href="/property/1">1 Oak Road, Shenfield</a><span class="price">£500,000</span><span>3 bed</span></div>
  <div class="card"><a href="/property/2">2 Oak Road, Shenfield</a><span class="price">£520,000</span><span>4 bed</span></div>
  <div class="card"><a href="/property/3">3 Oak Road, Shenfield</a><span class="price">£540,000</span><span>2 bed</span></div>
  </body></html>`;
check('discoverListingsUrl finds /properties-for-sale', discoverListingsUrl(homepage, 'https://www.wnproperties.co.uk/') === 'https://www.wnproperties.co.uk/properties-for-sale');

const stubTransport = async (url) => {
  if (url.endsWith('/properties-for-sale')) return { reachable: true, status: 200, ms: 5, html: listingsPage };
  return { reachable: true, status: 200, ms: 5, html: homepage };
};
r = await runScrape(stubTransport, 'https://www.wnproperties.co.uk/');
check('runScrape follows homepage → listings page', r.full === 3 && /followed/.test(r.hint), `full=${r.full} hint="${r.hint}"`);

// ---- 6. Method d (Playwright) actually runs ----
console.log('\n[6] Playwright transport (method d)');
const propPath = join(tmpdir(), 'novus-prop2.html');
writeFileSync(propPath, `<html><body>
  <div class="card"><a href="/property/1">1 Bench Way, Billericay</a><span class="price">£450,000</span><span>3 bed</span></div>
  <div class="card"><a href="/property/2">2 Bench Way, Billericay</a><span class="price">£470,000</span><span>4 bed</span></div>
  <div class="card"><a href="/property/3">3 Bench Way, Billericay</a><span class="price">£490,000</span><span>2 bed</span></div>
  </body></html>`);
const dres = await tD(pathToFileURL(propPath).href);
if (dres.status === 'SKIP') {
  console.log(`  ″ skipped (no browser): ${dres.hint}`);
} else {
  check('tD launches a real browser & returns HTML', dres.reachable && dres.html.includes('Bench Way'), `status=${dres.status} hint=${dres.hint || ''}`);
  const da = analyse(dres.html, 'https://x.co.uk/');
  check('method d rendered HTML extracts 3 full cards', da.full === 3, `full=${da.full}`);
}

// ---- 7. Regression fixtures for the three reported bugs ----
console.log('\n[7] reported-bug regressions');

// 7a. Parabar: a "Let Agreed" badge that lands in EVERY card's scope must not
//     wipe the whole page. When all candidates look unavailable, keep them.
const allAgreed = `<html><body><section class="results">
  <div class="card"><a href="/property-for-sale/1">Stock Road, Billericay</a><span class="price">£685,000</span><span>2 bed</span><div class="ribbon">Let Agreed</div></div>
  <div class="card"><a href="/property-for-sale/2">Perry Street, Billericay</a><span class="price">£950,000</span><span>5 bed</span><div class="ribbon">Let Agreed</div></div>
  <div class="card"><a href="/property-for-sale/3">Chapel Street, Billericay</a><span class="price">£499,995</span><span>3 bed</span><div class="ribbon">Let Agreed</div></div>
  </section></body></html>`;
r = analyse(allAgreed, 'https://parabar.co.uk/');
check('Parabar: all-flagged page kept, not wiped to 0/0', r.full === 3 && r.dropped === 0, `full=${r.full}/${r.count} dropped=${r.dropped}`);

// 7e. Charles David Casson: beds spelled out as "Three-Bedrooms …", no digit.
//     (real markup from their site — the qualifier-title label.)
const cdcCard = `<article id="17113949" class="component property property--grid">
  <div class="property__status"><span class="property__status-text">For Sale</span></div>
  <div class="property__image"><img src="/x.jpg" srcset="/x-320.jpg 320w"></div>
  <div class="property__content">
    <div class="label qualifier-title text-secondary text-transform-uppercase">Three-Bedrooms&nbsp;Terraced House</div>
    <h2 class="h3 text-primary">&pound;350,000</h2>
    <p class="property__content--address text-secondary">Dahlia Close, Chelmsford, CM1</p>
  </div>
  <a aria-label="property" href="https://www.charlesdavidcasson.co.uk/property/dahlia-close-springfield/" class="property__link"></a>
</article>`;
check('CDC: spelled-out "Three-Bedrooms" → beds=3', extractBeds(parseCard(cdcCard)) === 3, `got ${extractBeds(parseCard(cdcCard))}`);
const cdcPage = `<html><body>${cdcCard}${cdcCard.replace('Three-Bedrooms', 'Two-Bedrooms').replace('17113949', '2').replace('dahlia-close-springfield', 'p2').replace('Dahlia Close, Chelmsford, CM1', 'Pochard Way, Braintree, CM77')}${cdcCard.replace('Three-Bedrooms', 'Four-Bedrooms').replace('17113949', '3').replace('dahlia-close-springfield', 'p3').replace('Dahlia Close, Chelmsford, CM1', 'Elm Road, Chelmsford, CM2')}</body></html>`;
r = analyse(cdcPage, 'https://www.charlesdavidcasson.co.uk/');
check('CDC: full page of spelled-out beds → 3/3 full ("For Sale" not dropped)', r.full === 3 && r.dropped === 0, `full=${r.full}/${r.count} dropped=${r.dropped}`);

// 7f. Parabar: address is a BARE TEXT NODE loose in the card (no tag/class),
//     sitting between the </a> and the price span. (real markup.)
const parabarCard = (slug, sub, addr, price) =>
  `<div class="item"><div class="wppf_slider_title"><a href="https://parabar.co.uk/property/${slug}/"><div class="wppf_subhead">${sub}&nbsp;</div></a> ${addr} <span class="up-price">${price}</span></div></div>`;
const parabarPage = `<html><body><div class="wppf-carousel">
  ${parabarCard('st-lawrence-road-upminster', 'For Sale 2 Bed House - Terraced', 'St. Lawrence Road, Upminster', 'Asking Price &pound;575,000')}
  ${parabarCard('tawny-avenue-upminster', 'For Sale 5 Bed House - Semi-Detached', 'Tawny Avenue, Upminster', 'Asking Price &pound;1,250,000')}
  ${parabarCard('chapel-street-billericay-4', 'For Sale 5 Bed House - Semi-Detached', 'Chapel Street, Billericay', 'Offers Over &pound;950,000')}
  </div></body></html>`;
r = analyse(parabarPage, 'https://parabar.co.uk/');
check('Parabar: bare text-node address → 3/3 full cards', r.full === 3, `full=${r.full}/${r.count} addrs=${JSON.stringify(r.listings.map(l => l.address))}`);

// 7g. WN Properties regression: a tighter inner element holds the link + a bare
//     text-node address, while BEDS live in a sibling OUTSIDE it. Boundary
//     detection must not shrink to the inner element (which would drop beds) —
//     the text-node address change must be additive. (models the 12/12 → 0/23 break.)
const wnRegression = (slug, addr, price, beds) =>
  `<div class="listing"><div class="wrap"><a href="/property-for-sale/${slug}/"><img alt=""></a> ${addr} <span class="price">${price}</span></div><div class="meta">${beds}</div></div>`;
const wnPage = `<html><body><div class="results">
  ${wnRegression('oak-road', 'Oak Road, Shenfield', '£400,000', '3 Bedrooms')}
  ${wnRegression('elm-avenue', 'Elm Avenue, Shenfield', '£450,000', '4 Bedrooms')}
  ${wnRegression('mill-lane', 'Mill Lane, Hutton', '£375,000', '2 Bedrooms')}
  </div></body></html>`;
r = analyse(wnPage, 'https://www.wnproperties.co.uk/');
check('WN: beds outside the text-node-address element still captured (no regression)', r.full === 3, `full=${r.full}/${r.count} beds=${JSON.stringify(r.listings.map(l => l.beds))}`);

// 7b. Bed icon as <img src=".../bedroom.svg"> with the number as a sibling.
const imgSrcBeds = `<div class="p"><a href="/property/1">Willow Way, Brentwood</a><span class="price">£425,000</span>
  <ul class="feat"><li><img src="/assets/icons/bedroom.svg" class="ico" alt=""> 3</li><li><img src="/assets/icons/bathroom.svg"> 2</li></ul></div>`;
check('beds via <img src=bedroom.svg> + sibling number', extractBeds(parseCard(imgSrcBeds)) === 3, `got ${extractBeds(parseCard(imgSrcBeds))}`);

// 7c. Bed icon as an SVG sprite <use href="#icon-bed"> with the number as a sibling.
const svgUseBeds = `<div class="p"><a href="/property/1">Cedar Close, Chelmsford</a><span class="price">£560,000</span>
  <span class="stat"><svg><use xlink:href="#icon-bed"></use></svg> 4</span></div>`;
check('beds via <svg><use href=#icon-bed> + sibling number', extractBeds(parseCard(svgUseBeds)) === 4, `got ${extractBeds(parseCard(svgUseBeds))}`);

// 7d. IPS: a grid/table where every row has a price+link must NOT collapse into
//     one card. Expect one card per row.
const gridPage = `<html><body><table class="listings">
  <tr class="row"><td><a href="/property-details/1">1 Elm Grove, Chelmsford</a></td><td class="price">£300,000</td><td>2 bed</td></tr>
  <tr class="row"><td><a href="/property-details/2">2 Elm Grove, Chelmsford</a></td><td class="price">£320,000</td><td>3 bed</td></tr>
  <tr class="row"><td><a href="/property-details/3">3 Elm Grove, Chelmsford</a></td><td class="price">£340,000</td><td>4 bed</td></tr>
  <tr class="row"><td><a href="/property-details/4">4 Elm Grove, Chelmsford</a></td><td class="price">£360,000</td><td>2 bed</td></tr>
  </table></body></html>`;
r = analyse(gridPage, 'https://ipschelmsford.co.uk/');
check('IPS: grid of 4 rows → 4 cards (not collapsed to 1)', r.count === 4 && r.full === 4, `full=${r.full}/${r.count}`);

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
