// lib/campaign-audience.mjs — PURE audience builder for campaign creation.
//
// Takes tables the handler already loaded and returns, for a set of filters
// and a policy, every candidate agency with its resolved outreach contact,
// prior-outreach facts, lifecycle stage, existing campaign memberships and
// the eligibility decision (lib/campaign-eligibility.mjs). The counts the
// audience screen shows ("147 selected · 121 ready · 14 contacted too
// recently …") are computed here so the browser never re-derives them.
//
// PURITY CONTRACT: no I/O, no writer import, deterministic for (tables,
// filters, policy, now). Lifecycle stage comes from the same resolver the
// Command Centre uses (lib/operator-funnel.mjs → lib/acquisition-stage.mjs),
// so "in an active conversation" means exactly what the Pipeline says.

import { buildAgencyEvidence } from './operator-funnel.mjs';
import { isGenericEmail } from './contact-resolution.mjs';
import { resolvePropertyStreet } from './property-reference.mjs';
import { campaignRecords, memberRecords, eventRecords } from './campaign-store.mjs';
import { evaluateEligibility, normalisePolicy, summariseEligibility, DEFAULT_POLICY } from './campaign-eligibility.mjs';
import { PROBE_CALL_CAMPAIGN_TYPE } from './probe-call-campaign.mjs';

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();
const lower = (value) => text(value).toLowerCase();
const ts = (value) => { const n = Date.parse(text(value)); return Number.isFinite(n) ? n : null; };

export const AUDIENCE_TABS = Object.freeze([
  'AGENCIES', 'CONTACTS', 'PROBES', 'INTELLIGENCE', 'PERSONALISATION', 'DEMOS', 'OUTBOUND', 'REPLY_EVENTS',
  'SALES_MESSAGES', 'ACTIONS', 'CALLS',
]);

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
function group(rows, key) {
  const out = new Map();
  for (const row of rows) {
    const value = text(row[key]);
    if (!value) continue;
    if (!out.has(value)) out.set(value, []);
    out.get(value).push(row);
  }
  return out;
}

// The address a campaign would send to for this agency. The CONTACTS row
// selected for outreach wins (it carries its own verification and type); the
// AGENCIES outreach columns are the fallback for agencies resolved before the
// CONTACTS tab existed.
export function resolveOutreachContact(agency, contacts = []) {
  const selected = contacts.find((row) => upper(row.is_selected_for_outreach) === 'TRUE' && text(row.email))
    || contacts.find((row) => lower(row.email) && lower(row.email) === lower(agency.outreach_contact_email))
    || null;
  const email = text(selected?.email) || text(agency.outreach_contact_email);
  return {
    contact_id: text(selected?.contact_id),
    name: text(selected?.contact_name) || text(agency.outreach_contact_name) || text(agency.primary_contact_name),
    role: text(selected?.contact_role) || (text(agency.owner_md) && lower(agency.owner_md) === lower(agency.outreach_contact_name || selected?.contact_name) ? 'Owner' : ''),
    email,
    verification_status: upper(selected?.verification_status) || upper(agency.email_verification_status),
    contact_type: upper(selected?.contact_type) || (email ? (isGenericEmail(email) ? 'GENERIC' : 'NAMED_HUMAN') : 'UNKNOWN'),
    source: selected ? 'CONTACTS' : (email ? 'AGENCIES' : ''),
  };
}

function firstName(name) {
  const clean = text(name).replace(/^(mr|mrs|ms|miss|dr)\.?\s+/i, '');
  return clean.split(/\s+/)[0] || '';
}

// ── filters ────────────────────────────────────────────────────────────────
export const DEFAULT_FILTERS = Object.freeze({
  probe_completed: null,        // true → closed only; false → no closed probe; null → any
  probe_sent: null,             // true → observing/closed; null → any
  probe_not_compromised: true,
  email_exists: true,
  verification: ['VALID'],      // accepted verification statuses
  include_risky: false,         // shorthand: adds RISKY to `verification`
  contact_kind: '',             // '' | 'direct' | 'generic'
  owner_identified: null,
  never_emailed: null,          // true → prior_email_count === 0
  max_prior_emails: null,
  last_emailed_before: '',      // ISO date; last email must be before this
  replied_before: null,
  positive_reply: null,
  negative_reply: null,
  include_opted_out: false,
  include_bounced: false,
  spoken_to: null,              // owner previously reached on a call
  in_active_campaign: null,     // true → only those; false → exclude; null → any
  branch_count_min: null,
  branch_count_max: null,
  location: '',
  crm: '',
  agency_name: '',
  contact_name: '',
  contact_role: '',
  stages: [],                   // lifecycle stages to include
  agency_ids: [],               // explicit selection; when set, other filters still apply
  exclude_agency_ids: [],       // manual removals from the audience screen
});

export function normaliseFilters(input = {}) {
  const out = { ...DEFAULT_FILTERS, verification: [...DEFAULT_FILTERS.verification], stages: [], agency_ids: [], exclude_agency_ids: [] };
  const tri = (v) => (v === true || upper(v) === 'TRUE' ? true : v === false || upper(v) === 'FALSE' ? false : null);
  const num = (v) => { const n = Number(v); return v === '' || v === null || v === undefined || !Number.isFinite(n) ? null : n; };
  for (const key of Object.keys(DEFAULT_FILTERS)) {
    const v = input[key];
    if (v === undefined) continue;
    if (['verification', 'stages', 'agency_ids', 'exclude_agency_ids'].includes(key)) {
      out[key] = (Array.isArray(v) ? v : String(v).split(',')).map(text).filter(Boolean).map((s) => (key === 'verification' || key === 'stages' ? s.toUpperCase() : s));
    } else if (['probe_completed', 'probe_sent', 'owner_identified', 'never_emailed', 'replied_before', 'positive_reply', 'negative_reply', 'spoken_to', 'in_active_campaign'].includes(key)) {
      out[key] = tri(v);
    } else if (['probe_not_compromised', 'email_exists', 'include_risky', 'include_opted_out', 'include_bounced'].includes(key)) {
      out[key] = tri(v) === null ? DEFAULT_FILTERS[key] : tri(v);
    } else if (['max_prior_emails', 'branch_count_min', 'branch_count_max'].includes(key)) {
      out[key] = num(v);
    } else {
      out[key] = text(v);
    }
  }
  if (out.include_risky && !out.verification.includes('RISKY')) out.verification.push('RISKY');
  if (!out.verification.length) out.verification = ['VALID'];
  return out;
}

function matchesFilters(row, f) {
  const c = row.contact;
  const facts = row.eligibility.facts;
  if (f.agency_ids.length && !f.agency_ids.includes(row.agency_id)) return false;
  if (f.exclude_agency_ids.includes(row.agency_id)) return false;
  if (f.email_exists && !c.email) return false;
  if (c.email && f.verification.length && !f.verification.includes(c.verification_status)) return false;
  if (f.probe_completed === true && !facts.probe_complete) return false;
  if (f.probe_completed === false && facts.probe_complete) return false;
  if (f.probe_sent === true && !facts.probe_sent) return false;
  if (f.probe_sent === false && facts.probe_sent) return false;
  if (f.probe_not_compromised && facts.probe_compromised) return false;
  if (f.contact_kind === 'direct' && facts.generic_email) return false;
  if (f.contact_kind === 'generic' && !facts.generic_email) return false;
  if (f.owner_identified === true && !facts.owner_contact) return false;
  if (f.owner_identified === false && facts.owner_contact) return false;
  if (f.never_emailed === true && facts.prior_email_count > 0) return false;
  if (f.never_emailed === false && facts.prior_email_count === 0) return false;
  if (f.max_prior_emails !== null && facts.prior_email_count > f.max_prior_emails) return false;
  if (f.last_emailed_before) {
    const limit = ts(f.last_emailed_before);
    const last = ts(facts.last_emailed_at);
    if (limit !== null && last !== null && last >= limit) return false;
  }
  if (f.replied_before === true && !facts.replied_before) return false;
  if (f.replied_before === false && facts.replied_before) return false;
  if (f.positive_reply === true && !facts.positive_reply) return false;
  if (f.positive_reply === false && facts.positive_reply) return false;
  if (f.negative_reply === true && !facts.negative_reply) return false;
  if (f.negative_reply === false && facts.negative_reply) return false;
  if (!f.include_opted_out && (facts.opted_out || facts.unsubscribed)) return false;
  if (!f.include_bounced && facts.bounced) return false;
  if (f.spoken_to === true && !row.spoken_to) return false;
  if (f.spoken_to === false && row.spoken_to) return false;
  if (f.in_active_campaign === true && !facts.in_other_active_campaign) return false;
  if (f.in_active_campaign === false && facts.in_other_active_campaign) return false;
  if (f.branch_count_min !== null && !(row.branch_count >= f.branch_count_min)) return false;
  if (f.branch_count_max !== null && !(row.branch_count <= f.branch_count_max)) return false;
  const has = (hay, needle) => !needle || lower(hay).includes(lower(needle));
  if (!has(row.location, f.location)) return false;
  if (!has(row.crm, f.crm)) return false;
  if (!has(row.agency_name, f.agency_name)) return false;
  if (!has(c.name, f.contact_name)) return false;
  if (!has(c.role, f.contact_role)) return false;
  if (f.stages.length && !f.stages.includes(row.stage)) return false;
  return true;
}

// ── the builder ────────────────────────────────────────────────────────────
// `campaign` is { campaign_id, campaign_type } for the campaign being built
// (campaign_id may be blank for a not-yet-created draft). `campaignTables`
// is { CAMPAIGNS, CAMPAIGN_MEMBERS, CAMPAIGN_EVENTS }.
export function buildCampaignAudience(tables, campaignTables, {
  filters = {}, policy = DEFAULT_POLICY, campaign = {}, now = new Date().toISOString(),
  applyFilters = true, limit = 0,
} = {}) {
  const nowMs = Date.parse(now) || Date.now();
  const f = normaliseFilters(filters);
  const probeCall = upper(campaign.campaign_type) === PROBE_CALL_CAMPAIGN_TYPE;
  const p = normalisePolicy({ ...policy, requires_probe: probeCall || (policy?.requires_probe ?? (upper(campaign.campaign_type || 'ENQUIRY_FOLLOWUP') === 'ENQUIRY_FOLLOWUP')) });
  if (probeCall) Object.assign(p, { requires_probe: true, allow_risky_email: false, block_active_campaign: true, block_active_conversation: true, block_active_followup: true, block_prior_negative: true, block_meeting_booked: true, block_opted_out: true });

  const evidence = buildAgencyEvidence(tables, { now });
  const contactsByAgency = group(records(tables.CONTACTS, 'contact_id'), 'agency_id');
  const callsByAgency = group(records(tables.CALLS, 'call_id').filter((row) => upper(row.call_status) !== 'DISCARDED'), 'agency_id');
  const campaignsById = new Map(campaignRecords(campaignTables?.CAMPAIGNS).map((row) => [text(row.campaign_id), row]));
  const members = memberRecords(campaignTables?.CAMPAIGN_MEMBERS).map((row) => ({ ...row, campaign_status: upper(campaignsById.get(text(row.campaign_id))?.status), campaign_name: text(campaignsById.get(text(row.campaign_id))?.name) }));
  const membersByAgency = group(members, 'agency_id');
  const membersByEmail = group(members.map((row) => ({ ...row, email_key: lower(row.email) })), 'email_key');
  const events = eventRecords(campaignTables?.CAMPAIGN_EVENTS);
  const eventsByAgency = group(events, 'agency_id');
  const eventsByEmail = group(events.map((row) => ({ ...row, email_key: lower(row.lead_email) })), 'email_key');

  // First pass: resolve contacts so duplicates inside the selection can be
  // detected before eligibility runs.
  const prepared = evidence.map((ev) => {
    const agency = ev.agency;
    const agencyId = text(agency.agency_id);
    const contact = resolveOutreachContact(agency, contactsByAgency.get(agencyId) || []);
    return { ev, agencyId, contact, emailKey: lower(contact.email) };
  });
  // One address, several agency rows (multi-branch firms share a contact):
  // exactly ONE row keeps the address — the one with a personalised probe,
  // else the most recent probe, else the lowest id — and the rest are
  // DUPLICATE_EMAIL so the contact is mailed once and the branches stay
  // visible in the review.
  const byEmailKey = new Map();
  const agencyCounts = new Map();
  for (const row of prepared) {
    if (row.emailKey) { if (!byEmailKey.has(row.emailKey)) byEmailKey.set(row.emailKey, []); byEmailKey.get(row.emailKey).push(row); }
    agencyCounts.set(row.agencyId, (agencyCounts.get(row.agencyId) || 0) + 1);
  }
  const duplicateAgencyIds = new Set();
  for (const group of byEmailKey.values()) {
    if (group.length < 2) continue;
    const ranked = [...group].sort((a, b) => (Boolean(b.ev.personalisation) - Boolean(a.ev.personalisation))
      || ((ts(b.ev.probe?.probe_timestamp) ?? 0) - (ts(a.ev.probe?.probe_timestamp) ?? 0)) || a.agencyId.localeCompare(b.agencyId));
    ranked.slice(1).forEach((row) => duplicateAgencyIds.add(row.agencyId));
  }

  const all = prepared.map(({ ev, agencyId, contact, emailKey }) => {
    const agency = ev.agency;
    const memberships = [...(membersByAgency.get(agencyId) || []), ...(emailKey ? (membersByEmail.get(emailKey) || []) : [])]
      .filter((row, i, arr) => arr.findIndex((other) => other.member_id === row.member_id) === i);
    const campaignEvents = [...(eventsByAgency.get(agencyId) || []), ...(emailKey ? (eventsByEmail.get(emailKey) || []) : [])]
      .filter((row, i, arr) => arr.findIndex((other) => other.event_id === row.event_id) === i);
    const calls = callsByAgency.get(agencyId) || [];
    const spokenTo = calls.some((row) => upper(row.owner_reached) === 'TRUE' || Boolean(text(row.owner_reached_at)));

    const candidate = {
      agency, contact, probe: ev.probe, outbound: ev.outbound, execution: ev.execution,
      replyEvents: ev.replyEvents, salesMessages: ev.salesMessages, actions: ev.actions, demo: ev.demo,
      personalisation: ev.personalisation, stage: ev.stage, memberships, campaignEvents, campaign, calls,
      generic_email: contact.email ? isGenericEmail(contact.email) : false,
      duplicate_email: duplicateAgencyIds.has(agencyId),
      duplicate_agency: agencyCounts.get(agencyId) > 1,
    };
    const eligibility = evaluateEligibility(candidate, { policy: p, nowMs });
    const probe = ev.probe;
    const branchCount = Number(text(agency.branch_count)) || null;
    return {
      agency_id: agencyId,
      agency_name: text(agency.clean_agency_name || agency.agency_name),
      location: text(agency.location),
      crm: text(agency.crm_name),
      branch_count: branchCount,
      contact: { ...contact, first_name: firstName(contact.name) },
      probe: probe ? {
        probe_id: text(probe.probe_id), reference: text(probe.probe_reference), status: lower(probe.probe_status),
        sent_at: text(probe.probe_timestamp), property: resolvePropertyStreet(probe) || text(probe.property_address),
        compromised: upper(probe.compromised) === 'TRUE',
      } : null,
      outbound_id: text(ev.outbound?.outbound_id),
      personalisation: ev.personalisation ? {
        email_observation: text(ev.personalisation.email_observation), email_commercial_hook: text(ev.personalisation.email_commercial_hook),
      } : null,
      demo_url: text(ev.outbound?.demo_url),
      stage: ev.stage,
      stage_reason: ev.stageReason,
      prior: {
        email_count: eligibility.facts.prior_email_count, last_emailed_at: eligibility.facts.last_emailed_at,
        last_emailed_days: eligibility.facts.last_emailed_days, replied: eligibility.facts.replied_before,
        positive: eligibility.facts.positive_reply, negative: eligibility.facts.negative_reply,
        opted_out: eligibility.facts.opted_out || eligibility.facts.unsubscribed, bounced: eligibility.facts.bounced,
      },
      spoken_to: spokenTo,
      campaigns: memberships.map((row) => ({ campaign_id: text(row.campaign_id), name: row.campaign_name, status: row.campaign_status, member_status: upper(row.member_status), instantly_lead_status: upper(row.instantly_lead_status) })),
      eligibility: { status: eligibility.status, reasons: eligibility.reasons, blocks: eligibility.blocks, warnings: eligibility.warnings, facts: eligibility.facts },
    };
  });

  // Readiness buckets, over the whole database and over the selection, so
  // the review can say not just "121 ready" but where everyone else went.
  const bucketsOf = (rows) => {
    const f2 = (pred) => rows.filter((row) => pred(row.eligibility.facts, row)).length;
    return {
      agencies: rows.length,
      eligible_agencies: rows.filter((row) => row.eligibility.status === 'READY').length,
      eligible_contacts: new Set(rows.filter((row) => row.eligibility.status === 'READY').map((row) => lower(row.contact.email)).filter(Boolean)).size,
      clean_untouched: rows.filter((row) => row.eligibility.status === 'READY' && row.eligibility.facts.last_emailed_days === null && !row.eligibility.facts.prior_campaign_count).length,
      previously_emailed: f2((x) => x.prior_email_count > 0 || x.prior_campaign_count > 0),
      recently_contacted: f2((x) => x.last_emailed_days !== null && x.last_emailed_days < p.cooling_days),
      active_conversation: f2((x) => x.active_conversation),
      active_followup: f2((x) => x.active_followup),
      meeting_booked: f2((x) => x.meeting_booked),
      negative_reply: f2((x) => x.negative_reply),
      invalid_or_bounced: f2((x) => x.bounced || (x.email && !['VALID', 'RISKY'].includes(x.verification_status))),
      risky_email: f2((x) => x.verification_status === 'RISKY'),
      opted_out: f2((x) => x.opted_out || x.unsubscribed),
      missing_probe: f2((x) => !x.probe_sent),
      probe_observing: f2((x) => x.probe_sent && !x.probe_complete),
      missing_email: f2((x) => !x.email),
      in_other_active_campaign: f2((x) => x.in_other_active_campaign),
      suppressed: f2((x) => x.suppressed || ['CLOSED', 'EXCLUDED'].includes(x.pipeline_status)),
    };
  };
  // Instantly leads NOVUS holds but could not attach to an agency are not
  // agencies at all; they are surfaced here so nobody mistakes "not in the
  // list" for "not contacted".
  const unlinked = members.filter((row) => !text(row.agency_id));
  const selected = applyFilters ? all.filter((row) => matchesFilters(row, f)) : all;
  selected.sort((a, b) => {
    const rank = { READY: 0, WARNING: 1, BLOCKED: 2 };
    return (rank[a.eligibility.status] - rank[b.eligibility.status]) || a.agency_name.localeCompare(b.agency_name);
  });
  const summary = summariseEligibility(selected.map((row) => row.eligibility));
  const rows = limit > 0 ? selected.slice(0, limit) : selected;

  return {
    generated_at: now,
    filters: f,
    policy: p,
    total_agencies: all.length,
    selected: selected.length,
    summary,
    buckets: { all: bucketsOf(all), selected: bucketsOf(selected) },
    unlinked_members: { count: unlinked.length, ambiguous: unlinked.filter((row) => upper(row.match_status) === 'AMBIGUOUS').length, unmatched: unlinked.filter((row) => upper(row.match_status) !== 'AMBIGUOUS').length,
      rows: unlinked.slice(0, 200).map((row) => ({ email: lower(row.email), campaign: row.campaign_name, match_status: upper(row.match_status) || 'UNMATCHED', match_note: text(row.match_note), instantly_lead_status: upper(row.instantly_lead_status) })) },
    rows: rows.map((row) => ({ ...row, eligibility: { ...row.eligibility, facts: undefined } })),
    truncated: rows.length < selected.length,
    ready_agency_ids: selected.filter((row) => row.eligibility.status === 'READY').map((row) => row.agency_id),
    warning_agency_ids: selected.filter((row) => row.eligibility.status === 'WARNING').map((row) => row.agency_id),
    // Filter option values so the UI can offer real choices.
    options: {
      locations: [...new Set(all.map((row) => row.location).filter(Boolean))].sort(),
      crms: [...new Set(all.map((row) => row.crm).filter(Boolean))].sort(),
      stages: [...new Set(all.map((row) => row.stage).filter(Boolean))].sort(),
    },
  };
}

// The Instantly lead payload for one audience row. Custom variables mirror the
// proven OUTBOUND → Instantly mapping (lib/instantly-outbound.mjs) so existing
// Instantly templates keep working, plus the NOVUS identifiers as variables
// for traceability inside Instantly.
export function leadPayloadFor(row, { campaignId = '' } = {}) {
  const probe = row.probe || {};
  const sent = probe.sent_at ? new Date(probe.sent_at) : null;
  const probeDate = sent && !Number.isNaN(sent.getTime()) ? sent.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'Europe/London' }) : '';
  const probeTime = sent && !Number.isNaN(sent.getTime()) ? sent.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }) : '';
  return {
    email: row.contact.email,
    first_name: row.contact.first_name || '',
    last_name: '',
    company_name: row.agency_name,
    custom_variables: {
      property: probe.property || '',
      agency: row.agency_name,
      property_street: probe.property || '',
      probe_date: probeDate,
      probe_time: probeTime,
      email_observation: row.personalisation?.email_observation || '',
      email_commercial_hook: row.personalisation?.email_commercial_hook || '',
      demo_url: row.demo_url || '',
      novus_agency_id: row.agency_id,
      novus_campaign_id: campaignId,
    },
  };
}

export const _internal = { records, group, matchesFilters, firstName };
