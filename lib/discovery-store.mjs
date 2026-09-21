// lib/discovery-store.mjs — the two workbook tabs behind the meeting
// discovery workspace, and nothing else: headers, parsing, setup.
//
// DISCOVERY_SESSIONS   one row per meeting discovery. Answers, notes,
//                      overrides, the latest diagnosis and plan, the
//                      outcome. Patched in place by autosave (same id).
// DISCOVERY_PITCHES    one IMMUTABLE row per generated pitch version, with
//                      the diagnosis snapshot it was generated from, so a
//                      regenerated pitch never overwrites an earlier one.
//
// Same row-1 header / row-2 SCHEMA NOTE layout as every other tab. JSON
// columns hold structured state; the registry versions the session was
// answered against are stamped on the row, and a completed session freezes
// `question_snapshot_json` (labels only) so it stays readable after the
// registries change.

const text = (value) => String(value ?? '').trim();

function newId(prefix) {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${time}_${rand}`;
}
export function newSessionId() { return newId('dsc'); }
export function newPitchId() { return newId('pit'); }

export const DISCOVERY_SESSIONS_TAB = 'DISCOVERY_SESSIONS';
export const DISCOVERY_SESSIONS_HEADER = Object.freeze([
  'session_id', 'agency_id', 'agency_name', 'contact_name', 'meeting_at', 'source_call_id',
  'status', 'stage', 'questions_version', 'rules_version',
  'answers_json', 'notes_json', 'overrides_json', 'diagnosis_json', 'plan_json', 'economics_json',
  'latest_pitch_id', 'pitch_count',
  'outcome', 'outcome_notes', 'follow_up_at', 'agreed_scope_json', 'question_snapshot_json',
  'created_at', 'updated_at', 'completed_at',
  // Added after the tab first shipped: the meeting conclusion (owner's
  // agreement to each finding, the chosen illustration, the agreed scope).
  // A live tab whose header stops short of it is extended in place — see
  // headerMatches / extendHeader below — so the workspace keeps working.
  'conclusion_json',
]);
export const DISCOVERY_SESSIONS_SCHEMA_NOTE = 'SCHEMA NOTE: one row per meeting discovery session. Autosave patches the row in place. answers_json/notes_json/overrides_json are the operator\'s recorded inputs; diagnosis_json/plan_json are the deterministic engine\'s latest output; question_snapshot_json freezes the labels used once the outcome is recorded.';

export const DISCOVERY_PITCHES_TAB = 'DISCOVERY_PITCHES';
export const DISCOVERY_PITCHES_HEADER = Object.freeze([
  'pitch_id', 'session_id', 'agency_id', 'version', 'source', 'model', 'status',
  'pitch_json', 'plan_json', 'diagnosis_snapshot_json', 'validation_json', 'error',
  'questions_version', 'rules_version', 'created_at',
]);
export const DISCOVERY_PITCHES_SCHEMA_NOTE = 'SCHEMA NOTE: one immutable row per generated pitch version. source=AI or TEMPLATE. Never edited; a regeneration appends the next version.';

export const SESSION_STATUSES = Object.freeze(['IN_PROGRESS', 'COMPLETED']);
export const SESSION_STAGES = Object.freeze(['commercial', 'foundations', 'intelligence', 'diagnosis', 'pitch', 'conclusion', 'outcome']);
export const MEETING_OUTCOMES = Object.freeze({
  PILOT_AGREED: 'Pilot agreed',
  PROPOSAL_REQUESTED: 'Proposal requested',
  FOLLOW_UP_REQUIRED: 'Follow-up required',
  TECHNICAL_ASSESSMENT_REQUIRED: 'Technical assessment required',
  FURTHER_DISCOVERY_REQUIRED: 'Further discovery required',
  NOT_SUITABLE: 'Not suitable',
  NOT_INTERESTED: 'Not interested',
});

export const DISCOVERY_TABS = Object.freeze([
  { tab: DISCOVERY_SESSIONS_TAB, header: DISCOVERY_SESSIONS_HEADER, note: DISCOVERY_SESSIONS_SCHEMA_NOTE, idColumn: 'session_id' },
  { tab: DISCOVERY_PITCHES_TAB, header: DISCOVERY_PITCHES_HEADER, note: DISCOVERY_PITCHES_SCHEMA_NOTE, idColumn: 'pitch_id' },
]);

// A header that is a strict PREFIX of the expected one is a tab that predates
// a column added later; it still matches, and the missing columns are written
// the first time a row needs them (extendHeader).
export function headerMatches(table, header) {
  const actual = table?.header || [];
  return actual.length > 0 && actual.length <= header.length && actual.every((key, i) => header[i] === key);
}
export function missingHeaderColumns(table, header) {
  const actual = table?.header || [];
  return headerMatches(table, header) ? header.slice(actual.length) : [];
}

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

export function rowFor(header, obj) { return header.map((key) => (obj[key] ?? '')); }

export function parseJson(value, fallback) {
  const raw = text(value);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export async function readDiscoveryTables(repo) {
  const out = { available: true, missing: [], header_mismatch: [], tables: {} };
  await Promise.all(DISCOVERY_TABS.map(async ({ tab, header }) => {
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

export function buildDiscoverySetupPlan() {
  return DISCOVERY_TABS.map(({ tab, header, note }) => {
    const noteRow = header.map((_, i) => (i === 0 ? 'SCHEMA NOTE' : ''));
    noteRow[1] = note;
    return { tab, header_row: [...header], schema_note_row: noteRow };
  });
}

export async function extendHeader(repo, tab, header) {
  const table = await repo.getTable(tab);
  const missing = missingHeaderColumns(table, header);
  if (!missing.length) return { extended: [], header: table.header || [] };
  const start = (table.header || []).length;
  await repo.writeCellsBatch(missing.map((key, i) => ({ tab, rowNumber: 1, columnNumber: start + i + 1, value: key })));
  return { extended: missing, header: [...(table.header || []), ...missing] };
}

export async function ensureDiscoveryTabs(repo) {
  const results = [];
  for (const plan of buildDiscoverySetupPlan()) {
    let result = await repo.ensureTab(plan.tab, plan.header_row, plan.schema_note_row);
    if (result === 'exists') {
      const { extended } = await extendHeader(repo, plan.tab, plan.header_row);
      if (extended.length) result = `extended: ${extended.join(', ')}`;
    }
    results.push({ tab: plan.tab, result });
  }
  return results;
}

export function sessionRecords(table) { return parseRecords(table, 'session_id').map((r) => r.obj); }
export function pitchRecords(table) { return parseRecords(table, 'pitch_id').map((r) => r.obj); }

// Row → the object the API returns and the page works with.
export function sessionView(row) {
  return {
    session_id: text(row.session_id), agency_id: text(row.agency_id), agency_name: text(row.agency_name), contact_name: text(row.contact_name),
    meeting_at: text(row.meeting_at), source_call_id: text(row.source_call_id), status: text(row.status) || 'IN_PROGRESS', stage: text(row.stage) || 'commercial',
    questions_version: Number(row.questions_version) || null, rules_version: Number(row.rules_version) || null,
    answers: parseJson(row.answers_json, {}), notes: parseJson(row.notes_json, {}), overrides: parseJson(row.overrides_json, {}),
    diagnosis: parseJson(row.diagnosis_json, null), plan: parseJson(row.plan_json, null), economics: parseJson(row.economics_json, null),
    latest_pitch_id: text(row.latest_pitch_id), pitch_count: Number(row.pitch_count) || 0,
    outcome: text(row.outcome), outcome_notes: text(row.outcome_notes), follow_up_at: text(row.follow_up_at),
    agreed_scope: parseJson(row.agreed_scope_json, null), question_snapshot: parseJson(row.question_snapshot_json, null),
    conclusion: parseJson(row.conclusion_json, null),
    created_at: text(row.created_at), updated_at: text(row.updated_at), completed_at: text(row.completed_at),
  };
}

export function pitchView(row) {
  return {
    pitch_id: text(row.pitch_id), session_id: text(row.session_id), agency_id: text(row.agency_id), version: Number(row.version) || 1,
    source: text(row.source), model: text(row.model), status: text(row.status),
    pitch: parseJson(row.pitch_json, null), plan: parseJson(row.plan_json, null), diagnosis_snapshot: parseJson(row.diagnosis_snapshot_json, null),
    validation: parseJson(row.validation_json, null), error: text(row.error),
    questions_version: Number(row.questions_version) || null, rules_version: Number(row.rules_version) || null, created_at: text(row.created_at),
  };
}

// Patches only the named columns of one session row, in one request —
// autosave and pitch generation can land close together and a whole-row
// rewrite would let the later one clobber the earlier one's columns.
export async function patchSessionCells(repo, sessionId, patch) {
  let table = await repo.getTable(DISCOVERY_SESSIONS_TAB);
  let header = table.header || [];
  // A column the live tab does not have yet (added after it shipped) is
  // written to the header first, so the patch is never silently dropped.
  if (Object.keys(patch || {}).some((key) => !header.includes(key) && DISCOVERY_SESSIONS_HEADER.includes(key))) {
    const { header: extended } = await extendHeader(repo, DISCOVERY_SESSIONS_TAB, DISCOVERY_SESSIONS_HEADER);
    header = extended; table = { ...table, header };
  }
  const record = parseRecords(table, 'session_id').find((r) => text(r.obj.session_id) === text(sessionId));
  if (!record) return null;
  const writes = [];
  for (const [key, value] of Object.entries(patch || {})) {
    const columnNumber = header.indexOf(key) + 1;
    if (columnNumber < 1) continue;
    writes.push({ tab: DISCOVERY_SESSIONS_TAB, rowNumber: record.rowNumber, columnNumber, value: value ?? '' });
  }
  if (writes.length) await repo.writeCellsBatch(writes);
  return { ...record.obj, ...patch };
}

export const _internal = { newId };
