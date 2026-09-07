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
      && ['PENDING', 'DUE', 'IN_PROGRESS', 'SNOOZED'].includes(text(record.obj.action_status).toUpperCase()));
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

// ── THE BATCH WRITERS ───────────────────────────────────────────────────────
//
// WHAT THEY REPLACE. The reconciler used to call appendAction() per created
// action (each one re-reading the whole ACTIONS tab to re-check for a
// duplicate) and patchAction() per updated/cancelled/completed action (each one
// a repo.updateById, which is itself getTable + getRecords + update — three
// requests per action). One nightly reconciliation over N agencies could
// therefore issue several hundred Sheets requests to write a few dozen rows.
//
// These two take the table ONCE, from the caller, and return fully-formed rows
// and cell/row writes to be sent in a bounded number of requests. Every rule the
// per-row writers enforced is enforced here — the exact 19-column header check,
// the full row validation, the active-dedupe_key duplicate check — with one
// addition the per-row path got for free from re-reading and this one must do
// explicitly: rows created EARLIER IN THE SAME BATCH also count as duplicates,
// so a batch can never contain two active actions for one dedupe_key.

export function assertActionsHeader(table) {
  const header = table?.header || [];
  if (header.length !== ACTIONS_HEADER.length || ACTIONS_HEADER.some((key, i) => header[i] !== key)) {
    throw new Error('ACTIONS header does not match the audited 19-column schema');
  }
}

const ACTIVE_STATUSES = ['PENDING', 'DUE', 'IN_PROGRESS', 'SNOOZED'];

// table: the ACTIONS snapshot. inputs: the rows reconcileActions() wants
// created. -> { rows, skipped_duplicate, appendRows }
// appendRows is header-ordered and ready for repo.appendRowsBatch().
export function buildActionAppendPlan(table, inputs, now = new Date().toISOString()) {
  assertActionsHeader(table);
  const existing = parseActionRecords(table);
  const activeKeys = new Set(existing
    .filter((record) => ACTIVE_STATUSES.includes(text(record.obj.action_status).toUpperCase()))
    .map((record) => text(record.obj.dedupe_key)));

  const rows = [];
  const appendRows = [];
  const errors = [];
  let skippedDuplicate = 0;

  for (const input of inputs || []) {
    const row = { ...Object.fromEntries(ACTIONS_HEADER.map((key) => [key, ''])), ...input };
    row.action_id = text(row.action_id) || newActionId();
    row.created_at = text(row.created_at) || now;
    row.updated_at = now;
    row.metadata_json = text(row.metadata_json) || '{}';
    const validation = validateActionRow(row);
    if (!validation.valid) { errors.push({ dedupe_key: text(row.dedupe_key), errors: validation.errors }); continue; }
    const key = text(row.dedupe_key);
    // Includes keys claimed by rows earlier in THIS batch — see the header.
    if (activeKeys.has(key)) { skippedDuplicate += 1; continue; }
    activeKeys.add(key);
    rows.push(row);
    appendRows.push(ACTIONS_HEADER.map((column) => row[column] ?? ''));
  }

  return { rows, appendRows, skipped_duplicate: skippedDuplicate, errors };
}

// table: the ACTIONS snapshot. patches: [{ action_id, patch }].
// -> { writes, missing } where writes is ready for repo.writeRowsBatch().
// Merged in memory onto the already-loaded row, so no read per patch. Two
// patches to the same action_id are merged rather than sent as two writes to
// one range (which writeRowsBatch would collapse last-one-wins).
export function buildActionPatchPlan(table, patches) {
  assertActionsHeader(table);
  const byId = new Map(parseActionRecords(table).map((record) => [text(record.obj.action_id), record]));
  const mergedById = new Map();
  const missing = [];

  for (const { action_id: actionId, patch } of patches || []) {
    const record = byId.get(text(actionId));
    if (!record) { missing.push(text(actionId)); continue; }
    const current = mergedById.get(text(actionId))?.obj || record.obj;
    mergedById.set(text(actionId), { rowNumber: record.rowNumber, obj: { ...current, ...patch } });
  }

  const writes = [...mergedById.values()].map(({ rowNumber, obj }) => ({
    tab: ACTIONS_TAB,
    rowNumber,
    row: ACTIONS_HEADER.map((column) => obj[column] ?? ''),
  }));
  return { writes, missing };
}

export function buildActionsSetupPlan() {
  const note = ACTIONS_HEADER.map((_, i) => i === 0 ? 'SCHEMA NOTE' : '');
  note[1] = ACTIONS_SCHEMA_NOTE;
  return { tab: ACTIONS_TAB, header_row: [...ACTIONS_HEADER], schema_note_row: note, data_rows: [] };
}
