// Explicit one-off write path for deterministic inbound match recovery.
// Only blank agency_id/probe_id cells are filled. Existing non-blank IDs are
// never overwritten, and every committed match uses the existing observation
// recomputation path used by live ingestion.

import { evaluateInboundMatchCandidates } from './inbound-match-review.mjs';
import { recomputeProbeObservation } from './observation-recompute.mjs';

function text(value) {
  return String(value ?? '').trim();
}

function emptySummary(reviewed) {
  return {
    reviewed,
    updated: 0,
    skipped_unmatched: 0,
    skipped_ambiguous: 0,
    skipped_conflict: 0,
    skipped_existing: 0,
    failed: 0,
  };
}

export async function runInboundMatchBackfill(repo, options = {}, {
  recompute = recomputeProbeObservation,
} = {}) {
  const { evaluations, parameters } = await evaluateInboundMatchCandidates(repo, {
    ...options,
    candidateMode: 'missing_identity',
  });
  const summary = emptySummary(evaluations.length);
  const updated = [];
  const failures = [];

  for (const { communication: original, proposed, status } of evaluations) {
    const communicationId = text(original.communication_id);
    if (status === 'conflict') {
      summary.skipped_conflict++;
      continue;
    }
    if (status === 'ambiguous') {
      summary.skipped_ambiguous++;
      continue;
    }
    if (status !== 'recoverable' || !text(proposed.agency_id) || !text(proposed.probe_id)) {
      summary.skipped_unmatched++;
      continue;
    }

    try {
      // Re-read immediately before mutation. This prevents a stale preview or
      // a concurrent earlier run from causing a non-blank ID to be replaced.
      const latestRecord = await repo.findById('COMMUNICATIONS', 'communication_id', communicationId);
      if (!latestRecord) throw new Error('COMMUNICATIONS row no longer exists');
      const latest = latestRecord.obj;
      const currentAgencyId = text(latest.agency_id);
      const currentProbeId = text(latest.probe_id);
      const agencyContradiction = currentAgencyId && currentAgencyId !== text(proposed.agency_id);
      const probeContradiction = currentProbeId && currentProbeId !== text(proposed.probe_id);
      if (agencyContradiction || probeContradiction || (currentAgencyId && currentProbeId)) {
        summary.skipped_existing++;
        continue;
      }

      const patch = {
        matching_method: proposed.matching_method,
        match_score: proposed.match_score,
        match_status: 'matched',
        manual_review_status: 'not_required',
      };
      if (!currentAgencyId) patch.agency_id = proposed.agency_id;
      if (!currentProbeId) patch.probe_id = proposed.probe_id;

      const merged = await repo.updateById('COMMUNICATIONS', 'communication_id', communicationId, patch);
      if (!merged) throw new Error('COMMUNICATIONS row could not be updated');

      const item = {
        communication_id: communicationId,
        agency_id: text(merged.agency_id),
        probe_id: text(merged.probe_id),
        matching_method: text(merged.matching_method),
      };
      updated.push(item);
      summary.updated++;

      try {
        await recompute(repo, item.probe_id);
      } catch (err) {
        summary.failed++;
        failures.push({ communication_id: communicationId, stage: 'recompute', error: err?.message || String(err) });
      }
    } catch (err) {
      summary.failed++;
      failures.push({ communication_id: communicationId, stage: 'write', error: err?.message || String(err) });
    }
  }

  return {
    read_only: false,
    parameters,
    summary,
    updated,
    failures,
  };
}

