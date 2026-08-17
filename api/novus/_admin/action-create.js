// api/novus/_admin/action-create.js — resource handler for
//   POST /api/novus/admin?resource=actions   Body: { probe_id, action_type, ... }
//   GET  /api/novus/admin?resource=actions&probe_id=...   list actions for a probe
//
// Relocated under the underscore-prefixed _admin/ directory so Vercel does not
// route this file directly (see api/novus/admin.js for why: staying within the
// Hobby plan's 12-serverless-function limit). The HANDLER LOGIC BELOW IS
// UNCHANGED from the original api/novus/action-create.js — only its location
// (and therefore its relative import depth) moved.
//
// The last link in AGENCY → PROBE → COMMUNICATION → INTELLIGENCE → ACTION.
//
// ── WHY THIS FILE IS NEW ─────────────────────────────────────────────────────
// The ACTIONS tab already existed in the live workbook with a full 15-column
// schema, and CONFIG already defined its action_status vocabulary
// (open / in_progress / completed / cancelled) — but NO code anywhere read or
// wrote it. The chain physically stopped at INTELLIGENCE. This adds the writer
// against the schema that is already there; it does not introduce a parallel
// action pipeline or a new vocabulary.
//
// ── HOW PROBE CONTEXT IS GUARANTEED ──────────────────────────────────────────
// agency_id is NEVER taken from the request body. It is read from the PROBES
// row identified by probe_id, so an action cannot be filed against a
// probe/agency pair that doesn't exist in the sheet. This is the same "derive,
// never accept" rule the communications webhooks already follow.

import { getRepo } from '../../../lib/sheets.mjs';
import { newActionId } from '../../../lib/ids.mjs';
import { requireAuth } from '../_auth.mjs';

export const maxDuration = 20;

// Exactly the CONFIG action_status vocabulary. No additions.
const ACTION_STATUS = ['open', 'in_progress', 'completed', 'cancelled'];
const PRIORITY = ['low', 'normal', 'high', 'urgent'];

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;

  if (req.method === 'GET') return listActions(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const probeId = String(body.probe_id || '').trim();
  const actionType = String(body.action_type || '').trim();

  if (!probeId) return res.status(400).json({ error: 'Missing probe_id' });
  if (!actionType) return res.status(400).json({ error: 'Missing action_type' });

  const status = String(body.action_status || 'open').trim().toLowerCase();
  if (!ACTION_STATUS.includes(status)) {
    return res.status(400).json({ error: `action_status must be one of: ${ACTION_STATUS.join(', ')}` });
  }
  const priority = String(body.priority || 'normal').trim().toLowerCase();
  if (!PRIORITY.includes(priority)) {
    return res.status(400).json({ error: `priority must be one of: ${PRIORITY.join(', ')}` });
  }

  try {
    const repo = getRepo();

    // Probe must exist — this is what anchors the action to a real agency.
    const probe = await repo.findById('PROBES', 'probe_id', probeId);
    if (!probe) return res.status(404).json({ error: `Unknown probe_id "${probeId}"` });

    const agencyId = String(probe.obj.agency_id || '').trim();
    if (!agencyId) {
      // A probe with no agency cannot carry an action anywhere useful. Refuse
      // loudly rather than writing an orphan row.
      return res.status(409).json({
        error: `Probe ${probeId} has no agency_id, so an action cannot be attributed. Repair the probe's agency link first.`,
        probe_id: probeId,
      });
    }

    // If a communication is cited, it must belong to THIS probe — otherwise the
    // action would carry evidence from an unrelated probe.
    const relatedCommunicationId = String(body.related_communication_id || '').trim();
    if (relatedCommunicationId) {
      const comm = await repo.findById('COMMUNICATIONS', 'communication_id', relatedCommunicationId);
      if (!comm) {
        return res.status(404).json({ error: `Unknown related_communication_id "${relatedCommunicationId}"` });
      }
      if (String(comm.obj.probe_id || '').trim() !== probeId) {
        return res.status(409).json({
          error: `Communication ${relatedCommunicationId} belongs to probe "${comm.obj.probe_id || '(none)'}", not ${probeId}.`,
        });
      }
    }

    const now = new Date().toISOString();
    const action = {
      action_id: newActionId(),
      agency_id: agencyId,
      probe_id: probeId,
      action_type: actionType,
      action_status: status,
      priority,
      due_at: String(body.due_at || '').trim(),
      completed_at: status === 'completed' ? now : '',
      owner: String(body.owner || '').trim(),
      trigger: String(body.trigger || '').trim(),
      reason: String(body.reason || '').trim(),
      related_communication_id: relatedCommunicationId,
      notes: String(body.notes || '').trim(),
      created_at: now,
      updated_at: now,
    };

    await repo.appendRecord('ACTIONS', action);

    return res.status(200).json({
      action,
      // Echo the resolved chain so a caller can assert it end-to-end.
      chain: {
        agency_id: agencyId,
        probe_id: probeId,
        property_url: probe.obj.property_url || '',
        related_communication_id: relatedCommunicationId,
      },
    });
  } catch (err) {
    console.error('action-create error:', err);
    return res.status(500).json({ error: err.message || 'Failed to create action' });
  }
}

async function listActions(req, res) {
  const probeId = String(req.query?.probe_id || '').trim();
  const agencyId = String(req.query?.agency_id || '').trim();
  if (!probeId && !agencyId) {
    return res.status(400).json({ error: 'Provide probe_id or agency_id' });
  }
  try {
    const repo = getRepo();
    const records = await repo.getRecords('ACTIONS', 'action_id');
    const actions = records
      .map((r) => r.obj)
      .filter((a) => (probeId ? a.probe_id === probeId : true))
      .filter((a) => (agencyId ? a.agency_id === agencyId : true));
    return res.status(200).json({ actions, count: actions.length });
  } catch (err) {
    console.error('action-create list error:', err);
    return res.status(500).json({ error: err.message || 'Failed to list actions' });
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
