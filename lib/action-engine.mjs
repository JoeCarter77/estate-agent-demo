import { ACQUISITION_REQUIRED_TABS, buildAgencyEvidence } from './operator-funnel.mjs';
import { deriveExpectedActions, reconcileActions } from './acquisition-actions.mjs';
import { appendAction, patchAction, readActions } from './actions-store.mjs';
import { getClaimStore } from './reply-claim.mjs';

const COMPLETION_TRANSITIONS = Object.freeze({
  PROBE_AGENCY: ['PROBE_IN_PROGRESS', 'PROBE_OBSERVING', 'PROBE_COMPLETE', 'PREPARING_OUTREACH', 'READY_FOR_OUTREACH'],
  COMPLETE_PROBE: ['PROBE_OBSERVING', 'PROBE_COMPLETE', 'PREPARING_OUTREACH', 'READY_FOR_OUTREACH'],
  OBSERVATION_CHECKPOINT: ['PROBE_COMPLETE', 'PREPARING_OUTREACH', 'READY_FOR_OUTREACH'],
  PREPARE_OUTREACH: ['READY_FOR_OUTREACH', 'WAITING_FOR_FIRST_EMAIL', 'SEQUENCE_RUNNING'],
  HANDOFF_TO_INSTANTLY: ['WAITING_FOR_FIRST_EMAIL', 'SEQUENCE_RUNNING'],
  FIRST_EMAIL_CHECKPOINT: ['SEQUENCE_RUNNING'],
  HUMAN_REPLY: ['MANUAL_REPLY_SENT_WAITING'],
  MANUAL_REVIEW: ['MANUAL_REPLY_SENT_WAITING'],
  SEND_DEMO: ['DEMO_SENT_UNOPENED', 'DEMO_OPENED', 'DEMO_ENGAGED', 'DEMO_FOLLOWUP_SENT'],
  DEMO_UNOPENED_FOLLOWUP: ['DEMO_FOLLOWUP_SENT'],
  DEMO_OPENED_FOLLOWUP: ['DEMO_FOLLOWUP_SENT'],
});

function completedByStage(action, stage) {
  return (COMPLETION_TRANSITIONS[String(action?.action_type || '').toUpperCase()] || []).includes(stage);
}

export async function loadActionEngineTables(repo) {
  const pairs = await Promise.all(ACQUISITION_REQUIRED_TABS.map(async (tab) => [tab, await repo.getTable(tab)]));
  for (const tab of ['SALES_MESSAGES', 'ACTIONS']) {
    try { pairs.push([tab, await repo.getTable(tab)]); } catch { pairs.push([tab, { header: [], rows: [] }]); }
  }
  return Object.fromEntries(pairs);
}

export async function reconcileActionEngine(repo, { now = new Date().toISOString(), agencyId = '', agencyIds = [] } = {}) {
  const actionRead = await readActions(repo);
  if (!actionRead.available) return { available: false, created: 0, updated: 0, cancelled: 0, error: actionRead.error };
  const tables = await loadActionEngineTables(repo);
  let claimStore = null;
  try { claimStore = getClaimStore(); } catch { /* Sequential Sheets check remains the safe fallback. */ }
  const wanted = new Set((agencyIds || []).map((value) => String(value).trim()).filter(Boolean));
  if (agencyId) wanted.add(String(agencyId).trim());
  const evidence = buildAgencyEvidence(tables, { now }).filter((row) => !wanted.size || wanted.has(String(row.agency?.agency_id).trim()));
  const summary = { available: true, created: 0, updated: 0, completed: 0, cancelled: 0, agencies: evidence.length };
  for (const item of evidence) {
    const expected = deriveExpectedActions(item, now);
    const plan = reconcileActions(item.actions, expected, now);
    for (const row of plan.create) {
      const result = await appendAction(repo, row, now, { claimStore });
      if (!result.reused) summary.created += 1;
    }
    for (const change of plan.cancel) {
      const existing = item.actions.find((row) => String(row.action_id).trim() === String(change.action_id).trim());
      if (completedByStage(existing, item.stage)) {
        change.patch = { action_status: 'COMPLETED', completed_at: now, updated_at: now, completion_reason: `Lifecycle advanced to ${item.stage}` };
      }
    }
    for (const change of [...plan.update, ...plan.cancel]) {
      await patchAction(repo, change.action_id, change.patch);
      if (change.patch.action_status === 'CANCELLED') summary.cancelled += 1;
      else if (change.patch.action_status === 'COMPLETED') summary.completed += 1;
      else summary.updated += 1;
    }
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
