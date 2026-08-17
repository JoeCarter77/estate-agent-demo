// api/novus/_admin/ensure-schema.js — resource handler for
//   POST /api/novus/admin?resource=ensure-schema   Body: { dry_run?: boolean }
//   (dry_run defaults to true)
//
// Relocated under the underscore-prefixed _admin/ directory so Vercel does not
// route this file directly — api/novus/admin.js dispatches to it by
// `resource`. Reason: staying within the Vercel Hobby plan's 12-serverless-
// function limit (see that file's header comment). Handler logic unchanged.
//
// Adds the columns the new probe flow needs to the LIVE workbook, additively.
//
// This exists as an endpoint rather than a local script because Google Sheets
// access is keyless: the only place a token can be obtained is inside a real
// Vercel invocation (Vercel OIDC → Workload Identity Federation → impersonated
// novus-sheets service account, see lib/sheets.mjs). There is no private key to
// run a migration from a laptop or a CI box, by design.
//
// SAFETY: repo.ensureColumns writes ROW 1 ONLY. Existing columns are never
// reordered, renamed or removed, and no data row is touched. Every existing
// record simply gains trailing empty cells. Idempotent — a second call adds
// nothing and reports [].
//
// Protected by the same NOVUS_BASIC_AUTH as the rest of /api/novus/*.

import { getRepo } from '../../../lib/sheets.mjs';
import { RIGHTMOVE_COLUMNS } from '../../../lib/rightmove-migrate.mjs';
import { requireAuth } from '../_auth.mjs';

export const maxDuration = 30;

// Only genuinely-missing information. Deliberately NOT added:
//   listing_agent / listing_agent_rightmove_url / agency_match_status — the
//   brief rules out listing-agent-vs-agency validation, so storing a scraped
//   listing agent would be a field nothing writes and nothing reads. The
//   agency↔property relationship is established by agency_id on the probe and
//   confirmed in the real world by the submitted enquiry.
export const SCHEMA_ADDITIONS = {
  // The Rightmove research fields (Part 1).
  AGENCIES: RIGHTMOVE_COLUMNS,
  // Property enrichment that the existing PROBES tab has no home for.
  // property_address / property_price / property_status already exist and are
  // reused as-is.
  PROBES: ['property_type', 'property_bedrooms', 'property_id'],
  // INTELLIGENCE is deliberately absent. lib/observation-recompute.mjs carries a
  // comment saying contact_attempt_count is "not yet a column" — that comment is
  // stale: the live INTELLIGENCE tab already has it (and observed_problem,
  // commercial_implication, discovery_focus, demo_type, email_strategy,
  // phone_strategy, next_action). Adding it again would be a duplicate column.
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const dryRun = body.dry_run === undefined ? true : Boolean(body.dry_run);

  try {
    const repo = getRepo();
    const result = {};

    for (const [tab, columns] of Object.entries(SCHEMA_ADDITIONS)) {
      const { header } = await repo.getTable(tab);
      const missing = columns.filter((c) => !header.includes(c));
      if (dryRun) {
        result[tab] = { would_add: missing, existing_column_count: header.length };
      } else {
        const applied = await repo.ensureColumns(tab, columns);
        result[tab] = { added: applied.added, column_count: applied.header.length };
      }
    }

    return res.status(200).json({ dry_run: dryRun, tabs: result });
  } catch (err) {
    console.error('ensure-schema error:', err);
    return res.status(500).json({ error: err.message || 'Failed to ensure schema' });
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
