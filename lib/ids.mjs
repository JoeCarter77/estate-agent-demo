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

export function newProbeId() {
  // e.g. "prb_lm2x9f_8c1a" — sortable-ish, collision-resistant, opaque.
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `prb_${time}_${rand}`;
}

// sequence is the count of existing probes (0-based); reference is 1-based.
export function newProbeReference(sequence, portal = 'rightmove') {
  const code = PORTAL_CODE[String(portal).toLowerCase()] || 'RM';
  const n = Math.max(0, Number(sequence) || 0) + 1;
  return `${code}-${String(n).padStart(4, '0')}`;
}
