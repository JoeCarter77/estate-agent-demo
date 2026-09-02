// scripts/novus-sales-messages-setup.mjs — prints the EXACT contents of a new
// SALES_MESSAGES tab, for a one-time manual paste into the NOVUS workbook.
//
// IT WRITES NOTHING. It performs no Google Sheets call, needs no credential,
// and touches no network. It prints two rows.
//
// WHY A PASTE AND NOT A SCRIPT THAT CREATES THE TAB. Adding a sheet is a
// spreadsheets.batchUpdate:addSheet call, which lib/sheets.mjs does not speak —
// it is a values-only transport (get/append/update) — and its credentials are
// per-invocation Vercel OIDC tokens that cannot be minted on a local machine.
// So a "create the tab" script would mean BOTH a new Sheets API surface AND a
// new live write path, built for a phase that appends no rows at all. The paste
// is the smaller, safer thing.
//
// Usage:
//   node scripts/novus-sales-messages-setup.mjs
//
// Then, once, in NOVUS_Data_V1_Master_v2:
//   1. Add a sheet named exactly SALES_MESSAGES.
//   2. Paste row 1 into A1 and row 2 into A2 (Paste special > values only).
//   3. Add NOTHING else. The tab stays empty until a send actually happens.

import { pathToFileURL } from 'node:url';
import {
  SALES_MESSAGES_TAB,
  SALES_MESSAGES_HEADER,
  buildSalesMessagesSetupPlan,
} from '../lib/sales-messages.mjs';

export function main() {
  const plan = buildSalesMessagesSetupPlan();

  console.log(`Tab name: ${plan.tab}`);
  console.log(`Columns:  ${plan.header_row.length}`);
  console.log(`Data rows to paste: ${plan.data_rows.length} (a setup must never seed a message NOVUS did not send)\n`);

  console.log('--- Row 1 (header) — paste into A1, tab-separated ---');
  console.log(plan.header_row.join('\t'));
  console.log('\n--- Row 2 (schema note) — paste into A2, tab-separated ---');
  console.log(plan.schema_note_row.join('\t'));

  console.log('\n--- Column reference ---');
  SALES_MESSAGES_HEADER.forEach((column, i) => {
    console.log(`  ${String(i + 1).padStart(2)}  ${column}`);
  });

  console.log(`\nAfter pasting, verify with the operator drawer: the ${SALES_MESSAGES_TAB} warning`);
  console.log('("sales_messages_unavailable") should disappear from GET /api/novus/operator/conversation.');
  console.log('Phase 3A appends nothing, so the tab stays at 2 rows.');
  return plan;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
