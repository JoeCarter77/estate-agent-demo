// lib/sales-messages.mjs — SCHEMA + READ groundwork for the future
// SALES_MESSAGES tab (Phase 2).
//
// WHAT THIS TAB IS FOR. REPLY_EVENTS is RECEIVED-ONLY durable evidence, and its
// exact header is validated by the live poller (lib/instantly-reply-poll.mjs),
// so NOVUS-sent sales messages cannot live there: adding a column, reordering
// one, or appending an outbound row would all break a live campaign path.
// SALES_MESSAGES is the separate, append-only home for what NOVUS SENDS in a
// sales conversation.
//
// STILL NO WRITER, AS OF PHASE 3A. Nothing in this module writes, and no
// writer is exported. buildSalesMessageRow() produces a row array and calls
// nothing; buildSalesMessagesSetupPlan() produces the two literal rows the tab
// needs and calls nothing. Phase 3A sends no message, so it records none.
//
// THE TAB IS CREATED BY HAND, ONCE. lib/sheets.mjs speaks only the Sheets
// VALUES api (get/append/update) — it cannot add a sheet, that is a separate
// spreadsheets.batchUpdate:addSheet call — and its credentials are Vercel OIDC
// tokens that exist only inside a live Function invocation, so no local script
// can create the tab either. Building a live tab-creating write path, for a
// phase that appends nothing, would be scope this phase does not need. Instead
// buildSalesMessagesSetupPlan() emits the exact two rows and
// scripts/novus-sales-messages-setup.mjs prints them for a one-time paste.
//
// Until that paste happens, readSalesMessagesForOutreach() treats the absent
// tab as "no rows, not available" rather than an error, so every existing
// operator path works unchanged either way.

export const SALES_MESSAGES_TAB = 'SALES_MESSAGES';

// Column order IS the tab layout, exactly as REPLY_EVENTS_HEADER is for its own
// tab. Phase 3 must create the tab with this header verbatim.
export const SALES_MESSAGES_HEADER = [
  'sales_message_id',
  'outreach_id',
  'agency_id',
  'reply_event_id',
  'direction',
  'message_type',
  'eaccount',
  'in_reply_to_email_id',
  'instantly_email_id',
  'instantly_thread_id',
  'instantly_message_id',
  'thread_continuity',
  'subject',
  'body_text',
  'send_outcome',
  'instantly_status',
  'error',
  'sent_by',
  'sent_at',
  'created_at',
];

export const SALES_MESSAGES_ID_COLUMN = 'sales_message_id';

// SALES_MESSAGES.outreach_id stores OUTBOUND.outbound_id — the same journey
// identity REPLY_EVENTS.outreach_id uses, so a lead's sent and received
// messages join on one key.
export const SALES_MESSAGES_OUTREACH_COLUMN = 'outreach_id';

export const SALES_MESSAGE_DIRECTIONS = ['OUTBOUND'];

// Only NOVUS-sent sales messages belong here. Inbound stays in REPLY_EVENTS;
// duplicating it would create two competing records of the same event.
export const SALES_MESSAGE_TYPES = ['MANUAL_REPLY', 'DEMO_REPLY', 'FOLLOW_UP'];

export const SEND_OUTCOMES = ['SENT', 'FAILED', 'BLOCKED', 'DRY_RUN'];

// WHAT thread_continuity RECORDS. After a send, Instantly's response carries a
// thread_id. Comparing it to the thread_id we replied INTO answers the one
// question that matters afterwards: did this message land in the prospect's
// existing conversation, or did Instantly start a new thread?
//
//   CONFIRMED — both ids are present and equal. The reply is in-thread.
//   DIFFERENT — both are present and differ. The message was sent, but it is
//               NOT where we expected it; a human should look.
//   UNKNOWN   — either id is missing. NOT an error and NOT a failure: a 2xx
//               with no thread_id in the body is still a completed send, and
//               recording UNKNOWN says exactly that we cannot tell.
//
// Phase 3A defines and tests this. Nothing writes it yet, because nothing
// sends yet. (The Phase 2 placeholder values IN_THREAD/NEW_THREAD are gone: no
// row has ever carried them — the tab does not exist — and they described a
// different question, one the Instantly response cannot actually answer.)
export const THREAD_CONTINUITY = ['CONFIRMED', 'DIFFERENT', 'UNKNOWN'];

// The pure comparison itself. Takes the thread we replied into and the thread
// Instantly reported; never throws, never guesses.
export function resolveThreadContinuity(storedThreadId, responseThreadId) {
  const stored = text(storedThreadId);
  const returned = text(responseThreadId);
  if (!stored || !returned) return 'UNKNOWN';
  return stored === returned ? 'CONFIRMED' : 'DIFFERENT';
}

export const SALES_MESSAGES_SCHEMA_NOTE =
  'SCHEMA NOTE: append-only record of sales messages NOVUS SENT. outreach_id = OUTBOUND.outbound_id. '
  + 'reply_event_id = the REPLY_EVENTS row this answers, when it answers one. eaccount = the Instantly '
  + 'sending inbox actually used. Received replies live in REPLY_EVENTS and are never duplicated here.';

function text(value) {
  return String(value ?? '').trim();
}

// Re-exported from lib/ids.mjs, where every other NOVUS id prefix is minted,
// so this module stays the SCHEMA and nothing else. Importers that already
// take newSalesMessageId from here are unaffected.
export { newSalesMessageId } from './ids.mjs';

// -- validation --------------------------------------------------------------

// Structural validation only. It asserts nothing about whether a send SHOULD
// happen — that gate is Phase 3's and lives with the send path, not here.
export function validateSalesMessageRow(obj) {
  const errors = [];
  const row = obj || {};

  for (const column of ['sales_message_id', 'outreach_id', 'direction', 'message_type', 'created_at']) {
    if (!text(row[column])) errors.push(`${column} is required`);
  }

  const direction = text(row.direction).toUpperCase();
  if (direction && !SALES_MESSAGE_DIRECTIONS.includes(direction)) {
    errors.push(`direction must be one of ${SALES_MESSAGE_DIRECTIONS.join(', ')} (got ${direction})`);
  }
  const messageType = text(row.message_type).toUpperCase();
  if (messageType && !SALES_MESSAGE_TYPES.includes(messageType)) {
    errors.push(`message_type must be one of ${SALES_MESSAGE_TYPES.join(', ')} (got ${messageType})`);
  }
  const outcome = text(row.send_outcome).toUpperCase();
  if (outcome && !SEND_OUTCOMES.includes(outcome)) {
    errors.push(`send_outcome must be one of ${SEND_OUTCOMES.join(', ')} (got ${outcome})`);
  }
  const continuity = text(row.thread_continuity).toUpperCase();
  if (continuity && !THREAD_CONTINUITY.includes(continuity)) {
    errors.push(`thread_continuity must be one of ${THREAD_CONTINUITY.join(', ')} (got ${continuity})`);
  }
  // A row claiming a completed send must name the mailbox it went out from,
  // otherwise the durable record cannot answer "who sent this".
  if (outcome === 'SENT' && !text(row.eaccount)) {
    errors.push('eaccount is required when send_outcome is SENT');
  }

  const unknown = Object.keys(row).filter((key) => !SALES_MESSAGES_HEADER.includes(key));
  if (unknown.length) errors.push(`unknown column(s): ${unknown.join(', ')}`);

  return { valid: errors.length === 0, errors };
}

// Row array in header order. Phase 3 hands this to repo.appendRecord/append;
// Phase 2 only uses it to prove the schema round-trips.
export function buildSalesMessageRow(obj) {
  const { valid, errors } = validateSalesMessageRow(obj);
  if (!valid) throw new Error(`invalid SALES_MESSAGES row: ${errors.join('; ')}`);
  return SALES_MESSAGES_HEADER.map((column) => text(obj[column]));
}

// -- reading -----------------------------------------------------------------

// Parses a { header, rows } table into records, applying the same rules
// lib/sheets.mjs getRecords applies: skip the header, skip the SCHEMA NOTE row,
// skip any row with a blank id. A missing or empty table yields [].
export function parseSalesMessageRecords(table) {
  const header = table?.header || [];
  const rows = table?.rows || [];
  const idIndex = header.indexOf(SALES_MESSAGES_ID_COLUMN);
  if (idIndex < 0) return [];
  const out = [];
  rows.forEach((row, i) => {
    const id = text(row[idIndex]);
    if (!id || id === 'SCHEMA NOTE') return;
    const obj = {};
    header.forEach((key, c) => { obj[key] = row[c] ?? ''; });
    out.push({ rowNumber: i + 2, obj });
  });
  return out;
}

// TOLERANT READ. The tab does not exist yet, and a Sheets read of a missing tab
// throws. That must never break the operator drawer, so the failure is caught
// and reported as { available: false } — the caller renders the durable Phase 1
// data exactly as before.
export async function readSalesMessagesForOutreach(repo, outreachId, { tab = SALES_MESSAGES_TAB } = {}) {
  const wanted = text(outreachId);
  if (!wanted) return { available: false, rows: [], error: 'outreach_id is required' };
  let table;
  try {
    table = await repo.getTable(tab);
  } catch (err) {
    return { available: false, rows: [], error: err?.message || `${tab} could not be read` };
  }
  if (!table?.header?.length) return { available: false, rows: [], error: `${tab} is absent or empty` };
  const rows = parseSalesMessageRecords(table)
    .map((record) => record.obj)
    .filter((obj) => text(obj[SALES_MESSAGES_OUTREACH_COLUMN]) === wanted);
  return { available: true, rows, error: null };
}

// -- one-time tab setup ------------------------------------------------------

// The EXACT contents of a freshly created SALES_MESSAGES tab: row 1 the header,
// row 2 the schema note, and NOTHING else. It is a pure function returning
// data — it creates nothing, writes nothing and reaches no network.
//
// NO SENT ROWS. A setup that seeded even one example row would put a message
// NOVUS never sent into the durable record of messages NOVUS sent, which is
// exactly the corruption this tab exists to avoid.
//
// The schema-note row is padded to the header width so the two rows are the
// same shape, matching every other tab in this workbook (row 1 header, row 2
// "SCHEMA NOTE ...", row 3+ data) and keeping the repo's SCHEMA-NOTE skip rule
// working from the first read.
export function buildSalesMessagesSetupPlan() {
  const noteRow = SALES_MESSAGES_HEADER.map((_, i) => (i === 0 ? 'SCHEMA NOTE' : ''));
  noteRow[1] = SALES_MESSAGES_SCHEMA_NOTE;
  return {
    tab: SALES_MESSAGES_TAB,
    header_row: [...SALES_MESSAGES_HEADER],
    schema_note_row: noteRow,
    data_rows: [],
  };
}
