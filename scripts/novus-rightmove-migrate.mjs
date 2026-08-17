// scripts/novus-rightmove-migrate.mjs — CLI driver for the Rightmove migration.
//
// Reads the Rightmove research as CSV and POSTs it to
// /api/novus/admin?resource=rightmove-migrate on the deployed NOVUS instance,
// which is the only place with Google Sheets write access (keyless WIF — see
// lib/sheets.mjs). Nothing is written unless you pass --apply.
//
// (Routed through the consolidated api/novus/admin.js dispatcher, not a
// standalone /api/novus/admin/rightmove-migrate file — see that file's header
// comment: Vercel Hobby's 12-serverless-function limit.)
//
// Why CSV and not .xlsx: this project deliberately carries almost no
// dependencies, and adding an XLSX parser for a one-off import isn't worth it.
// Export the Rightmove sheet as CSV first:
//   In the workbook:  File → Download → Comma-separated values (.csv)
//   Or:  python3 -c "import openpyxl,csv,sys; ws=openpyxl.load_workbook(sys.argv[1]).active; w=csv.writer(open(sys.argv[2],'w',newline='')); [w.writerow(['' if c is None else c for c in r]) for r in ws.iter_rows(values_only=True)]" in.xlsx out.csv
//
// Usage:
//   node scripts/novus-rightmove-migrate.mjs --file rightmove.csv                 # dry run
//   node scripts/novus-rightmove-migrate.mjs --file rightmove.csv --apply         # writes
//   node scripts/novus-rightmove-migrate.mjs --file rightmove.csv --sheet-tab 2   # pick a tab's CSV
//
// Env:
//   NOVUS_BASE_URL         e.g. https://estate-agent-demo.vercel.app
//   NOVUS_BASIC_AUTH_USER  the internal /api/novus credential
//   NOVUS_BASIC_AUTH_PASS

import fs from 'node:fs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

// ── Minimal RFC-4180 CSV parser (quotes, escaped quotes, embedded newlines) ───
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = String(text).replace(/^﻿/, ''); // strip BOM

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  // Drop trailing all-empty rows.
  while (rows.length && rows[rows.length - 1].every((c) => String(c).trim() === '')) rows.pop();
  if (!rows.length) return { headers: [], rows: [] };

  const headers = rows[0].map((h) => String(h).trim());
  const out = [];
  for (const r of rows.slice(1)) {
    if (r.every((c) => String(c).trim() === '')) continue;
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = String(r[idx] ?? '').trim(); });
    out.push(obj);
  }
  return { headers, rows: out };
}

async function main() {
  const file = arg('file');
  if (!file) {
    console.error('Missing --file <path-to-csv>');
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    console.error(`No such file: ${file}`);
    process.exit(2);
  }

  const base = (process.env.NOVUS_BASE_URL || '').replace(/\/+$/, '');
  const user = process.env.NOVUS_BASIC_AUTH_USER;
  const pass = process.env.NOVUS_BASIC_AUTH_PASS;
  if (!base || !user || !pass) {
    console.error('Set NOVUS_BASE_URL, NOVUS_BASIC_AUTH_USER and NOVUS_BASIC_AUTH_PASS.');
    process.exit(2);
  }

  const { headers, rows } = parseCsv(fs.readFileSync(file, 'utf8'));
  if (!rows.length) {
    console.error('CSV contained no data rows.');
    process.exit(2);
  }

  const apply = has('apply');
  console.log(`Source: ${file}`);
  console.log(`Headers: ${headers.join(', ')}`);
  console.log(`Data rows: ${rows.length}`);
  console.log(apply ? '\n*** APPLY MODE — this WILL write to the live sheet ***\n' : '\nDRY RUN (pass --apply to write)\n');

  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  const res = await fetch(`${base}/api/novus/admin?resource=rightmove-migrate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify({ rows, dry_run: !apply }),
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 2000) }; }

  if (!res.ok) {
    console.error(`Request failed (${res.status}):`);
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log('Header map:', JSON.stringify(data.header_map, null, 2));
  console.log('\n── REPORT ──');
  console.log(JSON.stringify(data.report, null, 2));

  const r = data.report || {};
  console.log('\n── SUMMARY ──');
  console.log(`matched agencies      : ${r.matched}`);
  console.log(`URLs migrated         : ${r.urls_migrated}`);
  console.log(`URLs rejected (generic): ${r.urls_rejected}`);
  console.log(`confirmed             : ${r.status_counts?.confirmed ?? 0}`);
  console.log(`candidate             : ${r.status_counts?.candidate ?? 0}`);
  console.log(`unresolved            : ${r.status_counts?.unresolved ?? 0}`);
  console.log(`not_applicable        : ${r.status_counts?.not_applicable ?? 0}`);
  console.log(`rows ${apply ? 'written' : 'that would change'}: ${r.rows_written}`);
  console.log(`rows already correct  : ${r.rows_unchanged}`);
  console.log(`unmatched agency_ids  : ${r.unmatched_count}`);
  if (r.unmatched_agency_ids?.length) console.log(`  ${r.unmatched_agency_ids.join(', ')}`);
  if (r.errors?.length) {
    console.log('\nERRORS:');
    console.log(JSON.stringify(r.errors, null, 2));
    process.exit(1);
  }
}

// Only run when invoked directly (so parseCsv can be imported by the self-test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
