import { newActionId } from './ids.mjs';
import { ACTION_OWNERS, ACTION_STATUSES, ACTION_TYPES } from './acquisition-actions.mjs';
import crypto from 'node:crypto';

export const ACTIONS_TAB = 'ACTIONS';
export const ACTIONS_HEADER = Object.freeze([
  'action_id', 'agency_id', 'outreach_id', 'probe_id', 'reply_event_id',
  'action_type', 'action_owner', 'action_status', 'due_at', 'reason',
  'source_stage', 'dedupe_key', 'created_at', 'updated_at', 'completed_at',
  'cancelled_at', 'completion_reason', 'error', 'metadata_json',
]);
export const ACTIONS_SCHEMA_NOTE = 'SCHEMA NOTE: durable acquisition action ledger. One active equivalent action per deterministic dedupe_key; history is never overwritten or deleted.';
const text = (value) => String(value ?? '').trim();

export function validateActionRow(row) {
  const errors = [];
  for (const key of ['action_id', 'agency_id', 'action_type', 'action_owner', 'action_status', 'dedupe_key', 'created_at', 'updated_at']) {
    if (!text(row?.[key])) errors.push(`${key} is required`);
  }
  if (text(row?.action_type) && !ACTION_TYPES.includes(text(row.action_type).toUpperCase())) errors.push('invalid action_type');
  if (text(row?.action_owner) && !ACTION_OWNERS.includes(text(row.action_owner).toUpperCase())) errors.push('invalid action_owner');
  if (text(row?.action_status) && !ACTION_STATUSES.includes(text(row.action_status).toUpperCase())) errors.push('invalid action_status');
  const unknown = Object.keys(row || {}).filter((key) => !ACTIONS_HEADER.includes(key));
  if (unknown.length) errors.push(`unknown column(s): ${unknown.join(', ')}`);
  return { valid: errors.length === 0, errors };
}

export function parseActionRecords(table) {
  const header = table?.header || [];
  const idIndex = header.indexOf('action_id');
  if (idIndex < 0) return [];
  return (table.rows || []).flatMap((row, index) => {
    const actionId = text(row[idIndex]);
    if (!actionId || actionId === 'SCHEMA NOTE') return [];
    return [{ rowNumber: index + 2, obj: Object.fromEntries(header.map((key, i) => [key, row[i] ?? ''])) }];
  });
}

export async function readActions(repo) {
  try {
    const table = await repo.getTable(ACTIONS_TAB);
    const exact = ACTIONS_HEADER.length === table.header.length && ACTIONS_HEADER.every((key, i) => table.header[i] === key);
    if (!exact) return { available: false, rows: [], error: 'ACTIONS header does not match the audited 19-column schema' };
    return { available: true, rows: parseActionRecords(table).map((record) => record.obj), error: null };
  } catch (err) {
    return { available: false, rows: [], error: err?.message || 'ACTIONS could not be read' };
  }
}

export function actionClaimKey(dedupeKey) {
  return `novus:action:${crypto.createHash('sha256').update(text(dedupeKey)).digest('hex')}`;
}

export async function appendAction(repo, input, now = new Date().toISOString(), { claimStore = null } = {}) {
  const row = { ...Object.fromEntries(ACTIONS_HEADER.map((key) => [key, ''])), ...input };
  row.action_id = text(row.action_id) || newActionId();
  row.created_at = text(row.created_at) || now;
  row.updated_at = now;
  row.metadata_json = text(row.metadata_json) || '{}';
  const validation = validateActionRow(row);
  if (!validation.valid) throw new Error(`invalid ACTIONS row: ${validation.errors.join('; ')}`);
  let claim = null;
  if (claimStore) {
    claim = await claimStore.acquire(actionClaimKey(row.dedupe_key), 60);
    if (!claim.acquired && claim.error) throw new Error(`action claim store unavailable: ${claim.error}`);
    if (!claim.acquired) return { row: null, reused: true, claim_conflict: true, claim_error: null };
  }
  try {
    const table = await repo.getTable(ACTIONS_TAB);
    if (table.header.length !== ACTIONS_HEADER.length || ACTIONS_HEADER.some((key, i) => table.header[i] !== key)) {
      throw new Error('ACTIONS header does not match the audited 19-column schema');
    }
    const duplicate = parseActionRecords(table).find((record) => text(record.obj.dedupe_key) === text(row.dedupe_key)
      && ['PENDING', 'DUE', 'IN_PROGRESS'].includes(text(record.obj.action_status).toUpperCase()));
    if (duplicate) return { row: duplicate.obj, reused: true };
    await repo.appendRowsBatch(ACTIONS_TAB, [ACTIONS_HEADER.map((key) => row[key] ?? '')]);
    return { row, reused: false };
  } finally {
    if (claimStore) await claimStore.release(actionClaimKey(row.dedupe_key), claim.token).catch(() => false);
  }
}

export async function patchAction(repo, actionId, patch) {
  return repo.updateById(ACTIONS_TAB, 'action_id', text(actionId), patch);
}

export function buildActionsSetupPlan() {
  const note = ACTIONS_HEADER.map((_, i) => i === 0 ? 'SCHEMA NOTE' : '');
  note[1] = ACTIONS_SCHEMA_NOTE;
  return { tab: ACTIONS_TAB, header_row: [...ACTIONS_HEADER], schema_note_row: note, data_rows: [] };
}
