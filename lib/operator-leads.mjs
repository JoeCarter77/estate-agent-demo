// lib/operator-leads.mjs - PURE aggregation for the NOVUS Acquisition Command
// Centre (Phase 1, read-only).
//
// PURITY CONTRACT - this module:
//   - performs no I/O of any kind (no fetch, no Sheets read, no Sheets write)
//   - imports no writer function and no AI client
//   - never mutates its input tables
//   - is fully deterministic for a given (tables, now)
//
// It takes tables ALREADY loaded by the caller and returns the operator view.
// Every field is either stored verbatim or derived by a rule written down in
// this file. Nothing is inferred, guessed or invented: an unavailable field
// comes back as '' or null.
//
// The first import below is a NAMED PURE PREDICATE. lib/contact-resolution.mjs
// does contain write-side functions, but none of them is imported here, and
// that module performs no I/O at load time (every credential read and every
// API call in its own dependencies is lazy, inside a function body).
// Re-declaring GENERIC_LOCAL_PARTS here instead would let the operator's idea
// of a "generic inbox" drift away from the resolver's, which is worse.
import { isGenericEmail } from './contact-resolution.mjs';

// Enum surfaces mirrored from lib/reply-router.mjs, imported as values rather
// than re-typed so the operator can never disagree with the router about what
// an action_status or a priority means.
import { ACTION_STATUSES, PRIORITIES } from './reply-router.mjs';

export const OPERATOR_TABS = [
  'OUTBOUND', 'REPLY_EVENTS', 'DEMOS', 'AGENCIES', 'INTELLIGENCE', 'PERSONALISATION', 'PROBES',
];

// The states this module can produce, in precedence order (highest first).
// Nothing outside this list is ever emitted.
export const CURRENT_STATES = [
  'MEETING_BOOKED',
  'OPTED_OUT',
  'NOT_INTERESTED',
  'NURTURE',
  'DEMO_ENGAGED',
  'DEMO_SENT',
  'REVIEW_REQUIRED',
  'REPLIED',
  'SEQUENCE_RUNNING',
  'READY',
  // Terminal fallback. Reached only by an OUTBOUND row that satisfies no rule
  // above - in practice a row with a blank instantly_lead_id whose
  // outbound_status is ERROR or SUPPRESSED rather than READY. Calling such a
  // row READY would be a lie, so it is named for what it is and a warning is
  // recorded. NOT_QUEUED is deliberately NOT implemented in V0.1: this
  // endpoint is OUTBOUND-journey-centric and a journey with no OUTBOUND row
  // has no outbound_id to key a lead on.
  'UNKNOWN',
];

export const DEMO_ENGAGEMENTS = ['BOOKED', 'CTA_CLICKED', 'VIEWED', 'NONE'];
export const CONTACT_TYPES = ['OWNER_DIRECT', 'NAMED_HUMAN', 'GENERIC', 'UNKNOWN'];
export const DECISION_MAKER_CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];

// Reply rows in these action_status values are a human's problem by definition.
const HUMAN_ACTION_STATUSES = new Set(['REVIEW', 'FAILED']);
// ...and these next_actions are a human's problem while still PENDING.
const HUMAN_PENDING_NEXT_ACTIONS = new Set(['HUMAN_REPLY', 'BOOK_MEETING', 'MANUAL_REVIEW']);

const PRIORITY_RANK = new Map(PRIORITIES.map((p, i) => [p, i])); // CRITICAL=0 ... LOW=3

// The stamp lib/reply-send-demo.mjs appends to REPLY_EVENTS.notes on a
// successful send. Matched, never written, and deliberately duplicated as a
// literal here so this module imports nothing from the send path.
const SEND_DEMO_NOTE_PATTERN = /SEND_DEMO sent\b/;

// -- small pure helpers ------------------------------------------------------

function text(value) {
  return String(value ?? '').trim();
}

function nonblank(value) {
  return text(value).length > 0;
}

// IDs are trimmed on BOTH sides of every join: a hand-edited cell with a
// trailing space must not silently break a lead's reply history.
function id(value) {
  return text(value);
}

function lower(value) {
  return text(value).toLowerCase();
}

// Returns epoch ms, or null when the value is blank or unparseable. Never
// throws, never guesses a date.
function ts(value) {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function intOrZero(value) {
  const parsed = parseInt(text(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function rowObject(header, row) {
  const obj = {};
  (header || []).forEach((key, i) => { obj[key] = row[i] ?? ''; });
  return obj;
}

// Data records of a table, skipping the header, the SCHEMA NOTE row and any
// row with a blank id - the same rule lib/sheets.mjs getRecords applies.
function recordsOf(table, idColumn) {
  const header = table?.header || [];
  const rows = table?.rows || [];
  const idIndex = header.indexOf(idColumn);
  const out = [];
  rows.forEach((row, i) => {
    const value = id(row[idIndex]);
    if (idIndex < 0 || !value || value === 'SCHEMA NOTE') return;
    out.push({ rowNumber: i + 2, obj: rowObject(header, row) });
  });
  return out;
}

// First-wins index with duplicate reporting. Duplicates are surfaced as
// warnings rather than thrown: the operator page must still render when the
// workbook has a stray row.
function indexBy(records, keyOf) {
  const byKey = new Map();
  const duplicates = [];
  for (const record of records) {
    const key = keyOf(record.obj);
    if (!key) continue;
    if (byKey.has(key)) duplicates.push(key);
    else byKey.set(key, record.obj);
  }
  return { byKey, duplicates };
}

function groupBy(records, keyOf) {
  const byKey = new Map();
  for (const record of records) {
    const key = keyOf(record.obj);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(record.obj);
  }
  return byKey;
}

// -- contact derivation (no AI, no Hunter, no network) -----------------------

// Conservative: does the stored contact name plausibly name the same person as
// the stored owner/MD? Only used to promote a contact to OWNER_DIRECT, so a
// false positive is the expensive direction - require shared tokens of real
// length, never a single initial.
export function namesLikelySamePerson(a, b) {
  const tokensOf = (value) => lower(value)
    .replace(/[^a-z\s'-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  const left = tokensOf(a);
  const right = new Set(tokensOf(b));
  if (!left.length || !right.size) return false;
  const shared = left.filter((t) => right.has(t));
  // Two shared tokens (first + last) is a match; one shared token is a match
  // only when both names are a single token.
  if (shared.length >= 2) return true;
  return shared.length === 1 && left.length === 1 && right.size === 1;
}

export function deriveContactType({ email, contactName, ownerName, resolutionStatus }) {
  if (!nonblank(email)) return 'UNKNOWN';
  if (isGenericEmail(email)) return 'GENERIC';
  if (nonblank(ownerName) && namesLikelySamePerson(contactName, ownerName)) return 'OWNER_DIRECT';
  if (nonblank(contactName) && !text(contactName).includes('@')) return 'NAMED_HUMAN';
  if (text(resolutionStatus).toUpperCase() === 'RESOLVED_DIRECT') return 'NAMED_HUMAN';
  return 'UNKNOWN';
}

export function deriveDecisionMakerConfidence({ contactType, verificationStatus }) {
  const verified = text(verificationStatus).toUpperCase() === 'VALID';
  switch (contactType) {
    case 'OWNER_DIRECT': return verified ? 'HIGH' : 'MEDIUM';
    case 'NAMED_HUMAN': return verified ? 'MEDIUM' : 'LOW';
    case 'GENERIC': return 'LOW';
    default: return 'UNKNOWN';
  }
}

// -- reply-event derivation --------------------------------------------------

// Newest first. received_at is the event's own clock; processed_at is when
// NOVUS saw it. A row with neither sorts last but is never dropped.
export function sortReplyEventsNewestFirst(events) {
  return [...(events || [])].sort((a, b) => {
    const at = ts(a.received_at) ?? ts(a.processed_at) ?? -Infinity;
    const bt = ts(b.received_at) ?? ts(b.processed_at) ?? -Infinity;
    if (at !== bt) return bt - at;
    // Deterministic tie-break so two rows on the same timestamp never swap
    // between two otherwise identical requests.
    return id(b.reply_event_id).localeCompare(id(a.reply_event_id));
  });
}

// The row-level rule. Kept separate so the reason a lead needs a human is the
// same fact the UI can point at.
export function replyRowNeedsHuman(row) {
  const status = text(row?.action_status).toUpperCase();
  const nextAction = text(row?.next_action).toUpperCase();
  const suppression = text(row?.suppression_type).toUpperCase();
  if (HUMAN_ACTION_STATUSES.has(status)) return true;
  if (status === 'PENDING' && HUMAN_PENDING_NEXT_ACTIONS.has(nextAction)) return true;
  if (status === 'PENDING' && suppression === 'PERMANENT') return true;
  return false;
}

export function deriveNeedsHuman(replyEvents) {
  return (replyEvents || []).some(replyRowNeedsHuman);
}

// SEND_DEMO completion evidence, exactly as lib/reply-send-demo.mjs writes it:
// next_action SEND_DEMO, action_status COMPLETED, plus a completion mark (the
// notes stamp it writes, or action_completed_at). Nothing here re-runs or
// re-evaluates the send gate - it only reads the marks already on the row.
export function sendDemoCompletedAt(row) {
  if (text(row?.next_action).toUpperCase() !== 'SEND_DEMO') return null;
  if (text(row?.action_status).toUpperCase() !== 'COMPLETED') return null;
  const marker = SEND_DEMO_NOTE_PATTERN.test(text(row?.notes));
  const completedAt = ts(row?.action_completed_at);
  if (!marker && completedAt === null) return null;
  return completedAt;
}

// Was a demo sent on this journey, and when. `at` stays null when the row
// carries the notes stamp but no parseable action_completed_at.
export function findSendDemoEvidence(replyEvents) {
  let latest = null;
  let found = false;
  for (const row of replyEvents || []) {
    if (text(row?.next_action).toUpperCase() !== 'SEND_DEMO') continue;
    if (text(row?.action_status).toUpperCase() !== 'COMPLETED') continue;
    const marker = SEND_DEMO_NOTE_PATTERN.test(text(row?.notes));
    const completedAt = ts(row?.action_completed_at);
    if (!marker && completedAt === null) continue;
    found = true;
    if (completedAt !== null && (latest === null || completedAt > latest)) latest = completedAt;
  }
  return { sent: found, at: latest };
}

// -- demo derivation ---------------------------------------------------------

export function deriveDemoEngagement(demo) {
  if (!demo) return 'NONE';
  if (nonblank(demo.meeting_booked_at)) return 'BOOKED';
  if (nonblank(demo.cta_clicked_at)) return 'CTA_CLICKED';
  if (nonblank(demo.first_viewed_at) || nonblank(demo.last_viewed_at) || intOrZero(demo.view_count) > 0) return 'VIEWED';
  return 'NONE';
}

// -- current state -----------------------------------------------------------

// Deterministic, evaluated strictly top-down. Every input is a stored value.
// Returns { state, reason }; reason is the rule that fired, for the UI and the
// tests. `replyEvents` must already be newest-first.
export function deriveCurrentState({ outbound, replyEvents, demo }) {
  const events = replyEvents || [];
  const latest = events[0] || null;
  const classification = text(latest?.classification).toUpperCase();
  const suppression = text(latest?.suppression_type).toUpperCase();

  if (demo && nonblank(demo.meeting_booked_at)) {
    return { state: 'MEETING_BOOKED', reason: 'DEMOS.meeting_booked_at is set' };
  }
  if (suppression === 'PERMANENT') {
    return { state: 'OPTED_OUT', reason: 'latest reply suppression_type is PERMANENT' };
  }
  if (classification === 'NOT_INTERESTED') {
    return { state: 'NOT_INTERESTED', reason: 'latest reply classification is NOT_INTERESTED' };
  }
  if (classification === 'NOT_NOW') {
    return { state: 'NURTURE', reason: 'latest reply classification is NOT_NOW' };
  }

  const sendDemo = findSendDemoEvidence(events);

  if (demo && nonblank(demo.cta_clicked_at)) {
    return { state: 'DEMO_ENGAGED', reason: 'DEMOS.cta_clicked_at is set' };
  }
  // A view only means engagement when the demo was actually sent AND the view
  // is not older than the send. Without that evidence the view could be our
  // own pre-send check, so it is deliberately not promoted.
  if (demo && nonblank(demo.first_viewed_at) && sendDemo.sent) {
    const viewedAt = ts(demo.first_viewed_at);
    if (viewedAt !== null && (sendDemo.at === null || viewedAt >= sendDemo.at)) {
      return { state: 'DEMO_ENGAGED', reason: 'demo viewed at or after the recorded SEND_DEMO completion' };
    }
  }
  if (sendDemo.sent) {
    return { state: 'DEMO_SENT', reason: 'REPLY_EVENTS carries SEND_DEMO completion evidence' };
  }

  const reviewRow = events.find((row) => {
    if (HUMAN_ACTION_STATUSES.has(text(row.action_status).toUpperCase())) return true;
    return text(row.next_action).toUpperCase() === 'MANUAL_REVIEW';
  });
  if (reviewRow) {
    return { state: 'REVIEW_REQUIRED', reason: 'a reply row is REVIEW/FAILED or routed to MANUAL_REVIEW' };
  }

  if (events.length) {
    return { state: 'REPLIED', reason: 'REPLY_EVENTS has a row for this journey' };
  }
  if (nonblank(outbound?.instantly_lead_id)) {
    return { state: 'SEQUENCE_RUNNING', reason: 'OUTBOUND.instantly_lead_id is set' };
  }
  if (text(outbound?.outbound_status).toUpperCase() === 'READY') {
    return { state: 'READY', reason: 'OUTBOUND is READY and not yet handed to Instantly' };
  }
  return {
    state: 'UNKNOWN',
    reason: `no rule matched (outbound_status=${text(outbound?.outbound_status) || '(blank)'}, no instantly_lead_id)`,
  };
}

// -- latest event ------------------------------------------------------------

// Only timestamps that are actually STORED are considered. There is no email
// open/click telemetry in this workbook, so none is invented.
export function deriveLatestEvent({ outbound, replyEvents, demo }) {
  const events = replyEvents || [];
  const candidates = [];
  const push = (type, value, summary) => {
    const at = ts(value);
    if (at === null) return;
    candidates.push({ type, at, at_iso: text(value), summary });
  };

  const latestReply = events[0] || null;
  if (latestReply) {
    const classification = text(latestReply.classification) || 'unclassified';
    push('REPLY_RECEIVED', latestReply.received_at || latestReply.processed_at,
      `Reply received (${classification})`);
  }
  if (demo) {
    push('MEETING_BOOKED', demo.meeting_booked_at, 'Meeting booked from the demo');
    push('CTA_CLICKED', demo.cta_clicked_at, 'Demo CTA clicked');
    push('DEMO_VIEWED', demo.last_viewed_at, 'Demo viewed');
  }
  const sendDemoRow = events.find((row) => sendDemoCompletedAt(row) !== null);
  if (sendDemoRow) push('DEMO_SENT', sendDemoRow.action_completed_at, 'Demo link sent in reply');
  if (outbound) push('ADDED_TO_CAMPAIGN', outbound.instantly_added_at, 'Added to the Instantly campaign');

  if (!candidates.length) return { type: null, at: null, summary: '' };
  candidates.sort((a, b) => b.at - a.at);
  const winner = candidates[0];
  return { type: winner.type, at: winner.at_iso, summary: winner.summary };
}

// -- priority ----------------------------------------------------------------

// The most severe priority stored on any relevant reply row. Never invented
// for a lead that has not replied - those come back null and sort last.
export function derivePriority(replyEvents) {
  let best = null;
  for (const row of replyEvents || []) {
    const value = text(row.priority).toUpperCase();
    if (!PRIORITY_RANK.has(value)) continue;
    if (best === null || PRIORITY_RANK.get(value) < PRIORITY_RANK.get(best)) best = value;
  }
  return best;
}

// -- primary journey selection -----------------------------------------------

// An agency with several OUTBOUND rows gets ONE primary journey and keeps the
// rest visible under other_journeys. Nothing is dropped.
//   1. prefer a row with a non-blank instantly_lead_id
//   2. among those, the latest instantly_added_at
//   3. otherwise the latest updated_at
//   4. deterministic tie-break on outbound_id so two identical requests agree
export function selectPrimaryJourney(rows) {
  const ranked = [...rows].sort((a, b) => {
    const aHasLead = nonblank(a.instantly_lead_id) ? 1 : 0;
    const bHasLead = nonblank(b.instantly_lead_id) ? 1 : 0;
    if (aHasLead !== bHasLead) return bHasLead - aHasLead;
    if (aHasLead === 1) {
      const at = ts(a.instantly_added_at) ?? -Infinity;
      const bt = ts(b.instantly_added_at) ?? -Infinity;
      if (at !== bt) return bt - at;
    }
    const au = ts(a.updated_at) ?? -Infinity;
    const bu = ts(b.updated_at) ?? -Infinity;
    if (au !== bu) return bu - au;
    return id(a.outbound_id).localeCompare(id(b.outbound_id));
  });
  return { primary: ranked[0], others: ranked.slice(1) };
}

// -- the aggregation ---------------------------------------------------------

export function buildOperatorLeads(tables, { now = new Date().toISOString() } = {}) {
  const warnings = [];
  const warn = (code, detail) => warnings.push({ code, detail });

  for (const tab of OPERATOR_TABS) {
    if (!tables?.[tab]) warn('missing_tab', `${tab} was not supplied; fields sourced from it are blank`);
  }

  const outboundRecords = recordsOf(tables?.OUTBOUND, 'outbound_id');
  const replyRecords = recordsOf(tables?.REPLY_EVENTS, 'reply_event_id');
  const demoRecords = recordsOf(tables?.DEMOS, 'demo_id');
  const agencyRecords = recordsOf(tables?.AGENCIES, 'agency_id');
  const intelligenceRecords = recordsOf(tables?.INTELLIGENCE, 'intelligence_id');
  const personalisationRecords = recordsOf(tables?.PERSONALISATION, 'probe_id');
  const probeRecords = recordsOf(tables?.PROBES, 'probe_id');

  // In-memory indexes; every key is trimmed on both sides. repo.findById() is
  // never used here - one pass per tab, then O(1) lookups.
  const agencies = indexBy(agencyRecords, (o) => id(o.agency_id));
  const probes = indexBy(probeRecords, (o) => id(o.probe_id));
  const personalisation = indexBy(personalisationRecords, (o) => id(o.probe_id));
  const intelligence = indexBy(intelligenceRecords, (o) => id(o.probe_id));
  // DEMOS is joined on probe_id, deliberately NOT on the demo_slug copied onto
  // OUTBOUND: the slug is a copy and can go stale, probe_id is the identity.
  const demos = indexBy(demoRecords, (o) => id(o.probe_id));

  for (const [label, index] of [
    ['AGENCIES.agency_id', agencies], ['PROBES.probe_id', probes],
    ['PERSONALISATION.probe_id', personalisation], ['INTELLIGENCE.probe_id', intelligence],
    ['DEMOS.probe_id', demos],
  ]) {
    if (index.duplicates.length) {
      warn('duplicate_rows',
        `${label} has duplicate values (first row wins): ${[...new Set(index.duplicates)].join(', ')}`);
    }
  }

  // REPLY_EVENTS joins on outreach_id, which stores OUTBOUND.outbound_id.
  const repliesByOutreachId = groupBy(replyRecords, (o) => id(o.outreach_id));
  const knownOutboundIds = new Set(outboundRecords.map((r) => id(r.obj.outbound_id)));
  const orphanReplyEvents = replyRecords.filter((r) => !knownOutboundIds.has(id(r.obj.outreach_id)));
  if (orphanReplyEvents.length) {
    warn('orphan_reply_events',
      `${orphanReplyEvents.length} REPLY_EVENTS row(s) have no matching OUTBOUND.outbound_id and are attached to no lead`);
  }

  // Group journeys by agency. A row with a blank agency_id becomes its own
  // group keyed on its outbound_id, so it is never silently merged with an
  // unrelated row.
  const byAgency = new Map();
  for (const { obj } of outboundRecords) {
    const key = id(obj.agency_id) || ` outbound:${id(obj.outbound_id)}`;
    if (!nonblank(obj.agency_id)) {
      warn('outbound_missing_agency_id', `OUTBOUND ${id(obj.outbound_id)} has a blank agency_id`);
    }
    if (!byAgency.has(key)) byAgency.set(key, []);
    byAgency.get(key).push(obj);
  }

  const leads = [];
  for (const rows of byAgency.values()) {
    const { primary, others } = selectPrimaryJourney(rows);
    if (others.length) {
      warn('multiple_journeys',
        `agency ${id(primary.agency_id) || '(blank)'} has ${rows.length} OUTBOUND rows; primary=${id(primary.outbound_id)}`);
    }
    leads.push(buildLead({
      outbound: primary,
      others,
      agencies, probes, personalisation, intelligence, demos,
      repliesByOutreachId,
    }));
  }

  // needs_human first, then priority (CRITICAL -> LOW, unknown last), then the
  // newest meaningful activity, then agency name for a stable order.
  leads.sort(compareLeads);

  const counts = countLeads(leads);
  counts.orphan_reply_events = orphanReplyEvents.length;
  counts.other_journeys = leads.reduce((sum, lead) => sum + lead.other_journeys.length, 0);

  return { leads, counts, warnings, generated_at: now };
}

function buildLead({ outbound, others, agencies, probes, personalisation, intelligence, demos, repliesByOutreachId }) {
  const outboundId = id(outbound.outbound_id);
  const agencyId = id(outbound.agency_id);
  const probeId = id(outbound.probe_id);

  const agency = agencies.byKey.get(agencyId) || null;
  const probe = probes.byKey.get(probeId) || null;
  const intel = intelligence.byKey.get(probeId) || null;
  const person = personalisation.byKey.get(probeId) || null;
  const demo = demos.byKey.get(probeId) || null;

  const replyEvents = sortReplyEventsNewestFirst(repliesByOutreachId.get(outboundId) || []);
  const latestReply = replyEvents[0] || null;

  // OUTBOUND carries compiled COPIES of the contact fields; AGENCIES is the
  // live source. Prefer the live AGENCIES value, fall back to the compiled one.
  const contactEmail = text(agency?.outreach_contact_email) || text(outbound.outreach_contact_email);
  const contactName = text(agency?.outreach_contact_name) || text(outbound.outreach_contact_name);
  const verification = text(agency?.email_verification_status) || text(outbound.email_verification_status);
  const resolutionStatus = text(agency?.contact_resolution_status);
  const ownerName = text(agency?.owner_md);

  const contactType = deriveContactType({ email: contactEmail, contactName, ownerName, resolutionStatus });
  const decisionMakerConfidence = deriveDecisionMakerConfidence({
    contactType, verificationStatus: verification,
  });

  const { state, reason } = deriveCurrentState({ outbound, replyEvents, demo });

  const demoSlug = text(demo?.demo_slug) || text(outbound.demo_slug);
  const demoUrl = text(outbound.demo_url) || (demoSlug ? `https://demo.getnovus.co.uk/${demoSlug}` : '');
  // EVERY operator-facing demo link is a preview link. api/demo.js counts any
  // non-preview load as a prospect view, so opening the plain URL from the
  // operator console would contaminate the engagement data this page reports.
  const previewUrl = demoUrl ? `${demoUrl}${demoUrl.includes('?') ? '&' : '?'}preview=1` : '';

  return {
    outbound_id: outboundId,
    agency_id: agencyId,
    probe_id: probeId,
    agency_name: text(outbound.clean_agency_name) || text(agency?.agency_name) || '',

    contact: {
      name: contactName,
      email: contactEmail,
      email_verification_status: verification,
      resolution_status: resolutionStatus,
      contact_type: contactType,
      decision_maker_confidence: decisionMakerConfidence,
    },

    current_state: state,
    current_state_reason: reason,
    priority: derivePriority(replyEvents),
    needs_human: deriveNeedsHuman(replyEvents),

    outreach: {
      instantly_lead_id: text(outbound.instantly_lead_id),
      instantly_added_at: text(outbound.instantly_added_at),
      outbound_status: text(outbound.outbound_status),
      handed_to_instantly: nonblank(outbound.instantly_lead_id),
      last_error: text(outbound.last_error),
    },

    latest_event: deriveLatestEvent({ outbound, replyEvents, demo }),

    next_action: {
      type: text(latestReply?.next_action) || null,
      status: text(latestReply?.action_status) || null,
      requires_human: latestReply ? replyRowNeedsHuman(latestReply) : false,
      due_at: null,
    },

    reply: latestReply ? {
      reply_event_id: text(latestReply.reply_event_id),
      classification: text(latestReply.classification),
      confidence: text(latestReply.confidence),
      classifier_reason: text(latestReply.classifier_reason),
      suppression_type: text(latestReply.suppression_type),
      text: text(latestReply.cleaned_reply_text) || text(latestReply.body_text),
      received_at: text(latestReply.received_at),
      reply_count: replyEvents.length,
      error: text(latestReply.error),
      notes: text(latestReply.notes),
    } : {
      reply_event_id: '', classification: '', confidence: '', classifier_reason: '',
      suppression_type: '', text: '', received_at: '', reply_count: 0, error: '', notes: '',
    },

    demo: {
      slug: demoSlug,
      url: demoUrl,
      preview_url: previewUrl,
      status: text(demo?.demo_status),
      first_viewed_at: text(demo?.first_viewed_at),
      last_viewed_at: text(demo?.last_viewed_at),
      // Soft signal: api/demo.js counts ANY non-preview load. Never treated as
      // proof of prospect interest on its own.
      view_count: intOrZero(demo?.view_count),
      cta_clicked_at: text(demo?.cta_clicked_at),
      meeting_booked_at: text(demo?.meeting_booked_at),
      engagement: deriveDemoEngagement(demo),
    },

    // PROBE EVIDENCE - deliberately kept apart from the sales fields above.
    // This is what the probe observed about the agency, not what our outreach
    // did to them. The two must not be read as one story.
    probe_summary: {
      probe_reference: text(probe?.probe_reference) || text(demo?.probe_reference),
      grade: text(intel?.grade) || text(demo?.grade),
      grade_reason: text(intel?.grade_reason),
      human_contact: text(intel?.human_contact) || text(demo?.human_contact),
      response_hours: text(intel?.response_hours) || text(demo?.response_hours),
      main_finding: text(demo?.main_finding),
      email_observation: text(outbound.email_observation) || text(person?.email_observation),
      property_street: text(outbound.property_street) || text(probe?.property_street) || text(probe?.property_address),
    },

    other_journeys: others.map((row) => ({
      outbound_id: id(row.outbound_id),
      probe_id: id(row.probe_id),
      outbound_status: text(row.outbound_status),
      instantly_lead_id: text(row.instantly_lead_id),
      instantly_added_at: text(row.instantly_added_at),
      updated_at: text(row.updated_at),
      property_street: text(row.property_street),
    })),
  };
}

function priorityRankOf(lead) {
  return lead.priority && PRIORITY_RANK.has(lead.priority)
    ? PRIORITY_RANK.get(lead.priority)
    : PRIORITIES.length;
}

export function compareLeads(a, b) {
  if (a.needs_human !== b.needs_human) return a.needs_human ? -1 : 1;
  const ap = priorityRankOf(a);
  const bp = priorityRankOf(b);
  if (ap !== bp) return ap - bp;
  const at = ts(a.latest_event?.at) ?? -Infinity;
  const bt = ts(b.latest_event?.at) ?? -Infinity;
  if (at !== bt) return bt - at;
  return String(a.agency_name || '').localeCompare(String(b.agency_name || ''));
}

function countLeads(leads) {
  const byState = Object.fromEntries(CURRENT_STATES.map((s) => [s, 0]));
  const counts = {
    total: leads.length,
    needs_attention: 0,
    sequence_running: 0,
    replied: 0,
    demo_engaged: 0,
    meetings: 0,
    by_state: byState,
  };
  for (const lead of leads) {
    if (lead.needs_human) counts.needs_attention += 1;
    if (Object.prototype.hasOwnProperty.call(byState, lead.current_state)) byState[lead.current_state] += 1;
    if (lead.outreach.handed_to_instantly) counts.sequence_running += 1;
    if (lead.reply.reply_count > 0) counts.replied += 1;
    if (lead.demo.engagement === 'CTA_CLICKED' || lead.demo.engagement === 'BOOKED'
      || lead.current_state === 'DEMO_ENGAGED') {
      counts.demo_engaged += 1;
    }
    if (nonblank(lead.demo.meeting_booked_at)) counts.meetings += 1;
  }
  return counts;
}

export const _internal = { recordsOf, indexBy, groupBy, ts, ACTION_STATUSES };
