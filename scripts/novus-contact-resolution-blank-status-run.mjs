#!/usr/bin/env node
// LIVE contact-resolution rechecks against the DEPLOYED NOVUS application.
// No local Google credentials/WIF needed — this script only speaks HTTP to
// two EXISTING, unmodified-in-behaviour endpoints:
//
//   GET  /api/novus/contacts/resolution-backlog  (rewrite -> personalisation.js)
//   POST /api/novus/contacts/resolve              (rewrite -> personalisation.js)
//
// Modes are selected by an explicit confirmation value:
//   RESOLVE_NEEDS_RESEARCH_AFTER_ROW_180 — NEEDS_RESEARCH, physical row > 180
//   RESOLVE_BLANK_AFTER_ROW_247           — blank status, physical row >= 247
// sheet_row_number comes from the server's repo record metadata, not array
// position, agency order or timestamps.
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
//     --confirm RESOLVE_BLANK_AFTER_ROW_247 [--limit 5|--limit=5] [--base=...] [--user=...] [--pass=...]
//
// Requires (same production auth already used elsewhere in this repo):
//   NOVUS_BASE_URL (or --base)                — defaults to https://demo.getnovus.co.uk
//   NOVUS_BASIC_AUTH_USER/PASS (or --user/--pass)

import path from 'node:path';
import { fileURLToPath } from 'node:url';

// CONFIRMATION remains the original NEEDS_RESEARCH mode for existing callers.
export const NEEDS_RESEARCH_CONFIRMATION = 'RESOLVE_NEEDS_RESEARCH_AFTER_ROW_180';
export const BLANK_STATUS_CONFIRMATION = 'RESOLVE_BLANK_AFTER_ROW_247';
export const CONFIRMATION = NEEDS_RESEARCH_CONFIRMATION;
export const NEEDS_RESEARCH_MIN_EXCLUSIVE_SHEET_ROW = 180;
export const MIN_INCLUSIVE_SHEET_ROW = 247;
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

export function isBlankStatusEligible(row) {
  return !String(row?.contact_resolution_status || '').trim()
    && Number(row?.sheet_row_number) >= MIN_INCLUSIVE_SHEET_ROW;
}

export function isNeedsResearchEligible(row) {
  return String(row?.contact_resolution_status || '').trim() === 'NEEDS_RESEARCH'
    && Number(row?.sheet_row_number) > NEEDS_RESEARCH_MIN_EXCLUSIVE_SHEET_ROW;
}

// Kept for callers of the original NEEDS_RESEARCH recheck runner.
export const isEligibleAgency = isNeedsResearchEligible;

export function partitionBlankStatus(rows) {
  const blankStatus = (Array.isArray(rows) ? rows : [])
    .filter((row) => !String(row?.contact_resolution_status || '').trim());
  for (const row of blankStatus) {
    const sheetRow = Number(row?.sheet_row_number);
    if (!Number.isInteger(sheetRow) || sheetRow < 1) {
      throw new Error(`Missing valid physical sheet_row_number for agency ${row?.agency_id || 'UNKNOWN'}`);
    }
  }
  return {
    blankStatus,
    excluded: blankStatus.filter((row) => Number(row.sheet_row_number) < MIN_INCLUSIVE_SHEET_ROW),
    eligible: blankStatus.filter(isBlankStatusEligible),
  };
}

export function partitionNeedsResearch(rows) {
  const needsResearch = (Array.isArray(rows) ? rows : [])
    .filter((row) => String(row?.contact_resolution_status || '').trim() === 'NEEDS_RESEARCH');
  for (const row of needsResearch) {
    const sheetRow = Number(row?.sheet_row_number);
    if (!Number.isInteger(sheetRow) || sheetRow < 1) {
      throw new Error(`Missing valid physical sheet_row_number for agency ${row?.agency_id || 'UNKNOWN'}`);
    }
  }
  return {
    needsResearch,
    excluded: needsResearch.filter((row) => Number(row.sheet_row_number) <= NEEDS_RESEARCH_MIN_EXCLUSIVE_SHEET_ROW),
    eligible: needsResearch.filter(isNeedsResearchEligible),
  };
}

function modeForConfirmation(confirmation) {
  if (confirmation === NEEDS_RESEARCH_CONFIRMATION) {
    return {
      confirmation,
      partition: partitionNeedsResearch,
      isEligible: isNeedsResearchEligible,
      totalLabel: 'Total NEEDS_RESEARCH rows',
      excludedLabel: `Excluded at sheet row <= ${NEEDS_RESEARCH_MIN_EXCLUSIVE_SHEET_ROW}`,
      eligibleLabel: `Eligible at sheet row > ${NEEDS_RESEARCH_MIN_EXCLUSIVE_SHEET_ROW}`,
    };
  }
  if (confirmation === BLANK_STATUS_CONFIRMATION) {
    return {
      confirmation,
      partition: partitionBlankStatus,
      isEligible: isBlankStatusEligible,
      totalLabel: 'Total blank-status rows',
      excludedLabel: `Excluded at sheet row < ${MIN_INCLUSIVE_SHEET_ROW}`,
      eligibleLabel: `Eligible at sheet row >= ${MIN_INCLUSIVE_SHEET_ROW}`,
    };
  }
  throw new Error(
    `This spends live Hunter credits and writes to AGENCIES/CONTACTS. Re-run with --confirm ${NEEDS_RESEARCH_CONFIRMATION} or --confirm ${BLANK_STATUS_CONFIRMATION}`,
  );
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
  const mode = modeForConfirmation(flags.confirm);
  const limit = numericFlag(flags, 'limit', Infinity);
  const throttleMs = numericFlag(flags, 'throttle-ms', DEFAULT_THROTTLE_MS);
  const cfg = httpConfig(flags);

  const initialRows = await fetchAgencySnapshot(cfg, dependencies);
  const partitioned = mode.partition(initialRows);
  const total = partitioned.blankStatus || partitioned.needsResearch || [];
  const { excluded, eligible } = partitioned;
  const targets = eligible.slice(0, limit);
  console.log(`${mode.totalLabel}: ${total.length}`);
  console.log(`${mode.excludedLabel}: ${excluded.length}`);
  console.log(`${mode.eligibleLabel}: ${eligible.length}`);
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
      // and confirm the mode's status and physical-row predicate still hold.
      const current = await fetchAgencySnapshot(cfg, dependencies);
      const row = current.find((agency) => agency.agency_id === target.agency_id);
      const freshStatus = row ? String(row.contact_resolution_status || '').trim() : '';
      const freshSheetRow = Number(row?.sheet_row_number);
      if (!row || !mode.isEligible(row)) {
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
