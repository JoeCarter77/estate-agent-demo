// lib/rebuild-pass.mjs — the one combined "recompute INTELLIGENCE, then
// DIAGNOSIS for whatever just closed" pass, shared by:
//   - api/novus/intelligence/rebuild-all.js  — the human "Rebuild Intelligence"
//     button, full-rebuild branch (batched, AI-call budgeted per request)
//   - api/novus/intelligence/finalize.js     — the Vercel Cron entry point
//     that automatically closes/finalises probes once their 4-day
//     observation window has elapsed, with zero communications or many
//
// Both callers need exactly the same two steps in the same order — run
// lib/intelligence-rebuild.mjs over every non-finalised probe (self-heals
// deterministic fields; AI-interprets only what's never been interpreted,
// or is forced), then lib/diagnosis-rebuild.mjs over whatever INTELLIGENCE
// rows are now closed and undiagnosed — sharing one AI-call budget across
// both steps so a single invocation never exceeds it. Factored out here so
// that logic can't drift between the manual and automatic entry points.
//
// A probe whose Diagnosis is already finalised (non-blank diagnosis_summary)
// is skipped entirely by both steps — see the "frozen" comments in
// lib/intelligence-rebuild.mjs and lib/diagnosis-rebuild.mjs.

import { rebuildAllIntelligence } from './intelligence-rebuild.mjs';
import { rebuildAllDiagnosis } from './diagnosis-rebuild.mjs';

// repo, opts?: { forceAi?: boolean, maxAiCalls?: number } -> intelligence
// summary fields, plus { diagnosis: <diagnosis summary>, complete: boolean }.
// complete is true once neither step has any remaining budget-starved work —
// i.e. every non-finalised probe is now fully interpreted and, if closed,
// diagnosed. forceAi only ever affects the INTELLIGENCE step (re-interpret a
// probe that isn't finalised yet); DIAGNOSIS has no forced-refresh path once
// written — see lib/diagnosis-rebuild.mjs's file header.
export async function runRebuildPass(repo, opts = {}) {
  const forceAi = Boolean(opts.forceAi);
  const maxAiCalls = Number.isFinite(opts.maxAiCalls) ? opts.maxAiCalls : Infinity;

  const intelligenceSummary = await rebuildAllIntelligence(repo, { forceAi, maxAiCalls });

  // Diagnosis gets whatever's left of this invocation's AI-call budget after
  // interpretation spent its share, so one call never runs more than
  // maxAiCalls AI calls total.
  const diagnosisBudget = Math.max(0, maxAiCalls - intelligenceSummary.ai_interpretations_run);

  // DIAGNOSIS prompts need the probe's property/price for context — loaded
  // once here rather than inside the rebuild loop.
  const probeRecords = await repo.getRecords('PROBES', 'probe_id');
  const probesById = new Map(probeRecords.map((r) => [r.obj.probe_id, r.obj]));

  const diagnosisSummary = await rebuildAllDiagnosis(repo, probesById, { maxAiCalls: diagnosisBudget });

  const complete = intelligenceSummary.remaining_interpretations === 0
    && diagnosisSummary.remaining_diagnoses === 0;

  return { ...intelligenceSummary, diagnosis: diagnosisSummary, complete };
}
