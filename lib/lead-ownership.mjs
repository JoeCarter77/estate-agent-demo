// lib/lead-ownership.mjs — who owns each lead (agency), as ONE append-only
// ledger: the LEAD_OWNERSHIP tab. Nothing here touches AGENCIES.
//
// WHY A LEDGER, NOT AN AGENCIES COLUMN. AGENCIES rows are rewritten whole by
// the rebuild/import paths from a snapshot, so a column written between their
// read and their write would be silently erased. Nothing but the operations
// below ever appends here, so ingestion and sync cannot touch ownership.
//
// THE RULE (deriveLeadOwners), replayed in sheet row order — the order the
// Sheets API serialised the appends in:
//   CLAIM    first meaningful human interaction. Applies ONLY if the lead is
//            unassigned at that point in the log. Two simultaneous claims are
//            both appended; the first one wins and the second is a no-op, so
//            no lock is needed for correctness.
//   MIGRATE  initial owner from the one-off migration. Same "only if
//            unassigned" rule, which makes re-running the migration a no-op.
//   ASSIGN   manual reassignment (and member deletion transfers). Always
//            applies; to_user_id '' means "unassigned".
// The history a person sees is the EFFECTIVE events only, each with the owner
// it replaced, so an ignored losing claim never appears as a change.
//
// Owners are canonical user ids (lib/novus-users.mjs): 'admin' is the env
// administrator (Joe); everyone else is a USERS row id. Never a free-text name.

import crypto from 'node:crypto';
import { rowFor } from './calling-store.mjs';

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();

export const LEAD_OWNERSHIP_TAB = 'LEAD_OWNERSHIP';
export const LEAD_OWNERSHIP_HEADER = Object.freeze([
  'event_id', 'at', 'agency_id', 'event_type', 'from_user_id', 'to_user_id', 'reason', 'actor_user_id', 'source', 'ref_id',
]);
export const LEAD_OWNERSHIP_SCHEMA_NOTE = 'Append-only lead ownership ledger. CLAIM/MIGRATE apply only to an unassigned lead; ASSIGN always applies. The current owner is the replay of this tab in row order. Never edit or delete rows.';
export const OWNERSHIP_EVENT_TYPES = Object.freeze(['CLAIM', 'MIGRATE', 'ASSIGN']);

export function newOwnershipEventId() {
  return `own_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

export function ownershipEvents(table) {
  const header = table?.header || [];
  const idAt = header.indexOf('event_id');
  if (idAt < 0) return [];
  return (table.rows || []).flatMap((row) => {
    const id = text(row[idAt]);
    if (!id || id === 'SCHEMA NOTE') return [];
    return [Object.fromEntries(header.map((key, i) => [key, text(row[i])]))];
  });
}

// -> { owners: Map(agency_id -> { user_id, since, event_type, event_id }),
//      history: Map(agency_id -> [effective events, oldest first, with previous_user_id]) }
export function deriveLeadOwners(table) {
  const owners = new Map();
  const history = new Map();
  for (const ev of ownershipEvents(table)) {
    const agencyId = ev.agency_id;
    const type = upper(ev.event_type);
    if (!agencyId || !OWNERSHIP_EVENT_TYPES.includes(type)) continue;
    const current = owners.get(agencyId)?.user_id || '';
    if ((type === 'CLAIM' || type === 'MIGRATE') && current) continue;
    if (type !== 'ASSIGN' && !ev.to_user_id) continue;
    if (ev.to_user_id === current) continue;
    if (ev.to_user_id) owners.set(agencyId, { user_id: ev.to_user_id, since: ev.at, event_type: type, event_id: ev.event_id });
    else owners.delete(agencyId);
    if (!history.has(agencyId)) history.set(agencyId, []);
    history.get(agencyId).push({ ...ev, event_type: type, previous_user_id: current });
  }
  return { owners, history };
}

export function leadOwnerOf(table, agencyId) {
  return deriveLeadOwners(table).owners.get(text(agencyId))?.user_id || '';
}

export async function readOwnershipTable(repo) {
  try { return await repo.getTable(LEAD_OWNERSHIP_TAB); }
  catch (err) {
    if (/Unable to parse range|no tab/i.test(String(err?.message || ''))) return { header: [...LEAD_OWNERSHIP_HEADER], rows: [] };
    throw err;
  }
}

async function ensureOwnershipTab(repo) {
  await repo.ensureTab(LEAD_OWNERSHIP_TAB, [...LEAD_OWNERSHIP_HEADER], ['SCHEMA NOTE', LEAD_OWNERSHIP_SCHEMA_NOTE, ...LEAD_OWNERSHIP_HEADER.slice(2).map(() => '')]);
}

export function ownershipEventRow({ agencyId, type, fromUserId = '', toUserId = '', reason = '', actorUserId = '', source = '', refId = '', at = new Date().toISOString() }) {
  return {
    event_id: newOwnershipEventId(), at, agency_id: text(agencyId), event_type: upper(type), from_user_id: text(fromUserId), to_user_id: text(toUserId),
    reason: text(reason).slice(0, 300), actor_user_id: text(actorUserId), source: text(source), ref_id: text(refId),
  };
}

export async function appendOwnershipEvents(repo, events) {
  if (!events.length) return 0;
  await ensureOwnershipTab(repo);
  await repo.appendRowsBatch(LEAD_OWNERSHIP_TAB, events.map((ev) => rowFor(LEAD_OWNERSHIP_HEADER, ev)));
  return events.length;
}

// A human signed-in caller. Machine clients (the Playwright worker) never
// claim; the reply poller / campaign sync / rebuilds never reach a claim
// hook at all — only the human operations listed in the router call this.
export function claimingUser(req) {
  const u = req?.novusUser;
  if (!u || !text(u.user_id)) return null;
  if (text(req?.headers?.['x-novus-client']).toLowerCase() === 'worker') return null;
  return u;
}

// First meaningful interaction. NEVER throws and never blocks the action it
// rides on: a failure is reported as { claimed:false, error }.
// -> { claimed, owner_user_id, error? }
export async function claimLeadIfUnassigned(repo, { agencyId, user, source, refId = '', reason = '' }) {
  const id = text(agencyId);
  if (!id || !user) return { claimed: false, owner_user_id: '' };
  try {
    const current = leadOwnerOf(await readOwnershipTable(repo), id);
    if (current) return { claimed: false, owner_user_id: current };
    await appendOwnershipEvents(repo, [ownershipEventRow({
      agencyId: id, type: 'CLAIM', toUserId: user.user_id, actorUserId: user.user_id, source, refId,
      reason: reason || `First interaction: ${source}`,
    })]);
    // Re-derive: a simultaneous claim may have landed first.
    const owner = leadOwnerOf(await readOwnershipTable(repo), id);
    return { claimed: owner === text(user.user_id), owner_user_id: owner };
  } catch (err) {
    console.error('lead ownership claim failed:', err?.message || err);
    return { claimed: false, owner_user_id: '', error: err?.message || 'claim failed' };
  }
}

// Manual reassignment. -> { changed, from_user_id, to_user_id, event }
export async function assignLead(repo, { agencyId, toUserId, actorUserId, reason = '', source = 'lead-owner-set' }) {
  const id = text(agencyId);
  const current = leadOwnerOf(await readOwnershipTable(repo), id);
  if (current === text(toUserId)) return { changed: false, from_user_id: current, to_user_id: current, event: null };
  const event = ownershipEventRow({ agencyId: id, type: 'ASSIGN', fromUserId: current, toUserId, actorUserId, source, reason: reason || 'Manually reassigned' });
  await appendOwnershipEvents(repo, [event]);
  return { changed: true, from_user_id: current, to_user_id: text(toUserId), event };
}

// The action's assignee: an explicit metadata assigned_user_id, else the
// lead owner (inherited). Changing the lead owner therefore never moves an
// explicitly assigned action.
export function effectiveActionAssignee(actionRow, owners) {
  let meta = {};
  try { meta = JSON.parse(text(actionRow?.metadata_json) || '{}') || {}; } catch { meta = {}; }
  const explicit = text(meta.assigned_user_id);
  if (explicit) return { user_id: explicit, explicit: true };
  return { user_id: owners?.get(text(actionRow?.agency_id))?.user_id || '', explicit: false };
}
