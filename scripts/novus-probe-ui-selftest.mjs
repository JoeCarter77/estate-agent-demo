// scripts/novus-probe-ui-selftest.mjs — browser-level E2E of the probe flow.
//
// Serves the REAL novus/probe.html and dispatches /api/novus/* to the REAL
// handlers, backed by an in-memory fake sheet. Verifies the parts a Node-only
// test cannot: the agency picker, the ?agency_id= / ?probe_id= deep links, and
// that the browser actually sends agency_id on create.
//
// No network, no credentials, no outreach — the seeded agency and property are
// synthetic and the enrichment fetcher is stubbed.
//
// Requires Playwright + a Chromium build (both optional in this project). If
// either is missing the test SKIPS with exit code 0 rather than failing, so it
// never breaks an environment that only runs the Node self-tests.
//
// Run:  npm run novus:probe-ui-selftest

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { __setListingMetaFetcherForTests } from '../lib/rightmove-meta.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Locate Playwright + a Chromium binary, or skip ───────────────────────────
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('\n  ⊘ SKIPPED — playwright is not installed (npm i playwright).\n');
  process.exit(0);
}

function findChromium() {
  const fromEnv = process.env.NOVUS_CHROMIUM_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base && fs.existsSync(base)) {
    for (const dir of fs.readdirSync(base)) {
      for (const rel of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = path.join(base, dir, rel);
        if (dir.startsWith('chromium') && !dir.includes('headless') && fs.existsSync(p)) return p;
      }
    }
  }
  return null; // fall back to Playwright's own resolution
}

process.env.NOVUS_BASIC_AUTH_USER = 'novus';
process.env.NOVUS_BASIC_AUTH_PASS = 'testpass';
process.env.NOVUS_PROBE_EMAIL = 'novusprobes@gmail.com';
process.env.NOVUS_PROBE_PHONE = '+447575333064';
process.env.NOVUS_INGEST_SECRET = 'secret';

const AGENCIES_HEADER = ['agency_id','agency_name','website','domain','location','branch_count','main_phone','known_phone_numbers','primary_contact_name','primary_contact_email','other_known_emails','owner_md','independent_franchise_corporate','sales_led_lettings_only','years_trading','incorporation_date','live_listing_count','crm_name','crm_evidence','qualification_segment','current_pipeline_status','suppression_status','suppression_reason','notes','created_at','updated_at','rightmove_sales_branch_url','rightmove_status','rightmove_checked_at','rightmove_notes'];
const PROBES_HEADER = ['probe_id','probe_reference','agency_id','portal','property_address','property_url','property_price','property_status','enquiry_text','probe_email','probe_phone','probe_timestamp','observation_deadline','probe_status','compromised','compromise_reason','observation_closed_at','sent_from','observation_notes','created_at','updated_at','property_type','property_bedrooms','property_id'];

const AG_ID = 'ag_hist_fisks-ltd-d8u5';
const PROFILE = 'https://www.rightmove.co.uk/estate-agents/agent/Fisks/Rayleigh-90210.html';
const PROP = 'https://www.rightmove.co.uk/properties/999000111';

const store = {
  AGENCIES: [AGENCIES_HEADER.slice(), AGENCIES_HEADER.map((k) => ({
    agency_id: AG_ID, agency_name: 'Fisks Ltd', domain: 'fisks.co.uk', location: 'Rayleigh',
    primary_contact_email: 'sales@fisks.co.uk',
    rightmove_sales_branch_url: PROFILE, rightmove_status: 'confirmed',
  }[k] ?? ''))],
  PROBES: [PROBES_HEADER.slice()],
  COMMUNICATIONS: [['communication_id','agency_id','probe_id','occurred_at','received_at','channel','direction','communication_type','provider','provider_event_id','source_identifier_raw','source_identifier_normalized','destination_identifier','subject','body_text','raw_content','raw_payload_reference','matching_method','match_score','match_status','human_contact','follow_up','manual_review_status','created_at','updated_at']],
  INTELLIGENCE: [['intelligence_id','agency_id','probe_id','observation_status','grade','grade_reason','created_at','updated_at']],
  ACTIONS: [['action_id','agency_id','probe_id','action_type','action_status','priority','due_at','completed_at','owner','trigger','reason','related_communication_id','notes','created_at','updated_at']],
  RAW_EVENTS: [['raw_event_id','provider','provider_event_id','channel','event_type','received_at','occurred_at','source_identifier','destination_identifier','payload_reference','processing_status','processed_communication_id','error_message','created_at']],
};
const tabOf = (r) => String(r).split('!')[0];
const startRowOf = (r) => { const m = String(r).match(/!\D+(\d+)/); return m ? parseInt(m[1], 10) : null; };
__setRepoForTests(createRepo({
  async get(r) { return (store[tabOf(r)] || []).map((x) => x.slice()); },
  async append(r, rows) { const t = tabOf(r); store[t] = store[t] || []; rows.forEach((x) => store[t].push(x.slice())); return {}; },
  async update(r, rows) { const t = tabOf(r); const s = startRowOf(r); rows.forEach((x, i) => { store[t][s - 1 + i] = x.slice(); }); return {}; },
}));
__setListingMetaFetcherForTests(async (u) => u === PROP ? {
  address: 'Test Road, Rayleigh, SS6 7AA', price: '£450,000', status: 'for_sale',
  property_type: 'semi-detached house', bedrooms: '3',
  title: '3 bedroom semi-detached house for sale in Test Road, Rayleigh, SS6 7AA',
} : { address: '', price: '', status: '', property_type: '', bedrooms: '', title: '' });

const handlers = {
  '/api/novus/probe-create': (await import(`${ROOT}/api/novus/probe-create.js`)).default,
  '/api/novus/probe-get': (await import(`${ROOT}/api/novus/probe-get.js`)).default,
  '/api/novus/probe-mark-sent': (await import(`${ROOT}/api/novus/probe-mark-sent.js`)).default,
  '/api/novus/agencies': (await import(`${ROOT}/api/novus/agencies.js`)).default,
  '/api/novus/action-create': (await import(`${ROOT}/api/novus/action-create.js`)).default,
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/novus/probe' || u.pathname === '/novus/probe.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(fs.readFileSync(path.join(ROOT, 'novus/probe.html')));
  }
  const h = handlers[u.pathname];
  if (!h) { res.writeHead(404); return res.end('nope'); }
  let body = '';
  for await (const c of req) body += c;
  const query = Object.fromEntries(u.searchParams);
  const fakeRes = {
    statusCode: 200, _headers: {},
    status(c) { this.statusCode = c; return this; },
    json(o) { res.writeHead(this.statusCode, { 'content-type': 'application/json', ...this._headers }); res.end(JSON.stringify(o)); return this; },
    end() { res.writeHead(this.statusCode, this._headers); res.end(); return this; },
    setHeader(k, v) { this._headers[k] = v; },
  };
  await h({ method: req.method, body: body ? JSON.parse(body) : {}, query, headers: req.headers }, fakeRes);
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const results = [];
const check = (name, cond, extra = '') => { results.push([cond ? 'PASS' : 'FAIL', name, extra]); };

const execPath = findChromium();
let browser;
try {
  browser = await chromium.launch(execPath ? { executablePath: execPath } : {});
} catch (e) {
  console.log('\n  ⊘ SKIPPED — no Chromium build available: ' + e.message.split('\n')[0] + '\n');
  server.close();
  process.exit(0);
}
const ctx = await browser.newContext({ httpCredentials: { username: 'novus', password: 'testpass' } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// Only genuine uncaught exceptions count. Deliberate 400s (the URL rejections
// under test) and the blocked Google Fonts preconnect are expected here.
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !/Failed to load resource/.test(t)) errors.push('console: ' + t);
});

// ── 1) Deep link with agency_id pre-selects the agency ───────────────────────
await page.goto(`${base}/novus/probe?agency_id=${AG_ID}`);
await page.waitForFunction(() => !document.getElementById('agency-chosen').classList.contains('hidden'), { timeout: 5000 });
check('deep link ?agency_id= pre-selects the agency',
  (await page.textContent('#chosen-name')).trim() === 'Fisks Ltd',
  await page.textContent('#chosen-name'));
check('agency_id shown in the chosen chip',
  (await page.textContent('#chosen-meta')).includes(AG_ID));
check('agency Rightmove profile offered as where to find a property',
  (await page.getAttribute('#agency-rm a', 'href')) === PROFILE);
check('property URL field enabled once an agency is chosen',
  !(await page.getAttribute('#url', 'disabled')));

// ── 2) Rejecting the agency profile URL as a property URL ────────────────────
await page.fill('#url', PROFILE);
await page.click('#create-btn');
await page.waitForSelector('#create-err.show', { timeout: 5000 });
check('pasting the AGENCY profile URL is rejected with a useful message',
  (await page.textContent('#create-err')).includes('agency’s Rightmove profile') ||
  (await page.textContent('#create-err')).includes("agency's Rightmove profile"),
  await page.textContent('#create-err'));

// ── 3) Area search URL rejected ──────────────────────────────────────────────
await page.fill('#url', 'https://www.rightmove.co.uk/property-for-sale/Rayleigh.html');
await page.click('#create-btn');
await page.waitForTimeout(400);
check('pasting an AREA SEARCH URL is rejected',
  (await page.textContent('#create-err')).includes('search'),
  await page.textContent('#create-err'));
check('no probe row written by the rejected attempts', store.PROBES.length === 1, `rows=${store.PROBES.length - 1}`);

// ── 4) Real property URL creates the probe with the agency attached ──────────
await page.fill('#url', PROP);
await page.click('#create-btn');
await page.waitForSelector('#view-ready:not(.hidden)', { timeout: 8000 });
check('probe created and PROBE READY shown', true);
check('agency NAME rendered (not the raw id)', (await page.textContent('#f-agency')).trim() === 'Fisks Ltd', await page.textContent('#f-agency'));
check('agency_id rendered on the probe', (await page.textContent('#f-agency-id')).trim() === AG_ID);
check('property address enriched', (await page.textContent('#f-address')).includes('Rayleigh'), await page.textContent('#f-address'));
check('property type + bedrooms enriched', (await page.textContent('#f-type')).trim() === '3 bed · semi-detached house', await page.textContent('#f-type'));
check('price enriched', (await page.textContent('#f-price')).includes('450,000'));
check('property URL stored is the normalised individual listing', (await page.textContent('#f-url')).trim() === PROP);
check('probe reference minted', /^RM-\d{4}$/.test((await page.textContent('#f-ref')).trim()), await page.textContent('#f-ref'));

const stored = store.PROBES[1];
check('PROBES row persisted with agency_id', stored[PROBES_HEADER.indexOf('agency_id')] === AG_ID);
check('PROBES row persisted with property_url', stored[PROBES_HEADER.indexOf('property_url')] === PROP);
check('PROBES row persisted with property_bedrooms', stored[PROBES_HEADER.indexOf('property_bedrooms')] === '3');

// ── 5) The address bar became a shareable probe deep link ────────────────────
const probeId = stored[PROBES_HEADER.indexOf('probe_id')];
const urlNow = page.url();
check('address bar now carries ?probe_id=', urlNow.includes(`probe_id=${probeId}`), urlNow);
check('address bar no longer carries ?agency_id=', !urlNow.includes('agency_id='), urlNow);

// ── 6) Reload the probe deep link — full rehydration ────────────────────────
await page.goto(`${base}/novus/probe?probe_id=${probeId}`);
await page.waitForSelector('#view-ready:not(.hidden)', { timeout: 8000 });
check('deep link ?probe_id= rehydrates the probe after reload', (await page.textContent('#f-agency-id')).trim() === AG_ID);
check('rehydrated view resolves the agency NAME', (await page.textContent('#f-agency')).trim() === 'Fisks Ltd');
check('rehydrated view keeps the property URL', (await page.textContent('#f-url')).trim() === PROP);

// ── 7) Mark as sent from the rehydrated deep link ───────────────────────────
await page.click('#sent-btn');
await page.waitForSelector('#observing-note:not(.hidden)', { timeout: 8000 });
check('mark-as-sent works from a rehydrated deep link',
  (await page.textContent('#status-text')).trim() === 'Observing');
check('observation window persisted', !!store.PROBES[1][PROBES_HEADER.indexOf('observation_deadline')]);
check('agency_id survived mark-as-sent', store.PROBES[1][PROBES_HEADER.indexOf('agency_id')] === AG_ID);

// ── 8) Agency picker search path ────────────────────────────────────────────
await page.goto(`${base}/novus/probe`);
await page.waitForSelector('#agency-search');
await page.fill('#agency-search', 'fisk');
await page.waitForSelector('#agency-results:not(.hidden) .res-item', { timeout: 5000 });
check('typing in the picker finds the agency', (await page.textContent('.res-item .res-name')).trim() === 'Fisks Ltd');
await page.click('.res-item');
await page.waitForFunction(() => !document.getElementById('agency-chosen').classList.contains('hidden'));
check('clicking a search result selects the agency', (await page.textContent('#chosen-name')).trim() === 'Fisks Ltd');

// ── 9) Second probe for the SAME agency (one agency → many probes) ──────────
await page.fill('#url', 'https://www.rightmove.co.uk/properties/999000222');
await page.click('#create-btn');
await page.waitForSelector('#view-ready:not(.hidden)', { timeout: 8000 });
check('a second probe for the same agency is created', store.PROBES.length === 3, `rows=${store.PROBES.length - 1}`);
check('both probes carry the same agency_id',
  store.PROBES[1][PROBES_HEADER.indexOf('agency_id')] === AG_ID && store.PROBES[2][PROBES_HEADER.indexOf('agency_id')] === AG_ID);
check('the two probes have distinct references',
  store.PROBES[1][PROBES_HEADER.indexOf('probe_reference')] !== store.PROBES[2][PROBES_HEADER.indexOf('probe_reference')],
  `${store.PROBES[1][1]} vs ${store.PROBES[2][1]}`);

// ── 10) "New probe" keeps the agency selected ───────────────────────────────
await page.click('#another-btn');
await page.waitForSelector('#view-new:not(.hidden)');
check('“+ New probe” keeps the agency selected', !(await page.locator('#agency-chosen').getAttribute('class')).includes('hidden'));
check('“+ New probe” puts agency_id back in the address bar', page.url().includes(`agency_id=${AG_ID}`), page.url());

check('no uncaught JavaScript exceptions anywhere in the flow', errors.length === 0, errors.join(' | '));

await browser.close();
server.close();

const fails = results.filter((r) => r[0] === 'FAIL');
for (const [st, name, extra] of results) console.log(`  ${st === 'PASS' ? '✓' : '✗'} ${name}${st === 'FAIL' && extra ? '\n      → ' + extra : ''}`);
console.log(`\n  ${results.length - fails.length} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
