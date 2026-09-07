import { ACQUISITION_REQUIRED_TABS, buildAgencyEvidence } from './operator-funnel.mjs';
import { deriveExpectedActions, reconcileActions } from './acquisition-actions.mjs';
import { ACTIONS_TAB, buildActionAppendPlan, buildActionPatchPlan, patchAction, readActions } from './actions-store.mjs';
// ONE definition of "sent". The reconciler resolves the same stages the
// dashboard does, so it must read the same canonical execution state — two
// separate reads would let the ledger and the Command Centre disagree about
// whether email 1 went out.
import { loadOutreachExecutionState } from './instantly-execution-state.mjs';

// Every stage a lead handed to Instantly can legitimately occupy. Named once
// so a new executed-sequence stage cannot be added to the resolver and
// silently forgotten here.
const HANDED_TO_INSTANTLY_STAGES = Object.freeze([
  'WAITING_FOR_FIRST_EMAIL', 'EMAIL_1_SENT', 'FOLLOWUP_1_SENT', 'FOLLOWUP_2_SENT', 'SEQUENCE_RUNNING',
]);

// The two SYSTEM checkpoints whose identity depends on Instantly execution
// state, and therefore the only two a degraded read can get wrong.
const OUTREACH_CHECKPOINT_TYPES = new Set(['FIRST_EMAIL_CHECKPOINT', 'SEQUENCE_CHECKPOINT']);

const COMPLETION_TRANSITIONS = Object.freeze({
  PROBE_AGENCY: ['PROBE_IN_PROGRESS', 'PROBE_OBSERVING', 'PROBE_COMPLETE', 'PREPARING_OUTREACH', 'READY_FOR_OUTREACH'],
  COMPLETE_PROBE: ['PROBE_OBSERVING', 'PROBE_COMPLETE', 'PREPARING_OUTREACH', 'READY_FOR_OUTREACH'],
  OBSERVATION_CHECKPOINT: ['PROBE_COMPLETE', 'PREPARING_OUTREACH', 'READY_FOR_OUTREACH'],
  PREPARE_OUTREACH: ['READY_FOR_OUTREACH', ...HANDED_TO_INSTANTLY_STAGES],
  HANDOFF_TO_INSTANTLY: [...HANDED_TO_INSTANTLY_STAGES],
  // A first-email checkpoint is DONE the moment Instantly proves email 1 left,
  // at whatever step the sequence has since reached. Completing it (rather
  // than cancelling it) keeps the ledger's history honest.
  FIRST_EMAIL_CHECKPOINT: ['EMAIL_1_SENT', 'FOLLOWUP_1_SENT', 'FOLLOWUP_2_SENT', 'SEQUENCE_RUNNING'],
  HUMAN_REPLY: ['MANUAL_REPLY_SENT_WAITING'],
  MANUAL_REVIEW: ['MANUAL_REPLY_SENT_WAITING'],
  SEND_DEMO: ['DEMO_SENT_UNOPENED', 'DEMO_OPENED', 'DEMO_ENGAGED', 'DEMO_FOLLOWUP_SENT'],
  DEMO_UNOPENED_FOLLOWUP: ['DEMO_FOLLOWUP_SENT'],
  DEMO_OPENED_FOLLOWUP: ['DEMO_FOLLOWUP_SENT'],
});

function completedByStage(action, stage) {
  return (COMPLETION_TRANSITIONS[String(action?.action_type || '').toUpperCase()] || []).includes(stage);
}

// Loads every tab the evidence builder needs IN PARALLEL — one request each,
// and none at all for a tab an invocation-scoped snapshot has already cached
// (lib/pipeline-snapshot.mjs). The two optional tabs degrade to empty rather
// than taking the reconciliation down.
export async function loadActionEngineTables(repo) {
  const required = await Promise.all(ACQUISITION_REQUIRED_TABS.map(async (tab) => [tab, await repo.getTable(tab)]));
  const optional = await Promise.all(['SALES_MESSAGES', ACTIONS_TAB].map(async (tab) => {
    try { return [tab, await repo.getTable(tab)]; } catch { return [tab, { header: [], rows: [] }]; }
  }));
  return Object.fromEntries([...required, ...optional]);
}

// The OUTBOUND addresses that carry an instantly_lead_id. Passing them to the
// execution loader is what lets a handed lead with no observed send resolve to
// a positive "waiting for email 1" rather than to "no data".
export function handedOutreachEmails(tables) {
  const header = tables?.OUTBOUND?.header || [];
  const emailAt = header.indexOf('outreach_contact_email');
  const leadAt = header.indexOf('instantly_lead_id');
  if (emailAt < 0 || leadAt < 0) return [];
  return (tables.OUTBOUND.rows || []).flatMap((row) => {
    const email = String(row[emailAt] ?? '').trim();
    const leadId = String(row[leadAt] ?? '').trim();
    return email && leadId ? [email] : [];
  });
}

// ── THE RECONCILER ──────────────────────────────────────────────────────────
//
// LOAD ONCE, PLAN IN MEMORY, WRITE IN BATCH. It used to re-read the whole
// ACTIONS tab for every action it created (appendAction's own duplicate check)
// and issue a read-modify-write for every action it patched (updateById =
// getTable + getRecords + update). With A agencies each producing an action,
// that is O(A) Sheets round-trips to write O(A) rows, on a per-minute quota
// shared with the live Command Centre.
//
// Now: ACTIONS is read ONCE, every create/update/complete/cancel is decided and
// deduped in memory across ALL agencies, and the result goes out as one batched
// append plus one batched row-patch. The number of Sheets requests is bounded by
// the batch chunk size, not by the number of agencies or actions.
//
// SCOPE. agencyIds/agencyId restrict reconciliation to the agencies whose
// evidence actually changed — what the nightly cron passes, so a routine run
// reconciles what moved rather than sweeping the whole sheet. Omitting both
// still reconciles everything, which is the explicit full-recovery operation.
//
// The claim store is deliberately NOT used on this path any more: it existed to
// serialise concurrent per-row appends, and there are no per-row appends left.
// In-memory dedupe by dedupe_key across the whole batch is strictly stronger,
// because it also catches two agencies deriving the same key in one pass.
export async function reconcileActionEngine(repo, { now = new Date().toISOString(), agencyId = '', agencyIds = [], execution = undefined } = {}) {
  const actionRead = await readActions(repo);
  if (!actionRead.available) return { available: false, created: 0, updated: 0, cancelled: 0, error: actionRead.error };
  const tables = await loadActionEngineTables(repo);
  // Read-only, cached, and soft-failing: an unavailable Instantly read leaves
  // every handed lead on its stored-evidence stage, exactly as before.
  const outreachExecution = execution !== undefined
    ? execution
    : await loadOutreachExecutionState({ handedEmails: handedOutreachEmails(tables) });
  const wanted = new Set((agencyIds || []).map((value) => String(value).trim()).filter(Boolean));
  if (agencyId) wanted.add(String(agencyId).trim());
  const scoped = wanted.size > 0;
  const evidence = buildAgencyEvidence(tables, { now, execution: outreachExecution })
    .filter((row) => !scoped || wanted.has(String(row.agency?.agency_id).trim()));

  const summary = {
    available: true,
    created: 0,
    updated: 0,
    completed: 0,
    cancelled: 0,
    agencies: evidence.length,
    scope: scoped ? 'affected_agencies' : 'all_agencies',
  };

  const creates = [];
  const patches = [];

  for (const item of evidence) {
    const expected = deriveExpectedActions(item, now);
    // DEGRADED-READ GUARD. Without Instantly execution state a handed lead
    // resolves to WAITING_FOR_FIRST_EMAIL even when email 1 demonstrably went
    // out. Reconciling on that guess would cancel a live SEQUENCE_CHECKPOINT
    // and recreate it on the next healthy pass — ledger churn caused purely by
    // a failed read. The outreach checkpoints are therefore left untouched
    // until the read succeeds. Nothing else is skipped: every human action and
    // every non-outreach checkpoint still reconciles normally, and a lead with
    // no expected action still has its stale rows cancelled.
    if (outreachExecution?.available !== true
        && String(item.outbound?.instantly_lead_id || '').trim()
        && expected.length === 1
        && OUTREACH_CHECKPOINT_TYPES.has(String(expected[0].action_type))) {
      summary.outreach_checkpoints_deferred = (summary.outreach_checkpoints_deferred || 0) + 1;
      continue;
    }
    const plan = reconcileActions(item.actions, expected, now);
    creates.push(...plan.create);
    for (const change of plan.cancel) {
      const existing = item.actions.find((row) => String(row.action_id).trim() === String(change.action_id).trim());
      if (completedByStage(existing, item.stage)) {
        change.patch = { action_status: 'COMPLETED', completed_at: now, updated_at: now, completion_reason: `Lifecycle advanced to ${item.stage}` };
      }
    }
    patches.push(...plan.update, ...plan.cancel);
  }

  // ONE append plan and ONE patch plan for the whole run. Both are computed
  // against the single ACTIONS snapshot loaded above.
  const actionsTable = tables[ACTIONS_TAB];
  const appendPlan = buildActionAppendPlan(actionsTable, creates, now);
  const patchPlan = buildActionPatchPlan(actionsTable, patches);

  if (appendPlan.appendRows.length) await repo.appendRowsBatch(ACTIONS_TAB, appendPlan.appendRows);
  if (patchPlan.writes.length) {
    // The batch write is the point of this rewrite, and it is what the real
    // repo (and the invocation-scoped snapshot in front of it) always does.
    // A minimal repo that implements only the single-record writers still
    // works, one patch at a time — the dedupe and the planning above already
    // happened in memory, so the fallback costs requests but never
    // correctness.
    if (typeof repo.writeRowsBatch === 'function') await repo.writeRowsBatch(patchPlan.writes);
    else for (const { action_id: actionId, patch } of patches) await patchAction(repo, actionId, patch);
  }

  summary.created = appendPlan.rows.length;
  if (appendPlan.skipped_duplicate) summary.creates_deduped = appendPlan.skipped_duplicate;
  if (appendPlan.errors.length) summary.create_errors = appendPlan.errors;
  if (patchPlan.missing.length) summary.patch_targets_missing = patchPlan.missing;
  for (const { patch } of patches) {
    if (patch.action_status === 'CANCELLED') summary.cancelled += 1;
    else if (patch.action_status === 'COMPLETED') summary.completed += 1;
    else summary.updated += 1;
  }
  return summary;
}

// Event hooks must never destabilise the live path that produced the evidence.
export async function reconcileAgencyActionsBestEffort(repo, agencyId, context = '') {
  try { return await reconcileActionEngine(repo, { agencyId }); }
  catch (err) {
    console.error(`action reconciliation failed${context ? ` after ${context}` : ''}:`, err?.message || err);
    return { available: false, error: err?.message || 'action reconciliation failed' };
  }
}
