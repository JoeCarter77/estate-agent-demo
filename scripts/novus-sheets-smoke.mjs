// scripts/novus-sheets-smoke.mjs — LIVE round-trip against the real workbook.
//
// This is the "verify against the real workbook" check. It needs a real Vercel
// OIDC token, so it can only run WHERE ONE EXISTS: inside an actual Vercel
// Function invocation (Production or Preview, per the WIF provider's attribute
// condition), not on a bare local machine — VERCEL_OIDC_TOKEN is minted and
// injected by Vercel per-invocation and cannot be faked locally. It is
// intentionally NOT part of the hermetic selftest.
//
// Easiest way to run this against a live deployment: wire it up as a temporary
// diagnostic API route (server-side, Basic-Auth gated like the rest of
// /api/novus) that imports and calls main() from this file, hit it once via
// curl, then remove the route. Do not expose Sheets round-trips as a permanent
// public endpoint.
//
// It writes ONE clearly-marked test probe, reads it back, flips it to observing,
// reads again, then prints the row so you can delete it from the PROBES tab.
//
// Setup (keyless — no service-account key is created or used):
//   1) Create the Workload Identity Pool + Provider trusting Vercel's OIDC
//      issuer, and grant novus-sheets@first-metric-505115-n3.iam.gserviceaccount.com
//      roles/iam.workloadIdentityUser to the scoped principalSet.
//   2) Enable sheets.googleapis.com, iamcredentials.googleapis.com, sts.googleapis.com.
//   3) Share NOVUS_Data_V1_Master_v2 with novus-sheets@... (Editor).
//   4) Enable OIDC Federation on the Vercel project (Settings → Security), and
//      set GCP_WORKLOAD_IDENTITY_AUDIENCE + GCP_SERVICE_ACCOUNT_EMAIL +
//      NOVUS_SHEET_ID as Vercel env vars.
//   5) Run this script's main() from inside a Vercel Function invocation.

import { pathToFileURL } from 'node:url';
import { getRepo } from '../lib/sheets.mjs';
import { newProbeId, newProbeReference } from '../lib/ids.mjs';

async function main() {
  if (!process.env.VERCEL_OIDC_TOKEN) {
    console.error(
      'Missing VERCEL_OIDC_TOKEN. This script must run inside a Vercel Function ' +
      'invocation (OIDC Federation enabled on the project) — it cannot be run on ' +
      'a bare local machine. See the setup notes at the top of this file.'
    );
    process.exit(1);
  }
  if (!process.env.GCP_WORKLOAD_IDENTITY_AUDIENCE || !process.env.GCP_SERVICE_ACCOUNT_EMAIL || !process.env.NOVUS_SHEET_ID) {
    console.error('Missing GCP_WORKLOAD_IDENTITY_AUDIENCE, GCP_SERVICE_ACCOUNT_EMAIL and/or NOVUS_SHEET_ID. See .env.example.');
    process.exit(1);
  }
  const repo = getRepo();

  console.log('→ Reading PROBES header + current count…');
  const { header } = await repo.getTable('PROBES');
  console.log('  header:', header.join(', '));
  const count = await repo.count('PROBES', 'probe_id');
  console.log('  existing probes:', count);

  const now = new Date().toISOString();
  const id = newProbeId();
  const draft = {
    probe_id: id,
    probe_reference: 'RM-SMOKE-' + Date.now().toString(36),
    portal: 'rightmove',
    property_url: 'https://www.rightmove.co.uk/properties/SMOKE-TEST',
    property_address: 'SMOKE TEST — safe to delete',
    probe_email: process.env.NOVUS_PROBE_EMAIL || 'novusprobes@gmail.com',
    probe_phone: process.env.NOVUS_PROBE_PHONE || '+44...',
    probe_status: 'draft',
    compromised: 'FALSE',
    created_at: now,
    updated_at: now,
  };

  console.log('→ Appending draft probe', draft.probe_reference, '…');
  await repo.appendRecord('PROBES', draft);

  console.log('→ Reading it back…');
  let rec = await repo.findById('PROBES', 'probe_id', id);
  console.log('  status:', rec?.obj.probe_status, '| row:', rec?.rowNumber);

  const sentAt = new Date();
  const deadline = new Date(sentAt.getTime() + 7 * 24 * 60 * 60 * 1000);
  console.log('→ Marking as sent (observing, +7 days)…');
  await repo.updateById('PROBES', 'probe_id', id, {
    probe_status: 'observing',
    probe_timestamp: sentAt.toISOString(),
    observation_deadline: deadline.toISOString(),
    updated_at: sentAt.toISOString(),
  });

  rec = await repo.findById('PROBES', 'probe_id', id);
  console.log('  status:', rec?.obj.probe_status);
  console.log('  probe_timestamp:', rec?.obj.probe_timestamp);
  console.log('  observation_deadline:', rec?.obj.observation_deadline);

  console.log('\n✅ Live round-trip OK.');
  console.log(`   Delete the test row (${draft.probe_reference}, row ${rec?.rowNumber}) from PROBES when done.`);
}

export { main };

// Only auto-run when executed directly (`node scripts/novus-sheets-smoke.mjs`),
// not when imported by a diagnostic route.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('\n❌ SMOKE FAILED:\n', err); process.exit(1); });
}
