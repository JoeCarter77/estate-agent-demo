// lib/intelligence-rebuild.mjs — the canonical full-rebuild path for
// INTELLIGENCE, per PROBES + COMMUNICATIONS -> EVIDENCE -> INTELLIGENCE.
//
// This does NOT reimplement recompute logic. It loops every PROBES row and
// calls the exact same per-probe engine (lib/observation-recompute.mjs
// recomputeProbeObservation) already used by:
//   - api/novus/observation/recompute.js (manual single-probe re-run)
//   - the communications webhooks (auto-recompute after a matched inbound
//     communication)
// so a change to recompute logic only ever needs to happen in one place, and
// this full rebuild, the manual single-probe endpoint, and live ingestion
// can never drift apart.
//
// Idempotent: recomputeProbeObservation() itself upserts exactly one
// INTELLIGENCE row per probe_id (never duplicates), so running rebuildAll
// twice in a row produces the same INTELLIGENCE rows both times.
//
// Zero-communication probes are valid intelligence (per spec) and are
// processed exactly like any other probe — recomputeProbeObservation /
// lib/observation.mjs / lib/grading.mjs already handle an empty
// communications list correctly (open -> pending/"observing", closed -> H).
// Nothing here special-cases them.

import { recomputeProbeObservation } from './observation-recompute.mjs';

// repo -> { probes_processed, probes_with_communications,
//   probes_with_zero_communications, intelligence_created,
//   intelligence_updated, problems: [{probe_id, error}], results: [...] }
export async function rebuildAllIntelligence(repo) {
  const probes = await repo.getRecords('PROBES', 'probe_id');
  const communications = await repo.getRecords('COMMUNICATIONS', 'communication_id');
  const commCountByProbe = new Map();
  for (const { obj } of communications) {
    if (!obj.probe_id) continue;
    commCountByProbe.set(obj.probe_id, (commCountByProbe.get(obj.probe_id) || 0) + 1);
  }

  // Snapshot which probes already have an INTELLIGENCE row BEFORE this run,
  // so created vs. updated counts are accurate even though
  // recomputeProbeObservation re-reads INTELLIGENCE itself on every call.
  const existingIntelligence = await repo.getRecords('INTELLIGENCE', 'intelligence_id');
  const hadIntelligenceBefore = new Set(existingIntelligence.map((r) => r.obj.probe_id));

  let probesWithCommunications = 0;
  let probesWithZeroCommunications = 0;
  let intelligenceCreated = 0;
  let intelligenceUpdated = 0;
  const problems = [];
  const results = [];

  for (const { obj: probe } of probes) {
    const probeId = probe.probe_id;
    const commCount = commCountByProbe.get(probeId) || 0;
    if (commCount > 0) probesWithCommunications += 1; else probesWithZeroCommunications += 1;

    try {
      const result = await recomputeProbeObservation(repo, probeId);
      if (!result) {
        problems.push({ probe_id: probeId, error: 'Probe disappeared during rebuild' });
        continue;
      }
      if (hadIntelligenceBefore.has(probeId)) intelligenceUpdated += 1; else intelligenceCreated += 1;
      results.push({
        probe_id: probeId,
        intelligence_id: result.intelligence_id,
        grade: result.grade,
        communications_matched: commCount,
      });
    } catch (err) {
      problems.push({ probe_id: probeId, error: err.message || String(err) });
    }
  }

  return {
    probes_processed: probes.length,
    probes_with_communications: probesWithCommunications,
    probes_with_zero_communications: probesWithZeroCommunications,
    intelligence_created: intelligenceCreated,
    intelligence_updated: intelligenceUpdated,
    problems,
    results,
  };
}
