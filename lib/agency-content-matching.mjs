// lib/agency-content-matching.mjs — deterministic, content-based Agency
// identification fallback (email subject/body, SMS body, voicemail
// transcript).
//
// Only ever consulted AFTER deterministic identifier matching (phone/email/
// domain — lib/matching.mjs, lib/phone-matching.mjs) has already returned
// 'unmatched'. Still a deterministic exact-phrase lookup, not fuzzy/AI
// guessing: an agency is matched only when its full registered agency_name
// appears as a whole phrase in the text, and only when exactly one agency's
// name appears. Noisy/garbled content (e.g. an unreliable voicemail
// transcription) simply fails to match anything and is left unmatched for
// manual review — it is never forced.

function normalizeText(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A bare substring match on the agency name is not enough evidence on its
// own — a noisy/garbled voicemail transcription can easily contain the right
// words in the wrong grammatical shape (e.g. "...is some toddlers estate
// agents here..." literally contains "toddlers estate agents" but is not a
// reliable identification). Requiring the name to appear in a genuine
// self-identification frame ("it's X from <Agency>", "calling from
// <Agency>", "this is <Agency>", "at <Agency>") is what separates the
// Kareena example (confident match) from the garbled-transcript example
// (left unmatched) in the NOVUS matching spec.
const IDENTIFICATION_CONNECTORS = ['from', 'calling from', 'this is', 'at'];

// text: free-text evidence (subject+body, SMS body, or voicemail transcript).
// Returns { match_status, matching_method, agency_id, match_score }, the same
// shape as matchAgency/matchAgencyByPhone.
export async function matchAgencyByName(repo, text) {
  const haystack = normalizeText(text);
  if (!haystack) {
    return { match_status: 'unmatched', matching_method: '', agency_id: '', match_score: 0 };
  }

  const agencies = await repo.getRecords('AGENCIES', 'agency_id');
  const matches = new Set();
  for (const { obj } of agencies) {
    const name = normalizeText(obj.agency_name);
    // Require a reasonably specific name (avoid matching on trivially short
    // or blank agency_name values) and the name appearing right after a
    // genuine self-identification connector, not just anywhere in the text.
    if (name.length < 4) continue;
    const escapedName = escapeRegex(name);
    const isIdentified = IDENTIFICATION_CONNECTORS.some((connector) =>
      new RegExp(`\\b${escapeRegex(connector)}\\s+${escapedName}\\b`).test(haystack)
    );
    if (isIdentified) matches.add(obj.agency_id);
  }

  if (matches.size === 1) {
    return { match_status: 'matched', matching_method: 'name_content', agency_id: [...matches][0], match_score: 0.6 };
  }
  if (matches.size > 1) {
    // More than one registered agency name appears in the text: do not guess.
    return { match_status: 'ambiguous', matching_method: '', agency_id: '', match_score: 0 };
  }
  return { match_status: 'unmatched', matching_method: '', agency_id: '', match_score: 0 };
}
