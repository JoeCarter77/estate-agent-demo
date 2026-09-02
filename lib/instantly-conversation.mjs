// lib/instantly-conversation.mjs — LEAD-SCOPED read of one prospect's Instantly
// conversation, plus the pure merge that turns it into the canonical sales
// thread the operator drawer renders (Phase 2).
//
// READ CONTRACT — this module:
//   - performs exactly ONE Instantly call, a GET, and only when asked
//   - never calls an Instantly write endpoint (no /emails/reply, no lead write)
//   - never touches Google Sheets (no repo, no getRepo import)
//   - never runs AI and never classifies
//   - never echoes the API key into a return value or an error
//   - is otherwise pure: buildConversation() does no I/O at all
//
// WHY LEAD-SCOPED. lib/reply-thread-context.mjs sweeps the 100 most recent
// emails WORKSPACE-WIDE, because it serves a whole poller pass from one call.
// The drawer has the opposite shape: one lead, opened on demand, and that
// lead's campaign email may be weeks outside any recent-messages window. GET
// /api/v2/emails supports `lead=<email>`, so the drawer asks for exactly the
// conversation it is displaying. There is no workspace-wide sweep here.
//
// DIRECTION is not taken from Instantly's word for it: normalizeInstantlyEmail
// cross-checks ue_type against the from/to/eaccount address relationship, and
// a contradiction resolves to UNKNOWN. A message whose direction cannot be
// established is KEPT and labelled UNKNOWN — silently dropping a real message
// from a sales thread is worse than showing one we cannot attribute.

import { normalizeInstantlyEmail, extractEmails, UE_TYPE } from './reply-router.mjs';

export const INSTANTLY_EMAILS_URL = 'https://api.instantly.ai/api/v2/emails';

// 100 is the API maximum for `limit`. A single sales conversation is far
// smaller than that in practice; this is a ceiling, not an expectation.
export const DEFAULT_CONVERSATION_LIMIT = 100;

// One drawer open = one GET. If Instantly is slow the drawer must still render
// the durable Sheets data, so the live call is bounded.
export const DEFAULT_CONVERSATION_TIMEOUT_MS = 12_000;

// Where a canonical message came from. OUTBOUND is not a message store: it
// contributes the single factual "added to the campaign" timeline marker
// described below, never any email text.
export const CONVERSATION_SOURCES = ['INSTANTLY', 'REPLY_EVENTS', 'SALES_MESSAGES', 'OUTBOUND'];

export const MESSAGE_DIRECTIONS = ['INBOUND', 'OUTBOUND', 'UNKNOWN'];

// message_type is descriptive, never a routing decision. CAMPAIGN/MANUAL/
// SCHEDULED come from Instantly's own ue_type (1/3/4); CAMPAIGN_ADDED is the
// OUTBOUND marker.
export const MESSAGE_TYPES = [
  'CAMPAIGN_EMAIL',
  'MANUAL_EMAIL',
  'SCHEDULED_EMAIL',
  'PROSPECT_REPLY',
  'NOVUS_MESSAGE',
  'CAMPAIGN_ADDED',
  'UNKNOWN',
];

export const SENDER_STATUSES = ['CONFIRMED', 'AMBIGUOUS', 'UNKNOWN'];

// -- small pure helpers ------------------------------------------------------

function text(value) {
  return String(value ?? '').trim();
}

function ms(value) {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

// The lead address is known SERVER-SIDE (from OUTBOUND). Instantly usually
// echoes it on each email, but when it does not, direction detection has no
// counterparty and every message resolves to UNKNOWN. Seeding the known
// address is not a guess: it is the address this conversation was fetched for.
function seedLeadEmail(raw, leadEmail) {
  const known = text(leadEmail).toLowerCase();
  if (!known || !raw || typeof raw !== 'object') return raw;
  const present = extractEmails(raw.lead ?? raw.lead_email ?? raw.email ?? '');
  if (present.length) return raw;
  return { ...raw, lead: known };
}

function messageTypeFor(message) {
  if (message.direction === 'INBOUND') return 'PROSPECT_REPLY';
  switch (message.ue_type) {
    case UE_TYPE.SENT_FROM_CAMPAIGN: return 'CAMPAIGN_EMAIL';
    case UE_TYPE.SENT_MANUALLY: return 'MANUAL_EMAIL';
    case UE_TYPE.SCHEDULED: return 'SCHEDULED_EMAIL';
    default: return message.direction === 'OUTBOUND' ? 'NOVUS_MESSAGE' : 'UNKNOWN';
  }
}

// -- URL construction --------------------------------------------------------

// LEAD-SCOPED, always. There is deliberately no code path in this module that
// builds an unscoped /emails URL: a blank leadEmail throws rather than
// degrading into a workspace-wide sweep.
export function buildLeadConversationUrl({ leadEmail, limit = DEFAULT_CONVERSATION_LIMIT } = {}) {
  const lead = text(leadEmail);
  if (!lead) throw new Error('leadEmail is required for a lead-scoped conversation fetch');
  const bounded = Number.isInteger(limit) && limit > 0 && limit <= DEFAULT_CONVERSATION_LIMIT
    ? limit
    : DEFAULT_CONVERSATION_LIMIT;
  const params = new URLSearchParams({
    lead,
    limit: String(bounded),
    sort_order: 'desc',
  });
  return `${INSTANTLY_EMAILS_URL}?${params.toString()}`;
}

function emailsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['items', 'data', 'emails', 'results', 'records']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

// -- the one live read -------------------------------------------------------

// ONE GET. Returns normalised messages plus per-row warnings; never throws for
// a malformed row, always throws (with instantly_status/instantly_error, never
// the key) for a transport or API failure so the caller can degrade cleanly.
export async function fetchLeadConversation({
  apiKey,
  leadEmail,
  limit = DEFAULT_CONVERSATION_LIMIT,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_CONVERSATION_TIMEOUT_MS,
  mailboxes,
} = {}) {
  if (!apiKey) throw new Error('INSTANTLY_REPLY_API_KEY is not set in this environment.');
  const url = buildLeadConversationUrl({ leadEmail, limit });

  const init = {
    method: 'GET',
    cache: 'no-store',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  };
  // A hung Instantly call must not hold the drawer open. AbortSignal.timeout is
  // used when available and simply skipped when it is not — a missing timeout
  // is a slower path, not a wrong one.
  if (timeoutMs && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    init.signal = AbortSignal.timeout(timeoutMs);
  }

  const response = await fetchImpl(url, init);
  const body = await response.text();

  let payload = null;
  try { payload = body ? JSON.parse(body) : null; } catch { payload = null; }

  if (!response.ok) {
    const err = new Error('Instantly API returned an error');
    err.instantly_status = response.status;
    err.instantly_error = payload?.error || payload?.message || payload?.detail
      || (body ? String(body).slice(0, 500) : '(empty response body)');
    throw err;
  }

  const raws = emailsFromPayload(payload);
  const messages = [];
  const warnings = [];
  raws.forEach((raw, i) => {
    try {
      messages.push(toConversationMessage(raw, { leadEmail, mailboxes }));
    } catch (err) {
      warnings.push({
        code: 'malformed_instantly_row',
        detail: `Instantly row ${i} could not be read (${err?.message || 'unknown error'}) and was skipped`,
      });
    }
  });

  return { messages, count: messages.length, raw_count: raws.length, warnings };
}

// One raw Instantly email -> one canonical message. Only the fields the drawer
// actually renders are kept; nothing is invented, and an absent field stays ''.
export function toConversationMessage(raw, { leadEmail, mailboxes } = {}) {
  const message = normalizeInstantlyEmail(seedLeadEmail(raw, leadEmail), { mailboxes });
  return {
    source: 'INSTANTLY',
    direction: message.direction,
    message_type: messageTypeFor(message),
    at: message.timestamp,
    subject: message.subject,
    body_text: message.cleaned_reply_text || message.raw_body_text,
    instantly_email_id: message.email_id,
    thread_id: message.thread_id,
    eaccount: message.eaccount,
    campaign_id: message.campaign_id,
    lead_email: message.lead_email,
    from: message.from_email,
    to: message.to_emails,
    reply_event_id: '',
    sales_message_id: '',
  };
}

// -- sender inbox resolution -------------------------------------------------

// WHICH MAILBOX THIS CONVERSATION BELONGS TO — read from the live conversation
// only. Never derived from a domain pattern, never defaulted to the configured
// list, and never supplied by the browser. `eaccount` is Instantly's own "email
// account used for this email", so it is the one authoritative answer.
//
// More than one distinct eaccount on a single lead-scoped conversation is not
// something to pick a winner from: it is reported as AMBIGUOUS with every
// candidate listed.
export function resolveSenderInbox(messages) {
  const seen = [];
  for (const message of messages || []) {
    const account = text(message?.eaccount).toLowerCase();
    if (account && !seen.includes(account)) seen.push(account);
  }
  if (seen.length === 1) return { sender_status: 'CONFIRMED', eaccount: seen[0], candidates: seen };
  if (seen.length > 1) return { sender_status: 'AMBIGUOUS', eaccount: null, candidates: seen };
  return { sender_status: 'UNKNOWN', eaccount: null, candidates: [] };
}

// -- durable rows -> canonical messages ---------------------------------------

// REPLY_EVENTS is DURABLE RECEIVED EVIDENCE. Its schema is live-validated by
// the poller and is not touched here — this only reads.
export function replyEventToMessage(row) {
  return {
    source: 'REPLY_EVENTS',
    direction: 'INBOUND',
    message_type: 'PROSPECT_REPLY',
    at: text(row?.received_at) || text(row?.processed_at),
    subject: text(row?.subject),
    body_text: text(row?.cleaned_reply_text) || text(row?.body_text),
    instantly_email_id: text(row?.instantly_email_id),
    thread_id: text(row?.thread_id),
    eaccount: '',
    campaign_id: text(row?.campaign_id),
    lead_email: text(row?.lead_email),
    from: text(row?.lead_email),
    to: [],
    reply_event_id: text(row?.reply_event_id),
    sales_message_id: '',
    // Stored classifier output, shown so the operator can see what the system
    // made of this reply. Read verbatim; nothing here re-classifies.
    classification: text(row?.classification),
  };
}

// SALES_MESSAGES will become the durable home for NOVUS-sent sales messages.
// In Phase 2 nothing writes it; this reader exists so the merge is already
// correct when Phase 3 starts appending.
export function salesMessageToMessage(row) {
  const direction = text(row?.direction).toUpperCase();
  return {
    source: 'SALES_MESSAGES',
    direction: MESSAGE_DIRECTIONS.includes(direction) ? direction : 'UNKNOWN',
    message_type: text(row?.message_type) || 'NOVUS_MESSAGE',
    at: text(row?.sent_at) || text(row?.created_at),
    subject: text(row?.subject),
    body_text: text(row?.body_text),
    instantly_email_id: text(row?.instantly_email_id),
    thread_id: text(row?.instantly_thread_id),
    eaccount: text(row?.eaccount),
    campaign_id: '',
    lead_email: '',
    from: text(row?.eaccount),
    to: [],
    reply_event_id: text(row?.reply_event_id),
    sales_message_id: text(row?.sales_message_id),
    send_outcome: text(row?.send_outcome).toUpperCase(),
  };
}

// -- the merge ---------------------------------------------------------------

// DEDUPLICATION KEY: instantly_email_id. The same inbound reply is both a
// REPLY_EVENTS row (durable) and an Instantly email (live), and it must appear
// ONCE.
//
// PRECEDENCE: durable local data wins on every field it actually holds. The
// live copy is folded into the durable one as ENRICHMENT — it supplies exactly
// what REPLY_EVENTS has no column for (eaccount, from/to) and fills fields the
// durable row left blank. It never overwrites stored text with live text.
//
// A message with no instantly_email_id cannot be de-duplicated against
// anything, so it is kept on its own identity (reply_event_id /
// sales_message_id / a positional key) rather than being merged on a guess.
function enrich(target, live) {
  const merged = { ...target };
  if (!text(merged.eaccount) && text(live.eaccount)) merged.eaccount = live.eaccount;
  if (!text(merged.subject) && text(live.subject)) merged.subject = live.subject;
  if (!text(merged.body_text) && text(live.body_text)) merged.body_text = live.body_text;
  if (!text(merged.at) && text(live.at)) merged.at = live.at;
  if (!text(merged.thread_id) && text(live.thread_id)) merged.thread_id = live.thread_id;
  if (!text(merged.campaign_id) && text(live.campaign_id)) merged.campaign_id = live.campaign_id;
  if (!text(merged.lead_email) && text(live.lead_email)) merged.lead_email = live.lead_email;
  if (!text(merged.from) && text(live.from)) merged.from = live.from;
  if (!(merged.to || []).length && (live.to || []).length) merged.to = live.to;
  // Direction is durable-first, but a durable row that could not state one
  // takes the live, address-validated answer over staying UNKNOWN.
  if (merged.direction === 'UNKNOWN' && live.direction !== 'UNKNOWN') merged.direction = live.direction;
  merged.enriched_from_instantly = true;
  return merged;
}

// Oldest -> newest for display. A message with no parseable timestamp cannot be
// placed in the thread, so it sorts LAST (never silently to the top, which
// would read as "this happened first") with a deterministic tie-break.
function compareMessages(a, b) {
  const at = ms(a.at);
  const bt = ms(b.at);
  if (at === null && bt === null) return String(a._key).localeCompare(String(b._key));
  if (at === null) return 1;
  if (bt === null) return -1;
  if (at !== bt) return at - bt;
  return String(a._key).localeCompare(String(b._key));
}

export function buildConversation({
  instantlyMessages = [],
  replyEvents = [],
  salesMessages = [],
  outbound = null,
} = {}) {
  const warnings = [];
  const byEmailId = new Map();
  const standalone = [];

  const place = (message, fallbackKey) => {
    const emailId = text(message.instantly_email_id);
    const keyed = { ...message, _key: emailId || fallbackKey };
    if (emailId) byEmailId.set(emailId, keyed);
    else standalone.push(keyed);
    return keyed;
  };

  // Durable first, so the live pass can only enrich what is already stored.
  (replyEvents || []).forEach((row, i) => {
    place(replyEventToMessage(row), `reply:${text(row?.reply_event_id) || i}`);
  });
  (salesMessages || []).forEach((row, i) => {
    place(salesMessageToMessage(row), `sales:${text(row?.sales_message_id) || i}`);
  });

  let deduped = 0;
  (instantlyMessages || []).forEach((message, i) => {
    const emailId = text(message.instantly_email_id);
    if (emailId && byEmailId.has(emailId)) {
      byEmailId.set(emailId, enrich(byEmailId.get(emailId), message));
      deduped += 1;
      return;
    }
    place(message, `instantly:${emailId || i}`);
  });

  if (deduped) {
    warnings.push({
      code: 'deduplicated_messages',
      detail: `${deduped} live Instantly message(s) matched a stored row on instantly_email_id and were merged rather than duplicated`,
    });
  }

  const messages = [...byEmailId.values(), ...standalone];

  // ORIGINAL CAMPAIGN EMAILS. NOVUS does not durably store the campaign email
  // bodies Instantly sent, and nothing here fabricates them. When the live
  // fetch supplies them they are shown; when it does not — including when the
  // fetch failed outright — the thread carries one factual marker built from
  // OUTBOUND.instantly_added_at and nothing else.
  const hasLiveOutbound = messages.some((m) => m.source === 'INSTANTLY' && m.direction === 'OUTBOUND');
  const addedAt = text(outbound?.instantly_added_at);
  if (!hasLiveOutbound && addedAt) {
    messages.push({
      source: 'OUTBOUND',
      direction: 'OUTBOUND',
      message_type: 'CAMPAIGN_ADDED',
      at: addedAt,
      subject: '',
      body_text: '',
      instantly_email_id: '',
      thread_id: '',
      eaccount: '',
      campaign_id: '',
      lead_email: '',
      from: '',
      to: [],
      reply_event_id: '',
      sales_message_id: '',
      _key: `outbound:${text(outbound?.outbound_id)}`,
    });
  }

  const unknownDirection = messages.filter((m) => m.direction === 'UNKNOWN').length;
  if (unknownDirection) {
    warnings.push({
      code: 'unknown_direction',
      detail: `${unknownDirection} message(s) could not be attributed to NOVUS or the prospect and are shown as UNKNOWN`,
    });
  }
  const undatable = messages.filter((m) => ms(m.at) === null).length;
  if (undatable) {
    warnings.push({
      code: 'undated_messages',
      detail: `${undatable} message(s) carry no readable timestamp and are listed last`,
    });
  }

  messages.sort(compareMessages);
  // _key is an internal ordering handle, never part of the payload.
  const ordered = messages.map(({ _key, ...rest }) => rest);

  return {
    messages: ordered,
    original_campaign_emails_available: hasLiveOutbound,
    warnings,
  };
}

export const _internal = { seedLeadEmail, messageTypeFor, enrich, compareMessages, ms };
