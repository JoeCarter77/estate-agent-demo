// Scope the personalised demo stylesheet to .demo-page.
//
// WHY THIS EXISTS: demo.css legitimately needs to restyle the page from the
// ground up — it redefines tokens tokens.css owns (--ink, --blue, --hair…),
// sets global element rules (*, html, body, p, h1/h2, a, img) and reuses
// generic class names the public site also uses (.frame, .eyebrow, .wordmark,
// .skip). Loaded anywhere near site/index.html, any one of those would restyle
// the homepage. Rather than rely on "demo.html is the only page that links it",
// every selector is mechanically prefixed with .demo-page, which is set on
// <html> in demo.html and nowhere else.
//
//   node scripts/novus-demo-scope-css.mjs           → build
//   node scripts/novus-demo-scope-css.mjs --check   → verify committed output
import { readFile, writeFile } from 'node:fs/promises';

const SCOPE = '.demo-page';
const SRC = new URL('../site/assets/css/demo.src.css', import.meta.url);
const OUT = new URL('../site/assets/css/demo.css', import.meta.url);

// A selector already rooted at the scope, or an at-rule keyframe step, is left
// alone. Everything else is rewritten to sit under .demo-page.
function scopeSelector(sel) {
  const s = sel.trim();
  if (!s || s.startsWith('@') || /^\d/.test(s) || s === 'from' || s === 'to') return s;
  if (s === ':root' || s === 'html') return `html${SCOPE}`;
  if (s.startsWith('html')) return `html${SCOPE}${s.slice(4)}`;
  return `${SCOPE} ${s}`;
}

function scopeCss(css) {
  let out = '', i = 0, depth = 0;
  let inKeyframes = 0;
  while (i < css.length) {
    // pass comments through untouched
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2);
      const stop = end === -1 ? css.length : end + 2;
      out += css.slice(i, stop); i = stop; continue;
    }
    const nextBrace = css.indexOf('{', i);
    const nextClose = css.indexOf('}', i);
    if (nextBrace === -1 && nextClose === -1) { out += css.slice(i); break; }
    if (nextClose !== -1 && (nextBrace === -1 || nextClose < nextBrace)) {
      out += css.slice(i, nextClose + 1); i = nextClose + 1;
      depth--; if (inKeyframes && depth < inKeyframes) inKeyframes = 0;
      continue;
    }
    const raw = css.slice(i, nextBrace);
    const prelude = raw.trim();
    if (prelude.startsWith('@')) {
      // at-rules keep their prelude; their contents are scoped as normal, except
      // keyframe steps (0%, from, to) which are not selectors at all.
      if (/^@keyframes/i.test(prelude)) inKeyframes = depth + 1;
      out += raw + '{';
    } else if (inKeyframes) {
      out += raw + '{';
    } else {
      let comments = '', sel = raw;
      sel = sel.replace(/\/\*[\s\S]*?\*\//g, (m) => { comments += m; return ''; });
      const lead = sel.slice(0, sel.length - sel.trimStart().length);
      const body = sel.trim();
      out += lead.replace(/[^\n]/g, '') + comments + (comments ? '\n' : '') +
             body.split(',').map(scopeSelector).join(',') + '{';
    }
    i = nextBrace + 1; depth++;
  }
  return out;
}

const src = await readFile(SRC, 'utf8');
const built = `/* GENERATED — do not edit. Source: demo.src.css
   Built by scripts/novus-demo-scope-css.mjs; every selector is scoped to
   ${SCOPE} so this stylesheet can never restyle the public site. */\n` + scopeCss(src);

if (process.argv.includes('--check')) {
  const current = await readFile(OUT, 'utf8');
  if (current !== built) {
    console.error('demo.css is out of date — run: node scripts/novus-demo-scope-css.mjs');
    process.exit(1);
  }
  console.log('demo.css scoping: up to date.');
} else {
  await writeFile(OUT, built);
  console.log(`demo.css scoped to ${SCOPE} (${built.length} bytes).`);
}
