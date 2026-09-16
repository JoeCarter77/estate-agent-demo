// lib/calling-store.mjs — the four workbook tabs behind the cold-calling
// workspace, and nothing else: headers, row parsing, validation, setup plan.
//
// WHY FOUR TABS AND NOT A FEW LEAD COLUMNS. A lead has MANY calls, a call has
// MANY objection events, and a script has MANY versions. Storing "last call
// outcome" on the AGENCIES row would make the second call overwrite the
// first, and the script funnel (dials -> connected -> owner -> pitched ->
// interested -> meeting) can only be computed from immutable per-call rows.
// Every tab here is id-keyed and append-mostly, in the same row-1 header /
// row-2 SCHEMA NOTE layout as every other tab in the workbook.
//
// VERSIONING. SCRIPTS and OBJECTIONS are ONE ROW PER VERSION. A row is never
// edited once a call references it — the editor creates a new row with the
// same family key and version + 1 instead. CALLS.script_id and
// CALL_OBJECTION_EVENTS.objection_id therefore point at an exact, permanent
// version, which is what makes historical test data trustworthy.

import crypto from 'node:crypto';

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();

function newId(prefix) {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${time}_${rand}`;
}
export function newCallId() { return newId('cal'); }
export function newScriptId() { return newId('scr'); }
export function newObjectionId() { return newId('obj'); }
export function newObjectionEventId() { return newId('coe'); }
export function newFamilyKey(prefix) { return `${prefix}_${crypto.randomBytes(4).toString('hex')}`; }

// ── SCRIPTS ────────────────────────────────────────────────────────────────
export const SCRIPTS_TAB = 'SCRIPTS';
export const SCRIPTS_HEADER = Object.freeze([
  'script_id', 'script_key', 'name', 'version', 'status', 'content', 'notes',
  'created_at', 'updated_at', 'archived_at',
]);
export const SCRIPTS_SCHEMA_NOTE = 'SCHEMA NOTE: one row per script VERSION. script_key groups versions of the same script. Content is frozen once any CALLS row references the script_id; edit by duplicating into a new version.';
export const SCRIPT_STATUSES = Object.freeze(['CURRENT', 'TESTING', 'ARCHIVED']);

// ── OBJECTIONS ─────────────────────────────────────────────────────────────
export const OBJECTIONS_TAB = 'OBJECTIONS';
export const OBJECTIONS_HEADER = Object.freeze([
  'objection_id', 'objection_key', 'title', 'response', 'version', 'active', 'sort_order',
  'created_at', 'updated_at', 'archived_at',
]);
export const OBJECTIONS_SCHEMA_NOTE = 'SCHEMA NOTE: one row per objection VERSION. objection_key groups versions. Only rows with active=TRUE appear in Calling Mode. A response is frozen once a CALL_OBJECTION_EVENTS row references the objection_id.';

// ── CALLS ──────────────────────────────────────────────────────────────────
export const CALLS_TAB = 'CALLS';
export const CALLS_HEADER = Object.freeze([
  'call_id', 'client_key', 'agency_id', 'script_id', 'source_action_id',
  'contact_name', 'contact_role', 'phone', 'attempt_number', 'call_mode',
  'twilio_call_sid', 'started_at', 'connected_at', 'ended_at', 'duration_seconds', 'call_status',
  'outcome', 'connected', 'owner_reached', 'pitched',
  'callback_at', 'callback_note',
  'not_interested_reason', 'not_interested_detail',
  'more_info_type', 'more_info_note',
  'meeting_at', 'meeting_note',
  'referred_contact_json',
  'recording_sid', 'recording_url', 'recording_status', 'recording_duration_seconds', 'transcript',
  'objections', 'main_priority', 'main_constraint', 'useful_note',
  'action_ids', 'metadata_json', 'created_at', 'updated_at',
  // Appended, not inserted: a production CALLS tab only needs these four
  // header cells added after updated_at (never shift existing columns —
  // parseRecords reads a missing trailing cell as '' on every older row).
  'gatekeeper_reached', 'gatekeeper_reached_at', 'owner_reached_at', 'owner_reach_source',
]);
export const CALLS_SCHEMA_NOTE = 'SCHEMA NOTE: one immutable row per dial. Outcome/pitched/owner_reached drive the script funnel; suppression (DO_NOT_CALL, WRONG_NUMBER) is derived from these rows, never stored on AGENCIES. gatekeeper_reached/owner_reached_at/owner_reach_source record who was classified as answering the call, independent of the outcome-derived owner_reached column.';

export const CALL_MODES = Object.freeze(['MANUAL', 'TWILIO']);
export const CALL_STATUSES = Object.freeze(['queued', 'initiated', 'ringing', 'in-progress', 'completed', 'busy', 'no-answer', 'failed', 'canceled', 'manual', 'discarded']);
// A TECHNICAL DISCARD is a flag, not a deletion. The row stays in the ledger
// with call_status=discarded, outcome blank and metadata_json.discarded=true,
// and every reader (queue, attempt numbering, analytics, funnel, workspace
// counts) skips it through isDiscardedCall / liveCallRecords below. Physical
// deletion was rejected: Twilio's status and recording callbacks patch CALLS
// by row number for several seconds after hangup, and a deleteDimension in
// that window would shift a concurrent patch onto a different call's row.
export const DISCARDED_CALL_STATUS = 'discarded';
export const DISCARD_REASONS = Object.freeze(['TECHNICAL_ISSUE']);
export const OWNER_REACH_SOURCES = Object.freeze(['DIRECT', 'VIA_GATEKEEPER']);

// ── CALL_OBJECTION_EVENTS ──────────────────────────────────────────────────
export const CALL_OBJECTION_EVENTS_TAB = 'CALL_OBJECTION_EVENTS';
export const CALL_OBJECTION_EVENTS_HEADER = Object.freeze([
  'event_id', 'call_id', 'agency_id', 'objection_id', 'objection_key', 'objection_title',
  'clicked_at', 'offset_seconds', 'source', 'created_at',
]);
export const CALL_OBJECTION_EVENTS_SCHEMA_NOTE = 'SCHEMA NOTE: one row per objection encountered on a call. source=LIVE was clicked during the call; source=MANUAL was added in the post-call review.';

export const CALLING_TABS = Object.freeze([
  { tab: SCRIPTS_TAB, header: SCRIPTS_HEADER, note: SCRIPTS_SCHEMA_NOTE, idColumn: 'script_id' },
  { tab: OBJECTIONS_TAB, header: OBJECTIONS_HEADER, note: OBJECTIONS_SCHEMA_NOTE, idColumn: 'objection_id' },
  { tab: CALLS_TAB, header: CALLS_HEADER, note: CALLS_SCHEMA_NOTE, idColumn: 'call_id' },
  { tab: CALL_OBJECTION_EVENTS_TAB, header: CALL_OBJECTION_EVENTS_HEADER, note: CALL_OBJECTION_EVENTS_SCHEMA_NOTE, idColumn: 'event_id' },
]);

// ── parsing ────────────────────────────────────────────────────────────────
export function headerMatches(table, header) {
  const actual = table?.header || [];
  return header.length === actual.length && header.every((key, i) => actual[i] === key);
}

// Same skip rule as lib/sheets.mjs's getRecords: blank id or SCHEMA NOTE.
export function parseRecords(table, idColumn) {
  const header = table?.header || [];
  const at = header.indexOf(idColumn);
  if (at < 0) return [];
  return (table.rows || []).flatMap((row, index) => {
    const id = text(row[at]);
    if (!id || id === 'SCHEMA NOTE') return [];
    return [{ rowNumber: index + 2, obj: Object.fromEntries(header.map((key, i) => [key, row[i] ?? ''])) }];
  });
}

export function rowFor(header, obj) {
  return header.map((key) => (obj[key] ?? ''));
}

// Reads all four tabs at once. A missing tab is reported, not thrown, so the
// workspace can render its "set up" state instead of a blank error.
export async function readCallingTables(repo) {
  const out = { available: true, missing: [], header_mismatch: [], tables: {} };
  await Promise.all(CALLING_TABS.map(async ({ tab, header }) => {
    try {
      const table = await repo.getTable(tab);
      if (!table.header?.length) { out.missing.push(tab); out.tables[tab] = { header: [...header], rows: [] }; return; }
      if (!headerMatches(table, header)) out.header_mismatch.push(tab);
      out.tables[tab] = table;
    } catch {
      out.missing.push(tab);
      out.tables[tab] = { header: [...header], rows: [] };
    }
  }));
  out.available = out.missing.length === 0 && out.header_mismatch.length === 0;
  return out;
}

export function buildCallingSetupPlan() {
  return CALLING_TABS.map(({ tab, header, note }) => {
    const noteRow = header.map((_, i) => (i === 0 ? 'SCHEMA NOTE' : ''));
    noteRow[1] = note;
    return { tab, header_row: [...header], schema_note_row: noteRow };
  });
}

// Creates any missing calling tab. Existing tabs are never touched.
export async function ensureCallingTabs(repo) {
  const results = [];
  for (const plan of buildCallingSetupPlan()) {
    const result = await repo.ensureTab(plan.tab, plan.header_row, plan.schema_note_row);
    results.push({ tab: plan.tab, result });
  }
  return results;
}

// ── validation ─────────────────────────────────────────────────────────────
export function validateScriptRow(row) {
  const errors = [];
  for (const key of ['script_id', 'script_key', 'name', 'version', 'status', 'created_at', 'updated_at']) {
    if (!text(row?.[key])) errors.push(`${key} is required`);
  }
  if (text(row?.status) && !SCRIPT_STATUSES.includes(upper(row.status))) errors.push('invalid status');
  if (!Number.isInteger(Number(row?.version)) || Number(row?.version) < 1) errors.push('version must be a positive integer');
  return { valid: errors.length === 0, errors };
}

export function validateObjectionRow(row) {
  const errors = [];
  for (const key of ['objection_id', 'objection_key', 'title', 'version', 'active', 'created_at', 'updated_at']) {
    if (!text(row?.[key])) errors.push(`${key} is required`);
  }
  if (!['TRUE', 'FALSE'].includes(upper(row?.active))) errors.push('active must be TRUE or FALSE');
  return { valid: errors.length === 0, errors };
}

export function validateCallRow(row) {
  const errors = [];
  for (const key of ['call_id', 'agency_id', 'call_mode', 'started_at', 'created_at', 'updated_at']) {
    if (!text(row?.[key])) errors.push(`${key} is required`);
  }
  if (text(row?.call_mode) && !CALL_MODES.includes(upper(row.call_mode))) errors.push('invalid call_mode');
  if (text(row?.owner_reach_source) && !OWNER_REACH_SOURCES.includes(upper(row.owner_reach_source))) errors.push('invalid owner_reach_source');
  const unknown = Object.keys(row || {}).filter((key) => !CALLS_HEADER.includes(key));
  if (unknown.length) errors.push(`unknown column(s): ${unknown.join(', ')}`);
  return { valid: errors.length === 0, errors };
}

// Objects → records, with the SCRIPTS/OBJECTIONS "latest per family" helpers
// the workspace needs.
export function scriptRecords(table) { return parseRecords(table, 'script_id').map((r) => r.obj); }
export function objectionRecords(table) { return parseRecords(table, 'objection_id').map((r) => r.obj); }
export function callRecords(table) { return parseRecords(table, 'call_id').map((r) => r.obj); }
export function isDiscardedCall(row) {
  if (upper(row?.call_status) === DISCARDED_CALL_STATUS.toUpperCase()) return true;
  try { return JSON.parse(text(row?.metadata_json) || '{}').discarded === true; } catch { return false; }
}
// The CALLS rows that exist as far as the workflow is concerned. Every
// counting/queueing path reads this, never callRecords, so a discarded
// attempt is invisible everywhere at once.
export function liveCallRecords(table) { return callRecords(table).filter((row) => !isDiscardedCall(row)); }
export function objectionEventRecords(table) { return parseRecords(table, 'event_id').map((r) => r.obj); }

// THE ONE CURRENT SCRIPT. Sheets cannot enforce uniqueness, so it is
// enforced in two places: every write path that makes a script CURRENT first
// demotes every other CURRENT row (lib/calling-handlers.mjs demoteCurrent),
// and this read is deterministic if the sheet is ever hand-edited into two —
// the most recently updated wins, and currentScriptConflicts() reports the
// rest so the workspace can say so.
export function currentScript(scripts) {
  const current = (scripts || []).filter((row) => upper(row.status) === 'CURRENT');
  if (!current.length) return null;
  return [...current].sort((a, b) => (Date.parse(text(b.updated_at)) || 0) - (Date.parse(text(a.updated_at)) || 0)
    || text(b.script_id).localeCompare(text(a.script_id)))[0];
}
export function currentScriptConflicts(scripts) {
  const chosen = currentScript(scripts);
  return (scripts || []).filter((row) => upper(row.status) === 'CURRENT' && row !== chosen).map((row) => text(row.script_id));
}

// Patches ONLY the named columns of one CALLS row, in a single request,
// without rewriting the rest of the row. Twilio's status and recording
// callbacks and the operator's save can all land within seconds of each
// other; a read-modify-write of the whole row (updateById) would let the
// last writer clobber the others' columns. Cell writes cannot.
export async function patchCallCells(repo, callId, patch) {
  const table = await repo.getTable(CALLS_TAB);
  const header = table.header || [];
  const record = parseRecords(table, 'call_id').find((r) => text(r.obj.call_id) === text(callId));
  if (!record) return null;
  const writes = [];
  for (const [key, value] of Object.entries(patch || {})) {
    const columnNumber = header.indexOf(key) + 1;
    if (columnNumber < 1) continue;
    writes.push({ tab: CALLS_TAB, rowNumber: record.rowNumber, columnNumber, value: value ?? '' });
  }
  if (writes.length) await repo.writeCellsBatch(writes);
  return { ...record.obj, ...patch };
}

export function activeObjections(objections) {
  return (objections || [])
    .filter((row) => upper(row.active) === 'TRUE')
    .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || text(a.title).localeCompare(text(b.title)));
}

export const _internal = { text, upper, newId };
