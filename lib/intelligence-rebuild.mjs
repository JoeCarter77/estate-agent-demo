// lib/intelligence-rebuild.mjs — the canonical full-rebuild path for
// INTELLIGENCE, per PROBES + COMMUNICATIONS -> EVIDENCE -> INTELLIGENCE.
//
// PERFORMANCE NOTE: this file must never trigger a per-row or per-write read
// against Google Sheets. Two things blew through the Sheets API read quota
// (HTTP 429) before this shape:
//   1. Calling lib/observation-recompute.mjs's recomputeProbeObservation()
//      once per probe — it reads COMMUNICATIONS and INTELLIGENCE fresh from
//      Sheets on every call (correct for a single probe, O(probes) full-table
//      reads for a full rebuild).
//   2. Even after batch-loading the three tables up front, WRITING through
//      repo.updateById()/repo.appendRecord() still reads the target tab
//      again before every single write (that's how those helpers do their
//      safe row-level merge) — so a rebuild with many changed rows still
//      did one read PER WRITE.
//
// rebuildAllIntelligence() now:
//   1. Batch-loads PROBES, COMMUNICATIONS and INTELLIGENCE exactly ONCE
//      (repo.getTable() directly — not repo.getRecords(), which would read
//      the same tab a second time just to hand back the header separately).
//   2. Runs the SAME per-probe pipeline recomputeProbeObservation() uses —
//      classification (lib/classification.mjs), the 30-minute contact-
//      attempt grouping + evidence rollup (lib/observation.mjs), and the
//      A-H grading engine (lib/grading.mjs) — entirely in memory, against
//      the batch-loaded data. No logic is duplicated or reimplemented; the
//      exact same pure functions are called, just orchestrated around
//      pre-loaded data instead of per-probe (or per-write) sheet reads.
//   3. Only then performs the writes — via repo.writeRowsBatch(), which
//      sends already-fully-formed rows straight to the Sheets API
//      values:batchUpdate endpoint with NO read first. Every COMMUNICATIONS
//      row that needs a classification/follow_up patch and every INTELLIGENCE
//      create/update is merged in memory (against the batch-loaded snapshot)
//      and collected into ONE flat list, sent in a small, constant-ish
//      number of chunked requests — never one request per row.
//
// lib/observation-recompute.mjs itself is untouched: single-probe recompute
// (api/novus/intelligence/rebuild-all.js, when body.probe_id is present) and the webhooks' auto-recompute
// keep behaving exactly as before.
//
// Idempotent: INTELLIGENCE is still upserted exactly one row per probe_id
// (looked up from the batch-loaded snapshot) — running rebuildAll twice in
// a row produces the same INTELLIGENCE rows both times, never duplicates.
//
// Zero-communication probes are valid intelligence (per spec) and are
// processed exactly like any other probe — computeObservation/
// gradeObservation already handle an empty communications list correctly
// (open -> pending/"observing", closed -> H). Nothing here special-cases them.

import { newIntelligenceId } from './ids.mjs';
import { interpretCommunication, detectCrm, isHumanCommunication } from './classification.mjs';
import { computeObservation, markFollowUps } from './observation.mjs';
import { gradeObservation, resolveObservationDeadline } from './grading.mjs';
import { computeVendorOpportunity } from './vendor-intent.mjs';
import { buildEvidenceSummary } from './evidence-summary.mjs';
import { computeProbeIntelligenceContext } from './probe-intelligence.mjs';

function isOverridden(comm) {
  return comm.manual_override === 'TRUE' || comm.manual_override === true;
}

// Same row-filtering rule as repo.getRecords(): skip any row whose id column
// is empty or the literal "SCHEMA NOTE" (row 1 = header, row 2 = schema
// note, row 3+ = data). Duplicated here (not called) because the batch load
// below reads each tab via getTable() directly, once, instead of going
// through getRecords() (which would call getTable() a second time).
function recordsFromTable({ header, rows }, idColumn) {
  const idIdx = header.indexOf(idColumn);
  const out = [];
  rows.forEach((row, i) => {
    const idVal = idIdx >= 0 ? (row[idIdx] ?? '') : '';
    if (!idVal || idVal === 'SCHEMA NOTE') return;
    const obj = {};
    header.forEach((key, colIdx) => { obj[key] = row[colIdx] ?? ''; });
    out.push({ rowNumber: i + 2, obj });
  });
  return out;
}

// Runs the same interpretation -> evidence -> decision pipeline as
// recomputeProbeObservation(), against an in-memory probe + its already
// batch-loaded communications. No sheet I/O. Returns the computed result
// plus any COMMUNICATIONS row patches that still need writing.
function computeProbeIntelligence(probe, probeCommunications, now) {
  const communicationPatches = new Map(); // communication_id -> patch

  // 2) INTERPRETATION
  // EVERY non-overridden communication is re-interpreted on every rebuild,
  // previously classified or not. The old guard here skipped any row that
  // already had automated_or_human set, which permanently froze
  // communication_classification, booking_attempt, contact_quality and intent
  // as blank on every historical row and on every row written before those
  // detectors existed — no number of rebuilds could ever fill them in.
  // interpretCommunication() preserves an existing human/automated decision
  // (so the A-H grade stays stable) while recomputing the derived columns.
  const classified = [];
  const crmResults = [];
  for (const comm of probeCommunications) {
    if (isOverridden(comm)) {
      classified.push(comm);
      continue;
    }

    const patch = interpretCommunication(comm, { probeTimestamp: probe.probe_timestamp });
    crmResults.push(detectCrm(comm));

    // Only write cells that actually change — a rebuild over an already-correct
    // sheet still produces zero COMMUNICATIONS writes.
    const changed = {};
    for (const [key, value] of Object.entries(patch)) {
      if (String(comm[key] ?? '') !== String(value)) changed[key] = value;
    }
    if (Object.keys(changed).length > 0) {
      communicationPatches.set(comm.communication_id, { ...(communicationPatches.get(comm.communication_id) || {}), ...changed });
    }
    classified.push({ ...comm, ...patch });
  }

  // Second pass: mark which human touches belong to a follow-up contact
  // attempt (2nd+ attempt under the 30-minute grouping rule).
  const humanSorted = classified
    .filter((c) => isHumanCommunication(c))
    .map((c) => ({ ...c, _occurredAt: new Date(c.occurred_at) }))
    .filter((c) => !Number.isNaN(c._occurredAt.getTime()))
    .sort((a, b) => a._occurredAt - b._occurredAt);

  const withFollowUpFlags = markFollowUps(humanSorted);
  for (const comm of withFollowUpFlags) {
    if (isOverridden(comm)) continue;
    const desired = comm.is_follow_up ? 'TRUE' : 'FALSE';
    if (comm.follow_up !== desired) {
      communicationPatches.set(comm.communication_id, { ...(communicationPatches.get(comm.communication_id) || {}), follow_up: desired });
      comm.follow_up = desired;
    }
  }

  // 3) EVIDENCE ROLLUP
  const observation = computeObservation(probe, classified);

  // CRM detection rollup — 'unknown' unless a real signature matched.
  const crmResult = crmResults.find((c) => c && c.crm_detected !== 'unknown') || { crm_detected: 'unknown', crm_name: '', crm_evidence: '' };

  // VENDOR OPPORTUNITY — entirely separate from the A-H grade below. Only
  // runs for probes that declared a vendor opportunity at creation (see
  // lib/vendor-intent.mjs); returns null otherwise, in which case no vendor
  // fields are touched at all.
  const vendorResult = computeVendorOpportunity(probe, classified);

  // PROBE-LEVEL CONTEXT — the whole conversation plus the original enquiry,
  // judged together. This is what makes "did they respond to the actual
  // enquiry", "did they push for the booking" and "what did they NOT do"
  // answerable; see lib/probe-intelligence.mjs.
  const context = computeProbeIntelligenceContext({
    probe,
    communications: classified,
    phraseVendorStatus: vendorResult ? vendorResult.status : '',
  });

  // A vendor-position question ("confirm your position - sold/selling") is
  // vendor engagement the phrase list cannot see. Tag those rows' intent too,
  // so COMMUNICATIONS.intent reflects the same conclusion INTELLIGENCE reaches.
  const vendorCommPatches = new Map(vendorResult ? vendorResult.commPatches : []);
  if (context.enquiry.has_property_to_sell) {
    for (const a of context.assessments) {
      if (a.asks_vendor_position && !vendorCommPatches.has(a.communication_id)) {
        vendorCommPatches.set(a.communication_id, { intent: 'vendor_acknowledged' });
      }
    }
  }

  if (vendorCommPatches.size > 0) {
    const byId = new Map(classified.map((c) => [c.communication_id, c]));
    for (const [communicationId, patch] of vendorCommPatches) {
      const existing = byId.get(communicationId) || {};
      // Same change-only rule as the classification patches above, so a rebuild
      // over an already-tagged sheet writes nothing.
      const changed = {};
      for (const [key, value] of Object.entries(patch)) {
        if (String(existing[key] ?? '') !== String(value)) changed[key] = value;
      }
      if (Object.keys(changed).length > 0) {
        communicationPatches.set(communicationId, { ...(communicationPatches.get(communicationId) || {}), ...changed });
      }
    }
  }

  // 4) DECISION
  const deadline = resolveObservationDeadline(probe);
  const windowClosed = Boolean(deadline && now.getTime() >= deadline.getTime());
  const { grade, grade_reason } = gradeObservation({ probe, observation, now });

  const intelligencePatch = {
    agency_id: probe.agency_id || '',
    probe_id: probe.probe_id,
    observation_status: windowClosed ? 'closed' : 'observing',
    // PROBES.compromised forwarded onto the Intelligence row so DIAGNOSIS can
    // refuse to draw a commercial conclusion from a probe that did not test
    // what it was supposed to. Written into the EXISTING override_reason
    // column (previously unused on every row) rather than adding one: a
    // compromised probe is exactly a row whose conclusions are overridden.
    ...(context.enquiry.compromised
      ? { override_reason: `COMPROMISED PROBE — ${context.enquiry.compromise_reason || 'probe did not test the intended behaviour'}` }
      : {}),
    observation_deadline: deadline ? deadline.toISOString() : (probe.observation_deadline || ''),
    auto_acknowledgement: observation.auto_acknowledgement ? 'TRUE' : 'FALSE',
    auto_ack_timestamp: observation.auto_ack_timestamp,
    crm_detected: crmResult.crm_detected === true ? 'TRUE' : crmResult.crm_detected === false ? 'FALSE' : 'unknown',
    crm_name: crmResult.crm_name,
    crm_evidence: crmResult.crm_evidence,
    first_human_touch: observation.first_human_touch,
    first_human_touch_at: observation.first_human_touch_at,
    human_lag_hours: observation.human_lag_hours,
    callback_attempts: observation.callback_attempts,
    successful_conversations: observation.successful_conversations,
    voicemail_count: observation.voicemail_count,
    inbound_sms_count: observation.inbound_sms_count,
    email_touch_count: observation.email_touch_count,
    contact_attempt_count: observation.contact_attempt_count,
    follow_up_count: observation.follow_up_count,
    follow_up_channels: observation.follow_up_channels,
    last_touch_at: observation.last_touch_at,
    days_chased: observation.days_chased,
    booking_attempt: observation.booking_attempt ? 'TRUE' : 'FALSE',
    contact_quality: observation.contact_quality,
    // Source Master §11 "Proactive vs reactive contact" — its own column, and
    // deliberately NOT the same thing as contact_quality above.
    proactive_reactive: observation.proactive_reactive,
    persistence_profile: observation.persistence_profile,
    channels_used: observation.channels_used,
    grade,
    grade_reason,
    observation_closed_at: windowClosed ? (deadline ? deadline.toISOString() : now.toISOString()) : '',
    updated_at: now.toISOString(),
    // Written for EVERY probe now, not only vendor-declaration probes: the
    // vendor line (when there is one) plus the response/persistence/booking
    // read and verbatim quotes from the actual communications.
    ai_evidence_summary: buildEvidenceSummary({ communications: classified, observation, context }),
  };

  return { grade, grade_reason, observation, intelligencePatch, communicationPatches };
}

// repo -> { probes_processed, probes_with_communications,
//   probes_with_zero_communications, intelligence_created,
//   intelligence_updated, problems: [{probe_id, error}], results: [...] }
export async function rebuildAllIntelligence(repo) {
  // 1) BATCH LOAD — exactly one read of each table for the whole rebuild.
  // getTable() (not getRecords()) so we get the header alongside the rows in
  // that SAME read — needed later to build full row arrays for the batch
  // write without reading the tab again.
  const [probesTable, communicationsTable, intelligenceTable] = await Promise.all([
    repo.getTable('PROBES'),
    repo.getTable('COMMUNICATIONS'),
    repo.getTable('INTELLIGENCE'),
  ]);

  const probeRecords = recordsFromTable(probesTable, 'probe_id');
  const communicationRecords = recordsFromTable(communicationsTable, 'communication_id');
  const intelligenceRecords = recordsFromTable(intelligenceTable, 'intelligence_id');

  const communicationsByProbe = new Map();
  const communicationRowById = new Map(); // communication_id -> { rowNumber, obj }
  for (const rec of communicationRecords) {
    communicationRowById.set(rec.obj.communication_id, rec);
    const probeId = rec.obj.probe_id;
    if (!probeId) continue;
    if (!communicationsByProbe.has(probeId)) communicationsByProbe.set(probeId, []);
    communicationsByProbe.get(probeId).push(rec.obj);
  }

  const intelligenceByProbe = new Map(intelligenceRecords.map((r) => [r.obj.probe_id, r]));

  // 2) COMPUTE — the full pipeline, entirely in memory, for every probe.
  const now = new Date();
  let probesWithCommunications = 0;
  let probesWithZeroCommunications = 0;
  const problems = [];
  const results = [];
  const communicationPatchesById = new Map(); // communication_id -> merged patch
  const intelligenceUpsertsByProbe = new Map(); // probe_id -> { intelligenceId, patch, isCreate }

  for (const rec of probeRecords) {
    const probe = rec.obj;
    const probeId = probe.probe_id;
    const probeCommunications = communicationsByProbe.get(probeId) || [];
    if (probeCommunications.length > 0) probesWithCommunications += 1; else probesWithZeroCommunications += 1;

    try {
      const { grade, intelligencePatch, communicationPatches } = computeProbeIntelligence(probe, probeCommunications, now);

      for (const [communicationId, patch] of communicationPatches) {
        communicationPatchesById.set(communicationId, { ...(communicationPatchesById.get(communicationId) || {}), ...patch });
      }

      const existingRecord = intelligenceByProbe.get(probeId) || null;
      const intelligenceId = existingRecord ? existingRecord.obj.intelligence_id : newIntelligenceId();
      intelligenceUpsertsByProbe.set(probeId, {
        intelligenceId,
        existingRecord,
        patch: existingRecord ? intelligencePatch : { intelligence_id: intelligenceId, ...intelligencePatch, created_at: now.toISOString() },
      });

      results.push({
        probe_id: probeId,
        intelligence_id: intelligenceId,
        grade,
        communications_matched: probeCommunications.length,
      });
    } catch (err) {
      problems.push({ probe_id: probeId, error: err.message || String(err) });
    }
  }

  // 3) BUILD FULLY-FORMED ROWS — merge each patch onto its already-loaded
  // row (or, for new INTELLIGENCE rows, onto an empty row) using the header
  // read in step 1. No sheet access here at all.
  const writes = [];

  for (const [communicationId, patch] of communicationPatchesById) {
    const existing = communicationRowById.get(communicationId);
    if (!existing) continue; // defensive: shouldn't happen, patches only come from loaded rows
    const merged = { ...existing.obj, ...patch };
    const row = communicationsTable.header.map((key) => (merged[key] ?? ''));
    writes.push({ tab: 'COMMUNICATIONS', rowNumber: existing.rowNumber, row });
  }

  // New INTELLIGENCE rows land after the last row already read in step 1 —
  // computed once, up front, from the batch-loaded snapshot (never a re-read).
  let nextIntelligenceRow = intelligenceTable.rows.length + 2;
  let intelligenceCreated = 0;
  let intelligenceUpdated = 0;

  for (const { existingRecord, patch } of intelligenceUpsertsByProbe.values()) {
    let rowNumber;
    let merged;
    if (existingRecord) {
      rowNumber = existingRecord.rowNumber;
      merged = { ...existingRecord.obj, ...patch };
      intelligenceUpdated += 1;
    } else {
      rowNumber = nextIntelligenceRow;
      nextIntelligenceRow += 1;
      merged = patch;
      intelligenceCreated += 1;
    }
    const row = intelligenceTable.header.map((key) => (merged[key] ?? ''));
    writes.push({ tab: 'INTELLIGENCE', rowNumber, row });
  }

  // 4) WRITE — one batched call (chunked only to keep request size sane),
  // zero reads.
  await repo.writeRowsBatch(writes);

  return {
    probes_processed: probeRecords.length,
    probes_with_communications: probesWithCommunications,
    probes_with_zero_communications: probesWithZeroCommunications,
    intelligence_created: intelligenceCreated,
    intelligence_updated: intelligenceUpdated,
    problems,
    results,
  };
}
