// lib/campaign-store.mjs — the three workbook tabs behind the Email /
// Campaigns area, and nothing else: headers, row parsing, setup, patching,
// and the NOVUS ↔ Instantly status mapping.
//
// WHY THREE NEW TABS AND NOT COLUMNS ON OUTBOUND. OUTBOUND is one durable
// queue identity per agency + probe for the ORIGINAL single-campaign handoff
// (docs/INSTANTLY_OUTBOUND.md) and REPLY_EVENTS is the reply system of
// record. A campaign has MANY members and a member has MANY events, and the
// same agency can legitimately sit in more than one campaign over time, so
// the campaign layer needs its own id-keyed, append-mostly ledgers in the same
// row-1 header / row-2 SCHEMA NOTE layout as every other tab.
//
// WHY NOT RAW_EVENTS / COMMUNICATIONS. Every Twilio and probe-email webhook
// reads RAW_EVENTS in full for idempotency, and COMMUNICATIONS is the probe
// intelligence engine's input (observation recompute, diagnosis). Thousands
// of campaign send/open events would slow the former and corrupt the latter.
// CAMPAIGN_EVENTS therefore carries its own raw payload column and its own
// idempotency key (dedupe_key), exactly as REPLY_EVENTS does for replies.

import crypto from 'node:crypto';

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();

function newId(prefix) {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${time}_${rand}`;
}
export function newCampaignId() { return newId('cmp'); }
export function newCampaignMemberId() { return newId('cmm'); }
export function newCampaignEventId() { return newId('cev'); }

// ── CAMPAIGNS ──────────────────────────────────────────────────────────────
export const CAMPAIGNS_TAB = 'CAMPAIGNS';
export const CAMPAIGNS_HEADER = Object.freeze([
  'campaign_id', 'instantly_campaign_id', 'name', 'status', 'campaign_type',
  'sequence_json', 'schedule_json', 'sending_json', 'audience_filters_json', 'policy_json',
  'instantly_status', 'analytics_json', 'step_analytics_json', 'last_synced_at', 'last_error',
  'created_at', 'pushed_at', 'launched_at', 'paused_at', 'completed_at', 'updated_at',
  // Appended, never inserted (older rows read a missing trailing cell as ''):
  // source=NOVUS for campaigns built here, IMPORTED for an Instantly campaign
  // that existed before NOVUS owned campaigns and was linked afterwards.
  'source', 'linked_at',
  // emails_synced_through is the newest /emails timestamp this campaign has
  // fully reconciled. It is ONLY a performance cursor for the automated
  // poller (lib/campaign-handlers.mjs syncOneCampaign, incremental mode) —
  // never trusted for correctness. A full sweep (manual Sync Now, the
  // nightly safety net, or an Instantly-side campaign that predates it)
  // ignores it and re-derives everything from scratch, then advances it.
  'emails_synced_through',
]);
export const CAMPAIGNS_SCHEMA_NOTE = 'SCHEMA NOTE: one row per NOVUS campaign. NOVUS owns audience, eligibility and status; instantly_campaign_id links the Instantly execution object. sequence_json/schedule_json/sending_json are the configuration pushed to Instantly; analytics_json is the last reconciled Instantly analytics snapshot.';

// NOVUS-side campaign statuses. DRAFT covers "created" and "pushed but not
// launched" (pushed_at tells them apart); ERROR is a sticky flag set when a
// push/launch/sync failed and cleared by the next successful operation.
export const CAMPAIGN_STATUSES = Object.freeze(['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ERROR']);

// Campaign types change which eligibility rules apply (see
// lib/campaign-eligibility.mjs). ENQUIRY_FOLLOWUP copy refers to the probe
// enquiry, so a lead without a completed probe cannot receive it.
export const CAMPAIGN_TYPES = Object.freeze(['ENQUIRY_FOLLOWUP', 'GENERAL', 'PROBE_FIVE_MINUTE_CALL', 'FOUNDING_PILOT_OUTCOME', 'FOUNDING_PILOT_OUTCOME_UPFRONT', 'FOUNDING_PILOT_PROBE']);

// Instantly `status` numbers (GET /api/v2/campaigns/{id}) → NOVUS status.
// -99 / -1 / -2 are Instantly-side health states; the campaign is not sending,
// and NOVUS reports that as ERROR rather than guessing "paused".
export const INSTANTLY_CAMPAIGN_STATUS = Object.freeze({
  0: 'DRAFT', 1: 'ACTIVE', 2: 'PAUSED', 3: 'COMPLETED', 4: 'ACTIVE',
  '-99': 'ERROR', '-1': 'ERROR', '-2': 'ERROR',
});
export const INSTANTLY_CAMPAIGN_STATUS_LABEL = Object.freeze({
  0: 'Draft', 1: 'Active', 2: 'Paused', 3: 'Completed', 4: 'Running subsequences',
  '-99': 'Account suspended', '-1': 'Accounts unhealthy', '-2': 'Bounce protect',
});
export function novusStatusFromInstantly(status) {
  const key = String(Number(status));
  return INSTANTLY_CAMPAIGN_STATUS[key] || '';
}

// ── CAMPAIGN_MEMBERS ───────────────────────────────────────────────────────
export const CAMPAIGN_MEMBERS_TAB = 'CAMPAIGN_MEMBERS';
export const CAMPAIGN_MEMBERS_HEADER = Object.freeze([
  'member_id', 'campaign_id', 'agency_id', 'contact_id', 'outbound_id', 'probe_id',
  'email', 'first_name', 'contact_name', 'company_name', 'custom_variables_json',
  'eligibility_status', 'eligibility_reasons', 'warnings_acknowledged',
  'member_status', 'instantly_lead_id', 'instantly_lead_status', 'interest_status',
  'emails_sent_count', 'last_event_type', 'last_event_at',
  'replied_at', 'bounced_at', 'unsubscribed_at', 'meeting_booked_at',
  'added_at', 'pushed_at', 'last_error', 'updated_at',
  // Appended, never inserted. How an IMPORTED member was matched to the
  // NOVUS master data (lib/campaign-import.mjs): MATCHED / AMBIGUOUS /
  // UNMATCHED, the identifier that decided it, and a human-readable note.
  'match_status', 'match_method', 'match_note',
]);
export const CAMPAIGN_MEMBERS_SCHEMA_NOTE = 'SCHEMA NOTE: one row per campaign + agency. eligibility_* is the NOVUS decision at selection time; member_status is the handoff state (SELECTED → PUSHED / PUSH_FAILED / SKIPPED); instantly_lead_status and the *_at columns are reconciled from Instantly and never edited by hand.';

export const ELIGIBILITY_STATUSES = Object.freeze(['READY', 'WARNING', 'BLOCKED']);
// SELECTED   chosen in NOVUS, not yet handed to Instantly
// PUSHED     Instantly returned a lead id for this address
// SKIPPED    Instantly accepted the request but did not create the lead
//            (already in campaign / blocklist / invalid) — see last_error
// PUSH_FAILED the add request itself failed — see last_error, retry with push
// EXCLUDED   BLOCKED at selection time; kept for the audit trail, never pushed
export const MEMBER_STATUSES = Object.freeze(['SELECTED', 'PUSHED', 'SKIPPED', 'PUSH_FAILED', 'EXCLUDED']);

// Instantly lead `status` (POST /api/v2/leads/list) → readable state.
export const INSTANTLY_LEAD_STATUS = Object.freeze({
  1: 'ACTIVE', 2: 'PAUSED', 3: 'COMPLETED', '-1': 'BOUNCED', '-2': 'UNSUBSCRIBED', '-3': 'SKIPPED',
});
// Instantly `lt_interest_status` → readable interest.
export const INSTANTLY_INTEREST_STATUS = Object.freeze({
  0: 'OUT_OF_OFFICE', 1: 'INTERESTED', 2: 'MEETING_BOOKED', 3: 'MEETING_COMPLETED', 4: 'WON',
  '-1': 'NOT_INTERESTED', '-2': 'WRONG_PERSON', '-3': 'LOST', '-4': 'NO_SHOW',
});
export function leadStatusLabel(status) {
  if (status === null || status === undefined || status === '') return '';
  return INSTANTLY_LEAD_STATUS[String(Number(status))] || `STATUS_${status}`;
}
export function interestLabel(status) {
  if (status === null || status === undefined || status === '') return '';
  return INSTANTLY_INTEREST_STATUS[String(Number(status))] || `INTEREST_${status}`;
}

// ── CAMPAIGN_EVENTS ────────────────────────────────────────────────────────
export const CAMPAIGN_EVENTS_TAB = 'CAMPAIGN_EVENTS';
export const CAMPAIGN_EVENTS_HEADER = Object.freeze([
  'event_id', 'dedupe_key', 'source', 'event_type', 'occurred_at', 'received_at',
  'campaign_id', 'instantly_campaign_id', 'member_id', 'agency_id', 'contact_id', 'lead_email',
  'instantly_email_id', 'step', 'variant', 'email_account', 'subject', 'snippet',
  'payload_json', 'created_at',
]);
export const CAMPAIGN_EVENTS_SCHEMA_NOTE = 'SCHEMA NOTE: append-only campaign/email event ledger. dedupe_key is the idempotency key (Instantly webhook payloads carry no event id, so it is a hash of the identifying fields). source=WEBHOOK|RECONCILE|NOVUS. payload_json is the raw provider payload, bounded.';

export const EVENT_SOURCES = Object.freeze(['WEBHOOK', 'RECONCILE', 'NOVUS']);

// Normalised event types. Instantly's webhook and API names are mapped onto
// this closed list; anything unknown becomes OTHER with the raw name kept in
// payload_json.
export const EVENT_TYPES = Object.freeze([
  // NOVUS-originated
  'CAMPAIGN_CREATED', 'LEAD_ADDED', 'LEAD_PUSHED', 'LEAD_PUSH_FAILED', 'LEAD_SKIPPED',
  'CAMPAIGN_PUSHED', 'CAMPAIGN_LAUNCHED', 'CAMPAIGN_PAUSED', 'CAMPAIGN_RESUMED',
  // Instantly-originated
  'EMAIL_SENT', 'EMAIL_OPENED', 'LINK_CLICKED', 'REPLY_RECEIVED', 'AUTO_REPLY_RECEIVED',
  'EMAIL_BOUNCED', 'LEAD_UNSUBSCRIBED', 'LEAD_INTERESTED', 'LEAD_NOT_INTERESTED', 'LEAD_NEUTRAL',
  'LEAD_MEETING_BOOKED', 'LEAD_MEETING_COMPLETED', 'LEAD_CLOSED', 'LEAD_OUT_OF_OFFICE',
  'LEAD_WRONG_PERSON', 'LEAD_NO_SHOW', 'CAMPAIGN_COMPLETED', 'ACCOUNT_ERROR', 'OTHER',
  // A reply NOVUS sent from the Instantly inbox ("Unibox Reply" in the
  // activity export). Recorded so the timeline shows both sides.
  'MANUAL_REPLY_SENT', 'CAMPAIGN_LINKED', 'LEAD_IMPORTED',
]);

// Provider-originated facts about ONE email/lead moment. The same moment can
// reach NOVUS three ways — webhook, /emails reconciliation, activity CSV —
// under three different keys, so these types also dedupe on
// (event_type, lead_email, occurred_at ± 90s). The step is deliberately NOT
// part of the key: the activity export carries it, /emails often does not,
// and two sends to one lead never land within 90s of each other.
export const PROVIDER_EVENT_TYPES = new Set([
  'EMAIL_SENT', 'EMAIL_OPENED', 'LINK_CLICKED', 'REPLY_RECEIVED', 'AUTO_REPLY_RECEIVED', 'EMAIL_BOUNCED',
  'LEAD_UNSUBSCRIBED', 'LEAD_INTERESTED', 'LEAD_NOT_INTERESTED', 'LEAD_NEUTRAL', 'LEAD_MEETING_BOOKED',
  'LEAD_MEETING_COMPLETED', 'LEAD_OUT_OF_OFFICE', 'LEAD_WRONG_PERSON', 'MANUAL_REPLY_SENT',
]);
export const PROVIDER_EVENT_TOLERANCE_MS = 90_000;
export function providerMomentKey(event) {
  const type = upper(event?.event_type);
  if (!PROVIDER_EVENT_TYPES.has(type)) return '';
  const email = text(event?.lead_email).toLowerCase();
  if (!email) return '';
  return `${type}|${email}`;
}

export const INSTANTLY_WEBHOOK_EVENT_TYPES = Object.freeze({
  email_sent: 'EMAIL_SENT',
  email_opened: 'EMAIL_OPENED',
  email_link_clicked: 'LINK_CLICKED',
  link_clicked: 'LINK_CLICKED',
  reply_received: 'REPLY_RECEIVED',
  auto_reply_received: 'AUTO_REPLY_RECEIVED',
  email_bounced: 'EMAIL_BOUNCED',
  lead_unsubscribed: 'LEAD_UNSUBSCRIBED',
  lead_interested: 'LEAD_INTERESTED',
  lead_not_interested: 'LEAD_NOT_INTERESTED',
  lead_neutral: 'LEAD_NEUTRAL',
  lead_meeting_booked: 'LEAD_MEETING_BOOKED',
  lead_meeting_completed: 'LEAD_MEETING_COMPLETED',
  lead_closed: 'LEAD_CLOSED',
  lead_out_of_office: 'LEAD_OUT_OF_OFFICE',
  lead_wrong_person: 'LEAD_WRONG_PERSON',
  lead_no_show: 'LEAD_NO_SHOW',
  campaign_completed: 'CAMPAIGN_COMPLETED',
  account_error: 'ACCOUNT_ERROR',
});
export function normaliseInstantlyEventType(raw) {
  return INSTANTLY_WEBHOOK_EVENT_TYPES[text(raw).toLowerCase()] || 'OTHER';
}

// Event types that count as a "positive" signal in campaign summaries.
export const POSITIVE_EVENT_TYPES = new Set(['LEAD_INTERESTED', 'LEAD_MEETING_BOOKED', 'LEAD_MEETING_COMPLETED']);
export const NEGATIVE_EVENT_TYPES = new Set(['LEAD_NOT_INTERESTED', 'LEAD_WRONG_PERSON', 'LEAD_UNSUBSCRIBED']);

// Instantly webhook payloads have no event id. The identifying fields below
// are stable across redeliveries (Instantly resends the same payload), so a
// hash of them is a real idempotency key rather than a heuristic.
export function webhookDedupeKey(payload) {
  const parts = [
    text(payload?.event_type).toLowerCase(),
    text(payload?.campaign_id),
    text(payload?.lead_email).toLowerCase(),
    text(payload?.timestamp),
    text(payload?.email_id),
    text(payload?.step),
    text(payload?.variant),
  ];
  return `wh_${crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32)}`;
}
// Reconciled events are keyed on the Instantly email id (a send or a reply
// from /api/v2/emails), which IS a stable provider id.
export function reconcileDedupeKey(kind, instantlyEmailId) {
  return `rc_${text(kind).toLowerCase()}_${text(instantlyEmailId)}`;
}
export function novusDedupeKey(kind, ...parts) {
  return `nv_${text(kind).toLowerCase()}_${parts.map(text).join('_')}`;
}

// ── shared table helpers ───────────────────────────────────────────────────
export const CAMPAIGN_TABS = Object.freeze([
  { tab: CAMPAIGNS_TAB, header: CAMPAIGNS_HEADER, note: CAMPAIGNS_SCHEMA_NOTE, id: 'campaign_id' },
  { tab: CAMPAIGN_MEMBERS_TAB, header: CAMPAIGN_MEMBERS_HEADER, note: CAMPAIGN_MEMBERS_SCHEMA_NOTE, id: 'member_id' },
  { tab: CAMPAIGN_EVENTS_TAB, header: CAMPAIGN_EVENTS_HEADER, note: CAMPAIGN_EVENTS_SCHEMA_NOTE, id: 'event_id' },
]);

export function headerMatches(table, header) {
  const actual = (table?.header || []).map(text);
  // Every required column must be present; extra trailing columns are fine
  // (a production tab may gain a hand-added column without breaking reads).
  return header.every((key) => actual.includes(key));
}
export function parseRecords(table, idColumn) {
  const header = table?.header || [];
  const at = header.indexOf(idColumn);
  if (at < 0) return [];
  return (table.rows || []).flatMap((row, index) => {
    const id = text(row[at]);
    if (!id || id === 'SCHEMA NOTE') return [];
    return [{ rowNumber: index + 2, obj: Object.fromEntries(header.map((key, i) => [key, row[i] ?? ''])) }];
  });
}
export function rowFor(header, obj) {
  return header.map((key) => (obj[key] ?? ''));
}
export function parseJson(value, fallback) {
  const raw = text(value);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}
export function reasonsList(value) {
  return text(value).split(/[,\s]+/).map(text).filter(Boolean);
}

export function campaignRecords(table) { return parseRecords(table, 'campaign_id').map((r) => r.obj); }
export function memberRecords(table) { return parseRecords(table, 'member_id').map((r) => r.obj); }
export function eventRecords(table) { return parseRecords(table, 'event_id').map((r) => r.obj); }

// Missing tabs come back as empty tables so every reader degrades to "no
// campaigns yet" instead of failing; the setup flag tells the UI to offer the
// one-click setup.
export async function readCampaignTables(repo) {
  const out = { available: true, missing: [], header_mismatch: [], tables: {} };
  await Promise.all(CAMPAIGN_TABS.map(async ({ tab, header }) => {
    try {
      const table = await repo.getTable(tab);
      if (!table.header?.length) { out.missing.push(tab); out.tables[tab] = { header: [...header], rows: [] }; return; }
      if (!headerMatches(table, header)) out.header_mismatch.push(tab);
      out.tables[tab] = table;
    } catch (err) {
      // A quota/network failure is not an absent tab. Treating it as empty
      // would erase campaign history from an audience eligibility decision.
      if (!/Unable to parse range|no tab:/i.test(String(err?.message || ''))) throw err;
      out.missing.push(tab);
      out.tables[tab] = { header: [...header], rows: [] };
    }
  }));
  out.available = out.missing.length === 0 && out.header_mismatch.length === 0;
  return out;
}

export function buildCampaignSetupPlan() {
  return CAMPAIGN_TABS.map(({ tab, header, note }) => ({
    tab,
    header_row: [...header],
    schema_note_row: ['SCHEMA NOTE', note, ...new Array(Math.max(0, header.length - 2)).fill('')],
  }));
}
export async function ensureCampaignTabs(repo) {
  const results = [];
  for (const plan of buildCampaignSetupPlan()) {
    const result = await repo.ensureTab(plan.tab, plan.header_row, plan.schema_note_row);
    results.push({ tab: plan.tab, result });
  }
  return results;
}

// Cell-level patch by id, resolved against a freshly read header so a
// hand-added column never shifts a write. Unknown keys are ignored (the
// column is simply not in the sheet yet), exactly like repo.updateCell.
async function patchCellsById(repo, tab, idColumn, idValue, patch) {
  const table = await repo.getTable(tab);
  const header = table.header || [];
  const record = parseRecords(table, idColumn).find((r) => text(r.obj[idColumn]) === text(idValue));
  if (!record) return null;
  const writes = [];
  for (const [key, value] of Object.entries(patch || {})) {
    const columnNumber = header.indexOf(key) + 1;
    if (columnNumber < 1) continue;
    writes.push({ tab, rowNumber: record.rowNumber, columnNumber, value: value ?? '' });
  }
  if (writes.length) await repo.writeCellsBatch(writes);
  return { ...record.obj, ...patch };
}
export function patchCampaign(repo, campaignId, patch) {
  return patchCellsById(repo, CAMPAIGNS_TAB, 'campaign_id', campaignId, patch);
}
export function patchMember(repo, memberId, patch) {
  return patchCellsById(repo, CAMPAIGN_MEMBERS_TAB, 'member_id', memberId, patch);
}

// Many member patches in ONE read + ONE batched write. `patches` is
// [{ member_id, patch }]. Used by push and reconcile, which touch hundreds
// of rows and must not issue a read per row.
export async function patchMembersBatch(repo, patches) {
  if (!patches?.length) return 0;
  const table = await repo.getTable(CAMPAIGN_MEMBERS_TAB);
  const header = table.header || [];
  const byId = new Map(parseRecords(table, 'member_id').map((r) => [text(r.obj.member_id), r]));
  const writes = [];
  for (const { member_id: memberId, patch } of patches) {
    const record = byId.get(text(memberId));
    if (!record) continue;
    for (const [key, value] of Object.entries(patch || {})) {
      const columnNumber = header.indexOf(key) + 1;
      if (columnNumber < 1) continue;
      writes.push({ tab: CAMPAIGN_MEMBERS_TAB, rowNumber: record.rowNumber, columnNumber, value: value ?? '' });
    }
  }
  if (writes.length) await repo.writeCellsBatch(writes);
  return writes.length;
}

// Append events, skipping any whose dedupe_key is already in the tab. The
// caller passes the already-loaded events table when it has one (webhook
// bursts and reconcile both do) so this is one read at most.
export async function appendEvents(repo, events, { existingTable = null, now = new Date().toISOString() } = {}) {
  if (!events?.length) return { appended: 0, duplicates: 0, rows: [] };
  const table = existingTable || await repo.getTable(CAMPAIGN_EVENTS_TAB);
  const header = table.header?.length ? table.header : [...CAMPAIGN_EVENTS_HEADER];
  const existing = eventRecords(table);
  const seen = new Set(existing.map((row) => text(row.dedupe_key)).filter(Boolean));
  // The same send or reply can arrive twice under different keys — once from
  // the webhook (hash of the payload) and once from reconciliation (Instantly
  // email id). Its (event_type, instantly_email_id) pair is the same both
  // times, so it is a second idempotency key.
  const byEmailId = (row) => (text(row.instantly_email_id) ? `${upper(row.event_type)}|${text(row.instantly_email_id)}` : '');
  const seenEmail = new Set(existing.map(byEmailId).filter(Boolean));
  // Third key: the provider moment (type, lead, step) within ±90s — the CSV
  // export and the API disagree by sub-second rounding on the same email.
  const moments = new Map();
  const remember = (row) => {
    const k = providerMomentKey(row);
    const at = Date.parse(text(row.occurred_at));
    if (!k || !Number.isFinite(at)) return;
    if (!moments.has(k)) moments.set(k, []);
    moments.get(k).push(at);
  };
  const seenMoment = (row) => {
    const k = providerMomentKey(row);
    const at = Date.parse(text(row.occurred_at));
    if (!k || !Number.isFinite(at)) return false;
    return (moments.get(k) || []).some((other) => Math.abs(other - at) <= PROVIDER_EVENT_TOLERANCE_MS);
  };
  existing.forEach(remember);
  const rows = [];
  const accepted = [];
  let duplicates = 0;
  for (const event of events) {
    const key = text(event.dedupe_key);
    const emailKey = byEmailId(event);
    if (!key || seen.has(key) || (emailKey && seenEmail.has(emailKey)) || seenMoment(event)) { duplicates += 1; continue; }
    seen.add(key);
    if (emailKey) seenEmail.add(emailKey);
    remember(event);
    const full = {
      event_id: newCampaignEventId(), source: 'NOVUS', occurred_at: now, received_at: now, created_at: now,
      ...event,
      payload_json: text(typeof event.payload_json === 'string' ? event.payload_json : JSON.stringify(event.payload_json ?? {})).slice(0, 20000),
    };
    rows.push(rowFor(header, full));
    accepted.push(full);
  }
  if (rows.length) await repo.appendRowsBatch(CAMPAIGN_EVENTS_TAB, rows);
  return { appended: rows.length, duplicates, rows: accepted };
}

export function validateCampaignRow(row) {
  const errors = [];
  for (const key of ['campaign_id', 'name', 'status', 'created_at', 'updated_at']) {
    if (!text(row?.[key])) errors.push(`${key} is required`);
  }
  if (text(row?.status) && !CAMPAIGN_STATUSES.includes(upper(row.status))) errors.push('invalid status');
  if (text(row?.campaign_type) && !CAMPAIGN_TYPES.includes(upper(row.campaign_type))) errors.push('invalid campaign_type');
  return { valid: errors.length === 0, errors };
}

export const _internal = { text, upper, newId, patchCellsById };
