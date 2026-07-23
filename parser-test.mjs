import { analyse, discoverListingsUrl, runScrape, tD, _loadParser } from './scraper-bench.mjs';
import { writeFileSync } from 'node:fs';

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
writeFileSync('/tmp/prop2.html', `<html><body>
  <div class="card"><a href="/property/1">1 Bench Way, Billericay</a><span class="price">£450,000</span><span>3 bed</span></div>
  <div class="card"><a href="/property/2">2 Bench Way, Billericay</a><span class="price">£470,000</span><span>4 bed</span></div>
  <div class="card"><a href="/property/3">3 Bench Way, Billericay</a><span class="price">£490,000</span><span>2 bed</span></div>
  </body></html>`);
const dres = await tD('file:///tmp/prop2.html');
if (dres.status === 'SKIP') {
  console.log(`  ″ skipped (no browser): ${dres.hint}`);
} else {
  check('tD launches a real browser & returns HTML', dres.reachable && dres.html.includes('Bench Way'), `status=${dres.status} hint=${dres.hint || ''}`);
  const da = analyse(dres.html, 'https://x.co.uk/');
  check('method d rendered HTML extracts 3 full cards', da.full === 3, `full=${da.full}`);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
