// lib/communication-status.mjs — the tombstone predicate shared by every
// reader of COMMUNICATIONS/RAW_EVENTS.
//
// Deletion (lib/inbound-match-delete.mjs) is deliberately schema-free: this
// workbook has no migration mechanism (headers are fixed on the live Google
// Sheet — see lib/sheets.mjs), so "deleted" reuses the existing match_status
// column instead of adding one. Every place that reads COMMUNICATIONS for
// matching evidence, observation/intelligence rollups, or the resolution
// queue must treat match_status = 'deleted' as if the row did not exist.
// This file is the single source of truth for that check so it can never
// drift between callers.

export const DELETED_MATCH_STATUS = 'deleted';

// RAW_EVENTS.processing_status value written once the COMMUNICATIONS row it
// produced has been deleted — distinct from 'processed', so a future
// processing/rebuild pass over RAW_EVENTS has an explicit signal to skip
// re-deriving a COMMUNICATIONS row from this event.
export const DISCARDED_PROCESSING_STATUS = 'discarded';

export function isDeletedCommunication(comm) {
  return String(comm?.match_status ?? '').trim().toLowerCase() === DELETED_MATCH_STATUS;
}
