#!/usr/bin/env node
// LIVE NEEDS_RESEARCH recheck against the DEPLOYED NOVUS application.
// No local Google credentials/WIF needed — this script only speaks HTTP to
// two EXISTING, unmodified-in-behaviour endpoints:
//
//   GET  /api/novus/contacts/resolution-backlog  (rewrite -> personalisation.js)
//   POST /api/novus/contacts/resolve              (rewrite -> personalisation.js)
//
// Target: exactly AGENCIES.contact_resolution_status == NEEDS_RESEARCH on a
// physical Google Sheets row > 180. sheet_row_number comes from the server's
// repo record metadata, not array position, agency order or timestamps.
//
// The script only decides which agency_id to POST next, one per call, exactly
// the endpoint's
// existing one-agency-per-call contract. The 3-call Hunter Verifier cap per
// agency is enforced inside resolveAgencyContact, not here.
//
// Safety: immediately before EACH resolve, the script re-fetches the full
// AGENCIES snapshot and re-checks both status and physical row boundary.
//
// This is a REAL run: it spends Hunter credits and writes
// to AGENCIES/CONTACTS. It never touches Instantly and never runs
// personalisation/rebuild jobs — it only calls the two routes above.
//
// Usage:
//   node scripts/novus-contact-resolution-blank-status-run.mjs \
//     --confirm RESOLVE_NEEDS_RESEARCH_AFTER_ROW_180 [--limit 5|--limit=5] [--base=...] [--user=...] [--pass=...]
//
// Requires (same production auth already used elsewhere in this repo):
//   NOVUS_BASE_URL (or --base)                — defaults to https://demo.getnovus.co.uk
//   NOVUS_BASIC_AUTH_USER/PASS (or --user/--pass)

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIRMATION = 'RESOLVE_NEEDS_RESEARCH_AFTER_ROW_180';
export const TARGET_STATUS = 'NEEDS_RESEARCH';
export const MIN_EXCLUSIVE_SHEET_ROW = 180;
const DEFAULT_BASE = 'https://demo.getnovus.co.uk';
const DEFAULT_THROTTLE_MS = 1000;
const RATE_LIMIT_RETRY_DELAYS_MS = [1000, 2000, 4000];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`Unknown argument: ${token}`);
    const equalsAt = token.indexOf('=');
    if (equalsAt > 2) {
      flags[token.slice(2, equalsAt)] = token.slice(equalsAt + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i += 1; }
  }
  return flags;
}

export function isEligibleAgency(row) {
  return String(row?.contact_resolution_status || '').trim() === TARGET_STATUS
    && Number(row?.sheet_row_number) > MIN_EXCLUSIVE_SHEET_ROW;
}

export function partitionNeedsResearch(rows) {
  const needsResearch = (Array.isArray(rows) ? rows : [])
    .filter((row) => String(row?.contact_resolution_status || '').trim() === TARGET_STATUS);
  for (const row of needsResearch) {
    const sheetRow = Number(row?.sheet_row_number);
    if (!Number.isInteger(sheetRow) || sheetRow < 1) {
      throw new Error(`Missing valid physical sheet_row_number for agency ${row?.agency_id || 'UNKNOWN'}`);
    }
  }
  return {
    needsResearch,
    excluded: needsResearch.filter((row) => Number(row.sheet_row_number) <= MIN_EXCLUSIVE_SHEET_ROW),
    eligible: needsResearch.filter(isEligibleAgency),
  };
}

function numericFlag(flags, name, fallback) {
  const parsed = Number(flags[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function httpConfig(flags) {
  const base = String(flags.base || process.env.NOVUS_BASE_URL || process.env.NOVUS_DEMO_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
  const user = String(flags.user || process.env.NOVUS_BASIC_AUTH_USER || '');
  const pass = String(flags.pass || process.env.NOVUS_BASIC_AUTH_PASS || '');
  if (!user || !pass) throw new Error('Set --user/--pass or NOVUS_BASIC_AUTH_USER/NOVUS_BASIC_AUTH_PASS');
  return { base, auth: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` };
}

export async function requestJson(url, init, {
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchImpl(url, init);
    const result = await response.json().catch(() => ({}));
    if (response.status !== 429 || attempt >= RATE_LIMIT_RETRY_DELAYS_MS.length) {
      return { response, result };
    }
    const retryAfterSeconds = Number(response.headers?.get?.('retry-after'));
    const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : 0;
    const delayMs = Math.min(30_000, Math.max(RATE_LIMIT_RETRY_DELAYS_MS[attempt], retryAfterMs));
    console.warn(`429 rate limit; retrying in ${delayMs}ms (attempt ${attempt + 1}/${RATE_LIMIT_RETRY_DELAYS_MS.length})`);
    await sleepImpl(delayMs);
  }
}

async function fetchAgencySnapshot(cfg, options = {}) {
  const url = `${cfg.base}/api/novus/contacts/resolution-backlog`
    + '?require_probe_sent=false&include_resolved=true';
  const { response, result } = await requestJson(url, { headers: { Authorization: cfg.auth } }, options);
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status} fetching backlog`);
  return result.agencies || [];
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const flags = parseArgs(argv);
  if (flags.confirm !== CONFIRMATION) {
    throw new Error(`This spends live Hunter credits and writes to AGENCIES/CONTACTS. Re-run with --confirm ${CONFIRMATION}`);
  }
  const limit = numericFlag(flags, 'limit', Infinity);
  const throttleMs = numericFlag(flags, 'throttle-ms', DEFAULT_THROTTLE_MS);
  const cfg = httpConfig(flags);

  const initialRows = await fetchAgencySnapshot(cfg, dependencies);
  const { needsResearch, excluded, eligible } = partitionNeedsResearch(initialRows);
  const targets = eligible.slice(0, limit);
  console.log(`Total NEEDS_RESEARCH rows: ${needsResearch.length}`);
  console.log(`Excluded at sheet row <= ${MIN_EXCLUSIVE_SHEET_ROW}: ${excluded.length}`);
  console.log(`Eligible at sheet row > ${MIN_EXCLUSIVE_SHEET_ROW}: ${eligible.length}`);
  console.log('First 10 eligible rows:');
  for (const row of eligible.slice(0, 10)) {
    console.log(`  row ${row.sheet_row_number}  ${row.agency_id}  ${row.agency_name}  ${row.contact_resolution_status}`);
  }
  if (eligible.length === 0) console.log('  (none)');
  console.log(`Processing ${targets.length} eligible agencies${Number.isFinite(limit) ? ` (--limit ${limit})` : ''}.`);
  console.log('');

  let processed = 0;
  let skippedRace = 0;
  let failed = 0;
  const throttleAfter = async (target) => {
    if (throttleMs > 0 && target !== targets[targets.length - 1]) {
      await (dependencies.sleepImpl || sleep)(throttleMs);
    }
  };

  for (const target of targets) {
    try {
      // Re-check immediately before spending credits: fetch the backlog fresh
      // and confirm status is STILL NEEDS_RESEARCH and physical row is STILL >180.
      const current = await fetchAgencySnapshot(cfg, dependencies);
      const row = current.find((agency) => agency.agency_id === target.agency_id);
      const freshStatus = row ? String(row.contact_resolution_status || '').trim() : '';
      const freshSheetRow = Number(row?.sheet_row_number);
      if (!row || !isEligibleAgency(row)) {
        skippedRace += 1;
        console.log(`SKIP  ${target.agency_id}  recheck failed (status=${freshStatus || 'MISSING'}, sheet_row=${Number.isFinite(freshSheetRow) ? freshSheetRow : 'MISSING'})`);
        continue;
      }

      const { response, result } = await requestJson(`${cfg.base}/api/novus/contacts/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: cfg.auth },
        body: JSON.stringify({ agency_id: target.agency_id, dry_run: false }),
      }, dependencies);
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      processed += 1;
      console.log(`OK    ${target.agency_id}  ${target.agency_name}  -> ${result.contact_resolution_status}  (${result.selected_contact?.email || 'no email selected'})`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL  ${target.agency_id}  ${target.agency_name}  ${err.message}`);
    } finally {
      await throttleAfter(target);
    }
  }

  console.log('');
  console.log(`Done. processed=${processed} skipped_recheck=${skippedRace} failed=${failed} of ${targets.length} targeted (${eligible.length} eligible at start).`);
  if (failed > 0) process.exitCode = 1;
  return { processed, skipped_recheck: skippedRace, failed, targeted: targets.length, eligible_at_start: eligible.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\nContact-resolution bulk run failed: ${err.message}\n`);
    process.exit(1);
  });
}
