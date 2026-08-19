// lib/vendor-intent.mjs — deterministic vendor-declaration gate.
//
// V2 (docs/V2_COMMS_INTELLIGENCE_DIAGNOSIS_SCHEMA.md §3): whether the agency
// actually recognised and progressed a declared seller opportunity is now an
// AI judgement — INTELLIGENCE.seller_recognition, read from the real message
// content by lib/probe-interpretation.mjs — because the narrow literal
// phrase-list this module used to carry for that ("free valuation", "market
// appraisal", ...) missed real agency wording ("are you on the market or
// renting?", "confirm your position — sold/selling/nothing to sell?").
//
// What stays deterministic, and stays here: whether the PROBE ITSELF
// declared a property to sell in the first place. That is a fixed marker
// written once at probe creation (api/novus/probe.js), not something to
// interpret — so it is exactly the kind of fact lib/classification.mjs-style
// hard-signal matching is right for, and it is the gate
// lib/probe-interpretation.mjs uses to decide whether seller_recognition is
// even a meaningful question for this probe.

// The exact marker api/novus/probe.js's create action writes for every Rightmove
// probe, also already present on historical imported probes (confirmed
// against the live sheet). Matched loosely on the declaration clause alone
// (not the trailing "not yet on the market" detail) so it still recognises
// the marker if that trailing detail ever varies.
const DECLARATION_PATTERN = /declared:\s*has a property to sell/i;

export function hasVendorDeclaration(probe) {
  return DECLARATION_PATTERN.test(String(probe?.enquiry_text || ''));
}
