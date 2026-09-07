// lib/property-reference.mjs — ONE definition of "the property street reference"
// for a probe.
//
// WHY THIS EXISTS. PROBES has carried two address columns over its life:
//   property_street  — a hand-maintained short street reference, written by the
//                      original import. New probes never write it
//                      (api/novus/probe.js does not produce it).
//   property_address — the full listing address every probe created since then
//                      actually carries.
// OUTBOUND eligibility demanded a nonblank property_street, so every probe
// created by the current code died at the last gate of the pipeline with
// "missing property_street" while holding a perfectly good property_address.
//
// THE RULE, AND IT IS THE ONLY ONE: a nonblank stored property_street WINS,
// always. It is a human-maintained value and is never recomputed, never
// overwritten, never second-guessed. Only when it is blank is the street
// derived from property_address. That keeps one source of truth (the stored
// column, when it has content) and makes the derivation a fallback rather than
// a competing writer.
//
// The derived value is the FIRST address component — "Whitmore Way, Basildon,
// SS14" -> "Whitmore Way" — with postcodes stripped and the analyst's trailing
// bracketed note removed by the existing cleanAddressForEmail(). House numbers
// are KEPT, because the historical values keep them ("10 High Street").

import { cleanAddressForEmail, hasUnresolvedPlaceholder } from './probe-personalisation.mjs';

const POSTCODE_RE = /\b[A-Z]{1,2}\d[A-Z\d]?(?:\s*\d[A-Z]{2})?\b/gi;

function text(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

// property_address -> the street reference, or '' when nothing usable is there.
// Never throws, never invents: an unknown/placeholder address derives nothing.
export function derivePropertyStreetFromAddress(address) {
  const cleaned = cleanAddressForEmail(address);
  if (!cleaned || /^unknown/i.test(cleaned) || hasUnresolvedPlaceholder(cleaned)) return '';
  const components = cleaned.split(',').map((part) => text(part));
  let first = components[0] ?? '';
  // A REAL HISTORICAL FORMAT: some addresses put the house number as its OWN
  // leading component — "4,High Street, Billericay" — rather than the more
  // common "4 High Street, Billericay". Discarding a bare-number first
  // component outright (the old behaviour) derived '' for these and blocked
  // OUTBOUND on a probe that plainly has a usable street. Fold it into the
  // next component instead, so both formats resolve to the same "4 High
  // Street" a human would write.
  if (/^\d+[a-z]?$/i.test(first) && components[1]) {
    first = `${first} ${components[1]}`;
  }
  const street = text(first.replace(POSTCODE_RE, ''));
  if (!street || hasUnresolvedPlaceholder(street)) return '';
  // A bare house number on its own is not a street reference.
  if (/^\d+[a-z]?$/i.test(street)) return '';
  return street;
}

// The value OUTBOUND (and the Instantly {{property_street}} variable) should
// use for this probe. Stored value first; derived only as a fallback.
export function resolvePropertyStreet(probe) {
  const stored = text(probe?.property_street);
  if (stored) return stored;
  return derivePropertyStreetFromAddress(probe?.property_address);
}

// True when this probe can supply a street reference at all — the OUTBOUND
// eligibility question. A blank property_street is no longer a blocker on its
// own; a probe with neither a stored street nor a usable address still is.
export function hasPropertyStreet(probe) {
  return resolvePropertyStreet(probe).length > 0;
}

// ── The one-off, safe backfill ───────────────────────────────────────────────
//
// Fills PROBES.property_street ONLY where it is blank AND property_address
// derives something. A nonblank existing value is never touched — that is the
// whole safety property, so it is enforced here rather than left to callers.
//
// Returns fully-formed rows for repo.writeRowsBatch(). If the live schema has
// no property_street column, the plan is empty: there is nothing to backfill
// into, and resolvePropertyStreet() already covers the runtime need.
//
// probesTable: { header, rows } from repo.getTable('PROBES').
export function buildPropertyStreetBackfillPlan(probesTable) {
  const header = probesTable?.header || [];
  const streetIdx = header.indexOf('property_street');
  const addressIdx = header.indexOf('property_address');
  const idIdx = header.indexOf('probe_id');
  if (streetIdx < 0 || addressIdx < 0 || idIdx < 0) {
    return { column_present: streetIdx >= 0, writes: [], backfilled: [], skipped_no_address: 0 };
  }

  const writes = [];
  const backfilled = [];
  let skippedNoAddress = 0;

  (probesTable.rows || []).forEach((row, i) => {
    const probeId = String(row[idIdx] ?? '').trim();
    if (!probeId || probeId === 'SCHEMA NOTE') return;
    if (String(row[streetIdx] ?? '').trim()) return;  // NEVER overwrite.
    const derived = derivePropertyStreetFromAddress(row[addressIdx]);
    if (!derived) { skippedNoAddress += 1; return; }
    const next = header.map((_, colIdx) => (row[colIdx] ?? ''));
    next[streetIdx] = derived;
    writes.push({ tab: 'PROBES', rowNumber: i + 2, row: next });
    backfilled.push({ probe_id: probeId, property_street: derived });
  });

  return { column_present: true, writes, backfilled, skipped_no_address: skippedNoAddress };
}

// repo -> applies the plan. Idempotent: a second run finds every derivable row
// already filled and writes nothing.
export async function backfillPropertyStreet(repo, { dryRun = false } = {}) {
  const probesTable = await repo.getTable('PROBES');
  const plan = buildPropertyStreetBackfillPlan(probesTable);
  if (!dryRun && plan.writes.length) await repo.writeRowsBatch(plan.writes);
  return {
    dry_run: dryRun,
    column_present: plan.column_present,
    backfilled_count: plan.backfilled.length,
    skipped_no_address: plan.skipped_no_address,
    backfilled: plan.backfilled,
  };
}
