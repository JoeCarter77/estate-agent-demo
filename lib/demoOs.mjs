// lib/demoOs.mjs — the Demo OS adapter.
//
// This is the ONLY seam the customer-facing demo frontend should ever need to
// know about for real NOVUS intelligence. It reads the two sheets the real
// engine already maintains — PROBES (lib/probes create/mark-sent) and
// INTELLIGENCE (lib/observation-recompute.mjs, kept fresh by the comms
// webhooks and/or a manual recompute) — and reshapes them into the small,
// stable Demo OS contract below. It never re-derives observation metrics or
// the grade itself: those are read verbatim from the INTELLIGENCE row that
// lib/observation-recompute.mjs already computed and persisted. See that
// module for the real PROBE -> EVIDENCE -> GRADE pipeline.
//
// Linkage note (architectural gap this module works around, not solves):
// PROBES.agency_id is a real column but nothing in the probe-create flow
// populated it until this milestone — the real long-term identity resolver
// is lib/matching.mjs (matches inbound COMMUNICATIONS to an AGENCIES row by
// email/phone), which is a different identity space from the demo's
// slug-keyed api/_leads.mjs. For the Demo OS to find "the probe for this
// agency slug" at all, api/novus/probe-create.js now accepts an optional
// `slug` and writes it into PROBES.agency_id verbatim. That is a deliberate,
// minimal bridge — NOT a claim that demo slugs and real AGENCIES.agency_id
// are the same identity space. See the milestone report for the follow-up
// this implies.

import { deriveProblem } from './problem.mjs';

// Looks up the most recent PROBES row (and its INTELLIGENCE row, if any)
// linked to this demo slug via PROBES.agency_id. One probe per agency is the
// expectation for this milestone ("ONE OPPORTUNITY") — if more than one
// exists, the most recently created wins.
export async function getProbeIntelligenceForSlug(repo, slug) {
  if (!slug) return { probe: null, intelligence: null };

  const probes = await repo.getRecords('PROBES', 'probe_id');
  const matches = probes.filter((r) => r.obj.agency_id === slug);
  if (!matches.length) return { probe: null, intelligence: null };

  matches.sort((a, b) => new Date(b.obj.created_at || 0) - new Date(a.obj.created_at || 0));
  const probe = matches[0].obj;

  const intelligenceRecords = await repo.getRecords('INTELLIGENCE', 'intelligence_id');
  const intelligenceRecord = intelligenceRecords.find((r) => r.obj.probe_id === probe.probe_id);
  const intelligence = intelligenceRecord ? intelligenceRecord.obj : null;

  return { probe, intelligence };
}

function toNum(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function toBool(v) {
  return v === true || v === 'TRUE' || v === 'true';
}

function splitList(v) {
  return v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : [];
}

// { slug, lead, probe, intelligence } -> Demo OS state (the frontend contract).
// `lead` is the existing api/_leads.mjs record (company/url/town/first_name),
// resolved by the caller exactly as api/lead.js already does — this module
// does not know about LEADS/slug identity, only about the NOVUS engine data.
export function buildDemoOsState({ slug, lead, probe, intelligence }) {
  const agency = {
    id: slug || '',
    slug: slug || '',
    company: lead?.company || '',
    url: lead?.url || '',
    town: lead?.town || '',
    first_name: lead?.first_name || '',
  };

  if (!probe) {
    return {
      agency,
      property: null,
      probe: null,
      evidence: null,
      grade: null,
      problem: { key: null, statement: null },
      journey: { key: 'C1' },
    };
  }

  const property = {
    address: probe.property_address || '',
    url: probe.property_url || '',
    price: probe.property_price || '',
    status: probe.property_status || '',
  };

  const probeOut = {
    id: probe.probe_id || '',
    reference: probe.probe_reference || '',
    timestamp: probe.probe_timestamp || '',
    status: probe.probe_status || '',
  };

  if (!intelligence) {
    // Probe exists but the Observation & Evidence Engine hasn't produced an
    // INTELLIGENCE row for it yet (no communications observed/recomputed) —
    // a genuine "not yet known" state, not an error.
    return {
      agency,
      property,
      probe: probeOut,
      evidence: null,
      grade: { value: 'pending', reason: 'No observation recorded for this probe yet.' },
      problem: { key: null, statement: null },
      journey: { key: 'C1' },
    };
  }

  const evidence = {
    autoAcknowledgement: toBool(intelligence.auto_acknowledgement),
    autoAcknowledgementAt: intelligence.auto_ack_timestamp || '',
    firstHumanTouch: intelligence.first_human_touch || 'no',
    firstHumanTouchAt: intelligence.first_human_touch_at || '',
    humanLagHours: toNum(intelligence.human_lag_hours),
    // contact_attempt_count isn't a persisted INTELLIGENCE column yet (see
    // lib/observation-recompute.mjs) — surfaced as null rather than guessed.
    contactAttempts: toNum(intelligence.contact_attempt_count),
    followUpCount: toNum(intelligence.follow_up_count) ?? 0,
    followUpChannels: splitList(intelligence.follow_up_channels),
    lastTouch: intelligence.last_touch_at || '',
    daysPersisted: toNum(intelligence.days_chased),
    persistenceProfile: intelligence.persistence_profile || '',
    contactQuality: intelligence.contact_quality || '',
  };

  const grade = {
    value: intelligence.grade || 'pending',
    reason: intelligence.grade_reason || '',
  };

  const problem = deriveProblem({ grade: grade.value, evidence });

  return {
    agency,
    property,
    probe: probeOut,
    evidence,
    grade,
    problem,
    journey: { key: 'C1' },
  };
}
