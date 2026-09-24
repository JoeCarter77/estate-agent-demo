#!/usr/bin/env node
// scripts/novus-sidebar-parity-selftest.mjs — hermetic parity guard for the
// NOVUS sidebar (novus/operator.html, calling.html, campaigns.html,
// meetings.html).
//
// NAVIGATION CLEANUP (Sept 2026). The rail is ONE canonical list of
// destinations — Workspace (Dashboard, Actions, Leads), Acquisition (Email,
// Calling, Prober, Meetings), Management (Analytics, Team) and Settings in
// the pinned foot — copied verbatim into all four pages. Every item is a
// plain link keyed by data-nav. calling.html additionally carries the setter
// rail (Calling, My Actions, Leads, Meetings, My Performance), shown only to
// a SETTER account and pointing only at calling.html (the one page a setter
// may load, middleware.js).
//
// This test reads the four files' real <nav> markup and fails the moment
// any page's items, order, groups, badge ids or hrefs drift, a link points
// at a hash its target page does not route, a bare (non-.html) route
// reappears, or a URL that existed before the cleanup stops resolving.
//
// No network, no DOM — plain string/regex parsing of the static files.
//
// Run:  npm run novus:sidebar-parity-selftest

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(ROOT, '..', 'novus', f), 'utf8');
const HTML = {
  'operator.html': read('operator.html'),
  'calling.html': read('calling.html'),
  'campaigns.html': read('campaigns.html'),
  'meetings.html': read('meetings.html'),
};

let passed = 0;
const ok = (msg) => { passed += 1; console.log(`  ✓ ${msg}`); };

// The canonical admin rail. Order matters.
const CANONICAL = [
  { group: 'Workspace', key: 'dashboard', label: 'Dashboard', href: '/novus/operator.html#dashboard', badge: null },
  { group: 'Workspace', key: 'actions', label: 'Actions', href: '/novus/operator.html#actions', badge: 'b-actions' },
  { group: 'Workspace', key: 'leads', label: 'Leads', href: '/novus/operator.html#leads', badge: null },
  { group: 'Acquisition', key: 'email', label: 'Email', href: '/novus/operator.html#email', badge: 'b-email-actions' },
  { group: 'Acquisition', key: 'calling', label: 'Calling', href: '/novus/calling.html#calling', badge: 'b-calls' },
  { group: 'Acquisition', key: 'prober', label: 'Prober', href: '/novus/operator.html#prober', badge: 'b-prober' },
  { group: 'Acquisition', key: 'meetings', label: 'Meetings', href: '/novus/meetings.html#meetings', badge: null },
  { group: 'Management', key: 'analytics', label: 'Analytics', href: '/novus/operator.html#analytics', badge: null },
  { group: 'Management', key: 'team', label: 'Team', href: '/novus/calling.html#team', badge: null },
  { group: 'foot', key: 'settings', label: 'Settings', href: '/novus/operator.html#settings', badge: 'b-exceptions' },
];
const SETTER = [
  { key: 'calling', label: 'Calling', href: '/novus/calling.html#calling' },
  { key: 'my-actions', label: 'My Actions', href: '/novus/calling.html#call-actions' },
  { key: 'leads', label: 'Leads', href: '/novus/calling.html#leads' },
  { key: 'meetings', label: 'Meetings', href: '/novus/calling.html#meetings' },
  { key: 'my-performance', label: 'My Performance', href: '/novus/calling.html#sessions' },
];
// Destinations that are no longer first-level items. Their functionality is
// an internal tab now; the labels must not come back as rail items.
const RETIRED_LABELS = ['Overview', 'Future', 'Pipeline', 'Campaigns', 'New Campaign', 'Email Actions', 'Call Actions',
  'Scripts', 'Calling Analytics', 'Exceptions', 'Communications'];

function parseNav(html, file) {
  const navMatch = html.match(/<nav class="nav">([\s\S]*?)<\/nav>/);
  assert.ok(navMatch, `${file}: no <nav class="nav"> block found`);
  const nav = navMatch[1];
  const subMatch = nav.match(/<div class="nav-sub">([^<]*)<\/div>/);
  const tokenRe = /<div class="(nav-group(?: setter-nav)?|nav-foot)">|<div class="nav-label">([^<]*)<\/div>|<(a|button) class="nav-item([^"]*)"([^>]*)>([\s\S]*?)<\/\3>/g;
  let group = null; let setter = false;
  const items = [];
  let m;
  while ((m = tokenRe.exec(nav))) {
    if (m[1] !== undefined) { setter = m[1].includes('setter-nav'); group = m[1] === 'nav-foot' ? 'foot' : null; continue; }
    if (m[2] !== undefined) { group = m[2].trim(); continue; }
    const attrs = m[5]; const inner = m[6];
    const spans = [...inner.matchAll(/<span(\s[^>]*)?>([^<]*)<\/span>/g)];
    const labelSpan = spans.find((s) => !/class="nav-badge/.test(s[1] || ''));
    const badgeSpan = spans.find((s) => /class="nav-badge/.test(s[1] || ''));
    items.push({
      setter, group, tag: m[3], classes: m[4].trim(),
      key: (attrs.match(/data-nav="([^"]*)"/) || [])[1] || null,
      href: (attrs.match(/href="([^"]*)"/) || [])[1] || null,
      dataView: (attrs.match(/data-view="([^"]*)"/) || [])[1] || null,
      label: labelSpan ? labelSpan[2].trim() : null,
      badge: badgeSpan ? ((badgeSpan[1] || '').match(/id="([^"]*)"/) || [])[1] || null : null,
    });
  }
  return { navSub: subMatch ? subMatch[1].trim() : null, admin: items.filter((i) => !i.setter), setter: items.filter((i) => i.setter), raw: nav };
}

const NAVS = Object.fromEntries(Object.entries(HTML).map(([f, h]) => [f, parseNav(h, f)]));

console.log('\nBranding');
for (const [file, nav] of Object.entries(NAVS)) assert.equal(nav.navSub, 'Acquisition', `${file}: NOVUS / Acquisition branding`);
ok('all four pages carry the same NOVUS / Acquisition sidebar branding');

console.log('\nThe canonical admin rail');
for (const [file, nav] of Object.entries(NAVS)) {
  assert.equal(nav.admin.length, CANONICAL.length, `${file}: expected ${CANONICAL.length} admin rail items, found ${nav.admin.length}`);
  CANONICAL.forEach((want, i) => {
    const got = nav.admin[i];
    assert.equal(got.label, want.label, `${file}: position ${i} expected "${want.label}", got "${got.label}"`);
    assert.equal(got.group, want.group, `${file}: "${want.label}" expected group ${want.group}, got ${got.group}`);
    assert.equal(got.key, want.key, `${file}: "${want.label}" data-nav`);
    assert.equal(got.href, want.href, `${file}: "${want.label}" href`);
    assert.equal(got.badge, want.badge, `${file}: "${want.label}" badge id`);
    assert.equal(got.tag, 'a', `${file}: "${want.label}" is a plain link`);
    assert.equal(got.dataView, null, `${file}: "${want.label}" must not carry data-view (the rail names destinations, not views)`);
  });
  assert.ok(nav.admin.find((i) => i.key === 'settings').classes.includes('nav-admin'), `${file}: Settings is marked admin-only`);
}
ok('operator, calling, campaigns and meetings carry the identical rail: items, order, groups, hrefs and badges');
for (const [file, nav] of Object.entries(NAVS)) {
  for (const label of RETIRED_LABELS) assert.ok(!nav.admin.some((i) => i.label === label), `${file}: "${label}" is an internal tab now, not a rail item`);
}
ok('no retired destination (Overview, Future, Pipeline, Campaigns, New Campaign, Email Actions, Call Actions, Scripts, Calling Analytics, Exceptions) is back in the rail');
assert.ok(/class="nav-scroll"/.test(NAVS['operator.html'].raw), 'rail has its own scroll area');
ok('the rail middle scrolls independently; the foot (Settings, account, sign out) stays pinned');

console.log('\nThe setter rail (calling.html only)');
assert.deepEqual(NAVS['calling.html'].setter.map(({ key, label, href }) => ({ key, label, href })), SETTER);
for (const f of ['operator.html', 'campaigns.html', 'meetings.html']) assert.equal(NAVS[f].setter.length, 0, `${f}: no setter rail`);
const css = HTML['calling.html'];
assert.ok(/\.setter-nav \{ display:none; \}/.test(css) && /\.role-setter \.setter-nav \{ display:block; \}/.test(css), 'setter rail hidden unless role-setter');
assert.ok(/\.role-setter \.admin-nav, \.role-setter \.nav-admin/.test(css), 'admin rail and Settings hidden for a setter');
ok('calling.html carries the setter rail (Calling, My Actions, Leads, Meetings, My Performance), shown only to a setter, admin rail hidden from them');

console.log('\nEvery link resolves to a route its target page recognises');
const listOf = (html, name) => html.match(new RegExp(`const ${name} = \\[([^\\]]+)\\]`))[1].match(/'[a-z-]+'/g).map((s) => s.slice(1, -1));
const keysOf = (html, name) => [...html.match(new RegExp(`const ${name} = \\{([^}]+)\\}`))[1].matchAll(/([a-z-]+|'[a-z-]+')\s*:/g)].map((x) => x[1].replace(/'/g, ''));
const OPERATOR_ROUTES = new Set([...listOf(HTML['operator.html'], 'VIEWS'), ...keysOf(HTML['operator.html'], 'ROUTE_ALIAS')]);
const CALLING_ROUTES = new Set(listOf(HTML['calling.html'], 'VIEWS'));
const CAMPAIGN_ROUTES = new Set(['campaigns', 'new', 'new-campaign', 'campaign']);
const MEETING_ROUTES = new Set(['meetings', 'discovery', 'present', 'start']);
function resolves(href) {
  const [file, hash = ''] = href.split('#');
  const route = hash.split('?')[0];
  if (file === '/novus/operator.html') return OPERATOR_ROUTES.has(route);
  if (file === '/novus/calling.html') return CALLING_ROUTES.has(route);
  if (file === '/novus/campaigns.html') return CAMPAIGN_ROUTES.has(route);
  if (file === '/novus/meetings.html') return MEETING_ROUTES.has(route);
  if (file === '/novus/communications.html') return true;
  return false;
}
for (const [file, nav] of Object.entries(NAVS)) {
  for (const item of [...nav.admin, ...nav.setter]) assert.ok(resolves(item.href), `${file}: "${item.label}" → ${item.href} is not a route that page recognises`);
}
// Workspace tabs (static ones) must resolve too.
for (const [file, html] of Object.entries(HTML)) {
  for (const m of html.matchAll(/<a class="wstab(?: on)?" href="([^"]+)"/g)) {
    const href = m[1].startsWith('#') ? `/novus/${file}${m[1]}` : m[1];
    assert.ok(resolves(href), `${file}: workspace tab → ${m[1]} does not resolve`);
  }
}
for (const [file, html] of Object.entries(HTML)) {
  for (const bare of ['operator', 'calling', 'campaigns', 'meetings']) {
    assert.ok(!new RegExp(`/novus/${bare}#`).test(html), `${file}: bare /novus/${bare}# link — Vercel serves ${bare}.html, so this 404s`);
  }
}
ok('every rail item and workspace tab points at a real .html file and a hash that page routes');

console.log('\nURLs from before the cleanup still open the right place');
for (const legacy of ['overview', 'actions', 'email-actions', 'future', 'pipeline', 'prober', 'leads', 'analytics', 'exceptions']) {
  assert.ok(OPERATOR_ROUTES.has(legacy), `operator.html#${legacy} must still route`);
}
for (const legacy of ['calling', 'call-actions', 'scripts', 'calling-analytics']) assert.ok(CALLING_ROUTES.has(legacy), `calling.html#${legacy} must still route`);
const alias = HTML['operator.html'].match(/const ROUTE_ALIAS = \{([^}]+)\}/)[1];
assert.match(alias, /future:'actions'/); assert.match(alias, /settings:'exceptions'/); assert.match(alias, /email:'email-actions'/); assert.match(alias, /dashboard:'overview'/);
assert.match(HTML['operator.html'], /path\.toLowerCase\(\) === 'future' \? 'scheduled'/, '#future opens Actions › Scheduled');
ok('#overview, #future (→ Actions › Scheduled), #email-actions, #pipeline, #exceptions and every calling.html hash still resolve');

console.log('\nEach page highlights the destination its view belongs to');
for (const [file, html] of Object.entries(HTML)) assert.ok(/\.nav-item\[data-nav\]|el\.dataset\.nav/.test(html), `${file}: highlights by data-nav`);
ok('every page marks its active destination by data-nav');

console.log(`\n✅ Sidebar parity self-test passed (${passed} checks).\n`);
