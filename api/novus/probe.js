// api/novus/probe.js — the probe lifecycle route, consolidated.
//
// GET  /api/novus/probe?probe_id=...        (was probe-get.js)
// GET  /api/novus/probe?agency_id=...        (was probe-get.js)
// GET  /api/novus/probe?next_after=<agency_id>  (was probe-get.js)
// POST /api/novus/probe  { action: "create", url, agency_id }      (was probe-create.js)
// POST /api/novus/probe  { action: "mark-sent", probe_id }         (was probe-mark-sent.js)
// POST /api/novus/probe  { action: "skip-agency", agency_id, reason, note? }
// POST /api/novus/probe  { action: "restore-agency", agency_id }
// POST /api/novus/probe  { action: "delete-agency", agency_id, confirm: "DELETE_EXACT_DUPLICATE" }
// POST /api/novus/probe  { action: "relationships-backfill", from_row?, dry_run? }
//
// Consolidated from three separate files into one Serverless Function to
// stay within Vercel Hobby's 12-function limit.

import { getRepo } from '../../lib/sheets.mjs';
import { newProbeId, newProbeReference } from '../../lib/ids.mjs';
import { fetchListingMeta } from '../../lib/rightmove-meta.mjs';
import { requireAuth } from './_auth.mjs';
import { reconcileAgencyActionsBestEffort } from '../../lib/action-engine.mjs';
import { hasValidOutreachContactEmail, isProbeQueueEligible, isProbeSkipped } from '../../lib/acquisition-stage.mjs';
import { patchAction } from '../../lib/actions-store.mjs';
import {
  buildAgencyIndex, describeAgencyRelationships, groupProbesByAgency, relationshipsForAgency, relationshipSummary,
} from '../../lib/agency-relationships.mjs';

export const maxDuration = 20;

// ── GET (was probe-get.js) ──────────────────────────────────────────────────

// PROBER QUEUE ELIGIBILITY.
//
// The hard gate is the physical AGENCIES.probe_sent cell being blank. Any
// non-blank value ("YES", a timestamp, a stray note) means the row is already
// probed and is skipped. This deliberately does NOT consult PROBES history:
// that inference is what handed already-probed agencies back to the operator
// whenever a PROBES row was missing, deleted or logged out of band.
//
// The normal exclusions (no Rightmove sales branch URL, suppressed, closed,
// excluded, meeting booked, not interested) still apply on top. The agency
// must also have a canonical outreach_contact_email verified VALID.
export function isProbeEligible(agency) {
  return isProbeQueueEligible(agency);
}

// The gate is a real column. If AGENCIES has no probe_sent column at all, every
// row would read as blank and the queue would silently re-serve probed
// agencies — exactly the failure being fixed. Say so instead of guessing.
export function hasProbeSentColumn(records) {
  return (records || []).some((record) => Object.prototype.hasOwnProperty.call(record.obj || {}, 'probe_sent'));
}

// Cheap queue telemetry for the Prober header. AGENCIES is already in memory
// for the next-agency lookup; PROBES is only read for the "today" figure.
export function queueStats(agencies, probes = null, now = new Date()) {
  const remaining = (agencies || []).filter((record) => isProbeEligible(record.obj)).length;
  const stats = { remaining, completed_today: null };
  if (probes) {
    const dayStart = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
    stats.completed_today = probes.filter((record) => {
      const sentAt = Date.parse(String(record.obj.probe_timestamp || '').trim());
      return Number.isFinite(sentAt) && sentAt >= dayStart;
    }).length;
  }
  return stats;
}

async function handleGet(req, res) {
  const probeId = (req.query?.probe_id || '').trim();
  const agencyId = (req.query?.agency_id || '').trim();
  const nextAfter = (req.query?.next_after || '').trim();
  const next = String(req.query?.next || '') === '1';
  const queueOnly = String(req.query?.queue || '') === '1';
  if (!probeId && !agencyId && !nextAfter && !next && !queueOnly) {
    return res.status(400).json({ error: 'Missing probe_id, agency_id, next_after, next=1 or queue=1' });
  }

  try {
    const repo = getRepo();

    // Queue telemetry only — no probe is created, advanced or sent.
    if (queueOnly) {
      const [agencies, probes] = await Promise.all([
        repo.getRecords('AGENCIES', 'agency_id'),
        repo.getRecords('PROBES', 'probe_id').catch(() => []),
      ]);
      return res.status(200).json({ queue: queueStats(agencies, probes) });
    }

    if (nextAfter || next) {
      const agencies = await repo.getRecords('AGENCIES', 'agency_id');
      if (!hasProbeSentColumn(agencies)) {
        return res.status(409).json({ error: 'AGENCIES has no probe_sent column — the Prober queue cannot verify which agencies were already probed. Add the column before probing.' });
      }
      const from = nextAfter ? agencies.findIndex((r) => String(r.obj.agency_id || '').trim() === nextAfter) : -1;
      if (nextAfter && from === -1) return res.status(404).json({ error: 'Agency not found' });
      // Sheet order, first row whose probe_sent is genuinely blank and whose
      // outreach email is verifier-backed VALID.
      const found = agencies.slice(from + 1).find((r) => isProbeEligible(r.obj));
      if (!found) return res.status(404).json({ error: nextAfter ? 'No further eligible agency in the list' : 'No eligible agency is ready to probe' });
      return res.status(200).json({ agency: found.obj, queue: queueStats(agencies) });
    }

    if (agencyId) {
      const agencies = await repo.getRecords('AGENCIES', 'agency_id');
      const record = agencies.find((r) => sameId(r, agencyId));
      if (!record) return res.status(404).json({ error: 'Agency not found' });
      // Brand / branch context so the operator sees an existing company
      // relationship BEFORE choosing Create probe, Skip or Delete.
      const relationship = await loadRelationship(repo, agencyId, agencies);
      const del = relationship?.status === 'EXACT_DUPLICATE' && relationship.canonical_agency_id
        ? await deleteCheck(repo, agencyId, relationship) : { permitted: false };
      return res.status(200).json({
        agency: record.obj, relationship, relationship_summary: relationshipSummary(relationship),
        delete_check: del, skip_reasons: SKIP_REASONS,
      });
    }

    const record = await repo.findById('PROBES', 'probe_id', probeId);
    if (!record) return res.status(404).json({ error: 'Probe not found' });
    return res.status(200).json({ probe: record.obj });
  } catch (err) {
    console.error('probe (get) error:', err);
    return res.status(500).json({ error: err.message || 'Failed to fetch probe/agency' });
  }
}

// ── POST action=create (was probe-create.js) ───────────────────────────────

const VENDOR_DECLARATION = 'Declared: has a property to sell, yes, it is not yet on the market';

async function handleCreate(body, res) {
  const url = (body.url || '').trim();
  const agencyId = (body.agency_id || '').trim();

  if (!url) return res.status(400).json({ error: 'Missing url' });
  if (!agencyId) {
    return res.status(400).json({
      error: 'Missing agency_id — probe creation is blocked because every NOVUS probe must belong to an agency',
    });
  }
  if (!/^https?:\/\/|^www\./i.test(url) && !url.includes('.')) {
    return res.status(400).json({ error: 'That does not look like a valid URL' });
  }

  const portal = /rightmove\./i.test(url) ? 'rightmove'
    : /zoopla\./i.test(url) ? 'zoopla'
    : /onthemarket\./i.test(url) ? 'onthemarket'
    : 'rightmove';

  try {
    const repo = getRepo();

    // Agency identity is a hard relational invariant. Never create an orphan
    // PROBES row and never guess an agency from listing metadata.
    const agencyRecord = await repo.findById('AGENCIES', 'agency_id', agencyId);
    if (!agencyRecord) return res.status(400).json({ error: 'Unknown agency_id' });
    if (!hasValidOutreachContactEmail(agencyRecord.obj)) {
      return res.status(409).json({
        error: 'Probe creation blocked — the agency outreach email must be verified VALID before probing.',
      });
    }
    if (isProbeSkipped(agencyRecord.obj)) {
      return res.status(409).json({ error: `This agency was skipped (${agencyRecord.obj.probe_skip_reason || 'no reason recorded'}). Restore it to the queue before probing.` });
    }

    // REPEAT-PROBE GUARD. The same branch (or the same Rightmove branch page)
    // already probed is a hard stop. Another branch of an already-probed
    // company is allowed only as a deliberate, confirmed branch probe.
    const relationship = await loadRelationship(repo, agencyId);
    const decision = relationship?.probe_decision || 'CLEAR';
    if (decision.startsWith('BLOCKED_')) {
      return res.status(409).json({ error: relationshipSummary(relationship), relationship });
    }
    if (decision === 'CONFIRM_RELATED_PROBED' && body.confirm_related_probe !== true) {
      return res.status(409).json({ error: relationshipSummary(relationship), needs_confirmation: true, relationship });
    }

    const meta = await fetchListingMeta(url).catch(() => ({ address: '', price: '', status: '', title: '' }));
    const sequence = await repo.count('PROBES', 'probe_id').catch(() => 0);

    const now = new Date().toISOString();
    const probe = {
      probe_id: newProbeId(),
      probe_reference: newProbeReference(sequence, portal),
      agency_id: agencyId,
      portal,
      property_address: meta.address || '',
      property_url: url,
      property_price: meta.price || '',
      property_status: meta.status || '',
      enquiry_text: portal === 'rightmove'
        ? [VENDOR_DECLARATION, (body.enquiry_text || '').trim()].filter(Boolean).join(' — ')
        : (body.enquiry_text || '').trim(),
      probe_email: process.env.NOVUS_PROBE_EMAIL || 'joe.novus2@gmail.com',
      probe_phone: process.env.NOVUS_PROBE_PHONE || '+447575333064',
      probe_timestamp: '',
      observation_deadline: '',
      probe_status: 'draft',
      compromised: 'FALSE',
      compromise_reason: '',
      observation_closed_at: '',
      sent_from: '',
      observation_notes: '',
      created_at: now,
      updated_at: now,
    };

    await repo.appendRecord('PROBES', probe);

    return res.status(200).json({ probe, meta_source: meta.address || meta.price ? 'fetched' : 'unavailable' });
  } catch (err) {
    console.error('probe (create) error:', err);
    return res.status(500).json({ error: err.message || 'Failed to create probe' });
  }
}

// ── POST action=mark-sent (was probe-mark-sent.js) ─────────────────────────

const OBSERVATION_DAYS = 4;

async function handleMarkSent(body, res) {
  const probeId = (body.probe_id || '').trim();
  if (!probeId) return res.status(400).json({ error: 'Missing probe_id' });

  try {
    const repo = getRepo();
    const record = await repo.findById('PROBES', 'probe_id', probeId);
    if (!record) return res.status(404).json({ error: 'Probe not found' });

    // Second guard: even a legacy/bad draft row cannot be moved into the live
    // observation pipeline without a canonical agency relationship.
    if (!String(record.obj.agency_id || '').trim()) {
      return res.status(409).json({
        error: 'Probe has no agency_id — Mark as Sent blocked. Re-link this probe to its AGENCIES row before sending.',
      });
    }

    const agencyRecord = await repo.findById('AGENCIES', 'agency_id', String(record.obj.agency_id).trim());
    if (!agencyRecord) {
      return res.status(409).json({
        error: 'Probe agency_id does not resolve to AGENCIES — Mark as Sent blocked to protect probe identity.',
      });
    }
    if (!hasValidOutreachContactEmail(agencyRecord.obj)) {
      return res.status(409).json({
        error: 'Mark as Sent blocked — the agency outreach email is not verified VALID.',
      });
    }

    if (record.obj.probe_status && record.obj.probe_status !== 'draft' && record.obj.probe_timestamp) {
      return res.status(200).json({ probe: record.obj, already_sent: true });
    }

    const sentAt = new Date();
    const deadline = new Date(sentAt.getTime() + OBSERVATION_DAYS * 24 * 60 * 60 * 1000);

    const updated = await repo.updateById('PROBES', 'probe_id', probeId, {
      probe_status: 'observing',
      probe_timestamp: sentAt.toISOString(),
      observation_deadline: deadline.toISOString(),
      updated_at: sentAt.toISOString(),
    });
    if (!updated) return res.status(404).json({ error: 'Probe not found' });

    try {
      await repo.updateCell('AGENCIES', 'agency_id', record.obj.agency_id, 'probe_sent', 'YES');
    } catch (err) {
      console.error('probe (mark-sent): could not set AGENCIES.probe_sent:', err);
    }

    const actions = await reconcileAgencyActionsBestEffort(repo, record.obj.agency_id, 'probe sent');

    return res.status(200).json({ probe: updated, already_sent: false, actions });
  } catch (err) {
    console.error('probe (mark-sent) error:', err);
    return res.status(500).json({ error: err.message || 'Failed to mark probe as sent' });
  }
}

// ── Skip / restore / delete (the Prober's agency decisions) ────────────────
//
// SKIP is a recorded decision on a KEPT row: probe_skip_status=SKIPPED plus
// reason and timestamp, and an audit line in AGENCIES.notes. It never deletes,
// never touches probe_sent and never writes PROBES, so a skipped agency is
// neither "probed" nor lost. RESTORE puts it back in the queue.
//
// DELETE is separate and narrow: only a confirmed exact duplicate of another
// kept row (lib/agency-relationships.mjs) with no downstream history. Its
// contacts are re-linked to the kept row, never deleted.

export const SKIP_COLUMNS = ['probe_skip_status', 'probe_skip_reason', 'probe_skipped_at'];
export const RELATIONSHIP_COLUMNS = ['parent_brand_key', 'brand_relationship', 'related_agency_ids', 'duplicate_of_agency_id'];
export const SKIP_REASONS = Object.freeze([
  'Already probed another branch', 'Duplicate agency', 'Unsuitable agency', 'No suitable Rightmove listing', 'Other',
]);

// Tabs whose rows are history of an agency. Any row here blocks a delete.
// ACTIONS is handled separately: the engine derives an open PROBE_AGENCY /
// SORT_LEAD for EVERY lead, so counting those made every agency undeletable.
const HISTORY_TABS = [
  ['PROBES', 'probe_id'], ['COMMUNICATIONS', 'communication_id'], ['INTELLIGENCE', 'probe_id'],
  ['DIAGNOSIS', 'probe_id'], ['PERSONALISATION', 'personalisation_id'], ['DEMOS', 'demo_id'],
  ['OUTBOUND', 'outbound_id'], ['REPLY_EVENTS', 'reply_event_id'], ['SALES_MESSAGES', 'sales_message_id'],
  ['CALLS', 'call_id'], ['CALL_OBJECTION_EVENTS', 'event_id'], ['CAMPAIGN_MEMBERS', 'member_id'],
  ['CAMPAIGN_EVENTS', 'event_id'], ['DISCOVERY_SESSIONS', 'session_id'], ['DISCOVERY_PITCHES', 'pitch_id'],
];
const QUEUE_ACTION_TYPES = new Set(['PROBE_AGENCY', 'SORT_LEAD']);
const OPEN_ACTION = new Set(['PENDING', 'DUE', 'IN_PROGRESS', 'SNOOZED']);

async function recordsOrEmpty(repo, tab, idColumn) {
  try { return await repo.getRecords(tab, idColumn); } catch { return []; }
}

const sameId = (record, agencyId) => String(record.obj.agency_id || '').trim() === agencyId;

// An open queue task the engine derived by itself is not history; anything
// else in ACTIONS (a completed call, a human task) is.
export function isSystemQueueAction(action) {
  return QUEUE_ACTION_TYPES.has(String(action.action_type || '').toUpperCase())
    && String(action.action_status || '').toUpperCase() !== 'COMPLETED';
}

async function loadRelationship(repo, agencyId, agencies = null) {
  const [agencyRecords, probeRecords] = await Promise.all([
    agencies || repo.getRecords('AGENCIES', 'agency_id'),
    recordsOrEmpty(repo, 'PROBES', 'probe_id'),
  ]);
  return relationshipsForAgency(agencyId, agencyRecords, probeRecords);
}

// Why this row may or may not be deleted, in operator language.
export async function deleteCheck(repo, agencyId, relationship) {
  if (!relationship || relationship.status !== 'EXACT_DUPLICATE') {
    return { permitted: false, reason: 'Only a confirmed exact duplicate of another agency row can be deleted. Use Skip to take this agency out of the queue instead.' };
  }
  if (!relationship.canonical_agency_id) {
    return { permitted: false, reason: 'This row is the one NOVUS keeps for this branch (probed, or earliest in the sheet). Delete the duplicate row instead.' };
  }
  const [counts, actionRows] = await Promise.all([
    Promise.all(HISTORY_TABS.map(async ([tab, idColumn]) => ({
      tab, count: (await recordsOrEmpty(repo, tab, idColumn)).filter((r) => sameId(r, agencyId)).length,
    }))),
    recordsOrEmpty(repo, 'ACTIONS', 'action_id'),
  ]);
  const history = counts.filter((h) => h.count);
  const actions = actionRows.filter((r) => sameId(r, agencyId));
  const workedActions = actions.filter((r) => !isSystemQueueAction(r.obj));
  if (workedActions.length) history.push({ tab: 'ACTIONS', count: workedActions.length });
  const canonical = relationship.related.find((r) => r.agency_id === relationship.canonical_agency_id);
  if (history.length) {
    return {
      permitted: false, canonical_agency_id: relationship.canonical_agency_id, history,
      reason: `Not deletable: this row has its own history (${history.map((h) => `${h.count} ${h.tab}`).join(', ')}). `
        + `It duplicates ${canonical?.agency_name || relationship.canonical_agency_id} (row ${canonical?.sheet_row || '?'}), so skip it instead — the history stays attached.`,
    };
  }
  return {
    permitted: true, canonical_agency_id: relationship.canonical_agency_id,
    canonical_sheet_row: canonical?.sheet_row || null,
    system_actions_to_cancel: actions.filter((r) => OPEN_ACTION.has(String(r.obj.action_status || '').toUpperCase())).length,
    reason: `Exact duplicate of ${canonical?.agency_name || relationship.canonical_agency_id} (row ${canonical?.sheet_row || '?'}) with no history of its own.`,
  };
}

const stamp = (now) => now.slice(0, 10);
const appendNote = (notes, line) => [String(notes || '').trim(), line].filter(Boolean).join('\n');

async function nextAfter(repo, agencyId) {
  const agencyRows = await repo.getRecords('AGENCIES', 'agency_id');
  const at = agencyRows.findIndex((record) => sameId(record, agencyId));
  const next = agencyRows.slice(at + 1).find((record) => isProbeEligible(record.obj))
    || agencyRows.find((record) => isProbeEligible(record.obj));
  return { next_agency_id: String(next?.obj?.agency_id || '').trim(), queue: queueStats(agencyRows) };
}

async function handleSkipAgency(body, res) {
  const agencyId = String(body.agency_id || '').trim();
  const reason = String(body.reason || '').trim();
  const note = String(body.note || '').trim().slice(0, 200);
  if (!agencyId) return res.status(400).json({ error: 'Missing agency_id' });
  if (!SKIP_REASONS.includes(reason)) {
    return res.status(400).json({ error: `Choose a skip reason: ${SKIP_REASONS.join(', ')}` });
  }
  try {
    const repo = getRepo();
    await repo.ensureColumns('AGENCIES', SKIP_COLUMNS);
    const agency = await repo.findById('AGENCIES', 'agency_id', agencyId);
    if (!agency) return res.status(404).json({ error: 'Agency not found' });
    const now = new Date().toISOString();
    const recorded = note ? `${reason} — ${note}` : reason;
    await repo.updateById('AGENCIES', 'agency_id', agencyId, {
      probe_skip_status: 'SKIPPED', probe_skip_reason: recorded, probe_skipped_at: now, updated_at: now,
      notes: appendNote(agency.obj.notes, `[${stamp(now)}] prober skip: ${recorded}`),
    });
    const actions = await reconcileAgencyActionsBestEffort(repo, agencyId, 'probe skip');
    return res.status(200).json({ skipped: true, agency_id: agencyId, reason: recorded, skipped_at: now, actions, ...(await nextAfter(repo, agencyId)) });
  } catch (err) {
    console.error('probe skip agency error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to skip agency' });
  }
}

async function handleRestoreAgency(body, res) {
  const agencyId = String(body.agency_id || '').trim();
  if (!agencyId) return res.status(400).json({ error: 'Missing agency_id' });
  try {
    const repo = getRepo();
    const agency = await repo.findById('AGENCIES', 'agency_id', agencyId);
    if (!agency) return res.status(404).json({ error: 'Agency not found' });
    if (!isProbeSkipped(agency.obj)) return res.status(409).json({ error: 'This agency is not skipped.' });
    const now = new Date().toISOString();
    // Reason and timestamp of the skip are kept; the status alone re-opens it.
    await repo.updateById('AGENCIES', 'agency_id', agencyId, {
      probe_skip_status: 'RESTORED', updated_at: now,
      notes: appendNote(agency.obj.notes, `[${stamp(now)}] prober restore: back in the probe queue`),
    });
    const actions = await reconcileAgencyActionsBestEffort(repo, agencyId, 'probe restore');
    return res.status(200).json({ restored: true, agency_id: agencyId, actions });
  } catch (err) {
    console.error('probe restore agency error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to restore agency' });
  }
}

async function handleDeleteAgency(body, res) {
  const agencyId = String(body.agency_id || '').trim();
  if (!agencyId) return res.status(400).json({ error: 'Missing agency_id' });
  if (String(body.confirm || '').trim() !== 'DELETE_EXACT_DUPLICATE') {
    return res.status(400).json({ error: 'Missing confirm=DELETE_EXACT_DUPLICATE' });
  }
  try {
    const repo = getRepo();
    const agencies = await repo.getRecords('AGENCIES', 'agency_id');
    const agency = agencies.find((record) => sameId(record, agencyId));
    if (!agency) return res.status(404).json({ error: 'Agency not found' });
    if (body.expected_updated_at && String(agency.obj.updated_at || '').trim() !== String(body.expected_updated_at).trim()) {
      return res.status(409).json({ error: 'Agency changed since it was loaded; refresh before deleting' });
    }
    const relationship = await loadRelationship(repo, agencyId, agencies);
    const check = await deleteCheck(repo, agencyId, relationship);
    if (!check.permitted) return res.status(409).json({ error: check.reason, delete_check: check, relationship });

    const now = new Date().toISOString();
    const canonicalId = check.canonical_agency_id;
    // Contacts are history: re-link them to the kept row, never delete them.
    const contacts = (await recordsOrEmpty(repo, 'CONTACTS', 'contact_id')).filter((r) => sameId(r, agencyId));
    for (const contact of contacts) {
      await repo.updateById('CONTACTS', 'contact_id', contact.obj.contact_id, {
        agency_id: canonicalId, is_selected_for_outreach: 'FALSE', updated_at: now,
        notes: appendNote(contact.obj.notes, `[${stamp(now)}] re-linked from deleted duplicate agency ${agencyId}`),
      });
    }
    // The engine's open queue tasks for this row are cancelled, not deleted.
    const openActions = (await recordsOrEmpty(repo, 'ACTIONS', 'action_id'))
      .filter((r) => sameId(r, agencyId) && OPEN_ACTION.has(String(r.obj.action_status || '').toUpperCase()));
    for (const action of openActions) {
      await patchAction(repo, action.obj.action_id, {
        action_status: 'CANCELLED', cancelled_at: now, updated_at: now,
        completion_reason: `agency deleted as exact duplicate of ${canonicalId}`,
      });
    }
    // Re-read immediately before the physical delete: row numbers shift.
    const fresh = await repo.findById('AGENCIES', 'agency_id', agencyId);
    if (fresh) await repo.deleteRows('AGENCIES', [fresh.rowNumber]);
    console.info('probe delete: exact duplicate agency removed', {
      agency_id: agencyId, agency_name: agency.obj.agency_name, canonical_agency_id: canonicalId,
      contacts_relinked: contacts.length, actions_cancelled: openActions.length,
    });
    return res.status(200).json({
      deleted: true, agency_id: agencyId, canonical_agency_id: canonicalId,
      contacts_relinked: contacts.length, actions_cancelled: openActions.length,
      ...(await nextAfter(repo, agencyId)),
    });
  } catch (err) {
    console.error('probe delete agency error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to delete duplicate agency' });
  }
}

// Writes the brand relationship onto AGENCIES rows from `from_row` down, for
// every row that relates to another. Dry-run unless dry_run === false.
async function handleRelationshipsBackfill(body, res) {
  const fromRow = Math.max(2, Number(body.from_row) || 2);
  const dryRun = body.dry_run !== false;
  try {
    const repo = getRepo();
    const [agencies, probes] = await Promise.all([
      repo.getRecords('AGENCIES', 'agency_id'), recordsOrEmpty(repo, 'PROBES', 'probe_id'),
    ]);
    const index = buildAgencyIndex(agencies.map((r) => r.obj), agencies.map((r) => r.rowNumber));
    const byAgency = groupProbesByAgency(probes.map((r) => r.obj));
    const rows = agencies.filter((r) => r.rowNumber >= fromRow).map((record) => {
      const rel = describeAgencyRelationships(record.obj.agency_id, index, byAgency);
      return {
        rowNumber: record.rowNumber, agency_id: rel.agency_id, status: rel.status, probe_decision: rel.probe_decision,
        values: {
          parent_brand_key: rel.brand_key, brand_relationship: rel.status,
          related_agency_ids: rel.related.map((r) => `${r.agency_id}:${r.relationship}`).join(', '),
          duplicate_of_agency_id: rel.canonical_agency_id,
        },
      };
    }).filter((row) => row.status !== 'UNRELATED');
    const counts = rows.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
    if (dryRun) return res.status(200).json({ dry_run: true, from_row: fromRow, counts, rows: rows.map(({ values, ...r }) => ({ ...r, ...values })) });
    const header = await repo.ensureColumns('AGENCIES', RELATIONSHIP_COLUMNS);
    const writes = rows.flatMap((row) => RELATIONSHIP_COLUMNS.map((column) => ({
      tab: 'AGENCIES', rowNumber: row.rowNumber, columnNumber: header.indexOf(column) + 1, value: row.values[column],
    })));
    await repo.writeCellsBatch(writes, 1000);
    return res.status(200).json({ dry_run: false, from_row: fromRow, counts, rows_written: rows.length, cells_written: writes.length });
  } catch (err) {
    console.error('probe relationships backfill error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to backfill relationships' });
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;

  if (req.method === 'GET') return handleGet(req, res);

  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
    if (body.action === 'create') return handleCreate(body, res);
    if (body.action === 'mark-sent') return handleMarkSent(body, res);
    if (body.action === 'skip-agency') return handleSkipAgency(body, res);
    if (body.action === 'restore-agency') return handleRestoreAgency(body, res);
    if (body.action === 'delete-agency') return handleDeleteAgency(body, res);
    if (body.action === 'relationships-backfill') return handleRelationshipsBackfill(body, res);
    return res.status(400).json({ error: 'Missing or unknown action — expected create, mark-sent, skip-agency, restore-agency, delete-agency or relationships-backfill' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }