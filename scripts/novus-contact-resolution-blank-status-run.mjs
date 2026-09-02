#!/usr/bin/env node
// LIVE bulk contact-resolution run against the DEPLOYED NOVUS application.
// No local Google credentials/WIF needed — this script only speaks HTTP to
// two EXISTING, unmodified-in-behaviour endpoints:
//
//   GET  /api/novus/contacts/resolution-backlog  (rewrite -> personalisation.js)
//   POST /api/novus/contacts/resolve              (rewrite -> personalisation.js)
//
// Target: every AGENCIES row with a blank contact_resolution_status,
// regardless of probe_sent. The backlog listing already supported a
// probe_sent-gated view; require_probe_sent=false is the (additive,
// backward-compatible) opt-out added for this run — it does not change the
// default listing behaviour any other caller relies on.
//
// The script only decides which agency_id to POST next, one per call, exactly
// the endpoint's
// existing one-agency-per-call contract. The 3-call Hunter Verifier cap per
// agency is enforced inside resolveAgencyContact, not here.
//
// Safety: the target list is built once at the start, but immediately before
// EACH agency's resolve call this script re-fetches the backlog fresh and
// re-checks that specific agency's current contact_resolution_status. If it
// is no longer blank — resolved earlier in this same run, or by anything else
// since the list was built — it is skipped, never reprocessed.
//
// This is a REAL run: it spends Hunter credits and writes
// to AGENCIES/CONTACTS. It never touches Instantly and never runs
// personalisation/rebuild jobs — it only calls the two routes above.
//
// Usage:
//   node scripts/novus-contact-resolution-blank-status-run.mjs \
//     --confirm RESOLVE_ALL_BLANK_CONTACT_STATUS [--limit=N] [--base=...] [--user=...] [--pass=...]
//
// Requires (same production auth already used elsewhere in this repo):
//   NOVUS_BASE_URL (or --base)                — defaults to https://demo.getnovus.co.uk
//   NOVUS_BASIC_AUTH_USER/PASS (or --user/--pass)

const CONFIRMATION = 'RESOLVE_ALL_BLANK_CONTACT_STATUS';
const DEFAULT_BASE = 'https://demo.getnovus.co.uk';

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`Unknown argument: ${token}`);
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i += 1; }
  }
  return flags;
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

async function fetchBacklog(cfg, { includeResolved }) {
  const url = `${cfg.base}/api/novus/contacts/resolution-backlog`
    + `?require_probe_sent=false&include_resolved=${includeResolved ? 'true' : 'false'}`;
  const response = await fetch(url, { headers: { Authorization: cfg.auth } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status} fetching backlog`);
  return result.agencies || [];
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.confirm !== CONFIRMATION) {
    throw new Error(`This spends live Hunter credits and writes to AGENCIES/CONTACTS. Re-run with --confirm ${CONFIRMATION}`);
  }
  const limit = numericFlag(flags, 'limit', Infinity);
  const cfg = httpConfig(flags);

  const eligible = await fetchBacklog(cfg, { includeResolved: false });
  const targets = eligible.slice(0, limit);
  console.log(`Blank contact_resolution_status agencies at start: ${eligible.length}. Processing ${targets.length}. (probe_sent not used as a gate)`);
  console.log('');

  let processed = 0;
  let skippedRace = 0;
  let failed = 0;

  for (const target of targets) {
    // Re-check immediately before spending credits: fetch the backlog fresh
    // and confirm this agency's contact_resolution_status is STILL blank.
    const current = await fetchBacklog(cfg, { includeResolved: true });
    const row = current.find((a) => a.agency_id === target.agency_id);
    const freshStatus = row ? String(row.contact_resolution_status || '').trim() : '';
    if (freshStatus) {
      skippedRace += 1;
      console.log(`SKIP  ${target.agency_id}  already resolved (${freshStatus}) since backlog was read`);
      continue;
    }

    try {
      const response = await fetch(`${cfg.base}/api/novus/contacts/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: cfg.auth },
        body: JSON.stringify({ agency_id: target.agency_id, dry_run: false }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      processed += 1;
      console.log(`OK    ${target.agency_id}  ${target.agency_name}  -> ${result.contact_resolution_status}  (${result.selected_contact?.email || 'no email selected'})`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL  ${target.agency_id}  ${target.agency_name}  ${err.message}`);
    }
  }

  console.log('');
  console.log(`Done. processed=${processed} skipped_already_resolved=${skippedRace} failed=${failed} of ${targets.length} targeted (${eligible.length} eligible at start).`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\nContact-resolution bulk run failed: ${err.message}\n`);
  process.exit(1);
});
