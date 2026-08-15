#!/usr/bin/env node
// scripts/import-agencies.mjs — load the scraped agency CSV into the AGENCIES tab.
//
//   node scripts/import-agencies.mjs --dry-run              # print what WOULD be written
//   node scripts/import-agencies.mjs --dry-run --json out.json
//   node scripts/import-agencies.mjs                        # write to the live workbook
//
// --dry-run needs no credentials and no network: it parses the CSV, builds the
// exact AGENCIES records, and reports the ambiguity that will affect matching.
// Run it first, every time.
//
// The live write path needs the same keyless WIF setup as every other Sheets
// call (see lib/sheets.mjs), which means a real VERCEL_OIDC_TOKEN — so in
// practice the live import runs from inside a Vercel invocation, exactly like
// scripts/novus-sheets-smoke.mjs. main() is exported for that purpose.
//
// IDEMPOTENT: agency_id is derived from the CSV slug, so an agency already in
// the sheet is UPDATED in place, never appended a second time. Re-running after
// editing the CSV is safe and is the intended way to refresh the data.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildAgencyRecords, findAmbiguousSignals } from '../lib/agency-import.mjs';
import { getRepo } from '../lib/sheets.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CSV = resolve(__dirname, '../agent_leads_with_slugs.csv');

export async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const csvArg = argv.find((a) => a.endsWith('.csv'));
  const jsonIdx = argv.indexOf('--json');
  const jsonOut = jsonIdx !== -1 ? argv[jsonIdx + 1] : '';
  const csvPath = csvArg ? resolve(process.cwd(), csvArg) : DEFAULT_CSV;

  const csvText = readFileSync(csvPath, 'utf8');
  const { records, skipped, duplicateSlugs } = buildAgencyRecords(csvText);

  console.log(`Parsed ${records.length} agencies from ${csvPath}`);
  if (skipped) console.log(`  ${skipped} row(s) skipped (no slug)`);
  if (duplicateSlugs.length) {
    console.log(`  ⚠ ${duplicateSlugs.length} duplicate slug(s) dropped: ${duplicateSlugs.join(', ')}`);
  }

  const withDomain = records.filter((r) => r.domain).length;
  const withPhone = records.filter((r) => r.main_phone).length;
  const withEmail = records.filter((r) => r.primary_contact_email).length;
  console.log(`\nMatching signal coverage (this is what decides whether replies match):`);
  console.log(`  domain           ${withDomain}/${records.length}`);
  console.log(`  main_phone       ${withPhone}/${records.length}`);
  console.log(`  contact email    ${withEmail}/${records.length}`);

  const { domains, phones } = findAmbiguousSignals(records);
  if (domains.length || phones.length) {
    console.log(`\n⚠ Signals shared by 2+ agencies — these will match as AMBIGUOUS (never wrongly attributed):`);
    for (const [d, ids] of domains) console.log(`  domain ${d}: ${ids.join(', ')}`);
    for (const [p, ids] of phones) console.log(`  phone  ${p}: ${ids.join(', ')}`);
  } else {
    console.log(`\n✓ No domain or phone is shared by two agencies.`);
  }

  const noSignal = records.filter((r) => !r.domain && !r.main_phone);
  if (noSignal.length) {
    console.log(`\n⚠ ${noSignal.length} agenc(ies) have NEITHER domain NOR phone — their replies can only be`);
    console.log(`  matched by the per-probe email address. Probe them last or fill the gap first:`);
    for (const r of noSignal.slice(0, 20)) console.log(`  ${r.agency_id}  ${r.agency_name}`);
  }

  if (jsonOut) {
    writeFileSync(resolve(process.cwd(), jsonOut), JSON.stringify(records, null, 2));
    console.log(`\nWrote ${records.length} records to ${jsonOut}`);
  }

  if (dryRun) {
    console.log('\n(dry run — nothing written to Google Sheets)');
    return { records, written: 0, updated: 0 };
  }

  const repo = getRepo();
  const existing = await repo.getRecords('AGENCIES', 'agency_id');
  const existingIds = new Set(existing.map((r) => r.obj.agency_id));

  let written = 0, updated = 0;
  for (const record of records) {
    if (existingIds.has(record.agency_id)) {
      // Preserve created_at and any human-entered qualification columns:
      // only overwrite what the CSV is authoritative for.
      const { created_at, current_pipeline_status, ...patch } = record;
      await repo.updateById('AGENCIES', 'agency_id', record.agency_id, patch);
      updated += 1;
    } else {
      await repo.appendRecord('AGENCIES', record);
      written += 1;
    }
  }

  console.log(`\n✅ AGENCIES import complete — ${written} appended, ${updated} updated in place.`);
  return { records, written, updated };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('\n❌ AGENCY IMPORT FAILED:\n', err); process.exit(1); });
}
