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
import { detectSellerIntentQuestion } from './sellerIntent.mjs';

// Looks up the most recent PROBES row (and its INTELLIGENCE row, if any)
// linked to this demo slug via PROBES.agency_id. One probe per agency is the
// expectation for this milestone ("ONE OPPORTUNITY") — if more than one
// exists, the most recently created wins. Also returns every COMMUNICATIONS
// row matched to that probe (sorted by occurred_at) — needed to read the
// ACTUAL automated-acknowledgement text for the C/G seller-ask journey
// (lib/observation.mjs only rolls up whether one exists, not its text).
// Reading raw COMMUNICATIONS text is not a second evidence engine: it never
// recomputes human_contact, follow-ups, or anything lib/observation.mjs /
// lib/grading.mjs already decided — same posture as probe.enquiry_text being
// passed through verbatim below.
export async function getProbeIntelligenceForSlug(repo, slug) {
  if (!slug) return { probe: null, intelligence: null, communications: [] };

  const probes = await repo.getRecords('PROBES', 'probe_id');
  const matches = probes.filter((r) => r.obj.agency_id === slug);
  if (!matches.length) return { probe: null, intelligence: null, communications: [] };

  matches.sort((a, b) => new Date(b.obj.created_at || 0) - new Date(a.obj.created_at || 0));
  const probe = matches[0].obj;

  const intelligenceRecords = await repo.getRecords('INTELLIGENCE', 'intelligence_id');
  const intelligenceRecord = intelligenceRecords.find((r) => r.obj.probe_id === probe.probe_id);
  const intelligence = intelligenceRecord ? intelligenceRecord.obj : null;

  const communications = await getCommunicationsForProbe(repo, probe.probe_id);

  return { probe, intelligence, communications };
}

// Every COMMUNICATIONS row deterministically matched to this probe_id
// (lib/matching.mjs already did the matching; this only reads its output),
// sorted oldest-first by occurred_at. Rows with an unparseable timestamp are
// dropped rather than guessed into an order.
export async function getCommunicationsForProbe(repo, probeId) {
  if (!probeId) return [];
  const records = await repo.getRecords('COMMUNICATIONS', 'communication_id');
  return records
    .map((r) => r.obj)
    .filter((c) => c.probe_id === probeId)
    .map((c) => ({ ...c, _occurredAt: new Date(c.occurred_at) }))
    .filter((c) => !Number.isNaN(c._occurredAt.getTime()))
    .sort((a, b) => a._occurredAt - b._occurredAt)
    .map(({ _occurredAt, ...rest }) => rest);
}

// The earliest COMMUNICATIONS row already classified as an automated
// acknowledgement (lib/classification.mjs / lib/observation-recompute.mjs —
// unchanged, read-only here), plus whether ITS TEXT contains a known
// seller-intent question (lib/sellerIntent.mjs). Returns exists:false when no
// such row is found — never invents one, even for a grade-G probe where an
// acknowledgement is known (from INTELLIGENCE) to exist but its row can't be
// located (e.g. sheet edited by hand) — see deriveJourneyVariant for how that
// safely falls back to no journey rather than a broken one.
export function deriveAcknowledgement(communications) {
  const ackRow = (communications || []).find((c) => c.communication_classification === 'auto_acknowledgement');
  if (!ackRow) return { exists: false, text: null, timestamp: null, sellerAsk: null, sellerAskEvidence: null };

  const text = ackRow.body_text || ackRow.raw_content || ackRow.subject || '';
  const { asked, evidence } = detectSellerIntentQuestion(text);
  return {
    exists: true,
    text: text || null,
    timestamp: ackRow.occurred_at || null,
    sellerAsk: asked,
    sellerAskEvidence: evidence,
  };
}

// A minimal, real-events-only timeline for the demo UI: probe received, the
// automated acknowledgement (if any), the first human touch (if any), and
// any genuine follow-up touches (if any) — each taken verbatim from fields
// this module/observation.mjs already computed. Deliberately does NOT invent
// "— nothing —" placeholder rows: silence between two real events is a
// rendering decision for the frontend (it knows the gap from the two real
// timestamps), not a fabricated data point.
export function deriveTimeline({ probe, evidence, acknowledgement }) {
  const events = [];
  if (probe && probe.probe_timestamp) {
    events.push({ at: probe.probe_timestamp, kind: 'received', label: 'Enquiry received' });
  }
  if (acknowledgement && acknowledgement.exists && acknowledgement.timestamp) {
    events.push({ at: acknowledgement.timestamp, kind: 'auto_ack', label: 'Automated acknowledgement' });
  }
  if (evidence && evidence.firstHumanTouch === 'yes' && evidence.firstHumanTouchAt) {
    events.push({ at: evidence.firstHumanTouchAt, kind: 'human', label: 'Human reply' });
  }
  events.sort((a, b) => new Date(a.at) - new Date(b.at));
  return events;
}

// The one new journey this milestone adds: the C/G seller-ask case. Derived
// deterministically from the OFFICIAL grade (lib/grading.mjs, untouched) and
// whether a real automated-acknowledgement communication was found:
//   - grade must be exactly C ("very fast human response, no genuine
//     follow-up") or G ("automated acknowledgement only, no human contact") —
//     Source Master definitions, not this module's own thresholds.
//   - an acknowledgement communication must actually exist to have anything
//     to reveal — a grade-C probe with a fast human reply but NO automated
//     acknowledgement at all has no premise for this journey and safely
//     returns null (falls back to the plain default hero, same as any other
//     not-yet-covered grade — see the milestone report for why D/E/F/H/A/B
//     intentionally never activate this).
//   - sellerAsk === true -> C_G_SELLER_ASK; otherwise (false OR undetermined)
//     -> C_G_SELLER_NO_ASK. Absence of a matched phrase is never promoted to
//     "asked" — see lib/sellerIntent.mjs.
export function deriveJourneyVariant({ grade, acknowledgement }) {
  if (grade !== 'C' && grade !== 'G') return null;
  if (!acknowledgement || !acknowledgement.exists) return null;
  return acknowledgement.sellerAsk === true ? 'C_G_SELLER_ASK' : 'C_G_SELLER_NO_ASK';
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

// { slug, lead, probe, intelligence, communications } -> Demo OS state (the
// frontend contract). `lead` is the existing api/_leads.mjs record
// (company/url/town/first_name), resolved by the caller exactly as
// api/lead.js already does — this module does not know about LEADS/slug
// identity, only about the NOVUS engine data. `communications` is optional
// (defaults to []) — every existing caller that doesn't pass it still works,
// it just gets acknowledgement.exists = false and journeyVariant = null.
export function buildDemoOsState({ slug, lead, probe, intelligence, communications = [] }) {
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
      acknowledgement: { exists: false, text: null, timestamp: null, sellerAsk: null, sellerAskEvidence: null },
      timeline: [],
      journeyVariant: null,
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
    // Verbatim PROBES.enquiry_text, if ever populated - currently always blank
    // in practice (probe-create.js doesn't capture it; the genuine enquiry is
    // submitted manually outside the system). Never synthesised.
    enquiry: probe.enquiry_text || '',
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
      acknowledgement: { exists: false, text: null, timestamp: null, sellerAsk: null, sellerAskEvidence: null },
      timeline: [],
      journeyVariant: null,
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

  const acknowledgement = deriveAcknowledgement(communications);
  const timeline = deriveTimeline({ probe, evidence, acknowledgement });
  const journeyVariant = deriveJourneyVariant({ grade: grade.value, acknowledgement });

  return {
    agency,
    property,
    probe: probeOut,
    evidence,
    grade,
    problem,
    journey: { key: 'C1' },
    acknowledgement,
    timeline,
    journeyVariant,
  };
}
