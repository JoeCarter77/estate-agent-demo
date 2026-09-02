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

// CONTACTS.contact_id — one per (agency, email address) outreach contact.
export function newContactId() {
  return newId('cnt');
}

// INTELLIGENCE.intelligence_id — one per probe's Observation & Evidence result.
export function newIntelligenceId() {
  return newId('itl');
}

// DIAGNOSIS.diagnosis_id — one per probe's commercial diagnosis (closed
// observations only).
export function newDiagnosisId() {
  return newId('dgn');
}

// PERSONALISATION.personalisation_id — one per probe's acquisition-story
// narrative, generated once DIAGNOSIS is finalised for that probe.
export function newPersonalisationId() {
  return newId('psn');
}

// DEMOS.demo_id — one per published personalised demo (one row = one demo URL).
export function newDemoId() {
  return newId('dmo');
}

// OUTBOUND.outbound_id — one durable queue identity per agency + probe pair.
export function newOutboundId() {
  return newId('out');
}

// REPLY_EVENTS.reply_event_id — one per received Instantly reply email.
// Note this is NOT the idempotency key: REPLY_EVENTS is de-duplicated on
// instantly_email_id, the external event id (see lib/reply-router.mjs).
export function newReplyEventId() {
  return newId('rpl');
}

// SALES_MESSAGES.sales_message_id — one per sales message NOVUS SENT.
// Inbound stays in REPLY_EVENTS under a rpl_ id; the separate prefix keeps the
// two sides of a conversation impossible to confuse at a glance.
export function newSalesMessageId() {
  return newId('smg');
}
