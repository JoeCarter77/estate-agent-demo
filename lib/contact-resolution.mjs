// lib/contact-resolution.mjs — NOVUS contact resolution for ONE agency.
//
// Answers: "which single email address should NOVUS send this agency's
// outreach to, and is it deliverable?" — then persists that decision.
//
// Shape of the run, in order:
//   1. DISCOVER   candidates from AGENCIES (primary_contact_email,
//                 other_known_emails) and from genuine human inbound senders
//                 in COMMUNICATIONS. No manual CONTACTS population required.
//   2. IDENTIFY   the owner. owner_md when populated; otherwise
//                 lib/owner-research.mjs (web research, evidence-gated).
//   3. FIND       an address for that person via lib/hunter.mjs — only when we
//                 know who they are and don't already hold a direct address
//                 for them.
//   4. VERIFY     candidates in priority order via lib/neverbounce.mjs's
//                 verifyEmail(), STOPPING at the first VALID one. Lower
//                 priority candidates after a winner are never verified.
//   5. PERSIST    every candidate to CONTACTS (idempotent per agency+email)
//                 and the winner back to AGENCIES.
//
// Boundaries this module keeps:
//   - Google Sheets access is ONLY through the existing lib/sheets.mjs repo.
//   - Deliverability is ONLY ever decided by verifyEmail(). Hunter finds; it
//     never verifies.
//   - WHO the owner is lives in lib/owner-research.mjs, not here, so the
//     research strategy can be improved without touching this waterfall.
//   - Nothing here sends email or touches Instantly.

import { newContactId } from './ids.mjs';
import { normalizeEmail } from './normalize.mjs';
import { verifyEmail } from './neverbounce.mjs';
import { findEmail, isHunterConfigured } from './hunter.mjs';
import { researchOwner } from './owner-research.mjs';

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

// Maps lib/owner-research.mjs's seniority rank onto this waterfall.
function priorityForOwnerRank(rank) {
  if (rank === 1 || rank === 2) return PRIORITY.OWNER_DIRECT; // Owner/Founder/MD
  if (rank === 3) return PRIORITY.SENIOR_DIRECT;              // Director/Partner
  return PRIORITY.BRANCH_MANAGER;
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

function makeCandidate({ email, name = '', role = '', source, priority, reason }) {
  const normalized = normalizeEmail(email).normalized;
  const generic = isGenericEmail(normalized);
  return {
    email: normalized,
    name: generic ? '' : name,
    role: generic ? 'Generic inbox' : role,
    source,
    type: generic ? 'GENERIC' : 'DIRECT',
    priority: generic ? PRIORITY.GENERIC : priority,
    priority_label: PRIORITY_LABEL[generic ? PRIORITY.GENERIC : priority],
    reason,
  };
}

// Builds the deduplicated, priority-ordered candidate list for one agency.
// `owner` is { person_name, rank } or null — supplied by the caller so this
// stays free of any research/lookup concern.
export function buildCandidates({ agency, communications, owner }) {
  const ownerName = String(owner?.person_name || '').trim();
  const ownerPriority = owner ? priorityForOwnerRank(owner.rank) : PRIORITY.OWNER_DIRECT;
  const byEmail = new Map();

  const add = (candidate) => {
    if (!looksLikeEmail(candidate.email)) return;
    if (isAutomatedSender(candidate.email)) return;
    const existing = byEmail.get(candidate.email);
    // Deduplicate; keep the strongest claim we have for an address.
    if (!existing) { byEmail.set(candidate.email, candidate); return; }
    if (candidate.priority < existing.priority) {
      byEmail.set(candidate.email, { ...candidate, reason: `${candidate.reason}; also ${existing.reason}` });
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

  return sortCandidates([...byEmail.values()]);
}

// Stable: priority first, discovery order within a priority.
export function sortCandidates(candidates) {
  return candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.priority - b.c.priority) || (a.i - b.i))
    .map(({ c }) => c);
}

// ── Stored verification reuse ───────────────────────────────────────────────

const VERIFICATION_TTL_DAYS = 30;

// email -> { verification_status, verified_at } from CONTACTS, most recent
// first, ignoring anything older than the TTL. Deliberately workbook-wide: the
// same address can appear against more than one agency, and NeverBounce credits
// are the thing being conserved.
export function buildVerificationCache(contactRecords, { ttlDays = VERIFICATION_TTL_DAYS, now = Date.now() } = {}) {
  const cache = new Map();
  const cutoff = now - ttlDays * 24 * 60 * 60 * 1000;
  for (const { obj } of contactRecords) {
    const email = normalizeEmail(obj.email).normalized;
    const status = String(obj.verification_status || '').trim().toUpperCase();
    if (!email || !status) continue;
    const verifiedAt = Date.parse(obj.verified_at || '');
    if (!Number.isFinite(verifiedAt) || verifiedAt < cutoff) continue;
    const existing = cache.get(email);
    if (existing && existing.verified_at_ms >= verifiedAt) continue;
    cache.set(email, { verification_status: status, verified_at: obj.verified_at, verified_at_ms: verifiedAt });
  }
  return cache;
}

// ── The waterfall ───────────────────────────────────────────────────────────

// Verifies candidates in order and STOPS at the first VALID one. Anything after
// a winner is left unverified — that is the whole point of the sequence.
export async function runVerificationWaterfall(candidates, { cache, verifyEmailImpl, now }) {
  const attempts = [];
  let winner = null;

  for (const candidate of candidates) {
    const cached = cache.get(candidate.email);
    if (cached) {
      const attempt = {
        email: candidate.email,
        priority_label: candidate.priority_label,
        verification_status: cached.verification_status,
        verified_at: cached.verified_at,
        cached: true,
        neverbounce_called: false,
      };
      attempts.push(attempt);
      if (attempt.verification_status === 'VALID') { winner = { candidate, attempt }; break; }
      continue;
    }

    let status = 'UNKNOWN';
    let error = null;
    let raw = null;
    try {
      const result = await verifyEmailImpl(candidate.email);
      status = String(result?.verification_status || 'UNKNOWN').toUpperCase();
      raw = result?.raw_result ?? null;
    } catch (err) {
      // A provider failure is not a verdict: treat it as UNKNOWN and carry on
      // down the waterfall rather than failing the whole agency.
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
      neverbounce_called: true,
      error,
      raw_result: raw,
    };
    // Feed the in-run cache so the same address is never checked twice.
    cache.set(candidate.email, { verification_status: status, verified_at: verifiedAt, verified_at_ms: Date.parse(verifiedAt) });
    attempts.push(attempt);
    if (status === 'VALID') { winner = { candidate, attempt }; break; }
    // INVALID / RISKY / UNKNOWN all mean: try the next candidate.
  }

  return { attempts, winner };
}

// ── CONTACTS persistence (idempotent per agency + email) ────────────────────

async function persistContacts(repo, { agencyId, candidates, attempts, winner, now }) {
  const existing = await repo.getRecords('CONTACTS', 'contact_id');
  const byKey = new Map();
  for (const record of existing) {
    if (record.obj.agency_id !== agencyId) continue;
    byKey.set(normalizeEmail(record.obj.email).normalized, record);
  }
  const attemptByEmail = new Map(attempts.map((a) => [a.email, a]));
  const winnerEmail = winner?.candidate.email || '';
  const written = [];

  for (const candidate of candidates) {
    const attempt = attemptByEmail.get(candidate.email);
    const isWinner = candidate.email === winnerEmail;
    const record = byKey.get(candidate.email);
    const notes = [candidate.reason, attempt?.error ? `verification error: ${attempt.error}` : '']
      .filter(Boolean).join(' | ');

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
    if (attempt) {
      fields.verification_status = attempt.verification_status;
      fields.verified_at = attempt.verified_at;
    }

    if (record) {
      await repo.updateById('CONTACTS', 'contact_id', record.obj.contact_id, fields);
      written.push({ contact_id: record.obj.contact_id, email: candidate.email, action: 'updated' });
    } else {
      const contactId = newContactId();
      await repo.appendRecord('CONTACTS', {
        contact_id: contactId,
        verification_status: '',
        verified_at: '',
        ...fields,
        created_at: now(),
      });
      byKey.set(candidate.email, { obj: { contact_id: contactId, agency_id: agencyId, email: candidate.email } });
      written.push({ contact_id: contactId, email: candidate.email, action: 'created' });
    }
  }

  // Exactly one selected contact per agency: stand down any pre-existing row
  // that this run did not choose.
  const candidateEmails = new Set(candidates.map((c) => c.email));
  for (const [email, record] of byKey) {
    if (candidateEmails.has(email)) continue;
    if (String(record.obj.is_selected_for_outreach || '').trim().toUpperCase() !== 'TRUE') continue;
    await repo.updateById('CONTACTS', 'contact_id', record.obj.contact_id, {
      is_selected_for_outreach: 'FALSE',
      updated_at: now(),
    });
    written.push({ contact_id: record.obj.contact_id, email, action: 'deselected' });
  }

  return written;
}

// ── AGENCIES writeback ──────────────────────────────────────────────────────

// updateCell (not updateById) so neighbouring formula columns in AGENCIES are
// left exactly as they are — the same rule the rest of NOVUS follows.
async function writeAgencyCells(repo, agencyId, patch) {
  const applied = {};
  for (const [column, value] of Object.entries(patch)) {
    applied[column] = await repo.updateCell('AGENCIES', 'agency_id', agencyId, column, value);
  }
  return applied;
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
  researchOwnerImpl = researchOwner,
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

  const agencyRecord = await repo.findById('AGENCIES', 'agency_id', id);
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
  let research = null;

  if (!owner) {
    research = await researchOwnerImpl(agency);
    if (research?.found) {
      owner = {
        person_name: research.person_name,
        rank: research.rank,
        role_title: research.role_title,
        source: `RESEARCH:${research.source_type}`,
      };
    }
  }

  // ── 3. Candidates ─────────────────────────────────────────────────────────
  const communications = await repo.getRecords('COMMUNICATIONS', 'communication_id');
  let candidates = buildCandidates({ agency, communications, owner });

  // ── 4. Hunter: only when we know the person and lack a direct line to them.
  const ownerPriority = owner ? priorityForOwnerRank(owner.rank) : null;
  const haveOwnerDirect = Boolean(owner) && candidates.some(
    (c) => c.type === 'DIRECT' && nameMatchesLocalPart(owner.person_name, emailLocalPart(c.email)),
  );
  const hunter = { used: false, attempted: false, reason: '', email: '', error: '' };

  if (owner && !haveOwnerDirect && domain && hunterConfigured()) {
    hunter.attempted = true;
    try {
      const found = await findEmailImpl({ name: owner.person_name, domain });
      if (found?.email) {
        hunter.used = true;
        hunter.email = found.email;
        hunter.score = found.score ?? null;
        hunter.position = found.position || '';
        candidates = sortCandidates([
          ...candidates.filter((c) => c.email !== found.email),
          makeCandidate({
            email: found.email,
            name: owner.person_name,
            role: found.position || owner.role_title || 'Owner / MD',
            source: 'HUNTER',
            priority: ownerPriority,
            reason: `Hunter email finder for ${owner.person_name} @ ${domain}`,
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
  } else if (owner && haveOwnerDirect) {
    hunter.reason = 'Already hold a direct address for this person';
  } else {
    hunter.reason = 'No owner/decision-maker identified';
  }

  // ── 5. Verification waterfall ─────────────────────────────────────────────
  const contactRecords = await repo.getRecords('CONTACTS', 'contact_id');
  const cache = buildVerificationCache(contactRecords, { now: Date.parse(now()) || Date.now() });
  const { attempts, winner } = await runVerificationWaterfall(candidates, { cache, verifyEmailImpl, now });

  // ── 6. Status ─────────────────────────────────────────────────────────────
  let status;
  if (winner) {
    status = winner.candidate.type === 'GENERIC'
      ? RESOLUTION_STATUS.RESOLVED_GENERIC
      : RESOLUTION_STATUS.RESOLVED_DIRECT;
  } else if (candidates.length === 0 || (!owner && research && !research.found)) {
    // Nothing to try at all, or research could not tell us who to look for:
    // this agency needs a human/better research, not another verification run.
    status = RESOLUTION_STATUS.NEEDS_RESEARCH;
  } else {
    status = RESOLUTION_STATUS.NO_VALID_EMAIL;
  }

  // ── 7. Persist ────────────────────────────────────────────────────────────
  let contactsWritten = [];
  let agencyWrites = {};
  if (!dryRun) {
    contactsWritten = await persistContacts(repo, { agencyId: id, candidates, attempts, winner, now });

    const agencyPatch = {
      outreach_contact_name: winner && winner.candidate.type === 'DIRECT' ? (winner.candidate.name || '') : '',
      outreach_contact_email: winner ? winner.candidate.email : '',
      email_verification_status: winner ? winner.attempt.verification_status : '',
      contact_resolution_status: status,
      updated_at: now(),
    };
    // A researched owner is worth keeping even when no email came of it.
    if (research?.found && !storedOwner) {
      agencyPatch.owner_md = research.person_name;
      const evidenceLine = `[${now().slice(0, 10)}] owner research: ${research.person_name} — ${research.role_title} (${research.source_type}${research.source_url ? ` ${research.source_url}` : ''}): ${research.evidence}`;
      const existingNotes = String(agency.notes || '').trim();
      if (!existingNotes.includes(research.person_name)) {
        agencyPatch.notes = existingNotes ? `${existingNotes}\n${evidenceLine}` : evidenceLine;
      }
    }
    agencyWrites = await writeAgencyCells(repo, id, agencyPatch);
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
      research: research
        ? {
            found: research.found,
            person_name: research.person_name,
            role_title: research.role_title,
            source_type: research.source_type,
            source_url: research.source_url,
            evidence: research.evidence,
            confidence: research.confidence,
          }
        : null,
    },
    candidates_considered: candidates.map((c) => ({
      email: c.email, name: c.name, role: c.role, source: c.source,
      type: c.type, priority: c.priority, priority_label: c.priority_label, reason: c.reason,
    })),
    candidates_verified: attempts.map((a) => ({
      email: a.email,
      priority_label: a.priority_label,
      verification_status: a.verification_status,
      cached: a.cached,
      neverbounce_called: a.neverbounce_called,
      error: a.error || undefined,
    })),
    neverbounce: {
      calls_made: attempts.filter((a) => a.neverbounce_called).length,
      cached_reuses: attempts.filter((a) => a.cached).length,
      results: attempts.map((a) => ({ email: a.email, verification_status: a.verification_status, cached: a.cached })),
      not_verified_after_winner: candidates
        .filter((c) => !attempts.some((a) => a.email === c.email))
        .map((c) => c.email),
    },
    hunter,
    selected_contact: winner
      ? {
          contact_name: winner.candidate.type === 'DIRECT' ? winner.candidate.name : '',
          contact_role: winner.candidate.role,
          email: winner.candidate.email,
          email_source: winner.candidate.source,
          contact_type: winner.candidate.type,
          verification_status: winner.attempt.verification_status,
          verified_at: winner.attempt.verified_at,
        }
      : null,
    contact_resolution_status: status,
    contacts_written: contactsWritten,
    agency_writes: agencyWrites,
    dry_run: dryRun,
  };
}

// ── Backlog preparation (NOT executed) ──────────────────────────────────────
//
// Everything the later bulk run needs, without running anything: which probed
// agencies are still unresolved, in sheet order. Unprobed agencies are never
// included. Call resolveAgencyContact() per id when the bulk run is authorised.
export async function listResolutionBacklog(repo, { includeResolved = false } = {}) {
  const agencies = await repo.getRecords('AGENCIES', 'agency_id');
  return agencies
    .filter(({ obj }) => String(obj.probe_sent || '').trim().toUpperCase() === 'YES')
    .filter(({ obj }) => includeResolved || !String(obj.contact_resolution_status || '').trim())
    .map(({ obj }) => ({
      agency_id: obj.agency_id,
      agency_name: obj.agency_name || '',
      contact_resolution_status: String(obj.contact_resolution_status || '').trim(),
    }));
}

export const _internal = { priorityForOwnerRank, persistContacts, writeAgencyCells, splitEmailList };
