// lib/demo-slug.mjs — compact public demo slug generation.
//
// Public demo URLs deliberately use the short house style already established
// in the live DEMOS sheet: first agency word + a 1–99 identifier, e.g.
//   "Fenn Wright Colchester" -> "fenn-35"
//   "Hair & Son Southend"    -> "hair-08" (existing row preserved)
//
// Existing DEMOS rows keep their stored demo_slug. This helper is only used
// when a new demo needs a slug. The numeric part is deterministic from the
// probe identity so rebuilding a missing row produces the same candidate,
// while collision handling prevents one probe from taking another probe's URL.

function text(value) { return String(value ?? '').trim(); }

export function slugifyDemoWord(value) {
  return text(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function firstAgencyWord(agencyName) {
  const clean = slugifyDemoWord(agencyName);
  return clean.split('-').filter(Boolean)[0] || 'demo';
}

// Small deterministic hash; we only need a stable compact identifier, not
// cryptographic randomness. Returns 1..99 inclusive.
export function demoNumber(seed) {
  const value = text(seed) || 'demo';
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (Math.abs(hash >>> 0) % 99) + 1;
}

export function buildShortDemoSlug({ agencyName, probeReference, probeId }, takenBy = new Map()) {
  const word = firstAgencyWord(agencyName);
  const seed = `${text(probeId)}|${text(probeReference)}|${text(agencyName)}`;
  const start = demoNumber(seed);

  for (let offset = 0; offset < 99; offset += 1) {
    const number = ((start - 1 + offset) % 99) + 1;
    const candidate = `${word}-${number}`;
    const owner = takenBy.get(candidate.toLowerCase());
    if (!owner || owner === probeId) return candidate;
  }

  // Practically unreachable unless all 99 numbers for the same first word are
  // already occupied. Keep the URL compact while remaining unique.
  return `${word}-${start}-${slugifyDemoWord(probeId).slice(-4) || 'x'}`;
}
