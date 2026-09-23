// lib/campaign-handlers.mjs — the HTTP operations behind the Email /
// Campaigns area (novus/campaigns.html) and the Instantly webhook. Mounted
// as ?novus_operation= branches on api/novus/personalisation.js because
// /api/novus/* sits at Vercel's 12-function ceiling; every handler here
// except the webhook assumes Basic Auth was already enforced by the router.
//
// READ   campaigns-list          CAMPAIGNS + CAMPAIGN_MEMBERS → summary rows
//        campaign-detail         one campaign: members, events, analytics,
//                                sequence, sending (live accounts on demand)
//        campaign-accounts       Instantly sending accounts (cached)
//        lead-timeline           one agency's full chronological story
// WRITE  campaign-setup          creates the three tabs
//        campaign-audience       POST filters → eligibility preview (no write)
//        campaign-create         DRAFT campaign + member snapshot
//        campaign-update         DRAFT edits, warning acknowledgement,
//                                audience refresh, member removal
//        campaign-push           create the Instantly campaign if needed and
//                                add READY (+acknowledged WARNING) leads
//        campaign-launch         activate — the ONLY operation that starts
//                                sending; explicit confirm token required
//        campaign-pause / campaign-resume
//        campaign-sync           reconcile status, leads, events, analytics
//        instantly-webhook       provider events → CAMPAIGN_EVENTS + members
//
// NOTHING HERE LAUNCHES AUTOMATICALLY. create writes a draft; push creates the
// Instantly campaign in its Draft state and adds leads; only launch (and
// resume) calls /activate, and each demands its own confirm token from a
// human click in the Basic-Auth-protected page.

import { getRepo } from './sheets.mjs';
import crypto from 'node:crypto';
import {
  CAMPAIGNS_TAB, CAMPAIGNS_HEADER, CAMPAIGN_MEMBERS_TAB, CAMPAIGN_MEMBERS_HEADER, CAMPAIGN_EVENTS_TAB,
  CAMPAIGN_STATUSES, CAMPAIGN_TYPES, INSTANTLY_CAMPAIGN_STATUS_LABEL,
  campaignRecords, memberRecords, eventRecords, parseRecords, rowFor, parseJson, reasonsList,
  readCampaignTables, ensureCampaignTabs, patchCampaign, patchMember, patchMembersBatch, appendEvents,
  newCampaignId, newCampaignMemberId, novusStatusFromInstantly, leadStatusLabel, interestLabel,
  normaliseInstantlyEventType, webhookDedupeKey, reconcileDedupeKey, novusDedupeKey,
  POSITIVE_EVENT_TYPES, NEGATIVE_EVENT_TYPES, PROVIDER_EVENT_TYPES,
} from './campaign-store.mjs';
import { AUDIENCE_TABS, buildCampaignAudience, leadPayloadFor, normaliseFilters } from './campaign-audience.mjs';
import { DEFAULT_POLICY, normalisePolicy, REASON_LABEL } from './campaign-eligibility.mjs';
import { clientFor, instantlyCredentials, InstantlyApiError, LEADS_ADD_CHUNK } from './instantly-client.mjs';
import { TIMELINE_TABS, buildLeadTimeline, buildLeadProfile } from './lead-timeline.mjs';
import { normalizeInstantlyEmail, UE_TYPE, novusMailboxes } from './reply-router.mjs';
import {
  buildNovusMatchIndex, matchInstantlyLead, memberRowFromInstantlyLead, memberPatchFromInstantlyLead,
  parseInstantlyLeadsCsv, parseInstantlyActivityCsv, eventsFromActivityRows, eventsFromEmailSweep, buildReconciliationReport,
} from './campaign-import.mjs';
import { buildAgencyEvidence } from './operator-funnel.mjs';
import { PROBE_CALL_CAMPAIGN_NAME, PROBE_CALL_SEQUENCE } from './probe-call-campaign.mjs';
import { lockedPreset, isPresetSequence, comparableBody, presetEnums } from './campaign-presets.mjs';
import { preparedCohort } from './campaign-cohorts.mjs';
import { probeCallMetrics } from './probe-call-analytics.mjs';

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();
const lower = (value) => text(value).toLowerCase();
const noStore = (res) => res.setHeader('Cache-Control', 'private, no-store, max-age=0');
const nowIso = () => new Date().toISOString();

export const CONFIRM = Object.freeze({
  SETUP: 'SETUP_CAMPAIGN_TABS',
  LINK: 'LINK_INSTANTLY_CAMPAIGN',
  IMPORT: 'IMPORT_CAMPAIGN_ACTIVITY',
  CREATE: 'CREATE_CAMPAIGN',
  PUSH: 'PUSH_TO_INSTANTLY',
  LAUNCH: 'LAUNCH_CAMPAIGN',
  PAUSE: 'PAUSE_CAMPAIGN',
  RESUME: 'RESUME_CAMPAIGN',
});

// Instantly's schedule timezone enum has no Europe/London; Europe/Isle_of_Man
// is the same UK clock and is in the list.
export const DEFAULT_SCHEDULE = Object.freeze({
  name: 'NOVUS working hours', from: '09:00', to: '17:00', timezone: 'Europe/Isle_of_Man',
  days: { 0: false, 1: true, 2: true, 3: true, 4: true, 5: true, 6: false },
});
export const DEFAULT_SENDING = Object.freeze({
  email_list: [], daily_limit: 50, daily_max_leads: 0, stop_on_reply: true, stop_on_auto_reply: false,
  open_tracking: true, link_tracking: false, text_only: false,
});

// Same in-process, single-entry cache pattern as the operator dashboard and
// calling workspace. Every write below clears it.
const CACHE_TTL_MS = 30_000;
const ACCOUNTS_TTL_MS = 120_000;
let listCache = null;
let accountsCache = null;
let audienceCache = null;
let audienceTablesCache = null;
export function invalidateCampaignCache() { listCache = null; audienceCache = null; audienceTablesCache = null; }

// ── automated sync poller tuning (Growth-plan campaigns, no webhooks) ──────
// POLL_MIN_INTERVAL_MS is a durable, per-campaign cooldown: a campaign whose
// CAMPAIGNS.last_synced_at is younger than this is skipped by the POLL path
// (never by a manual Sync Now or the nightly pass). It is read from the
// sheet, not memory, so it holds even across cold starts and across two
// overlapping invocations of the external scheduler — the closest thing to a
// distributed lock available without adding infrastructure. It is set below
// the documented ~10-15 minute poll cadence so one scheduled tick per cycle
// always goes through; a genuinely concurrent tick is absorbed here rather
// than doubling the Instantly calls. A race where two invocations both read
// the sheet before either writes it is possible in principle and is
// deliberately NOT hardened further: every write this poller makes is
// idempotent (dedupe_key / provider-moment matching in appendEvents, patch-by-
// diff on members), so a duplicate run wastes an Instantly call but never
// duplicates data.
const POLL_MIN_INTERVAL_MS = 8 * 60 * 1000;
// How far behind CAMPAIGNS.emails_synced_through the incremental /emails
// sweep still looks, to absorb Instantly-side eventual consistency and clock
// skew without re-scanning full campaign history on every poll.
const INCREMENTAL_OVERLAP_MS = 30 * 60 * 1000;
// Best-effort reentrancy guard for the poll endpoint. It only protects a
// single warm lambda instance (there is no cross-instance lock here either),
// but that is the common case for a lightweight external cron hitting one
// region, and it costs nothing when it does not apply.
let pollInFlight = false;

// ── loaders ────────────────────────────────────────────────────────────────
async function loadOptionalTables(repo, tabs, required = ['AGENCIES']) {
  const entries = await Promise.all(tabs.map(async (tab) => {
    try { return [tab, await repo.getTable(tab)]; }
    catch (err) {
      if (required.includes(tab) || !/Unable to parse range|no tab:/i.test(String(err?.message || ''))) throw err;
      return [tab, { header: [], rows: [] }];
    }
  }));
  return Object.fromEntries(entries);
}

function campaignView(row, members = [], events = []) {
  const analytics = parseJson(row.analytics_json, null);
  const live = members.filter((m) => ['SELECTED', 'PUSHED'].includes(upper(m.member_status)));
  const pushed = members.filter((m) => upper(m.member_status) === 'PUSHED');
  const count = (pred) => members.filter(pred).length;
  const sentFromEvents = events.filter((e) => upper(e.event_type) === 'EMAIL_SENT').length;
  const sentFromMembers = members.reduce((n, m) => n + (Number(m.emails_sent_count) || 0), 0);
  return {
    campaign_id: text(row.campaign_id),
    instantly_campaign_id: text(row.instantly_campaign_id),
    name: text(row.name),
    status: upper(row.status) || 'DRAFT',
    campaign_type: upper(row.campaign_type) || 'ENQUIRY_FOLLOWUP',
    instantly_status: text(row.instantly_status),
    instantly_status_label: INSTANTLY_CAMPAIGN_STATUS_LABEL[text(row.instantly_status)] || '',
    source: upper(row.source) || 'NOVUS', linked_at: text(row.linked_at),
    created_at: text(row.created_at), pushed_at: text(row.pushed_at), launched_at: text(row.launched_at),
    paused_at: text(row.paused_at), completed_at: text(row.completed_at), updated_at: text(row.updated_at),
    last_synced_at: text(row.last_synced_at), last_error: text(row.last_error),
    emails_synced_through: text(row.emails_synced_through),
    sequence: parseJson(row.sequence_json, { steps: [] }),
    schedule: { ...DEFAULT_SCHEDULE, ...parseJson(row.schedule_json, {}) },
    sending: { ...DEFAULT_SENDING, ...parseJson(row.sending_json, {}) },
    filters: parseJson(row.audience_filters_json, {}),
    policy: normalisePolicy(parseJson(row.policy_json, {})),
    analytics,
    step_analytics: parseJson(row.step_analytics_json, []),
    metrics: {
      leads: live.length,
      selected: count((m) => upper(m.member_status) === 'SELECTED'),
      pushed: pushed.length,
      skipped: count((m) => upper(m.member_status) === 'SKIPPED'),
      push_failed: count((m) => upper(m.member_status) === 'PUSH_FAILED'),
      excluded: count((m) => upper(m.member_status) === 'EXCLUDED'),
      ready: count((m) => upper(m.eligibility_status) === 'READY' && upper(m.member_status) !== 'EXCLUDED'),
      warning: count((m) => upper(m.eligibility_status) === 'WARNING' && upper(m.member_status) !== 'EXCLUDED'),
      warning_unacknowledged: count((m) => upper(m.eligibility_status) === 'WARNING' && upper(m.member_status) === 'SELECTED' && upper(m.warnings_acknowledged) !== 'TRUE'),
      blocked: count((m) => upper(m.eligibility_status) === 'BLOCKED'),
      // Instantly's own counters when synced; NOVUS's ledger otherwise.
      emails_sent: analytics ? Number(analytics.emails_sent_count) || 0 : Math.max(sentFromEvents, sentFromMembers),
      contacted: analytics ? Number(analytics.contacted_count) || 0 : count((m) => Number(m.emails_sent_count) > 0),
      opens: analytics ? Number(analytics.open_count_unique ?? analytics.open_count) || 0 : count((m) => events.some((e) => upper(e.event_type) === 'EMAIL_OPENED' && text(e.member_id) === text(m.member_id))),
      replies: Math.max(analytics ? Number(analytics.reply_count_unique ?? analytics.reply_count) || 0 : 0, count((m) => text(m.replied_at))),
      positive: count((m) => POSITIVE_EVENT_TYPES.has(`LEAD_${upper(m.interest_status)}`) || text(m.meeting_booked_at)),
      negative: count((m) => NEGATIVE_EVENT_TYPES.has(`LEAD_${upper(m.interest_status)}`)),
      meetings: count((m) => text(m.meeting_booked_at) || ['MEETING_BOOKED', 'MEETING_COMPLETED', 'WON'].includes(upper(m.interest_status))),
      bounces: Math.max(analytics ? Number(analytics.bounced_count) || 0 : 0, count((m) => text(m.bounced_at) || upper(m.instantly_lead_status) === 'BOUNCED')),
      unsubscribes: Math.max(analytics ? Number(analytics.unsubscribed_count) || 0 : 0, count((m) => text(m.unsubscribed_at) || upper(m.instantly_lead_status) === 'UNSUBSCRIBED')),
      completed: analytics ? Number(analytics.completed_count) || 0 : count((m) => upper(m.instantly_lead_status) === 'COMPLETED'),
    },
  };
}
function bounceRate(view) {
  const denominator = view.metrics.pushed || view.metrics.leads;
  return denominator ? Math.round((view.metrics.bounces / denominator) * 1000) / 10 : null;
}
function memberView(row) {
  return {
    member_id: text(row.member_id), campaign_id: text(row.campaign_id), agency_id: text(row.agency_id), contact_id: text(row.contact_id),
    outbound_id: text(row.outbound_id), probe_id: text(row.probe_id), email: text(row.email), first_name: text(row.first_name),
    contact_name: text(row.contact_name), company_name: text(row.company_name),
    custom_variables: parseJson(row.custom_variables_json, {}),
    eligibility_status: upper(row.eligibility_status), eligibility_reasons: reasonsList(row.eligibility_reasons),
    warnings_acknowledged: upper(row.warnings_acknowledged) === 'TRUE',
    match_status: upper(row.match_status), match_method: text(row.match_method), match_note: text(row.match_note),
    member_status: upper(row.member_status), instantly_lead_id: text(row.instantly_lead_id), instantly_lead_status: upper(row.instantly_lead_status),
    interest_status: upper(row.interest_status), emails_sent_count: Number(row.emails_sent_count) || 0,
    last_event_type: upper(row.last_event_type), last_event_at: text(row.last_event_at),
    replied_at: text(row.replied_at), bounced_at: text(row.bounced_at), unsubscribed_at: text(row.unsubscribed_at), meeting_booked_at: text(row.meeting_booked_at),
    added_at: text(row.added_at), pushed_at: text(row.pushed_at), last_error: text(row.last_error), updated_at: text(row.updated_at),
  };
}
function eventView(row) {
  return {
    event_id: text(row.event_id), source: upper(row.source), event_type: upper(row.event_type), occurred_at: text(row.occurred_at),
    campaign_id: text(row.campaign_id), member_id: text(row.member_id), agency_id: text(row.agency_id), lead_email: text(row.lead_email),
    step: text(row.step), variant: text(row.variant), email_account: text(row.email_account), subject: text(row.subject), snippet: text(row.snippet),
  };
}
function instantlyErrorPayload(err) {
  if (err instanceof InstantlyApiError) return err.toJSON();
  return { code: 'UNEXPECTED', status: 0, message: err?.message || String(err), detail: '', retryable: false };
}
function configPayload() {
  const creds = instantlyCredentials();
  return {
    instantly_write_configured: creds.configured,
    instantly_read_configured: creds.read_configured,
    // Webhooks need Instantly's Hyper Growth plan; Growth (API-only) is fully
    // supported without them via the poller below. Both are optional extras
    // layered on the same underlying sync — neither is required to operate.
    webhook_secret_configured: Boolean(text(process.env.INSTANTLY_WEBHOOK_SECRET)),
    webhook_path: '/api/novus/webhooks/instantly',
    webhook_header: 'X-Novus-Instantly-Secret',
    campaign_poller_configured: Boolean(text(process.env.NOVUS_CAMPAIGN_POLLER_SECRET)),
    poll_path: '/api/novus/personalisation?novus_operation=campaign-sync-poll',
    poll_header: 'X-Novus-Campaign-Poller-Secret',
    poll_min_interval_ms: POLL_MIN_INTERVAL_MS,
  };
}

// ── GET campaigns-list ─────────────────────────────────────────────────────
export async function handleCampaignsList(req, res) {
  noStore(res);
  const refresh = String(req.query?.refresh || '') === '1';
  const nowMs = Date.now();
  if (!refresh && listCache && nowMs - listCache.at < CACHE_TTL_MS) {
    return res.status(200).json({ ...listCache.payload, cached: true, cache_age_ms: nowMs - listCache.at });
  }
  try {
    const repo = getRepo();
    const loaded = await readCampaignTables(repo);
    const members = memberRecords(loaded.tables[CAMPAIGN_MEMBERS_TAB]);
    const events = eventRecords(loaded.tables[CAMPAIGN_EVENTS_TAB]);
    const byCampaign = new Map();
    for (const m of members) { const k = text(m.campaign_id); if (!byCampaign.has(k)) byCampaign.set(k, []); byCampaign.get(k).push(m); }
    const eventsByCampaign = new Map();
    for (const e of events) { const k = text(e.campaign_id); if (!eventsByCampaign.has(k)) eventsByCampaign.set(k, []); eventsByCampaign.get(k).push(e); }
    const campaigns = campaignRecords(loaded.tables[CAMPAIGNS_TAB])
      .map((row) => { const view = campaignView(row, byCampaign.get(text(row.campaign_id)) || [], eventsByCampaign.get(text(row.campaign_id)) || []); return { ...view, bounce_rate: bounceRate(view), sequence: { step_count: (view.sequence.steps || []).length }, filters: undefined, policy: undefined, step_analytics: undefined }; })
      .sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0));
    const payload = {
      success: true, generated_at: nowIso(), cache_ttl_ms: CACHE_TTL_MS,
      setup: { available: loaded.available, missing: loaded.missing, header_mismatch: loaded.header_mismatch },
      config: configPayload(),
      counts: {
        total: campaigns.length,
        by_status: Object.fromEntries(CAMPAIGN_STATUSES.map((s) => [s, campaigns.filter((c) => c.status === s).length])),
        members: members.length, events: events.length,
      },
      campaigns,
      enums: { statuses: CAMPAIGN_STATUSES, types: CAMPAIGN_TYPES, reason_labels: REASON_LABEL, default_policy: DEFAULT_POLICY, default_schedule: DEFAULT_SCHEDULE, default_sending: DEFAULT_SENDING, probe_call_sequence: PROBE_CALL_SEQUENCE, probe_call_name: PROBE_CALL_CAMPAIGN_NAME, presets: presetEnums() },
    };
    listCache = { at: Date.now(), payload };
    return res.status(200).json({ ...payload, cached: false, cache_age_ms: 0 });
  } catch (err) {
    console.error('campaigns-list error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Failed to load campaigns' });
  }
}

// ── GET campaign-detail ────────────────────────────────────────────────────
async function loadCampaign(repo, campaignId) {
  const loaded = await readCampaignTables(repo);
  const record = parseRecords(loaded.tables[CAMPAIGNS_TAB], 'campaign_id').find((r) => text(r.obj.campaign_id) === text(campaignId)) || null;
  const members = memberRecords(loaded.tables[CAMPAIGN_MEMBERS_TAB]).filter((m) => text(m.campaign_id) === text(campaignId));
  const events = eventRecords(loaded.tables[CAMPAIGN_EVENTS_TAB]).filter((e) => text(e.campaign_id) === text(campaignId));
  return { loaded, record, campaign: record?.obj || null, members, events };
}
export async function handleCampaignDetail(req, res) {
  noStore(res);
  const campaignId = text(req.query?.campaign_id);
  if (!campaignId) return res.status(400).json({ success: false, error: 'Missing campaign_id' });
  const live = String(req.query?.live || '') === '1';
  try {
    const repo = getRepo();
    const { campaign, members, events } = await loadCampaign(repo, campaignId);
    if (!campaign) return res.status(404).json({ success: false, error: `No campaign ${campaignId}` });
    const view = campaignView(campaign, members, events);
    if (lockedPreset(campaign.campaign_type)) {
      const linked = await loadOptionalTables(repo, ['REPLY_EVENTS', 'ACTIONS', 'CALLS', 'DISCOVERY_SESSIONS']);
      view.probe_call_metrics = probeCallMetrics(campaign, members, events, linked);
    }
    const payload = {
      success: true, generated_at: nowIso(), config: configPayload(),
      campaign: { ...view, bounce_rate: bounceRate(view) },
      members: members.map(memberView).sort((a, b) => a.company_name.localeCompare(b.company_name)),
      events: events.map(eventView).sort((a, b) => (Date.parse(b.occurred_at) || 0) - (Date.parse(a.occurred_at) || 0)).slice(0, 300),
      reason_labels: REASON_LABEL,
      instantly: { live: false },
    };
    if (live && text(campaign.instantly_campaign_id)) {
      const client = clientFor('read');
      if (!client) payload.instantly = { live: false, error: { code: 'NO_API_KEY', message: 'No Instantly API key is configured' } };
      else {
        const out = { live: true };
        const attempt = async (key, fn) => { try { out[key] = await fn(); } catch (err) { out[`${key}_error`] = instantlyErrorPayload(err); } };
        await attempt('campaign', async () => {
          const c = await client.getCampaign(campaign.instantly_campaign_id);
          return { id: c.id, name: c.name, status: c.status, status_label: INSTANTLY_CAMPAIGN_STATUS_LABEL[String(c.status)] || String(c.status), not_sending_status: c.not_sending_status ?? null, email_list: c.email_list || [], daily_limit: c.daily_limit ?? null, timestamp_updated: c.timestamp_updated || '' };
        });
        await attempt('accounts', () => loadAccounts(client, false));
        payload.instantly = out;
      }
    }
    return res.status(200).json(payload);
  } catch (err) {
    console.error('campaign-detail error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Failed to load the campaign' });
  }
}

// ── GET campaign-accounts ──────────────────────────────────────────────────
async function loadAccounts(client, refresh) {
  const nowMs = Date.now();
  if (!refresh && accountsCache && nowMs - accountsCache.at < ACCOUNTS_TTL_MS) return accountsCache.accounts;
  const { items } = await client.listAccounts();
  const accounts = items.map((a) => ({
    email: text(a.email), status: Number(a.status), status_label: { 1: 'Active', 2: 'Paused', 3: 'Connection error', '-1': 'Soft bounce error', '-2': 'Sending error', '-3': 'Sending error' }[String(Number(a.status))] || String(a.status ?? ''),
    daily_limit: a.daily_limit ?? null, warmup_status: a.warmup_status ?? null, warmup_score: a.stat_warmup_score ?? null,
    first_name: text(a.first_name), last_name: text(a.last_name), provider_code: a.provider_code ?? null,
  })).sort((a, b) => a.email.localeCompare(b.email));
  accountsCache = { at: Date.now(), accounts };
  return accounts;
}
export async function handleCampaignAccounts(req, res) {
  noStore(res);
  const client = clientFor('read');
  if (!client) return res.status(200).json({ success: true, available: false, error: 'No Instantly API key is configured', accounts: [], suggested: novusMailboxes() });
  try {
    const accounts = await loadAccounts(client, String(req.query?.refresh || '') === '1');
    return res.status(200).json({ success: true, available: true, accounts, suggested: novusMailboxes() });
  } catch (err) {
    return res.status(200).json({ success: true, available: false, error: instantlyErrorPayload(err), accounts: [], suggested: novusMailboxes() });
  }
}

// ── GET lead-timeline ──────────────────────────────────────────────────────
export async function handleLeadTimeline(req, res) {
  noStore(res);
  const agencyId = text(req.query?.agency_id);
  if (!agencyId) return res.status(400).json({ success: false, error: 'Missing agency_id' });
  try {
    const repo = getRepo();
    const tables = await loadOptionalTables(repo, TIMELINE_TABS);
    const timeline = buildLeadTimeline(tables, agencyId, { now: nowIso() });
    if (!timeline.agency_name && !timeline.entries.length) return res.status(404).json({ success: false, error: `No agency ${agencyId}` });
    return res.status(200).json({ success: true, ...timeline, profile: buildLeadProfile(tables, agencyId, { now: nowIso() }) });
  } catch (err) {
    console.error('lead-timeline error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Failed to build the timeline' });
  }
}

// ── POST campaign-setup ────────────────────────────────────────────────────
export async function handleCampaignSetup(req, res) {
  noStore(res);
  if (text(req.body?.confirm) !== CONFIRM.SETUP) return res.status(400).json({ success: false, error: `Missing confirm=${CONFIRM.SETUP}` });
  try {
    const tabs = await ensureCampaignTabs(getRepo());
    invalidateCampaignCache();
    return res.status(200).json({ success: true, tabs });
  } catch (err) {
    console.error('campaign-setup error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Campaign setup failed' });
  }
}

// ── POST campaign-audience (preview, no write) ─────────────────────────────
async function buildAudience(repo, { filters, policy, campaign, limit = 400, applyFilters = true, cohortIds = null, preview = false }) {
  let snapshot;
  if (preview && audienceTablesCache && Date.now() - audienceTablesCache.at < 15_000) snapshot = await audienceTablesCache.promise;
  else {
    const promise = Promise.all([loadOptionalTables(repo, AUDIENCE_TABS), readCampaignTables(repo)]);
    if (preview) audienceTablesCache = { at: Date.now(), promise };
    try { snapshot = await promise; } catch (err) { if (preview) audienceTablesCache = null; throw err; }
  }
  const [tables, loaded] = snapshot;
  const audience = buildCampaignAudience(tables, loaded.tables, { filters, policy, campaign, now: nowIso(), limit, applyFilters, cohortIds });
  const expected = cohortIds?.filter((id) => !normaliseFilters(filters).exclude_agency_ids.includes(id)).length;
  if (cohortIds && audience.selected !== expected) throw new Error(`Prepared cohort has ${expected} selected IDs but only ${audience.selected} resolve to agencies; campaign creation is blocked`);
  return audience;
}
export async function handleCampaignAudience(req, res) {
  noStore(res);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    const campaignType = CAMPAIGN_TYPES.includes(upper(body.campaign_type)) ? upper(body.campaign_type) : 'ENQUIRY_FOLLOWUP';
    const cohort = await preparedCohort(campaignType);
    const filters = cohort ? { agency_ids: cohort.ids, exclude_agency_ids: body.filters?.exclude_agency_ids || [] } : body.filters || {};
    if (!cohort && upper(body.audience_source) === 'MANUAL' && !normaliseFilters(filters).agency_ids.length) return res.status(400).json({ success: false, error: 'Enter agency IDs for a manually selected audience.' });
    const key = JSON.stringify([campaignType, filters, body.policy || {}, body.campaign_id || '', body.limit || 400]);
    const now = Date.now();
    if (audienceCache?.key === key && now - audienceCache.at < 15_000) return res.status(200).json({ ...await audienceCache.promise, cached: true });
    const promise = buildAudience(getRepo(), {
      filters, policy: body.policy || {}, cohortIds: cohort?.ids || null, preview: true,
      campaign: { campaign_id: text(body.campaign_id), campaign_type: campaignType },
      limit: Math.min(1000, Math.max(50, Number(body.limit) || 400)),
    }).then((audience) => ({ success: true, ...audience, filters: cohort ? { prepared_cohort: cohort.label } : audience.filters, cohort: cohort ? { label: cohort.label, count: cohort.count } : null, audience_source: cohort ? 'PREPARED' : (normaliseFilters(filters).agency_ids.length ? 'MANUAL' : 'FILTERS') }));
    audienceCache = { key, at: now, promise };
    return res.status(200).json({ ...await promise, cached: false });
  } catch (err) {
    audienceCache = null;
    console.error('campaign-audience error:', err);
    return res.status(err?.statusCode === 429 ? 429 : 503).json({ success: false, error: err?.statusCode === 429 ? 'Google Sheets is temporarily rate limited. Audience could not be verified; try again shortly.' : err?.message || 'Failed to build the audience' });
  }
}

// ── configuration validation shared by create/update ───────────────────────
export function normaliseSequence(input) {
  const steps = Array.isArray(input?.steps) ? input.steps : [];
  const out = steps.map((step, i) => {
    const variants = Array.isArray(step?.variants) && step.variants.length
      ? step.variants
      : [{ subject: step?.subject, body: step?.body }];
    return {
      step: i + 1,
      delay_days: i === 0 ? 0 : Math.max(0, Math.floor(Number(step?.delay_days ?? step?.delay ?? 0) || 0)),
      variants: variants.map((v) => ({ subject: text(v?.subject), body: String(v?.body ?? '').replace(/\r\n/g, '\n').trim(), disabled: v?.disabled === true })),
    };
  });
  const errors = [];
  if (!out.length) errors.push('sequence needs at least one email step');
  out.forEach((step) => {
    if (!step.variants.some((v) => (step.step > 1 || v.subject) && v.body && !v.disabled)) errors.push(`step ${step.step} needs a body${step.step === 1 ? ' and a subject' : ''}`);
    if (step.step > 1 && step.delay_days < 1) errors.push(`step ${step.step} needs a delay of at least 1 day`);
  });
  return { sequence: { steps: out }, errors };
}
export function normaliseSchedule(input) {
  const s = { ...DEFAULT_SCHEDULE, ...(input && typeof input === 'object' ? input : {}) };
  const errors = [];
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!time.test(text(s.from)) || !time.test(text(s.to))) errors.push('schedule times must be HH:MM');
  const days = {};
  for (let d = 0; d <= 6; d += 1) days[d] = s.days?.[d] === true || upper(s.days?.[d]) === 'TRUE';
  if (!Object.values(days).some(Boolean)) errors.push('schedule needs at least one sending day');
  return { schedule: { name: text(s.name) || DEFAULT_SCHEDULE.name, from: text(s.from), to: text(s.to), timezone: text(s.timezone) || DEFAULT_SCHEDULE.timezone, days, start_date: text(s.start_date) || '' }, errors };
}
export function normaliseSending(input) {
  const s = { ...DEFAULT_SENDING, ...(input && typeof input === 'object' ? input : {}) };
  const list = (Array.isArray(s.email_list) ? s.email_list : String(s.email_list || '').split(/[,\s]+/)).map(lower).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  const bool = (v, d) => (v === undefined || v === null ? d : v === true || upper(v) === 'TRUE');
  return {
    sending: {
      email_list: [...new Set(list)],
      daily_limit: Math.max(1, Math.min(2000, Math.floor(Number(s.daily_limit) || DEFAULT_SENDING.daily_limit))),
      daily_max_leads: Math.max(0, Math.floor(Number(s.daily_max_leads) || 0)),
      stop_on_reply: bool(s.stop_on_reply, true), stop_on_auto_reply: bool(s.stop_on_auto_reply, false),
      open_tracking: bool(s.open_tracking, true), link_tracking: bool(s.link_tracking, false), text_only: bool(s.text_only, false),
    },
    errors: [],
  };
}

// The exact POST /campaigns body. Plain-text bodies become <br/> HTML, which
// is what Instantly documents for delivered line breaks. NOVUS step N's
// delay_days is "wait before this step"; Instantly's step delay is "wait
// before the NEXT step", so the values shift by one.
export function buildInstantlyCampaignPayload({ name, sequence, schedule, sending }) {
  const steps = sequence.steps.map((step, i) => ({
    type: 'email',
    delay: sequence.steps[i + 1] ? sequence.steps[i + 1].delay_days : 0,
    delay_unit: 'days',
    pre_delay: 0,
    pre_delay_unit: 'days',
    variants: step.variants.filter((v) => !v.disabled).map((v) => ({ subject: v.subject, body: v.body.replace(/\n/g, '<br/>') })),
  }));
  const payload = {
    name,
    campaign_schedule: {
      ...(schedule.start_date ? { start_date: schedule.start_date } : {}),
      schedules: [{ name: schedule.name, timing: { from: schedule.from, to: schedule.to }, days: Object.fromEntries(Object.entries(schedule.days).map(([k, v]) => [String(k), Boolean(v)])), timezone: schedule.timezone }],
    },
    sequences: [{ steps }],
    email_list: sending.email_list,
    daily_limit: sending.daily_limit,
    stop_on_reply: sending.stop_on_reply,
    stop_on_auto_reply: sending.stop_on_auto_reply,
    open_tracking: sending.open_tracking,
    link_tracking: sending.link_tracking,
    text_only: sending.text_only,
  };
  if (sending.daily_max_leads > 0) payload.daily_max_leads = sending.daily_max_leads;
  return payload;
}

// Compare the provider's persisted configuration, not the create response.
// Blank follow-up subjects are intentional: Instantly keeps those emails in
// the first email's thread. Any nonblank replacement is a material change.
export function instantlyConfigurationDifferences(expected, remote) {
  const differences = [];
  if (!remote || typeof remote !== 'object') return ['campaign read-back is missing'];
  if (text(remote.name) !== text(expected.name)) differences.push('campaign name');
  const actualSequences = remote.sequences;
  if (!Array.isArray(actualSequences) || actualSequences.length !== 1) differences.push('sequence count');
  const actualSteps = actualSequences?.[0]?.steps;
  const expectedSteps = expected.sequences[0].steps;
  if (!Array.isArray(actualSteps) || actualSteps.length !== expectedSteps.length) differences.push('step count');
  else expectedSteps.forEach((step, i) => {
    const actual = actualSteps[i];
    if (text(actual?.type || 'email').toLowerCase() !== 'email') differences.push(`step ${i + 1} type`);
    if (Number(actual?.delay) !== step.delay || text(actual?.delay_unit) !== step.delay_unit) differences.push(`step ${i + 1} delay`);
    if (Number(actual?.pre_delay || 0) !== 0) differences.push(`step ${i + 1} pre-delay`);
    if (!Array.isArray(actual?.variants) || actual.variants.length !== step.variants.length) differences.push(`step ${i + 1} variant count`);
    else step.variants.forEach((variant, j) => {
      const got = actual.variants[j];
      if (got?.v_disabled === true) differences.push(`step ${i + 1} variant ${j + 1} disabled`);
      if (text(got?.subject) !== text(variant.subject)) differences.push(`step ${i + 1} subject ${j + 1}`);
      if (comparableBody(got?.body) !== comparableBody(variant.body)) differences.push(`step ${i + 1} body ${j + 1}`);
    });
  });
  for (const field of ['stop_on_reply', 'stop_on_auto_reply', 'open_tracking', 'link_tracking', 'text_only', 'daily_limit']) {
    if (remote[field] !== expected[field]) differences.push(field);
  }
  if (Number(remote.daily_max_leads || 0) !== Number(expected.daily_max_leads || 0)) differences.push('daily_max_leads');
  const expectedEmails = expected.email_list.map(lower).sort();
  const actualEmails = Array.isArray(remote.email_list) ? remote.email_list.map(lower).sort() : null;
  if (JSON.stringify(actualEmails) !== JSON.stringify(expectedEmails)) differences.push('sending accounts');
  const a = remote.campaign_schedule?.schedules?.[0];
  const b = expected.campaign_schedule.schedules[0];
  if (!a || text(a.timing?.from) !== b.timing.from || text(a.timing?.to) !== b.timing.to || text(a.timezone) !== b.timezone
    || Object.keys(b.days).some((day) => a.days?.[day] !== b.days[day])) differences.push('sending schedule');
  if (expected.campaign_schedule.start_date && text(remote.campaign_schedule?.start_date) !== expected.campaign_schedule.start_date) differences.push('start date');
  return differences;
}

function expectedInstantlyCampaign(campaign) {
  return buildInstantlyCampaignPayload({
    name: text(campaign.name), sequence: parseJson(campaign.sequence_json, { steps: [] }),
    schedule: { ...DEFAULT_SCHEDULE, ...parseJson(campaign.schedule_json, {}) },
    sending: { ...DEFAULT_SENDING, ...parseJson(campaign.sending_json, {}) },
  });
}

function memberRowFromAudience(row, campaignId, now) {
  const e = row.eligibility;
  return {
    member_id: newCampaignMemberId(), campaign_id: campaignId, agency_id: row.agency_id, contact_id: row.contact.contact_id,
    outbound_id: row.outbound_id, probe_id: row.probe?.probe_id || '', email: lower(row.contact.email), first_name: row.contact.first_name,
    contact_name: row.contact.name, company_name: row.agency_name,
    custom_variables_json: JSON.stringify(leadPayloadFor(row, { campaignId }).custom_variables),
    eligibility_status: e.status, eligibility_reasons: e.reasons.join(','), warnings_acknowledged: '',
    member_status: e.status === 'BLOCKED' ? 'EXCLUDED' : 'SELECTED', instantly_lead_id: '', instantly_lead_status: '', interest_status: '',
    emails_sent_count: 0, last_event_type: '', last_event_at: '', replied_at: '', bounced_at: '', unsubscribed_at: '', meeting_booked_at: '',
    added_at: now, pushed_at: '', last_error: '', updated_at: now,
  };
}

// ── POST campaign-create ───────────────────────────────────────────────────
export async function handleCampaignCreate(req, res) {
  noStore(res);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (text(body.confirm) !== CONFIRM.CREATE) return res.status(400).json({ success: false, error: `Missing confirm=${CONFIRM.CREATE}` });
  const name = text(body.name).slice(0, 120);
  if (!name) return res.status(400).json({ success: false, error: 'Campaign name is required' });
  const campaignType = CAMPAIGN_TYPES.includes(upper(body.campaign_type)) ? upper(body.campaign_type) : 'ENQUIRY_FOLLOWUP';
  const seq = normaliseSequence(body.sequence);
  const sch = normaliseSchedule(body.schedule);
  const snd = normaliseSending(body.sending);
  const errors = [...seq.errors, ...sch.errors, ...snd.errors];
  const preset = lockedPreset(campaignType);
  if (preset) {
    if (name !== preset.name) errors.push(`Campaign name must be ${preset.name}`);
    if (!isPresetSequence(preset, seq.sequence)) errors.push(`The ${preset.label} sequence must match the approved copy and delays`);
    if (!snd.sending.stop_on_reply) errors.push('Stop on reply must be enabled');
    if (!preset.cohort && !normaliseFilters(body.filters || {}).agency_ids.length) errors.push('Select an explicit agency ID cohort before creating this campaign');
  }
  if (errors.length) return res.status(400).json({ success: false, error: errors.join('; '), errors });
  if (!preset && upper(body.audience_source) === 'MANUAL' && !normaliseFilters(body.filters || {}).agency_ids.length) return res.status(400).json({ success: false, error: 'Enter agency IDs for a manually selected audience.' });
  try {
    const repo = getRepo();
    const loaded = await readCampaignTables(repo);
    if (!loaded.available) return res.status(409).json({ success: false, error: 'Campaign tabs are not set up', setup: loaded });
    if (campaignRecords(loaded.tables[CAMPAIGNS_TAB]).some((row) => lower(row.name) === lower(name))) {
      return res.status(409).json({ success: false, error: `A campaign named "${name}" already exists` });
    }
    const cohort = await preparedCohort(campaignType);
    const filters = normaliseFilters(cohort ? { agency_ids: cohort.ids, exclude_agency_ids: body.filters?.exclude_agency_ids || [] } : body.filters || {});
    const policy = normalisePolicy({ ...(body.policy || {}), requires_probe: preset ? preset.requires_probe : (body.policy?.requires_probe ?? (campaignType === 'ENQUIRY_FOLLOWUP')) });
    if (preset) Object.assign(policy, { requires_probe: preset.requires_probe, allow_risky_email: false, block_active_campaign: true, block_active_conversation: true, block_active_followup: true, block_prior_negative: true, block_meeting_booked: true, block_opted_out: true });
    const campaignId = newCampaignId();
    const now = nowIso();
    // The audience is rebuilt SERVER-SIDE from the filters — the browser's
    // idea of which rows are ready is never trusted for the member snapshot.
    const audience = await buildAudience(repo, { filters, policy, campaign: { campaign_id: campaignId, campaign_type: campaignType }, limit: 0, cohortIds: cohort?.ids || null });
    if (Number(body.confirm_recipient_count) !== audience.selected || !audience.selected) return res.status(409).json({ success: false, error: `Audience changed or is empty. Review and confirm the current recipient count (${audience.selected}).` });
    const memberRows = audience.rows.map((row) => memberRowFromAudience(row, campaignId, now));
    const campaignRow = {
      campaign_id: campaignId, instantly_campaign_id: '', name, status: 'DRAFT', campaign_type: campaignType,
      sequence_json: JSON.stringify(seq.sequence), schedule_json: JSON.stringify(sch.schedule), sending_json: JSON.stringify(snd.sending),
      audience_filters_json: JSON.stringify(filters), policy_json: JSON.stringify(policy),
      instantly_status: '', analytics_json: '', step_analytics_json: '', last_synced_at: '', last_error: '',
      created_at: now, pushed_at: '', launched_at: '', paused_at: '', completed_at: '', updated_at: now,
    };
    await repo.appendRowsBatch(CAMPAIGNS_TAB, [rowFor(loaded.tables[CAMPAIGNS_TAB].header, campaignRow)]);
    if (memberRows.length) await repo.appendRowsBatch(CAMPAIGN_MEMBERS_TAB, memberRows.map((m) => rowFor(loaded.tables[CAMPAIGN_MEMBERS_TAB].header, m)));
    await appendEvents(repo, [
      { dedupe_key: novusDedupeKey('created', campaignId), event_type: 'CAMPAIGN_CREATED', campaign_id: campaignId, snippet: name, payload_json: { filters, policy, summary: audience.summary } },
      ...memberRows.filter((m) => m.member_status === 'SELECTED').map((m) => ({
        dedupe_key: novusDedupeKey('added', campaignId, m.agency_id), event_type: 'LEAD_ADDED', campaign_id: campaignId, member_id: m.member_id,
        agency_id: m.agency_id, contact_id: m.contact_id, lead_email: m.email, snippet: `${m.eligibility_status}: ${m.eligibility_reasons}`,
      })),
    ], { existingTable: loaded.tables[CAMPAIGN_EVENTS_TAB], now });
    invalidateCampaignCache();
    return res.status(200).json({ success: true, campaign_id: campaignId, summary: audience.summary, members: memberRows.length });
  } catch (err) {
    console.error('campaign-create error:', err);
    return res.status(err?.statusCode === 429 ? 429 : 503).json({ success: false, error: err?.statusCode === 429 ? 'Google Sheets is temporarily rate limited. Audience could not be verified; no campaign was created.' : err?.message || 'Campaign creation failed' });
  }
}

// ── POST campaign-update ───────────────────────────────────────────────────
// Configuration edits are allowed while the campaign has not been launched
// (DRAFT) or is PAUSED; the audience can be refreshed only before a push.
export async function handleCampaignUpdate(req, res) {
  noStore(res);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const campaignId = text(body.campaign_id);
  if (!campaignId) return res.status(400).json({ success: false, error: 'Missing campaign_id' });
  try {
    const repo = getRepo();
    const { loaded, campaign, members } = await loadCampaign(repo, campaignId);
    if (!campaign) return res.status(404).json({ success: false, error: `No campaign ${campaignId}` });
    if (lockedPreset(campaign.campaign_type) && ['name', 'sequence', 'sending', 'policy', 'campaign_type'].some((key) => body[key] !== undefined)) {
      return res.status(409).json({ success: false, error: `The ${lockedPreset(campaign.campaign_type).label} copy and safety settings are fixed; create a new version for changes` });
    }
    const status = upper(campaign.status);
    const now = nowIso();
    const patch = { updated_at: now };
    const changed = [];

    if (body.acknowledge_warnings === true) {
      const targets = members.filter((m) => upper(m.eligibility_status) === 'WARNING' && upper(m.member_status) === 'SELECTED' && upper(m.warnings_acknowledged) !== 'TRUE');
      await patchMembersBatch(repo, targets.map((m) => ({ member_id: m.member_id, patch: { warnings_acknowledged: 'TRUE', updated_at: now } })));
      changed.push(`acknowledged ${targets.length} warning${targets.length === 1 ? '' : 's'}`);
    }
    if (Array.isArray(body.remove_agency_ids) && body.remove_agency_ids.length) {
      const ids = new Set(body.remove_agency_ids.map(text));
      const targets = members.filter((m) => ids.has(text(m.agency_id)) && upper(m.member_status) === 'SELECTED');
      await patchMembersBatch(repo, targets.map((m) => ({ member_id: m.member_id, patch: { member_status: 'EXCLUDED', last_error: 'removed by operator', updated_at: now } })));
      changed.push(`removed ${targets.length}`);
    }
    if (['DRAFT', 'PAUSED'].includes(status)) {
      if (body.name !== undefined) { const name = text(body.name).slice(0, 120); if (!name) return res.status(400).json({ success: false, error: 'Campaign name is required' }); patch.name = name; changed.push('name'); }
      if (body.sequence !== undefined) { const seq = normaliseSequence(body.sequence); if (seq.errors.length) return res.status(400).json({ success: false, error: seq.errors.join('; ') }); patch.sequence_json = JSON.stringify(seq.sequence); changed.push('sequence'); }
      if (body.schedule !== undefined) { const sch = normaliseSchedule(body.schedule); if (sch.errors.length) return res.status(400).json({ success: false, error: sch.errors.join('; ') }); patch.schedule_json = JSON.stringify(sch.schedule); changed.push('schedule'); }
      if (body.sending !== undefined) { patch.sending_json = JSON.stringify(normaliseSending(body.sending).sending); changed.push('sending'); }
      if (body.policy !== undefined) { patch.policy_json = JSON.stringify(normalisePolicy({ ...normalisePolicy(parseJson(campaign.policy_json, {})), ...body.policy })); changed.push('policy'); }
      if (body.campaign_type !== undefined && CAMPAIGN_TYPES.includes(upper(body.campaign_type))) { patch.campaign_type = upper(body.campaign_type); changed.push('type'); }
      // The Instantly copy follows only while nothing has been sent from it.
      if (status === 'DRAFT' && text(campaign.instantly_campaign_id) && (patch.sequence_json || patch.schedule_json || patch.sending_json || patch.name)) {
        const client = clientFor('write');
        if (client) {
          try {
            const merged = { ...campaign, ...patch };
            await client.updateCampaign(campaign.instantly_campaign_id, buildInstantlyCampaignPayload({
              name: text(merged.name), sequence: parseJson(merged.sequence_json, { steps: [] }), schedule: { ...DEFAULT_SCHEDULE, ...parseJson(merged.schedule_json, {}) }, sending: { ...DEFAULT_SENDING, ...parseJson(merged.sending_json, {}) },
            }));
            changed.push('instantly copy updated');
            patch.last_error = '';
          } catch (err) {
            patch.last_error = `Instantly update failed: ${instantlyErrorPayload(err).detail || instantlyErrorPayload(err).message}`;
          }
        }
      }
    } else if (body.name !== undefined || body.sequence !== undefined || body.schedule !== undefined || body.sending !== undefined || body.filters !== undefined) {
      return res.status(409).json({ success: false, error: `Campaign is ${status}; configuration can only change while DRAFT or PAUSED` });
    }
    if (body.filters !== undefined || body.refresh_audience === true) {
      if (members.some((m) => upper(m.member_status) === 'PUSHED')) return res.status(409).json({ success: false, error: 'Audience cannot be rebuilt after leads were pushed to Instantly; add a new campaign for new leads' });
      const filters = normaliseFilters(body.filters !== undefined ? body.filters : parseJson(campaign.audience_filters_json, {}));
      const policy = normalisePolicy(parseJson(patch.policy_json || campaign.policy_json, {}));
      const audience = await buildAudience(repo, { filters, policy, campaign: { campaign_id: campaignId, campaign_type: patch.campaign_type || upper(campaign.campaign_type) }, limit: 0 });
      // Replace the snapshot: old un-pushed members are excluded, new ones appended.
      await patchMembersBatch(repo, members.filter((m) => upper(m.member_status) !== 'EXCLUDED').map((m) => ({ member_id: m.member_id, patch: { member_status: 'EXCLUDED', last_error: 'superseded by audience refresh', updated_at: now } })));
      const memberRows = audience.rows.map((row) => memberRowFromAudience(row, campaignId, now));
      if (memberRows.length) await repo.appendRowsBatch(CAMPAIGN_MEMBERS_TAB, memberRows.map((m) => rowFor(loaded.tables[CAMPAIGN_MEMBERS_TAB].header, m)));
      await appendEvents(repo, memberRows.filter((m) => m.member_status === 'SELECTED').map((m) => ({
        dedupe_key: novusDedupeKey('added', campaignId, m.agency_id, now), event_type: 'LEAD_ADDED', campaign_id: campaignId, member_id: m.member_id,
        agency_id: m.agency_id, contact_id: m.contact_id, lead_email: m.email, snippet: `${m.eligibility_status}: ${m.eligibility_reasons}`,
      })), { existingTable: loaded.tables[CAMPAIGN_EVENTS_TAB], now });
      patch.audience_filters_json = JSON.stringify(filters);
      changed.push(`audience rebuilt (${memberRows.length})`);
    }
    await patchCampaign(repo, campaignId, patch);
    invalidateCampaignCache();
    return res.status(200).json({ success: true, campaign_id: campaignId, changed });
  } catch (err) {
    console.error('campaign-update error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Campaign update failed' });
  }
}

// ── POST campaign-push ─────────────────────────────────────────────────────
// Creates the Instantly campaign (Draft — never activated here) if NOVUS has
// no id for it yet, then adds every READY member plus WARNING members only
// when include_warnings=true (which the UI sets after an explicit
// acknowledgement). BLOCKED members are never sent. Eligibility is
// re-evaluated against the live workbook first, so a lead that opted out
// since selection is stopped even though its snapshot said READY.
export async function handleCampaignPush(req, res) {
  noStore(res);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const campaignId = text(body.campaign_id);
  if (text(body.confirm) !== CONFIRM.PUSH) return res.status(400).json({ success: false, error: `Missing confirm=${CONFIRM.PUSH}` });
  if (!campaignId) return res.status(400).json({ success: false, error: 'Missing campaign_id' });
  const includeWarnings = body.include_warnings === true;
  const client = clientFor('write');
  if (!client) return res.status(500).json({ success: false, error: 'INSTANTLY_API_KEY is not set in this environment; nothing was pushed' });
  try {
    const repo = getRepo();
    const { loaded, campaign, members } = await loadCampaign(repo, campaignId);
    if (!campaign) return res.status(404).json({ success: false, error: `No campaign ${campaignId}` });
    const preset = lockedPreset(campaign.campaign_type);
    const probeCall = Boolean(preset);
    if (probeCall && (!isPresetSequence(preset, parseJson(campaign.sequence_json, {})) || !parseJson(campaign.sending_json, {}).stop_on_reply || !normaliseFilters(parseJson(campaign.audience_filters_json, {})).agency_ids.length)) {
      return res.status(409).json({ success: false, error: `${preset.label} campaign configuration is incomplete or changed; nothing was pushed` });
    }
    if (upper(campaign.status) === 'COMPLETED') return res.status(409).json({ success: false, error: 'Campaign is COMPLETED' });
    const now = nowIso();
    const result = { campaign_id: campaignId, instantly_campaign_id: text(campaign.instantly_campaign_id), created_instantly_campaign: false, adopted_instantly_campaign: false, pushed: 0, skipped: 0, failed: 0, blocked_at_push: 0, warnings_held: 0, chunks: [], errors: [] };
    const events = [];
    const patches = [];
    const campaignPatch = { updated_at: now, last_error: '' };

    // 1. The Instantly campaign object. Idempotent: an existing id wins; a
    //    campaign of exactly this name already in the workspace (a previous
    //    push that created it but failed before recording the id) is adopted
    //    rather than duplicated; only then is one created.
    let instantlyId = text(campaign.instantly_campaign_id);
    if (!instantlyId) {
      try {
        const { items } = await client.listCampaigns();
        const existing = items.find((c) => lower(c?.name) === lower(campaign.name));
        if (existing?.id) { instantlyId = text(existing.id); result.adopted_instantly_campaign = true; }
      } catch (err) {
        const e = instantlyErrorPayload(err);
        if (probeCall) return res.status(502).json({ success: false, error: 'Could not check existing Instantly campaigns; nothing was pushed', instantly: e, ...result });
        result.errors.push({ stage: 'list_campaigns', ...e });
      }
    }
    if (!instantlyId) {
      try {
        const created = await client.createCampaign(expectedInstantlyCampaign(campaign));
        instantlyId = text(created.id);
        result.created_instantly_campaign = true;
        campaignPatch.instantly_status = String(created.status ?? 0);
      } catch (err) {
        const e = instantlyErrorPayload(err);
        await patchCampaign(repo, campaignId, { updated_at: now, last_error: `Instantly campaign creation failed: ${e.detail || e.message}` });
        invalidateCampaignCache();
        return res.status(502).json({ success: false, error: `Instantly campaign creation failed: ${e.detail || e.message}`, instantly: e, ...result });
      }
    }
    // Record the id BEFORE any lead work so a later failure cannot orphan it.
    if (instantlyId !== text(campaign.instantly_campaign_id)) {
      await patchCampaign(repo, campaignId, { instantly_campaign_id: instantlyId, updated_at: now });
      events.push({ dedupe_key: novusDedupeKey('pushed', campaignId, instantlyId), event_type: 'CAMPAIGN_PUSHED', campaign_id: campaignId, instantly_campaign_id: instantlyId, snippet: result.created_instantly_campaign ? 'Instantly campaign created (draft)' : 'Existing Instantly campaign adopted' });
    }
    result.instantly_campaign_id = instantlyId;

    // Recover provider members before adding anything. Instantly can accept a
    // lead while the NOVUS write fails; a retry must adopt that lead, not send
    // a second enrolment. Fail closed if the provider inventory is incomplete.
    let remoteByEmail = new Map();
    const remoteOtherEmails = new Set();
    {
      try {
        const expected = expectedInstantlyCampaign(campaign);
        let remoteCampaign = await client.getCampaign(instantlyId);
        let differences = instantlyConfigurationDifferences(expected, remoteCampaign);
        // A push explicitly synchronises NOVUS's draft. Repair a newly
        // created shell or an already linked draft with one replacement PATCH;
        // never rewrite a same-name campaign discovered for adoption.
        if (differences.length && Number(remoteCampaign.status) === 0
          && (result.created_instantly_campaign || text(campaign.instantly_campaign_id) === instantlyId)) {
          await client.updateCampaign(instantlyId, expected);
          remoteCampaign = await client.getCampaign(instantlyId);
          differences = instantlyConfigurationDifferences(expected, remoteCampaign);
        }
        if (Number(remoteCampaign.status) !== 0) differences.push('campaign is not a draft');
        if (differences.length) throw new Error(`Instantly read-back differs: ${differences.join(', ')}`);
        const remote = await client.listCampaignLeads(instantlyId);
        if (remote.truncated) throw new Error('Instantly lead inventory was truncated');
        remoteByEmail = new Map(remote.items.filter((lead) => text(lead.email)).map((lead) => [lower(lead.email), lead]));
        const otherActive = campaignRecords(loaded.tables[CAMPAIGNS_TAB]).filter((row) =>
          text(row.campaign_id) !== campaignId && text(row.instantly_campaign_id)
          && ['ACTIVE', 'PAUSED'].includes(upper(row.status)));
        for (const other of otherActive) {
          const inventory = await client.listCampaignLeads(other.instantly_campaign_id);
          if (inventory.truncated) throw new Error(`Instantly lead inventory was truncated for ${text(other.name)}`);
          for (const lead of inventory.items) if ([1, 2].includes(Number(lead.status))) remoteOtherEmails.add(lower(lead.email));
        }
      } catch (err) {
        await patchCampaign(repo, campaignId, { updated_at: now, last_error: err.message });
        return res.status(502).json({ success: false, error: `Instantly configuration or lead inventory could not be verified: ${instantlyErrorPayload(err).detail || err.message}`, ...result });
      }
    }

    // 2. Fresh eligibility over the selected members. PUSH_FAILED rows are
    //    retried here too: a failed add request left nothing in Instantly.
    const selected = members.filter((m) => ['SELECTED', 'PUSH_FAILED'].includes(upper(m.member_status)));
    const fresh = selected.length ? await buildAudience(repo, {
      filters: { ...normaliseFilters(parseJson(campaign.audience_filters_json, {})), agency_ids: selected.map((m) => text(m.agency_id)), exclude_agency_ids: [] },
      policy: parseJson(campaign.policy_json, {}), campaign: { campaign_id: campaignId, campaign_type: upper(campaign.campaign_type) }, limit: 0, applyFilters: false,
    }) : { rows: [] };
    const freshById = new Map(fresh.rows.map((row) => [row.agency_id, row]));
    const toPush = [];
    const seenContacts = new Set();
    for (const m of selected) {
      const live = freshById.get(text(m.agency_id));
      // A member the live audience cannot see any more (agency deleted, no
      // email) is treated as blocked rather than pushed on stale data.
      const status = live ? live.eligibility.status : 'BLOCKED';
      const reasons = live ? live.eligibility.reasons : ['NO_LIVE_RECORD'];
      // in_this_campaign is true for the member's own row — not a block here.
      const ownBlocks = live ? live.eligibility.blocks.filter((code) => code !== 'ALREADY_IN_CAMPAIGN') : ['NO_LIVE_RECORD'];
      const effectiveStatus = status === 'BLOCKED' && !ownBlocks.length ? (live.eligibility.warnings.length ? 'WARNING' : 'READY') : status;
      const effectiveReasons = effectiveStatus === 'BLOCKED' ? ownBlocks : reasons.filter((code) => code !== 'ALREADY_IN_CAMPAIGN');
      if (effectiveStatus !== upper(m.eligibility_status) || effectiveReasons.join(',') !== text(m.eligibility_reasons)) {
        patches.push({ member_id: m.member_id, patch: { eligibility_status: effectiveStatus, eligibility_reasons: effectiveReasons.join(','), updated_at: now } });
      }
      if (effectiveStatus === 'BLOCKED') { result.blocked_at_push += 1; patches.push({ member_id: m.member_id, patch: { last_error: `blocked at push: ${effectiveReasons.join(', ')}`, updated_at: now } }); continue; }
      if (probeCall && remoteOtherEmails.has(lower(m.email))) { result.blocked_at_push += 1; patches.push({ member_id: m.member_id, patch: { eligibility_status: 'BLOCKED', eligibility_reasons: 'IN_ACTIVE_CAMPAIGN', last_error: 'already active in another Instantly campaign', updated_at: now } }); continue; }
      if (effectiveStatus === 'WARNING' && !(includeWarnings || upper(m.warnings_acknowledged) === 'TRUE')) { result.warnings_held += 1; continue; }
      const contactKey = `${text(m.agency_id)}:${lower(m.email)}`;
      if (probeCall && seenContacts.has(contactKey)) { result.skipped += 1; patches.push({ member_id: m.member_id, patch: { member_status: 'SKIPPED', last_error: 'duplicate agency/contact selection', updated_at: now } }); continue; }
      seenContacts.add(contactKey);
      const remote = remoteByEmail.get(lower(m.email));
      if (remote) {
        result.skipped += 1;
        patches.push({ member_id: m.member_id, patch: { member_status: 'PUSHED', instantly_lead_id: text(remote.id), instantly_lead_status: leadStatusLabel(remote.status), pushed_at: now, last_error: '', updated_at: now } });
        events.push({ dedupe_key: novusDedupeKey('leadrecovered', campaignId, m.agency_id), event_type: 'LEAD_PUSHED', campaign_id: campaignId, instantly_campaign_id: instantlyId, member_id: m.member_id, agency_id: m.agency_id, contact_id: m.contact_id, lead_email: m.email, snippet: `Recovered existing Instantly member ${text(remote.id)}` });
        continue;
      }
      toPush.push({ member: m, row: live, acknowledged: effectiveStatus === 'WARNING' });
    }

    // 3. Chunked add. One chunk failing never stops the others; each lead's
    //    outcome is written back individually so a rerun skips the successes.
    for (let i = 0; i < toPush.length; i += LEADS_ADD_CHUNK) {
      const chunk = toPush.slice(i, i + LEADS_ADD_CHUNK);
      const leads = chunk.map(({ member, row }) => {
        const payload = row ? leadPayloadFor(row, { campaignId }) : { email: member.email, first_name: member.first_name, company_name: member.company_name, custom_variables: parseJson(member.custom_variables_json, {}) };
        return { ...payload, email: lower(member.email) };
      });
      try {
        const summary = await client.addLeads({ campaignId: instantlyId, leads, skipIfInCampaign: true });
        const createdByIndex = new Map(summary.created_leads.map((c) => [Number(c.index), c]));
        const createdByEmail = new Map(summary.created_leads.filter((c) => text(c.email)).map((c) => [lower(c.email), c]));
        chunk.forEach(({ member, acknowledged }, index) => {
          const created = createdByIndex.get(index) || createdByEmail.get(lower(member.email));
          if (created?.id) {
            result.pushed += 1;
            patches.push({ member_id: member.member_id, patch: { member_status: 'PUSHED', instantly_lead_id: text(created.id), pushed_at: now, last_error: '', updated_at: now, ...(acknowledged ? { warnings_acknowledged: 'TRUE' } : {}) } });
            events.push({ dedupe_key: novusDedupeKey('leadpushed', campaignId, member.agency_id), event_type: 'LEAD_PUSHED', campaign_id: campaignId, instantly_campaign_id: instantlyId, member_id: member.member_id, agency_id: member.agency_id, contact_id: member.contact_id, lead_email: member.email, snippet: text(created.id) });
          } else {
            result.skipped += 1;
            const why = summary.in_blocklist ? 'blocklist / duplicate / invalid (see Instantly)' : summary.duplicated_leads ? 'already in this Instantly campaign' : summary.skipped_count ? 'skipped by Instantly' : summary.invalid_email_count ? 'invalid email' : 'not created by Instantly';
            patches.push({ member_id: member.member_id, patch: { member_status: 'SKIPPED', last_error: why, updated_at: now } });
            events.push({ dedupe_key: novusDedupeKey('leadskipped', campaignId, member.agency_id, now), event_type: 'LEAD_SKIPPED', campaign_id: campaignId, instantly_campaign_id: instantlyId, member_id: member.member_id, agency_id: member.agency_id, lead_email: member.email, snippet: why });
          }
        });
        result.chunks.push({ size: chunk.length, ...summary, created_leads: undefined });
      } catch (err) {
        const e = instantlyErrorPayload(err);
        result.failed += chunk.length;
        result.errors.push({ stage: 'add_leads', chunk: i / LEADS_ADD_CHUNK, ...e });
        for (const { member } of chunk) {
          patches.push({ member_id: member.member_id, patch: { member_status: 'PUSH_FAILED', last_error: (e.detail || e.message).slice(0, 300), updated_at: now } });
          events.push({ dedupe_key: novusDedupeKey('leadfailed', campaignId, member.agency_id, now), event_type: 'LEAD_PUSH_FAILED', campaign_id: campaignId, instantly_campaign_id: instantlyId, member_id: member.member_id, agency_id: member.agency_id, lead_email: member.email, snippet: (e.detail || e.message).slice(0, 300) });
        }
      }
    }

    await patchMembersBatch(repo, patches);
    await appendEvents(repo, events, { existingTable: loaded.tables[CAMPAIGN_EVENTS_TAB], now });
    if (result.pushed > 0 || result.created_instantly_campaign) campaignPatch.pushed_at = text(campaign.pushed_at) || now;
    if (result.errors.length) campaignPatch.last_error = `push: ${result.errors.map((e) => e.detail || e.message).join('; ')}`.slice(0, 500);
    await patchCampaign(repo, campaignId, campaignPatch);
    invalidateCampaignCache();
    return res.status(200).json({ success: result.errors.length === 0, ...result });
  } catch (err) {
    console.error('campaign-push error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Campaign push failed' });
  }
}

// ── POST campaign-launch / pause / resume ──────────────────────────────────
async function transition(req, res, { confirm, action, from, to, eventType, stampField }) {
  noStore(res);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const campaignId = text(body.campaign_id);
  if (text(body.confirm) !== confirm) return res.status(400).json({ success: false, error: `Missing confirm=${confirm}` });
  if (!campaignId) return res.status(400).json({ success: false, error: 'Missing campaign_id' });
  const client = clientFor('write');
  if (!client) return res.status(500).json({ success: false, error: 'INSTANTLY_API_KEY is not set in this environment' });
  try {
    const repo = getRepo();
    const { loaded, campaign, members } = await loadCampaign(repo, campaignId);
    if (!campaign) return res.status(404).json({ success: false, error: `No campaign ${campaignId}` });
    const status = upper(campaign.status);
    if (!from.includes(status)) return res.status(409).json({ success: false, error: `Campaign is ${status}; ${action} needs ${from.join(' or ')}` });
    if (!text(campaign.instantly_campaign_id)) return res.status(409).json({ success: false, error: 'Campaign has not been pushed to Instantly yet' });
    if (action === 'activate') {
      const remote = await client.getCampaign(campaign.instantly_campaign_id);
      const differences = instantlyConfigurationDifferences(expectedInstantlyCampaign(campaign), remote);
      if (differences.length) return res.status(409).json({ success: false, error: `Launch blocked: Instantly configuration differs from NOVUS (${differences.join(', ')})` });
    }
    if (action === 'activate' && to === 'ACTIVE' && status === 'DRAFT') {
      const pushed = members.filter((m) => upper(m.member_status) === 'PUSHED').length;
      if (!pushed) return res.status(409).json({ success: false, error: 'No leads have been pushed to Instantly; launch would send nothing' });
      if (body.acknowledge !== true) return res.status(400).json({ success: false, error: 'Launch requires acknowledge=true from the review screen' });
      const held = members.filter((m) => upper(m.member_status) === 'SELECTED' && upper(m.eligibility_status) === 'WARNING' && upper(m.warnings_acknowledged) !== 'TRUE').length;
      if (held && body.launch_without_warnings !== true) return res.status(409).json({ success: false, error: `${held} warning lead${held === 1 ? '' : 's'} are neither acknowledged nor removed; acknowledge them, push again, or set launch_without_warnings=true to leave them out` });
    }
    const now = nowIso();
    try {
      if (action === 'activate') await client.activateCampaign(campaign.instantly_campaign_id);
      else await client.pauseCampaign(campaign.instantly_campaign_id);
    } catch (err) {
      const e = instantlyErrorPayload(err);
      await patchCampaign(repo, campaignId, { updated_at: now, last_error: `${action} failed: ${e.detail || e.message}` });
      invalidateCampaignCache();
      return res.status(502).json({ success: false, error: `Instantly ${action} failed: ${e.detail || e.message}`, instantly: e });
    }
    const patch = { status: to, updated_at: now, last_error: '', [stampField]: now };
    if (to === 'ACTIVE' && !text(campaign.launched_at)) patch.launched_at = now;
    await patchCampaign(repo, campaignId, patch);
    await appendEvents(repo, [{ dedupe_key: novusDedupeKey(eventType, campaignId, now), event_type: eventType, campaign_id: campaignId, instantly_campaign_id: campaign.instantly_campaign_id, snippet: `${status} → ${to}` }], { existingTable: loaded.tables[CAMPAIGN_EVENTS_TAB], now });
    invalidateCampaignCache();
    return res.status(200).json({ success: true, campaign_id: campaignId, status: to });
  } catch (err) {
    console.error(`campaign-${action} error:`, err);
    return res.status(500).json({ success: false, error: err?.message || `Campaign ${action} failed` });
  }
}
export function handleCampaignLaunch(req, res) {
  return transition(req, res, { confirm: CONFIRM.LAUNCH, action: 'activate', from: ['DRAFT', 'ERROR'], to: 'ACTIVE', eventType: 'CAMPAIGN_LAUNCHED', stampField: 'launched_at' });
}
export function handleCampaignPause(req, res) {
  return transition(req, res, { confirm: CONFIRM.PAUSE, action: 'pause', from: ['ACTIVE', 'ERROR'], to: 'PAUSED', eventType: 'CAMPAIGN_PAUSED', stampField: 'paused_at' });
}
export function handleCampaignResume(req, res) {
  return transition(req, res, { confirm: CONFIRM.RESUME, action: 'activate', from: ['PAUSED', 'ERROR'], to: 'ACTIVE', eventType: 'CAMPAIGN_RESUMED', stampField: 'launched_at' });
}

// ── POST campaign-sync (reconciliation) ────────────────────────────────────
// Instantly is the source of truth for EXECUTION: campaign status, lead
// status, sends, replies, bounces, unsubscribes and analytics are read and
// written into the NOVUS ledgers. NOVUS sales state (AGENCIES pipeline,
// ACTIONS, REPLY_EVENTS classification) is never touched here.
export async function syncOneCampaign(repo, client, campaign, members, eventsTable, { now = nowIso(), mailboxes, matchTables = null, incremental = false } = {}) {
  const campaignId = text(campaign.campaign_id);
  const instantlyId = text(campaign.instantly_campaign_id);
  const out = { campaign_id: campaignId, instantly_campaign_id: instantlyId, mode: incremental ? 'poll' : 'full', status_before: upper(campaign.status), status_after: upper(campaign.status), members_imported: 0, members_updated: 0, events_appended: 0, events_duplicate: 0, errors: [] };
  if (!instantlyId) { out.skipped = 'not pushed to Instantly'; return out; }
  const patch = { last_synced_at: now, updated_at: now };
  const attempt = async (stage, fn) => { try { return await fn(); } catch (err) { out.errors.push({ stage, ...instantlyErrorPayload(err) }); return null; } };

  // Campaign status. Provider execution state wins: a campaign launched from
  // the Instantly UI becomes ACTIVE here too.
  const remote = await attempt('campaign', () => client.getCampaign(instantlyId));
  if (remote) {
    patch.instantly_status = String(remote.status ?? '');
    const mapped = novusStatusFromInstantly(remote.status);
    if (mapped && mapped !== upper(campaign.status)) {
      patch.status = mapped;
      if (mapped === 'ACTIVE' && !text(campaign.launched_at)) patch.launched_at = now;
      if (mapped === 'PAUSED') patch.paused_at = now;
      if (mapped === 'COMPLETED') patch.completed_at = now;
      out.status_after = mapped;
    }
  }
  const analytics = await attempt('analytics', () => client.getCampaignAnalytics(instantlyId));
  if (analytics) patch.analytics_json = JSON.stringify(analytics).slice(0, 20000);
  const steps = await attempt('step_analytics', () => client.getCampaignStepAnalytics(instantlyId));
  if (steps) patch.step_analytics_json = JSON.stringify(steps).slice(0, 20000);

  // Lead membership + per-lead state. A lead Instantly has that NOVUS does
  // not (added in the Instantly UI, or a campaign linked after the fact) is
  // imported as a PUSHED member matched to the master data; it is never
  // dropped from Instantly.
  const memberByEmail = new Map(members.map((m) => [lower(m.email), m]));
  const memberPatches = new Map();
  const mp = (m, fields) => { const cur = memberPatches.get(m.member_id) || {}; memberPatches.set(m.member_id, { ...cur, ...fields, updated_at: now }); };
  const leads = await attempt('leads', () => client.listCampaignLeads(instantlyId));
  const imported = [];
  if (leads) {
    const missing = leads.items.filter((lead) => lower(lead.email) && !memberByEmail.has(lower(lead.email)));
    if (missing.length) {
      const index = buildNovusMatchIndex(matchTables || await loadOptionalTables(repo, ['AGENCIES', 'CONTACTS', 'OUTBOUND', 'DEMOS']));
      for (const lead of missing) {
        const match = matchInstantlyLead({ ...lead, payload: lead.payload || {} }, index);
        const row = memberRowFromInstantlyLead({ ...lead, payload: lead.payload || {} }, match, { campaignId, now, index });
        imported.push(row);
        memberByEmail.set(lower(lead.email), row);
      }
      const table = await repo.getTable(CAMPAIGN_MEMBERS_TAB);
      await repo.appendRowsBatch(CAMPAIGN_MEMBERS_TAB, imported.map((m) => rowFor(table.header, m)));
      members = [...members, ...imported];
    }
    for (const lead of leads.items) {
      const m = memberByEmail.get(lower(lead.email));
      if (!m || imported.includes(m)) continue;
      const fields = {};
      if (!text(m.instantly_lead_id) && text(lead.id)) fields.instantly_lead_id = text(lead.id);
      if (upper(m.member_status) === 'SELECTED' || upper(m.member_status) === 'PUSH_FAILED' || upper(m.member_status) === 'SKIPPED') { fields.member_status = 'PUSHED'; fields.pushed_at = text(m.pushed_at) || now; fields.last_error = ''; }
      const ls = leadStatusLabel(lead.status);
      if (ls && ls !== upper(m.instantly_lead_status)) fields.instantly_lead_status = ls;
      const interest = interestLabel(lead.lt_interest_status);
      if (interest && interest !== upper(m.interest_status)) fields.interest_status = interest;
      if (ls === 'BOUNCED' && !text(m.bounced_at)) fields.bounced_at = text(lead.timestamp_updated) || now;
      if (ls === 'UNSUBSCRIBED' && !text(m.unsubscribed_at)) fields.unsubscribed_at = text(lead.timestamp_updated) || now;
      if (['MEETING_BOOKED', 'MEETING_COMPLETED', 'WON'].includes(interest) && !text(m.meeting_booked_at)) fields.meeting_booked_at = text(lead.timestamp_last_interest_change) || now;
      if (Number(lead.email_reply_count) > 0 && !text(m.replied_at)) fields.replied_at = text(lead.timestamp_last_reply) || now;
      if (Object.keys(fields).length) mp(m, fields);
    }
  }

  // Send / reply evidence from /emails, keyed on the Instantly email id.
  // A POLL sweep is bounded to what changed since the last one (the stored
  // cursor, minus a safety overlap); a FULL sweep — manual Sync Now, the
  // nightly safety net, or the first sync after a link/push — always
  // re-derives from the whole bounded history, because there is no cursor to
  // trust yet or because correctness matters more than call count.
  const sinceMs = incremental && text(campaign.emails_synced_through) ? Date.parse(text(campaign.emails_synced_through)) : NaN;
  const since = Number.isFinite(sinceMs) ? new Date(sinceMs - INCREMENTAL_OVERLAP_MS).toISOString() : '';
  const emails = await attempt('emails', () => client.listCampaignEmails(instantlyId, since ? { minTimestampCreated: since } : {}));
  const events = emails ? eventsFromEmailSweep(emails.items, { campaignId, instantlyCampaignId: instantlyId, membersByEmail: memberByEmail, now, normalise: (raw) => normalizeInstantlyEmail(raw, { mailboxes }), ueType: UE_TYPE }) : [];
  if (emails?.truncated) out.errors.push({ stage: 'emails', code: 'TRUNCATED', message: 'The /emails sweep hit its page ceiling; send counts are lower bounds' });
  for (const ev of events) {
    const m = ev.member_id ? memberByEmail.get(ev.lead_email) : null;
    if (m && ev.event_type === 'REPLY_RECEIVED' && !text(m.replied_at) && !memberPatches.get(m.member_id)?.replied_at) mp(m, { replied_at: ev.occurred_at });
  }
  const appended = await appendEvents(repo, events, { existingTable: eventsTable, now });
  out.events_appended = appended.appended;
  out.events_duplicate = appended.duplicates;
  out.members_imported = imported.length;
  out.emails_window_since = since;
  // Advance the cursor to the newest timestamp actually observed this sweep —
  // but only when the sweep was not truncated (a truncated sweep did not see
  // everything, so trusting its "newest" would risk skipping the untruncated
  // remainder next time) and only forward, never backward.
  if (emails && !emails.truncated) {
    // Every raw item seen counts toward "how far this sweep looked", even one
    // /emails does not turn into a stored event (e.g. a ue_type NOVUS does
    // not recognise) — normalizeInstantlyEmail is the one place that knows
    // which field carries the timestamp, so it decides here too.
    const seenAt = (emails.items || []).map((raw) => Date.parse(text(normalizeInstantlyEmail(raw, { mailboxes }).timestamp))).filter(Number.isFinite);
    const newest = seenAt.length ? Math.max(...seenAt) : NaN;
    const priorCursor = Date.parse(text(campaign.emails_synced_through));
    if (Number.isFinite(newest) && (!Number.isFinite(priorCursor) || newest > priorCursor)) patch.emails_synced_through = new Date(newest).toISOString();
  }
  // Actual send counts: EMAIL_SENT rows now on the ledger (this sweep plus
  // webhook and CSV history), never a lead-status inference.
  const ledger = eventRecords(await repo.getTable(CAMPAIGN_EVENTS_TAB)).filter((e) => text(e.campaign_id) === campaignId && upper(e.event_type) === 'EMAIL_SENT');
  const sendCounts = new Map();
  for (const e of ledger) { const k = lower(e.lead_email); sendCounts.set(k, (sendCounts.get(k) || 0) + 1); }
  for (const m of members) {
    const count = sendCounts.get(lower(m.email)) || 0;
    if (count !== (Number(m.emails_sent_count) || 0)) mp(m, { emails_sent_count: count });
  }
  // last_event_* from the newest reconciled event per member.
  for (const ev of appended.rows) {
    if (!ev.member_id) continue;
    const m = members.find((row) => row.member_id === ev.member_id);
    if (!m) continue;
    const prev = memberPatches.get(m.member_id)?.last_event_at || text(m.last_event_at);
    if (!prev || Date.parse(ev.occurred_at) > Date.parse(prev)) mp(m, { last_event_type: ev.event_type, last_event_at: ev.occurred_at });
  }
  out.members_updated = await patchMembersBatch(repo, [...memberPatches].map(([member_id, p]) => ({ member_id, patch: p })));
  if (out.errors.length) patch.last_error = `sync: ${out.errors.map((e) => `${e.stage} ${e.detail || e.message}`).join('; ')}`.slice(0, 500);
  else patch.last_error = '';
  await patchCampaign(repo, campaignId, patch);
  return out;
}
// Every pushed campaign (or one by id). Shared by the manual Sync button and
// the nightly cron (api/novus/intelligence/finalize.js step F).
export async function syncCampaigns(repo, client, { campaignId = '', onlyOpen = false, mailboxes = novusMailboxes(), incremental = false, minIntervalMs = 0 } = {}) {
  const loaded = await readCampaignTables(repo);
  if (!loaded.available) return { available: false, setup: loaded, synced: 0, skipped: 0, results: [] };
  const wanted = text(campaignId);
  const nowMs = Date.now();
  const dueForSync = (c) => {
    if (!minIntervalMs) return true;
    const last = Date.parse(text(c.last_synced_at));
    return !Number.isFinite(last) || nowMs - last >= minIntervalMs;
  };
  const candidates = campaignRecords(loaded.tables[CAMPAIGNS_TAB]).filter((c) => {
    if (wanted) return text(c.campaign_id) === wanted;
    if (!text(c.instantly_campaign_id)) return false;
    // The nightly pass skips campaigns that finished; a manual sync does not.
    return !onlyOpen || upper(c.status) !== 'COMPLETED';
  });
  if (wanted && !candidates.length) return { available: true, synced: 0, skipped: 0, results: [], not_found: wanted };
  // The per-campaign cooldown (see POLL_MIN_INTERVAL_MS) applies only when the
  // caller asked for one — the interactive Sync Now button and the nightly
  // safety net pass minIntervalMs=0 and always run every candidate.
  const campaigns = candidates.filter(dueForSync);
  const skippedRecently = candidates.filter((c) => !dueForSync(c)).map((c) => ({ campaign_id: text(c.campaign_id), instantly_campaign_id: text(c.instantly_campaign_id), skipped: 'synced_recently', last_synced_at: text(c.last_synced_at) }));
  const members = memberRecords(loaded.tables[CAMPAIGN_MEMBERS_TAB]);
  const results = [];
  let eventsTable = loaded.tables[CAMPAIGN_EVENTS_TAB];
  for (const campaign of campaigns) {
    const own = members.filter((m) => text(m.campaign_id) === text(campaign.campaign_id));
    results.push(await syncOneCampaign(repo, client, campaign, own, eventsTable, { mailboxes, incremental }));
    // Later campaigns must see the rows appended for earlier ones.
    eventsTable = await repo.getTable(CAMPAIGN_EVENTS_TAB);
  }
  if (results.length) invalidateCampaignCache();
  return { available: true, synced: results.length, skipped: skippedRecently.length, results, skipped_campaigns: skippedRecently, ok: results.every((r) => !r.errors?.length) };
}
export async function handleCampaignSync(req, res) {
  noStore(res);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const client = clientFor('read');
  if (!client) return res.status(500).json({ success: false, error: 'No Instantly API key is configured; sync is unavailable' });
  try {
    // A human clicked Sync Now: no cooldown, no incremental narrowing — full
    // correctness sweep, exactly the pre-poller behaviour.
    const out = await syncCampaigns(getRepo(), client, { campaignId: text(body.campaign_id) });
    if (!out.available) return res.status(409).json({ success: false, error: 'Campaign tabs are not set up', setup: out.setup });
    if (out.not_found) return res.status(404).json({ success: false, error: `No campaign ${out.not_found}` });
    return res.status(200).json({ success: out.ok, synced: out.synced, results: out.results });
  } catch (err) {
    console.error('campaign-sync error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Campaign sync failed' });
  }
}

// ── POST campaign-sync-poll ─────────────────────────────────────────────────
// The PRIMARY sync path when Instantly webhooks are unavailable (Growth
// plan): an external scheduler (a free GitHub Actions cron — see
// .github/workflows/campaign-sync-poll.yml and docs/EMAIL_CAMPAIGNS.md) calls
// this roughly every 10-15 minutes. Vercel's own Cron cannot do that on the
// Hobby plan (crons there run at most once a day), which is why this is a
// second, secret-gated HTTP operation rather than a vercel.json cron entry.
//
// Guarded by requireCampaignPollerSecret ON TOP of Basic Auth (see
// api/novus/_auth.mjs) — the same two-layer pattern as the reply poller.
// Every open campaign not synced within POLL_MIN_INTERVAL_MS is reconciled
// INCREMENTALLY (bounded /emails window from its stored cursor); status,
// leads, replies, bounces, unsubscribes and analytics are always read in
// full regardless, because those calls are already cheap and unconditional
// freshness there matters more than saving one small GET.
//
// This never activates, pauses or adds leads — identical write surface to
// the manual Sync Now button, just on a schedule and narrower per pass.
export async function handleCampaignSyncPoll(req, res) {
  noStore(res);
  if (pollInFlight) {
    return res.status(200).json({ success: true, skipped: true, reason: 'a campaign sync poll is already running in this instance' });
  }
  pollInFlight = true;
  try {
    const client = clientFor('read');
    if (!client) return res.status(500).json({ success: false, error: 'No Instantly API key is configured; the campaign sync poll is unavailable' });
    const out = await syncCampaigns(getRepo(), client, { onlyOpen: true, incremental: true, minIntervalMs: POLL_MIN_INTERVAL_MS });
    if (!out.available) return res.status(409).json({ success: false, error: 'Campaign tabs are not set up', setup: out.setup });
    return res.status(200).json({ success: out.ok, synced: out.synced, skipped: out.skipped, results: out.results, skipped_campaigns: out.skipped_campaigns, polled_at: nowIso() });
  } catch (err) {
    console.error('campaign-sync-poll error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Campaign sync poll failed' });
  } finally {
    pollInFlight = false;
  }
}

// ── GET campaign-discover ──────────────────────────────────────────────────
// Every campaign in the Instantly workspace, with whether NOVUS already links
// it. This is how a campaign that predates the NOVUS campaign layer is found.
export async function handleCampaignDiscover(req, res) {
  noStore(res);
  const client = clientFor('read');
  if (!client) return res.status(200).json({ success: true, available: false, error: 'No Instantly API key is configured', campaigns: [] });
  try {
    const [{ items }, loaded] = await Promise.all([client.listCampaigns(), readCampaignTables(getRepo())]);
    const linked = new Map(campaignRecords(loaded.tables[CAMPAIGNS_TAB]).filter((c) => text(c.instantly_campaign_id)).map((c) => [text(c.instantly_campaign_id), c]));
    const campaigns = items.map((c) => ({
      instantly_campaign_id: text(c.id), name: text(c.name), status: c.status ?? null, status_label: INSTANTLY_CAMPAIGN_STATUS_LABEL[String(c.status)] || String(c.status ?? ''),
      timestamp_created: text(c.timestamp_created), email_list: Array.isArray(c.email_list) ? c.email_list : [], daily_limit: c.daily_limit ?? null,
      linked: linked.has(text(c.id)), campaign_id: text(linked.get(text(c.id))?.campaign_id), novus_status: upper(linked.get(text(c.id))?.status),
    })).sort((a, b) => (Date.parse(b.timestamp_created) || 0) - (Date.parse(a.timestamp_created) || 0));
    return res.status(200).json({ success: true, available: true, campaigns });
  } catch (err) {
    return res.status(200).json({ success: true, available: false, error: instantlyErrorPayload(err), campaigns: [] });
  }
}

// ── POST campaign-link ─────────────────────────────────────────────────────
// Links an EXISTING Instantly campaign: one CAMPAIGNS row (source IMPORTED,
// status mirrored from Instantly), its configuration copied from GET
// /campaigns/{id}, every Instantly lead imported as a PUSHED member matched to
// the master data, and its send/reply history from /emails. Idempotent: a
// second link of the same id updates the same row and adds nothing twice.
// dry_run=true returns the full plan (matches, counts, unmatched) and writes
// nothing. Instantly is only ever read.
function sequenceFromInstantly(c) {
  const steps = Array.isArray(c?.sequences?.[0]?.steps) ? c.sequences[0].steps : [];
  // Instantly's step delay is "wait before the NEXT step"; NOVUS stores "wait before this step".
  return { steps: steps.map((st, i) => ({ step: i + 1, delay_days: i === 0 ? 0 : Number(steps[i - 1]?.delay) || 0, variants: (st.variants || []).map((v) => ({ subject: text(v.subject), body: String(v.body ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim(), disabled: v.v_disabled === true })) })) };
}
function scheduleFromInstantly(c) {
  const s = c?.campaign_schedule?.schedules?.[0];
  if (!s) return { ...DEFAULT_SCHEDULE };
  return { name: text(s.name) || DEFAULT_SCHEDULE.name, from: text(s.timing?.from) || DEFAULT_SCHEDULE.from, to: text(s.timing?.to) || DEFAULT_SCHEDULE.to, timezone: text(s.timezone) || DEFAULT_SCHEDULE.timezone, days: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, s.days?.[String(d)] === true || s.days?.[d] === true])), start_date: text(c.campaign_schedule?.start_date) };
}
function sendingFromInstantly(c) {
  return { ...DEFAULT_SENDING, email_list: Array.isArray(c?.email_list) ? c.email_list.map(lower) : [], daily_limit: Number(c?.daily_limit) || DEFAULT_SENDING.daily_limit, daily_max_leads: Number(c?.daily_max_leads) || 0, stop_on_reply: c?.stop_on_reply !== false, stop_on_auto_reply: c?.stop_on_auto_reply === true, open_tracking: c?.open_tracking !== false, link_tracking: c?.link_tracking === true, text_only: c?.text_only === true };
}
export async function handleCampaignLink(req, res) {
  noStore(res);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const instantlyId = text(body.instantly_campaign_id);
  const dryRun = body.dry_run !== false;
  if (!instantlyId) return res.status(400).json({ success: false, error: 'Missing instantly_campaign_id' });
  if (!dryRun && text(body.confirm) !== CONFIRM.LINK) return res.status(400).json({ success: false, error: `Missing confirm=${CONFIRM.LINK} (or set dry_run=true)` });
  const client = clientFor('read');
  if (!client) return res.status(500).json({ success: false, error: 'No Instantly API key is configured' });
  try {
    const repo = getRepo();
    const loaded = await readCampaignTables(repo);
    if (!loaded.available) return res.status(409).json({ success: false, error: 'Campaign tabs are not set up', setup: loaded });
    const now = nowIso();
    const remote = await client.getCampaign(instantlyId);
    const existing = campaignRecords(loaded.tables[CAMPAIGNS_TAB]).find((c) => text(c.instantly_campaign_id) === instantlyId) || null;
    const campaignId = text(existing?.campaign_id) || newCampaignId();
    const [leads, matchTables] = await Promise.all([client.listCampaignLeads(instantlyId), loadOptionalTables(repo, ['AGENCIES', 'CONTACTS', 'OUTBOUND', 'DEMOS'])]);
    const index = buildNovusMatchIndex(matchTables);
    const members = memberRecords(loaded.tables[CAMPAIGN_MEMBERS_TAB]).filter((m) => text(m.campaign_id) === campaignId);
    const memberByEmail = new Map(members.map((m) => [lower(m.email), m]));
    const plan = { new_members: [], patches: [], matches: { MATCHED: 0, AMBIGUOUS: 0, UNMATCHED: 0, DOMAIN: 0 }, review: [] };
    for (const lead of leads.items) {
      const shaped = { ...lead, email: lower(lead.email), payload: lead.payload && typeof lead.payload === 'object' ? lead.payload : {} };
      if (!shaped.email) continue;
      const match = matchInstantlyLead(shaped, index);
      plan.matches[match.match_status] += 1;
      if (match.match_method === 'DOMAIN' && match.match_status === 'MATCHED') plan.matches.DOMAIN += 1;
      if (match.match_status !== 'MATCHED' || match.match_method === 'DOMAIN') plan.review.push({ email: shaped.email, instantly_lead_id: text(lead.id), company_name: text(lead.company_name), ...match });
      const current = memberByEmail.get(shaped.email);
      if (current) {
        const patch = memberPatchFromInstantlyLead(current, shaped, match, { now });
        if (Object.keys(patch).length) plan.patches.push({ member_id: current.member_id, patch });
      } else {
        const row = memberRowFromInstantlyLead(shaped, match, { campaignId, now, index });
        plan.new_members.push(row);
        memberByEmail.set(shaped.email, row);
      }
    }
    const mirrored = novusStatusFromInstantly(remote.status) || 'DRAFT';
    const campaignRow = existing ? null : {
      campaign_id: campaignId, instantly_campaign_id: instantlyId, name: text(remote.name), status: mirrored, campaign_type: upper(body.campaign_type) === 'GENERAL' ? 'GENERAL' : 'ENQUIRY_FOLLOWUP',
      sequence_json: JSON.stringify(sequenceFromInstantly(remote)), schedule_json: JSON.stringify(scheduleFromInstantly(remote)), sending_json: JSON.stringify(sendingFromInstantly(remote)),
      audience_filters_json: '', policy_json: JSON.stringify(normalisePolicy({})), instantly_status: String(remote.status ?? ''), analytics_json: '', step_analytics_json: '', last_synced_at: '', last_error: '',
      created_at: text(remote.timestamp_created) || now, pushed_at: text(remote.timestamp_created) || now, launched_at: mirrored === 'ACTIVE' || mirrored === 'PAUSED' || mirrored === 'COMPLETED' ? text(remote.timestamp_created) || now : '',
      paused_at: mirrored === 'PAUSED' ? now : '', completed_at: mirrored === 'COMPLETED' ? now : '', updated_at: now, source: 'IMPORTED', linked_at: now,
    };
    const summary = {
      instantly_campaign_id: instantlyId, campaign_id: campaignId, name: text(remote.name), instantly_status: remote.status ?? null, instantly_status_label: INSTANTLY_CAMPAIGN_STATUS_LABEL[String(remote.status)] || '',
      novus_status: existing ? upper(existing.status) : mirrored, already_linked: Boolean(existing), leads_in_instantly: leads.items.length, leads_truncated: leads.truncated,
      members_existing: members.length, members_to_add: plan.new_members.length, members_to_patch: plan.patches.length, matches: plan.matches, review: plan.review,
    };
    if (dryRun) return res.status(200).json({ success: true, dry_run: true, ...summary, config: campaignRow ? { sequence: JSON.parse(campaignRow.sequence_json), schedule: JSON.parse(campaignRow.schedule_json), sending: JSON.parse(campaignRow.sending_json) } : null });

    if (campaignRow) await repo.appendRowsBatch(CAMPAIGNS_TAB, [rowFor(loaded.tables[CAMPAIGNS_TAB].header, campaignRow)]);
    else await patchCampaign(repo, campaignId, { instantly_status: String(remote.status ?? ''), status: mirrored, source: text(existing.source) || 'IMPORTED', linked_at: text(existing.linked_at) || now, updated_at: now });
    if (plan.new_members.length) {
      const table = await repo.getTable(CAMPAIGN_MEMBERS_TAB);
      await repo.appendRowsBatch(CAMPAIGN_MEMBERS_TAB, plan.new_members.map((m) => rowFor(table.header, m)));
    }
    await patchMembersBatch(repo, plan.patches);
    const allMembers = [...members, ...plan.new_members];
    const memberEvents = plan.new_members.map((m) => ({
      dedupe_key: novusDedupeKey('imported', campaignId, m.email), event_type: 'LEAD_IMPORTED', source: 'RECONCILE', occurred_at: m.added_at, received_at: now, campaign_id: campaignId, instantly_campaign_id: instantlyId,
      member_id: m.member_id, agency_id: m.agency_id, contact_id: m.contact_id, lead_email: m.email, snippet: `${m.match_status}${m.match_method ? ` via ${m.match_method}` : ''}`,
    }));
    if (!existing) memberEvents.unshift({ dedupe_key: novusDedupeKey('linked', campaignId, instantlyId), event_type: 'CAMPAIGN_LINKED', occurred_at: now, campaign_id: campaignId, instantly_campaign_id: instantlyId, snippet: `${text(remote.name)} linked (${INSTANTLY_CAMPAIGN_STATUS_LABEL[String(remote.status)] || remote.status})` });
    const appended = await appendEvents(repo, memberEvents, { existingTable: loaded.tables[CAMPAIGN_EVENTS_TAB], now });
    // History: the same reconciliation the Sync button runs (status, leads,
    // /emails sends and replies, analytics), so a linked campaign is complete
    // in one step.
    const campaign = campaignRow || { ...existing, instantly_campaign_id: instantlyId };
    const sync = await syncOneCampaign(repo, client, campaign, allMembers, await repo.getTable(CAMPAIGN_EVENTS_TAB), { now, mailboxes: novusMailboxes(), matchTables });
    invalidateCampaignCache();
    return res.status(200).json({ success: true, dry_run: false, ...summary, events_appended: appended.appended, sync });
  } catch (err) {
    console.error('campaign-link error:', err);
    return res.status(err instanceof InstantlyApiError ? 502 : 500).json({ success: false, error: err?.message || 'Campaign link failed', instantly: err instanceof InstantlyApiError ? err.toJSON() : undefined });
  }
}

// ── POST campaign-import-activity ──────────────────────────────────────────
// Historical activity the API does not expose (opens, clicks, interest
// changes, bounces with their dates, NOVUS inbox replies) from Instantly's
// activity export, plus the leads export for lead state. Body:
//   { campaign_id, activity_csv?: "<text>", leads_csv?: "<text>", dry_run }
// Idempotent on the provider moment; real timestamps are kept.
export async function handleCampaignImportActivity(req, res) {
  noStore(res);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const campaignId = text(body.campaign_id);
  const dryRun = body.dry_run !== false;
  if (!campaignId) return res.status(400).json({ success: false, error: 'Missing campaign_id' });
  if (!dryRun && text(body.confirm) !== CONFIRM.IMPORT) return res.status(400).json({ success: false, error: `Missing confirm=${CONFIRM.IMPORT} (or set dry_run=true)` });
  const activityCsv = typeof body.activity_csv === 'string' ? body.activity_csv : '';
  const leadsCsv = typeof body.leads_csv === 'string' ? body.leads_csv : '';
  if (!activityCsv && !leadsCsv) return res.status(400).json({ success: false, error: 'Provide activity_csv and/or leads_csv' });
  try {
    const repo = getRepo();
    const { loaded, campaign, members } = await loadCampaign(repo, campaignId);
    if (!campaign) return res.status(404).json({ success: false, error: `No campaign ${campaignId}` });
    const now = nowIso();
    const instantlyId = text(campaign.instantly_campaign_id);
    const memberByEmail = new Map(members.map((m) => [lower(m.email), m]));
    const out = { campaign_id: campaignId, dry_run: dryRun, leads_rows: 0, activity_rows: 0, members_to_add: 0, members_to_patch: 0, events_to_append: 0, events_duplicate: 0, unknown_recipients: [], by_type: {}, matches: { MATCHED: 0, AMBIGUOUS: 0, UNMATCHED: 0 }, review: [] };
    const newMembers = [];
    const patches = [];
    if (leadsCsv) {
      const leads = parseInstantlyLeadsCsv(leadsCsv);
      out.leads_rows = leads.length;
      const foreign = leads.filter((l) => instantlyId && l.campaign && l.campaign !== instantlyId);
      if (foreign.length) return res.status(400).json({ success: false, error: `${foreign.length} row(s) in leads_csv belong to a different Instantly campaign (${foreign[0].campaign}); this campaign is ${instantlyId}` });
      const index = buildNovusMatchIndex(await loadOptionalTables(repo, ['AGENCIES', 'CONTACTS', 'OUTBOUND', 'DEMOS']));
      for (const lead of leads) {
        const match = matchInstantlyLead(lead, index);
        out.matches[match.match_status] += 1;
        if (match.match_status !== 'MATCHED' || match.match_method === 'DOMAIN') out.review.push({ email: lead.email, instantly_lead_id: lead.id, company_name: lead.company_name, ...match });
        const current = memberByEmail.get(lead.email);
        if (current) { const patch = memberPatchFromInstantlyLead(current, lead, match, { now }); if (Object.keys(patch).length) patches.push({ member_id: current.member_id, patch }); }
        else { const row = memberRowFromInstantlyLead(lead, match, { campaignId, now, index }); newMembers.push(row); memberByEmail.set(lead.email, row); }
      }
      out.members_to_add = newMembers.length; out.members_to_patch = patches.length;
    }
    let events = [];
    if (activityCsv) {
      const rows = parseInstantlyActivityCsv(activityCsv);
      out.activity_rows = rows.length;
      events = eventsFromActivityRows(rows, { campaignId, instantlyCampaignId: instantlyId, membersByEmail: memberByEmail, now });
      out.unknown_recipients = [...new Set(rows.filter((r) => !memberByEmail.has(r.recipient)).map((r) => r.recipient))];
      for (const e of events) out.by_type[e.event_type] = (out.by_type[e.event_type] || 0) + 1;
    }
    if (dryRun) {
      // Count what a real run would append against the current ledger.
      const probe = await appendEvents({ appendRowsBatch: async () => {} }, events, { existingTable: loaded.tables[CAMPAIGN_EVENTS_TAB], now });
      out.events_to_append = probe.appended; out.events_duplicate = probe.duplicates;
      return res.status(200).json({ success: true, ...out });
    }
    if (newMembers.length) { const table = await repo.getTable(CAMPAIGN_MEMBERS_TAB); await repo.appendRowsBatch(CAMPAIGN_MEMBERS_TAB, newMembers.map((m) => rowFor(table.header, m))); }
    await patchMembersBatch(repo, patches);
    const appended = await appendEvents(repo, events, { existingTable: loaded.tables[CAMPAIGN_EVENTS_TAB], now });
    out.events_to_append = appended.appended; out.events_duplicate = appended.duplicates;
    // Member counters/flags from the ledger (actual records only).
    const ledger = eventRecords(await repo.getTable(CAMPAIGN_EVENTS_TAB)).filter((e) => text(e.campaign_id) === campaignId);
    const all = [...members, ...newMembers];
    const counterPatches = [];
    for (const m of all) {
      const mine = ledger.filter((e) => lower(e.lead_email) === lower(m.email));
      const sends = mine.filter((e) => upper(e.event_type) === 'EMAIL_SENT');
      const patch = {};
      if (sends.length !== (Number(m.emails_sent_count) || 0)) patch.emails_sent_count = sends.length;
      const first = (type) => mine.filter((e) => upper(e.event_type) === type).map((e) => text(e.occurred_at)).sort()[0] || '';
      if (!text(m.replied_at) && first('REPLY_RECEIVED')) patch.replied_at = first('REPLY_RECEIVED');
      if (!text(m.bounced_at) && first('EMAIL_BOUNCED')) patch.bounced_at = first('EMAIL_BOUNCED');
      if (!text(m.unsubscribed_at) && first('LEAD_UNSUBSCRIBED')) patch.unsubscribed_at = first('LEAD_UNSUBSCRIBED');
      if (!text(m.meeting_booked_at) && first('LEAD_MEETING_BOOKED')) patch.meeting_booked_at = first('LEAD_MEETING_BOOKED');
      if (!text(m.interest_status)) { if (first('LEAD_NOT_INTERESTED')) patch.interest_status = 'NOT_INTERESTED'; else if (first('LEAD_INTERESTED')) patch.interest_status = 'INTERESTED'; }
      const latest = mine.filter((e) => PROVIDER_EVENT_TYPES.has(upper(e.event_type))).sort((a, b) => (Date.parse(b.occurred_at) || 0) - (Date.parse(a.occurred_at) || 0))[0];
      if (latest && (!text(m.last_event_at) || Date.parse(latest.occurred_at) > Date.parse(m.last_event_at))) { patch.last_event_type = upper(latest.event_type); patch.last_event_at = text(latest.occurred_at); }
      if (Object.keys(patch).length) counterPatches.push({ member_id: m.member_id, patch: { ...patch, updated_at: now } });
    }
    await patchMembersBatch(repo, counterPatches);
    await patchCampaign(repo, campaignId, { updated_at: now });
    invalidateCampaignCache();
    return res.status(200).json({ success: true, ...out, members_counters_updated: counterPatches.length });
  } catch (err) {
    console.error('campaign-import-activity error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Activity import failed' });
  }
}

// ── GET campaign-reconciliation ────────────────────────────────────────────
// Per-member truth table: what Instantly actually did for each lead, next to
// what NOVUS knows (stage), with the match audit. Read-only.
export async function handleCampaignReconciliation(req, res) {
  noStore(res);
  const campaignId = text(req.query?.campaign_id);
  if (!campaignId) return res.status(400).json({ success: false, error: 'Missing campaign_id' });
  try {
    const repo = getRepo();
    const [{ campaign, members, events }, tables] = await Promise.all([loadCampaign(repo, campaignId), loadOptionalTables(repo, AUDIENCE_TABS)]);
    if (!campaign) return res.status(404).json({ success: false, error: `No campaign ${campaignId}` });
    const evidence = buildAgencyEvidence(tables, { now: nowIso() });
    const stageByAgency = new Map(evidence.map((ev) => [text(ev.agency.agency_id), ev.stage]));
    const agencyById = new Map(evidence.map((ev) => [text(ev.agency.agency_id), ev.agency]));
    const report = buildReconciliationReport({ campaign, members, events, stageByAgency, agencyById, now: nowIso() });
    return res.status(200).json({ success: true, ...report, campaign: { campaign_id: campaignId, name: text(campaign.name), status: upper(campaign.status), source: upper(campaign.source) || 'NOVUS', instantly_campaign_id: text(campaign.instantly_campaign_id), last_synced_at: text(campaign.last_synced_at) } });
  } catch (err) {
    console.error('campaign-reconciliation error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Reconciliation report failed' });
  }
}

// ── POST /api/novus/webhooks/instantly (rewrite → instantly-webhook) ───────
// AUTH: Instantly cannot sign payloads, but it can attach custom headers to a
// webhook. The webhook is created in Instantly with
//   X-Novus-Instantly-Secret: <INSTANTLY_WEBHOOK_SECRET>
// and this handler compares it in constant time. Same pattern as the email
// adapter's NOVUS_INGEST_SECRET; never the human Basic Auth password.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
export function requireInstantlyWebhookSecret(req, res) {
  const expected = text(process.env.INSTANTLY_WEBHOOK_SECRET);
  if (!expected) { res.status(500).json({ error: 'INSTANTLY_WEBHOOK_SECRET is not configured' }); return false; }
  const provided = text(req.headers?.['x-novus-instantly-secret'] ?? req.headers?.['X-Novus-Instantly-Secret'] ?? '');
  if (!provided || !safeEqual(provided, expected)) { res.status(401).json({ error: 'Invalid or missing webhook secret' }); return false; }
  return true;
}

// The pure part: one payload → { event, memberPatch }. Exported for tests.
export function interpretWebhookPayload(payload, { campaign = null, member = null, now = nowIso() } = {}) {
  const eventType = normaliseInstantlyEventType(payload.event_type);
  const occurredAt = text(payload.timestamp) || now;
  const event = {
    dedupe_key: webhookDedupeKey(payload), source: 'WEBHOOK', event_type: eventType, occurred_at: occurredAt, received_at: now,
    campaign_id: text(campaign?.campaign_id), instantly_campaign_id: text(payload.campaign_id), member_id: text(member?.member_id),
    agency_id: text(member?.agency_id), contact_id: text(member?.contact_id), lead_email: lower(payload.lead_email),
    instantly_email_id: text(payload.email_id), step: text(payload.step), variant: text(payload.variant), email_account: text(payload.email_account),
    subject: text(payload.email_subject || payload.reply_subject).slice(0, 200),
    snippet: text(payload.reply_text_snippet || payload.reply_text || payload.email_text).slice(0, 300),
    payload_json: { ...payload, email_html: undefined, reply_html: undefined, email_text: text(payload.email_text).slice(0, 2000), reply_text: text(payload.reply_text).slice(0, 2000), raw_event_type: text(payload.event_type) },
  };
  const memberPatch = member ? { last_event_type: eventType, last_event_at: occurredAt, updated_at: now } : null;
  if (member) {
    if (eventType === 'EMAIL_SENT') memberPatch.emails_sent_count = (Number(member.emails_sent_count) || 0) + 1;
    if (eventType === 'REPLY_RECEIVED' && !text(member.replied_at)) memberPatch.replied_at = occurredAt;
    if (eventType === 'EMAIL_BOUNCED') { memberPatch.bounced_at = text(member.bounced_at) || occurredAt; memberPatch.instantly_lead_status = 'BOUNCED'; }
    if (eventType === 'LEAD_UNSUBSCRIBED') { memberPatch.unsubscribed_at = text(member.unsubscribed_at) || occurredAt; memberPatch.instantly_lead_status = 'UNSUBSCRIBED'; }
    if (eventType === 'LEAD_INTERESTED') memberPatch.interest_status = 'INTERESTED';
    if (eventType === 'LEAD_NOT_INTERESTED') memberPatch.interest_status = 'NOT_INTERESTED';
    if (eventType === 'LEAD_NEUTRAL') memberPatch.interest_status = '';
    if (eventType === 'LEAD_OUT_OF_OFFICE') memberPatch.interest_status = 'OUT_OF_OFFICE';
    if (eventType === 'LEAD_WRONG_PERSON') memberPatch.interest_status = 'WRONG_PERSON';
    if (eventType === 'LEAD_CLOSED') memberPatch.interest_status = 'LOST';
    if (eventType === 'LEAD_NO_SHOW') memberPatch.interest_status = 'NO_SHOW';
    if (eventType === 'LEAD_MEETING_BOOKED') { memberPatch.interest_status = 'MEETING_BOOKED'; memberPatch.meeting_booked_at = text(member.meeting_booked_at) || occurredAt; }
    if (eventType === 'LEAD_MEETING_COMPLETED') memberPatch.interest_status = 'MEETING_COMPLETED';
  }
  return { event, memberPatch };
}

export async function handleInstantlyWebhook(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireInstantlyWebhookSecret(req, res)) return;
  let payload = req.body;
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { payload = null; } }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return res.status(400).json({ error: 'Body must be a JSON object' });
  if (!text(payload.event_type)) return res.status(400).json({ error: 'Missing event_type' });
  // Instantly's "Test a webhook" sends a sample payload; accept it without
  // storing anything so the console shows a green tick.
  if (upper(payload.test) === 'TRUE' || payload.test === true) return res.status(200).json({ ok: true, test: true });

  try {
    const repo = getRepo();
    const loaded = await readCampaignTables(repo);
    if (!loaded.available) return res.status(503).json({ error: 'Campaign tabs are not set up; event not stored', missing: loaded.missing });
    const campaign = campaignRecords(loaded.tables[CAMPAIGNS_TAB]).find((c) => text(c.instantly_campaign_id) && text(c.instantly_campaign_id) === text(payload.campaign_id)) || null;
    const email = lower(payload.lead_email);
    const members = memberRecords(loaded.tables[CAMPAIGN_MEMBERS_TAB]);
    const member = campaign && email ? members.find((m) => text(m.campaign_id) === text(campaign.campaign_id) && lower(m.email) === email) || null : null;
    const now = nowIso();
    const { event, memberPatch } = interpretWebhookPayload(payload, { campaign, member, now });
    // An event for a campaign NOVUS did not create (e.g. the legacy sequence)
    // is still worth keeping on the agency's timeline: resolve the agency by
    // address so the History tab can show it.
    if (!member && email) {
      const known = members.find((m) => lower(m.email) === email);
      if (known) { event.agency_id = text(known.agency_id); event.contact_id = text(known.contact_id); }
      else {
        const [agencies, contacts] = await Promise.all([repo.getTable('AGENCIES').catch(() => ({ header: [], rows: [] })), repo.getTable('CONTACTS').catch(() => ({ header: [], rows: [] }))]);
        const contact = parseRecords(contacts, 'contact_id').map((r) => r.obj).find((c) => lower(c.email) === email);
        const agency = contact ? null : parseRecords(agencies, 'agency_id').map((r) => r.obj).find((a) => lower(a.outreach_contact_email) === email || lower(a.primary_contact_email) === email);
        event.agency_id = text(contact?.agency_id || agency?.agency_id);
        event.contact_id = text(contact?.contact_id);
      }
    }
    const appended = await appendEvents(repo, [event], { existingTable: loaded.tables[CAMPAIGN_EVENTS_TAB], now });
    if (!appended.appended) return res.status(200).json({ ok: true, duplicate: true, dedupe_key: event.dedupe_key });
    if (member && memberPatch) await patchMember(repo, member.member_id, memberPatch);
    if (campaign && event.event_type === 'CAMPAIGN_COMPLETED') await patchCampaign(repo, campaign.campaign_id, { status: 'COMPLETED', completed_at: now, updated_at: now });
    invalidateCampaignCache();
    return res.status(200).json({ ok: true, duplicate: false, event_id: appended.rows[0].event_id, event_type: event.event_type, campaign_id: event.campaign_id, member_id: event.member_id, agency_id: event.agency_id });
  } catch (err) {
    console.error('instantly-webhook error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to store the Instantly event' });
  }
}

export const _internal = { campaignView, memberView, eventView, memberRowFromAudience, loadCampaign, bounceRate, CAMPAIGNS_HEADER, CAMPAIGN_MEMBERS_HEADER };
