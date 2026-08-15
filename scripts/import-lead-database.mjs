#!/usr/bin/env node
// scripts/import-lead-database.mjs — idempotent reconciliation import of the
// 144-agency source lead database into the LIVE NOVUS_Data_V1_Master_v2
// AGENCIES/PROBES tabs.
//
// Usage:
//   node scripts/import-lead-database.mjs                 dry run (default) — computes
//                                                           and prints the reconciliation
//                                                           report, writes nothing
//   node scripts/import-lead-database.mjs --apply          performs the writes for real
//   node scripts/import-lead-database.mjs --csv <path>     override the source CSV
//                                                           (default: data/lead-database-
//                                                           import/LEAD_DATABASE_1.csv)
//
// Requires the same env vars as every other NOVUS script talking to the live
// sheet (GCP_WORKLOAD_IDENTITY_AUDIENCE, GCP_SERVICE_ACCOUNT_EMAIL,
// NOVUS_SHEET_ID) — see .env.example. Only real inside a Vercel invocation
// (or wherever those credentials are actually available); this script does
// not itself provide any way around that.
//
// Safety:
//   - Never touches COMMUNICATIONS or INTELLIGENCE (evidence rule).
//   - Never deletes or blindly overwrites an existing AGENCIES/PROBES row —
//     a domain match only fills in fields that were previously blank.
//   - Idempotent: running twice performs zero duplicate writes the second
//     time (agencies matched by domain, probes matched by agency+timestamp).
//   - Every write is validated against the live sheet's actual header first
//     (assertRecordMatchesHeader) — an unknown column throws instead of
//     being silently dropped.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getRepo } from '../lib/sheets.mjs';
import {
  reconcileAgencies, buildHistoricalProbes, isSyntheticAgency,
  assertRecordMatchesHeader,
} from '../lib/lead-import.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CSV = resolve(__dirname, '../data/lead-database-import/LEAD_DATABASE_1.csv');

// ── Minimal RFC-4180-ish CSV parser (same shape as scripts/import-leads.mjs) ─
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* swallow */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v !== ''));
}

function loadSourceRows(csvPath) {
  const raw = readFileSync(csvPath, 'utf8');
  const rows = parseCSV(raw);
  const header = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

// ── Core import, decoupled from the CLI so tests can call it against a fake repo ─
export async function runImport(repo, sourceRows, { apply = false, now = () => new Date().toISOString() } = {}) {
  const nowIso = now();

  const [beforeAgencies, beforeProbes, beforeCommunications, beforeIntelligence, beforeActions] = await Promise.all([
    repo.getRecords('AGENCIES', 'agency_id'),
    repo.getRecords('PROBES', 'probe_id'),
    repo.getRecords('COMMUNICATIONS', 'communication_id').catch(() => []),
    repo.getRecords('INTELLIGENCE', 'intelligence_id').catch(() => []),
    repo.getRecords('ACTIONS', 'action_id').catch(() => []),
  ]);

  const syntheticAgencyIds = new Set(beforeAgencies.filter((r) => isSyntheticAgency(r.obj)).map((r) => r.obj.agency_id));

  const agencyResult = reconcileAgencies(beforeAgencies, sourceRows, { now: nowIso });
  const probeResult = buildHistoricalProbes(sourceRows, agencyResult.domainIndex, beforeProbes, syntheticAgencyIds, { now: nowIso });

  if (apply) {
    const { header: agenciesHeader } = await repo.getTable('AGENCIES');
    for (const record of agencyResult.toCreate) {
      const { _slug, ...row } = record;
      assertRecordMatchesHeader(agenciesHeader, row, 'AGENCIES');
      await repo.appendRecord('AGENCIES', row);
    }
    for (const { agency_id, patch } of agencyResult.toMerge) {
      assertRecordMatchesHeader(agenciesHeader, patch, 'AGENCIES');
      await repo.updateById('AGENCIES', 'agency_id', agency_id, patch);
    }

    const { header: probesHeader } = await repo.getTable('PROBES');
    for (const row of probeResult.toCreate) {
      assertRecordMatchesHeader(probesHeader, row, 'PROBES');
      await repo.appendRecord('PROBES', row);
    }
  }

  const [afterAgencies, afterProbes, afterCommunications, afterIntelligence, afterActions] = apply
    ? await Promise.all([
        repo.getRecords('AGENCIES', 'agency_id'),
        repo.getRecords('PROBES', 'probe_id'),
        repo.getRecords('COMMUNICATIONS', 'communication_id').catch(() => []),
        repo.getRecords('INTELLIGENCE', 'intelligence_id').catch(() => []),
        repo.getRecords('ACTIONS', 'action_id').catch(() => []),
      ])
    : [beforeAgencies, beforeProbes, beforeCommunications, beforeIntelligence, beforeActions];

  return {
    applied: apply,
    sourceCount: sourceRows.length,
    agencies: {
      imported: agencyResult.toCreate.length,
      alreadyExisting: agencyResult.alreadyExisting,
      merged: agencyResult.toMerge.length,
      ambiguousPhoneGroups: agencyResult.ambiguousPhoneGroups,
      skipped: agencyResult.skipped,
    },
    probes: {
      discovered: probeResult.discovered,
      imported: probeResult.toCreate.length,
      duplicatesAvoided: probeResult.duplicatesAvoided,
      skipped: probeResult.skipped,
    },
    preserved: {
      agenciesBefore: beforeAgencies.length, agenciesAfter: afterAgencies.length,
      probesBefore: beforeProbes.length, probesAfter: afterProbes.length,
      communicationsBefore: beforeCommunications.length, communicationsAfter: afterCommunications.length,
      intelligenceBefore: beforeIntelligence.length, intelligenceAfter: afterIntelligence.length,
      actionsBefore: beforeActions.length, actionsAfter: afterActions.length,
    },
  };
}

export function formatReport(r) {
  const lines = [];
  lines.push('=== NOVUS lead database reconciliation report ===');
  lines.push(r.applied ? '(APPLIED — writes were performed)' : '(DRY RUN — no writes were performed; re-run with --apply)');
  lines.push('');
  lines.push(`Source agencies: ${r.sourceCount}`);
  lines.push(`  imported (new agency_id assigned): ${r.agencies.imported}`);
  lines.push(`  already existing (matched by domain): ${r.agencies.alreadyExisting}`);
  lines.push(`  merged (blank fields filled on an existing row): ${r.agencies.merged}`);
  lines.push(`  flagged ambiguous (shared phone across different domains): ${r.agencies.ambiguousPhoneGroups.length} group(s)`);
  for (const g of r.agencies.ambiguousPhoneGroups) {
    lines.push(`    phone ${g.phone}: ${g.entries.map((e) => `${e.agency_id}(${e.domain}${e.slug !== '(existing)' ? `,slug=${e.slug}` : ''})`).join(' vs ')}`);
  }
  lines.push(`  skipped: ${r.agencies.skipped.length}`);
  for (const s of r.agencies.skipped) lines.push(`    ${s.slug}: ${s.reason}`);
  lines.push('');
  lines.push(`Historical probes discovered (non-blank "Probe Sent"): ${r.probes.discovered}`);
  lines.push(`  imported: ${r.probes.imported}`);
  lines.push(`  duplicate probes avoided: ${r.probes.duplicatesAvoided}`);
  lines.push(`  skipped: ${r.probes.skipped.length}`);
  for (const s of r.probes.skipped) lines.push(`    ${s.slug}: ${s.reason}`);
  lines.push('');
  lines.push('Existing NOVUS records preserved:');
  const p = r.preserved;
  lines.push(`  AGENCIES:       ${p.agenciesBefore} -> ${p.agenciesAfter}`);
  lines.push(`  PROBES:         ${p.probesBefore} -> ${p.probesAfter}`);
  lines.push(`  COMMUNICATIONS: ${p.communicationsBefore} -> ${p.communicationsAfter} (never written by this importer)`);
  lines.push(`  INTELLIGENCE:   ${p.intelligenceBefore} -> ${p.intelligenceAfter} (never written by this importer)`);
  lines.push(`  ACTIONS:        ${p.actionsBefore} -> ${p.actionsAfter} (never written by this importer)`);
  return lines.join('\n');
}

// ── CLI entrypoint ───────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const csvIdx = args.indexOf('--csv');
  const csvPath = csvIdx >= 0 ? resolve(process.cwd(), args[csvIdx + 1]) : DEFAULT_CSV;

  const sourceRows = loadSourceRows(csvPath);
  const repo = getRepo();
  const result = await runImport(repo, sourceRows, { apply });
  console.log(formatReport(result));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error('import-lead-database failed:', err);
    process.exit(1);
  });
}
