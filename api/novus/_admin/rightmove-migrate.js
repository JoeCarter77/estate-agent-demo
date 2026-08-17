// api/novus/_admin/rightmove-migrate.js — resource handler for
//   POST /api/novus/admin?resource=rightmove-migrate
//
// Relocated under the underscore-prefixed _admin/ directory so Vercel does not
// route this file directly — api/novus/admin.js dispatches to it by
// `resource`. Reason: staying within the Vercel Hobby plan's 12-serverless-
// function limit (see that file's header comment). Handler logic unchanged.
//
// Merges the Rightmove research into the LIVE AGENCIES table, keyed on
// agency_id. The decision logic is lib/rightmove-migrate.mjs (pure, unit-tested
// by scripts/novus-rightmove-selftest.mjs); this file is the thin HTTP wrapper
// that gives it live sheet access, for the same keyless-auth reason as
// ensure-schema.js.
//
// Body:
//   {
//     rows: [ { agency_id, rightmove_sales_branch_url, rightmove_status,
//               rightmove_checked_at, rightmove_notes }, ... ],
//     dry_run: true            // DEFAULTS TO TRUE — you must opt in to writing
//   }
//
// Source headers do not have to match exactly: mapSourceHeaders() accepts the
// common aliases, and `rows` may be posted with the original workbook headers.
//
// ALWAYS run dry_run first and read the report. A dry run performs zero writes
// and returns exactly the same counts the real run will produce, including which
// URLs were rejected as generic and which 'confirmed' statuses were downgraded.

import { getRepo } from '../../../lib/sheets.mjs';
import { migrateRightmove, mapSourceHeaders } from '../../../lib/rightmove-migrate.mjs';
import { requireAuth } from '../_auth.mjs';

export const maxDuration = 60;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const rows = Array.isArray(body.rows) ? body.rows : null;
  const dryRun = body.dry_run === undefined ? true : Boolean(body.dry_run);

  if (!rows) return res.status(400).json({ error: 'Body must contain a "rows" array' });
  if (!rows.length) return res.status(400).json({ error: '"rows" is empty — nothing to migrate' });

  // Normalise incoming headers to canonical field names, so the caller can post
  // the workbook's own column names verbatim.
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r || {})))];
  const { map, missing } = mapSourceHeaders(headers);
  if (missing.length) {
    return res.status(400).json({
      error: `Source rows are missing required column(s): ${missing.join(', ')}`,
      headers_seen: headers,
    });
  }

  const canonical = rows.map((r) => {
    const out = {};
    for (const [field, sourceHeader] of Object.entries(map)) out[field] = r?.[sourceHeader] ?? '';
    return out;
  });

  try {
    const repo = getRepo();
    const report = await migrateRightmove(repo, canonical, { dryRun, ensureColumns: true });
    return res.status(200).json({ header_map: map, report });
  } catch (err) {
    console.error('rightmove-migrate error:', err);
    return res.status(500).json({ error: err.message || 'Migration failed' });
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
