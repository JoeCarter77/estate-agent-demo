// api/novus/_admin/agencies.js — resource handler for GET /api/novus/admin?resource=agencies
//
// Relocated under the underscore-prefixed _admin/ directory so Vercel does not
// route this file directly (see api/novus/admin.js for why: staying within the
// Hobby plan's 12-serverless-function limit). The HANDLER LOGIC BELOW IS
// UNCHANGED from the original api/novus/agencies.js — only its location (and
// therefore its relative import depth) moved.
//
// The agency side of the probe flow. The probe UI needs this for two things:
//   1) the agency picker — you launch a probe FROM an agency, so the UI has to
//      be able to find "Fisks Ltd" and hold its agency_id;
//   2) deep-link resolution — /novus/probe?agency_id=ag_hist_fisks-ltd-d8u5
//      must be able to render the agency's NAME, not a raw opaque id.
//
// Query params:
//   agency_id=<id>   resolve exactly one agency (deep-link entry point)
//   q=<text>         case-insensitive substring over agency_name / location /
//                    domain (the picker's search box)
//   probeable=1      only agencies it is legitimate to probe: not suppressed,
//                    and rightmove_status not 'not_applicable' (lettings /
//                    non-sales). Agencies whose Rightmove research is still
//                    unresolved are INCLUDED — a missing profile URL does not
//                    stop Joe pasting a property URL he found another way.
//   limit=<n>        default 50, max 200
//
// Read-only. Returns a trimmed projection — never the full agency row, so
// contact emails and internal notes stay server-side.

import { getRepo } from '../../../lib/sheets.mjs';
import { RIGHTMOVE_STATUS } from '../../../lib/rightmove-urls.mjs';
import { requireAuth } from '../_auth.mjs';

export const maxDuration = 20;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function project(obj) {
  return {
    agency_id: obj.agency_id || '',
    agency_name: obj.agency_name || '',
    location: obj.location || '',
    domain: obj.domain || '',
    main_phone: obj.main_phone || '',
    // Present only once the Rightmove migration has added these columns; the
    // repo returns '' for a column the sheet does not have yet, so this is safe
    // to read before the migration runs.
    rightmove_sales_branch_url: obj.rightmove_sales_branch_url || '',
    rightmove_status: obj.rightmove_status || '',
    rightmove_checked_at: obj.rightmove_checked_at || '',
    sales_led_lettings_only: obj.sales_led_lettings_only || '',
    suppression_status: obj.suppression_status || '',
    current_pipeline_status: obj.current_pipeline_status || '',
  };
}

function isProbeable(a) {
  if (String(a.suppression_status).trim().toLowerCase() === 'suppressed') return false;
  if (String(a.rightmove_status).trim().toLowerCase() === RIGHTMOVE_STATUS.NOT_APPLICABLE) return false;
  return true;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const agencyId = String(req.query?.agency_id || '').trim();
  const q = String(req.query?.q || '').trim().toLowerCase();
  const probeableOnly = String(req.query?.probeable || '') === '1';
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query?.limit, 10) || DEFAULT_LIMIT));

  try {
    const repo = getRepo();

    // Single-agency resolution (deep link).
    if (agencyId) {
      const record = await repo.findById('AGENCIES', 'agency_id', agencyId);
      if (!record) return res.status(404).json({ error: `Unknown agency_id "${agencyId}"` });
      const agency = project(record.obj);
      return res.status(200).json({ agency, probeable: isProbeable(agency) });
    }

    const records = await repo.getRecords('AGENCIES', 'agency_id');

    // De-duplicate on agency_id. The live workbook currently contains the
    // NOVUS test fixture twice; returning it twice would give the picker two
    // identical options that resolve to the same record.
    const seen = new Set();
    let agencies = [];
    for (const { obj } of records) {
      if (seen.has(obj.agency_id)) continue;
      seen.add(obj.agency_id);
      agencies.push(project(obj));
    }

    if (probeableOnly) agencies = agencies.filter(isProbeable);

    if (q) {
      agencies = agencies.filter((a) =>
        `${a.agency_name} ${a.location} ${a.domain}`.toLowerCase().includes(q));
    }

    agencies.sort((a, b) => a.agency_name.localeCompare(b.agency_name, 'en-GB'));
    const total = agencies.length;

    return res.status(200).json({ agencies: agencies.slice(0, limit), total, returned: Math.min(total, limit) });
  } catch (err) {
    console.error('agencies error:', err);
    return res.status(500).json({ error: err.message || 'Failed to list agencies' });
  }
}
