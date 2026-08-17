// lib/agencies.mjs — deterministic AGENCIES identity resolution.
//
// NOVUS rule: there is exactly ONE canonical agency identifier — AGENCIES.agency_id
// in the live workbook. This module does not mint, derive or guess an identifier:
// it only resolves a supplied one against the AGENCIES tab and returns the row's
// own canonical agency_id (so casing/whitespace in a pasted link can never fork
// identity downstream).
//
// The agency-specific probe URL carries this same agency_id (/novus/a/<agency_id>
// or /novus/probe?agency=<agency_id>), so the chain
//   probe URL → UI → probe-create → PROBES.agency_id → communications matching
//     → intelligence
// is one value end-to-end, never a second identifier and never a lookup by name.
//
// If the id does not resolve to exactly one AGENCIES row, callers MUST fail —
// an orphan probe with a blank agency_id can never be matched to a
// communication, so creating one is worse than refusing.

// Returns { ok: true, agency } | { ok: false, reason: 'missing'|'unknown'|'ambiguous' }.
// `agency` is the AGENCIES row object; agency.agency_id is the canonical value.
export async function resolveAgency(repo, rawAgencyId) {
  const wanted = String(rawAgencyId ?? '').trim();
  if (!wanted) return { ok: false, reason: 'missing' };

  const agencies = await repo.getRecords('AGENCIES', 'agency_id');
  const needle = wanted.toLowerCase();
  const hits = agencies.filter(({ obj }) => String(obj.agency_id ?? '').trim().toLowerCase() === needle);

  if (hits.length === 1) return { ok: true, agency: hits[0].obj };
  if (hits.length > 1) return { ok: false, reason: 'ambiguous' };
  return { ok: false, reason: 'unknown' };
}

// Human-readable failure text for the reasons above. Kept next to the resolver so
// the UI and the API always say the same thing.
export function agencyErrorMessage(reason, rawAgencyId) {
  const id = String(rawAgencyId ?? '').trim();
  if (reason === 'missing') {
    return 'No agency in this probe link. Open the agency-specific probe URL (/novus/a/<agency_id>) — a probe cannot be created without a resolved agency.';
  }
  if (reason === 'ambiguous') {
    return `Agency id "${id}" matches more than one AGENCIES row. Fix the duplicate in the workbook — NOVUS will not guess which agency this is.`;
  }
  return `Agency id "${id}" does not exist in AGENCIES. Check the probe link — NOVUS will not create a probe without a resolved agency.`;
}
