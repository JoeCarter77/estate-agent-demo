// lib/matching.mjs — deterministic Agency + Probe matching (email channel).
//
// NOVUS rule: deterministic matching happens before AI, and AI must never
// guess Agency ID or Probe ID. This module contains ONLY exact-signal lookups
// against AGENCIES/PROBES via the existing repo — no fuzzy matching, no
// scoring heuristics, no AI calls. An ambiguous result stays ambiguous; an
// unmatched result stays unmatched. Nothing here writes to the workbook.
//
// match_status / matching_method values are the literals already defined in
// the live CONFIG tab (matched/ambiguous/unmatched; email_exact/domain_exact/
// probe_exact/phone_exact/manual) — no new vocabulary is introduced.

import { canonicalTimestamp } from './normalize.mjs';

function splitEmailList(cell) {
  return String(cell ?? '')
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// senderEmail: the { normalized, domain } shape returned by normalizeEmail().
// Returns { match_status, matching_method, agency_id, match_score }.
export async function matchAgency(repo, senderEmail) {
  const agencies = await repo.getRecords('AGENCIES', 'agency_id');

  // 1) Exact known email. Checks primary_contact_email + other_known_emails.
  const emailMatches = new Set();
  for (const { obj } of agencies) {
    const known = [
      String(obj.primary_contact_email ?? '').trim().toLowerCase(),
      ...splitEmailList(obj.other_known_emails),
    ].filter(Boolean);
    if (known.includes(senderEmail.normalized)) emailMatches.add(obj.agency_id);
  }
  if (emailMatches.size === 1) {
    return { match_status: 'matched', matching_method: 'email_exact', agency_id: [...emailMatches][0], match_score: 1 };
  }
  if (emailMatches.size > 1) {
    // Same email address registered against more than one agency: do not guess.
    return { match_status: 'ambiguous', matching_method: '', agency_id: '', match_score: 0 };
  }

  // 2) Exact domain, only if it maps uniquely to one agency.
  if (!senderEmail.domain) {
    return { match_status: 'unmatched', matching_method: '', agency_id: '', match_score: 0 };
  }
  const domainMatches = new Set();
  for (const { obj } of agencies) {
    const domain = String(obj.domain ?? '').trim().toLowerCase();
    if (domain && domain === senderEmail.domain) domainMatches.add(obj.agency_id);
  }
  if (domainMatches.size === 1) {
    return { match_status: 'matched', matching_method: 'domain_exact', agency_id: [...domainMatches][0], match_score: 1 };
  }
  if (domainMatches.size > 1) {
    return { match_status: 'ambiguous', matching_method: '', agency_id: '', match_score: 0 };
  }

  // 3) No deterministic match — never handed to AI to guess.
  return { match_status: 'unmatched', matching_method: '', agency_id: '', match_score: 0 };
}

// Only called once an Agency ID is already deterministically known. Matches
// against PROBES rows for that agency that are currently in their observation
// window (probe_status = "observing" and now within [probe_timestamp,
// observation_deadline]). Returns { status: 'matched'|'ambiguous'|'none', probe_id }.
export async function matchProbe(repo, agencyId, now = new Date()) {
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
