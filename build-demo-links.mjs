// build-demo-links.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Turns the lead sheet into a per-lead demo URL.
//
// Routing rule (the whole point of this script):
//   • Grade A / B / C  →  the GROWTH page   (?s=growth&grade=<A|B|C>&…)
//   • Grade D / E / blank / anything else  →  the CORE page (existing behaviour)
//
// The frontend (index.html) already consumes these params. This script is just
// the mail-merge that decides which variant each lead is sent to, driven by the
// `Grade` column you're adding to the sheet.
//
// It is tolerant: if the `Grade` column doesn't exist yet, every lead is routed
// to Core and a warning is printed — so it's safe to wire up now and light up
// the moment you add grades.
//
// Usage:
//   node build-demo-links.mjs                      # reads agent_leads_with_slugs.csv,
//                                                  # writes agent_leads_with_links.csv
//   node build-demo-links.mjs --stdout             # print URLs, don't write a file
//   node build-demo-links.mjs --in leads.csv --out out.csv
//   node build-demo-links.mjs --base https://demo.trynovus.co.uk
//   DEMO_BASE_URL=https://demo.trynovus.co.uk node build-demo-links.mjs
//
// npm: `npm run links`
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync } from 'node:fs';

// ── config ──
function argFlag(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const IN_FILE  = argFlag('--in')  || 'agent_leads_with_slugs.csv';
const OUT_FILE = argFlag('--out') || 'agent_leads_with_links.csv';
const TO_STDOUT = process.argv.includes('--stdout');

// Root where index.html is served. Override with --base or DEMO_BASE_URL.
const DEFAULT_BASE = 'https://trynovus.co.uk';
const BASE_URL = (process.env.DEMO_BASE_URL || argFlag('--base') || DEFAULT_BASE).replace(/\/+$/, '');
const USING_DEFAULT_BASE = !(process.env.DEMO_BASE_URL || argFlag('--base'));

// Grades that qualify for the Growth variant.
const GROWTH_GRADES = new Set(['A', 'B', 'C']);

// Sheet column → URL param. Base params are sent for every lead.
const BASE_COLS = {
  'Firm':       'company',
  'Website':    'url',
  'First Name': 'first_name',
};
// Extra params that only matter to the Growth variant. Any of these columns that
// exist in the sheet are passed through (see the brief's "new sheet columns").
// Missing columns are simply skipped — the Growth page already omits the proof
// line / relabels module one when a field isn't present.
const GROWTH_COLS = {
  'valuation_url': 'valuation_url',
  'property':      'property',
  'probe_time':    'probe_time',
  'probe_day':     'probe_day',
  'contact_name':  'contact_name',
  'ack_seconds':   'ack_seconds',
  'human_lag':     'human_lag',
  'days_since':    'days_since',
};

// ── minimal RFC-4180 CSV parse / stringify (handles quoted commas & newlines) ──
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* ignore */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCSV(rows) { return rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n'; }

// case-insensitive header lookup
function findCol(header, name) {
  const target = name.toLowerCase();
  return header.findIndex(h => h.trim().toLowerCase() === target);
}
function normalizeGrade(raw) {
  // Tolerate "A" / "a" / "Grade A" / "grade b - good" → "A" / "B"
  return (raw || '').trim().toUpperCase().replace(/^GRADE\s+/, '').charAt(0);
}

function buildUrl(get, grade) {
  const params = new URLSearchParams();
  for (const [col, param] of Object.entries(BASE_COLS)) {
    const v = get(col);
    if (v) params.set(param, v.trim());
  }
  const isGrowth = GROWTH_GRADES.has(grade);
  if (isGrowth) {
    params.set('s', 'growth');
    params.set('grade', grade);
    for (const [col, param] of Object.entries(GROWTH_COLS)) {
      const v = get(col);
      if (v && v.trim()) params.set(param, v.trim());
    }
  }
  return { url: `${BASE_URL}/?${params.toString()}`, variant: isGrowth ? 'growth' : 'core' };
}

// ── run ──
const raw = readFileSync(IN_FILE, 'utf8');
const rows = parseCSV(raw).filter(r => r.length && r.some(c => c !== ''));
if (!rows.length) { console.error(`No rows in ${IN_FILE}`); process.exit(1); }

const header = rows[0];
const gradeIdx = findCol(header, 'Grade');
if (gradeIdx === -1) {
  console.warn('⚠  No "Grade" column found — routing every lead to Core.');
  console.warn('   Add a "Grade" column (A/B/C → Growth, D/E/blank → Core) and re-run.');
}

const counts = { core: 0, growth: 0, A: 0, B: 0, C: 0, D: 0, E: 0, other: 0 };
const outRows = [header.concat(['Variant', 'Demo URL'])];

for (let r = 1; r < rows.length; r++) {
  const row = rows[r];
  const get = (colName) => { const i = findCol(header, colName); return i === -1 ? '' : (row[i] ?? ''); };
  const grade = gradeIdx === -1 ? '' : normalizeGrade(row[gradeIdx]);
  const { url, variant } = buildUrl(get, grade);

  counts[variant]++;
  if (['A', 'B', 'C', 'D', 'E'].includes(grade)) counts[grade]++;
  else if (grade) counts.other++;

  if (TO_STDOUT) console.log(`${(get('Slug') || get('Firm') || 'lead').padEnd(28)} ${variant.padEnd(7)} ${url}`);
  outRows.push(row.concat([variant, url]));
}

if (!TO_STDOUT) {
  writeFileSync(OUT_FILE, toCSV(outRows));
  console.log(`Wrote ${outRows.length - 1} links → ${OUT_FILE}`);
}
console.log(`Base URL: ${BASE_URL}${USING_DEFAULT_BASE ? '  (default — set DEMO_BASE_URL or --base to the demo deploy root)' : ''}`);
console.log(`Routed:   ${counts.growth} growth  ·  ${counts.core} core`);
console.log(`Grades:   A=${counts.A} B=${counts.B} C=${counts.C} D=${counts.D} E=${counts.E}${counts.other ? ` other=${counts.other}` : ''}`);
