// lib/sellerIntent.mjs — narrow, deterministic seller-intent question detector.
//
// Single purpose: does a piece of acknowledgement text ask the recipient
// whether they have a property to sell? Same conservative doctrine as
// lib/classification.mjs's AUTO_ACK_PHRASES: only matches confirmed known
// phrasing, never guesses, never scores confidence. This is NOT a second
// evidence/grading engine — it never touches lib/grading.mjs or
// lib/observation.mjs, and it has no opinion on human_contact, follow-ups,
// or the A-H grade. It exists purely to select Demo OS journey copy
// (lib/demoOs.mjs): whether the demo can truthfully say "your system asked
// whether I had a property to sell" or must say the opposite.
//
// Extend SELLER_INTENT_PHRASES only with confirmed real phrasing seen in
// actual agency auto-replies — do not widen this by guessing what an agency
// "probably" asks.

const SELLER_INTENT_PHRASES = [
  'do you have a property to sell',
  "do you have a property you'd like to sell",
  'do you have a property you are looking to sell',
  'do you have a property you wish to sell',
  'are you looking to sell',
  'are you also looking to sell',
  'thinking of selling',
  'do you have a property to sell or let',
  'is there a property you need to sell',
  'do you need to sell a property',
  'do you have a house to sell',
  'looking to sell a property',
];

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Best-effort: return the sentence in the ORIGINAL (non-normalised) text that
// contains the match, so the demo can quote real wording rather than a
// normalised fragment. Falls back to the whole text if sentence-splitting
// doesn't cleanly isolate it.
function extractSentence(original, normalizedPhrase) {
  const sentences = String(original || '').split(/(?<=[.?!])\s+/).filter(Boolean);
  const hit = sentences.find((s) => normalize(s).includes(normalizedPhrase));
  return (hit || String(original || '')).trim();
}

// text -> { asked: boolean, evidence: string|null }
// asked=false + evidence=null means "no known seller-intent phrasing was
// found in this text" — NOT "we confirmed the agency never asks this".
// Absence of a matched phrase is the safe default; it is never upgraded to
// asked=true without an actual match.
export function detectSellerIntentQuestion(text) {
  const hay = normalize(text);
  if (!hay) return { asked: false, evidence: null };
  for (const phrase of SELLER_INTENT_PHRASES) {
    const normPhrase = normalize(phrase);
    if (hay.includes(normPhrase)) {
      return { asked: true, evidence: extractSentence(text, normPhrase) };
    }
  }
  return { asked: false, evidence: null };
}
