// lib/vendor-intent.mjs — deterministic Vendor Opportunity detection.
//
// Separate from, and never feeding into, the A-H grade (lib/grading.mjs).
// A-H measures response speed/persistence to the enquiry generically; this
// module answers a narrower question: for a probe that declared "I have a
// property to sell — it is not yet on the market" (PROBES.enquiry_text, set
// by api/novus/probe-create.js), did the agency's own communications show
// any sign they noticed or acted on that vendor opportunity?
//
// Same conservative posture as lib/classification.mjs: narrow, literal
// phrase lists, human communications only (an auto-ack template is never
// evidence of the agency noticing anything), no AI, no guessing. Extend the
// phrase lists only as real agency wording is confirmed.
//
// Writes to two EXISTING, currently-unused columns — no new schema:
//   COMMUNICATIONS.intent        — per-row tag: 'vendor_progressed' |
//                                   'vendor_discussed' | 'vendor_acknowledged' | ''
//   INTELLIGENCE.ai_evidence_summary — per-probe rollup: status + quoted
//                                   evidence (or the absence of any).

// The exact marker api/novus/probe-create.js writes for every Rightmove
// probe, also already present on historical imported probes (confirmed
// against the live sheet). Matched loosely on the declaration clause alone
// (not the trailing "not yet on the market" detail) so it still recognises
// the marker if that trailing detail ever varies.
const DECLARATION_PATTERN = /declared:\s*has a property to sell/i;

export function hasVendorDeclaration(probe) {
  return DECLARATION_PATTERN.test(String(probe?.enquiry_text || ''));
}

// Priority order matters: checked most-progressed-first so a message that
// both discusses and books a valuation is tagged at the higher tier.
const PROGRESSED_PHRASES = [
  'book a valuation',
  'arrange a valuation',
  'valuation is booked',
  'valuation has been booked',
  'booked you in for a valuation',
  'booked in for your valuation',
  'confirmed for your valuation',
  'confirmed your valuation',
  'see you for the valuation',
  'our valuer will',
  'valuer will call',
  'valuer will visit',
];

const DISCUSSED_PHRASES = [
  'market appraisal',
  'value your property',
  'value your home',
  'valuation of your property',
  'valuation of your home',
  'free valuation',
  'current market value of your property',
  'current value of your property',
];

const ACKNOWLEDGED_PHRASES = [
  'sell your property',
  'sell your home',
  'selling your property',
  'selling your home',
  'thinking of selling',
  'looking to sell',
  'property you have to sell',
  'property to sell',
  'putting your property on the market',
];

function haystackOf(comm) {
  const subject = String(comm.subject || '').toLowerCase();
  const body = String(comm.body_text || comm.raw_content || comm.transcript || '').toLowerCase();
  return `${subject}\n${body}`;
}

function originalTextOf(comm) {
  return String(comm.body_text || comm.raw_content || comm.transcript || comm.subject || '');
}

// Returns a ~140-char window of the ORIGINAL-cased text around the matched
// phrase, so the stored evidence reads as a real quote, not the lowercased
// haystack used for matching.
function extractSnippet(originalText, phrase) {
  const idx = originalText.toLowerCase().indexOf(phrase);
  if (idx === -1) return originalText.slice(0, 140).trim();
  const start = Math.max(0, idx - 50);
  const end = Math.min(originalText.length, idx + phrase.length + 50);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < originalText.length ? '…' : '';
  return `${prefix}${originalText.slice(start, end).trim()}${suffix}`;
}

function firstMatch(haystack, phrases) {
  return phrases.find((p) => haystack.includes(p)) || null;
}

// One communication -> { tag, phrase, snippet } | null.
// tag: 'vendor_progressed' | 'vendor_discussed' | 'vendor_acknowledged'.
export function classifyVendorCommunication(comm) {
  const haystack = haystackOf(comm);
  const original = originalTextOf(comm);

  const progressed = firstMatch(haystack, PROGRESSED_PHRASES);
  if (progressed) return { tag: 'vendor_progressed', phrase: progressed, snippet: extractSnippet(original, progressed) };

  const discussed = firstMatch(haystack, DISCUSSED_PHRASES);
  if (discussed) return { tag: 'vendor_discussed', phrase: discussed, snippet: extractSnippet(original, discussed) };

  const acknowledged = firstMatch(haystack, ACKNOWLEDGED_PHRASES);
  if (acknowledged) return { tag: 'vendor_acknowledged', phrase: acknowledged, snippet: extractSnippet(original, acknowledged) };

  return null;
}

const TAG_RANK = { vendor_progressed: 3, vendor_discussed: 2, vendor_acknowledged: 1 };
const STATUS_LABEL = { vendor_progressed: 'progressed', vendor_discussed: 'discussed', vendor_acknowledged: 'acknowledged' };

function toBool(v) { return v === true || v === 'TRUE' || v === 'true'; }
function isOverridden(comm) { return comm.manual_override === 'TRUE' || comm.manual_override === true; }

// probe: PROBES row. communications: already-classified COMMUNICATIONS rows
// for this probe (human_contact/automated_or_human already tagged by
// lib/classification.mjs), any order.
//
// Returns null when the probe never declared a vendor opportunity (nothing
// to check). Otherwise returns:
//   { commPatches: Map(communication_id -> { intent }),
//     ai_evidence_summary: string }
// commPatches only contains rows that matched a vendor phrase and are not
// manually overridden — callers merge this into whatever COMMUNICATIONS
// patch map they already maintain, same convention as classification tags.
export function computeVendorOpportunity(probe, communications) {
  if (!hasVendorDeclaration(probe)) return null;

  const humanComms = communications
    .filter((c) => toBool(c.human_contact))
    .map((c) => ({ ...c, _occurredAt: new Date(c.occurred_at) }))
    .filter((c) => !Number.isNaN(c._occurredAt.getTime()))
    .sort((a, b) => a._occurredAt - b._occurredAt);

  const commPatches = new Map();
  const matches = []; // { comm, tag, phrase, snippet }

  for (const comm of humanComms) {
    if (isOverridden(comm)) continue;
    const result = classifyVendorCommunication(comm);
    if (!result) continue;
    commPatches.set(comm.communication_id, { intent: result.tag });
    matches.push({ comm, ...result });
  }

  if (matches.length === 0) {
    const reviewed = humanComms.length;
    const ai_evidence_summary = reviewed > 0
      ? `Vendor opportunity: no_evidence. ${reviewed} human communication(s) reviewed; none referenced the declared vendor opportunity or a valuation.`
      : 'Vendor opportunity: no_evidence. No human communications observed to assess.';
    return { commPatches, ai_evidence_summary };
  }

  // Highest tier reached; earliest communication at that tier for a stable,
  // reproducible evidence quote.
  const best = matches.reduce((top, m) => (TAG_RANK[m.tag] > TAG_RANK[top.tag] ? m : top), matches[0]);
  const status = STATUS_LABEL[best.tag];
  const ai_evidence_summary =
    `Vendor opportunity: ${status}. ${humanComms.length} human communication(s) reviewed. ` +
    `Evidence: "${best.snippet}" (${best.comm.channel || 'unknown channel'}, ${best.comm.occurred_at || 'unknown time'}).`;

  return { commPatches, ai_evidence_summary };
}
