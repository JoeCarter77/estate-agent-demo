// lib/normalize.mjs — deterministic normalisation for communication evidence.
//
// Normalisation never destroys the original evidence: callers keep the raw
// value alongside whatever normalised form these helpers return.

// Lowercases + trims an email address and extracts its lowercase domain.
// Returns the trimmed raw value too, so callers don't need to re-derive it.
//
// Also handles an RFC5322-style "Display Name <address>" value (e.g. a raw
// From header some adapters may forward unparsed) by extracting the bare
// address from inside the angle brackets for matching purposes. `raw` always
// keeps the untouched original string — normalisation never destroys evidence.
export function normalizeEmail(raw) {
  const trimmed = String(raw ?? '').trim();
  const angleMatch = trimmed.match(/<([^<>]+)>\s*$/);
  const address = (angleMatch ? angleMatch[1] : trimmed).trim();
  const normalized = address.toLowerCase();
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

// Normalises a phone number for exact-match comparison. The only conversion
// applied is UK national (0...) -> E.164 (+44...) — no other country-code
// guessing. Non-digit characters (spaces, dashes, brackets) are stripped.
export function normalizePhone(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  let digits = trimmed.replace(/[^\d+]/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) digits = '+44' + digits.slice(1);
  if (!digits.startsWith('+')) digits = '+' + digits;
  return digits;
}
