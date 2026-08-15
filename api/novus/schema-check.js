// api/novus/schema-check.js — GET /api/novus/schema-check
//
// Reports whether the live workbook actually has the columns the code writes.
//
// This is the antidote to the one genuinely silent failure in the Sheets
// layer: appendRecord maps records onto the header row, so a field whose
// column is absent is dropped with no error anywhere. Run this after any
// workbook edit, and before a probing run, to confirm nothing is being
// quietly discarded.
//
// Basic-Auth gated like the rest of the internal surface. Read-only.

import { getRepo } from '../../lib/sheets.mjs';
import { verifyWorkbookSchema } from '../../lib/schema.mjs';
import { requireAuth } from './_auth.mjs';

export const maxDuration = 20;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  try {
    const repo = getRepo();
    const result = await verifyWorkbookSchema(repo);

    const droppedFields = result.tabs
      .filter((t) => t.missingOptional.length)
      .map((t) => ({ tab: t.tab, columns: t.missingOptional }));

    // 200 even when columns are missing: this is a report, not an operation
    // that failed. The `ok` flag carries the verdict.
    return res.status(200).json({
      ok: result.ok,
      summary: result.ok
        ? 'All required columns present.'
        : `Missing required columns in: ${result.tabs.filter((t) => !t.ok).map((t) => t.tab).join(', ')}`,
      dropped_on_write: droppedFields.length
        ? droppedFields
        : 'None — every field the code writes has a column.',
      tabs: result.tabs,
      errors: result.errors,
    });
  } catch (err) {
    console.error('schema-check error:', err);
    return res.status(500).json({ error: err.message || 'Failed to verify workbook schema' });
  }
}
