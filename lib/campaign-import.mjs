// lib/campaign-import.mjs — bringing an Instantly campaign that EXISTED BEFORE
// the NOVUS campaign layer under NOVUS control, without recreating it.
//
// PURE below the I/O boundary: this module parses Instantly exports, matches
// leads to the NOVUS master data, maps them to CAMPAIGN_MEMBERS /
// CAMPAIGN_EVENTS rows and builds the reconciliation report. It reads no
// tab and calls no API; lib/campaign-handlers.mjs does the loading and the
// writes (campaign-discover / campaign-link / campaign-import-activity /
// campaign-reconciliation).
//
// LINKING NEVER TOUCHES INSTANTLY STATE. The campaign keeps whatever status it
// has there (mirrored into NOVUS), no lead is added, nothing is activated,
// paused or rescheduled. GET is the only verb used.
//
// MATCHING is by reliable identifier, in this order, and stops at the first
// hit that is unique:
//   1. OUTBOUND.outreach_contact_email  — the address NOVUS itself uploaded
//      (carries agency_id, outbound_id, probe_id)
//   2. OUTBOUND.instantly_lead_id       — the id Instantly returned at upload
//   3. CONTACTS.email
//   4. AGENCIES.outreach_contact_email / primary_contact_email
//   5. DEMOS.demo_slug from the lead's demo_url custom variable
//   6. email domain, ONLY when exactly one agency owns that domain and no
//      named contact contradicts it; several agencies on one domain
//      (multi-branch, franchises) → AMBIGUOUS with the candidates listed
// Anything else is UNMATCHED. Ambiguous and unmatched leads are still
// imported (so their history is kept and their address is suppressed for
// future campaigns) but carry no agency_id until a human resolves them.
//
// SENDS ARE NEVER INFERRED. A lead's emails_sent_count, steps and dates come
// from actual send records (Instantly /emails ue_type 1, or "Email Sent" rows
// of the activity export) — never from the lead's status or last_step.

import { normaliseInstantlyEventType, interestLabel, leadStatusLabel, newCampaignMemberId, novusDedupeKey, reconcileDedupeKey, PROVIDER_EVENT_TYPES } from './campaign-store.mjs';

const text = (value) => String(value ?? '').trim();
const lower = (value) => text(value).toLowerCase();
const upper = (value) => text(value).toUpperCase();
const ts = (value) => { const n = Date.parse(text(value)); return Number.isFinite(n) ? n : null; };

// ── CSV ───────────────────────────────────────────────────────────────────
// RFC 4180: quoted fields, doubled quotes, embedded newlines. Instantly's
// exports start with a UTF-8 BOM.
export function parseCsv(input) {
  const src = String(input ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => text(h));
  return rows.slice(1).filter((r) => r.some((v) => text(v))).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

function domainOf(email) {
  const at = lower(email).indexOf('@');
  return at >= 0 ? lower(email).slice(at + 1) : '';
}
function slugOf(url) {
  const m = text(url).match(/^https?:\/\/[^/]+\/([^/?#]+)/);
  return m ? m[1] : '';
}

// Instantly "Export leads" CSV → the same shape POST /leads/list returns.
export function parseInstantlyLeadsCsv(input) {
  return parseCsv(input).map((r) => ({
    id: text(r.id),
    email: lower(r.contact || r.email || r.Email),
    campaign: text(r.campaign),
    status: text(r.status) === '' ? null : Number(r.status),
    lt_interest_status: text(r.lt_interest_status) === '' ? null : Number(r.lt_interest_status),
    email_reply_count: Number(r.email_reply_count) || 0,
    email_open_count: Number(r.email_open_count) || 0,
    email_click_count: Number(r.email_click_count) || 0,
    timestamp_created: text(r.timestamp_created),
    timestamp_updated: text(r.timestamp_updated),
    timestamp_last_contact: text(r.timestamp_last_contact),
    timestamp_last_reply: text(r.timestamp_last_reply),
    timestamp_last_open: text(r.timestamp_last_open),
    timestamp_last_interest_change: text(r.timestamp_last_interest_change),
    verification_status: text(r.verification_status),
    first_name: text(r['First Name'] || r.first_name),
    last_name: text(r['Last Name'] || r.last_name),
    company_name: text(r.companyName || r.company_name),
    company_domain: lower(r.company_domain),
    lead_status_label: text(r['Lead Status']),
    payload: {
      demo_url: text(r.demo_url), property_street: text(r.property_street), probe_date: text(r.probe_date), probe_time: text(r.probe_time),
      email_observation: text(r.email_observation), email_commercial_hook: text(r.email_commercial_hook), website: text(r.website),
    },
  })).filter((l) => l.email || l.id);
}

// Instantly "Campaign activity" CSV: Date, Action, Sender Email, Recipient
// Email, Step, Link Clicked.
export const ACTIVITY_ACTIONS = Object.freeze({
  'email sent': 'EMAIL_SENT',
  'email opened': 'EMAIL_OPENED',
  'opened': 'EMAIL_OPENED',
  'link clicked': 'LINK_CLICKED',
  'reply received': 'REPLY_RECEIVED',
  'auto reply': 'AUTO_REPLY_RECEIVED',
  'auto-reply': 'AUTO_REPLY_RECEIVED',
  'bounce': 'EMAIL_BOUNCED',
  'bounced': 'EMAIL_BOUNCED',
  'unsubscribe': 'LEAD_UNSUBSCRIBED',
  'unsubscribed': 'LEAD_UNSUBSCRIBED',
  'interested': 'LEAD_INTERESTED',
  'not interested': 'LEAD_NOT_INTERESTED',
  'meeting booked': 'LEAD_MEETING_BOOKED',
  'unibox reply': 'MANUAL_REPLY_SENT',
});
export function parseInstantlyActivityCsv(input) {
  return parseCsv(input).map((r) => {
    const action = lower(r.Action || r.action);
    const step = text(r.Step || r.step).match(/(\d+)/);
    return {
      at: text(r.Date || r.date || r.timestamp),
      action,
      event_type: ACTIVITY_ACTIONS[action] || normaliseInstantlyEventType(action.replace(/\s+/g, '_')),
      sender: lower(r['Sender Email'] || r.sender),
      recipient: lower(r['Recipient Email'] || r.recipient),
      step: step ? step[1] : '',
      link: text(r['Link Clicked'] || r.link),
    };
  }).filter((e) => e.at && e.recipient && e.event_type);
}

// ── matching ──────────────────────────────────────────────────────────────
function records(table, idColumn) {
  const header = table?.header || [];
  const at = header.indexOf(idColumn);
  if (at < 0) return [];
  return (table.rows || []).flatMap((row) => {
    const id = text(row[at]);
    if (!id || id === 'SCHEMA NOTE') return [];
    return [Object.fromEntries(header.map((key, i) => [key, row[i] ?? '']))];
  });
}
function add(map, key, value) {
  const k = lower(key);
  if (!k) return;
  if (!map.has(k)) map.set(k, []);
  map.get(k).push(value);
}

export function buildNovusMatchIndex(tables) {
  const agencies = records(tables.AGENCIES, 'agency_id');
  const agencyById = new Map(agencies.map((a) => [text(a.agency_id), a]));
  const outboundByEmail = new Map();
  const outboundByLeadId = new Map();
  for (const row of records(tables.OUTBOUND, 'outbound_id')) {
    const ref = { agency_id: text(row.agency_id), outbound_id: text(row.outbound_id), probe_id: text(row.probe_id), contact_id: '' };
    add(outboundByEmail, row.outreach_contact_email, ref);
    add(outboundByLeadId, row.instantly_lead_id, ref);
  }
  const contactsByEmail = new Map();
  for (const row of records(tables.CONTACTS, 'contact_id')) {
    add(contactsByEmail, row.email, { agency_id: text(row.agency_id), contact_id: text(row.contact_id), outbound_id: '', probe_id: '' });
  }
  const agenciesByEmail = new Map();
  const agenciesByDomain = new Map();
  for (const a of agencies) {
    const ref = { agency_id: text(a.agency_id), contact_id: '', outbound_id: '', probe_id: '' };
    add(agenciesByEmail, a.outreach_contact_email, ref);
    if (lower(a.primary_contact_email) !== lower(a.outreach_contact_email)) add(agenciesByEmail, a.primary_contact_email, ref);
    for (const d of new Set([domainOf(a.outreach_contact_email), domainOf(a.primary_contact_email), lower(a.domain), domainOf(text(a.website).replace(/^https?:\/\//, 'x@').replace(/^x@www\./, 'x@'))].filter(Boolean))) {
      add(agenciesByDomain, d, ref);
    }
  }
  const demosBySlug = new Map();
  for (const row of records(tables.DEMOS, 'demo_id')) {
    add(demosBySlug, row.demo_slug, { agency_id: text(row.agency_id), contact_id: '', outbound_id: '', probe_id: text(row.probe_id) });
  }
  return { agencyById, outboundByEmail, outboundByLeadId, contactsByEmail, agenciesByEmail, agenciesByDomain, demosBySlug };
}

function uniqueAgency(refs) {
  const ids = new Set((refs || []).map((r) => r.agency_id).filter(Boolean));
  return ids.size === 1 ? (refs || []).find((r) => r.agency_id) : null;
}
function candidatesOf(refs, index) {
  const seen = new Set();
  return (refs || []).filter((r) => r.agency_id && !seen.has(r.agency_id) && seen.add(r.agency_id)).map((r) => ({
    agency_id: r.agency_id, agency_name: text(index.agencyById.get(r.agency_id)?.clean_agency_name || index.agencyById.get(r.agency_id)?.agency_name),
  }));
}

// One Instantly lead → { match_status, match_method, agency_id, contact_id,
// outbound_id, probe_id, candidates, match_note }.
export function matchInstantlyLead(lead, index) {
  const email = lower(lead.email);
  const tries = [
    ['OUTBOUND_EMAIL', index.outboundByEmail.get(email)],
    ['OUTBOUND_LEAD_ID', index.outboundByLeadId.get(lower(lead.id))],
    ['CONTACT_EMAIL', index.contactsByEmail.get(email)],
    ['AGENCY_EMAIL', index.agenciesByEmail.get(email)],
    ['DEMO_SLUG', index.demosBySlug.get(lower(slugOf(lead.payload?.demo_url)))],
  ];
  for (const [method, refs] of tries) {
    if (!refs?.length) continue;
    const one = uniqueAgency(refs);
    if (one) {
      const contact = index.contactsByEmail.get(email)?.find((r) => r.agency_id === one.agency_id);
      const outbound = index.outboundByEmail.get(email)?.find((r) => r.agency_id === one.agency_id) || index.outboundByLeadId.get(lower(lead.id))?.find((r) => r.agency_id === one.agency_id);
      return { match_status: 'MATCHED', match_method: method, agency_id: one.agency_id, contact_id: text(contact?.contact_id), outbound_id: text(outbound?.outbound_id || one.outbound_id), probe_id: text(outbound?.probe_id || one.probe_id), candidates: candidatesOf(refs, index), match_note: '' };
    }
    return { match_status: 'AMBIGUOUS', match_method: method, agency_id: '', contact_id: '', outbound_id: '', probe_id: '', candidates: candidatesOf(refs, index), match_note: `${method} points at ${new Set(refs.map((r) => r.agency_id)).size} agencies` };
  }
  const domain = domainOf(email);
  const byDomain = index.agenciesByDomain.get(domain);
  if (byDomain?.length) {
    const one = uniqueAgency(byDomain);
    if (one) {
      return { match_status: 'MATCHED', match_method: 'DOMAIN', agency_id: one.agency_id, contact_id: '', outbound_id: '', probe_id: '', candidates: candidatesOf(byDomain, index), match_note: `matched by domain ${domain} only — the address itself is not on file; review` };
    }
    return { match_status: 'AMBIGUOUS', match_method: 'DOMAIN', agency_id: '', contact_id: '', outbound_id: '', probe_id: '', candidates: candidatesOf(byDomain, index), match_note: `domain ${domain} is shared by ${new Set(byDomain.map((r) => r.agency_id)).size} agencies` };
  }
  return { match_status: 'UNMATCHED', match_method: '', agency_id: '', contact_id: '', outbound_id: '', probe_id: '', candidates: [], match_note: `no NOVUS record carries ${email || 'this address'}${domain ? ` or the domain ${domain}` : ''}` };
}

// ── mapping to workbook rows ───────────────────────────────────────────────
// An imported member is PUSHED by definition (Instantly has it). Its
// eligibility columns stay blank: NOVUS did not decide this membership.
export function memberRowFromInstantlyLead(lead, match, { campaignId, now, index }) {
  const agency = match.agency_id ? index?.agencyById.get(match.agency_id) : null;
  const status = leadStatusLabel(lead.status);
  const interest = interestLabel(lead.lt_interest_status);
  return {
    member_id: newCampaignMemberId(), campaign_id: campaignId, agency_id: match.agency_id, contact_id: match.contact_id,
    outbound_id: match.outbound_id, probe_id: match.probe_id, email: lower(lead.email), first_name: text(lead.first_name),
    contact_name: text([lead.first_name, lead.last_name].filter(Boolean).join(' ')),
    company_name: text(lead.company_name) || text(agency?.clean_agency_name || agency?.agency_name),
    custom_variables_json: JSON.stringify(lead.payload || {}),
    eligibility_status: '', eligibility_reasons: '', warnings_acknowledged: '',
    member_status: 'PUSHED', instantly_lead_id: text(lead.id), instantly_lead_status: status, interest_status: interest,
    emails_sent_count: 0, last_event_type: '', last_event_at: '',
    replied_at: Number(lead.email_reply_count) > 0 ? text(lead.timestamp_last_reply) : '',
    bounced_at: status === 'BOUNCED' ? text(lead.timestamp_updated || lead.timestamp_last_contact) : '',
    unsubscribed_at: status === 'UNSUBSCRIBED' ? text(lead.timestamp_updated) : '',
    meeting_booked_at: ['MEETING_BOOKED', 'MEETING_COMPLETED', 'WON'].includes(interest) ? text(lead.timestamp_last_interest_change) : '',
    added_at: text(lead.timestamp_created) || now, pushed_at: text(lead.timestamp_created) || now, last_error: '', updated_at: now,
    match_status: match.match_status, match_method: match.match_method, match_note: match.match_note,
  };
}

// The patch a re-import applies to an EXISTING member row: provider state
// only. Never the NOVUS-side columns (eligibility, warnings, added_at).
export function memberPatchFromInstantlyLead(existing, lead, match, { now }) {
  const fresh = memberRowFromInstantlyLead(lead, match, { campaignId: existing.campaign_id, now });
  const patch = {};
  for (const key of ['instantly_lead_id', 'instantly_lead_status', 'interest_status', 'company_name', 'first_name', 'contact_name']) {
    if (text(fresh[key]) && text(fresh[key]) !== text(existing[key])) patch[key] = fresh[key];
  }
  for (const key of ['replied_at', 'bounced_at', 'unsubscribed_at', 'meeting_booked_at']) {
    if (text(fresh[key]) && !text(existing[key])) patch[key] = fresh[key];
  }
  // A match found later fills blanks; it never overwrites an existing link.
  if (!text(existing.agency_id) && match.agency_id) {
    Object.assign(patch, { agency_id: match.agency_id, contact_id: match.contact_id, outbound_id: match.outbound_id, probe_id: match.probe_id });
  }
  if (upper(existing.member_status) !== 'PUSHED' && upper(existing.member_status) !== 'EXCLUDED') patch.member_status = 'PUSHED';
  if (text(match.match_status) && (text(match.match_status) !== text(existing.match_status) || text(match.match_method) !== text(existing.match_method))) {
    if (!text(existing.agency_id) || match.agency_id === text(existing.agency_id)) {
      patch.match_status = match.match_status; patch.match_method = match.match_method; patch.match_note = match.match_note;
    }
  }
  if (Object.keys(patch).length) patch.updated_at = now;
  return patch;
}

// Activity export rows → CAMPAIGN_EVENTS rows, keyed on the moment. The
// real timestamp is the event's occurred_at; the import time is received_at.
export function eventsFromActivityRows(rows, { campaignId, instantlyCampaignId, membersByEmail, now }) {
  return rows.map((r) => {
    const m = membersByEmail.get(r.recipient) || null;
    const at = ts(r.at);
    const moment = at === null ? text(r.at) : new Date(at).toISOString();
    return {
      dedupe_key: novusDedupeKey('csv', r.event_type, r.recipient, moment.slice(0, 19), r.step),
      source: 'RECONCILE', event_type: r.event_type, occurred_at: moment, received_at: now,
      campaign_id: campaignId, instantly_campaign_id: instantlyCampaignId, member_id: text(m?.member_id), agency_id: text(m?.agency_id), contact_id: text(m?.contact_id),
      lead_email: r.recipient, instantly_email_id: '', step: r.step, variant: '', email_account: r.event_type === 'MANUAL_REPLY_SENT' ? '' : r.sender,
      subject: '', snippet: r.link ? `link: ${r.link}` : '', payload_json: { source: 'activity_csv', action: r.action, sender: r.sender, step: r.step },
    };
  });
}

// /emails sweep → events. Shared with the ongoing sync so historical and
// live sends carry identical keys (rc_sent_<email id>).
export function eventsFromEmailSweep(items, { campaignId, instantlyCampaignId, membersByEmail, now, normalise, ueType }) {
  const events = [];
  for (const raw of items) {
    const message = normalise(raw);
    const m = membersByEmail.get(lower(message.lead_email)) || null;
    const emailId = text(message.email_id || raw?.id);
    if (!emailId) continue;
    const base = {
      source: 'RECONCILE', occurred_at: text(message.timestamp) || now, received_at: now, campaign_id: campaignId, instantly_campaign_id: instantlyCampaignId,
      member_id: text(m?.member_id), agency_id: text(m?.agency_id), contact_id: text(m?.contact_id), lead_email: lower(message.lead_email), instantly_email_id: emailId,
      step: text(message.provider_hints?.step ?? raw?.step), email_account: text(message.eaccount), subject: text(message.subject).slice(0, 200),
      payload_json: { id: emailId, ue_type: message.ue_type, timestamp: message.timestamp },
    };
    if (message.ue_type === ueType.SENT_FROM_CAMPAIGN && message.direction === 'OUTBOUND') {
      events.push({ ...base, dedupe_key: reconcileDedupeKey('sent', emailId), event_type: 'EMAIL_SENT' });
    } else if (message.ue_type === ueType.RECEIVED && message.direction === 'INBOUND') {
      events.push({ ...base, dedupe_key: reconcileDedupeKey('reply', emailId), event_type: 'REPLY_RECEIVED', snippet: text(message.cleaned_reply_text || message.raw_body_text).slice(0, 200) });
    } else if (message.ue_type === ueType.SENT_MANUALLY && message.direction === 'OUTBOUND') {
      events.push({ ...base, dedupe_key: reconcileDedupeKey('manual', emailId), event_type: 'MANUAL_REPLY_SENT' });
    }
  }
  return events;
}

// ── reconciliation report ─────────────────────────────────────────────────
// One row per member, from real events only. `stageByAgency` (optional) is
// the NOVUS lifecycle stage, so the report shows the combination of Instantly
// history and NOVUS history side by side.
export function buildReconciliationReport({ campaign, members, events, stageByAgency = new Map(), agencyById = new Map(), now = new Date().toISOString() }) {
  const byMember = new Map();
  const byEmail = new Map();
  for (const ev of events) {
    const k = text(ev.member_id);
    if (k) { if (!byMember.has(k)) byMember.set(k, []); byMember.get(k).push(ev); }
    const e = lower(ev.lead_email);
    if (e) { if (!byEmail.has(e)) byEmail.set(e, []); byEmail.get(e).push(ev); }
  }
  const rows = members.map((m) => {
    const evs = [...new Map([...(byMember.get(text(m.member_id)) || []), ...(byEmail.get(lower(m.email)) || [])].map((e) => [e.event_id || e.dedupe_key, e])).values()];
    const of = (type) => evs.filter((e) => upper(e.event_type) === type);
    const sends = of('EMAIL_SENT').sort((a, b) => (ts(a.occurred_at) ?? 0) - (ts(b.occurred_at) ?? 0));
    const steps = [...new Set(sends.map((e) => text(e.step)).filter(Boolean))].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    const interest = upper(m.interest_status);
    const stage = stageByAgency.get(text(m.agency_id)) || null;
    const agency = agencyById.get(text(m.agency_id));
    const positiveEvents = of('LEAD_INTERESTED').length + of('LEAD_MEETING_BOOKED').length;
    const negativeEvents = of('LEAD_NOT_INTERESTED').length;
    return {
      member_id: text(m.member_id), agency_id: text(m.agency_id),
      agency_name: text(agency?.clean_agency_name || agency?.agency_name) || text(m.company_name),
      contact_name: text(m.contact_name), email: lower(m.email), instantly_lead_id: text(m.instantly_lead_id), instantly_campaign_id: text(campaign?.instantly_campaign_id),
      instantly_lead_status: upper(m.instantly_lead_status), interest_status: interest,
      match_status: upper(m.match_status) || (text(m.agency_id) ? 'MATCHED' : 'UNMATCHED'), match_method: text(m.match_method), match_note: text(m.match_note),
      emails_sent: sends.length, steps_sent: steps, first_send_at: text(sends[0]?.occurred_at), last_send_at: text(sends[sends.length - 1]?.occurred_at),
      replies: of('REPLY_RECEIVED').length, auto_replies: of('AUTO_REPLY_RECEIVED').length, manual_replies_sent: of('MANUAL_REPLY_SENT').length,
      opens: of('EMAIL_OPENED').length, clicks: of('LINK_CLICKED').length,
      positive: positiveEvents > 0 || ['INTERESTED', 'MEETING_BOOKED', 'MEETING_COMPLETED', 'WON'].includes(interest),
      negative: negativeEvents > 0 || ['NOT_INTERESTED', 'WRONG_PERSON', 'LOST'].includes(interest),
      bounced: Boolean(text(m.bounced_at)) || of('EMAIL_BOUNCED').length > 0 || upper(m.instantly_lead_status) === 'BOUNCED',
      unsubscribed: Boolean(text(m.unsubscribed_at)) || of('LEAD_UNSUBSCRIBED').length > 0 || upper(m.instantly_lead_status) === 'UNSUBSCRIBED',
      meeting: Boolean(text(m.meeting_booked_at)) || ['MEETING_BOOKED', 'MEETING_COMPLETED'].includes(interest) || stage === 'MEETING_BOOKED',
      replied_at: text(m.replied_at), novus_stage: stage || '',
      manual_conversation: ['REPLIED_NEEDS_HUMAN', 'MEETING_INTENT', 'DEMO_REQUESTED', 'MANUAL_REPLY_SENT_WAITING', 'DEMO_FOLLOWUP_SENT', 'DEMO_ENGAGED', 'DEMO_OPENED', 'DEMO_SENT_UNOPENED', 'CALL_DUE', 'MEETING_BOOKED'].includes(stage),
      sequence_completed: upper(m.instantly_lead_status) === 'COMPLETED',
    };
  });
  const count = (pred) => rows.filter(pred).length;
  const summary = {
    members: rows.length,
    matched: count((r) => r.match_status === 'MATCHED'), ambiguous: count((r) => r.match_status === 'AMBIGUOUS'), unmatched: count((r) => r.match_status === 'UNMATCHED'),
    matched_by_domain_only: count((r) => r.match_status === 'MATCHED' && r.match_method === 'DOMAIN'),
    never_sent: count((r) => r.emails_sent === 0), sent_one: count((r) => r.emails_sent === 1), sent_many: count((r) => r.emails_sent > 1),
    emails_sent_total: rows.reduce((n, r) => n + r.emails_sent, 0),
    by_steps: rows.reduce((acc, r) => { const k = String(r.steps_sent.length ? Math.max(...r.steps_sent) : 0); acc[k] = (acc[k] || 0) + 1; return acc; }, {}),
    replied: count((r) => r.replies > 0), auto_replied: count((r) => r.auto_replies > 0), positive: count((r) => r.positive), negative: count((r) => r.negative),
    bounced: count((r) => r.bounced), unsubscribed: count((r) => r.unsubscribed), meetings: count((r) => r.meeting), manual_conversation: count((r) => r.manual_conversation),
    sequence_completed: count((r) => r.sequence_completed), still_active: count((r) => r.instantly_lead_status === 'ACTIVE'),
    first_send_at: rows.map((r) => r.first_send_at).filter(Boolean).sort()[0] || '', last_send_at: rows.map((r) => r.last_send_at).filter(Boolean).sort().pop() || '',
  };
  return { campaign_id: text(campaign?.campaign_id), instantly_campaign_id: text(campaign?.instantly_campaign_id), generated_at: now, summary, rows: rows.sort((a, b) => a.agency_name.localeCompare(b.agency_name)), review: rows.filter((r) => r.match_status !== 'MATCHED' || r.match_method === 'DOMAIN') };
}

export const _internal = { domainOf, slugOf, records, uniqueAgency, PROVIDER_EVENT_TYPES };
