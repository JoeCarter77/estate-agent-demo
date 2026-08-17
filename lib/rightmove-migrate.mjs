// lib/rightmove-migrate.mjs — merges the Rightmove research into the LIVE
// AGENCIES table.
//
// GROUND RULES (from the migration brief, enforced in code below):
//   • The live Google Sheet is the sole source of truth. This is a MERGE into
//     it, not a replacement of it. Nothing is recreated.
//   • agency_id is the ONLY join key. Row order/row number is never used.
//   • Only the four rightmove_* fields (plus one reuse of an existing column,
//     see below) are ever written. Every other cell of an agency row is left
//     exactly as it is — repo.updateById patches named keys only.
//   • Only a GENUINE agency-profile URL may land in rightmove_sales_branch_url.
//     Generic searches / area pages / individual property pages are rejected by
//     lib/rightmove-urls.mjs and recorded as a rejection instead.
//   • A 'confirmed' status is not taken at face value. Confirmed REQUIRES a
//     genuine agency-profile URL; if the research says confirmed but the URL is
//     generic (or missing), the status is downgraded. This is the specific
//     failure the re-check was done to catch, so it is enforced here rather
//     than trusted.
//   • Idempotent: a second run over the same source produces zero writes.
//
// Deliberate reuse, not duplication (Part 5): agencies the research flags as
// lettings-only / non-sales are ALSO recorded in the AGENCIES column that
// already exists for exactly that fact — sales_led_lettings_only — but ONLY
// when that cell is currently blank, so live human-entered data is never
// overwritten. No new "is_lettings" column is invented.

import {
  classifyRightmoveUrl,
  URL_KIND,
  RIGHTMOVE_STATUS,
  normalizeRightmoveStatus,
} from './rightmove-urls.mjs';
import { canonicalTimestamp } from './normalize.mjs';

// The four columns this migration introduces on AGENCIES.
export const RIGHTMOVE_COLUMNS = [
  'rightmove_sales_branch_url',
  'rightmove_status',
  'rightmove_checked_at',
  'rightmove_notes',
];

// Header aliases, so the source workbook doesn't have to match exactly.
const FIELD_ALIASES = {
  agency_id: ['agency_id', 'agencyid', 'agency id', 'id'],
  rightmove_sales_branch_url: [
    'rightmove_sales_branch_url', 'rightmove sales branch url', 'rightmove_url',
    'rightmove url', 'rightmove_branch_url', 'sales_branch_url', 'rightmove_profile_url',
    'rightmove_agency_url',
  ],
  rightmove_status: ['rightmove_status', 'rightmove status', 'status', 'rm_status'],
  rightmove_checked_at: [
    'rightmove_checked_at', 'rightmove checked at', 'checked_at', 'checked at',
    'rightmove_checked', 'date_checked', 'reviewed_at',
  ],
  rightmove_notes: [
    'rightmove_notes', 'rightmove notes', 'notes', 'rm_notes', 'comment', 'comments',
  ],
};

function norm(s) {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Builds a { canonicalField -> sourceHeader } map from the source workbook's
 * headers. Returns { map, missing } so a caller can refuse to run against a
 * file that isn't the Rightmove research at all.
 */
export function mapSourceHeaders(headers) {
  const byNorm = new Map();
  for (const h of headers || []) byNorm.set(norm(h), h);

  const map = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      if (byNorm.has(alias)) { map[field] = byNorm.get(alias); break; }
    }
  }
  const missing = [];
  if (!map.agency_id) missing.push('agency_id');
  // At least one Rightmove payload column must be present, or there is nothing
  // to migrate.
  if (!map.rightmove_sales_branch_url && !map.rightmove_status && !map.rightmove_notes) {
    missing.push('rightmove_sales_branch_url / rightmove_status / rightmove_notes');
  }
  return { map, missing };
}

/**
 * Decides the values a single source row should contribute, WITHOUT touching
 * any sheet. Pure — this is where the correctness rules live and what the
 * self-test exercises directly.
 *
 * @param sourceRow  object keyed by canonical field names
 * @param liveRow    the current AGENCIES row object (or null if unmatched)
 * @returns { patch, url_kind, url_reason, status, downgraded, rejected_url }
 */
export function resolveRow(sourceRow, liveRow) {
  const rawUrl = String(sourceRow.rightmove_sales_branch_url ?? '').trim();
  const classified = classifyRightmoveUrl(rawUrl);
  const isGenuine = classified.kind === URL_KIND.AGENCY_PROFILE;

  let status = normalizeRightmoveStatus(sourceRow.rightmove_status);
  let downgraded = null;

  // A URL that is not an agency profile can never support 'confirmed'.
  if (status === RIGHTMOVE_STATUS.CONFIRMED && !isGenuine) {
    downgraded = {
      from: RIGHTMOVE_STATUS.CONFIRMED,
      to: rawUrl ? RIGHTMOVE_STATUS.CANDIDATE : RIGHTMOVE_STATUS.UNRESOLVED,
      why: rawUrl
        ? `Research said confirmed but the URL is not a Rightmove agency profile (${classified.reason})`
        : 'Research said confirmed but no URL was supplied',
    };
    status = downgraded.to;
  }

  // A genuine profile URL with no stated status is at least a candidate.
  if (!status && isGenuine) status = RIGHTMOVE_STATUS.CANDIDATE;

  // Notes: keep the researcher's own text, and append a machine annotation when
  // we rejected a URL or changed a status, so the reason survives in the sheet.
  const noteParts = [];
  const sourceNotes = String(sourceRow.rightmove_notes ?? '').trim();
  if (sourceNotes) noteParts.push(sourceNotes);
  if (rawUrl && !isGenuine) {
    noteParts.push(`[NOVUS migration] Rejected URL (${classified.kind}): ${classified.reason}. Not stored as the agency URL. Value was: ${rawUrl}`);
  }
  if (downgraded) {
    noteParts.push(`[NOVUS migration] Status downgraded ${downgraded.from} → ${downgraded.to}: ${downgraded.why}`);
  }

  const patch = {};
  // Only ever write a genuine profile URL. Never blank out an existing value.
  if (isGenuine) patch.rightmove_sales_branch_url = classified.normalized;
  if (status) patch.rightmove_status = status;

  const checkedAt = canonicalTimestamp(sourceRow.rightmove_checked_at);
  if (checkedAt) patch.rightmove_checked_at = checkedAt;

  if (noteParts.length) patch.rightmove_notes = noteParts.join(' | ');

  // Reuse of the pre-existing column, only when it is blank.
  if (status === RIGHTMOVE_STATUS.NOT_APPLICABLE && liveRow && !String(liveRow.sales_led_lettings_only ?? '').trim()) {
    patch.sales_led_lettings_only = 'lettings_only';
  }

  return {
    patch,
    url_kind: classified.kind,
    url_reason: classified.reason,
    status,
    downgraded,
    rejected_url: rawUrl && !isGenuine ? rawUrl : '',
  };
}

/**
 * Runs the merge.
 *
 * @param repo      the sheets repo (real or in-memory fake)
 * @param rows      array of source row objects, canonical field names
 * @param options   { dryRun = true, ensureColumns = true }
 * @returns a full report — nothing is hidden, including every unmatched id.
 */
export async function migrateRightmove(repo, rows, options = {}) {
  const { dryRun = true, ensureColumns = true } = options;

  const report = {
    dry_run: dryRun,
    columns_added: [],
    source_rows: (rows || []).length,
    source_rows_without_agency_id: 0,
    duplicate_source_agency_ids: [],
    matched: 0,
    unmatched_agency_ids: [],
    urls_migrated: 0,
    urls_rejected: 0,
    rejected_url_samples: [],
    status_counts: {
      [RIGHTMOVE_STATUS.CONFIRMED]: 0,
      [RIGHTMOVE_STATUS.CANDIDATE]: 0,
      [RIGHTMOVE_STATUS.UNRESOLVED]: 0,
      [RIGHTMOVE_STATUS.NOT_APPLICABLE]: 0,
    },
    downgraded: [],
    rows_written: 0,
    rows_unchanged: 0,
    lettings_flag_set: 0,
    errors: [],
  };

  if (ensureColumns && !dryRun) {
    const result = await repo.ensureColumns('AGENCIES', RIGHTMOVE_COLUMNS);
    report.columns_added = result.added;
  } else if (ensureColumns) {
    // Dry run: report what WOULD be added without writing.
    const { header } = await repo.getTable('AGENCIES');
    report.columns_added = RIGHTMOVE_COLUMNS.filter((c) => !header.includes(c));
  }

  // Index the live table once, by agency_id.
  const liveRecords = await repo.getRecords('AGENCIES', 'agency_id');
  const live = new Map();
  for (const r of liveRecords) {
    // First occurrence wins, matching repo.findById/updateById behaviour, so the
    // migration patches exactly the row a later lookup would resolve to.
    if (!live.has(r.obj.agency_id)) live.set(r.obj.agency_id, r.obj);
  }

  const seenSource = new Set();

  for (const raw of rows || []) {
    const agencyId = String(raw.agency_id ?? '').trim();
    if (!agencyId) { report.source_rows_without_agency_id += 1; continue; }
    if (seenSource.has(agencyId)) {
      report.duplicate_source_agency_ids.push(agencyId);
      continue; // never apply the same id twice in one run
    }
    seenSource.add(agencyId);

    const liveRow = live.get(agencyId);
    if (!liveRow) { report.unmatched_agency_ids.push(agencyId); continue; }
    report.matched += 1;

    const resolved = resolveRow(raw, liveRow);

    if (resolved.status && report.status_counts[resolved.status] !== undefined) {
      report.status_counts[resolved.status] += 1;
    }
    if (resolved.patch.rightmove_sales_branch_url) report.urls_migrated += 1;
    if (resolved.rejected_url) {
      report.urls_rejected += 1;
      if (report.rejected_url_samples.length < 25) {
        report.rejected_url_samples.push({
          agency_id: agencyId,
          agency_name: liveRow.agency_name || '',
          url: resolved.rejected_url,
          kind: resolved.url_kind,
          reason: resolved.url_reason,
        });
      }
    }
    if (resolved.downgraded) {
      report.downgraded.push({
        agency_id: agencyId,
        agency_name: liveRow.agency_name || '',
        ...resolved.downgraded,
      });
    }
    if (resolved.patch.sales_led_lettings_only) report.lettings_flag_set += 1;

    // Idempotence: drop keys whose live value already equals the new value.
    const effective = {};
    for (const [k, v] of Object.entries(resolved.patch)) {
      if (String(liveRow[k] ?? '') !== String(v)) effective[k] = v;
    }
    if (!Object.keys(effective).length) { report.rows_unchanged += 1; continue; }

    if (dryRun) { report.rows_written += 1; continue; }

    try {
      const updated = await repo.updateById('AGENCIES', 'agency_id', agencyId, effective);
      if (!updated) {
        report.errors.push({ agency_id: agencyId, error: 'updateById found no row at write time' });
      } else {
        report.rows_written += 1;
        Object.assign(liveRow, effective); // keep the in-memory index truthful
      }
    } catch (err) {
      report.errors.push({ agency_id: agencyId, error: err.message || String(err) });
    }
  }

  report.unmatched_count = report.unmatched_agency_ids.length;
  return report;
}
