// Human confirmation path for unresolved inbound COMMUNICATIONS.
//
// A human selects the agency + probe from the protected Command Centre. The
// write is deliberately narrow: it updates the one COMMUNICATIONS row, validates
// that the probe belongs to the selected agency, marks the row as an explicit
// manual override, and recomputes the affected probe through the existing
// deterministic observation path.
//
// Optional apply_same_identifier is a deliberate one-click "learn this number /
// email" action. It only propagates when every already-matched occurrence of
// that exact normalised identifier agrees with the selected agency+probe.

import { normalizeEmail, normalizePhone } from './normalize.mjs';
import { recomputeProbeObservation } from './observation-recompute.mjs';
import { isDeletedCommunication } from './communication-status.mjs';

export const MANUAL_MATCH_CONFIRMATION = 'CONFIRM_COMMUNICATION_MATCH';

function text(value) {
  return String(value ?? '').trim();
}

function normalizedIdentifier(comm) {
  const channel = text(comm.channel).toLowerCase();
  const raw = text(comm.source_identifier_normalized || comm.source_identifier_raw);
  if (channel === 'email' || raw.includes('@')) return normalizeEmail(raw).normalized;
  if (['sms', 'voice'].includes(channel)) return normalizePhone(raw);
  return raw;
}

function alreadyMatchedTo(comm, agencyId, probeId) {
  return text(comm.match_status).toLowerCase() === 'matched'
    && text(comm.agency_id) === agencyId
    && text(comm.probe_id) === probeId;
}

function canFillWithoutContradiction(comm, agencyId, probeId) {
  const currentAgency = text(comm.agency_id);
  const currentProbe = text(comm.probe_id);
  return (!currentAgency || currentAgency === agencyId)
    && (!currentProbe || currentProbe === probeId);
}

async function recomputeSafely(repo, probeIds, failures) {
  for (const probeId of [...new Set(probeIds)].filter(Boolean)) {
    try {
      await recomputeProbeObservation(repo, probeId);
    } catch (err) {
      failures.push({ stage: 'recompute', probe_id: probeId, error: err?.message || String(err) });
    }
  }
}

export async function confirmInboundCommunicationMatch(repo, {
  communication_id,
  agency_id,
  probe_id,
  confirm,
  apply_same_identifier = false,
} = {}) {
  const communicationId = text(communication_id);
  const agencyId = text(agency_id);
  const probeId = text(probe_id);
  if (!communicationId || !agencyId || !probeId) {
    return { ok: false, status: 400, error: 'communication_id, agency_id and probe_id are required' };
  }
  if (text(confirm) !== MANUAL_MATCH_CONFIRMATION) {
    return { ok: false, status: 400, error: `Missing confirm=${MANUAL_MATCH_CONFIRMATION}` };
  }

  const [communicationRecord, agencyRecord, probeRecord] = await Promise.all([
    repo.findById('COMMUNICATIONS', 'communication_id', communicationId),
    repo.findById('AGENCIES', 'agency_id', agencyId),
    repo.findById('PROBES', 'probe_id', probeId),
  ]);
  if (!communicationRecord) return { ok: false, status: 404, error: 'Communication not found' };
  if (isDeletedCommunication(communicationRecord.obj)) {
    return { ok: false, status: 409, error: 'Communication has been deleted' };
  }
  if (!agencyRecord) return { ok: false, status: 404, error: 'Agency not found' };
  if (!probeRecord) return { ok: false, status: 404, error: 'Probe not found' };
  if (text(probeRecord.obj.agency_id) !== agencyId) {
    return { ok: false, status: 409, error: 'Selected probe does not belong to selected agency' };
  }

  const now = new Date().toISOString();
  const patch = {
    agency_id: agencyId,
    probe_id: probeId,
    match_status: 'matched',
    matching_method: 'manual_operator',
    match_score: 1,
    manual_review_status: 'not_required',
    manual_override: 'TRUE',
    updated_at: now,
  };
  const merged = await repo.updateById('COMMUNICATIONS', 'communication_id', communicationId, patch);
  if (!merged) return { ok: false, status: 409, error: 'Communication could not be updated' };

  const propagated = [];
  const skipped = [];
  const failures = [];
  const recomputeProbeIds = [probeId];

  if (apply_same_identifier === true) {
    const identifier = normalizedIdentifier(merged);
    if (identifier) {
      const records = await repo.getRecords('COMMUNICATIONS', 'communication_id');
      const same = records.filter((record) => normalizedIdentifier(record.obj) === identifier);
      const matchedPairs = new Set(
        same
          .filter((record) => text(record.obj.match_status).toLowerCase() === 'matched')
          .filter((record) => text(record.obj.agency_id) && text(record.obj.probe_id))
          .map((record) => `${text(record.obj.agency_id)}\u0000${text(record.obj.probe_id)}`),
      );
      const expectedPair = `${agencyId}\u0000${probeId}`;
      if (matchedPairs.size === 1 && matchedPairs.has(expectedPair)) {
        for (const record of same) {
          const comm = record.obj;
          const siblingId = text(comm.communication_id);
          if (!siblingId || siblingId === communicationId || alreadyMatchedTo(comm, agencyId, probeId)) continue;
          if (isDeletedCommunication(comm)) continue;
          if (!canFillWithoutContradiction(comm, agencyId, probeId)) {
            skipped.push({ communication_id: siblingId, reason: 'existing_identity_conflict' });
            continue;
          }
          try {
            const updated = await repo.updateById('COMMUNICATIONS', 'communication_id', siblingId, {
              agency_id: agencyId,
              probe_id: probeId,
              match_status: 'matched',
              matching_method: 'manual_identifier_propagation',
              match_score: 1,
              manual_review_status: 'not_required',
              updated_at: now,
            });
            if (updated) {
              propagated.push({ communication_id: siblingId });
              recomputeProbeIds.push(probeId);
            }
          } catch (err) {
            failures.push({ stage: 'propagate', communication_id: siblingId, error: err?.message || String(err) });
          }
        }
      } else {
        skipped.push({ communication_id: communicationId, reason: 'identifier_not_unique_after_confirmation' });
      }
    }
  }

  await recomputeSafely(repo, recomputeProbeIds, failures);

  return {
    ok: true,
    status: 200,
    communication: {
      communication_id: communicationId,
      agency_id: agencyId,
      probe_id: probeId,
      matching_method: 'manual_operator',
    },
    propagated,
    skipped,
    failures,
  };
}
