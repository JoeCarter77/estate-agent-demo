// lib/rebuild-pass.mjs — the one combined "recompute INTELLIGENCE, then
// DIAGNOSIS for whatever just closed, then PERSONALISATION, then the DEMO"
// pass, shared by:
//   - api/novus/intelligence/rebuild-all.js  — the human "Rebuild Intelligence"
//     button, full-rebuild branch (batched, AI-call budgeted per request)
//   - api/novus/intelligence/finalize.js     — the Vercel Cron entry point
//     that automatically closes/finalises probes once their 4-day
//     observation window has elapsed, with zero communications or many
//
// All callers need exactly the same four steps in the same order — run
// lib/intelligence-rebuild.mjs over every non-finalised probe (self-heals
// deterministic fields; AI-interprets only what's never been interpreted,
// or is forced), then lib/diagnosis-rebuild.mjs over whatever INTELLIGENCE
// rows are now closed and undiagnosed, then lib/personalisation-rebuild.mjs
// over whatever DIAGNOSIS rows are now finalised and unpersonalised —
// sharing one AI-call budget across all three steps so a single invocation
// never exceeds it — and finally lib/demo-compile.mjs over whatever
// PERSONALISATION just wrote. Factored out here so that logic can't drift
// between the manual and automatic entry points.
//
// THE DEMO STEP IS WHY THERE IS NO MANUAL BUILD. It runs in the SAME
// invocation as the personalisation that produced the story, so a probe that
// finishes personalisation comes out of this pass with a live
// /demo/{demo_slug} already compiled. It makes no AI calls and takes no share
// of the AI budget; it is bounded by its own compile and image-fetch budgets
// (see lib/demo-compile.mjs), and whatever it cannot reach this pass it picks
// up on the next one. It is also the last step for a reason: it can never
// fail the pipeline, because everything it reads has already been written.
//
// A probe whose Diagnosis is already finalised (non-blank diagnosis_summary)
// is skipped by the first two steps — see the "frozen" comments in
// lib/intelligence-rebuild.mjs and lib/diagnosis-rebuild.mjs. A probe whose
// Personalisation is already written (non-blank primary_narrative) is
// skipped the same way by the third — lib/personalisation-rebuild.mjs.
//
// opts.probeIds restricts ALL THREE steps to exactly the listed probe_ids —
// every other probe is skipped before any other check, in every step. Use
// it to run a known handful of probes (e.g. for testing) without a full
// rebuild sweeping up every other eligible probe on the sheet — see the
// "IMPORTANT" note in lib/personalisation-rebuild.mjs's file header for why
// that sweep can catch far more than intended on an otherwise-untouched
// PERSONALISATION tab.

import { rebuildAllIntelligence } from './intelligence-rebuild.mjs';
import { rebuildAllDiagnosis } from './diagnosis-rebuild.mjs';
import { rebuildAllPersonalisation } from './personalisation-rebuild.mjs';
import { compileDemos } from './demo-compile.mjs';
import { rebuildOutbound } from './outbound.mjs';

// repo, opts?: { forceAi?: boolean, maxAiCalls?: number, probeIds?: string[],
//                maxDemoCompiles?: number, maxDemoImageFetches?: number,
//                rebuildOutbound?: boolean }
// -> intelligence summary fields, plus { diagnosis: <diagnosis summary>,
// personalisation: <personalisation summary>, demos: <demo summary>,
// complete: boolean }.
// complete is true once none of the three steps has any remaining budget-
// starved work — i.e. every non-finalised probe (within probeIds, if given)
// is fully interpreted and, if closed, diagnosed and, if diagnosed,
// personalised. forceAi only ever affects the INTELLIGENCE step (re-
// interpret a probe that isn't finalised yet); DIAGNOSIS and PERSONALISATION
// have no forced-refresh path once written — see their file headers.
export async function runRebuildPass(repo, opts = {}) {
  const forceAi = Boolean(opts.forceAi);
  const maxAiCalls = Number.isFinite(opts.maxAiCalls) ? opts.maxAiCalls : Infinity;
  const probeIds = Array.isArray(opts.probeIds) && opts.probeIds.length > 0 ? opts.probeIds : null;

  const intelligenceSummary = await rebuildAllIntelligence(repo, { forceAi, maxAiCalls, probeIds });

  // Diagnosis gets whatever's left of this invocation's AI-call budget after
  // interpretation spent its share, so one call never runs more than
  // maxAiCalls AI calls total.
  const diagnosisBudget = Math.max(0, maxAiCalls - intelligenceSummary.ai_interpretations_run);

  // DIAGNOSIS and PERSONALISATION prompts both need the probe's property/
  // price for context — loaded once here rather than inside either rebuild
  // loop.
  const probeRecords = await repo.getRecords('PROBES', 'probe_id');
  const probesById = new Map(probeRecords.map((r) => [r.obj.probe_id, r.obj]));

  const diagnosisSummary = await rebuildAllDiagnosis(repo, probesById, { maxAiCalls: diagnosisBudget, probeIds });

  // Personalisation gets whatever's left after Intelligence and Diagnosis.
  const personalisationBudget = Math.max(0, diagnosisBudget - diagnosisSummary.ai_diagnoses_run);
  const personalisationSummary = await rebuildAllPersonalisation(repo, probesById, { maxAiCalls: personalisationBudget, probeIds });

  // DEMOS — the last step of the pipeline, and the reason no human runs a
  // build command. Every probe this pass just personalised is compiled here
  // and now; on top of that the step self-heals any already-personalised probe
  // that has no demo row yet (a tab created after the fact, an earlier
  // budget-capped pass, a row deleted by hand).
  //
  // Deliberately never allowed to throw: a demo problem must not take down the
  // pipeline step that already wrote INTELLIGENCE, DIAGNOSIS and
  // PERSONALISATION successfully.
  let demosSummary;
  try {
    demosSummary = await compileDemos(repo, {
      probeIds,
      justPersonalised: personalisationSummary.personalised_probe_ids,
      compiledBy: 'auto',
      maxCompiles: opts.maxDemoCompiles,
      maxImageFetches: opts.maxDemoImageFetches,
    });
  } catch (err) {
    demosSummary = { demos_compiled: 0, problems: [{ error: err?.message || String(err) }] };
  }

  // The nightly finalisation cron opts into this only after the normal
  // pipeline (including DEMOS) has completed. Reuse the existing deterministic
  // OUTBOUND compiler so its eligibility gates and SENT/SUPPRESSED preservation
  // rules remain the single source of truth.
  let outboundSummary;
  if (opts.rebuildOutbound) {
    outboundSummary = await rebuildOutbound(repo, { dryRun: false });
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
    complete,
  };
}
