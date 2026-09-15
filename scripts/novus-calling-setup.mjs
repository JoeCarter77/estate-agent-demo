// scripts/novus-calling-setup.mjs — prints the header + schema-note rows for
// the four calling tabs, same convention as novus-actions-setup.mjs. The
// calling page's "Set up calling tabs" button does the same thing through the
// API (calling-setup); this is the paste-in fallback.
import { pathToFileURL } from 'node:url';
import { buildCallingSetupPlan } from '../lib/calling-store.mjs';

export function main() {
  const plans = buildCallingSetupPlan();
  for (const plan of plans) {
    console.log(`\n=== Tab: ${plan.tab} (${plan.header_row.length} columns) ===`);
    console.log('--- Row 1 (header) — paste into A1, tab-separated ---');
    console.log(plan.header_row.join('\t'));
    console.log('--- Row 2 (schema note) — paste into A2, tab-separated ---');
    console.log(plan.schema_note_row.join('\t'));
  }
  return plans;
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
