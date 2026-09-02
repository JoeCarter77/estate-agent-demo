// lib/contact-resolution.mjs — NOVUS contact resolution for ONE agency.
//
// Answers: "which single email address should NOVUS send this agency's
// outreach to, and is it deliverable?" — then persists that decision.
//
// Shape of the run, in order:
//   1. DISCOVER   candidates from AGENCIES (primary_contact_email,
//                 other_known_emails) and from genuine human inbound senders
//                 in COMMUNICATIONS. No manual CONTACTS population required.
//   2. IDENTIFY   the owner/decision-maker. Use owner_md when populated;
//                 otherwise use Hunter Domain Search only.
//   3. FIND       an address for that person via lib/hunter.mjs — only when we
//                 know who they are and don't already hold a direct address
//                 for them.
//   4. VERIFY     candidates in priority order with Hunter EMAIL VERIFIER,
//                 STOPPING at the first selectable one. Candidate #2 is only
//                 verified if #1 failed, #3 only if #1 and #2 failed, and at
//                 most MAX_HUNTER_VERIFIER_CALLS_PER_AGENCY calls are ever
//                 spent on one agency. Direct candidates form stage one;
//                 generic stored/Hunter Domain Search candidates form stage
//                 two. Finder/Domain Search metadata is NOT verification.
//   5. PERSIST    every candidate to CONTACTS (idempotent per agency+email)
//                 and the winner back to AGENCIES.
//
// Boundaries this module keeps:
//   - Google Sheets access is ONLY through the existing lib/sheets.mjs repo.
//   - Deliverability is ONLY ever decided by a Hunter EMAIL VERIFIER call, or
//     by a stored result that provably came from one. INVALID/DISPOSABLE are
//     hard rejects; UNKNOWN is not selectable. Accept-all is stored as RISKY;
//     which RISKY wins is ranked by commercial seniority (see
//     verdictForCandidate): VALID owner/senior > RISKY owner/senior > VALID
//     named/probe-responder > RISKY named/probe-responder > VALID generic >
//     RISKY generic. A Finder-sourced senior candidate still needs a
//     Finder confidence score >= 80 to earn the RISKY accept.
//   - Contact resolution imports only Hunter provider code. It cannot invoke
//     owner research, Anthropic, Claude or server-side web search.
//   - Nothing here sends email or touches Instantly.

import { newContactId } from './ids.mjs';
import { normalizeEmail } from './normalize.mjs';
import {
  findDomainDecisionMakers,
  findDomainGenericEmails,
  findEmail,
  verifyEmail,
  isHunterConfigured,
} from './hunter.mjs';

export const HARD_FAIL_STATUSES = new Set(['INVALID', 'DISPOSABLE']);
export const INCONCLUSIVE_STATUSES = new Set(['UNKNOWN', 'RISKY']);

// ── Address classification ───────────────────────────────────────────────────

// Role/shared inboxes. Reaching one of these is a valid outcome, but it is
// always the LAST resort: nobody in particular owns it.
export const GENERIC_LOCAL_PARTS = new Set([
  'info', 'hello', 'sales', 'office', 'admin', 'enquiries', 'enquiry', 'contact',
  'contactus', 'lettings', 'rentals', 'property', 'properties', 'mail', 'email',
  'team', 'reception', 'general', 'help', 'support', 'accounts', 'hi', 'ask',
  'newbusiness', 'valuations', 'marketing', 'branch',
]);

// Senders that are machines, not people. These are never outreach recipients.
const AUTOMATED_LOCAL_PARTS = new Set([
  'noreply', 'no-reply', 'no_reply', 'donotreply', 'do-not-reply', 'do_not_reply',
  'notifications', 'notification', 'notify', 'alerts', 'alert', 'mailer-daemon',
  'mailer_daemon', 'maildaemon', 'postmaster', 'bounce', 'bounces', 'automated',
  'auto', 'autoreply', 'auto-reply', 'system', 'robot', 'bot', 'daemon',
]);

export function emailLocalPart(email) {
  const normalized = normalizeEmail(email).normalized;
  const at = normalized.lastIndexOf('@');
  return at > 0 ? normalized.slice(0, at) : '';
}

export function isGenericEmail(email) {
  const local = emailLocalPart(email);
  if (!local) return false;
  // "sales.london@" / "info-uk@" are still the shared sales/info inbox.
  const head = local.split(/[.\-_+]/)[0];
  return GENERIC_LOCAL_PARTS.has(local) || GENERIC_LOCAL_PARTS.has(head);
}

export function isAutomatedSender(email) {
  const local = emailLocalPart(email);
  if (!local) return true;
  if (AUTOMATED_LOCAL_PARTS.has(local)) return true;
  const collapsed = local.replace(/[.\-_+]/g, '');
  if (AUTOMATED_LOCAL_PARTS.has(collapsed)) return true;
  return /(^|[.\-_])(no.?reply|do.?not.?reply|mailer.?daemon|notifications?)([.\-_]|$)/.test(local);
}

function looksLikeEmail(value) {
  const normalized = normalizeEmail(value).normalized;
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(normalized);
}

// Does `localPart` plausibly belong to `personName`? Deliberately conservative:
// this decides whether an address is treated as the OWNER's direct line, which
// is the top of the waterfall — a false positive there sends outreach to the
// wrong human under the owner's name.
export function nameMatchesLocalPart(personName, localPart) {
  const tokens = String(personName || '')
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z]/g, ''))
    .filter((t) => t.length > 1);
  if (tokens.length === 0 || !localPart) return false;

  const local = String(localPart).toLowerCase().replace(/[^a-z]/g, '');
  const first = tokens[0];
  const last = tokens[tokens.length - 1];

  const forms = new Set([first]);
  if (tokens.length > 1) {
    forms.add(last);
    forms.add(first + last);
    forms.add(last + first);
    forms.add(first[0] + last);
    forms.add(first + last[0]);
    forms.add(last + first[0]);
    forms.add(first[0] + last[0]);
  }
  // A bare forename only counts when it is the whole local part ("james@"),
  // never as a substring — "jameson@" is not James.
  return forms.has(local);
}

// ── Priority ────────────────────────────────────────────────────────────────
//
// The spec's recipient priority, with one sub-tier: a named human we hold an
// address for but who did not respond to the probe sits between a probe
// responder and a generic inbox.
export const PRIORITY = {
  OWNER_DIRECT: 1,
  SENIOR_DIRECT: 2,
  BRANCH_MANAGER: 3,
  PROBE_RESPONDER: 4,
  NAMED_HUMAN: 5,
  GENERIC: 6,
};
const PRIORITY_LABEL = Object.fromEntries(Object.entries(PRIORITY).map(([k, v]) => [v, k]));

// ── Hunter confidence threshold ─────────────────────────────────────────────
//
// Hunter's Email Finder returns a 0-100 confidence score for the address it
// proposes for a named person at a domain. At or above this score we treat the
// address as strongly evidenced for THAT person, which is what earns it the
// caution-accept rule in the waterfall below.
//
// 80 is the explicit NOVUS floor for selecting an accept-all address. It only
// applies to a direct owner/MD/senior contact; generic accept-all addresses
// remain the final fallback and UNKNOWN never qualifies.
//
export const HUNTER_HIGH_CONFIDENCE_SCORE = 80;

function finiteNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function hunterHighConfidenceThreshold() {
  return HUNTER_HIGH_CONFIDENCE_SCORE;
}

function priorityForOwnerRank(rank) {
  if (rank >= 1 && rank <= 3) return PRIORITY.OWNER_DIRECT;
  return PRIORITY.SENIOR_DIRECT;
}

// Preferred Hunter role order. The final tier is allowed only when Hunter has
// itself classified the person as a decision-maker; no title is guessed.
export function rankHunterDecisionMaker(person) {
  const title = String(person?.position || '').trim();
  if (!title) return null;
  if (/\b(branch owner)\b/i.test(title)) return 7;
  if (/\b(owner|proprietor)\b/i.test(title)) return 1;
  if (/\b(co[- ]?founder|founder)\b/i.test(title)) return 2;
  if (/\b(managing director)\b/i.test(title)) return 3;
  if (/\bdirector\b/i.test(title)) return 4;
  if (/\bpartner\b/i.test(title)) return 5;
  if (/\bprincipal\b/i.test(title)) return 6;
  return person?.decision_maker === true ? 8 : null;
}

export function selectHunterDecisionMaker(people) {
  return (Array.isArray(people) ? people : [])
    .map((person, index) => ({ person, index, rank: rankHunterDecisionMaker(person) }))
    .filter(({ person, rank }) => {
      const name = String(person?.full_name || `${person?.first_name || ''} ${person?.last_name || ''}`).trim();
      return rank !== null && name.split(/\s+/).filter(Boolean).length >= 2;
    })
    .sort((a, b) => a.rank - b.rank || (finiteNumber(b.person.confidence) ?? -1) - (finiteNumber(a.person.confidence) ?? -1) || a.index - b.index)
    .map(({ person, rank }) => ({
      ...person,
      full_name: String(person.full_name || `${person.first_name || ''} ${person.last_name || ''}`).trim(),
      role_rank: rank,
    }))[0] || null;
}

const SENIOR_ROLE_RE = /\b(owner|founder|proprietor|managing director|director|partner|principal|ceo)\b/i;
const BRANCH_MANAGER_RE = /\b(branch manager|office manager|sales manager|manager)\b/i;

// ── Candidate discovery ─────────────────────────────────────────────────────

function splitEmailList(cell) {
  return String(cell ?? '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function agencyDomain(agency) {
  const explicit = String(agency?.domain || '').trim().toLowerCase();
  if (explicit) return explicit.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  const website = String(agency?.website || '').trim().toLowerCase();
  if (website) {
    const host = website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    if (host.includes('.')) return host;
  }
  const primary = normalizeEmail(agency?.primary_contact_email).domain;
  return primary || '';
}

// Genuine human inbound email senders for this agency, oldest-first, deduped.
// "Genuine human" is decided by the classification COMMUNICATIONS already
// carries (automated_or_human) plus the local-part machine check — this never
// re-classifies a communication itself.
export function humanInboundSenders(communications, agencyId) {
  const seen = new Set();
  const out = [];
  const rows = communications
    .filter(({ obj }) => obj.agency_id === agencyId)
    .filter(({ obj }) => String(obj.channel || '').trim().toLowerCase() === 'email')
    .filter(({ obj }) => String(obj.direction || '').trim().toLowerCase() === 'inbound')
    .filter(({ obj }) => String(obj.automated_or_human || '').trim().toLowerCase() !== 'automated');

  for (const { obj } of rows) {
    const raw = obj.source_identifier_normalized || obj.source_identifier_raw || '';
    const { normalized } = normalizeEmail(raw);
    if (!looksLikeEmail(normalized)) continue;
    if (isAutomatedSender(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({
      email: normalized,
      display_name: String(obj.display_name || '').trim(),
      occurred_at: String(obj.occurred_at || obj.received_at || '').trim(),
      communication_id: obj.communication_id,
    });
  }
  return out;
}

function makeCandidate({
  email, name = '', role = '', source, priority, reason,
  hunterScore = null, highConfidenceOwner = false,
  hunterVerificationStatus = '', hunterVerificationDate = '', hunterVerificationRaw = null,
}) {
  const normalized = normalizeEmail(email).normalized;
  const generic = isGenericEmail(normalized);
  const effectivePriority = generic ? PRIORITY.GENERIC : priority;
  return {
    email: normalized,
    name: generic ? '' : name,
    role: generic ? 'Generic inbox' : role,
    source,
    type: generic ? 'GENERIC' : 'DIRECT',
    priority: effectivePriority,
    priority_label: PRIORITY_LABEL[effectivePriority],
    hunter_score: hunterScore,
    hunter_verification_status: hunterVerificationStatus,
    hunter_verification_date: hunterVerificationDate,
    hunter_verification_raw: hunterVerificationRaw,
    clearly_senior_direct: !generic && effectivePriority <= PRIORITY.BRANCH_MANAGER,
    // A generic inbox is nobody's direct line, so it can never carry the
    // high-confidence owner status however it was found.
    high_confidence_owner: Boolean(highConfidenceOwner) && !generic,
    reason,
  };
}

// Rebuilds a candidate from a CONTACTS row this agency already has.
//
// WHY CONTACTS IS A DISCOVERY SOURCE. A contact that only ever existed because
// Hunter found it (or because a human typed it into the sheet) is not
// rediscoverable from AGENCIES or COMMUNICATIONS on a later run. Without this,
// a rerun silently loses the very contact an earlier run selected, finds no
// winner, and blanks the agency's outreach fields — which is exactly the bug
// this fixes. The stored row IS evidence; a rerun reconciles it rather than
// pretending it was never found.
//
// Provenance is preserved: email_source stays whatever discovered it
// originally (HUNTER, COMMUNICATIONS, ...), so reruns never rewrite history.
function candidateFromContactRow(obj, { owner, ownerPriority }) {
  const email = normalizeEmail(obj.email).normalized;
  const storedName = String(obj.contact_name || '').trim();
  const storedRole = String(obj.contact_role || '').trim();
  const ownerName = String(owner?.person_name || '').trim();

  // The stored name matching the known owner IS the attribution here — the
  // local part need not look like them (Hunter's brad@ for "Bradley Stanton").
  const isOwner = Boolean(ownerName) && storedName.toLowerCase() === ownerName.toLowerCase();
  let priority = PRIORITY.NAMED_HUMAN;
  if (isOwner) priority = ownerPriority;
  else if (SENIOR_ROLE_RE.test(storedRole)) priority = PRIORITY.SENIOR_DIRECT;
  else if (BRANCH_MANAGER_RE.test(storedRole)) priority = PRIORITY.BRANCH_MANAGER;
  else if (nameMatchesLocalPart(ownerName, emailLocalPart(email))) priority = ownerPriority;

  const storedStatus = String(obj.verification_status || '').trim().toUpperCase();
  const wasSelected = String(obj.is_selected_for_outreach || '').trim().toUpperCase() === 'TRUE';

  const candidate = makeCandidate({
    email,
    name: storedName,
    role: storedRole,
    source: String(obj.email_source || '').trim() || 'CONTACTS',
    priority,
    reason: `Existing CONTACTS row ${obj.contact_id}`,
  });
  candidate.prior_selection = wasSelected && Boolean(storedStatus) && !HARD_FAIL_STATUSES.has(storedStatus);
  candidate.stored_status = storedStatus;
  candidate.stored_verified_at = String(obj.verified_at || '').trim();
  // Did a Hunter Email Verifier call actually produce this stored status?
  // Without that proof the address is re-verified rather than trusted.
  candidate.stored_verifier_proof = hasVerifierProof(obj);
  candidate.contact_id = obj.contact_id;
  return candidate;
}

// Builds the deduplicated, priority-ordered candidate list for one agency.
// `owner` is { person_name, rank } or null — supplied by the caller so this
// stays free of any research/lookup concern. `contacts` are this agency's
// existing CONTACTS records.
export function buildCandidates({ agency, communications, contacts = [], owner }) {
  const ownerName = String(owner?.person_name || '').trim();
  const ownerPriority = owner ? priorityForOwnerRank(owner.rank) : PRIORITY.OWNER_DIRECT;
  const byEmail = new Map();

  const add = (candidate) => {
    if (!looksLikeEmail(candidate.email)) return;
    if (isAutomatedSender(candidate.email)) return;
    const existing = byEmail.get(candidate.email);
    // Deduplicate; keep the strongest claim we have for an address.
    if (!existing) { byEmail.set(candidate.email, candidate); return; }
    // Whichever claim wins on priority, the standing-selection facts from the
    // stored row survive the merge — they are what a rerun reconciles.
    const carried = {
      prior_selection: existing.prior_selection || candidate.prior_selection || false,
      stored_status: existing.stored_status || candidate.stored_status || '',
      stored_verified_at: existing.stored_verified_at || candidate.stored_verified_at || '',
      stored_verifier_proof: existing.stored_verifier_proof || candidate.stored_verifier_proof || false,
      contact_id: existing.contact_id || candidate.contact_id || '',
      hunter_score: existing.hunter_score ?? candidate.hunter_score ?? null,
      high_confidence_owner: existing.high_confidence_owner || candidate.high_confidence_owner || false,
    };
    if (candidate.priority < existing.priority) {
      byEmail.set(candidate.email, { ...candidate, ...carried, reason: `${candidate.reason}; also ${existing.reason}` });
    } else {
      byEmail.set(candidate.email, { ...existing, ...carried });
    }
  };

  // Classifies a known address against the owner we believe in.
  const classifyKnown = ({ email, name, source, reason }) => {
    const local = emailLocalPart(email);
    if (ownerName && nameMatchesLocalPart(ownerName, local)) {
      return makeCandidate({
        email, name: ownerName, role: owner?.role_title || 'Owner / MD',
        source, priority: ownerPriority,
        reason: `${reason}; local part matches known owner/decision-maker`,
      });
    }
    if (name && nameMatchesLocalPart(name, local)) {
      const priority = SENIOR_ROLE_RE.test(name) ? PRIORITY.SENIOR_DIRECT : PRIORITY.NAMED_HUMAN;
      return makeCandidate({ email, name, source, priority, reason: `${reason}; named contact` });
    }
    // The stored name does not match this address's local part (e.g.
    // primary_contact_name "James Hale" against sarah@). The pairing in the
    // sheet is contradicted by the address itself, so the address is kept as
    // an unnamed direct contact rather than sending outreach to one person
    // under another person's name.
    return makeCandidate({
      email, name: '', source, priority: PRIORITY.NAMED_HUMAN,
      reason: name ? `${reason}; stored name does not match this address` : reason,
    });
  };

  const primaryEmail = String(agency?.primary_contact_email || '').trim();
  if (primaryEmail) {
    add(classifyKnown({
      email: primaryEmail,
      // A populated primary_contact_name is NOT evidence that the address is
      // the owner's — that link is only made by nameMatchesLocalPart above.
      name: String(agency?.primary_contact_name || '').trim(),
      source: 'AGENCIES.primary_contact_email',
      reason: 'AGENCIES primary contact email',
    }));
  }

  for (const other of splitEmailList(agency?.other_known_emails)) {
    add(classifyKnown({
      email: other, name: '',
      source: 'AGENCIES.other_known_emails',
      reason: 'AGENCIES other known emails',
    }));
  }

  for (const sender of humanInboundSenders(communications, agency?.agency_id)) {
    const displayName = sender.display_name;
    const local = emailLocalPart(sender.email);
    let priority = PRIORITY.PROBE_RESPONDER;
    let role = 'Responded to probe';
    if (ownerName && nameMatchesLocalPart(ownerName, local)) {
      priority = ownerPriority;
      role = owner?.role_title || 'Owner / MD';
    } else if (displayName && SENIOR_ROLE_RE.test(displayName)) {
      priority = PRIORITY.SENIOR_DIRECT;
      role = displayName;
    } else if (displayName && BRANCH_MANAGER_RE.test(displayName)) {
      priority = PRIORITY.BRANCH_MANAGER;
      role = displayName;
    }
    add(makeCandidate({
      email: sender.email,
      name: (ownerName && nameMatchesLocalPart(ownerName, local)) ? ownerName : displayName,
      role,
      source: 'COMMUNICATIONS',
      priority,
      reason: `Human inbound email sender (${sender.communication_id || 'communication'})`,
    }));
  }

  // Contacts this agency already has. Added last so the live sources above set
  // discovery order for addresses both know about, but never dropped.
  for (const { obj } of contacts) {
    if (obj.agency_id !== agency?.agency_id) continue;
    if (!looksLikeEmail(normalizeEmail(obj.email).normalized)) continue;
    add(candidateFromContactRow(obj, { owner, ownerPriority }));
  }

  return sortCandidates([...byEmail.values()]);
}

// Stable: priority first, then the standing selection (so a rerun reconciles
// the decision already recorded before re-litigating equals), then discovery
// order. A HIGHER-priority candidate still goes first, so a better contact
// discovered since can still displace the incumbent.
export function sortCandidates(candidates) {
  return candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.priority - b.c.priority)
      || (Number(Boolean(b.c.prior_selection)) - Number(Boolean(a.c.prior_selection)))
      || (a.i - b.i))
    .map(({ c }) => c);
}

// ── Verifier proof ──────────────────────────────────────────────────────────
//
// THE BUG THIS FIXES. A CONTACTS row can carry VALID/RISKY/UNKNOWN that no
// Hunter Email Verifier call ever produced — written from Finder metadata, or
// copied forward from another row that was itself never verified. Reusing such
// a status is how an address ends up "verified" without anybody checking it.
//
// So a stored status is only reusable when the row carries PROOF that the
// verifier itself produced it. The proof lives in the existing CONTACTS.notes
// column (no schema change to a live workbook): a marker this module writes
// only after a real, successful verifyEmail() call. A row without the marker is
// re-verified on the next run.
//
// A `verification_provider` / `verification_source` column is honoured too, if
// the workbook ever grows one, so proof is not tied to free text forever.
const VERIFIER_PROOF_RE = /\[hunter_verifier:[^\]]*\]/i;

export function verifierProofNote(status, verifiedAt) {
  return `[hunter_verifier:${String(status || 'UNKNOWN').toUpperCase()}@${verifiedAt || ''}]`;
}

export function extractVerifierProofNote(notes) {
  const match = String(notes || '').match(VERIFIER_PROOF_RE);
  return match ? match[0] : '';
}

// True only when this CONTACTS row's stored verification_status demonstrably
// came from a Hunter Email Verifier call.
export function hasVerifierProof(obj) {
  const provider = String(obj?.verification_provider || obj?.verification_source || '')
    .trim().toUpperCase();
  if (provider === 'HUNTER_VERIFIER') return true;
  return VERIFIER_PROOF_RE.test(String(obj?.notes || ''));
}

// ── Stored verification reuse ───────────────────────────────────────────────

const VERIFICATION_TTL_DAYS = 30;

// email -> { verification_status, verified_at } from CONTACTS, most recent
// first, ignoring anything older than the TTL. Deliberately workbook-wide: the
// same address can appear against more than one agency, and Hunter verification
// credits are the thing being conserved.
//
// Only rows carrying verifier proof are cached: an unproven status is not a
// verification result and must never save a call.
export function buildVerificationCache(contactRecords, { ttlDays = VERIFICATION_TTL_DAYS, now = Date.now() } = {}) {
  const cache = new Map();
  const cutoff = now - ttlDays * 24 * 60 * 60 * 1000;
  for (const { obj } of contactRecords) {
    const email = normalizeEmail(obj.email).normalized;
    const status = String(obj.verification_status || '').trim().toUpperCase();
    if (!email || !status) continue;
    if (!hasVerifierProof(obj)) continue;
    const verifiedAt = Date.parse(obj.verified_at || '');
    if (!Number.isFinite(verifiedAt) || verifiedAt < cutoff) continue;
    const existing = cache.get(email);
    if (existing && existing.verified_at_ms >= verifiedAt) continue;
    cache.set(email, { verification_status: status, verified_at: obj.verified_at, verified_at_ms: verifiedAt });
  }
  return cache;
}

// ── The waterfall ───────────────────────────────────────────────────────────

// Decides what a verification verdict means FOR THIS CANDIDATE. Returns
// 'SELECT' (take it and stop), 'REJECT' (never selectable, move on) or
// 'CONTINUE' (not good enough on its own, try the next candidate).
//
// FINAL-WINNER RANKING POLICY. Because the waterfall already verifies
// candidates in priority order (owner/senior/branch-manager, then
// probe-responder/named-human, then generic last) and stops at the first
// SELECT, making every genuinely identified contact selectable on RISKY —
// not just a Finder-scored senior one — is what makes commercial seniority
// win over a weaker/shared inbox reached later:
//
//   1. VALID  owner/MD/direct senior contact
//   2. RISKY  owner/MD/direct senior contact
//   3. VALID  named human / probe responder
//   4. RISKY  named human / probe responder
//   5. VALID  generic inbox
//   6. RISKY  generic inbox
//
// ACCEPT-ALL RULE. A RISKY generic inbox is always selectable — it is the
// final priority tier, there is nothing left to prefer it over. A RISKY
// identified contact (owner/senior/branch-manager/probe-responder/named
// human) is selectable UNLESS it was found by a live Hunter Finder or Domain
// Search call this run: Hunter carries its own confidence that
// this specific address belongs to that specific person, and a missing or
// weak (< threshold) score means Hunter itself is not sure — so it still
// requires a clearly senior/direct match at or above the threshold, exactly
// as before. A contact discovered directly from AGENCIES/COMMUNICATIONS/
// CONTACTS has no such attribution score to weigh: its identity was already
// decided by the (deliberately conservative) name/role matching that
// classified it, so it needs no further gate. UNKNOWN is never a new
// selection.
export function verdictForCandidate(candidate, status, score = candidate.hunter_score, threshold = HUNTER_HIGH_CONFIDENCE_SCORE) {
  if (HARD_FAIL_STATUSES.has(status)) return 'REJECT';
  if (status === 'VALID') return 'SELECT';
  if (status === 'RISKY') {
    if (candidate.type === 'GENERIC') return 'SELECT';
    if (candidate.source === 'HUNTER' || candidate.source === 'HUNTER_DOMAIN_SEARCH') {
      // Hunter scored this specific attribution this run: only a
      // strong (>= threshold) match on a senior/direct contact earns the
      // accept-all caution rule. A missing score is never high confidence.
      const numericScore = finiteNumber(score);
      if (candidate.clearly_senior_direct && numericScore !== null && numericScore >= threshold) return 'SELECT';
    } else if (candidate.priority <= PRIORITY.NAMED_HUMAN) {
      // Discovered directly from AGENCIES/COMMUNICATIONS/CONTACTS: no Hunter
      // confidence score to weigh — identity was already decided by the
      // (deliberately conservative) name/role matching that classified it —
      // so a genuinely identified, non-generic contact outranks the generic
      // fallback tier without a further gate.
      return 'SELECT';
    }
  }
  // A selection an earlier run already made and recorded in CONTACTS is
  // reconciled, not re-litigated. This preserves idempotency without treating
  // UNKNOWN as a newly valid result.
  if (candidate.prior_selection && INCONCLUSIVE_STATUSES.has(status)) return 'SELECT';
  return 'CONTINUE';
}

// Set on the winner when it was selected on an inconclusive verdict, so every
// downstream write can say so.
function cautionFor(candidate, status, score = candidate.hunter_score) {
  if (status === 'VALID') return '';
  if (!INCONCLUSIVE_STATUSES.has(status)) return '';
  const basis = candidate.prior_selection
    ? 'reconciled standing selection from CONTACTS'
    : candidate.type === 'GENERIC'
      ? 'generic fallback after all direct candidates were exhausted'
      : candidate.clearly_senior_direct
        ? `clearly senior direct contact${score === null || score === undefined ? '' : ` (Hunter score ${score})`}`
        : 'named/identified contact ranked above the generic fallback';
  return `Selected on a ${status} Hunter result: ${basis} — NOT fully verified.`;
}

// HARD CAP on Hunter Email Verifier calls for ONE agency. Candidate #2 is only
// verified if #1 failed and #3 only if #1 and #2 failed, so this is also the
// depth of the waterfall's paid section: past it, remaining candidates fall
// through to the existing UNKNOWN handling rather than spending a fourth call.
export const MAX_HUNTER_VERIFIER_CALLS_PER_AGENCY = 3;

// Verifies candidates in order and STOPS at the first selectable one. Anything
// after a winner is left unverified — that is the whole point of the sequence,
// and the reason the caution rule above matters: without it we keep paying for
// checks after the best contact we will ever have has already answered.
//
// Every new verdict comes from an EXPLICIT Hunter Email Verifier call on that
// candidate, made BEFORE it can be selected. Hunter Finder may still find the
// address, but its embedded verification metadata is not a verification: a
// Finder hit is verified like any other candidate. The only calls skipped are
// results that provably came from the verifier already (this run's cache, or a
// stored CONTACTS result carrying verifier proof).
export async function runVerificationWaterfall(candidates, {
  cache, verifyEmailImpl, now, riskyScoreThreshold = HUNTER_HIGH_CONFIDENCE_SCORE,
  maxVerifierCalls = MAX_HUNTER_VERIFIER_CALLS_PER_AGENCY,
}) {
  const attempts = [];
  let winner = null;
  let verifierCallsMade = 0;

  // The accept-all rule is scored on the verifier's own score when it gave one,
  // otherwise on Hunter Finder's confidence for that person.
  const scoreFor = (candidate, score) => (finiteNumber(score) === null ? candidate.hunter_score : score);

  const accept = (candidate, attempt) => {
    const score = scoreFor(candidate, attempt.verification_score);
    attempt.caution = cautionFor(candidate, attempt.verification_status, score);
    attempt.selected_on_caution = Boolean(attempt.caution);
    winner = { candidate, attempt };
  };

  // Records an attempt, then reports whether it wins. Returns true to stop.
  //
  // The verdict is gated on candidate.hunter_score (Finder's own person-match
  // confidence for a Finder-sourced candidate, null for everything else) —
  // deliberately NOT the verifier's own returned score, which is a
  // deliverability signal, not an attribution one, and must not gate whether
  // an already-identified direct/named contact can be selected.
  const consider = (candidate, attempt) => {
    attempts.push(attempt);
    if (verdictForCandidate(candidate, attempt.verification_status, candidate.hunter_score, riskyScoreThreshold) === 'SELECT') {
      accept(candidate, attempt);
      return true;
    }
    return false;
  };

  for (const candidate of candidates) {
    // A standing selection carries its own stored verdict. Honour it without a
    // Hunter call even if it is older than the cache TTL — but ONLY when that
    // stored verdict provably came from the verifier. This run is reconciling a
    // decision, not making a new one; an unproven status is not a decision.
    if (candidate.prior_selection && candidate.stored_status && candidate.stored_verifier_proof) {
      const attempt = {
        email: candidate.email,
        priority_label: candidate.priority_label,
        verification_status: candidate.stored_status,
        verified_at: candidate.stored_verified_at,
        cached: true,
        reconciled: true,
        hunter_verifier_called: false,
        verifier_proof: true,
        verification_provider: 'CONTACTS',
      };
      if (consider(candidate, attempt)) break;
      continue;
    }

    // Only proven verifier results ever reach this cache (buildVerificationCache
    // filters on proof), so a hit is a real verification, just not a new one.
    const cached = cache.get(candidate.email);
    if (cached) {
      const attempt = {
        email: candidate.email,
        priority_label: candidate.priority_label,
        verification_status: cached.verification_status,
        verification_score: cached.verification_score ?? null,
        verified_at: cached.verified_at,
        cached: true,
        hunter_verifier_called: false,
        verifier_proof: true,
        verification_provider: 'HUNTER_VERIFIER_CACHE',
      };
      // A stored verdict gets exactly the same treatment as a fresh one — the
      // caution rule is about the verdict, not about who paid for it.
      if (consider(candidate, attempt)) break;
      continue;
    }

    // Past the hard cap we stop paying. Nothing was checked, so nothing is
    // claimed: the candidate falls through the existing UNKNOWN handling and is
    // only selectable as a standing selection being reconciled. A row that
    // already holds a status keeps it (and stays unproven, so the next run
    // re-verifies it) rather than being overwritten with a verdict nobody gave.
    if (verifierCallsMade >= maxVerifierCalls) {
      const hasStored = Boolean(candidate.stored_status);
      const attempt = {
        email: candidate.email,
        priority_label: candidate.priority_label,
        verification_status: hasStored ? candidate.stored_status : 'UNKNOWN',
        verified_at: hasStored ? candidate.stored_verified_at : '',
        cached: hasStored,
        hunter_verifier_called: false,
        verifier_proof: false,
        verifier_cap_reached: true,
        records_status: hasStored,
        verification_provider: 'NOT_VERIFIED_CAP_REACHED',
      };
      if (consider(candidate, attempt)) break;
      continue;
    }

    // The explicit Hunter Email Verifier call, before this candidate can be
    // selected.
    let status = 'UNKNOWN';
    let score = null;
    let error = null;
    let raw = null;
    verifierCallsMade += 1;
    try {
      const result = await verifyEmailImpl(candidate.email);
      status = String(result?.verification_status || 'UNKNOWN').toUpperCase();
      score = result?.score ?? null;
      raw = result?.raw_result ?? null;
    } catch (err) {
      // A provider failure is not a verdict: treat it as UNKNOWN and carry on
      // down the waterfall rather than failing the whole agency. It is also not
      // proof of anything, so the address is re-verified on the next run.
      error = err?.message || String(err);
      status = 'UNKNOWN';
    }
    const verifiedAt = now();
    const attempt = {
      email: candidate.email,
      priority_label: candidate.priority_label,
      verification_status: status,
      verified_at: verifiedAt,
      cached: false,
      hunter_verifier_called: true,
      verifier_proof: !error,
      verification_provider: 'HUNTER_VERIFIER',
      verification_score: score,
      error,
      raw_result: raw,
    };
    // Feed the in-run cache so the same address is never checked twice.
    if (!error) {
      cache.set(candidate.email, {
        verification_status: status, verification_score: score,
        verified_at: verifiedAt, verified_at_ms: Date.parse(verifiedAt),
      });
    }
    if (consider(candidate, attempt)) break;
    // Everything else — INVALID, DISPOSABLE, or an inconclusive verdict on a
    // candidate that has not earned the caution rule — means: try the next one.
  }

  return {
    attempts,
    winner,
    verifier_calls_made: verifierCallsMade,
    verifier_cap: maxVerifierCalls,
    verifier_cap_reached: verifierCallsMade >= maxVerifierCalls,
  };
}

// ── CONTACTS persistence (idempotent per agency + email) ────────────────────

function recordsFromTable(table, idColumn) {
  const idIdx = table.header.indexOf(idColumn);
  return table.rows.flatMap((row, index) => {
    const idValue = idIdx >= 0 ? (row[idIdx] ?? '') : '';
    if (!idValue || idValue === 'SCHEMA NOTE') return [];
    const obj = Object.fromEntries(table.header.map((key, i) => [key, row[i] ?? '']));
    return [{ index, rowNumber: index + 2, obj }];
  });
}

async function persistContacts(repo, {
  agencyId, candidates, attempts, winner, now, contactRecords, contactsTable,
}) {
  const byKey = new Map();
  for (const record of contactRecords) {
    if (record.obj.agency_id !== agencyId) continue;
    byKey.set(normalizeEmail(record.obj.email).normalized, record);
  }
  const attemptByEmail = new Map(attempts.map((a) => [a.email, a]));
  const winnerEmail = winner?.candidate.email || '';
  const written = [];
  const writes = [];
  let appended = 0;
  const rowFor = (obj) => contactsTable.header.map((key) => (obj[key] ?? ''));

  for (const candidate of candidates) {
    const attempt = attemptByEmail.get(candidate.email);
    const isWinner = candidate.email === winnerEmail;
    const record = byKey.get(candidate.email);
    // Proof that Hunter's Email Verifier really produced this row's status —
    // written only for a genuine verifier result, and carried forward untouched
    // for a row this run did not re-check. A row without it is re-verified.
    const carriedProof = record ? extractVerifierProofNote(record.obj.notes) : '';
    // A cap-reached attempt verified nothing, so any proof the row already had
    // is neither created nor destroyed by it.
    const proofNote = attempt
      ? (attempt.verifier_proof
          ? verifierProofNote(attempt.verification_status, attempt.verified_at)
          : (attempt.verifier_cap_reached ? carriedProof : ''))
      : carriedProof;

    const notes = [
      candidate.reason,
      // The selection survives in the row, but so does the fact that the mail
      // server never confirmed the mailbox.
      isWinner && attempt?.caution ? attempt.caution : '',
      attempt?.error ? `verification error: ${attempt.error}` : '',
      proofNote,
    ].filter(Boolean).join(' | ');

    const fields = {
      agency_id: agencyId,
      contact_name: candidate.name || '',
      contact_role: candidate.role || '',
      email: candidate.email,
      email_source: candidate.source,
      contact_type: candidate.type,
      is_selected_for_outreach: isWinner ? 'TRUE' : 'FALSE',
      notes,
      updated_at: now(),
    };
    // Only overwrite a stored verification result when this run produced one.
    // An unverified candidate (past the per-agency verifier cap) produced none.
    if (attempt && attempt.records_status !== false) {
      fields.verification_status = attempt.verification_status;
      fields.verified_at = attempt.verified_at;
    }

    if (record) {
      record.obj = { ...record.obj, ...fields };
      writes.push({ tab: 'CONTACTS', rowNumber: record.rowNumber, row: rowFor(record.obj) });
      written.push({ contact_id: record.obj.contact_id, email: candidate.email, action: 'updated' });
    } else {
      const contactId = newContactId();
      const obj = {
        contact_id: contactId,
        verification_status: '',
        verified_at: '',
        ...fields,
        created_at: now(),
      };
      const recordToAdd = {
        obj,
        rowNumber: contactsTable.allValues.length + appended + 1,
      };
      appended += 1;
      byKey.set(candidate.email, recordToAdd);
      writes.push({ tab: 'CONTACTS', rowNumber: recordToAdd.rowNumber, row: rowFor(obj) });
      written.push({ contact_id: contactId, email: candidate.email, action: 'created' });
    }
  }

  // Exactly one selected contact per agency: stand down any pre-existing row
  // that this run did not choose.
  const candidateEmails = new Set(candidates.map((c) => c.email));
  for (const [email, record] of byKey) {
    if (candidateEmails.has(email)) continue;
    if (String(record.obj.is_selected_for_outreach || '').trim().toUpperCase() !== 'TRUE') continue;
    record.obj = { ...record.obj,
      is_selected_for_outreach: 'FALSE',
      updated_at: now(),
    };
    writes.push({ tab: 'CONTACTS', rowNumber: record.rowNumber, row: rowFor(record.obj) });
    written.push({ contact_id: record.obj.contact_id, email, action: 'deselected' });
  }

  await repo.writeRowsBatch(writes);
  return written;
}

// ── AGENCIES writeback ──────────────────────────────────────────────────────

// Maps a column we want onto the header string the sheet ACTUALLY has.
// repo.updateCell matches header names exactly, so a hand-added column with a
// trailing space, a capital, or a space instead of an underscore silently
// writes nothing. Matching on a normalised form and then passing the sheet's
// own spelling back keeps updateCell's exact-match contract intact while
// surviving how these columns really get added — by hand, in the browser.
export function resolveHeaderName(header, wanted) {
  const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '_');
  const target = norm(wanted);
  return (header || []).find((h) => norm(h) === target) || null;
}

// Cell-level batch writes (not full rows) keep neighbouring formula columns in
// AGENCIES exactly as they are, without re-reading the tab per cell.
//
// Returns { applied, missing_columns }. A column that could not be written is
// reported rather than swallowed: a silent false here is indistinguishable
// from a successful write at the call site, and looks exactly like "the
// resolver isn't writing back".
async function writeAgencyCells(repo, agencyId, patch, { agenciesTable, agencyRecord }) {
  const { header } = agenciesTable;
  const applied = {};
  const missing = [];
  const writes = [];
  for (const [column, value] of Object.entries(patch)) {
    const actualHeader = resolveHeaderName(header, column);
    if (!actualHeader) {
      applied[column] = false;
      missing.push(column);
      continue;
    }
    applied[column] = true;
    writes.push({
      tab: 'AGENCIES',
      rowNumber: agencyRecord.rowNumber,
      columnNumber: header.indexOf(actualHeader) + 1,
      value,
    });
  }
  await repo.writeCellsBatch(writes);
  if (missing.length) {
    console.error('contact resolution: AGENCIES writeback could not write columns', {
      agency_id: agencyId, missing_columns: missing,
    });
  }
  return { applied, missing_columns: missing };
}

// ── Public entry point ──────────────────────────────────────────────────────

export const RESOLUTION_STATUS = {
  RESOLVED_DIRECT: 'RESOLVED_DIRECT',
  RESOLVED_GENERIC: 'RESOLVED_GENERIC',
  NO_VALID_EMAIL: 'NO_VALID_EMAIL',
  NEEDS_RESEARCH: 'NEEDS_RESEARCH',
};

// Resolves ONE agency. Returns the full trace the single-agency test action
// renders; every step is visible so a human can see why a contact was chosen.
export async function resolveAgencyContact(repo, agencyId, {
  verifyEmailImpl = verifyEmail,
  findEmailImpl = findEmail,
  findDomainDecisionMakersImpl = findDomainDecisionMakers,
  findDomainGenericEmailsImpl = findDomainGenericEmails,
  hunterConfigured = isHunterConfigured,
  now = () => new Date().toISOString(),
  dryRun = false,
} = {}) {
  const id = String(agencyId || '').trim();
  if (!id) {
    const err = new Error('agency_id is required');
    err.statusCode = 400;
    throw err;
  }

  // Request-scoped snapshot: each source-of-truth tab is loaded once, then all
  // lookup, candidate processing and persistence planning happens in memory.
  const agenciesTable = await repo.getTable('AGENCIES');
  const agencyRecord = recordsFromTable(agenciesTable, 'agency_id')
    .find((record) => record.obj.agency_id === id) || null;
  if (!agencyRecord) {
    const err = new Error('Agency not found');
    err.statusCode = 404;
    throw err;
  }
  const agency = agencyRecord.obj;
  const domain = agencyDomain(agency);

  // ── 1/2. Owner identity ───────────────────────────────────────────────────
  const storedOwner = String(agency.owner_md || '').trim();
  let owner = storedOwner
    ? { person_name: storedOwner, rank: 1, role_title: 'Owner / MD', source: 'AGENCIES.owner_md' }
    : null;
  let domainDecisionMaker = null;
  let domainSearchAttempted = false;
  let domainSearchError = '';
  if (!owner && domain && hunterConfigured()) {
    domainSearchAttempted = true;
    try {
      domainDecisionMaker = selectHunterDecisionMaker(await findDomainDecisionMakersImpl({ domain }));
      if (domainDecisionMaker) {
        owner = {
          person_name: domainDecisionMaker.full_name,
          rank: domainDecisionMaker.role_rank,
          role_title: domainDecisionMaker.position,
          source: 'HUNTER_DOMAIN_SEARCH',
        };
      }
    } catch (err) {
      domainSearchError = err?.message || String(err);
    }
  }

  // ── 3. Candidates ─────────────────────────────────────────────────────────
  const [communicationsTable, contactsTable] = await Promise.all([
    repo.getTable('COMMUNICATIONS'),
    repo.getTable('CONTACTS'),
  ]);
  const communications = recordsFromTable(communicationsTable, 'communication_id');
  const contactRecords = recordsFromTable(contactsTable, 'contact_id');
  let candidates = buildCandidates({ agency, communications, contacts: contactRecords, owner });
  if (owner && domainDecisionMaker?.email) {
    const score = finiteNumber(domainDecisionMaker.confidence);
    const priority = priorityForOwnerRank(owner.rank);
    candidates = sortCandidates([
      ...candidates.filter((candidate) => candidate.email !== domainDecisionMaker.email),
      makeCandidate({
        email: domainDecisionMaker.email,
        name: owner.person_name,
        role: owner.role_title,
        source: 'HUNTER_DOMAIN_SEARCH',
        priority,
        hunterScore: score,
        highConfidenceOwner: score !== null && score >= hunterHighConfidenceThreshold(),
        hunterVerificationStatus: domainDecisionMaker.verification_status || 'UNKNOWN',
        hunterVerificationDate: domainDecisionMaker.verification_date || '',
        hunterVerificationRaw: domainDecisionMaker.raw_result || null,
        reason: `Hunter domain search decision-maker for ${domain}`,
      }),
    ]);
  }

  // ── 4. Hunter FINDER: only when we know the person and lack a direct line to
  // them. Finder discovers an address and scores how strongly it is evidenced
  // for that person; it never decides deliverability. Whatever verification
  // metadata it returns is carried for debugging only — the address goes into
  // the waterfall below and is checked by the Email Verifier like any other.
  const ownerPriority = owner ? priorityForOwnerRank(owner.rank) : null;
  const haveOwnerDirect = Boolean(owner) && candidates.some(
    (c) => c.type === 'DIRECT' && (c.source === 'HUNTER_DOMAIN_SEARCH'
      || nameMatchesLocalPart(owner.person_name, emailLocalPart(c.email))),
  );
  const threshold = hunterHighConfidenceThreshold();
  const hunter = {
    used: false, attempted: false, reason: '', email: '', error: '',
    high_confidence: false, high_confidence_threshold: threshold, caution_rule_applies: false,
    domain_search: {
      attempted: domainSearchAttempted,
      found: Boolean(domainDecisionMaker),
      error: domainSearchError,
    },
  };

  if (domainDecisionMaker?.email) {
    const score = finiteNumber(domainDecisionMaker.confidence);
    hunter.used = true;
    hunter.email = domainDecisionMaker.email;
    hunter.position = domainDecisionMaker.position;
    hunter.score = score;
    hunter.high_confidence = score !== null && score >= threshold;
    hunter.caution_rule_applies = hunter.high_confidence;
    hunter.reason = 'Hunter Domain Search identified a named decision-maker and address';
  }

  if (owner && !haveOwnerDirect && domain && hunterConfigured()) {
    hunter.attempted = true;
    try {
      const found = await findEmailImpl({ name: owner.person_name, domain });
      if (found?.email) {
        hunter.used = true;
        hunter.email = found.email;
        hunter.score = found.score ?? null;
        hunter.position = found.position || '';
        // Attribution comes from the QUERY, not from the address: Hunter was
        // asked for this specific person at this specific domain, so its answer
        // is by construction that person's address. What the score adds is how
        // strongly it is evidenced — which is why a diminutive local part like
        // brad@ for "Bradley Stanton" still counts, while a weak score does not.
        const score = finiteNumber(found.score);
        hunter.high_confidence = score !== null && score >= threshold;
        hunter.high_confidence_threshold = threshold;
        // Accept-all may be selected only for the clearly identified senior
        // person Hunter was asked to find, never for an unnamed direct address.
        const isSeniorTier = ownerPriority <= PRIORITY.BRANCH_MANAGER;
        hunter.caution_rule_applies = Boolean(hunter.high_confidence && isSeniorTier);
        candidates = sortCandidates([
          ...candidates.filter((c) => c.email !== found.email),
          makeCandidate({
            email: found.email,
            name: owner.person_name,
            role: found.position || owner.role_title || 'Owner / MD',
            source: 'HUNTER',
            priority: ownerPriority,
            hunterScore: score,
            highConfidenceOwner: hunter.caution_rule_applies,
            // Debug/provenance only — NOT a verification result.
            hunterVerificationStatus: found.verification_status || 'UNKNOWN',
            hunterVerificationDate: found.verification_date || '',
            hunterVerificationRaw: found.raw_result || null,
            reason: `Hunter email finder for ${owner.person_name} @ ${domain}`
              + `${score !== null ? ` (score ${score})` : ''}`
              + `${hunter.caution_rule_applies ? '; accept-all-eligible senior direct address' : ''}`,
          }),
        ]);
      } else {
        hunter.reason = 'Hunter had no address for this person at this domain';
      }
    } catch (err) {
      // A Hunter failure must never fail the agency: fall back to whatever we
      // already discovered.
      hunter.error = err?.message || String(err);
      hunter.reason = 'Hunter lookup failed; continued with discovered candidates';
    }
  } else if (owner && !haveOwnerDirect && !domain) {
    hunter.reason = 'No agency domain to search';
  } else if (owner && !haveOwnerDirect && !hunterConfigured()) {
    hunter.reason = 'HUNTER_API_KEY not configured';
  } else if (owner && haveOwnerDirect && !domainDecisionMaker?.email) {
    hunter.reason = 'Already hold a direct address for this person';
  } else if (!owner && domainSearchError) {
    hunter.error = domainSearchError;
    hunter.reason = 'Hunter Domain Search failed; agency left unresolved';
  } else if (!owner && domainSearchAttempted) {
    hunter.reason = 'Hunter Domain Search found no suitable named decision-maker';
  } else if (!owner && !domain) {
    hunter.reason = 'No agency domain to search';
  } else {
    hunter.reason = 'HUNTER_API_KEY not configured';
  }

  // ── 5. Two-stage verification waterfall ───────────────────────────────────
  // Direct contacts always get the first chance. Only when none is selectable
  // do we look for/verify a generic inbox, sharing the same cache and hard cap.
  const cache = buildVerificationCache(contactRecords, { now: Date.parse(now()) || Date.now() });
  const directCandidates = candidates.filter((candidate) => candidate.type === 'DIRECT');
  const directResult = await runVerificationWaterfall(directCandidates, {
    cache, verifyEmailImpl, now, riskyScoreThreshold: threshold,
  });

  let attempts = [...directResult.attempts];
  let winner = directResult.winner;
  let verifierCallsMade = directResult.verifier_calls_made;
  let genericSearchAttempted = false;
  let genericSearchError = '';

  let genericCandidates = candidates.filter((candidate) => candidate.type === 'GENERIC');
  if (!winner && domain && hunterConfigured()) {
    genericSearchAttempted = true;
    try {
      const foundGenerics = await findDomainGenericEmailsImpl({ domain });
      const hunterGenericCandidates = (Array.isArray(foundGenerics) ? foundGenerics : [])
        .filter((entry) => isGenericEmail(entry?.email))
        .map((entry) => makeCandidate({
          email: entry.email,
          source: 'HUNTER_DOMAIN_SEARCH',
          priority: PRIORITY.GENERIC,
          hunterScore: finiteNumber(entry.confidence),
          hunterVerificationStatus: entry.verification_status || 'UNKNOWN',
          hunterVerificationDate: entry.verification_date || '',
          hunterVerificationRaw: entry.raw_result || null,
          reason: `Hunter domain search generic inbox for ${domain}`,
        }));
      candidates = sortCandidates([
        ...candidates,
        ...hunterGenericCandidates.filter((candidate) => !candidates.some((existing) => existing.email === candidate.email)),
      ]);
      genericCandidates = candidates.filter((candidate) => candidate.type === 'GENERIC');
    } catch (err) {
      genericSearchError = err?.message || String(err);
    }
  }

  if (!winner && genericCandidates.length > 0) {
    const genericResult = await runVerificationWaterfall(genericCandidates, {
      cache,
      verifyEmailImpl,
      now,
      riskyScoreThreshold: threshold,
      maxVerifierCalls: Math.max(0, MAX_HUNTER_VERIFIER_CALLS_PER_AGENCY - verifierCallsMade),
    });
    attempts = [...attempts, ...genericResult.attempts];
    winner = genericResult.winner;
    verifierCallsMade += genericResult.verifier_calls_made;
  }

  const verifierCap = MAX_HUNTER_VERIFIER_CALLS_PER_AGENCY;
  const verifierCapReached = verifierCallsMade >= verifierCap;
  hunter.generic_search = {
    attempted: genericSearchAttempted,
    found: genericCandidates.some((candidate) => candidate.source === 'HUNTER_DOMAIN_SEARCH'),
    error: genericSearchError,
  };

  // Debug: exactly what the Email Verifier was asked, and what it answered.
  const verifiedEmails = attempts.filter((a) => a.hunter_verifier_called).map((a) => a.email);
  const verifierResults = attempts.map((a) => ({
    email: a.email,
    verification_status: a.verification_status,
    verification_score: a.verification_score ?? null,
    provider: a.verification_provider,
    hunter_verifier_called: Boolean(a.hunter_verifier_called),
    verifier_proof: Boolean(a.verifier_proof),
    error: a.error || undefined,
  }));
  console.log('contact resolution: hunter verifier', {
    agency_id: id,
    hunter_verifier_calls_made: verifierCallsMade,
    max_hunter_verifier_calls_per_agency: verifierCap,
    hunter_verifier_cap_reached: verifierCapReached,
    emails_verified: verifiedEmails,
    verifier_results: verifierResults,
  });

  // ── 6. Status ─────────────────────────────────────────────────────────────
  let status;
  if (winner) {
    status = winner.candidate.type === 'GENERIC'
      ? RESOLUTION_STATUS.RESOLVED_GENERIC
      : RESOLUTION_STATUS.RESOLVED_DIRECT;
  } else status = RESOLUTION_STATUS.NEEDS_RESEARCH;

  // ── 7. Persist ────────────────────────────────────────────────────────────
  let contactsWritten = [];
  let agencyWriteback = { applied: {}, missing_columns: [] };
  if (!dryRun) {
    contactsWritten = await persistContacts(repo, {
      agencyId: id, candidates, attempts, winner, now, contactRecords, contactsTable,
    });

    const agencyPatch = {
      outreach_contact_name: winner && winner.candidate.type === 'DIRECT' ? (winner.candidate.name || '') : '',
      outreach_contact_email: winner ? winner.candidate.email : '',
      email_verification_status: winner ? winner.attempt.verification_status : '',
      contact_resolution_status: status,
      updated_at: now(),
    };
    agencyWriteback = await writeAgencyCells(repo, id, agencyPatch, { agenciesTable, agencyRecord });
  }

  return {
    agency: {
      agency_id: agency.agency_id,
      agency_name: agency.agency_name || '',
      domain,
      probe_sent: agency.probe_sent || '',
    },
    owner_md: {
      value: owner?.person_name || '',
      role: owner?.role_title || '',
      source: owner?.source || '',
      was_blank: !storedOwner,
      research: null,
    },
    candidates_considered: candidates.map((c) => ({
      email: c.email, name: c.name, role: c.role, source: c.source,
      type: c.type, priority: c.priority, priority_label: c.priority_label,
      hunter_score: c.hunter_score, high_confidence_owner: c.high_confidence_owner,
      hunter_verification_status: c.hunter_verification_status || undefined,
      reason: c.reason,
    })),
    candidates_verified: attempts.map((a) => ({
      email: a.email,
      priority_label: a.priority_label,
      verification_status: a.verification_status,
      cached: a.cached,
      hunter_verifier_called: Boolean(a.hunter_verifier_called),
      verifier_proof: Boolean(a.verifier_proof),
      verification_provider: a.verification_provider,
      verification_score: a.verification_score ?? undefined,
      reconciled: Boolean(a.reconciled),
      selected_on_caution: Boolean(a.selected_on_caution),
      error: a.error || undefined,
    })),
    hunter_verifier: {
      // Debug block: how many Email Verifier calls this agency actually cost,
      // which addresses were really checked, and what each verdict was.
      hunter_verifier_calls_made: verifierCallsMade,
      calls_made: verifierCallsMade,
      max_calls_per_agency: verifierCap,
      cap_reached: verifierCapReached,
      emails_verified: verifiedEmails,
      verifier_results: verifierResults,
      cached_reuses: attempts.filter((a) => a.cached).length,
      results: verifierResults.map((r) => ({
        email: r.email,
        verification_status: r.verification_status,
        verification_score: r.verification_score,
        provider: r.provider,
        cached: attempts.find((a) => a.email === r.email)?.cached ?? false,
      })),
      not_verified_after_winner: candidates
        .filter((c) => !attempts.some((a) => a.email === c.email))
        .map((c) => c.email),
      not_verified_cap_reached: attempts
        .filter((a) => a.verifier_cap_reached)
        .map((a) => a.email),
    },
    hunter,
    selected_contact: winner
      ? {
          contact_name: winner.candidate.type === 'DIRECT' ? winner.candidate.name : '',
          contact_role: winner.candidate.role,
          email: winner.candidate.email,
          email_source: winner.candidate.source,
          contact_type: winner.candidate.type,
          // The REAL verdict, never upgraded to VALID because it was selected.
          verification_status: winner.attempt.verification_status,
          verified_at: winner.attempt.verified_at,
          fully_verified: winner.attempt.verification_status === 'VALID',
          selected_on_caution: Boolean(winner.attempt.selected_on_caution),
          caution: winner.attempt.caution || '',
          hunter_score: winner.candidate.hunter_score,
        }
      : null,
    contact_resolution_status: status,
    contacts_written: contactsWritten,
    agency_writes: agencyWriteback.applied,
    // Non-empty means the four outreach columns are missing/misspelled in the
    // AGENCIES header and nothing was written back.
    agency_writeback_missing_columns: agencyWriteback.missing_columns,
    dry_run: dryRun,
  };
}

// ── Backlog preparation (NOT executed) ──────────────────────────────────────
//
// Everything the later bulk run needs, without running anything: which
// agencies are still unresolved, in sheet order. Call resolveAgencyContact()
// per id when the bulk run is authorised.
//
// requireProbeSent defaults to true, preserving the original behaviour (only
// probed agencies are a backlog) for every existing caller. Passing false
// serves a different, equally real bulk run — every blank-status agency,
// regardless of probe state — without gating on probe_sent at all.
export async function listResolutionBacklog(repo, { includeResolved = false, requireProbeSent = true } = {}) {
  const agencies = await repo.getRecords('AGENCIES', 'agency_id');
  return agencies
    .filter(({ obj }) => !requireProbeSent || String(obj.probe_sent || '').trim().toUpperCase() === 'YES')
    .filter(({ obj }) => includeResolved || !String(obj.contact_resolution_status || '').trim())
    .map(({ obj, rowNumber }) => ({
      sheet_row_number: rowNumber,
      agency_id: obj.agency_id,
      agency_name: obj.agency_name || '',
      contact_resolution_status: String(obj.contact_resolution_status || '').trim(),
      probe_sent: String(obj.probe_sent || '').trim(),
    }));
}

export const _internal = { priorityForOwnerRank, persistContacts, writeAgencyCells, splitEmailList };
