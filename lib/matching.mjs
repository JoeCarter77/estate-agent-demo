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
import { extractProbeTag, probeTagFromReference } from './probe-identity.mjs';

// Sender domains that RELAY mail on an agency's behalf: portal autoresponders,
// lead-response services and CRM platforms. Confirmed from real probe traffic.
//
// These must never be used as an agency signal. Their domain belongs to the
// platform, not the agency, so a domain match would either find nothing (fine)
// or — the dangerous case — silently attribute the mail to whichever agency
// happens to use that platform's domain in its own record. When a relay sends
// the mail, the ONLY trustworthy agency signal is the probe address it was
// delivered to.
const RELAY_SENDER_DOMAINS = new Set([
  'rightmove.com',
  'mail.rightmove.co.uk',
  'rightmove.co.uk',
  'send.agentresponse.co.uk',
  'agentresponse.co.uk',
  'apex27.co.uk',
  'zoopla.co.uk',
  'onthemarket.com',
]);

export function isRelayDomain(domain) {
  const d = String(domain ?? '').trim().toLowerCase();
  if (!d) return false;
  if (RELAY_SENDER_DOMAINS.has(d)) return true;
  // Subdomains of a known relay (e.g. "mail1.send.agentresponse.co.uk").
  for (const relay of RELAY_SENDER_DOMAINS) {
    if (d.endsWith(`.${relay}`)) return true;
  }
  return false;
}

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
  // A relay/portal/CRM domain identifies the PLATFORM, not the agency. Refuse
  // to derive an Agency ID from it — the probe address is the only valid
  // signal for relayed mail, and it is applied by the caller before this.
  if (isRelayDomain(senderEmail.domain)) {
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

// STRONGEST email signal, tried BEFORE any sender-based matching.
//
// The probe's own reply address (joe+rm0007@getnovus.co.uk) is carried by the
// message itself, so this identifies the probe — and through it the agency —
// without inferring anything about who sent the mail. That makes it immune to
// the two ways sender matching fails in practice: replies from individual
// mailboxes, and auto-acknowledgements relayed by a portal/CRM.
//
// Matches the tag against BOTH the probe's stored probe_email and its
// probe_reference, so a probe created before plus-addressing existed (blank or
// un-tagged probe_email) still resolves from its reference.
//
// Returns { match_status, matching_method, agency_id, probe_id, match_score }.
// A tag that resolves to no probe, or to more than one, is NOT a match — it is
// never downgraded into a guess.
export async function matchProbeByAddress(repo, ...headerValues) {
  const tag = extractProbeTag(...headerValues);
  const miss = { match_status: 'unmatched', matching_method: '', agency_id: '', probe_id: '', match_score: 0 };
  if (!tag) return miss;

  const probes = await repo.getRecords('PROBES', 'probe_id');
  const hits = probes.filter(({ obj }) => {
    const fromEmail = extractProbeTag(obj.probe_email);
    if (fromEmail && fromEmail === tag) return true;
    return probeTagFromReference(obj.probe_reference) === tag;
  });

  if (hits.length !== 1) {
    // 0 hits: an unknown tag — real evidence, but not ours to attribute.
    // 2+ hits: two probes claim the same tag, which is a data fault, not a
    // coin toss. Both outcomes go to review.
    return hits.length > 1 ? { ...miss, match_status: 'ambiguous' } : miss;
  }

  const probe = hits[0].obj;
  return {
    match_status: 'matched',
    matching_method: 'probe_address_exact',
    agency_id: probe.agency_id || '',
    probe_id: probe.probe_id,
    match_score: 1,
  };
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
