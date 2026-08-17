// lib/agency-merge.mjs — merges one duplicate AGENCIES record into another.
//
// Built for exactly the case the data audit surfaced: two AGENCIES rows that
// are the same real-world business (confirmed by the human, not guessed here),
// causing matchAgency() in lib/matching.mjs to return 'ambiguous' for their
// shared contact email and permanently blocking replies from matching. Kept
// general because duplicate agencies are a recurring shape of problem in this
// scraped dataset, not a one-off.
//
// SAFETY MODEL:
//   • agency_name and every other single-value identity field (domain, website,
//     primary_contact_email, primary_contact_name, owner_md, location, ...) on
//     the RETAINED row is left exactly as it is. This module only ever fills a
//     blank, appends to a list field, or appends to notes — it never overwrites
//     a non-blank value with a guess. Naming/identity decisions are a human
//     call (see the AskUserQuestion exchange this was built from), not
//     something this code infers.
//   • Dependents (PROBES/COMMUNICATIONS/INTELLIGENCE/ACTIONS rows whose
//     agency_id is the row being removed) are repointed to the retained id
//     BEFORE anything is deleted, and re-counted as zero afterward before the
//     delete proceeds. If repointing did not actually reach zero, the delete is
//     refused — a partially-repointed row is never removed.
//   • The physical delete only happens via repo.deleteRecordRow(), which exists
//     solely for this. See its comment in lib/sheets.mjs for why that is a
//     deliberately separate, narrowly-scoped capability.

const DEPENDENT_TABS = [
  { tab: 'PROBES', idColumn: 'probe_id' },
  { tab: 'COMMUNICATIONS', idColumn: 'communication_id' },
  { tab: 'INTELLIGENCE', idColumn: 'intelligence_id' },
  { tab: 'ACTIONS', idColumn: 'action_id' },
];

// Rightmove research quality, worst to best. Used only to decide whether the
// retained row should inherit the OTHER row's rightmove_* values — never to
// overwrite a value the retained row already holds.
const RIGHTMOVE_RANK = { '': -1, unresolved: 0, not_applicable: 0, candidate: 1, confirmed: 2 };
function rank(status) { return RIGHTMOVE_RANK[String(status ?? '').trim().toLowerCase()] ?? -1; }

function splitPhones(cell) {
  return String(cell ?? '').split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
}
function normalizePhoneLoose(s) {
  let d = String(s ?? '').replace(/[^\d+]/g, '');
  if (d.startsWith('0')) d = '+44' + d.slice(1);
  if (d && !d.startsWith('+')) d = '+' + d;
  return d;
}

// Merges known_phone_numbers (+ each row's own main_phone) from both rows into
// one deduplicated, order-preserving list. Reuses the EXISTING delimited-list
// column (lib/phone-matching.mjs already splits on [,;\s]+) rather than adding
// a new field.
function mergePhoneNumbers(retain, del) {
  const seen = new Set();
  const out = [];
  for (const raw of [retain.main_phone, ...splitPhones(retain.known_phone_numbers), del.main_phone, ...splitPhones(del.known_phone_numbers)]) {
    const text = String(raw ?? '').trim();
    if (!text) continue;
    const key = normalizePhoneLoose(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out.join(', ');
}

function splitEmails(cell) {
  return String(cell ?? '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
}

// Preserves the deleted row's domain/website/emails as SEARCHABLE text on the
// retained row (via other_known_emails + notes) rather than silently losing
// them. Does not touch AGENCIES.domain — matchAgency's domain_exact check uses
// exactly one domain per row, by schema, so the deleted row's domain cannot
// become a second live match key without a schema change nobody asked for
// here. That gap is flagged in the report, not hidden.
function mergeOtherKnownEmails(retain, del) {
  const seen = new Set(splitEmails(retain.primary_contact_email).map((e) => e.toLowerCase()));
  const merged = splitEmails(retain.other_known_emails);
  for (const e of merged) seen.add(e.toLowerCase());
  for (const e of [del.primary_contact_email, ...splitEmails(del.other_known_emails)]) {
    const t = String(e ?? '').trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    merged.push(t);
  }
  return merged.join(', ');
}

/**
 * Pure decision function — no I/O. Computes the patch to apply to the RETAINED
 * row and a list of human-readable warnings (things a reader should know but
 * that don't block the merge).
 */
export function resolveAgencyMerge(retain, del, { notesAddendum } = {}) {
  const patch = {};
  const warnings = [];

  const mergedPhones = mergePhoneNumbers(retain, del);
  if (mergedPhones !== String(retain.known_phone_numbers ?? '').trim()) {
    patch.known_phone_numbers = mergedPhones;
  }

  const mergedEmails = mergeOtherKnownEmails(retain, del);
  if (mergedEmails !== String(retain.other_known_emails ?? '').trim()) {
    patch.other_known_emails = mergedEmails;
  }

  // Rightmove data: inherit only if the retained row's own status ranks lower
  // than the deleted row's. Never overwrites a retained value that already
  // ranks equal or higher.
  if (rank(del.rightmove_status) > rank(retain.rightmove_status)) {
    if (del.rightmove_sales_branch_url) patch.rightmove_sales_branch_url = del.rightmove_sales_branch_url;
    if (del.rightmove_status) patch.rightmove_status = del.rightmove_status;
    if (del.rightmove_checked_at) patch.rightmove_checked_at = del.rightmove_checked_at;
    if (del.rightmove_notes) patch.rightmove_notes = del.rightmove_notes;
    warnings.push(`Inherited rightmove_* fields from ${del.agency_id} — its research rank (${del.rightmove_status || 'blank'}) was higher than ${retain.agency_id}'s (${retain.rightmove_status || 'blank'}).`);
  }

  const existingNotes = String(retain.notes ?? '').trim();
  patch.notes = existingNotes ? `${existingNotes}\n${notesAddendum}` : notesAddendum;

  const retainDomain = String(retain.domain ?? '').trim().toLowerCase();
  const delDomain = String(del.domain ?? '').trim().toLowerCase();
  if (delDomain && delDomain !== retainDomain) {
    warnings.push(`${del.agency_id}'s domain (${del.domain}) is not carried onto the retained row's single 'domain' column — a future email from @${del.domain} will NOT domain_exact-match after this merge (email_exact via other_known_emails still will, since that address was preserved).`);
  }

  return { patch, warnings };
}

/**
 * Read-only plan: resolves both rows, counts dependents, computes the patch.
 * Never writes. This is what a dry_run returns.
 */
export async function planAgencyMerge(repo, { retain_agency_id, delete_agency_id, notes_addendum }) {
  if (!retain_agency_id || !delete_agency_id) {
    throw new Error('retain_agency_id and delete_agency_id are both required');
  }
  if (retain_agency_id === delete_agency_id) {
    throw new Error('retain_agency_id and delete_agency_id must be different');
  }

  const retainRec = await repo.findById('AGENCIES', 'agency_id', retain_agency_id);
  const delRec = await repo.findById('AGENCIES', 'agency_id', delete_agency_id);
  if (!retainRec) throw new Error(`retain_agency_id "${retain_agency_id}" not found in AGENCIES`);
  if (!delRec) throw new Error(`delete_agency_id "${delete_agency_id}" not found in AGENCIES`);

  const dependents_before = {};
  for (const { tab, idColumn } of DEPENDENT_TABS) {
    const records = await repo.getRecords(tab, idColumn);
    dependents_before[tab] = records.filter((r) => r.obj.agency_id === delete_agency_id).length;
  }

  const notesAddendum = notes_addendum
    || `Merged with ${delete_agency_id} (${delRec.obj.agency_name}) — same underlying business, confirmed by operator. Zero/repointed dependent records.`;

  const { patch, warnings } = resolveAgencyMerge(retainRec.obj, delRec.obj, { notesAddendum });

  return {
    retain_agency_id,
    delete_agency_id,
    retain_agency_name: retainRec.obj.agency_name,
    delete_agency_name: delRec.obj.agency_name,
    dependents_before,
    dependents_total_before: Object.values(dependents_before).reduce((a, b) => a + b, 0),
    patch,
    warnings,
    notes_addendum: notesAddendum,
  };
}

/**
 * Executes the merge: repoints dependents, patches the retained row, verifies
 * zero dependents remain on the deleted id, then deletes its row. Throws
 * (rather than deleting) if verification fails — a partially-merged agency is
 * never removed silently.
 */
export async function executeAgencyMerge(repo, { retain_agency_id, delete_agency_id, notes_addendum }) {
  const plan = await planAgencyMerge(repo, { retain_agency_id, delete_agency_id, notes_addendum });

  const repointed = {};
  for (const { tab, idColumn } of DEPENDENT_TABS) {
    const records = await repo.getRecords(tab, idColumn);
    const toMove = records.filter((r) => r.obj.agency_id === delete_agency_id);
    for (const r of toMove) {
      await repo.updateById(tab, idColumn, r.obj[idColumn], {
        agency_id: retain_agency_id,
        updated_at: new Date().toISOString(),
      });
    }
    repointed[tab] = toMove.length;
  }

  const updatedRetain = await repo.updateById('AGENCIES', 'agency_id', retain_agency_id, plan.patch);
  if (!updatedRetain) throw new Error(`retain_agency_id "${retain_agency_id}" vanished mid-merge — aborting before delete`);

  const dependents_after = {};
  for (const { tab, idColumn } of DEPENDENT_TABS) {
    const records = await repo.getRecords(tab, idColumn);
    dependents_after[tab] = records.filter((r) => r.obj.agency_id === delete_agency_id).length;
  }
  const remaining = Object.values(dependents_after).reduce((a, b) => a + b, 0);
  if (remaining > 0) {
    throw new Error(
      `Refusing to delete ${delete_agency_id}: ${remaining} dependent record(s) still reference it after repointing (${JSON.stringify(dependents_after)}). Nothing was deleted.`,
    );
  }

  const deleted = await repo.deleteRecordRow('AGENCIES', 'agency_id', delete_agency_id);
  if (!deleted) throw new Error(`delete_agency_id "${delete_agency_id}" vanished mid-merge — repointing already applied, but no row was found to delete`);

  return {
    ...plan,
    repointed,
    dependents_after,
    retained_row: updatedRetain,
    deleted_row: deleted,
    deleted: true,
  };
}
