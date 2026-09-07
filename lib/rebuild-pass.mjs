// lib/rebuild-pass.mjs — the ONE acquisition pass, shared by:
//   - api/novus/intelligence/rebuild-all.js  — the "Rebuild Intelligence" button
//   - api/novus/intelligence/finalize.js     — the 3am Vercel Cron
//
// THE MENTAL MODEL, AND THE ONE THING THAT CHANGED
//
//   PROBE + COMMUNICATIONS
//     -> deterministic observation                 (no AI, ever)
//     -> ONE final commercial assessment           (the ONLY AI call)
//     -> deterministic personalised copy + demo    (no AI)
//     -> OUTBOUND                                  (no AI)
//     -> Instantly
//
// It used to be three AI passes over the same enquiry — interpretation, then
// diagnosis, then personalisation — sharing ONE budget IN SEQUENCE. That is the
// whole reason a rebuild appeared to move DIAGNOSIS while PERSONALISATION,
// DEMOS and OUTBOUND barely moved: interpretation and diagnosis spent the
// budget, personalisation got whatever was left (often nothing), and because
// no personalisation was written, no demo was compiled and no outbound row was
// created. A backlog at the front of the pipeline froze everything behind it.
//
// THE BUDGET NOW GOVERNS EXACTLY ONE THING: how many NEW final assessments this
// invocation may run. Every other stage is deterministic and runs to completion
// regardless — with maxAiCalls: 0, a run still personalises, compiles and
// queues every probe that is already assessed. That is the property the backlog
// drain depends on, and it is asserted by the self-tests.
//
// IDEMPOTENT AND CONVERGENT. Run this repeatedly and it settles:
//   - a probe with a finalised assessment is never reassessed (frozen);
//   - a probe with a written PERSONALISATION row is never re-rendered (frozen —
//     a story a prospect was sent must not change under them);
//   - a compiled, up-to-date demo is not recompiled;
//   - an OUTBOUND row keeps its execution state (SENT/SUPPRESSED/lead id);
//   - every entity is one row per probe, upserted, never appended twice.
//
// ONE SNAPSHOT PER INVOCATION. Every stage below reads through the same
// lib/pipeline-snapshot.mjs cache, so a tab is downloaded at most once per run
// and writes are reflected in memory for the stages that follow. The cache is
// created here (or accepted from the handler) and dies with the invocation —
// nothing is shared between requests.

import { asSnapshotRepo } from './pipeline-snapshot.mjs';
import { rebuildAllIntelligence } from './intelligence-rebuild.mjs';
import { rebuildAllAssessments } from './assessment-rebuild.mjs';
import { rebuildAllPersonalisation } from './personalisation-rebuild.mjs';
import { compileDemos } from './demo-compile.mjs';
import { rebuildOutbound } from './outbound.mjs';
import { hasPropertyStreet } from './property-reference.mjs';

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

const text = (value) => String(value ?? '').trim();

// WHY EVERY COUNT IS EXPLAINED, NOT JUST REPORTED. The old summary could say
// "diagnosis 12, personalisation 0" and leave no way to tell whether that was a
// budget, a gate or a bug. This block reads the post-write snapshot and states,
// for each stage, what exists, what this run created, and what is still
// waiting — plus, for OUTBOUND, the exact reason each blocked probe is blocked.
function buildBacklogReport(tables) {
  const probes = recordsFromTable(tables.PROBES, 'probe_id');
  const intelligence = recordsFromTable(tables.INTELLIGENCE, 'probe_id');
  const diagnosis = recordsFromTable(tables.DIAGNOSIS, 'probe_id');
  const personalisation = recordsFromTable(tables.PERSONALISATION, 'probe_id');
  const demos = tables.DEMOS ? recordsFromTable(tables.DEMOS, 'probe_id') : [];
  const outbound = tables.OUTBOUND ? recordsFromTable(tables.OUTBOUND, 'probe_id') : [];
  const agencies = recordsFromTable(tables.AGENCIES, 'agency_id');

  const probeById = new Map(probes.map((p) => [p.probe_id, p]));
  const agencyById = new Map(agencies.map((a) => [a.agency_id, a]));
  const intelligenceByProbe = new Map(intelligence.map((r) => [r.probe_id, r]));
  const assessedProbes = new Set(diagnosis.filter((r) => text(r.diagnosis_summary)).map((r) => r.probe_id));
  const personalisedProbes = new Set(personalisation
    .filter((r) => text(r.email_observation) || text(r.primary_narrative))
    .map((r) => r.probe_id));
  const demoByProbe = new Map(demos.map((d) => [d.probe_id, d]));
  const outboundByProbe = new Map(outbound.map((o) => [o.probe_id, o]));

  const closed = intelligence.filter((r) => text(r.observation_status).toLowerCase() === 'closed');
  const observing = intelligence.filter((r) => text(r.observation_status).toLowerCase() !== 'closed');

  // The reasons a probe that IS personalised and demo-compiled still has no
  // OUTBOUND row. Deliberately the same questions lib/outbound.mjs asks, so a
  // blocked count here always corresponds to a real gate there.
  const outboundBlocked = {
    missing_email: 0,
    invalid_email: 0,
    missing_demo: 0,
    demo_needs_review: 0,
    demo_image_not_ok: 0,
    missing_property_reference: 0,
    missing_agency: 0,
  };
  let outboundEligibleWaiting = 0;

  for (const probeId of personalisedProbes) {
    if (outboundByProbe.has(probeId)) continue;
    const probe = probeById.get(probeId) || {};
    const agency = agencyById.get(probe.agency_id) || null;
    const demo = demoByProbe.get(probeId) || null;
    let blocked = false;
    if (!agency) { outboundBlocked.missing_agency += 1; blocked = true; }
    else {
      if (!text(agency.outreach_contact_email)) { outboundBlocked.missing_email += 1; blocked = true; }
      else if (!['VALID', 'RISKY'].includes(text(agency.email_verification_status))) { outboundBlocked.invalid_email += 1; blocked = true; }
    }
    if (!demo) { outboundBlocked.missing_demo += 1; blocked = true; }
    else {
      if (text(demo.demo_status) !== 'ready') { outboundBlocked.demo_needs_review += 1; blocked = true; }
      if (text(demo.property_image_status) !== 'ok') { outboundBlocked.demo_image_not_ok += 1; blocked = true; }
    }
    if (!hasPropertyStreet(probe)) { outboundBlocked.missing_property_reference += 1; blocked = true; }
    if (!blocked) outboundEligibleWaiting += 1;
  }

  const instantlyHandedOff = outbound.filter((o) => text(o.instantly_lead_id)).length;

  return {
    probes_total: probes.length,
    probes_observing: observing.length,
    probes_closed: closed.length,
    // Closed probes that have no INTELLIGENCE row at all cannot be assessed
    // yet; counted so "closed" and "assessable" never look inexplicably apart.
    probes_without_intelligence: probes.filter((p) => !intelligenceByProbe.has(p.probe_id)).length,
    assessments_existing: assessedProbes.size,
    assessments_remaining: closed.filter((r) => !assessedProbes.has(r.probe_id)).length,
    personalisation_existing: personalisedProbes.size,
    personalisation_remaining: [...assessedProbes].filter((id) => !personalisedProbes.has(id)).length,
    demos_existing: demos.length,
    demos_remaining: [...personalisedProbes].filter((id) => !demoByProbe.has(id)).length,
    outbound_existing: outbound.length,
    outbound_remaining: [...personalisedProbes].filter((id) => !outboundByProbe.has(id)).length,
    outbound_eligible_waiting: outboundEligibleWaiting,
    outbound_blocked: outboundBlocked,
    instantly_handed_off: instantlyHandedOff,
    instantly_remaining: outbound.filter((o) => text(o.outbound_status) === 'READY' && !text(o.instantly_lead_id)).length,
  };
}

// repo, opts?: {
//   maxAiCalls?: number      NEW FINAL ASSESSMENTS ONLY. Nothing else.
//   probeIds?: string[]      restrict every stage to exactly these probes
//   forceAi?: boolean        accepted, no longer meaningful — see
//                            lib/intelligence-rebuild.mjs's header
//   maxDemoCompiles?, maxDemoImageFetches?: number
//   rebuildOutbound?: boolean
// }
export async function runRebuildPass(repo, opts = {}) {
  const snapshot = asSnapshotRepo(repo);
  const maxAiCalls = Number.isFinite(opts.maxAiCalls) ? opts.maxAiCalls : Infinity;
  const probeIds = Array.isArray(opts.probeIds) && opts.probeIds.length > 0 ? opts.probeIds : null;

  // A. DETERMINISTIC OBSERVATION — recompute every non-finalised probe's
  // objective fields, close whatever expired, self-heal a blank
  // property_street from property_address. Zero AI calls, always.
  const intelligenceSummary = await rebuildAllIntelligence(snapshot, { probeIds });

  // Loaded once, from the snapshot the step above just wrote through.
  const probesTable = await snapshot.getTable('PROBES');
  const probesById = new Map(recordsFromTable(probesTable, 'probe_id').map((p) => [p.probe_id, p]));

  // B. FINAL ASSESSMENT — the only AI spend in the pass, and the only thing
  // maxAiCalls governs.
  const assessmentSummary = await rebuildAllAssessments(snapshot, probesById, { maxAiCalls, probeIds });

  // C. DETERMINISTIC DRAIN — every stage below runs to completion whether or
  // not the AI budget was exhausted above. This is the fix for "one AI backlog
  // stops 50 already-diagnosed leads becoming Personalisation -> Demo ->
  // OUTBOUND in the same run".
  const personalisationSummary = await rebuildAllPersonalisation(snapshot, probesById, { probeIds });

  let demosSummary;
  try {
    demosSummary = await compileDemos(snapshot, {
      probeIds,
      justPersonalised: personalisationSummary.personalised_probe_ids,
      compiledBy: 'auto',
      maxCompiles: opts.maxDemoCompiles,
      maxImageFetches: opts.maxDemoImageFetches,
    });
  } catch (err) {
    // A demo problem must never take down a pass that already wrote
    // INTELLIGENCE, DIAGNOSIS and PERSONALISATION successfully.
    demosSummary = { demos_compiled: 0, demos_created: 0, remaining_demos: 0, problems: [{ error: err?.message || String(err) }] };
  }

  let outboundSummary;
  if (opts.rebuildOutbound) {
    outboundSummary = await rebuildOutbound(snapshot, { dryRun: false });
  }

  // D. THE EXPLANATION. Built from the post-write snapshot, so the counts are
  // what the sheet actually holds now, not what this run happened to touch.
  const [agenciesTable, intelligenceTable, diagnosisTable, personalisationTable] = await Promise.all([
    snapshot.getTable('AGENCIES'),
    snapshot.getTable('INTELLIGENCE'),
    snapshot.getTable('DIAGNOSIS'),
    snapshot.getTable('PERSONALISATION'),
  ]);
  let demosTable = { header: [], rows: [] };
  try { demosTable = await snapshot.getTable('DEMOS'); } catch { /* tab may not exist */ }
  let outboundTable = { header: [], rows: [] };
  try { outboundTable = await snapshot.getTable('OUTBOUND'); } catch { /* tab may not exist */ }

  const backlog = buildBacklogReport({
    PROBES: probesTable,
    AGENCIES: agenciesTable,
    INTELLIGENCE: intelligenceTable,
    DIAGNOSIS: diagnosisTable,
    PERSONALISATION: personalisationTable,
    DEMOS: demosTable,
    OUTBOUND: outboundTable,
  });

  // "complete" now means: nothing is waiting on anything this pass could have
  // done. A probe still inside its observation window is NOT incomplete work —
  // it is work that is not due yet — so it is reported separately and does not
  // hold the flag down.
  const complete = backlog.assessments_remaining === 0
    && backlog.personalisation_remaining === 0
    && (demosSummary.remaining_demos ?? 0) === 0
    && backlog.outbound_eligible_waiting === 0;

  return {
    ...intelligenceSummary,
    ...backlog,
    assessments_created: assessmentSummary.assessments_created,
    ai_calls_used: assessmentSummary.ai_calls_used,
    personalisation_created: personalisationSummary.personalisation_created,
    demos_created: demosSummary.demos_created ?? 0,
    outbound_created: outboundSummary?.create_count ?? 0,
    assessment: assessmentSummary,
    personalisation: personalisationSummary,
    demos: demosSummary,
    ...(outboundSummary ? { outbound: outboundSummary } : {}),
    // Every agency this pass produced new evidence for. The nightly ACTIONS
    // reconciler uses it to reconcile ONLY what changed instead of sweeping
    // every agency on the sheet.
    affected_agency_ids: [...new Set(
      [...assessmentSummary.assessed_probe_ids, ...personalisationSummary.personalised_probe_ids]
        .map((probeId) => text(probesById.get(probeId)?.agency_id))
        .filter(Boolean),
    )],
    sheets: snapshot.snapshotStats(),
    complete,
  };
}
