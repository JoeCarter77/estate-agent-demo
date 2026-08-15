// lib/ids.mjs — probe identifier generation.
//
// probe_id        Opaque, globally-unique primary key (never shown to humans).
// probe_reference Human-readable label used in the UI and in conversation.
//
// V1 reference format: "RM-####" (Rightmove portal + zero-padded sequence).
// We intentionally do NOT mint agency-scoped references like "AG-0017-RM-003"
// yet: that requires resolved AGENCIES identity + per-agency probe counting,
// and the NOVUS matching rule forbids guessing an agency id. Agency-scoped
// references arrive with the matching milestone. Until then a simple global
// Rightmove sequence keeps references readable and unique.

const PORTAL_CODE = { rightmove: 'RM', zoopla: 'ZP', onthemarket: 'OTM' };

// Opaque, globally-unique, sortable-ish, collision-resistant id with a prefix
// naming the entity kind (e.g. "prb_", "rev_", "com_").
function newId(prefix) {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${time}_${rand}`;
}

export function newProbeId() {
  // e.g. "prb_lm2x9f_8c1a"
  return newId('prb');
}

// sequence is the count of existing probes (0-based); reference is 1-based.
export function newProbeReference(sequence, portal = 'rightmove') {
  const code = PORTAL_CODE[String(portal).toLowerCase()] || 'RM';
  const n = Math.max(0, Number(sequence) || 0) + 1;
  return `${code}-${String(n).padStart(4, '0')}`;
}

// RAW_EVENTS.raw_event_id — one per provider event delivery (pre-dedup check).
export function newRawEventId() {
  return newId('rev');
}

// COMMUNICATIONS.communication_id — one per meaningful communication.
export function newCommunicationId() {
  return newId('com');
}

// INTELLIGENCE.intelligence_id — one per probe's Observation & Evidence result.
export function newIntelligenceId() {
  return newId('itl');
}

// AGENCIES.agency_id — opaque, permanent identity key. Once assigned to an
// agency it never changes and is never regenerated on a later import.
export function newAgencyId() {
  return newId('ag');
}
