// lib/normalize.mjs — deterministic normalisation for communication evidence.
//
// Normalisation never destroys the original evidence: callers keep the raw
// value alongside whatever normalised form these helpers return.

// Lowercases + trims an email address and extracts its lowercase domain.
// Returns the trimmed raw value too, so callers don't need to re-derive it.
export function normalizeEmail(raw) {
  const trimmed = String(raw ?? '').trim();
  const normalized = trimmed.toLowerCase();
  const at = normalized.lastIndexOf('@');
  const domain = at >= 0 ? normalized.slice(at + 1) : '';
  return { raw: trimmed, normalized, domain };
}

// Parses a timestamp into canonical ISO-8601 (UTC). Returns null if the input
// is missing or unparseable — callers decide the fallback (e.g. server "now"),
// this function never guesses one itself.
export function canonicalTimestamp(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
