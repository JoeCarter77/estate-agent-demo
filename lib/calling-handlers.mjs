// lib/calling-handlers.mjs — the HTTP operations behind the cold-calling
// workspace (novus/calling.html). Mounted as ?novus_operation= branches on
// api/novus/personalisation.js because /api/novus/* sits at Vercel's
// 12-function ceiling; every handler here assumes Basic Auth was already
// enforced by the router.
//
// READ PATH  calling-workspace  — parallel tab reads → lib/calling-queue.mjs
//            calling-analytics  — parallel tab reads → lib/calling-analytics.mjs
// WRITE PATH calling-save       — one immutable CALLS row + objection events
//                                 + the ACTIONS the outcome implies
//            calling-start      — opens a CALLS row at dial time (Twilio mode)
//            calling-discard    — flags an opened row as a technical discard
//                                 (never a dial, never an attempt — see below)
//            calling-setup      — creates the four tabs if missing
//            script-save / script-duplicate / script-status
//            objection-save
//
// LOSSLESS SAVES. calling-save is idempotent on client_key: the browser keeps
// the completed call locally until this returns success, and a retry of the
// same key returns the row already written rather than writing it twice.

import { getRepo } from './sheets.mjs';
import { newActionId } from './ids.mjs';
import {
  ACTIONS_TAB, assertActionsHeader, buildActionAppendPlan, buildActionPatchPlan, parseActionRecords, readActions, patchAction,
} from './actions-store.mjs';
import { CALL_ACTION_TYPES } from './acquisition-actions.mjs';
import { reconcileAgencyActionsBestEffort } from './action-engine.mjs';
import {
  CALLS_HEADER, CALLS_TAB, CALL_OBJECTION_EVENTS_HEADER, CALL_OBJECTION_EVENTS_TAB,
  OBJECTIONS_HEADER, OBJECTIONS_TAB, SCRIPTS_HEADER, SCRIPTS_TAB, SCRIPT_STATUSES,
  activeObjections, callRecords, liveCallRecords, isDiscardedCall, DISCARDED_CALL_STATUS, DISCARD_REASONS,
  ensureCallingTabs, newCallId, newFamilyKey, newObjectionEventId, newObjectionId,
  newScriptId, objectionEventRecords, objectionRecords, parseRecords, patchCallCells, readCallingTables, rowFor, scriptRecords,
  currentScriptConflicts, validateCallRow, validateObjectionRow, validateScriptRow, OWNER_REACH_SOURCES,
} from './calling-store.mjs';
import { buildCallingWorkspace, scriptFunnel } from './calling-queue.mjs';
import { normalizePhoneNumber } from './lead-search.mjs';
import { updateReplyEventExecution } from './reply-router.mjs';
import { londonTimeOn } from './london-time.mjs';
import { buildCallingAnalytics, RANGE_KEYS } from './calling-analytics.mjs';
import {
  CALL_OUTCOMES, MAIN_CONSTRAINTS, MAIN_PRIORITIES, deriveConnected, deriveOwnerReached, derivePitched,
  meaningfulConversation, normaliseOutcomeInput, normalisedFromRow, planOutcome,
} from './calling-outcomes.mjs';

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();
const ACTIVE = new Set(['PENDING', 'DUE', 'IN_PROGRESS', 'SNOOZED']);
const noStore = (res) => res.setHeader('Cache-Control', 'private, no-store, max-age=0');

// Same in-process, single-entry cache pattern as the operator dashboard: a
// stale queue for at most 30s is the right trade against re-reading eight
// tabs on every refresh. Every write below clears it.
const WORKSPACE_CACHE_TTL_MS = 30_000;
let workspaceCache = null;
let analyticsCache = null;
export function invalidateCallingCache() { workspaceCache = null; analyticsCache = null; }

// Operator resolution of an ambiguous number or callback window. The edited
// choice stays on the originating ACTIONS row, so a workspace reload or later
// reconciliation cannot silently revert to a guessed number.
export async function handleCallingActionReview(req, res) {
  noStore(res);
  if (text(req.body?.confirm) !== 'REVIEW_CALL_ACTION') return res.status(400).json({ success: false, error: 'Missing confirm=REVIEW_CALL_ACTION' });
  const actionId = text(req.body?.action_id);
  let dueAt = text(req.body?.due_at);
  const dueLondon = text(req.body?.due_london);
  if (dueLondon) {
    const parts = dueLondon.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
    if (!parts) return res.status(400).json({ success: false, error: 'Use YYYY-MM-DDTHH:MM for the London callback time' });
    const [, year, month, day, hour, minute] = parts.map(Number);
    const reference = Date.UTC(year, month - 1, day, 12);
    const valid = new Date(reference);
    if (valid.getUTCFullYear() !== year || valid.getUTCMonth() + 1 !== month || valid.getUTCDate() !== day || hour > 23 || minute > 59) {
      return res.status(400).json({ success: false, error: 'Choose a valid London callback date and time' });
    }
    dueAt = new Date(londonTimeOn(reference, { hour, minute })).toISOString();
  }
  const rawPhone = text(req.body?.phone);
  const contactId = text(req.body?.contact_id);
  if (!actionId) return res.status(400).json({ success: false, error: 'action_id is required' });
  if (dueAt && (!Number.isFinite(Date.parse(dueAt)) || Date.parse(dueAt) < Date.now() - 60_000)) {
    return res.status(400).json({ success: false, error: 'Choose a future callback time' });
  }
  const normalised = rawPhone ? normalizePhoneNumber(rawPhone) : '';
  if (rawPhone && !/^\+44\d{9,10}$/.test(normalised)) return res.status(400).json({ success: false, error: 'Enter a usable UK phone number' });
  try {
    const repo = getRepo();
    const read = await readActions(repo);
    if (!read.available) return res.status(409).json({ success: false, error: read.error });
    const action = read.rows.find((row) => text(row.action_id) === actionId);
    if (!action || !ACTIVE.has(upper(action.action_status))) return res.status(409).json({ success: false, error: 'Call action is no longer active' });
    let meta = {};
    try { meta = JSON.parse(text(action.metadata_json) || '{}'); } catch { /* invalid source metadata is rejected below */ }
    if (meta.source !== 'EMAIL_REPLY') return res.status(409).json({ success: false, error: 'This action is not an email call request' });
    if (meta.phone_candidates?.length > 1 && !rawPhone) return res.status(400).json({ success: false, error: 'Choose the number to call' });
    if (meta.number_required && !rawPhone && !meta.phone) return res.status(400).json({ success: false, error: 'Obtain a verified callback number before clearing this action' });
    if (meta.contact_candidates?.length > 1 && !meta.contact_candidates.some((item) => text(item.contact_id) === contactId)) {
      return res.status(400).json({ success: false, error: 'Choose the contact to call' });
    }
    if (meta.timing?.needs_review && !dueAt) return res.status(400).json({ success: false, error: 'Choose a callback time or now' });
    if (rawPhone) { meta.phone = { raw: rawPhone, normalised, source: 'OPERATOR_REVIEW' }; meta.number_required = false; }
    if (contactId) {
      const chosen = (meta.contact_candidates || []).find((item) => text(item.contact_id) === contactId);
      if (chosen) { meta.contact_id = contactId; meta.contact_name = text(chosen.contact_name); }
    }
    if (dueAt) meta.timing = { ...meta.timing, due_at: dueAt, precision: 'OPERATOR', needs_review: false };
    meta.needs_review = false;
    meta.reviewed = true;
    const now = new Date().toISOString();
    const nextDue = dueAt || text(action.due_at);
    await patchAction(repo, actionId, { metadata_json: JSON.stringify(meta), due_at: nextDue,
      action_status: Date.parse(nextDue) > Date.now() ? 'SNOOZED' : 'DUE', updated_at: now });
    invalidateCallingCache();
    return res.status(200).json({ success: true, action_id: actionId });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || 'Could not review call action' });
  }
}

const CONTEXT_TABS = ['AGENCIES', 'REPLY_EVENTS', 'ACTIONS', 'CONTACTS', 'INTELLIGENCE', 'PROBES', 'DEMOS', 'CAMPAIGNS', 'OUTBOUND'];
async function loadContextTables(repo) {
  const entries = await Promise.all(CONTEXT_TABS.map(async (tab) => {
    try { return [tab, await repo.getTable(tab)]; }
    catch (err) {
      if (tab === 'AGENCIES') throw err;
      return [tab, { header: [], rows: [] }];
    }
  }));
  return Object.fromEntries(entries);
}

function scriptsPayload(scripts, calls) {
  const callsByScript = new Map();
  for (const call of calls) {
    const id = text(call.script_id);
    if (!callsByScript.has(id)) callsByScript.set(id, []);
    callsByScript.get(id).push(call);
  }
  return scripts
    .map((row) => ({
      ...row, version: Number(row.version) || 1, status: upper(row.status),
      call_count: (callsByScript.get(text(row.script_id)) || []).length,
      funnel: scriptFunnel(callsByScript.get(text(row.script_id)) || []),
    }))
    .sort((a, b) => text(a.name).localeCompare(text(b.name)) || b.version - a.version);
}

function objectionsPayload(objections, events) {
  const counts = new Map();
  for (const event of events) counts.set(text(event.objection_id), (counts.get(text(event.objection_id)) || 0) + 1);
  return objections.map((row) => ({ ...row, version: Number(row.version) || 1, active: upper(row.active) === 'TRUE', event_count: counts.get(text(row.objection_id)) || 0 }));
}

// ── GET calling-workspace ──────────────────────────────────────────────────
export async function handleCallingWorkspace(req, res) {
  noStore(res);
  const refresh = String(req.query?.refresh || '') === '1';
  const nowMs = Date.now();
  if (!refresh && workspaceCache && nowMs - workspaceCache.at < WORKSPACE_CACHE_TTL_MS) {
    return res.status(200).json({ ...workspaceCache.payload, cached: true, cache_age_ms: nowMs - workspaceCache.at });
  }
  try {
    const repo = getRepo();
    const [context, calling] = await Promise.all([loadContextTables(repo), readCallingTables(repo)]);
    const tables = { ...context, ...calling.tables };
    const now = new Date().toISOString();
    const workspace = buildCallingWorkspace(tables, { now });
    // Discarded (technical-issue) rows are not calls: not in the counts, the
    // script funnels, or the follow-up integrity list.
    const calls = liveCallRecords(tables.CALLS);
    const events = objectionEventRecords(tables.CALL_OBJECTION_EVENTS);
    const objections = objectionRecords(tables.OBJECTIONS);
    const payload = {
      success: true,
      generated_at: now,
      cache_ttl_ms: WORKSPACE_CACHE_TTL_MS,
      setup: { available: calling.available, missing: calling.missing, header_mismatch: calling.header_mismatch },
      counts: { ...workspace.counts, calls_total: calls.length, calls_today: calls.filter((row) => text(row.started_at).slice(0, 10) === now.slice(0, 10)).length },
      queue: workspace.queue,
      call_actions: workspace.call_actions,
      leads: workspace.leads,
      current_script: workspace.current_script,
      scripts: scriptsPayload(scriptRecords(tables.SCRIPTS), calls),
      objections: objectionsPayload(objections, events),
      active_objections: activeObjections(objections).map((row) => ({ objection_id: text(row.objection_id), objection_key: text(row.objection_key), title: text(row.title), response: text(row.response) })),
      funnel: scriptFunnel(calls),
      enums: { outcomes: CALL_OUTCOMES, main_priorities: MAIN_PRIORITIES, main_constraints: MAIN_CONSTRAINTS },
      // Integrity signals the page surfaces rather than hides.
      followups_pending: calls.filter(followupsPending).map((row) => ({ call_id: text(row.call_id), agency_id: text(row.agency_id), outcome: text(row.outcome), started_at: text(row.started_at) })),
      current_script_conflicts: currentScriptConflicts(scriptRecords(tables.SCRIPTS)),
    };
    workspaceCache = { at: Date.now(), payload };
    return res.status(200).json({ ...payload, cached: false, cache_age_ms: 0 });
  } catch (err) {
    console.error('calling-workspace error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Failed to build the calling workspace' });
  }
}

// ── GET calling-analytics ──────────────────────────────────────────────────
// READ-ONLY. Six tab reads in parallel (the four calling tabs + ACTIONS +
// AGENCIES), one pure aggregation (lib/calling-analytics.mjs), cached for
// 30s per distinct filter set. The date range is London-local; the only
// server-side filters are the range and script_id — outcome / objection /
// reach filters apply to the explorer rows in the browser, so every other
// section keeps its true denominators.
export async function handleCallingAnalytics(req, res) {
  noStore(res);
  const refresh = String(req.query?.refresh || '') === '1';
  const range = RANGE_KEYS.includes(text(req.query?.range).toLowerCase()) ? text(req.query.range).toLowerCase() : 'all';
  const from = text(req.query?.from).slice(0, 10);
  const to = text(req.query?.to).slice(0, 10);
  const scriptId = text(req.query?.script_id).slice(0, 80);
  if (range === 'custom' && (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))) {
    return res.status(400).json({ success: false, error: 'custom range needs from=YYYY-MM-DD and to=YYYY-MM-DD' });
  }
  const cacheKey = JSON.stringify({ range, from, to, scriptId });
  const nowMs = Date.now();
  if (!refresh && analyticsCache && analyticsCache.key === cacheKey && nowMs - analyticsCache.at < WORKSPACE_CACHE_TTL_MS) {
    return res.status(200).json({ ...analyticsCache.payload, cached: true, cache_age_ms: nowMs - analyticsCache.at });
  }
  try {
    const repo = getRepo();
    const optional = async (tab) => { try { return await repo.getTable(tab); } catch { return { header: [], rows: [] }; } };
    const [calling, actions, agencies] = await Promise.all([readCallingTables(repo), optional(ACTIONS_TAB), optional('AGENCIES')]);
    const tables = { ...calling.tables, ACTIONS: actions, AGENCIES: agencies };
    const now = new Date().toISOString();
    const analytics = buildCallingAnalytics(tables, { now, range, from, to, script_id: scriptId });
    const payload = {
      success: true, cache_ttl_ms: WORKSPACE_CACHE_TTL_MS,
      setup: { available: calling.available, missing: calling.missing, header_mismatch: calling.header_mismatch },
      actions_available: actions.header.length > 0,
      ...analytics,
    };
    analyticsCache = { key: cacheKey, at: Date.now(), payload };
    return res.status(200).json({ ...payload, cached: false, cache_age_ms: 0 });
  } catch (err) {
    console.error('calling-analytics error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Failed to build calling analytics' });
  }
}

// ── POST calling-setup ─────────────────────────────────────────────────────
// Creates missing tabs and, when the workbook has no script or objections at
// all, seeds a clearly-labelled starter set so Calling Mode has something to
// show on the first run. Existing rows are never touched.
const STARTER_OBJECTIONS = [
  ['We already do this', 'Edit this response in Scripts → Objections. Keep it as one natural passage: acknowledge what they do today, then explain what NOVUS adds on top of it.'],
  ["We're too busy", 'Edit this response in Scripts → Objections.'],
  ['Send me something', 'Edit this response in Scripts → Objections.'],
  ['Not interested', 'Edit this response in Scripts → Objections.'],
  ['We already use our CRM', 'Edit this response in Scripts → Objections.'],
  ["What's this regarding?", 'Edit this response in Scripts → Objections.'],
];
export async function handleCallingSetup(req, res) {
  noStore(res);
  if (text(req.body?.confirm) !== 'SETUP_CALLING_TABS') return res.status(400).json({ success: false, error: 'Missing confirm=SETUP_CALLING_TABS' });
  try {
    const repo = getRepo();
    const tabs = await ensureCallingTabs(repo);
    const now = new Date().toISOString();
    const seeded = { script: false, objections: 0 };
    const scripts = scriptRecords(await repo.getTable(SCRIPTS_TAB));
    if (!scripts.length) {
      const row = {
        script_id: newScriptId(), script_key: newFamilyKey('scr'), name: 'Seller Opportunity', version: 1, status: 'CURRENT',
        content: 'Starter script — replace this with your real opening, qualifying questions and close in Scripts.',
        notes: 'Seeded by calling-setup', created_at: now, updated_at: now, archived_at: '',
      };
      await repo.appendRowsBatch(SCRIPTS_TAB, [rowFor(SCRIPTS_HEADER, row)]);
      seeded.script = true;
    }
    const objections = objectionRecords(await repo.getTable(OBJECTIONS_TAB));
    if (!objections.length) {
      const rows = STARTER_OBJECTIONS.map(([title, response], i) => rowFor(OBJECTIONS_HEADER, {
        objection_id: newObjectionId(), objection_key: newFamilyKey('obj'), title, response, version: 1, active: 'TRUE',
        sort_order: i + 1, created_at: now, updated_at: now, archived_at: '',
      }));
      await repo.appendRowsBatch(OBJECTIONS_TAB, rows);
      seeded.objections = rows.length;
    }
    invalidateCallingCache();
    return res.status(200).json({ success: true, tabs, seeded });
  } catch (err) {
    console.error('calling-setup error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Calling setup failed' });
  }
}

// ── scripts ────────────────────────────────────────────────────────────────
async function demoteCurrent(repo, scripts, exceptId, now) {
  for (const row of scripts) {
    if (upper(row.status) === 'CURRENT' && text(row.script_id) !== exceptId) {
      await repo.updateById(SCRIPTS_TAB, 'script_id', text(row.script_id), { status: 'ARCHIVED', archived_at: now, updated_at: now });
    }
  }
}

export async function handleScriptSave(req, res) {
  noStore(res);
  if (text(req.body?.confirm) !== 'SAVE_SCRIPT') return res.status(400).json({ success: false, error: 'Missing confirm=SAVE_SCRIPT' });
  const name = text(req.body?.name).slice(0, 120);
  const content = String(req.body?.content ?? '').trim().slice(0, 45000);
  const notes = text(req.body?.notes).slice(0, 1000);
  const scriptId = text(req.body?.script_id);
  const status = upper(req.body?.status);
  if (!name) return res.status(400).json({ success: false, error: 'name is required' });
  if (status && !SCRIPT_STATUSES.includes(status)) return res.status(400).json({ success: false, error: 'invalid status' });
  try {
    const repo = getRepo();
    const [scriptsTable, callsTable] = await Promise.all([repo.getTable(SCRIPTS_TAB), repo.getTable(CALLS_TAB)]);
    const scripts = scriptRecords(scriptsTable);
    const now = new Date().toISOString();
    const existing = scriptId ? scripts.find((row) => text(row.script_id) === scriptId) : null;
    if (scriptId && !existing) return res.status(404).json({ success: false, error: 'Script not found' });

    // HISTORY IS IMMUTABLE. A version that calls already reference keeps its
    // content forever; the edit becomes the next version of the same script.
    const callCount = existing ? liveCallRecords(callsTable).filter((row) => text(row.script_id) === scriptId).length : 0;
    const contentChanged = existing && (content !== String(existing.content ?? '').trim() || name !== text(existing.name));
    if (existing && callCount > 0 && contentChanged && req.body?.as_new_version !== true) {
      return res.status(409).json({ success: false, has_calls: true, call_count: callCount, error: `This version has ${callCount} call${callCount === 1 ? '' : 's'} recorded against it. Save it as a new version instead.` });
    }

    let saved;
    if (!existing || (callCount > 0 && contentChanged)) {
      const family = existing ? scripts.filter((row) => text(row.script_key) === text(existing.script_key)) : [];
      const nextVersion = family.length ? Math.max(...family.map((row) => Number(row.version) || 1)) + 1 : 1;
      const wantsCurrent = status ? status === 'CURRENT' : (existing ? upper(existing.status) === 'CURRENT' : !scripts.some((row) => upper(row.status) === 'CURRENT'));
      saved = {
        script_id: newScriptId(), script_key: existing ? text(existing.script_key) : newFamilyKey('scr'), name, version: nextVersion,
        status: wantsCurrent ? 'CURRENT' : (status && status !== 'CURRENT' ? status : 'TESTING'),
        content, notes, created_at: now, updated_at: now, archived_at: '',
      };
      const validation = validateScriptRow(saved);
      if (!validation.valid) return res.status(400).json({ success: false, error: validation.errors.join('; ') });
      if (wantsCurrent) await demoteCurrent(repo, scripts, '', now);
      if (existing && wantsCurrent) {
        // The edited version stops being CURRENT the moment its successor is.
        await repo.updateById(SCRIPTS_TAB, 'script_id', scriptId, { status: 'ARCHIVED', archived_at: now, updated_at: now });
      }
      await repo.appendRowsBatch(SCRIPTS_TAB, [rowFor(SCRIPTS_HEADER, saved)]);
    } else {
      const patch = { name, content, notes, updated_at: now };
      if (status) {
        patch.status = status;
        patch.archived_at = status === 'ARCHIVED' ? now : '';
        if (status === 'CURRENT') await demoteCurrent(repo, scripts, scriptId, now);
      }
      saved = await repo.updateById(SCRIPTS_TAB, 'script_id', scriptId, patch);
    }
    invalidateCallingCache();
    return res.status(200).json({ success: true, script: saved, new_version: !existing || text(saved.script_id) !== scriptId });
  } catch (err) {
    console.error('script-save error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Could not save the script' });
  }
}

export async function handleScriptDuplicate(req, res) {
  noStore(res);
  if (text(req.body?.confirm) !== 'DUPLICATE_SCRIPT') return res.status(400).json({ success: false, error: 'Missing confirm=DUPLICATE_SCRIPT' });
  const scriptId = text(req.body?.script_id);
  if (!scriptId) return res.status(400).json({ success: false, error: 'script_id is required' });
  try {
    const repo = getRepo();
    const scripts = scriptRecords(await repo.getTable(SCRIPTS_TAB));
    const source = scripts.find((row) => text(row.script_id) === scriptId);
    if (!source) return res.status(404).json({ success: false, error: 'Script not found' });
    const family = scripts.filter((row) => text(row.script_key) === text(source.script_key));
    const now = new Date().toISOString();
    const row = {
      script_id: newScriptId(), script_key: text(source.script_key), name: text(source.name),
      version: Math.max(...family.map((r) => Number(r.version) || 1)) + 1, status: 'TESTING',
      content: String(source.content ?? ''), notes: text(req.body?.notes) || `Duplicated from v${source.version}`,
      created_at: now, updated_at: now, archived_at: '',
    };
    await repo.appendRowsBatch(SCRIPTS_TAB, [rowFor(SCRIPTS_HEADER, row)]);
    invalidateCallingCache();
    return res.status(201).json({ success: true, script: row });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || 'Could not duplicate the script' });
  }
}

export async function handleScriptStatus(req, res) {
  noStore(res);
  if (text(req.body?.confirm) !== 'SET_SCRIPT_STATUS') return res.status(400).json({ success: false, error: 'Missing confirm=SET_SCRIPT_STATUS' });
  const scriptId = text(req.body?.script_id);
  const status = upper(req.body?.status);
  if (!scriptId || !SCRIPT_STATUSES.includes(status)) return res.status(400).json({ success: false, error: 'script_id and a valid status are required' });
  try {
    const repo = getRepo();
    const scripts = scriptRecords(await repo.getTable(SCRIPTS_TAB));
    const target = scripts.find((row) => text(row.script_id) === scriptId);
    if (!target) return res.status(404).json({ success: false, error: 'Script not found' });
    const now = new Date().toISOString();
    if (status === 'CURRENT') await demoteCurrent(repo, scripts, scriptId, now);
    const saved = await repo.updateById(SCRIPTS_TAB, 'script_id', scriptId, { status, archived_at: status === 'ARCHIVED' ? now : '', updated_at: now });
    invalidateCallingCache();
    return res.status(200).json({ success: true, script: saved });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || 'Could not change the script status' });
  }
}

// ── objections ─────────────────────────────────────────────────────────────
export async function handleObjectionSave(req, res) {
  noStore(res);
  if (text(req.body?.confirm) !== 'SAVE_OBJECTION') return res.status(400).json({ success: false, error: 'Missing confirm=SAVE_OBJECTION' });
  const objectionId = text(req.body?.objection_id);
  const title = text(req.body?.title).slice(0, 160);
  const response = String(req.body?.response ?? '').trim().slice(0, 8000);
  const active = req.body?.active === false || upper(req.body?.active) === 'FALSE' ? 'FALSE' : 'TRUE';
  const sortOrder = Number.isFinite(Number(req.body?.sort_order)) ? Number(req.body.sort_order) : '';
  if (!title) return res.status(400).json({ success: false, error: 'title is required' });
  try {
    const repo = getRepo();
    const [objectionsTable, eventsTable] = await Promise.all([repo.getTable(OBJECTIONS_TAB), repo.getTable(CALL_OBJECTION_EVENTS_TAB)]);
    const objections = objectionRecords(objectionsTable);
    const existing = objectionId ? objections.find((row) => text(row.objection_id) === objectionId) : null;
    if (objectionId && !existing) return res.status(404).json({ success: false, error: 'Objection not found' });
    const now = new Date().toISOString();
    const eventCount = existing ? objectionEventRecords(eventsTable).filter((row) => text(row.objection_id) === objectionId).length : 0;
    const textChanged = existing && (title !== text(existing.title) || response !== String(existing.response ?? '').trim());
    let saved;
    if (!existing || (eventCount > 0 && textChanged)) {
      // Referenced by call history: the wording becomes a new version and the
      // old row is retired, so each logged click keeps pointing at what was
      // actually on screen when it was clicked.
      const family = existing ? objections.filter((row) => text(row.objection_key) === text(existing.objection_key)) : [];
      saved = {
        objection_id: newObjectionId(), objection_key: existing ? text(existing.objection_key) : newFamilyKey('obj'), title, response,
        version: family.length ? Math.max(...family.map((row) => Number(row.version) || 1)) + 1 : 1, active,
        sort_order: sortOrder !== '' ? sortOrder : (existing ? existing.sort_order : objections.length + 1),
        created_at: now, updated_at: now, archived_at: '',
      };
      const validation = validateObjectionRow(saved);
      if (!validation.valid) return res.status(400).json({ success: false, error: validation.errors.join('; ') });
      if (existing) await repo.updateById(OBJECTIONS_TAB, 'objection_id', objectionId, { active: 'FALSE', archived_at: now, updated_at: now });
      await repo.appendRowsBatch(OBJECTIONS_TAB, [rowFor(OBJECTIONS_HEADER, saved)]);
    } else {
      const patch = { title, response, active, updated_at: now, archived_at: active === 'FALSE' ? (text(existing.archived_at) || now) : '' };
      if (sortOrder !== '') patch.sort_order = sortOrder;
      saved = await repo.updateById(OBJECTIONS_TAB, 'objection_id', objectionId, patch);
    }
    invalidateCallingCache();
    return res.status(200).json({ success: true, objection: saved, new_version: !existing || text(saved.objection_id) !== objectionId });
  } catch (err) {
    console.error('objection-save error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Could not save the objection' });
  }
}

// ── calls ──────────────────────────────────────────────────────────────────
function baseCallRow(input, { agency, attemptNumber, now }) {
  const startedAt = Number.isFinite(Date.parse(text(input?.started_at))) ? new Date(Date.parse(text(input.started_at))).toISOString() : now;
  return {
    ...Object.fromEntries(CALLS_HEADER.map((key) => [key, ''])),
    call_id: text(input?.call_id) || newCallId(),
    client_key: text(input?.client_key).slice(0, 80),
    agency_id: text(agency.agency_id),
    script_id: text(input?.script_id),
    source_action_id: text(input?.source_action_id),
    contact_name: text(input?.contact_name || agency.outreach_contact_name || agency.primary_contact_name).slice(0, 120),
    contact_role: text(input?.contact_role).slice(0, 120),
    phone: text(input?.phone || agency.main_phone).slice(0, 40),
    attempt_number: attemptNumber,
    call_mode: upper(input?.call_mode) === 'TWILIO' ? 'TWILIO' : 'MANUAL',
    twilio_call_sid: text(input?.twilio_call_sid),
    started_at: startedAt,
    call_status: text(input?.call_status) || (upper(input?.call_mode) === 'TWILIO' ? 'queued' : 'manual'),
    metadata_json: '{}',
    created_at: now, updated_at: now,
  };
}

// Opens the CALLS row when the operator presses Call, before any outcome
// exists. Twilio status/recording callbacks later find it by call_id (passed
// through the TwiML as a custom parameter) and by twilio_call_sid.
export async function handleCallingStart(req, res) {
  noStore(res);
  if (text(req.body?.confirm) !== 'START_CALL') return res.status(400).json({ success: false, error: 'Missing confirm=START_CALL' });
  const agencyId = text(req.body?.agency_id);
  if (!agencyId) return res.status(400).json({ success: false, error: 'agency_id is required' });
  try {
    const repo = getRepo();
    const [agency, callsTable] = await Promise.all([repo.findById('AGENCIES', 'agency_id', agencyId), repo.getTable(CALLS_TAB)]);
    if (!agency) return res.status(404).json({ success: false, error: 'Agency not found' });
    // A discarded row is never reused and never counted towards attempt_number.
    const calls = liveCallRecords(callsTable);
    const clientKey = text(req.body?.client_key);
    const existing = clientKey ? calls.find((row) => text(row.client_key) === clientKey) : null;
    if (existing) return res.status(200).json({ success: true, call: existing, reused: true });
    const now = new Date().toISOString();
    const row = baseCallRow({ ...req.body, call_id: '' }, { agency: agency.obj, attemptNumber: calls.filter((c) => text(c.agency_id) === agencyId && text(c.outcome)).length + 1, now });
    const validation = validateCallRow(row);
    if (!validation.valid) return res.status(400).json({ success: false, error: validation.errors.join('; ') });
    await repo.appendRowsBatch(CALLS_TAB, [rowFor(CALLS_HEADER, row)]);
    invalidateCallingCache();
    return res.status(201).json({ success: true, call: row, reused: false });
  } catch (err) {
    console.error('calling-start error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Could not start the call' });
  }
}

// ── FOLLOW-UPS, RE-RUNNABLE ──────────────────────────────────────────────
// Sheets has no transactions, so the save is ordered "the call row first,
// then everything it implies", and everything it implies is IDEMPOTENT and
// derived from the stored row alone:
//   · every action dedupe_key contains the call_id, and
//     buildActionAppendPlan skips keys that are already active — so
//     re-running never duplicates an action;
//   · completing the call action(s) this dial answered is a no-op the
//     second time (they are no longer active);
//   · the terminal pipeline status is only written when it is not already
//     set;
//   · objection events are only appended for objections the call has no
//     event for yet.
// The CALLS row carries metadata_json.followups = PENDING until the whole
// step succeeds, and COMPLETE after. A retried save (same client_key / call
// id), and the calling-repair operation, simply run this again for any row
// still PENDING. A saved call therefore cannot permanently lose its callback
// because one later write failed.
export async function applyCallFollowups(repo, row, { nowMs = Date.now(), outreachId = '', probeId = '' } = {}) {
  const now = new Date(nowMs).toISOString();
  const agencyId = text(row.agency_id);
  const outcome = upper(row.outcome);
  const normalised = normalisedFromRow(row);
  const plan = planOutcome({ ...row, outreach_id: outreachId, probe_id: probeId }, normalised, { nowMs });
  const actionInputs = [...plan.call_actions, ...plan.actions].map((input) => ({ ...input, action_id: newActionId() }));
  const result = { complete: true, actions_created: [], actions_completed: [], terminal: plan.terminal, suppress_calling: plan.suppress_calling, reconciliation: null, warnings: [] };

  // 1) ACTIONS: one read, one append, one batch patch.
  try {
    const actionsTable = await repo.getTable(ACTIONS_TAB);
    assertActionsHeader(actionsTable);
    const ledger = parseActionRecords(actionsTable).map((r) => r.obj);
    const sourceId = text(row.source_action_id);
    // Never "complete" an action this very call created on an earlier,
    // partially-failed pass: its dedupe_key names this call_id.
    const own = (a) => text(a.dedupe_key).endsWith(`:call:${text(row.call_id)}`);
    const toComplete = ledger.filter((a) => text(a.agency_id) === agencyId && ACTIVE.has(upper(a.action_status)) && !own(a)
      && (text(a.action_id) === sourceId || CALL_ACTION_TYPES.includes(upper(a.action_type))));
    const patchPlan = buildActionPatchPlan(actionsTable, toComplete.map((a) => ({
      action_id: a.action_id,
      patch: { action_status: 'COMPLETED', completed_at: now, updated_at: now, completion_reason: `CALL_OUTCOME:${outcome} (${row.call_id})` },
    })));
    const appendPlan = buildActionAppendPlan(actionsTable, actionInputs, now);
    if (appendPlan.appendRows.length) await repo.appendRowsBatch(ACTIONS_TAB, appendPlan.appendRows);
    if (patchPlan.writes.length) await repo.writeRowsBatch(patchPlan.writes);
    result.actions_created = appendPlan.rows;
    result.actions_completed = toComplete.map((a) => text(a.action_id));
    const emailSource = ledger.find((a) => {
      if (text(a.action_id) !== sourceId || !text(a.reply_event_id)) return false;
      try { return JSON.parse(text(a.metadata_json) || '{}').source === 'EMAIL_REPLY'; }
      catch { return false; }
    });
    if (emailSource) {
      await updateReplyEventExecution(emailSource.reply_event_id,
        { action_status: 'COMPLETED', action_completed_at: now }, { repo, dryRun: false });
    }
    if (appendPlan.errors.length) { result.complete = false; result.warnings.push(`action errors: ${JSON.stringify(appendPlan.errors)}`); }
  } catch (err) {
    result.complete = false;
    result.warnings.push(`actions not updated: ${err?.message || err}`);
  }

  // 2) Terminal outcomes mark the agency exactly as the legacy call-outcome
  //    route does, then let the engine cancel the rest of the chasing.
  if (plan.terminal) {
    try {
      const agency = await repo.findById('AGENCIES', 'agency_id', agencyId);
      if (agency && upper(agency.obj.current_pipeline_status) !== plan.terminal) {
        const wrote = await repo.updateCell('AGENCIES', 'agency_id', agencyId, 'current_pipeline_status', plan.terminal);
        if (wrote) await repo.updateCell('AGENCIES', 'agency_id', agencyId, 'updated_at', now);
        else result.warnings.push('AGENCIES has no current_pipeline_status column; terminal status not written');
      }
      result.reconciliation = await reconcileAgencyActionsBestEffort(repo, agencyId, `call outcome ${outcome}`);
    } catch (err) {
      result.complete = false;
      result.warnings.push(`terminal status not written: ${err?.message || err}`);
    }
  }

  // 3) Record the verdict on the row itself so a retry or repair knows
  //    whether there is anything left to do.
  try {
    let meta = {};
    try { meta = JSON.parse(text(row.metadata_json) || '{}'); } catch { meta = {}; }
    meta.followups = result.complete ? 'COMPLETE' : 'PENDING';
    meta.followups_at = now;
    if (result.actions_created.length) meta.action_ids = [...new Set([...(meta.action_ids || []), ...result.actions_created.map((a) => a.action_id)])];
    const patch = { metadata_json: JSON.stringify(meta), updated_at: now };
    if (meta.action_ids?.length) patch.action_ids = meta.action_ids.join(',');
    await patchCallCells(repo, row.call_id, patch);
    row.metadata_json = patch.metadata_json;
  } catch (err) {
    result.warnings.push(`follow-up status not recorded: ${err?.message || err}`);
  }
  return result;
}

async function appendMissingObjectionEvents(repo, row, items, objectionsTable, now) {
  const wanted = (Array.isArray(items) ? items : []).slice(0, 40);
  if (!wanted.length) return { written: 0, titles: [] };
  const objectionsById = new Map(objectionRecords(objectionsTable).map((o) => [text(o.objection_id), o]));
  const existing = new Set(objectionEventRecords(await repo.getTable(CALL_OBJECTION_EVENTS_TAB))
    .filter((e) => text(e.call_id) === text(row.call_id)).map((e) => text(e.objection_id)));
  const events = wanted.flatMap((item) => {
    const objectionId = text(item?.objection_id);
    const objection = objectionsById.get(objectionId);
    if (!objection || existing.has(objectionId)) return [];
    existing.add(objectionId);
    const clickedAt = Number.isFinite(Date.parse(text(item?.clicked_at))) ? new Date(Date.parse(text(item.clicked_at))).toISOString() : now;
    const offset = Number(item?.offset_seconds);
    return [{
      event_id: newObjectionEventId(), call_id: row.call_id, agency_id: text(row.agency_id), objection_id: objectionId,
      objection_key: text(objection.objection_key), objection_title: text(objection.title), clicked_at: clickedAt,
      offset_seconds: Number.isFinite(offset) && offset >= 0 ? Math.round(offset) : '',
      source: upper(item?.source) === 'MANUAL' ? 'MANUAL' : 'LIVE', created_at: now,
    }];
  });
  if (events.length) await repo.appendRowsBatch(CALL_OBJECTION_EVENTS_TAB, events.map((e) => rowFor(CALL_OBJECTION_EVENTS_HEADER, e)));
  const titles = wanted.map((item) => objectionsById.get(text(item?.objection_id))?.title).filter(Boolean);
  return { written: events.length, titles: [...new Set(titles.map(text))] };
}

function isInboundCallRow(row) {
  try { return upper(JSON.parse(text(row?.metadata_json) || '{}').direction) === 'INBOUND'; } catch { return false; }
}
function followupsPending(row) {
  if (isDiscardedCall(row)) return false;
  try { return text(row.outcome) && JSON.parse(text(row.metadata_json) || '{}').followups !== 'COMPLETE'; } catch { return Boolean(text(row.outcome)); }
}

export async function handleCallingSave(req, res) {
  noStore(res);
  if (text(req.body?.confirm) !== 'SAVE_CALL') return res.status(400).json({ success: false, error: 'Missing confirm=SAVE_CALL' });
  const agencyId = text(req.body?.agency_id);
  if (!agencyId) return res.status(400).json({ success: false, error: 'agency_id is required' });
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const mainPriority = upper(req.body?.main_priority);
  const mainConstraint = upper(req.body?.main_constraint);
  if (mainPriority && !MAIN_PRIORITIES.includes(mainPriority)) return res.status(400).json({ success: false, error: 'invalid main_priority' });
  if (mainConstraint && !MAIN_CONSTRAINTS.includes(mainConstraint)) return res.status(400).json({ success: false, error: 'invalid main_constraint' });

  try {
    const repo = getRepo();
    const [agency, callsTable, objectionsTable] = await Promise.all([
      repo.findById('AGENCIES', 'agency_id', agencyId), repo.getTable(CALLS_TAB), repo.getTable(OBJECTIONS_TAB),
    ]);
    if (!agency) return res.status(404).json({ success: false, error: 'Agency not found' });
    const calls = callRecords(callsTable);
    const clientKey = text(req.body?.client_key);
    const requestedId = text(req.body?.call_id);
    const existing = (requestedId && calls.find((row) => text(row.call_id) === requestedId))
      || (clientKey && calls.find((row) => text(row.client_key) === clientKey)) || null;
    // An INBOUND row (lib/calling-inbound.mjs) is opened at ring time before
    // anyone has chosen the lead, so it may still carry no agency, or the
    // preselected candidate rather than the one the operator picked; the
    // save is what settles it. An outbound row never changes agency.
    const inboundRow = existing && isInboundCallRow(existing);
    if (existing && text(existing.agency_id) !== agencyId && !inboundRow) return res.status(409).json({ success: false, error: 'call_id belongs to a different agency' });
    if (existing && isDiscardedCall(existing)) return res.status(409).json({ success: false, discarded: true, error: 'This call was discarded as a technical issue and cannot be given an outcome. Start a new call.' });

    // ALREADY SAVED. Answer with what was written, and finish any follow-up
    // step that did not complete the first time (see applyCallFollowups).
    if (existing && text(existing.outcome)) {
      const warnings = [];
      let followups = { complete: true, actions_created: [], actions_completed: [], terminal: null, warnings: [] };
      try { await appendMissingObjectionEvents(repo, existing, req.body?.objections, objectionsTable, now); }
      catch (err) { warnings.push(`objection events not written: ${err?.message || err}`); }
      if (followupsPending(existing)) followups = await applyCallFollowups(repo, existing, { nowMs, outreachId: text(req.body?.outreach_id), probeId: text(req.body?.probe_id) });
      invalidateCallingCache();
      return res.status(200).json({ success: true, call: existing, reused: true, followups_complete: followups.complete, ...followups, warnings: [...warnings, ...followups.warnings] });
    }

    const outcomeCheck = normaliseOutcomeInput(req.body, nowMs);
    if (!outcomeCheck.valid) return res.status(400).json({ success: false, error: outcomeCheck.errors.join('; '), errors: outcomeCheck.errors });
    const normalised = outcomeCheck.normalised;
    const attemptNumber = existing ? (Number(existing.attempt_number) || 1) : calls.filter((c) => text(c.agency_id) === agencyId && text(c.outcome) && !isDiscardedCall(c)).length + 1;
    const row = existing
      ? { ...existing, ...(inboundRow ? { agency_id: agencyId, attempt_number: text(existing.attempt_number) || attemptNumber } : {}), ...Object.fromEntries(['contact_name', 'contact_role', 'phone', 'script_id', 'source_action_id', 'twilio_call_sid'].filter((k) => text(req.body?.[k])).map((k) => [k, text(req.body[k]).slice(0, 160)])) }
      : baseCallRow(req.body, { agency: agency.obj, attemptNumber, now });
    row.call_id = text(row.call_id) || newCallId();
    row.client_key = row.client_key || clientKey;

    // Timings. Twilio-mode rows already carry what the status callbacks wrote;
    // the browser's own clock fills whatever is still blank.
    for (const key of ['connected_at', 'ended_at']) {
      const value = text(req.body?.[key]);
      if (!text(row[key]) && Number.isFinite(Date.parse(value))) row[key] = new Date(Date.parse(value)).toISOString();
    }
    if (!text(row.ended_at)) row.ended_at = now;
    const duration = Number(req.body?.duration_seconds);
    if (!text(row.duration_seconds) && Number.isFinite(duration) && duration >= 0) row.duration_seconds = Math.round(duration);
    if (text(req.body?.call_status) && !existing) row.call_status = text(req.body.call_status);
    if (upper(row.call_mode) === 'MANUAL') row.call_status = 'manual';

    // Outcome + derived funnel facts.
    const outcome = normalised.outcome;
    const derived = { owner_reached: normalised.owner_reached, pitched_override: normalised.pitched_override };
    row.outcome = outcome;
    row.connected = deriveConnected(outcome) ? 'TRUE' : 'FALSE';
    row.owner_reached = deriveOwnerReached(outcome, derived) ? 'TRUE' : 'FALSE';
    row.pitched = derivePitched(outcome, derived) ? 'TRUE' : 'FALSE';

    // Gatekeeper/owner classification from the call's answer screen. Unlike
    // owner_reached above (derived from the outcome), these are typed in by
    // the operator the moment someone picks up and are carried through
    // whatever the eventual outcome turns out to be — a gatekeeper call can
    // still end in BOOKED_MEETING once the owner comes on the line.
    row.gatekeeper_reached = req.body?.gatekeeper_reached === true || upper(req.body?.gatekeeper_reached) === 'TRUE' ? 'TRUE' : 'FALSE';
    row.gatekeeper_reached_at = Number.isFinite(Date.parse(text(req.body?.gatekeeper_reached_at))) ? new Date(Date.parse(text(req.body.gatekeeper_reached_at))).toISOString() : '';
    row.owner_reached_at = Number.isFinite(Date.parse(text(req.body?.owner_reached_at))) ? new Date(Date.parse(text(req.body.owner_reached_at))).toISOString() : '';
    row.owner_reach_source = OWNER_REACH_SOURCES.includes(upper(req.body?.owner_reach_source)) ? upper(req.body.owner_reach_source) : '';

    row.callback_at = normalised.callback_at;
    row.callback_note = normalised.callback_note;
    row.not_interested_reason = normalised.not_interested_reason;
    row.not_interested_detail = normalised.not_interested_detail;
    row.more_info_type = normalised.more_info_type;
    row.more_info_note = normalised.more_info_note;
    row.meeting_at = normalised.meeting_at;
    row.meeting_note = normalised.meeting_note;
    row.referred_contact_json = normalised.referred_contact ? JSON.stringify(normalised.referred_contact) : '';
    const conversation = meaningfulConversation(outcome, derived);
    row.main_priority = conversation ? mainPriority : '';
    row.main_constraint = conversation ? mainConstraint : '';
    row.useful_note = text(req.body?.useful_note).slice(0, 1000);
    const objectionsById = new Map(objectionRecords(objectionsTable).map((o) => [text(o.objection_id), o]));
    row.objections = [...new Set((Array.isArray(req.body?.objections) ? req.body.objections : []).map((item) => text(objectionsById.get(text(item?.objection_id))?.title)).filter(Boolean))].join(' | ');
    // An inbound row keeps its direction + ring/answer trail alongside the
    // save's own bookkeeping.
    let keptMeta = {};
    if (inboundRow) { try { const m = JSON.parse(text(existing.metadata_json) || '{}'); keptMeta = { direction: m.direction, inbound: m.inbound }; } catch { keptMeta = {}; } }
    row.metadata_json = JSON.stringify({
      ...keptMeta, followups: 'PENDING', owner_reached_input: normalised.owner_reached, pitched_override: normalised.pitched_override,
    });
    row.updated_at = now;
    const validation = validateCallRow(row);
    if (!validation.valid) return res.status(400).json({ success: false, error: validation.errors.join('; ') });

    // 1) The call itself — the one write that must land. An opened Twilio row
    //    is patched cell-by-cell so a status/recording callback landing at the
    //    same moment cannot be overwritten by a whole-row write.
    if (existing) {
      const patch = {};
      for (const key of CALLS_HEADER) if (row[key] !== existing[key]) patch[key] = row[key];
      await patchCallCells(repo, row.call_id, patch);
    } else {
      await repo.appendRowsBatch(CALLS_TAB, [rowFor(CALLS_HEADER, row)]);
    }

    // 2) Objection events (idempotent per call + objection).
    const warnings = [];
    let objectionEvents = 0;
    try { objectionEvents = (await appendMissingObjectionEvents(repo, row, req.body?.objections, objectionsTable, now)).written; }
    catch (err) { warnings.push(`objection events not written: ${err?.message || err}`); }

    // 3) Everything the outcome implies — re-runnable, see above.
    const followups = await applyCallFollowups(repo, row, { nowMs, outreachId: text(req.body?.outreach_id), probeId: text(req.body?.probe_id) });

    invalidateCallingCache();
    return res.status(existing ? 200 : 201).json({
      success: true, call: row, reused: false, objection_events: objectionEvents, followups_complete: followups.complete,
      ...followups, warnings: [...warnings, ...followups.warnings],
    });
  } catch (err) {
    console.error('calling-save error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Could not save the call' });
  }
}

// ── POST calling-discard ───────────────────────────────────────────────────
// "Technical issue — discard call". The attempt was invalid (keypad/Twilio/
// audio/browser fault, accidental dial, IVR could not be navigated) and must
// behave as though it never happened: not a dial, not an attempt, no
// analytics, no follow-up, no change to the lead's state or queue position.
//
// SEMANTICS. The CALLS row opened by calling-start is FLAGGED, not deleted:
// call_status=discarded, outcome left blank, metadata_json.discarded=true
// (+ reason/time). liveCallRecords() hides it from every reader — the queue
// (attempts, suppression, last_call), attempt numbering in calling-start /
// calling-save, scriptFunnel, the analytics read model (not even
// `unclassified`), workspace counts and the follow-up integrity list — so no
// counting path needs to know about it individually. Why not delete: Twilio's
// status and recording callbacks patch CALLS by row number for several
// seconds after hangup; a deleteDimension in that window would shift a
// concurrent patch onto a different call's row. CALL_OBJECTION_EVENTS has no
// such writer, so any event rows for the call ARE physically removed, and any
// ACTIONS the call created (dedupe_key ends ":call:<call_id>") are CANCELLED.
// Both are normally empty — the option is offered before an outcome is saved.
//
// IDEMPOTENT. A second discard of the same call returns reused=true and
// writes nothing. A call that already has an outcome cannot be discarded
// (409): undoing a saved outcome's side effects (terminal pipeline status,
// engine reconciliation) is a different operation. A call that never opened
// a row (manual mode) is discarded purely in the browser; the server answers
// success with discarded=false so the page's flow is identical in both modes.
export async function handleCallingDiscard(req, res) {
  noStore(res);
  if (text(req.body?.confirm) !== 'DISCARD_CALL') return res.status(400).json({ success: false, error: 'Missing confirm=DISCARD_CALL' });
  const callId = text(req.body?.call_id);
  const clientKey = text(req.body?.client_key);
  const agencyId = text(req.body?.agency_id);
  const reason = DISCARD_REASONS.includes(upper(req.body?.reason)) ? upper(req.body.reason) : DISCARD_REASONS[0];
  const note = text(req.body?.note).slice(0, 300);
  if (!callId && !clientKey) return res.status(400).json({ success: false, error: 'call_id or client_key is required' });
  try {
    const repo = getRepo();
    const callsTable = await repo.getTable(CALLS_TAB);
    const calls = callRecords(callsTable);
    const existing = (callId && calls.find((row) => text(row.call_id) === callId))
      || (clientKey && calls.find((row) => text(row.client_key) === clientKey)) || null;
    if (!existing) return res.status(200).json({ success: true, discarded: false, reused: false, reason: 'no CALLS row was opened for this call' });
    if (agencyId && text(existing.agency_id) !== agencyId) return res.status(409).json({ success: false, error: 'call_id belongs to a different agency' });
    if (isDiscardedCall(existing)) return res.status(200).json({ success: true, discarded: true, reused: true, call: existing, objection_events_removed: 0, actions_cancelled: [] });
    if (text(existing.outcome)) return res.status(409).json({ success: false, error: 'This call already has a saved outcome and cannot be discarded.' });

    const now = new Date().toISOString();
    let meta = {};
    try { meta = JSON.parse(text(existing.metadata_json) || '{}'); } catch { meta = {}; }
    meta.discarded = true; meta.discard_reason = reason; meta.discarded_at = now;
    if (note) meta.discard_note = note;
    const patch = { call_status: DISCARDED_CALL_STATUS, outcome: '', metadata_json: JSON.stringify(meta), updated_at: now };
    if (!text(existing.ended_at)) patch.ended_at = now;
    // 1) The flag — the one write that must land.
    const row = await patchCallCells(repo, existing.call_id, patch);

    const warnings = [];
    // 2) Objection events logged live on this call: physically removed (this
    //    tab is append-only otherwise, so row deletion is safe here).
    let eventsRemoved = 0;
    try {
      const eventsTable = await repo.getTable(CALL_OBJECTION_EVENTS_TAB);
      const rows = parseRecords(eventsTable, 'event_id').filter((r) => text(r.obj.call_id) === text(existing.call_id));
      if (rows.length) { await repo.deleteRows(CALL_OBJECTION_EVENTS_TAB, rows.map((r) => r.rowNumber)); eventsRemoved = rows.length; }
    } catch (err) { warnings.push(`objection events not removed: ${err?.message || err}`); }
    // 3) Actions this call created (none before an outcome, but a partially
    //    failed earlier save could have left some): cancelled, never completed.
    let cancelled = [];
    try {
      const actionsTable = await repo.getTable(ACTIONS_TAB);
      if (actionsTable.header?.length) {
        const own = parseActionRecords(actionsTable).map((r) => r.obj)
          .filter((a) => text(a.dedupe_key).endsWith(`:call:${text(existing.call_id)}`) && ACTIVE.has(upper(a.action_status)));
        const plan = buildActionPatchPlan(actionsTable, own.map((a) => ({
          action_id: a.action_id,
          patch: { action_status: 'CANCELLED', updated_at: now, completion_reason: `CALL_DISCARDED:${reason} (${existing.call_id})` },
        })));
        if (plan.writes.length) await repo.writeRowsBatch(plan.writes);
        cancelled = own.map((a) => text(a.action_id));
      }
    } catch (err) { warnings.push(`actions not cancelled: ${err?.message || err}`); }

    invalidateCallingCache();
    return res.status(200).json({ success: true, discarded: true, reused: false, call: row, objection_events_removed: eventsRemoved, actions_cancelled: cancelled, warnings });
  } catch (err) {
    console.error('calling-discard error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Could not discard the call' });
  }
}

// ── POST calling-repair ────────────────────────────────────────────────────
// Re-runs the follow-up step for every saved call whose follow-ups are still
// PENDING (a Sheets write failed after the row landed). Bounded, idempotent,
// and the same code path a retried save takes.
export async function handleCallingRepair(req, res) {
  noStore(res);
  if (text(req.body?.confirm) !== 'REPAIR_CALL_FOLLOWUPS') return res.status(400).json({ success: false, error: 'Missing confirm=REPAIR_CALL_FOLLOWUPS' });
  try {
    const repo = getRepo();
    const pending = liveCallRecords(await repo.getTable(CALLS_TAB)).filter(followupsPending).slice(0, 25);
    const results = [];
    for (const row of pending) {
      const out = await applyCallFollowups(repo, row);
      results.push({ call_id: row.call_id, agency_id: row.agency_id, outcome: row.outcome, complete: out.complete, actions_created: out.actions_created.length, warnings: out.warnings });
    }
    invalidateCallingCache();
    return res.status(200).json({ success: true, repaired: results.filter((r) => r.complete).length, still_pending: results.filter((r) => !r.complete).length, results });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || 'Repair failed' });
  }
}

export const _internal = { baseCallRow, scriptsPayload, objectionsPayload, loadContextTables, readActions, followupsPending };
