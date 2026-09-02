import { pathToFileURL } from 'node:url';
import { ACTIONS_HEADER, buildActionsSetupPlan } from '../lib/actions-store.mjs';

export function main() {
  const plan = buildActionsSetupPlan();
  console.log(`Tab name: ${plan.tab}`);
  console.log(`Columns:  ${plan.header_row.length}`);
  console.log('\n--- Row 1 (header) — paste into A1, tab-separated ---');
  console.log(plan.header_row.join('\t'));
  console.log('\n--- Row 2 (schema note) — paste into A2, tab-separated ---');
  console.log(plan.schema_note_row.join('\t'));
  console.log('\n--- Column reference ---');
  ACTIONS_HEADER.forEach((column, i) => console.log(`  ${String(i + 1).padStart(2)}  ${column}`));
  return plan;
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
