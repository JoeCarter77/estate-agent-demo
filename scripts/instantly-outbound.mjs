// Operator CLI for the protected NOVUS OUTBOUND -> Instantly handoff.
//
// Safe default:
//   node scripts/instantly-outbound.mjs --dry-run
//
// Controlled one-lead modes (both require the literal confirmation value):
//   node scripts/instantly-outbound.mjs --live --outbound-id out_... --confirm UPLOAD_ONE_TO_INSTANTLY --test-email you@example.com
//   node scripts/instantly-outbound.mjs --live --outbound-id out_... --confirm UPLOAD_ONE_TO_INSTANTLY
//
// INSTANTLY_API_KEY and INSTANTLY_CAMPAIGN_ID are server-side Vercel env vars.
// This CLI sends neither value and never prints the API key.

import { INSTANTLY_LIVE_CONFIRMATION } from '../lib/instantly-outbound.mjs';

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unknown argument: ${token}`);
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; index += 1; }
  }
  return flags;
}

function config(flags) {
  const base = String(flags.base || process.env.NOVUS_BASE_URL || process.env.NOVUS_DEMO_BASE_URL || '').replace(/\/+$/, '');
  const user = String(flags.user || process.env.NOVUS_BASIC_AUTH_USER || '');
  const pass = String(flags.pass || process.env.NOVUS_BASIC_AUTH_PASS || '');
  if (!base) throw new Error('Set --base or NOVUS_BASE_URL to the deployed NOVUS URL');
  if (!user || !pass) throw new Error('Set --user/--pass or NOVUS_BASIC_AUTH_USER/NOVUS_BASIC_AUTH_PASS');
  return { base, auth: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` };
}

function requestBody(flags) {
  const live = flags.live === true;
  if (flags['dry-run'] === true && live) throw new Error('Choose either --dry-run or --live, not both');
  if (!live) {
    return {
      operation: 'instantly_outbound',
      dry_run: true,
      sample_limit: flags['sample-limit'] === undefined ? 3 : Number(flags['sample-limit']),
    };
  }
  if (!flags['outbound-id']) throw new Error('--live requires --outbound-id');
  if (!flags.confirm) {
    throw new Error(`--live requires --confirm ${INSTANTLY_LIVE_CONFIRMATION}`);
  }
  return {
    operation: 'instantly_outbound',
    dry_run: false,
    outbound_id: flags['outbound-id'],
    confirmation: flags.confirm,
    ...(flags['test-email'] !== undefined ? { test_email: flags['test-email'] } : {}),
  };
}

function printDryRun(result) {
  console.log('NOVUS OUTBOUND -> Instantly dry-run');
  console.log(`total rows:    ${result.total_rows}`);
  console.log(`eligible rows: ${result.eligible_rows}`);
  console.log(`skipped rows:  ${result.skipped_rows}`);
  for (const [reason, count] of Object.entries(result.skip_reasons || {}).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`skip ${reason}: ${count}`);
  }
  for (const sample of result.sample_payloads || []) {
    console.log(`SAMPLE ${sample.outbound_id}: ${JSON.stringify(sample.payload)}`);
  }
}

function printLive(result) {
  if (result.test_mode) {
    console.log(result.message || 'TEST MODE: lead accepted; OUTBOUND was not modified.');
    console.log(`outbound_id: ${result.outbound_id}`);
    console.log(`instantly_lead_id: ${result.instantly_lead_id}`);
    console.log(`payload: ${JSON.stringify(result.payload)}`);
    return;
  }
  console.log('NOVUS OUTBOUND -> Instantly single-lead handoff complete');
  console.log(`outbound_id: ${result.outbound_id}`);
  console.log(`instantly_lead_id: ${result.instantly_lead_id}`);
  console.log(`instantly_added_at: ${result.instantly_added_at}`);
  console.log(`outbound_status: ${result.outbound_status}`);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const cfg = config(flags);
  const body = requestBody(flags);
  const response = await fetch(`${cfg.base}/api/novus/intelligence/rebuild-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: cfg.auth },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Instantly handoff failed (${response.status})`);
  if (result.dry_run) printDryRun(result);
  else printLive(result);
}

main().catch((err) => {
  console.error(`\nInstantly handoff failed: ${err.message}\n`);
  process.exit(1);
});
