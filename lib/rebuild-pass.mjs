// lib/rebuild-pass.mjs — the lean acquisition rebuild pass.
//
// Acquisition now has one model boundary: final semantic interpretation of a
// closed probe's complete communication history. Everything before that is
// deterministic observation; everything after it (Diagnosis, Personalisation,
// Demo and OUTBOUND compilation) is deterministic projection of evidence that
// has already been interpreted. All stages share one request-scoped Sheets
// cache for the lifetime of the invocation.

import { rebuildAcquisitionIntelligence } from './acquisition-intelligence-rebuild.mjs';
import { rebuildAcquisitionDiagnosis } from './acquisition-diagnosis-rebuild.mjs';
import { rebuildAcquisitionPersonalisation } from './acquisition-personalisation-rebuild.mjs';
import { compileDemos } from './demo-compile.mjs';
import { rebuildOutbound } from './outbound.mjs';
import { createCachedRepo } from './cached-repo.mjs';

// repo, opts?: { maxAiCalls?: number, aiConcurrency?: number, probeIds?: string[],
//                maxDemoCompiles?: number, maxDemoImageFetches?: number,
//                rebuildOutbound?: boolean }
export async function runRebuildPass(repo, opts = {}) {
  const workRepo = createCachedRepo(repo);
  const maxAiCalls = Number.isFinite(opts.maxAiCalls) ? opts.maxAiCalls : Infinity;
  const probeIds = Array.isArray(opts.probeIds) && opts.probeIds.length > 0 ? opts.probeIds : null;

  const intelligenceSummary = await rebuildAcquisitionIntelligence(workRepo, {
    maxAiCalls,
    aiConcurrency: opts.aiConcurrency,
    probeIds,
  });

  const probeRecords = await workRepo.getRecords('PROBES', 'probe_id');
  const probesById = new Map(probeRecords.map((record) => [record.obj.probe_id, record.obj]));

  // Diagnosis is now a deterministic projection of the final structured
  // Intelligence. Only probes whose final interpretation completed in this
  // pass are eligible, which prevents a budget-starved closed probe from being
  // diagnosed off stale partial AI fields left by the old eager architecture.
  const diagnosisSummary = await rebuildAcquisitionDiagnosis(workRepo, probesById, {
    probeIds,
    finalizedIntelligenceProbeIds: intelligenceSummary.finalized_intelligence_probe_ids,
  });

  // Historical diagnoses that already exist but never made it through the old
  // AI-starved Personalisation stage are swept up here at zero model cost.
  const personalisationSummary = await rebuildAcquisitionPersonalisation(workRepo, probesById, {
    probeIds,
  });

  let demosSummary;
  try {
    demosSummary = await compileDemos(workRepo, {
      probeIds,
      justPersonalised: personalisationSummary.personalised_probe_ids,
      compiledBy: 'auto',
      // Row compilation is cheap. Keep the image-fetch budget separately
      // bounded, but do not make a 25-row renderer cap turn into a multi-day
      // acquisition backlog.
      maxCompiles: Number.isFinite(opts.maxDemoCompiles) ? opts.maxDemoCompiles : 100,
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
      interpretation_used: intelligenceSummary.ai_interpretations_run,
      diagnosis_used: 0,
      personalisation_used: 0,
      concurrency: intelligenceSummary.ai_concurrency,
    },
    complete,
  };
}
