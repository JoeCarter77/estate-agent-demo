// lib/demo-compile.mjs — the DEMOS compilation step.
//
//   PROBE -> COMMUNICATIONS -> INTELLIGENCE -> DIAGNOSIS ->
//   DIAGNOSIS_FINDINGS -> PERSONALISATION -> **DEMOS**
//
// This is where a demo comes into existence. It runs AUTOMATICALLY, as the
// last step of lib/rebuild-pass.mjs, immediately after
// rebuildAllPersonalisation — so the moment a probe's PERSONALISATION row is
// written, that probe's DEMOS row is compiled in the same invocation. There is
// no manual build step in the acquisition workflow; api/demo.js's `build`
// action calls straight into this same function and exists only as an
// internal debugging / recovery tool.
//
// IT ALSO SELF-HEALS. A probe that is already personalised but has no DEMOS
// row — the DEMOS tab was created after the probe was personalised, an earlier
// compile hit its budget, the row was deleted by hand — is picked up by the
// next pass. That is what makes "never run a build command" true in practice
// and not just for probes personalised from now on.
//
// SAME SHAPE AS EVERY OTHER REBUILD STEP: batch-load each tab once, decide in
// memory, write once. No read per write, no request per probe.
//
// ZERO AI CALLS. This step packages and displays intelligence the pipeline
// already produced upstream (in COMMUNICATIONS/INTELLIGENCE/DIAGNOSIS/
// PERSONALISATION) — it never calls lib/ai-client.mjs itself. The one
// COMMUNICATIONS read below feeds lib/demos.mjs's selectCommunicationEvidence(),
// which is fixed rules over already-classified fields (occurred_at, channel,
// automated_or_human, voicemail_present, the message's own stored text) — the
// same deterministic classifier lib/observation.mjs's INTELLIGENCE rollup
// already uses, never a new model call.
//
// IT CAN NEVER BREAK THE PIPELINE. Every per-probe failure is caught and
// reported; a workbook with no DEMOS tab is a no-op with a flag, not a throw.
// Personalisation has already been written by the time this runs, and nothing
// here writes back into it.

import {
  DEMOS_TAB, DEMO_VERSION,
  ANALYTICS_COLUMNS, buildDemoRow, buildDemoSlug, demoRecords, demosTabExists,
  loadDemosTable, slugOwners,
} from './demos.mjs';
import { loadFindingsTable, groupFindingsByProbe } from './diagnosis-findings.mjs';
import { resolvePropertyImageUrl } from './property-image.mjs';

// How many demos one pass will compile, and how many listing fetches it will
// attempt while doing so. Both exist because a pass runs inside a serverless
// invocation with a hard wall-clock limit: 40 sheet-row builds are cheap, but
// 40 sequential listing fetches at up to 8s each are not. Whatever a pass
// cannot get to is picked up by the next one — nothing is lost, and a demo
// compiled without its image is still perfectly sendable.
const DEFAULT_MAX_COMPILES = 25;
const DEFAULT_MAX_IMAGE_FETCHES = 6;

function text(value) { return String(value ?? '').trim(); }

function recordsFromTable({ header, rows }, idColumn) {
  const idIdx = header.indexOf(idColumn);
  const out = [];
  (rows || []).forEach((row) => {
    const idVal = idIdx >= 0 ? String(row[idIdx] ?? '').trim() : '';
    if (!idVal || idVal === 'SCHEMA NOTE') return;
    const obj = {};
    header.forEach((key, colIdx) => { obj[key] = row[colIdx] ?? ''; });
    if (idIdx >= 0) obj[idColumn] = idVal;
    out.push(obj);
  });
  return out;
}

// A probe is ready for a demo once PERSONALISATION has actually produced a
// story for it. primary_narrative is the same "finalised" signal
// lib/personalisation-rebuild.mjs freezes on, so this can never compile a demo
// from a half-written personalisation row.
export function isPersonalised(personalisation) {
  return Boolean(text(personalisation?.primary_narrative));
}

// Why this probe is (or isn't) being compiled this pass. Exported so the
// decision is testable on its own, and so the summary can explain itself.
export function compileDecision({ personalisation, existing, justPersonalised = false, force = false }) {
  if (!isPersonalised(personalisation)) return { compile: false, reason: 'not_personalised' };
  if (force) return { compile: true, reason: 'forced' };
  if (!existing) return { compile: true, reason: justPersonalised ? 'personalisation_completed' : 'missing_demo_row' };
  if (justPersonalised) return { compile: true, reason: 'personalisation_completed' };

  // A row built by an older renderer contract is refreshed rather than left to
  // render half a page.
  if (text(existing.demo_version) !== String(DEMO_VERSION)) return { compile: true, reason: 'stale_demo_version' };

  // The image budget ran out last time; try again now. Any other image status
  // (ok / manual / unavailable / none) is settled and is not a reason to
  // recompile — in particular `unavailable` is NOT retried automatically, so a
  // dead listing is not re-fetched on every pass.
  if (text(existing.property_image_status) === 'pending') return { compile: true, reason: 'image_pending' };

  return { compile: false, reason: 'up_to_date' };
}

// Decides what to do about the hero photo for one probe, and reports which
// branch it took. Never throws: lib/property-image.mjs resolves every failure
// mode to '', and a blank image never blocks a compile.
//
// Precedence: a hand-supplied URL wins, then whatever the row already has,
// then (budget permitting) one extraction attempt.
async function resolveImage({ probe, existing, suppliedImageUrl, forceImage, budget, resolver }) {
  if (text(suppliedImageUrl)) {
    return { url: text(suppliedImageUrl), status: 'manual', fetched: false };
  }

  const existingUrl = text(existing?.property_image_url);
  const existingStatus = text(existing?.property_image_status);
  if (existingUrl && !forceImage) {
    return { url: existingUrl, status: existingStatus || 'ok', fetched: false };
  }

  const listingUrl = text(probe?.property_url);
  if (!listingUrl) return { url: '', status: 'none', fetched: false };

  // Settled failure: don't re-fetch a dead or blocking listing every pass.
  if (existingStatus === 'unavailable' && !forceImage) {
    return { url: '', status: 'unavailable', fetched: false };
  }

  if (budget.remaining <= 0) return { url: existingUrl, status: 'pending', fetched: false };
  budget.remaining -= 1;

  // Serverless path only — never Playwright. Blocked is the expected outcome
  // on Rightmove and must leave the demo intact.
  const url = await resolver(listingUrl).catch(() => '');
  return { url, status: url ? 'ok' : 'unavailable', fetched: true };
}

// ── the step ─────────────────────────────────────────────────────────────────

// repo, opts?: {
//   probeIds?: iterable          restrict to these probes (same targeting
//                                option as every other rebuild step)
//   justPersonalised?: iterable  probe_ids PERSONALISATION wrote in this pass;
//                                always compiled, whatever else is true
//   force?: boolean              recompile even an up-to-date row
//   forceImage?: boolean         re-resolve an image the row already has
//   suppliedImageUrl?: string    single-probe only: use this image verbatim
//   compiledBy?: string          provenance stamped on the row ('auto'|'cli'|…)
//   maxCompiles?, maxImageFetches?: number
//   resolveImageUrl?: fn         TEST SEAM ONLY — replaces the one listing
//                                fetch, so the self-tests stay hermetic
//                                instead of reaching Rightmove for real
// }
// -> { demos_compiled, demos_created, demos_updated, demos_ready,
//      demos_needs_review, images_fetched, images_pending, remaining_demos,
//      demos_tab_missing, skipped_unsupported_journey, problems, results }
export async function compileDemos(repo, opts = {}) {
  const summary = {
    demos_compiled: 0,
    demos_created: 0,
    demos_updated: 0,
    demos_ready: 0,
    demos_needs_review: 0,
    images_fetched: 0,
    images_pending: 0,
    remaining_demos: 0,
    demos_tab_missing: false,
    skipped_unsupported_journey: 0,
    problems: [],
    results: [],
  };

  const demosTable = await loadDemosTable(repo);
  if (!demosTabExists(demosTable)) {
    // The tab has not been created yet. Say so once, loudly, in the summary —
    // and leave the rest of the pipeline completely unaffected.
    summary.demos_tab_missing = true;
    return summary;
  }

  const [probesTable, agenciesTable, intelligenceTable, personalisationTable, findingsTable, communicationsTable] = await Promise.all([
    repo.getTable('PROBES'),
    repo.getTable('AGENCIES'),
    repo.getTable('INTELLIGENCE'),
    repo.getTable('PERSONALISATION'),
    loadFindingsTable(repo),
    repo.getTable('COMMUNICATIONS'),
  ]);

  const probesById = new Map(recordsFromTable(probesTable, 'probe_id').map((o) => [o.probe_id, o]));
  const agencyById = new Map(recordsFromTable(agenciesTable, 'agency_id').map((o) => [o.agency_id, o]));
  const intelligenceByProbe = new Map(recordsFromTable(intelligenceTable, 'probe_id').map((o) => [o.probe_id, o]));
  const findingsByProbe = groupFindingsByProbe(findingsTable);

  // Grouped, not filtered per-probe on demand — same batch-load-once shape as
  // every other tab here. "Matched" is simply probe_id === probeId, the same
  // rule lib/observation-recompute.mjs already uses (matching itself runs
  // upstream and is never re-decided here).
  const communicationsByProbe = new Map();
  for (const comm of recordsFromTable(communicationsTable, 'probe_id')) {
    if (!communicationsByProbe.has(comm.probe_id)) communicationsByProbe.set(comm.probe_id, []);
    communicationsByProbe.get(comm.probe_id).push(comm);
  }

  const existingByProbe = new Map();
  for (const { rowNumber, obj } of demoRecords(demosTable)) {
    const probeId = text(obj.probe_id);
    if (probeId && !existingByProbe.has(probeId)) existingByProbe.set(probeId, { rowNumber, obj });
  }
  const owners = slugOwners(demosTable);

  const probeIdFilter = opts.probeIds ? new Set(opts.probeIds) : null;
  const justPersonalised = new Set(opts.justPersonalised || []);
  const maxCompiles = Number.isFinite(opts.maxCompiles) ? opts.maxCompiles : DEFAULT_MAX_COMPILES;
  const imageBudget = {
    remaining: Number.isFinite(opts.maxImageFetches) ? opts.maxImageFetches : DEFAULT_MAX_IMAGE_FETCHES,
  };
  const compiledBy = text(opts.compiledBy) || 'auto';
  const resolver = typeof opts.resolveImageUrl === 'function'
    ? opts.resolveImageUrl
    : (url) => resolvePropertyImageUrl(url, { allowBrowser: false });
  const now = new Date().toISOString();

  // PERSONALISATION drives the loop, because a demo exists for exactly one
  // reason: that probe has a personalised story to tell.
  const personalisationRows = recordsFromTable(personalisationTable, 'probe_id');
  const seen = new Set();
  const writes = [];
  let nextRow = (demosTable.rows?.length ?? 0) + 2;

  for (const personalisation of personalisationRows) {
    const probeId = personalisation.probe_id;
    if (probeIdFilter && !probeIdFilter.has(probeId)) continue;
    // One probe, one visit — the same duplicate-row defence the rest of the
    // pipeline applies, so a workbook with two rows for one probe can never
    // append a second demo.
    if (seen.has(probeId)) continue;
    seen.add(probeId);

    const existingRecord = existingByProbe.get(probeId) || null;
    const decision = compileDecision({
      personalisation,
      existing: existingRecord?.obj || null,
      justPersonalised: justPersonalised.has(probeId),
      force: Boolean(opts.force),
    });
    if (!decision.compile) continue;

    if (summary.demos_compiled >= maxCompiles) {
      summary.remaining_demos += 1;
      continue;
    }

    try {
      const probe = probesById.get(probeId) || {};
      const intelligence = intelligenceByProbe.get(probeId) || {};
      const agency = agencyById.get(text(probe.agency_id) || text(personalisation.agency_id)) || {};
      const findings = findingsByProbe.get(probeId) || [];
      const communications = communicationsByProbe.get(probeId) || [];

      const image = await resolveImage({
        probe,
        existing: existingRecord?.obj || null,
        suppliedImageUrl: opts.suppliedImageUrl,
        forceImage: Boolean(opts.forceImage),
        budget: imageBudget,
        resolver,
      });
      if (image.fetched) summary.images_fetched += 1;
      if (image.status === 'pending') summary.images_pending += 1;

      const slug = text(existingRecord?.obj.demo_slug) || text(opts.slug) || buildDemoSlug({
        agencyName: agency.agency_name,
        probeReference: probe.probe_reference,
        probeId,
      }, owners);

      const { row, reasons, status } = buildDemoRow({
        probe,
        agency,
        intelligence,
        findings,
        personalisation,
        communications,
        propertyImageUrl: image.url,
        propertyImageStatus: image.status,
        demoSlug: slug,
        existing: existingRecord?.obj || null,
        compiledBy,
        now,
      });
      // Claim the slug for this probe so two probes compiled in the SAME pass
      // cannot be handed the same URL.
      owners.set(slug.toLowerCase(), probeId);

      const rowNumber = existingRecord ? existingRecord.rowNumber : nextRow;
      if (!existingRecord) nextRow += 1;
      writes.push({ tab: DEMOS_TAB, rowNumber, row: demosTable.header.map((key) => (row[key] ?? '')) });

      summary.demos_compiled += 1;
      if (existingRecord) summary.demos_updated += 1; else summary.demos_created += 1;
      if (status === 'ready') summary.demos_ready += 1;
      if (status === 'needs_review') summary.demos_needs_review += 1;
      summary.results.push({
        probe_id: probeId,
        demo_slug: slug,
        demo_status: status,
        demo_url: `/demo/${slug}`,
        hero_journey: row.hero_journey,
        // Echoed so a caller that CAN run a real browser (scripts/novus-demo.mjs)
        // knows which listing to re-extract from when the serverless fetch came
        // back blank — without needing its own read access to PROBES.
        property_url: row.property_url,
        property_image_url: row.property_image_url,
        property_image_status: row.property_image_status,
        reason: decision.reason,
        review_reasons: reasons,
      });
    } catch (err) {
      // A journey with no demo behind it is an expected, countable outcome —
      // not a pipeline failure. Everything else is a real problem.
      if (err?.code === 'unsupported_hero_journey') {
        summary.skipped_unsupported_journey += 1;
        summary.problems.push({ probe_id: probeId, error: err.message, hero_journey: err.hero_journey });
      } else {
        summary.problems.push({ probe_id: probeId, error: err?.message || String(err) });
      }
    }
  }

  if (writes.length > 0) await repo.writeRowsBatch(writes);
  return summary;
}

// Single-probe convenience for api/demo.js's debugging/recovery `build`
// action and the CLI. Same code path as the automatic pass — there is exactly
// one compiler, so a hand-triggered rebuild can never produce a row the
// pipeline would not have produced.
export async function compileDemoForProbe(repo, probeId, opts = {}) {
  const summary = await compileDemos(repo, {
    ...opts,
    probeIds: [probeId],
    force: opts.force !== false,        // an explicit single-probe build always recompiles
  });
  return { ...summary, result: summary.results[0] || null };
}

export const _internal = { DEFAULT_MAX_COMPILES, DEFAULT_MAX_IMAGE_FETCHES, resolveImage, recordsFromTable, ANALYTICS_COLUMNS };
