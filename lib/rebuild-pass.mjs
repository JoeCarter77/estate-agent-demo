// lib/rebuild-pass.mjs — the combined acquisition rebuild pass.
//
// The acquisition pipeline now keeps expensive model work to the two places
// that genuinely interpret evidence: final INTELLIGENCE interpretation and
// DIAGNOSIS. PERSONALISATION is a deterministic rendering of already-selected,
// evidence-gated facts. All stages share one request-scoped cached repository
// so the same Sheet tab is not downloaded repeatedly inside one invocation.

import { rebuildAllIntelligence } from './intelligence-rebuild.mjs';
import { rebuildAllDiagnosis } from './diagnosis-rebuild.mjs';
import { rebuildAcquisitionPersonalisation } from './acquisition-personalisation-rebuild.mjs';
import { compileDemos } from './demo-compile.mjs';
import { rebuildOutbound } from './outbound.mjs';
import { createCachedRepo } from './cached-repo.mjs';

// repo, opts?: { forceAi?: boolean, maxAiCalls?: number, probeIds?: string[],
//                maxDemoCompiles?: number, maxDemoImageFetches?: number,
//                rebuildOutbound?: boolean }
export async function runRebuildPass(repo, opts = {}) {
  const workRepo = createCachedRepo(repo);
  const forceAi = Boolean(opts.forceAi);
  const maxAiCalls = Number.isFinite(opts.maxAiCalls) ? opts.maxAiCalls : Infinity;
  const probeIds = Array.isArray(opts.probeIds) && opts.probeIds.length > 0 ? opts.probeIds : null;

  // A full acquisition sweep must never let a historical interpretation
  // backlog consume the entire request budget before DIAGNOSIS gets a turn.
  // Reserve roughly 60% of a bounded normal pass for downstream diagnosis.
  // Targeted/debug runs keep the old full-budget behaviour because the caller
  // explicitly chose exactly which probes should be worked.
  const intelligenceBudget = Number.isFinite(maxAiCalls) && !probeIds
    ? Math.max(1, Math.floor(maxAiCalls * 0.4))
    : maxAiCalls;

  const intelligenceSummary = await rebuildAllIntelligence(workRepo, {
    forceAi,
    maxAiCalls: intelligenceBudget,
    probeIds,
  });

  // Only calls actually spent upstream are subtracted. If Intelligence has no
  // backlog, Diagnosis receives the whole request budget automatically.
  const diagnosisBudget = Math.max(0, maxAiCalls - intelligenceSummary.ai_interpretations_run);

  const probeRecords = await workRepo.getRecords('PROBES', 'probe_id');
  const probesById = new Map(probeRecords.map((record) => [record.obj.probe_id, record.obj]));

  const diagnosisSummary = await rebuildAllDiagnosis(workRepo, probesById, {
    maxAiCalls: diagnosisBudget,
    probeIds,
  });

  // Acquisition personalisation performs zero AI calls. It renders the
  // canonical PERSONALISATION_FACTS through the same deterministic renderer
  // that previously existed only as the AI fallback, then runs the existing
  // factual validators before persisting anything.
  const personalisationSummary = await rebuildAcquisitionPersonalisation(workRepo, probesById, {
    probeIds,
  });

  let demosSummary;
  try {
    demosSummary = await compileDemos(workRepo, {
      probeIds,
      justPersonalised: personalisationSummary.personalised_probe_ids,
      compiledBy: 'auto',
      maxCompiles: opts.maxDemoCompiles,
      maxImageFetches: opts.maxDemoImageFetches,
    });
  } catch (err) {
    demosSummary = { demos_compiled: 0, problems: [{ error: err?.message || String(err) }] };
  }

  let outboundSummary;
  if (opts.rebuildOutbound) {
    outboundSummary = await rebuildOutbound(workRepo, { dryRun: false });
  }

  const complete = intelligenceSummary.remaining_interpretations === 0
    && diagnosisSummary.remaining_diagnoses === 0
    && personalisationSummary.remaining_personalisations === 0
    && (demosSummary.remaining_demos ?? 0) === 0;

  return {
    ...intelligenceSummary,
    diagnosis: diagnosisSummary,
    personalisation: personalisationSummary,
    demos: demosSummary,
    ...(outboundSummary ? { outbound: outboundSummary } : {}),
    ai_budget: {
      total: Number.isFinite(maxAiCalls) ? maxAiCalls : null,
      intelligence_reserved_max: Number.isFinite(intelligenceBudget) ? intelligenceBudget : null,
      intelligence_used: intelligenceSummary.ai_interpretations_run,
      diagnosis_available: Number.isFinite(diagnosisBudget) ? diagnosisBudget : null,
      diagnosis_used: diagnosisSummary.ai_diagnoses_run,
      personalisation_used: 0,
    },
    complete,
  };
}
