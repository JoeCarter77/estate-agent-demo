// scripts/novus-sheets-smoke.mjs — LIVE round-trip against the real workbook.
//
// This is the "verify against the real workbook" check. It needs real creds and
// network, so run it where those exist (locally with .env.local, or any env that
// has the service account). It is intentionally NOT part of the hermetic
// selftest.
//
// It writes ONE clearly-marked test probe, reads it back, flips it to observing,
// reads again, then prints the row so you can delete it from the PROBES tab.
//
// Setup:
//   1) Create a Google Cloud service account, enable the Google Sheets API.
//   2) Share NOVUS_Data_V1_Master_v2 with the service account's client_email (Editor).
//   3) Put GOOGLE_SERVICE_ACCOUNT_JSON + NOVUS_SHEET_ID in .env.local
//   4) node --env-file=.env.local scripts/novus-sheets-smoke.mjs
//
// (Node 20+ supports --env-file. Or export the vars into your shell first.)

import { getRepo } from '../lib/sheets.mjs';
import { newProbeId, newProbeReference } from '../lib/ids.mjs';

async function main() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !process.env.NOVUS_SHEET_ID) {
    console.error('Missing GOOGLE_SERVICE_ACCOUNT_JSON and/or NOVUS_SHEET_ID. See .env.example.');
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

main().catch((err) => { console.error('\n❌ SMOKE FAILED:\n', err); process.exit(1); });
