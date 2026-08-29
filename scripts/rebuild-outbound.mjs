// Operator CLI for the deployed, Basic-Auth-protected OUTBOUND compiler.
//
// Usage:
//   node scripts/rebuild-outbound.mjs --dry-run
//   node scripts/rebuild-outbound.mjs
//
// Env (or flags):
//   NOVUS_BASE_URL (NOVUS_DEMO_BASE_URL also accepted)  --base
//   NOVUS_BASIC_AUTH_USER                              --user
//   NOVUS_BASIC_AUTH_PASS                              --pass

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

function config(flags) {
  const base = String(flags.base || process.env.NOVUS_BASE_URL || process.env.NOVUS_DEMO_BASE_URL || '').replace(/\/+$/, '');
  const user = String(flags.user || process.env.NOVUS_BASIC_AUTH_USER || '');
  const pass = String(flags.pass || process.env.NOVUS_BASIC_AUTH_PASS || '');
  if (!base) throw new Error('Set --base or NOVUS_BASE_URL to the deployed NOVUS URL');
  if (!user || !pass) throw new Error('Set --user/--pass or NOVUS_BASIC_AUTH_USER/NOVUS_BASIC_AUTH_PASS');
  return { base, auth: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') };
}

function printReport(result) {
  console.log(result.dry_run ? 'NOVUS OUTBOUND dry-run' : 'NOVUS OUTBOUND rebuild complete');
  console.log(`eligible: ${result.eligible_count}`);
  console.log(`skipped:  ${result.skipped_count}`);
  console.log(`create:   ${result.create_count}`);
  console.log(`update:   ${result.update_count}`);

  for (const item of result.skipped || []) {
    console.log(`SKIPPED ${item.agency_id} / ${item.probe_id}: ${item.reasons.join('; ')}`);
  }
  for (const row of result.rows_to_create || []) {
    console.log(`CREATE ${row.agency_id} / ${row.probe_id}: ${JSON.stringify(row)}`);
  }
  for (const row of result.rows_to_update || []) {
    console.log(`UPDATE ${row.agency_id} / ${row.probe_id}: ${JSON.stringify(row)}`);
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const dryRun = flags['dry-run'] === true;
  const cfg = config(flags);
  const response = await fetch(`${cfg.base}/api/novus/intelligence/rebuild-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: cfg.auth },
    body: JSON.stringify({ operation: 'rebuild_outbound', dry_run: dryRun }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `OUTBOUND rebuild failed (${response.status})`);
  printReport(body);
}

main().catch((err) => {
  console.error(`\nOUTBOUND compiler failed: ${err.message}\n`);
  process.exit(1);
});
