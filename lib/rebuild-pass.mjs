// lib/rebuild-pass.mjs — the one combined "recompute INTELLIGENCE, then
// DIAGNOSIS for whatever just closed" pass, shared by:
//   - api/novus/intelligence/rebuild-all.js  — the human "Rebuild Intelligence"
//     button, full-rebuild branch (batched, AI-call budgeted per request)
//   - api/novus/intelligence/finalize.js     — the Vercel Cron entry point
//     that automatically closes/finalises probes once their 4-day
//     observation window has elapsed, with zero communications or many
//
// All callers need exactly the same three steps in the same order — run
// lib/intelligence-rebuild.mjs over every non-finalised probe (self-heals
// deterministic fields; AI-interprets only what's never been interpreted,
// or is forced), then lib/diagnosis-rebuild.mjs over whatever INTELLIGENCE
// rows are now closed and undiagnosed, then lib/personalisation-rebuild.mjs
// over whatever DIAGNOSIS rows are now finalised and unpersonalised —
// sharing one AI-call budget across all three steps so a single invocation
// never exceeds it. Factored out here so that logic can't drift between the
// manual and automatic entry points.
//
// A probe whose Diagnosis is already finalised (non-blank diagnosis_summary)
// is skipped by the first two steps — see the "frozen" comments in
// lib/intelligence-rebuild.mjs and lib/diagnosis-rebuild.mjs. A probe whose
// Personalisation is already written (non-blank personalised_opener) is
// skipped the same way by the third — lib/personalisation-rebuild.mjs.

import { rebuildAllIntelligence } from './intelligence-rebuild.mjs';
import { rebuildAllDiagnosis } from './diagnosis-rebuild.mjs';
import { rebuildAllPersonalisation } from './personalisation-rebuild.mjs';

// repo, opts?: { forceAi?: boolean, maxAiCalls?: number } -> intelligence
// summary fields, plus { diagnosis: <diagnosis summary>,
// personalisation: <personalisation summary>, complete: boolean }.
// complete is true once none of the three steps has any remaining budget-
// starved work — i.e. every non-finalised probe is fully interpreted and,
// if closed, diagnosed and, if diagnosed, personalised. forceAi only ever
// affects the INTELLIGENCE step (re-interpret a probe that isn't finalised
// yet); DIAGNOSIS and PERSONALISATION have no forced-refresh path once
// written — see their file headers.
export async function runRebuildPass(repo, opts = {}) {
  const forceAi = Boolean(opts.forceAi);
  const maxAiCalls = Number.isFinite(opts.maxAiCalls) ? opts.maxAiCalls : Infinity;

  const intelligenceSummary = await rebuildAllIntelligence(repo, { forceAi, maxAiCalls });

  // Diagnosis gets whatever's left of this invocation's AI-call budget after
  // interpretation spent its share, so one call never runs more than
  // maxAiCalls AI calls total.
  const diagnosisBudget = Math.max(0, maxAiCalls - intelligenceSummary.ai_interpretations_run);

  // DIAGNOSIS and PERSONALISATION prompts both need the probe's property/
  // price for context — loaded once here rather than inside either rebuild
  // loop.
  const probeRecords = await repo.getRecords('PROBES', 'probe_id');
  const probesById = new Map(probeRecords.map((r) => [r.obj.probe_id, r.obj]));

  const diagnosisSummary = await rebuildAllDiagnosis(repo, probesById, { maxAiCalls: diagnosisBudget });

  // Personalisation gets whatever's left after Intelligence and Diagnosis.
  const personalisationBudget = Math.max(0, diagnosisBudget - diagnosisSummary.ai_diagnoses_run);
  const personalisationSummary = await rebuildAllPersonalisation(repo, probesById, { maxAiCalls: personalisationBudget });

  const complete = intelligenceSummary.remaining_interpretations === 0
    && diagnosisSummary.remaining_diagnoses === 0
    && personalisationSummary.remaining_personalisations === 0;

  return { ...intelligenceSummary, diagnosis: diagnosisSummary, personalisation: personalisationSummary, complete };
}
