// lib/ownership-handlers.mjs — team ownership of leads and actions. Mounted as
// ?novus_operation= branches on api/novus/personalisation.js (12-function
// ceiling). The ledger and its rules live in lib/lead-ownership.mjs.
//
//   GET  team-roster                any signed-in caller — active members (for
//                                   owner filters) + archived names (history)
//   POST lead-owner-set             ADMIN — reassign / unassign one lead
//   POST action-assign              ADMIN — reassign one action ('' = inherit
//                                   the lead owner again)
//   GET  team-user-delete-preview   ADMIN — what a member owns and what will
//                                   happen to it
//   POST team-user-delete           ADMIN — archive the member (status DELETED,
//                                   kept for attribution) and transfer their
//                                   leads + open actions; re-runnable
//   POST team-ownership-migrate     ADMIN — one-off initial assignment;
//                                   mode=preview is read-only
//
// Nothing here deletes a lead, action, call, email or history row.

import crypto from 'node:crypto';
import { getRepo } from './sheets.mjs';
import { rowFor, liveCallRecords, CALLS_TAB } from './calling-store.mjs';
import { ACTIONS_HEADER, ACTIONS_TAB, assertActionsHeader, buildActionPatchPlan, parseActionRecords, patchAction, readActions } from './actions-store.mjs';
import {
  ADMIN_USER_ID, USERS_AUDIT_HEADER, USERS_AUDIT_SCHEMA_NOTE, USERS_AUDIT_TAB, USERS_TAB,
  adminCaller, invalidateUsersCache, metaOf, publicUser, userRecords,
} from './novus-users.mjs';
import { revokeUserSessions } from './auth-session.mjs';
import { isSortLeadAction } from './acquisition-actions.mjs';
import {
  appendOwnershipEvents, assignLead, deriveLeadOwners, effectiveActionAssignee, ownershipEventRow, readOwnershipTable,
} from './lead-ownership.mjs';

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();
const noStore = (res) => res.setHeader('Cache-Control', 'private, no-store, max-age=0');
const ACTIVE_ACTION = new Set(['PENDING', 'DUE', 'IN_PROGRESS', 'SNOOZED']);

// ── roster ──────────────────────────────────────────────────────────────
// Every identity that can own work: the env admin ('admin', Joe) plus every
// USERS row. DELETED rows stay here (archived) so history keeps their name.
export async function readRoster(repo) {
  let rows = [];
  try { rows = userRecords(await repo.getTable(USERS_TAB)); } catch { rows = []; }
  const admin = adminCaller();
  return [
    { user_id: ADMIN_USER_ID, display_name: admin.display_name, role: 'ADMIN', status: 'ACTIVE', managed_by: 'env' },
    ...rows.map((r) => { const u = publicUser(r.obj); return { user_id: u.user_id, display_name: u.display_name, role: u.role, status: u.status, managed_by: 'team' }; }),
  ];
}
const isAssignable = (roster, userId) => roster.some((u) => u.user_id === text(userId) && u.status === 'ACTIVE');

export async function handleTeamRoster(req, res) {
  noStore(res);
  try {
    const roster = await readRoster(getRepo());
    return res.status(200).json({
      success: true, me: req.novusUser?.user_id || '',
      members: roster.filter((u) => u.status === 'ACTIVE'),
      archived: roster.filter((u) => u.status !== 'ACTIVE'),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || 'Could not read the team' });
  }
}

// ── lead owner ──────────────────────────────────────────────────────────
export async function handleLeadOwnerSet(req, res) {
  noStore(res);
  if (text(req.body?.confirm) !== 'SET_LEAD_OWNER') return res.status(400).json({ success: false, error: 'Missing confirm=SET_LEAD_OWNER' });
  const agencyId = text(req.body?.agency_id);
  const toUserId = text(req.body?.user_id);
  if (!agencyId) return res.status(400).json({ success: false, error: 'agency_id is required' });
  try {
    const repo = getRepo();
    const [agency, roster] = await Promise.all([repo.findById('AGENCIES', 'agency_id', agencyId), readRoster(repo)]);
    if (!agency) return res.status(404).json({ success: false, error: 'Agency not found' });
    if (toUserId && !isAssignable(roster, toUserId)) return res.status(400).json({ success: false, error: 'Choose an active team member' });
    const out = await assignLead(repo, { agencyId, toUserId, actorUserId: req.novusUser?.user_id || ADMIN_USER_ID, reason: text(req.body?.reason) || 'Manually reassigned' });
    return res.status(200).json({ success: true, agency_id: agencyId, ...out });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || 'Could not change the owner' });
  }
}

// ── action assignee ─────────────────────────────────────────────────────
// Writes metadata_json.assigned_user_id only (merged); status, due date and
// every other field are untouched. '' clears it so the action inherits the
// lead owner again. The lead's owner never changes here.
export async function handleActionAssign(req, res) {
  noStore(res);
  if (text(req.body?.confirm) !== 'ASSIGN_ACTION') return res.status(400).json({ success: false, error: 'Missing confirm=ASSIGN_ACTION' });
  const actionId = text(req.body?.action_id);
  const toUserId = text(req.body?.user_id);
  if (!actionId) return res.status(400).json({ success: false, error: 'action_id is required' });
  try {
    const repo = getRepo();
    const [read, roster] = await Promise.all([readActions(repo), readRoster(repo)]);
    if (!read.available) return res.status(409).json({ success: false, error: read.error });
    const action = read.rows.find((row) => text(row.action_id) === actionId);
    if (!action) return res.status(404).json({ success: false, error: 'Action not found' });
    if (toUserId && !isAssignable(roster, toUserId)) return res.status(400).json({ success: false, error: 'Choose an active team member' });
    const meta = metaOf(action);
    const from = text(meta.assigned_user_id);
    const next = { ...meta, assigned_user_id: toUserId };
    if (!toUserId) delete next.assigned_user_id;
    const history = Array.isArray(meta.assignment_history) ? meta.assignment_history.slice(-9) : [];
    next.assignment_history = [...history, { at: new Date().toISOString(), from, to: toUserId, by: req.novusUser?.user_id || ADMIN_USER_ID }];
    await patchAction(repo, actionId, { metadata_json: JSON.stringify(next), updated_at: new Date().toISOString() });
    return res.status(200).json({ success: true, action_id: actionId, from_user_id: from, to_user_id: toUserId });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || 'Could not reassign the action' });
  }
}

// ── member deletion ─────────────────────────────────────────────────────
// What a member is responsible for right now.
export function memberWorkload(userId, { ownershipTable, actions }) {
  const { owners } = deriveLeadOwners(ownershipTable);
  const ownedLeads = [...owners.entries()].filter(([, o]) => o.user_id === userId).map(([agencyId]) => agencyId);
  // Legacy lead-pool housekeeping rows are not anyone's workload.
  const openActions = actions.filter((a) => ACTIVE_ACTION.has(upper(a.action_status)) && !isSortLeadAction(a) && effectiveActionAssignee(a, owners).user_id === userId);
  // Only explicitly assigned actions need a write; inherited ones follow the lead.
  const explicitActions = openActions.filter((a) => effectiveActionAssignee(a, owners).explicit);
  return { owned_leads: ownedLeads, open_actions: openActions.map((a) => text(a.action_id)), explicit_actions: explicitActions.map((a) => text(a.action_id)) };
}

function activeAdminsAfterDelete(roster, userId) {
  const env = text(process.env.NOVUS_BASIC_AUTH_USER) && text(process.env.NOVUS_BASIC_AUTH_PASS) ? 1 : 0;
  return env + roster.filter((u) => u.managed_by === 'team' && u.user_id !== userId && u.role === 'ADMIN' && u.status === 'ACTIVE').length;
}

async function loadWorkloadInputs(repo) {
  const [ownershipTable, read] = await Promise.all([readOwnershipTable(repo), readActions(repo)]);
  if (!read.available) throw Object.assign(new Error(read.error), { status: 409 });
  return { ownershipTable, actions: read.rows };
}

export async function handleTeamUserDeletePreview(req, res) {
  noStore(res);
  const userId = text(req.query?.user_id);
  if (!userId || userId === ADMIN_USER_ID) return res.status(400).json({ success: false, error: 'Choose a team account' });
  try {
    const repo = getRepo();
    const roster = await readRoster(repo);
    const member = roster.find((u) => u.user_id === userId);
    if (!member) return res.status(404).json({ success: false, error: 'User not found' });
    const work = memberWorkload(userId, await loadWorkloadInputs(repo));
    return res.status(200).json({
      success: true, user: member,
      owned_leads: work.owned_leads.length, open_actions: work.open_actions.length,
      transfer_targets: roster.filter((u) => u.status === 'ACTIVE' && u.user_id !== userId),
      blocked: activeAdminsAfterDelete(roster, userId) < 1 ? 'This is the last active administrator; promote another account first' : '',
      effect: 'The account is archived: it can no longer sign in and leaves the active roster, but its name stays on every call, email and history entry it made. Its owned leads and outstanding actions move to the person you choose. No lead, action, call, email or history row is deleted.',
    });
  } catch (err) {
    return res.status(err?.status || 500).json({ success: false, error: err?.message || 'Could not preview' });
  }
}

export async function handleTeamUserDelete(req, res) {
  noStore(res);
  if (text(req.body?.confirm) !== 'DELETE_USER') return res.status(400).json({ success: false, error: 'Missing confirm=DELETE_USER' });
  const userId = text(req.body?.user_id);
  const transferTo = text(req.body?.transfer_to) || ADMIN_USER_ID;
  if (!userId || userId === ADMIN_USER_ID) return res.status(400).json({ success: false, error: 'The environment administrator cannot be deleted' });
  if (transferTo === userId) return res.status(400).json({ success: false, error: 'Transfer to someone else' });
  try {
    const repo = getRepo();
    const roster = await readRoster(repo);
    const member = roster.find((u) => u.user_id === userId);
    if (!member) return res.status(404).json({ success: false, error: 'User not found' });
    if (!isAssignable(roster, transferTo)) return res.status(400).json({ success: false, error: 'Transfer to an active team member' });
    if (member.status !== 'DELETED' && activeAdminsAfterDelete(roster, userId) < 1) {
      return res.status(409).json({ success: false, error: 'This is the last active administrator; promote another account first' });
    }
    const actor = req.novusUser || adminCaller();
    const now = new Date().toISOString();
    // 1) Archive (idempotent: a re-run after a partial failure skips this).
    if (member.status !== 'DELETED') {
      await repo.updateById(USERS_TAB, 'user_id', userId, { status: 'DELETED', updated_at: now, disabled_at: now });
      invalidateUsersCache();
    }
    let revoked = null;
    try { revoked = await revokeUserSessions(userId); } catch { revoked = null; }
    // 2) Transfer leads (ASSIGN events) and explicitly-assigned open actions.
    const inputs = await loadWorkloadInputs(repo);
    const work = memberWorkload(userId, inputs);
    const reason = `${member.display_name} removed from the team; transferred by ${actor.display_name || actor.user_id}`;
    await appendOwnershipEvents(repo, work.owned_leads.map((agencyId) => ownershipEventRow({
      agencyId, type: 'ASSIGN', fromUserId: userId, toUserId: transferTo, actorUserId: actor.user_id, source: 'team-user-delete', reason, at: now,
    })));
    const table = await repo.getTable(ACTIONS_TAB);
    assertActionsHeader(table);
    const byId = new Map(parseActionRecords(table).map((r) => [text(r.obj.action_id), r.obj]));
    const plan = buildActionPatchPlan(table, work.explicit_actions.map((id) => {
      const meta = metaOf(byId.get(id));
      const history = Array.isArray(meta.assignment_history) ? meta.assignment_history.slice(-9) : [];
      return { action_id: id, patch: { updated_at: now, metadata_json: JSON.stringify({ ...meta, assigned_user_id: transferTo, assignment_history: [...history, { at: now, from: userId, to: transferTo, by: actor.user_id, reason: 'member deleted' }] }) } };
    }));
    await repo.writeRowsBatch(plan.writes);
    // 3) Audit (best effort, like role changes).
    let audited = true;
    try {
      await repo.ensureTab(USERS_AUDIT_TAB, [...USERS_AUDIT_HEADER], ['SCHEMA NOTE', USERS_AUDIT_SCHEMA_NOTE, ...USERS_AUDIT_HEADER.slice(2).map(() => '')]);
      await repo.appendRowsBatch(USERS_AUDIT_TAB, [rowFor(USERS_AUDIT_HEADER, {
        audit_id: `aud_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`, at: now, action: 'DELETE_USER',
        actor_user_id: actor.user_id, actor_username: actor.username || '', target_user_id: userId, target_username: member.display_name,
        from_role: member.role, to_role: `DELETED→${transferTo}`, sessions_revoked: revoked ?? '',
      })]);
    } catch { audited = false; }
    return res.status(200).json({
      success: true, user_id: userId, transfer_to: transferTo, leads_transferred: work.owned_leads.length,
      actions_transferred: work.open_actions.length, actions_rewritten: plan.writes.length, sessions_revoked: revoked, audited,
    });
  } catch (err) {
    return res.status(err?.status || 500).json({ success: false, error: err?.message || 'Could not delete the member' });
  }
}

// ── one-off migration ───────────────────────────────────────────────────
// Leads: an owner is set ONLY from the lead's first reliably recorded
// meaningful interaction. Everything else stays unassigned and claimable:
//   · never contacted                      → unassigned
//   · first interaction's author unknowable → unassigned (never guessed)
// Evidence, in time order:
//   CALLS              a logged call (outcome set). metadata user_id names the
//                      caller; a call with none is Joe's only if it predates
//                      every other account (nobody else could have made it).
//   SALES_MESSAGES     a SENT manual reply. sent_by is a user id; the legacy
//                      'joe' / blank value is Joe's only before any other
//                      account could send (the first other ADMIN).
//   DISCOVERY_SESSIONS a completed meeting (admin-only page, no actor stored):
//                      Joe's only before the first other ADMIN.
// Action completions record no actor, so they are not evidence. Ties between
// two people at the same instant are ambiguous.
// Actions: every row with no assigned_user_id gets assigned_user_id='admin'
// in metadata_json; nothing else on the row changes. Assigning an action
// never makes anyone the lead's owner. Re-running finds nothing to do.
export function migrationEvidence({ calls, salesMessages = [], discoverySessions = [], roster, users = [], audit = [] }) {
  const known = new Set(roster.map((u) => u.user_id));
  const at = (v) => { const n = Date.parse(text(v)); return Number.isFinite(n) ? n : null; };
  const others = users.filter((u) => text(u.user_id) && text(u.user_id) !== ADMIN_USER_ID);
  const firstOtherAccountAt = Math.min(Infinity, ...others.map((u) => at(u.created_at) ?? -Infinity));
  const promotions = audit.filter((a) => upper(a.to_role) === 'ADMIN').map((a) => at(a.at) ?? -Infinity);
  // An ADMIN row with no audited promotion: assume it could act from creation.
  const auditedIds = new Set(audit.filter((a) => upper(a.to_role) === 'ADMIN').map((a) => text(a.target_user_id)));
  const unauditedAdmins = others.filter((u) => upper(u.role) === 'ADMIN' && !auditedIds.has(text(u.user_id))).map((u) => at(u.created_at) ?? -Infinity);
  const firstOtherAdminAt = Math.min(Infinity, ...promotions, ...unauditedAdmins);
  const legacyJoe = (ms, cutoff) => (ms !== null && ms < cutoff ? ADMIN_USER_ID : '');
  const named = (id) => (known.has(id) ? id : '');
  const out = [];
  for (const c of calls) {
    if (!text(c.outcome) || !text(c.agency_id)) continue;
    const ms = at(c.started_at || c.created_at);
    const uid = text(metaOf(c).user_id);
    out.push({ agency_id: text(c.agency_id), at: ms, user_id: uid ? named(uid) : legacyJoe(ms, firstOtherAccountAt), kind: 'call', ref: text(c.call_id) });
  }
  for (const m of salesMessages) {
    if (upper(m.message_type) !== 'MANUAL_REPLY' || upper(m.send_outcome) !== 'SENT' || !text(m.agency_id)) continue;
    const ms = at(m.sent_at || m.created_at);
    const by = text(m.sent_by);
    out.push({ agency_id: text(m.agency_id), at: ms, user_id: by && by.toLowerCase() !== 'joe' ? named(by) : legacyJoe(ms, firstOtherAdminAt), kind: 'email', ref: text(m.sales_message_id) });
  }
  for (const d of discoverySessions) {
    if (!text(d.completed_at) || !text(d.agency_id)) continue;
    const ms = at(d.completed_at);
    out.push({ agency_id: text(d.agency_id), at: ms, user_id: legacyJoe(ms, firstOtherAdminAt), kind: 'meeting', ref: text(d.session_id) });
  }
  return out;
}

export function planOwnershipMigration({ agencies, ownershipTable, actionsTable, calls, salesMessages = [], discoverySessions = [], roster, users = [], audit = [] }) {
  const { owners } = deriveLeadOwners(ownershipTable);
  const byAgency = new Map();
  for (const e of migrationEvidence({ calls, salesMessages, discoverySessions, roster, users, audit })) {
    if (!byAgency.has(e.agency_id)) byAgency.set(e.agency_id, []);
    byAgency.get(e.agency_id).push(e);
  }
  const leads = [];
  const unassigned = [];
  for (const agencyId of [...new Set(agencies.map((a) => text(a.agency_id)).filter(Boolean))]) {
    if (owners.has(agencyId)) continue;
    const evidence = byAgency.get(agencyId) || [];
    if (!evidence.length) { unassigned.push({ agency_id: agencyId, reason: 'never contacted' }); continue; }
    // Undated evidence could be the first interaction: it makes the lead ambiguous.
    if (evidence.some((e) => e.at === null)) { unassigned.push({ agency_id: agencyId, reason: 'ambiguous: undated interaction' }); continue; }
    evidence.sort((a, b) => a.at - b.at);
    const first = evidence.filter((e) => e.at === evidence[0].at);
    const who = new Set(first.map((e) => e.user_id));
    if (who.has('') ) { unassigned.push({ agency_id: agencyId, reason: `ambiguous: first ${first[0].kind} has no reliable author`, ref: first[0].ref }); continue; }
    if (who.size > 1) { unassigned.push({ agency_id: agencyId, reason: 'ambiguous: two people at the same moment' }); continue; }
    leads.push({ agency_id: agencyId, to_user_id: first[0].user_id, basis: `first ${first[0].kind}`, first_at: new Date(first[0].at).toISOString(), ref: first[0].ref });
  }
  assertActionsHeader(actionsTable);
  const metaCol = ACTIONS_HEADER.indexOf('metadata_json') + 1;
  const actions = parseActionRecords(actionsTable)
    .filter((r) => !text(metaOf(r.obj).assigned_user_id))
    .map((r) => {
      let parsed;
      try { parsed = JSON.parse(text(r.obj.metadata_json) || '{}'); } catch { parsed = null; }
      return { action_id: text(r.obj.action_id), row_number: r.rowNumber, column_number: metaCol, status: upper(r.obj.action_status),
        before: text(r.obj.metadata_json), after: parsed && typeof parsed === 'object' ? JSON.stringify({ ...parsed, assigned_user_id: ADMIN_USER_ID }) : null };
    });
  return { leads, unassigned, actions };
}

function migrationSummary(plan, owners) {
  const by = (list, key) => list.reduce((acc, item) => { acc[item[key]] = (acc[item[key]] || 0) + 1; return acc; }, {});
  return {
    leads_already_owned: owners.size,
    leads_to_assign: plan.leads.length, leads_by_owner: by(plan.leads, 'to_user_id'), leads_by_basis: by(plan.leads, 'basis'),
    leads_left_unassigned: plan.unassigned.length, unassigned_by_reason: by(plan.unassigned, 'reason'),
    actions_to_assign: plan.actions.filter((a) => a.after).length, actions_by_status: by(plan.actions, 'status'),
    actions_unparseable_metadata: plan.actions.filter((a) => !a.after).map((a) => a.action_id),
  };
}

const optionalRecords = (table, idColumn) => {
  const header = table?.header || [];
  const at = header.indexOf(idColumn);
  if (at < 0) return [];
  return (table.rows || []).filter((row) => text(row[at]) && text(row[at]) !== 'SCHEMA NOTE').map((row) => Object.fromEntries(header.map((k, i) => [k, row[i] ?? ''])));
};
async function loadMigrationInputs(repo) {
  const empty = { header: [], rows: [] };
  const optional = (tab) => repo.getTable(tab).catch(() => empty);
  const [agencyRecords, ownershipTable, actionsTable, callsTable, salesTable, discoveryTable, usersTable, auditTable, roster] = await Promise.all([
    repo.getRecords('AGENCIES', 'agency_id'), readOwnershipTable(repo), repo.getTable(ACTIONS_TAB),
    optional(CALLS_TAB), optional('SALES_MESSAGES'), optional('DISCOVERY_SESSIONS'), optional(USERS_TAB), optional(USERS_AUDIT_TAB), readRoster(repo),
  ]);
  return {
    agencies: agencyRecords.map((r) => r.obj), ownershipTable, actionsTable, calls: liveCallRecords(callsTable), roster,
    salesMessages: optionalRecords(salesTable, 'sales_message_id'), discoverySessions: optionalRecords(discoveryTable, 'session_id'),
    users: userRecords(usersTable).map((r) => r.obj), audit: optionalRecords(auditTable, 'audit_id'),
  };
}

export async function handleOwnershipMigrate(req, res) {
  noStore(res);
  const mode = text(req.body?.mode) || 'preview';
  if (!['preview', 'apply'].includes(mode)) return res.status(400).json({ success: false, error: 'mode must be preview or apply' });
  if (mode === 'apply' && text(req.body?.confirm) !== 'MIGRATE_OWNERSHIP') return res.status(400).json({ success: false, error: 'Missing confirm=MIGRATE_OWNERSHIP' });
  try {
    const repo = getRepo();
    const inputs = await loadMigrationInputs(repo);
    const plan = planOwnershipMigration(inputs);
    const summary = migrationSummary(plan, deriveLeadOwners(inputs.ownershipTable).owners);
    // The backup is the exact prior value of every cell this would write.
    const backup = plan.actions.map(({ action_id, row_number, before }) => ({ action_id, row_number, metadata_json: before }));
    if (mode === 'preview') {
      return res.status(200).json({ success: true, mode, summary, leads: plan.leads, unassigned: plan.unassigned, backup });
    }
    const now = new Date().toISOString();
    const actor = req.novusUser?.user_id || ADMIN_USER_ID;
    await appendOwnershipEvents(repo, plan.leads.map((l) => ownershipEventRow({
      agencyId: l.agency_id, type: 'MIGRATE', toUserId: l.to_user_id, actorUserId: actor, source: 'team-ownership-migrate',
      reason: `Initial owner (${l.basis} ${l.first_at})`, refId: l.ref, at: now,
    })));
    await repo.writeCellsBatch(plan.actions.filter((a) => a.after).map((a) => ({ tab: ACTIONS_TAB, rowNumber: a.row_number, columnNumber: a.column_number, value: a.after })));
    // Verify: the same plan, re-read from the sheet, must now be empty.
    const after = planOwnershipMigration(await loadMigrationInputs(repo));
    const verified = after.leads.length === 0 && after.actions.filter((a) => a.after).length === 0;
    return res.status(verified ? 200 : 500).json({
      success: verified, mode, summary, verified,
      remaining: { leads: after.leads.length, actions: after.actions.filter((a) => a.after).length }, backup,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || 'Migration failed' });
  }
}
