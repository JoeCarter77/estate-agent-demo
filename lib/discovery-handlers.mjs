// lib/discovery-handlers.mjs — the HTTP operations behind the meeting
// discovery workspace (novus/meetings.html). Mounted as ?novus_operation=
// branches on api/novus/personalisation.js (the 12-function ceiling); every
// handler assumes Basic Auth was already enforced by the router.
//
// READ   discovery-meetings   booked meetings (CALLS / ACTIONS / AGENCIES / DEMOS)
//                             + every discovery session, grouped by agency
//        discovery-session    one session with its prepopulated agency context,
//                             the question + rule registries, live diagnosis,
//                             and every stored pitch version
// WRITE  discovery-setup      creates the two tabs if missing
//        discovery-start      opens (or resumes) a session for an agency
//        discovery-save       autosave: answers / notes / overrides / stage,
//                             re-runs the deterministic diagnosis, patches the row
//        discovery-pitch      generates + appends a pitch version (never overwrites)
//        discovery-outcome    records the meeting outcome, freezes the snapshot
//
// The diagnosis is recomputed server-side on every save from the stored
// answers, so what the row holds is always what the engine says about those
// answers — the browser never writes a diagnosis of its own.

import { getRepo } from './sheets.mjs';
import { appendAction } from './actions-store.mjs';
import { liveCallRecords } from './calling-store.mjs';
import { resolvePropertyStreet } from './property-reference.mjs';
import { QUESTIONS, SECTIONS, DIMENSIONS, SKIP_REASONS, QUESTIONS_VERSION, snapshotFor } from './discovery-questions.mjs';
import { RULES, RULES_VERSION, DELIVERY_STATUSES, FOUNDING_OFFER, PLAN_PHASES } from './discovery-rules.mjs';
import { diagnose, SUITABILITY_POLICY } from './discovery-engine.mjs';
import { generatePitch, PITCH_SECTIONS } from './discovery-pitch.mjs';
import {
  DISCOVERY_SESSIONS_TAB, DISCOVERY_SESSIONS_HEADER, DISCOVERY_PITCHES_TAB, DISCOVERY_PITCHES_HEADER,
  MEETING_OUTCOMES, SESSION_STAGES, ensureDiscoveryTabs, newPitchId, newSessionId, parseRecords, patchSessionCells,
  pitchRecords, pitchView, readDiscoveryTables, rowFor, sessionRecords, sessionView,
} from './discovery-store.mjs';

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();
const ts = (value) => { const n = Date.parse(text(value)); return Number.isFinite(n) ? n : null; };
const noStore = (res) => res.setHeader('Cache-Control', 'private, no-store, max-age=0');
const ACTIVE = new Set(['PENDING', 'DUE', 'IN_PROGRESS', 'SNOOZED']);

function records(table, idColumn) {
  const header = table?.header || [];
  const at = header.indexOf(idColumn);
  if (at < 0) return [];
  return (table.rows || []).flatMap((row) => {
    const id = text(row[at]);
    if (!id || id === 'SCHEMA NOTE') return [];
    return [Object.fromEntries(header.map((key, i) => [key, row[i] ?? '']))];
  });
}
function metadata(row) { try { return JSON.parse(text(row?.metadata_json) || '{}'); } catch { return {}; } }

const CONTEXT_TABS = ['AGENCIES', 'CONTACTS', 'CALLS', 'ACTIONS', 'PROBES', 'INTELLIGENCE', 'DIAGNOSIS', 'DEMOS'];
async function loadContextTables(repo) {
  const entries = await Promise.all(CONTEXT_TABS.map(async (tab) => {
    try { return [tab, await repo.getTable(tab)]; }
    catch (err) { if (tab === 'AGENCIES') throw err; return [tab, { header: [], rows: [] }]; }
  }));
  return Object.fromEntries(entries);
}

// The registries the page renders from. Sent with every session read so the
// UI never hard-codes a question.
function registryPayload() {
  return {
    questions_version: QUESTIONS_VERSION, rules_version: RULES_VERSION,
    sections: SECTIONS, dimensions: DIMENSIONS, skip_reasons: SKIP_REASONS, questions: QUESTIONS,
    rules: RULES, delivery_statuses: DELIVERY_STATUSES, offer: FOUNDING_OFFER, plan_phases: PLAN_PHASES,
    outcomes: MEETING_OUTCOMES, stages: SESSION_STAGES, pitch_sections: PITCH_SECTIONS, suitability_policy: SUITABILITY_POLICY,
  };
}

// ── agency context: what we already know, never invented ──────────────────
export function buildAgencyContext(tables, agencyId, { now = new Date().toISOString() } = {}) {
  const id = text(agencyId);
  const agency = records(tables.AGENCIES, 'agency_id').find((row) => text(row.agency_id) === id) || null;
  if (!agency) return null;
  const contacts = records(tables.CONTACTS, 'contact_id').filter((row) => text(row.agency_id) === id);
  const selected = contacts.find((row) => upper(row.is_selected_for_outreach) === 'TRUE') || null;
  const calls = liveCallRecords(tables.CALLS).filter((row) => text(row.agency_id) === id)
    .sort((a, b) => (ts(b.started_at) ?? 0) - (ts(a.started_at) ?? 0));
  const meetingCall = calls.find((row) => upper(row.outcome) === 'BOOKED_MEETING' && text(row.meeting_at)) || null;
  const actions = records(tables.ACTIONS, 'action_id').filter((row) => text(row.agency_id) === id);
  const prepare = actions.filter((row) => upper(row.action_type) === 'PREPARE_MEETING' && ACTIVE.has(upper(row.action_status)))
    .sort((a, b) => (ts(a.due_at) ?? 0) - (ts(b.due_at) ?? 0))[0] || null;
  const probes = records(tables.PROBES, 'probe_id').filter((row) => text(row.agency_id) === id)
    .sort((a, b) => (ts(b.probe_timestamp) ?? ts(b.created_at) ?? 0) - (ts(a.probe_timestamp) ?? ts(a.created_at) ?? 0));
  const probe = probes.find((row) => ['OBSERVING', 'ACTIVE', 'CLOSED'].includes(upper(row.probe_status))) || probes[0] || null;
  const intel = probe ? records(tables.INTELLIGENCE, 'intelligence_id').filter((row) => text(row.probe_id) === text(probe.probe_id))
    .sort((a, b) => (ts(b.updated_at) ?? 0) - (ts(a.updated_at) ?? 0))[0] || null : null;
  const diagnosisRow = records(tables.DIAGNOSIS, 'diagnosis_id').filter((row) => text(row.agency_id) === id)
    .sort((a, b) => (ts(b.updated_at) ?? 0) - (ts(a.updated_at) ?? 0))[0] || null;
  const demo = records(tables.DEMOS, 'demo_id').filter((row) => text(row.agency_id) === id)
    .sort((a, b) => (ts(b.updated_at) ?? ts(b.created_at) ?? 0) - (ts(a.updated_at) ?? ts(a.created_at) ?? 0))[0] || null;

  const meetingAt = text(meetingCall?.meeting_at) || text(demo?.meeting_booked_at) || '';
  const branchCount = Number(text(agency.branch_count));
  return {
    agency_id: id,
    agency_name: text(agency.clean_agency_name || agency.agency_name),
    contact_name: text(meetingCall?.contact_name) || text(agency.outreach_contact_name || agency.primary_contact_name) || text(selected?.contact_name),
    contact_role: text(meetingCall?.contact_role) || text(selected?.contact_role),
    location: text(agency.location),
    crm_name: text(agency.crm_name),
    branch_count: Number.isFinite(branchCount) && branchCount > 0 ? branchCount : null,
    pipeline_status: text(agency.current_pipeline_status),
    meeting_at: meetingAt,
    meeting_note: text(meetingCall?.meeting_note),
    meeting_source: meetingCall ? 'CALLS' : demo?.meeting_booked_at ? 'DEMOS' : prepare ? 'ACTIONS' : upper(agency.current_pipeline_status) === 'MEETING_BOOKED' ? 'AGENCIES' : '',
    source_call_id: text(meetingCall?.call_id),
    prepare_action: prepare ? { action_id: text(prepare.action_id), due_at: text(prepare.due_at), reason: text(prepare.reason) } : null,
    probe: probe ? {
      probe_id: text(probe.probe_id), reference: text(probe.probe_reference), property: resolvePropertyStreet(probe) || text(probe.property_address),
      sent_at: text(probe.probe_timestamp), status: text(probe.probe_status),
      grade: text(intel?.grade), grade_reason: text(intel?.grade_reason), human_contact: text(intel?.human_contact), response_hours: text(intel?.response_hours),
      seller_recognition: text(intel?.seller_recognition), contact_attempts: text(intel?.contact_attempts), follow_ups: text(intel?.follow_ups), channels_used: text(intel?.channels_used),
    } : null,
    diagnosis_summary: text(diagnosisRow?.handling_summary || diagnosisRow?.diagnosis_summary).slice(0, 400),
    previous_calls: calls.filter((row) => text(row.outcome)).slice(0, 6).map((row) => ({
      call_id: text(row.call_id), at: text(row.started_at), outcome: text(row.outcome), contact_name: text(row.contact_name),
      main_priority: text(row.main_priority), main_constraint: text(row.main_constraint),
      note: text(row.useful_note || row.meeting_note || row.callback_note || row.more_info_note).slice(0, 400), objections: text(row.objections),
    })),
    generated_at: now,
  };
}

// ── GET discovery-meetings ────────────────────────────────────────────────
export async function handleDiscoveryMeetings(req, res) {
  noStore(res);
  try {
    const repo = getRepo();
    const [context, discovery] = await Promise.all([loadContextTables(repo), readDiscoveryTables(repo)]);
    const now = new Date().toISOString();
    const nowMs = Date.now();
    const agencies = new Map(records(context.AGENCIES, 'agency_id').map((row) => [text(row.agency_id), row]));
    const byAgency = new Map();
    const touch = (agencyId) => {
      const id = text(agencyId);
      if (!id) return null;
      if (!byAgency.has(id)) {
        const agency = agencies.get(id);
        byAgency.set(id, {
          agency_id: id, agency_name: text(agency?.clean_agency_name || agency?.agency_name) || id, location: text(agency?.location),
          contact_name: text(agency?.outreach_contact_name || agency?.primary_contact_name), crm_name: text(agency?.crm_name),
          pipeline_status: text(agency?.current_pipeline_status), meeting_at: '', meeting_note: '', meeting_sources: [], session: null, sessions: [],
        });
      }
      return byAgency.get(id);
    };
    for (const call of liveCallRecords(context.CALLS)) {
      if (upper(call.outcome) !== 'BOOKED_MEETING') continue;
      const entry = touch(call.agency_id); if (!entry) continue;
      entry.meeting_sources.push('CALLS');
      const at = text(call.meeting_at);
      if (at && (!entry.meeting_at || ((ts(at) ?? 0) >= nowMs && (ts(at) ?? 0) < (ts(entry.meeting_at) ?? Infinity)) || ((ts(entry.meeting_at) ?? 0) < nowMs && (ts(at) ?? 0) > (ts(entry.meeting_at) ?? 0)))) {
        entry.meeting_at = at; entry.meeting_note = text(call.meeting_note); entry.contact_name = text(call.contact_name) || entry.contact_name;
      }
    }
    for (const action of records(context.ACTIONS, 'action_id')) {
      if (upper(action.action_type) !== 'PREPARE_MEETING' || !ACTIVE.has(upper(action.action_status))) continue;
      const entry = touch(action.agency_id); if (!entry) continue;
      entry.meeting_sources.push('ACTIONS');
    }
    for (const demo of records(context.DEMOS, 'demo_id')) {
      if (!text(demo.meeting_booked_at)) continue;
      const entry = touch(demo.agency_id); if (!entry) continue;
      entry.meeting_sources.push('DEMOS');
      if (!entry.meeting_at) entry.meeting_at = text(demo.meeting_booked_at);
    }
    for (const [id, agency] of agencies) {
      if (upper(agency.current_pipeline_status) !== 'MEETING_BOOKED') continue;
      touch(id).meeting_sources.push('AGENCIES');
    }
    const sessions = sessionRecords(discovery.tables[DISCOVERY_SESSIONS_TAB]).map(sessionView)
      .sort((a, b) => (ts(b.updated_at) ?? 0) - (ts(a.updated_at) ?? 0));
    for (const session of sessions) {
      const entry = touch(session.agency_id); if (!entry) continue;
      const summary = {
        session_id: session.session_id, status: session.status, stage: session.stage, outcome: session.outcome, follow_up_at: session.follow_up_at,
        suitability: session.diagnosis?.suitability?.verdict || '', proposed: session.diagnosis?.proposed || [], pitch_count: session.pitch_count,
        progress: session.diagnosis?.progress || null, created_at: session.created_at, updated_at: session.updated_at, completed_at: session.completed_at,
      };
      entry.sessions.push(summary);
      if (!entry.session || session.status === 'IN_PROGRESS' && entry.session.status !== 'IN_PROGRESS') entry.session = summary;
      if (!entry.meeting_at && session.meeting_at) entry.meeting_at = session.meeting_at;
    }
    const meetings = [...byAgency.values()].map((entry) => ({ ...entry, meeting_sources: [...new Set(entry.meeting_sources)] }));
    const bucket = (m) => {
      const at = ts(m.meeting_at);
      if (m.session?.status === 'IN_PROGRESS') return 0;
      if (at !== null && at >= nowMs - 6 * 3600_000) return 1;
      if (!m.session) return 2;
      return 3;
    };
    meetings.sort((a, b) => bucket(a) - bucket(b) || ((ts(a.meeting_at) ?? Infinity) - (ts(b.meeting_at) ?? Infinity)) || ((ts(b.session?.updated_at) ?? 0) - (ts(a.session?.updated_at) ?? 0)));
    return res.status(200).json({
      success: true, generated_at: now,
      setup: { available: discovery.available, missing: discovery.missing, header_mismatch: discovery.header_mismatch },
      counts: {
        upcoming: meetings.filter((m) => (ts(m.meeting_at) ?? 0) >= nowMs).length,
        in_progress: meetings.filter((m) => m.session?.status === 'IN_PROGRESS').length,
        completed: sessions.filter((s) => s.status === 'COMPLETED').length,
        pilots_agreed: sessions.filter((s) => s.outcome === 'PILOT_AGREED').length,
      },
      meetings,
      outcomes: MEETING_OUTCOMES,
      versions: { questions: QUESTIONS_VERSION, rules: RULES_VERSION },
    });
  } catch (err) {
    console.error('discovery-meetings error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Could not load meetings' });
  }
}

// ── GET discovery-session ─────────────────────────────────────────────────
async function loadSession(repo, { sessionId, agencyId }) {
  const table = await repo.getTable(DISCOVERY_SESSIONS_TAB);
  const rows = parseRecords(table, 'session_id');
  let record = null;
  if (sessionId) record = rows.find((r) => text(r.obj.session_id) === text(sessionId)) || null;
  else if (agencyId) {
    const mine = rows.filter((r) => text(r.obj.agency_id) === text(agencyId)).sort((a, b) => (ts(b.obj.updated_at) ?? 0) - (ts(a.obj.updated_at) ?? 0));
    record = mine.find((r) => upper(r.obj.status) === 'IN_PROGRESS') || mine[0] || null;
  }
  return record ? sessionView(record.obj) : null;
}

export async function handleDiscoverySession(req, res) {
  noStore(res);
  const sessionId = text(req.query?.session_id);
  const agencyId = text(req.query?.agency_id);
  if (!sessionId && !agencyId) return res.status(400).json({ success: false, error: 'Missing session_id or agency_id' });
  try {
    const repo = getRepo();
    const discovery = await readDiscoveryTables(repo);
    if (!discovery.available) return res.status(409).json({ success: false, error: 'Discovery tabs are not set up', setup: { available: false, missing: discovery.missing, header_mismatch: discovery.header_mismatch } });
    const session = await loadSession(repo, { sessionId, agencyId });
    if (!session && sessionId) return res.status(404).json({ success: false, error: 'Session not found' });
    const context = await loadContextTables(repo);
    const agencyContext = buildAgencyContext(context, session?.agency_id || agencyId);
    if (!agencyContext) return res.status(404).json({ success: false, error: 'Agency not found' });
    const pitches = session ? pitchRecords(discovery.tables[DISCOVERY_PITCHES_TAB]).map(pitchView).filter((p) => p.session_id === session.session_id).sort((a, b) => b.version - a.version) : [];
    const live = session ? diagnose({ answers: session.answers, overrides: session.overrides, notes: session.notes }) : null;
    return res.status(200).json({
      success: true, generated_at: new Date().toISOString(), session, context: agencyContext, pitches, diagnosis: live, registry: registryPayload(),
      registry_drift: session ? { questions: session.questions_version !== null && session.questions_version !== QUESTIONS_VERSION, rules: session.rules_version !== null && session.rules_version !== RULES_VERSION } : null,
    });
  } catch (err) {
    console.error('discovery-session error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Could not load the session' });
  }
}

// ── POST discovery-setup ──────────────────────────────────────────────────
export async function handleDiscoverySetup(req, res) {
  noStore(res);
  if (text(req.body?.confirm) !== 'SETUP_DISCOVERY') return res.status(400).json({ success: false, error: 'Missing confirm=SETUP_DISCOVERY' });
  try {
    const results = await ensureDiscoveryTabs(getRepo());
    return res.status(200).json({ success: true, results });
  } catch (err) {
    console.error('discovery-setup error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Could not create the discovery tabs' });
  }
}

// ── POST discovery-start ──────────────────────────────────────────────────
// Prefills from the agency record are recorded as answers carrying
// source='AGENCIES' + prefilled=true so the operator can see and override
// them; nothing is invented for a blank field.
function prefillAnswers(context) {
  const answers = {};
  const now = new Date().toISOString();
  if (context.branch_count) answers.C3 = { value: context.branch_count, source: 'AGENCIES', prefilled: true, answered_at: now };
  if (context.crm_name) {
    const known = QUESTIONS.find((q) => q.id === 'C6').options.find((o) => o.label.toLowerCase() === context.crm_name.toLowerCase());
    answers.C6 = known ? { value: known.value, source: 'AGENCIES', prefilled: true, answered_at: now } : { value: 'other', note: context.crm_name, source: 'AGENCIES', prefilled: true, answered_at: now };
  }
  return answers;
}

export async function handleDiscoveryStart(req, res) {
  noStore(res);
  const agencyId = text(req.body?.agency_id);
  if (!agencyId) return res.status(400).json({ success: false, error: 'Missing agency_id' });
  try {
    const repo = getRepo();
    const discovery = await readDiscoveryTables(repo);
    if (!discovery.available) return res.status(409).json({ success: false, error: 'Discovery tabs are not set up' });
    const existing = await loadSession(repo, { agencyId });
    if (existing && existing.status === 'IN_PROGRESS' && req.body?.force_new !== true) {
      return res.status(200).json({ success: true, session_id: existing.session_id, resumed: true });
    }
    const context = buildAgencyContext(await loadContextTables(repo), agencyId);
    if (!context) return res.status(404).json({ success: false, error: 'Agency not found' });
    const now = new Date().toISOString();
    const answers = prefillAnswers(context);
    const diagnosis = diagnose({ answers });
    const row = Object.fromEntries(DISCOVERY_SESSIONS_HEADER.map((key) => [key, '']));
    Object.assign(row, {
      session_id: newSessionId(), agency_id: agencyId, agency_name: context.agency_name, contact_name: context.contact_name,
      meeting_at: text(req.body?.meeting_at) || context.meeting_at, source_call_id: text(req.body?.source_call_id) || context.source_call_id,
      status: 'IN_PROGRESS', stage: 'commercial', questions_version: String(QUESTIONS_VERSION), rules_version: String(RULES_VERSION),
      answers_json: JSON.stringify(answers), notes_json: '{}', overrides_json: '{}',
      diagnosis_json: JSON.stringify(diagnosis), plan_json: JSON.stringify(diagnosis.plan), economics_json: JSON.stringify(diagnosis.economics),
      pitch_count: '0', created_at: now, updated_at: now,
    });
    await repo.appendRowsBatch(DISCOVERY_SESSIONS_TAB, [rowFor(DISCOVERY_SESSIONS_HEADER, row)]);
    return res.status(201).json({ success: true, session_id: row.session_id, resumed: false });
  } catch (err) {
    console.error('discovery-start error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Could not start the session' });
  }
}

// ── POST discovery-save (autosave) ────────────────────────────────────────
// The client sends the whole answers/notes/overrides objects. Answers are
// validated against the registry: unknown question ids are dropped, option
// values must exist, numbers must be numbers. Nothing is silently rewritten
// beyond that; an override is stored with the reason the operator gave.
const QUESTION_IDS = new Set(QUESTIONS.map((q) => q.id));
function cleanAnswer(question, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  if (raw.skipped === true) {
    out.skipped = true; out.skip_reason = text(raw.skip_reason).slice(0, 200);
    out.note = text(raw.note).slice(0, 1000);
    out.answered_at = text(raw.answered_at) || new Date().toISOString();
    return out;
  }
  if (question.multi) {
    const allowed = new Set(question.options.map((o) => o.value));
    out.values = [...new Set((Array.isArray(raw.values) ? raw.values : []).map(text).filter((v) => allowed.has(v)))];
  } else if (question.type === 'number') {
    const n = Number(raw.value);
    if (raw.value === '' || raw.value === null || raw.value === undefined || !Number.isFinite(n)) return text(raw.note) ? { note: text(raw.note).slice(0, 1000) } : null;
    out.value = n;
    out.source = ['actual', 'owner_estimate', 'AGENCIES'].includes(text(raw.source)) ? text(raw.source) : 'owner_estimate';
  } else if (question.type === 'text') {
    out.value = text(raw.value).slice(0, 2000);
  } else {
    const allowed = new Set(question.options.map((o) => o.value));
    out.value = allowed.has(text(raw.value)) ? text(raw.value) : '';
    if (!out.value && !text(raw.note)) return null;
  }
  out.note = text(raw.note).slice(0, 1000);
  if (raw.prefilled === true) { out.prefilled = true; out.source = text(raw.source) || out.source || ''; }
  out.answered_at = text(raw.answered_at) || new Date().toISOString();
  return out;
}
export function cleanAnswers(raw) {
  const out = {};
  for (const [id, value] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (!QUESTION_IDS.has(id)) continue;
    const question = QUESTIONS.find((q) => q.id === id);
    const cleaned = cleanAnswer(question, value);
    if (cleaned) out[id] = cleaned;
  }
  return out;
}
export function cleanOverrides(raw) {
  const out = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const d of DIMENSIONS) {
    const o = src[d.id];
    if (!o || typeof o !== 'object') continue;
    if (!text(o.reason)) continue;
    out[d.id] = { level: text(o.level), evidence_status: text(o.evidence_status), reason: text(o.reason).slice(0, 500), at: text(o.at) || new Date().toISOString() };
  }
  const rules = {};
  for (const r of RULES) {
    const o = src.rules?.[r.rule_id];
    if (!o || typeof o !== 'object' || typeof o.include !== 'boolean') continue;
    if (!text(o.reason)) continue;
    rules[r.rule_id] = { include: o.include, reason: text(o.reason).slice(0, 500), at: text(o.at) || new Date().toISOString() };
  }
  if (Object.keys(rules).length) out.rules = rules;
  return out;
}
function cleanNotes(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return { meeting: text(src.meeting).slice(0, 8000), diagnosis: text(src.diagnosis).slice(0, 4000) };
}

export async function handleDiscoverySave(req, res) {
  noStore(res);
  const sessionId = text(req.body?.session_id);
  if (!sessionId) return res.status(400).json({ success: false, error: 'Missing session_id' });
  try {
    const repo = getRepo();
    const session = await loadSession(repo, { sessionId });
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
    if (session.status === 'COMPLETED' && req.body?.reopen !== true) return res.status(409).json({ success: false, error: 'Session is completed; send reopen=true to edit it' });
    const answers = req.body?.answers !== undefined ? cleanAnswers(req.body.answers) : session.answers;
    const notes = req.body?.notes !== undefined ? cleanNotes(req.body.notes) : session.notes;
    const overrides = req.body?.overrides !== undefined ? cleanOverrides(req.body.overrides) : session.overrides;
    const stage = SESSION_STAGES.includes(text(req.body?.stage)) ? text(req.body.stage) : session.stage;
    const diagnosis = diagnose({ answers, overrides, notes });
    const now = new Date().toISOString();
    const patch = {
      answers_json: JSON.stringify(answers), notes_json: JSON.stringify(notes), overrides_json: JSON.stringify(overrides), stage,
      diagnosis_json: JSON.stringify(diagnosis), plan_json: JSON.stringify(diagnosis.plan), economics_json: JSON.stringify(diagnosis.economics),
      updated_at: now,
    };
    if (text(req.body?.meeting_at) && ts(req.body.meeting_at) !== null) patch.meeting_at = new Date(ts(req.body.meeting_at)).toISOString();
    if (text(req.body?.contact_name)) patch.contact_name = text(req.body.contact_name).slice(0, 120);
    if (session.status === 'COMPLETED' && req.body?.reopen === true) { patch.status = 'IN_PROGRESS'; patch.completed_at = ''; }
    await patchSessionCells(repo, sessionId, patch);
    return res.status(200).json({ success: true, session_id: sessionId, saved_at: now, diagnosis, stage });
  } catch (err) {
    console.error('discovery-save error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Could not save the session' });
  }
}

// ── POST discovery-pitch ──────────────────────────────────────────────────
export async function handleDiscoveryPitch(req, res) {
  noStore(res);
  const sessionId = text(req.body?.session_id);
  if (!sessionId) return res.status(400).json({ success: false, error: 'Missing session_id' });
  if (text(req.body?.confirm) !== 'GENERATE_PITCH') return res.status(400).json({ success: false, error: 'Missing confirm=GENERATE_PITCH' });
  try {
    const repo = getRepo();
    const session = await loadSession(repo, { sessionId });
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
    // Always from the stored answers, never from a diagnosis the browser sent.
    const diagnosis = diagnose({ answers: session.answers, overrides: session.overrides, notes: session.notes });
    const result = await generatePitch({ session, diagnosis });
    const now = new Date().toISOString();
    const version = (session.pitch_count || 0) + 1;
    const row = Object.fromEntries(DISCOVERY_PITCHES_HEADER.map((key) => [key, '']));
    Object.assign(row, {
      pitch_id: newPitchId(), session_id: sessionId, agency_id: session.agency_id, version: String(version), source: result.source, model: result.model,
      status: result.validation.valid ? 'OK' : 'INVALID', pitch_json: JSON.stringify(result.pitch), plan_json: JSON.stringify(diagnosis.plan),
      diagnosis_snapshot_json: JSON.stringify({ suitability: diagnosis.suitability, proposed: diagnosis.proposed, findings: Object.fromEntries(Object.entries(diagnosis.assessments).map(([k, a]) => [k, { level: a.level, evidence_status: a.evidence_status, verified: a.verified }])), economics: diagnosis.economics.baseline, versions: diagnosis.versions }),
      validation_json: JSON.stringify(result.validation), error: text(result.error).slice(0, 1000),
      questions_version: String(QUESTIONS_VERSION), rules_version: String(RULES_VERSION), created_at: now,
    });
    await repo.appendRowsBatch(DISCOVERY_PITCHES_TAB, [rowFor(DISCOVERY_PITCHES_HEADER, row)]);
    await patchSessionCells(repo, sessionId, { latest_pitch_id: row.pitch_id, pitch_count: String(version), stage: 'pitch', updated_at: now, diagnosis_json: JSON.stringify(diagnosis), plan_json: JSON.stringify(diagnosis.plan) });
    return res.status(201).json({ success: true, pitch: pitchView(row), diagnosis, ai_error: result.error || '' });
  } catch (err) {
    console.error('discovery-pitch error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Could not generate the pitch' });
  }
}

// ── POST discovery-outcome ────────────────────────────────────────────────
export async function handleDiscoveryOutcome(req, res) {
  noStore(res);
  const sessionId = text(req.body?.session_id);
  const outcome = upper(req.body?.outcome);
  if (!sessionId) return res.status(400).json({ success: false, error: 'Missing session_id' });
  if (text(req.body?.confirm) !== 'RECORD_OUTCOME') return res.status(400).json({ success: false, error: 'Missing confirm=RECORD_OUTCOME' });
  if (!MEETING_OUTCOMES[outcome]) return res.status(400).json({ success: false, error: `Invalid outcome; one of ${Object.keys(MEETING_OUTCOMES).join(', ')}` });
  const followUpAt = text(req.body?.follow_up_at);
  if (followUpAt && ts(followUpAt) === null) return res.status(400).json({ success: false, error: 'follow_up_at is not a valid date/time' });
  try {
    const repo = getRepo();
    const session = await loadSession(repo, { sessionId });
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
    const now = new Date().toISOString();
    const diagnosis = diagnose({ answers: session.answers, overrides: session.overrides, notes: session.notes });
    const warnings = [];
    const patch = {
      status: 'COMPLETED', stage: 'outcome', outcome, outcome_notes: text(req.body?.outcome_notes).slice(0, 4000),
      follow_up_at: followUpAt ? new Date(ts(followUpAt)).toISOString() : '', completed_at: now, updated_at: now,
      question_snapshot_json: JSON.stringify(snapshotFor(session.answers)),
      diagnosis_json: JSON.stringify(diagnosis), plan_json: JSON.stringify(diagnosis.plan),
    };
    if (outcome === 'PILOT_AGREED') {
      const requested = Array.isArray(req.body?.agreed_scope_rule_ids) ? req.body.agreed_scope_rule_ids.map(text) : diagnosis.proposed;
      const proposed = new Set(diagnosis.proposed);
      const ruleIds = requested.filter((id) => proposed.has(id));
      patch.agreed_scope_json = JSON.stringify({
        rule_ids: ruleIds, agreed_at: now, pitch_id: session.latest_pitch_id, plan: diagnosis.plan, offer: FOUNDING_OFFER,
        // The onboarding/delivery checklist: one line per implementation step
        // of every agreed rule, in plan order, plus what the agency provides.
        checklist: [
          ...diagnosis.plan.required_access.map((item) => ({ phase: 'p1', owner: 'AGENCY', item: `Provide: ${item}`, done: false })),
          ...ruleIds.flatMap((id) => (RULES.find((r) => r.rule_id === id)?.implementation_steps || []).map((step) => ({ phase: id.startsWith('F') ? 'p2' : 'p3', owner: 'NOVUS', rule_id: id, item: step, done: false }))),
          ...diagnosis.plan.measurement.map((item) => ({ phase: 'p5', owner: 'NOVUS', item: `Measure: ${item}`, done: false })),
        ],
      });
    }
    await patchSessionCells(repo, sessionId, patch);

    if (outcome === 'NOT_INTERESTED' || outcome === 'NOT_SUITABLE') {
      try {
        const agency = await repo.findById('AGENCIES', 'agency_id', session.agency_id);
        if (agency && !['NOT_INTERESTED', 'CLOSED', 'OPTED_OUT'].includes(upper(agency.obj.current_pipeline_status))) {
          const wrote = await repo.updateCell('AGENCIES', 'agency_id', session.agency_id, 'current_pipeline_status', outcome === 'NOT_INTERESTED' ? 'NOT_INTERESTED' : 'CLOSED');
          if (wrote) await repo.updateCell('AGENCIES', 'agency_id', session.agency_id, 'updated_at', now);
        }
      } catch (err) { warnings.push(`agency status not updated: ${err?.message || err}`); }
    }
    let followUpAction = null;
    if (followUpAt) {
      try {
        const result = await appendAction(repo, {
          agency_id: session.agency_id, action_type: 'MEETING_FOLLOW_UP', action_owner: 'JOE', action_status: 'PENDING',
          due_at: patch.follow_up_at, reason: `${MEETING_OUTCOMES[outcome]} — discovery meeting follow-up`, source_stage: 'MEETING_BOOKED',
          dedupe_key: `discovery:${sessionId}:followup`, metadata_json: JSON.stringify({ discovery_session_id: sessionId, outcome }),
        }, now);
        followUpAction = result.row ? { action_id: result.row.action_id, reused: result.reused } : null;
      } catch (err) { warnings.push(`follow-up action not created: ${err?.message || err}`); }
    }
    return res.status(200).json({ success: true, session_id: sessionId, outcome, completed_at: now, follow_up_action: followUpAction, warnings });
  } catch (err) {
    console.error('discovery-outcome error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Could not record the outcome' });
  }
}

export const _internal = { loadSession, prefillAnswers, cleanAnswer, registryPayload };
