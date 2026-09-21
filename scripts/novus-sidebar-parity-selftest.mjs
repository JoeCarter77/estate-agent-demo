#!/usr/bin/env node
// scripts/novus-sidebar-parity-selftest.mjs — hermetic parity guard for the
// NOVUS sidebar (novus/operator.html vs novus/calling.html vs
// novus/campaigns.html).
//
// The Calling workspace deliberately reuses operator.html's exact sidebar
// markup (same items, same order, same groups, same badge ids) rather than
// maintaining its own copy — the two diverged once already (missing Future /
// Analytics / Exceptions, invented badges, "NOVUS CALLING" branding, and
// links to /novus/operator and /novus/calling missing the .html Vercel needs
// to serve them, which 404'd). This test reads both files' real <nav> markup
// and fails the moment either page's list of items, order, groups, badge ids
// or hrefs drifts from the canonical shape, or a bare (non-.html) operator/
// calling link reappears.
//
// No network, no DOM — plain string/regex parsing of the two static files.
//
// Run:  npm run novus:sidebar-parity-selftest

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OPERATOR_HTML = fs.readFileSync(path.join(ROOT, '..', 'novus', 'operator.html'), 'utf8');
const CALLING_HTML = fs.readFileSync(path.join(ROOT, '..', 'novus', 'calling.html'), 'utf8');
const CAMPAIGNS_HTML = fs.readFileSync(path.join(ROOT, '..', 'novus', 'campaigns.html'), 'utf8');
const MEETINGS_HTML = fs.readFileSync(path.join(ROOT, '..', 'novus', 'meetings.html'), 'utf8');

let passed = 0;
const ok = (msg) => { passed += 1; console.log(`  ✓ ${msg}`); };

// The canonical sidebar this task fixed both pages to match. Order matters.
const CANONICAL = [
  { group: null, key: 'overview', label: 'Overview', badge: null },
  { group: null, key: 'actions', label: 'Actions', badge: 'b-actions' },
  { group: null, key: 'future', label: 'Future', badge: 'b-future' },
  { group: null, key: 'pipeline', label: 'Pipeline', badge: null },
  { group: null, key: 'prober', label: 'Prober', badge: 'b-prober' },
  { group: null, key: 'leads', label: 'Leads', badge: 'b-leads' },
  { group: null, key: 'analytics', label: 'Analytics', badge: null },
  { group: 'Email', key: 'campaigns', label: 'Campaigns', badge: null },
  { group: 'Email', key: 'new-campaign', label: 'New Campaign', badge: null },
  { group: 'Calling', key: 'calling', label: 'Calling', badge: null },
  { group: 'Calling', key: 'call-actions', label: 'Call Actions', badge: null },
  { group: 'Calling', key: 'scripts', label: 'Scripts', badge: null },
  { group: 'Calling', key: 'calling-analytics', label: 'Calling Analytics', badge: null },
  { group: 'Meetings', key: 'meetings', label: 'Meetings', badge: null },
  { group: 'System', key: 'exceptions', label: 'Exceptions', badge: 'b-exceptions' },
  { group: 'System', key: 'communications', label: 'Communications', badge: null },
];
// Which items are this page's OWN tabs (data-view buttons) vs. links back to
// the other workspace — the one legitimate structural difference between the
// two pages.
const OPERATOR_OWN = new Set(['overview', 'actions', 'future', 'pipeline', 'prober', 'leads', 'analytics', 'exceptions']);
const CALLING_OWN = new Set(['calling', 'call-actions', 'scripts', 'calling-analytics']);
const CAMPAIGNS_OWN = new Set(['campaigns', 'new-campaign']);
const MEETINGS_OWN = new Set(['meetings']);

function parseNav(html, file) {
  const navMatch = html.match(/<nav class="nav">([\s\S]*?)<\/nav>/);
  assert.ok(navMatch, `${file}: no <nav class="nav"> block found`);
  const nav = navMatch[1];

  const subMatch = nav.match(/<div class="nav-sub">([^<]*)<\/div>/);
  const navSub = subMatch ? subMatch[1].trim() : null;

  // Walk the nav top-to-bottom, tracking which nav-label group we're under.
  const tokenRe = /<div class="nav-label">([^<]*)<\/div>|<(a|button) class="nav-item"([^>]*)>([\s\S]*?)<\/\2>/g;
  let group = null;
  const items = [];
  let m;
  while ((m = tokenRe.exec(nav))) {
    if (m[1] !== undefined) { group = m[1].trim(); continue; }
    const tag = m[2];
    const attrs = m[3];
    const inner = m[4];
    const hrefMatch = attrs.match(/href="([^"]*)"/);
    const dataViewMatch = attrs.match(/data-view="([^"]*)"/);
    const spans = [...inner.matchAll(/<span(\s[^>]*)?>([^<]*)<\/span>/g)];
    const labelSpan = spans.find((s) => !/class="nav-badge/.test(s[1] || ''));
    const badgeSpan = spans.find((s) => /class="nav-badge/.test(s[1] || ''));
    const badgeIdMatch = badgeSpan ? (badgeSpan[1] || '').match(/id="([^"]*)"/) : null;
    items.push({
      group, tag, href: hrefMatch ? hrefMatch[1] : null, dataView: dataViewMatch ? dataViewMatch[1] : null,
      label: labelSpan ? labelSpan[2].trim() : null, badgeId: badgeIdMatch ? badgeIdMatch[1] : null,
    });
  }
  return { navSub, items };
}

const operator = parseNav(OPERATOR_HTML, 'operator.html');
const calling = parseNav(CALLING_HTML, 'calling.html');
const campaigns = parseNav(CAMPAIGNS_HTML, 'campaigns.html');
const meetings = parseNav(MEETINGS_HTML, 'meetings.html');
const PAGES = [['operator.html', operator], ['calling.html', calling], ['campaigns.html', campaigns], ['meetings.html', meetings]];

console.log('\nBranding');
assert.equal(operator.navSub, 'Acquisition');
assert.equal(calling.navSub, 'Acquisition', 'calling.html must keep the same "NOVUS / Acquisition" branding as operator.html, never "NOVUS CALLING"');
assert.equal(campaigns.navSub, 'Acquisition');
assert.equal(meetings.navSub, 'Acquisition');
ok('all four pages carry the same NOVUS / Acquisition sidebar branding');

console.log('\nItem list, order, groups and badges');
for (const [name, parsed] of PAGES) {
  assert.equal(parsed.items.length, CANONICAL.length, `${name}: expected ${CANONICAL.length} sidebar items, found ${parsed.items.length}`);
  CANONICAL.forEach((expected, i) => {
    const got = parsed.items[i];
    assert.ok(got, `${name}: missing item at position ${i} (${expected.label})`);
    assert.equal(got.label, expected.label, `${name}: position ${i} expected "${expected.label}", got "${got.label}"`);
    assert.equal(got.group, expected.group, `${name}: "${expected.label}" expected group ${expected.group}, got ${got.group}`);
    assert.equal(got.badgeId, expected.badge, `${name}: "${expected.label}" expected badge id ${expected.badge}, got ${got.badgeId}`);
  });
}
ok('operator.html, calling.html, campaigns.html and meetings.html carry the identical item list, order, groups and badges');

console.log('\nWhich items are this page\'s own tabs vs. links to the other workspace');
function checkOwnership(name, parsed, ownKeys) {
  for (const expected of CANONICAL) {
    const got = parsed.items.find((it) => it.label === expected.label);
    const isOwn = ownKeys.has(expected.key);
    if (isOwn) {
      assert.equal(got.tag, 'button', `${name}: "${expected.label}" is this page's own tab and must be a data-view button, not a link`);
      assert.equal(got.dataView, expected.key, `${name}: "${expected.label}" data-view must be "${expected.key}"`);
    } else {
      assert.equal(got.tag, 'a', `${name}: "${expected.label}" must link elsewhere (not this page's own tab)`);
      assert.ok(got.href, `${name}: "${expected.label}" has no href`);
    }
  }
}
checkOwnership('operator.html', operator, OPERATOR_OWN);
checkOwnership('calling.html', calling, CALLING_OWN);
checkOwnership('campaigns.html', campaigns, CAMPAIGNS_OWN);
checkOwnership('meetings.html', meetings, MEETINGS_OWN);
ok('each page renders its own tabs as active buttons and everything else as a link elsewhere');

console.log('\nEvery cross-page link resolves to a real file, never a bare route Vercel has no rewrite for');
for (const [name, parsed] of PAGES) {
  for (const item of parsed.items) {
    if (item.tag !== 'a') continue;
    assert.ok(
      item.href.startsWith('/novus/operator.html#') || item.href === '/novus/communications.html' || item.href.startsWith('/novus/calling.html#') || item.href.startsWith('/novus/campaigns.html#') || item.href.startsWith('/novus/meetings.html#'),
      `${name}: "${item.label}" links to "${item.href}", which is not an explicit .html target`,
    );
  }
}
// Guard against the exact regression this task fixed: no bare (non-.html)
// operator/calling route anywhere in either file, sidebar or otherwise.
for (const [name, html] of [['operator.html', OPERATOR_HTML], ['calling.html', CALLING_HTML], ['campaigns.html', CAMPAIGNS_HTML], ['meetings.html', MEETINGS_HTML]]) {
  assert.ok(!/\/novus\/operator#/.test(html), `${name}: found a bare /novus/operator# link — Vercel has no rewrite for /novus/operator, only operator.html, so this 404s`);
  assert.ok(!/\/novus\/calling#/.test(html), `${name}: found a bare /novus/calling# link`);
  assert.ok(!/\/novus\/campaigns#/.test(html), `${name}: found a bare /novus/campaigns# link`);
  assert.ok(!/\/novus\/meetings#/.test(html), `${name}: found a bare /novus/meetings# link`);
}
ok('every link between the workspaces uses the real .html file, so none of them 404 on Vercel');

console.log('\nActive-view hashes line up with each page\'s own routing');
// operator.html's own VIEWS array and calling.html's own VIEWS array are the
// routing source of truth; the hrefs pointing at each page must use exactly
// those hash names (inspected, not guessed).
const operatorViews = OPERATOR_HTML.match(/const VIEWS = \[([^\]]+)\]/)[1].match(/'[a-z-]+'/g).map((s) => s.slice(1, -1));
const callingViews = CALLING_HTML.match(/const VIEWS = \[([^\]]+)\]/)[1].match(/'[a-z-]+'/g).map((s) => s.slice(1, -1));
for (const item of calling.items.filter((it) => it.tag === 'a' && it.href.startsWith('/novus/operator.html#'))) {
  const hash = item.href.split('#')[1];
  assert.ok(operatorViews.includes(hash), `calling.html: "${item.label}" links to operator.html#${hash}, which is not one of operator.html's own VIEWS (${operatorViews.join(', ')})`);
}
for (const item of [...operator.items, ...campaigns.items, ...meetings.items].filter((it) => it.tag === 'a' && it.href.startsWith('/novus/calling.html#'))) {
  const hash = item.href.split('#')[1];
  assert.ok(callingViews.includes(hash), `"${item.label}" links to calling.html#${hash}, which is not one of calling.html's own VIEWS (${callingViews.join(', ')})`);
}
for (const item of [...campaigns.items, ...meetings.items].filter((it) => it.tag === 'a' && it.href.startsWith('/novus/operator.html#'))) {
  const hash = item.href.split('#')[1];
  assert.ok(operatorViews.includes(hash), `"${item.label}" links to operator.html#${hash}, which is not one of operator.html's own VIEWS`);
}
// campaigns.html routes on #campaigns / #new / #campaign?id=; the other two
// pages must link only to hashes it recognises.
const campaignsHashes = new Set(['campaigns', 'new']);
for (const item of [...operator.items, ...calling.items, ...meetings.items].filter((it) => it.tag === 'a' && it.href.startsWith('/novus/campaigns.html#'))) {
  const hash = item.href.split('#')[1];
  assert.ok(campaignsHashes.has(hash), `"${item.label}" links to campaigns.html#${hash}, which campaigns.html does not route`);
}
// meetings.html routes on #meetings / #discovery?id= / #start?agency=.
for (const item of [...operator.items, ...calling.items, ...campaigns.items].filter((it) => it.tag === 'a' && it.href.startsWith('/novus/meetings.html#'))) {
  const hash = item.href.split('#')[1];
  assert.equal(hash, 'meetings', `"${item.label}" links to meetings.html#${hash}, which meetings.html does not route`);
}
ok('every cross-page link\'s hash matches a route the target page actually recognises');

console.log(`\n✅ Sidebar parity self-test passed (${passed} checks).\n`);
