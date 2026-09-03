// Deliberate tombstone deletion for an inbound COMMUNICATIONS row that
// carries no useful evidence (e.g. a call where no voicemail was left).
// Distinct from leaving a row unmatched: an unmatched row still wants a
// human decision; a deleted row has been judged to carry nothing worth
// deciding on.
//
// No new sheet columns: this workbook has no schema-migration mechanism, so
// "deleted" reuses match_status (see lib/communication-status.mjs) and the
// existing, otherwise-unused override_reason column for the human's reason.
// Every reader that matters — the matcher's historical-identifier evidence,
// the resolution queue, backfill candidates, and every observation/
// intelligence/demo rollup — already keys off match_status or is updated
// alongside this file to skip match_status = 'deleted' rows.
//
// The originating RAW_EVENT(s) are tagged 'discarded' so a future
// processing/rebuild pass over raw evidence has an explicit, durable signal
// never to re-derive a COMMUNICATIONS row from them. The existing
// provider+provider_event_id dedup check in every webhook already prevents a
// literal webhook replay from recreating the row regardless.

import { recomputeProbeObservation } from './observation-recompute.mjs';
import { DELETED_MATCH_STATUS, DISCARDED_PROCESSING_STATUS, isDeletedCommunication } from './communication-status.mjs';

export const DELETE_COMMUNICATION_CONFIRMATION = 'DELETE_COMMUNICATION';

function text(value) {
  return String(value ?? '').trim();
}

export async function deleteInboundCommunication(repo, {
  communication_id,
  confirm,
  reason = '',
} = {}) {
  const communicationId = text(communication_id);
  if (!communicationId) {
    return { ok: false, status: 400, error: 'communication_id is required' };
  }
  if (text(confirm) !== DELETE_COMMUNICATION_CONFIRMATION) {
    return { ok: false, status: 400, error: `Missing confirm=${DELETE_COMMUNICATION_CONFIRMATION}` };
  }

  const record = await repo.findById('COMMUNICATIONS', 'communication_id', communicationId);
  if (!record) return { ok: false, status: 404, error: 'Communication not found' };
  const comm = record.obj;

  if (isDeletedCommunication(comm)) {
    return {
      ok: true,
      status: 200,
      already_deleted: true,
      communication_id: communicationId,
      probe_id: text(comm.probe_id),
      recomputed: false,
    };
  }

  const probeId = text(comm.probe_id);
  const now = new Date().toISOString();

  const merged = await repo.updateById('COMMUNICATIONS', 'communication_id', communicationId, {
    match_status: DELETED_MATCH_STATUS,
    manual_review_status: 'not_required',
    override_reason: text(reason) || text(comm.override_reason),
    updated_at: now,
  });
  if (!merged) return { ok: false, status: 409, error: 'Communication could not be updated' };

  // Tombstone the originating RAW_EVENT(s) — normally exactly one, but every
  // matching row is flagged in case more than one ever pointed here.
  const rawEvents = await repo.getRecords('RAW_EVENTS', 'raw_event_id');
  const linkedRawEvents = rawEvents.filter((r) => text(r.obj.processed_communication_id) === communicationId);
  for (const raw of linkedRawEvents) {
    await repo.updateById('RAW_EVENTS', 'raw_event_id', raw.obj.raw_event_id, {
      processing_status: DISCARDED_PROCESSING_STATUS,
    });
  }

  let recomputed = false;
  const failures = [];
  if (probeId) {
    try {
      await recomputeProbeObservation(repo, probeId);
      recomputed = true;
    } catch (err) {
      failures.push({ stage: 'recompute', probe_id: probeId, error: err?.message || String(err) });
    }
  }

  return {
    ok: true,
    status: 200,
    communication_id: communicationId,
    probe_id: probeId,
    raw_events_discarded: linkedRawEvents.length,
    recomputed,
    failures,
  };
}
