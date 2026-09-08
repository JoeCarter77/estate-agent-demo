// The personalised demo must never be able to restyle the public site.
//
// demo.css redefines design tokens tokens.css owns (--ink, --blue, --hair…),
// sets global element rules, and reuses generic class names the site also uses
// (.frame, .eyebrow, .wordmark, .skip). This test does not merely check that
// site/index.html omits the stylesheet — it FORCE-LOADS demo.css into the live
// homepage and asserts that nothing about the rendering changes. If the scoping
// in scripts/novus-demo-scope-css.mjs ever regresses, this fails.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';

const base = process.env.NOVUS_SITE_URL || 'http://localhost:4310';
const out = '/tmp/novus-demo-qa'; await mkdir(out, { recursive: true });
const demoCss = await readFile(new URL('../site/assets/css/demo.css', import.meta.url), 'utf8');

// The demo shell must be the only thing that opts in.
const homepage = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
assert.ok(!/demo\.css|assets\/js\/demo\.js/.test(homepage), 'the homepage must not reference demo assets');
assert.ok(!/demo-page/.test(homepage), 'the homepage must not carry the demo scope class');

// Every selector in the built stylesheet is scoped.
for (const line of demoCss.split('\n')) {
  const m = line.match(/^([^@\s/{][^{]*)\{/);
  if (!m) continue;
  for (const sel of m[1].split(',')) {
    const s = sel.trim();
    if (!s || /^\d|^from$|^to$/.test(s)) continue;
    assert.ok(s.startsWith('.demo-page') || s.startsWith('html.demo-page'),
      'unscoped selector in demo.css: ' + s);
  }
}
console.log('demo.css: every selector scoped, homepage references none of it.');

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const probe = () => ({
  ink: getComputedStyle(document.documentElement).getPropertyValue('--ink').trim(),
  blue: getComputedStyle(document.documentElement).getPropertyValue('--blue').trim(),
  hair: getComputedStyle(document.documentElement).getPropertyValue('--hair').trim(),
  bodyFont: getComputedStyle(document.body).fontFamily,
  bodyBg: getComputedStyle(document.body).backgroundColor,
  bodyMargin: getComputedStyle(document.body).margin,
  boxSizing: getComputedStyle(document.body).boxSizing,
  scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
  nodes: [...document.querySelectorAll('h1,h2,h3,p,a,img,.frame,.eyebrow,.wordmark')]
    .slice(0, 90).map(el => {
      const c = getComputedStyle(el), r = el.getBoundingClientRect();
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height),
              c.fontSize, c.fontFamily.split(',')[0], c.color, c.letterSpacing].join('|');
    }),
  docWidth: document.documentElement.scrollWidth,
  docHeight: document.documentElement.scrollHeight,
});

try {
  for (const [name, width, height] of [['desktop',1440,900],['wide',1920,1080],['mobile',390,844],['small',320,740]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/');
    await page.evaluate(() => document.fonts.ready);
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
    await page.waitForTimeout(700);
    const before = await page.evaluate(probe);
    await page.screenshot({ path: `${out}/site-${name}-before.png` });

    // force the demo stylesheet onto the homepage
    await page.addStyleTag({ content: demoCss });
    await page.waitForTimeout(400);
    const after = await page.evaluate(probe);
    await page.screenshot({ path: `${out}/site-${name}-after.png` });

    assert.deepEqual(after, before, `${name}: demo.css changed the homepage`);
    assert.ok(before.docWidth <= width, `${name}: homepage overflows`);
    assert.deepEqual(errors, [], `${name}: homepage JS errors`);
    await page.close();
    console.log(`homepage ${name} (${width}x${height}): unchanged with demo.css force-loaded, no overflow, no JS errors`);
  }
} finally { await browser.close(); }
