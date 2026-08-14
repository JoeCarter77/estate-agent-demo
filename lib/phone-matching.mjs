// lib/phone-matching.mjs — deterministic Agency + Probe matching for the
// voice/SMS channel (Twilio number +447575333064).
//
// Deliberately a SIBLING to lib/matching.mjs (email matching), not an edit to
// it: existing Agency/Probe matching is protected and must not change. This
// module duplicates the probe-window logic rather than importing it, so the
// protected file's contents and behaviour stay exactly as they are.
//
// Same NOVUS matching rule as email: deterministic only, AI never guesses
// Agency ID or Probe ID. Ambiguous stays ambiguous; unmatched stays unmatched.
// matching_method value is 'phone_exact' — already anticipated in
// lib/matching.mjs's own vocabulary comment, so no new vocabulary introduced.

import { canonicalTimestamp, normalizePhone } from './normalize.mjs';

function splitPhoneList(cell) {
  return String(cell ?? '')
    .split(/[,;\s]+/)
    .map((s) => normalizePhone(s))
    .filter(Boolean);
}

// callerNumber: raw phone string (e.g. Twilio's "From" param).
// Returns { match_status, matching_method, agency_id, match_score }.
export async function matchAgencyByPhone(repo, callerNumber) {
  const normalizedCaller = normalizePhone(callerNumber);
  if (!normalizedCaller) {
    return { match_status: 'unmatched', matching_method: '', agency_id: '', match_score: 0 };
  }

  const agencies = await repo.getRecords('AGENCIES', 'agency_id');
  const matches = new Set();
  for (const { obj } of agencies) {
    const known = [normalizePhone(obj.main_phone), ...splitPhoneList(obj.known_phone_numbers)].filter(Boolean);
    if (known.includes(normalizedCaller)) matches.add(obj.agency_id);
  }

  if (matches.size === 1) {
    return { match_status: 'matched', matching_method: 'phone_exact', agency_id: [...matches][0], match_score: 1 };
  }
  if (matches.size > 1) {
    // Same phone number registered against more than one agency: do not guess.
    return { match_status: 'ambiguous', matching_method: '', agency_id: '', match_score: 0 };
  }
  return { match_status: 'unmatched', matching_method: '', agency_id: '', match_score: 0 };
}

// Only called once an Agency ID is already deterministically known. Same
// observation-window rule as lib/matching.mjs matchProbe.
export async function matchActiveProbe(repo, agencyId, now = new Date()) {
  const probes = await repo.getRecords('PROBES', 'probe_id');
  const nowMs = now.getTime();

  const active = probes.filter(({ obj }) => {
    if (obj.agency_id !== agencyId) return false;
    if (obj.probe_status !== 'observing') return false;
    const sentAt = canonicalTimestamp(obj.probe_timestamp);
    const deadline = canonicalTimestamp(obj.observation_deadline);
    if (!sentAt || !deadline) return false;
    return nowMs >= new Date(sentAt).getTime() && nowMs <= new Date(deadline).getTime();
  });

  if (active.length === 1) return { status: 'matched', probe_id: active[0].obj.probe_id };
  if (active.length > 1) return { status: 'ambiguous', probe_id: '' };
  return { status: 'none', probe_id: '' };
}
