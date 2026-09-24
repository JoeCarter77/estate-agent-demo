#!/usr/bin/env node
// scripts/novus-campaigns-selftest.mjs — hermetic test of the Email /
// Campaigns layer: eligibility rules, audience filters, campaign create →
// push → launch → pause → sync against an in-memory workbook and a fake
// Instantly API, the webhook (secret, idempotency, member state), and the
// unified lead timeline. No network, no credentials.
//
// Run:  npm run novus:campaigns-selftest

import assert from 'node:assert/strict';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { ACTIONS_HEADER } from '../lib/actions-store.mjs';
import { evaluateEligibility, deriveFacts, summariseEligibility } from '../lib/campaign-eligibility.mjs';
import { buildCampaignAudience, normaliseFilters, leadPayloadFor } from '../lib/campaign-audience.mjs';
import { createInstantlyClient, InstantlyApiError } from '../lib/instantly-client.mjs';
import { webhookDedupeKey, CAMPAIGNS_HEADER, CAMPAIGN_MEMBERS_HEADER, CAMPAIGN_EVENTS_HEADER } from '../lib/campaign-store.mjs';
import { buildInstantlyCampaignPayload, normaliseSequence, interpretWebhookPayload, syncCampaigns } from '../lib/campaign-handlers.mjs';
import { buildLeadTimeline } from '../lib/lead-timeline.mjs';
import { parseCsv, parseInstantlyLeadsCsv, parseInstantlyActivityCsv, buildNovusMatchIndex, matchInstantlyLead } from '../lib/campaign-import.mjs';
import { PROBE_CALL_CAMPAIGN_NAME, PROBE_CALL_CAMPAIGN_TYPE, PROBE_CALL_SEQUENCE } from '../lib/probe-call-campaign.mjs';

let passed = 0;
const ok = (msg) => { passed += 1; console.log(`  ✓ ${msg}`); };

function makeStore(initial) {
  const store = structuredClone(initial);
  const api = {
    async get(range) { const tab = String(range).split('!')[0]; if (!(tab in store)) throw new Error(`Unable to parse range: ${tab}`); return store[tab].map((r) => r.slice()); },
    async append(range, rows) { const tab = String(range).split('!')[0]; if (!(tab in store)) throw new Error(`no tab ${tab}`); store[tab].push(...rows.map((r) => r.slice())); },
    async update(range, rows) {
      const [tab, a1] = String(range).split('!');
      const m = a1.match(/^([A-Z]+)(\d+)/);
      const colIdx = m[1].split('').reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;
      const rowIdx = Number(m[2]) - 1;
      rows.forEach((row, i) => {
        while (store[tab].length <= rowIdx + i) store[tab].push([]);
        const target = store[tab][rowIdx + i];
        row.forEach((v, j) => { while (target.length <= colIdx + j) target.push(''); target[colIdx + j] = v; });
      });
    },
    async batchUpdate(data) { for (const { range, values } of data) await api.update(range, values); },
    async listTabs() { return Object.keys(store); },
    async addTab(tab) { store[tab] = []; },
  };
  return { store, repo: createRepo(api) };
}

// Relative to the real clock: handlers stamp rows with the real now, and the
// timeline order assertions need the fixture's "future" to stay in the future.
const T0 = Math.floor(Date.now() / 60_000) * 60_000;
const iso = (ms) => new Date(ms).toISOString();
const DAY = 86_400_000;

// ── 1. eligibility rules ───────────────────────────────────────────────────
{
  const base = () => ({
    agency: { agency_id: 'ag_1', email_verification_status: 'VALID', current_pipeline_status: '', suppression_status: '' },
    contact: { email: 'jane@alpha.co.uk', name: 'Jane Smith', role: 'Director', verification_status: 'VALID', contact_type: 'OWNER_DIRECT' },
    probe: { probe_id: 'pr_1', probe_status: 'closed', probe_timestamp: iso(T0 - 20 * DAY), compromised: 'FALSE' },
    personalisation: { email_observation: 'x' },
    replyEvents: [], actions: [], campaignEvents: [], memberships: [], salesMessages: [], stage: 'PROBE_COMPLETE',
    campaign: { campaign_id: 'cmp_new', campaign_type: 'ENQUIRY_FOLLOWUP' },
  });
  let r = evaluateEligibility(base(), { nowMs: T0 });
  assert.equal(r.status, 'READY');
  assert.deepEqual(r.reasons, ['EMAIL_VALID', 'PROBE_COMPLETE', 'NO_PRIOR_OUTREACH', 'OWNER_CONTACT']);
  ok('clean lead is READY with positive facts recorded as reasons');

  r = evaluateEligibility({ ...base(), replyEvents: [{ classification: 'OPT_OUT', suppression_type: 'PERMANENT' }] }, { nowMs: T0 });
  assert.equal(r.status, 'BLOCKED'); assert.ok(r.blocks.includes('OPTED_OUT'));
  ok('permanent opt-out blocks');

  r = evaluateEligibility({ ...base(), contact: { ...base().contact, verification_status: 'RISKY' } }, { nowMs: T0 });
  assert.equal(r.status, 'BLOCKED'); assert.ok(r.blocks.includes('RISKY_EMAIL'));
  r = evaluateEligibility({ ...base(), contact: { ...base().contact, verification_status: 'RISKY' } }, { nowMs: T0, policy: { allow_risky_email: true } });
  assert.equal(r.status, 'WARNING'); assert.ok(r.warnings.includes('RISKY_EMAIL'));
  ok('RISKY email: block by default, warning when the policy allows it');

  r = evaluateEligibility({ ...base(), campaignEvents: [{ event_type: 'EMAIL_SENT', occurred_at: iso(T0 - 3 * DAY) }] }, { nowMs: T0 });
  assert.equal(r.status, 'WARNING');
  assert.deepEqual(r.warnings, ['RECENTLY_EMAILED', 'LAST_EMAIL_3_DAYS_AGO']);
  r = evaluateEligibility({ ...base(), campaignEvents: [{ event_type: 'EMAIL_SENT', occurred_at: iso(T0 - 30 * DAY) }] }, { nowMs: T0 });
  assert.equal(r.status, 'READY'); assert.ok(r.reasons.includes('PRIOR_OUTREACH_OUTSIDE_COOLING'));
  ok('cooling period: 3 days ago warns with the day count, 30 days ago is ready');

  r = evaluateEligibility({ ...base(), campaignEvents: [{ event_type: 'EMAIL_BOUNCED', occurred_at: iso(T0 - 3 * DAY) }] }, { nowMs: T0 });
  assert.ok(r.blocks.includes('HARD_BOUNCE'));
  r = evaluateEligibility({ ...base(), memberships: [{ campaign_id: 'cmp_other', campaign_status: 'ACTIVE', member_status: 'PUSHED' }] }, { nowMs: T0 });
  assert.ok(r.blocks.includes('IN_ACTIVE_CAMPAIGN'));
  r = evaluateEligibility({ ...base(), memberships: [{ campaign_id: 'cmp_new', campaign_status: 'DRAFT', member_status: 'SELECTED' }] }, { nowMs: T0 });
  assert.ok(r.blocks.includes('ALREADY_IN_CAMPAIGN'));
  r = evaluateEligibility({ ...base(), stage: 'REPLIED_NEEDS_HUMAN' }, { nowMs: T0 });
  assert.ok(r.blocks.includes('ACTIVE_CONVERSATION'));
  r = evaluateEligibility({ ...base(), stage: 'MEETING_BOOKED' }, { nowMs: T0 });
  assert.ok(r.blocks.includes('MEETING_BOOKED'));
  r = evaluateEligibility({ ...base(), replyEvents: [{ classification: 'NOT_INTERESTED' }] }, { nowMs: T0 });
  assert.ok(r.blocks.includes('NEGATIVE_REPLY'));
  r = evaluateEligibility({ ...base(), actions: [{ action_type: 'CALL_PROSPECT', action_status: 'PENDING' }] }, { nowMs: T0 });
  assert.ok(r.blocks.includes('ACTIVE_FOLLOWUP'));
  r = evaluateEligibility({ ...base(), duplicate_email: true }, { nowMs: T0 });
  assert.ok(r.blocks.includes('DUPLICATE_EMAIL'));
  ok('bounce, other active campaign, same campaign, active conversation, meeting booked, negative reply, active follow-up and duplicates all block');

  r = evaluateEligibility({ ...base(), probe: null }, { nowMs: T0 });
  assert.ok(r.blocks.includes('MISSING_PROBE'));
  r = evaluateEligibility({ ...base(), probe: null }, { nowMs: T0, policy: { requires_probe: false } });
  assert.equal(r.status, 'READY');
  r = evaluateEligibility({ ...base(), probe: { ...base().probe, probe_status: 'observing' } }, { nowMs: T0 });
  assert.equal(r.status, 'WARNING'); assert.ok(r.warnings.includes('PROBE_NOT_CLOSED'));
  r = evaluateEligibility({ ...base(), probe: { ...base().probe, compromised: 'TRUE' } }, { nowMs: T0 });
  assert.ok(r.blocks.includes('PROBE_COMPROMISED'));
  ok('probe dependency follows the campaign policy: missing blocks, observing warns, compromised blocks, GENERAL campaigns ignore it');

  const facts = deriveFacts({ ...base(), contact: { email: 'info@alpha.co.uk', name: '', verification_status: 'VALID', contact_type: '' } }, { nowMs: T0 });
  assert.equal(facts.generic_email, true); assert.equal(facts.named_contact, false);
  const summary = summariseEligibility([evaluateEligibility(base(), { nowMs: T0 }), r]);
  assert.equal(summary.READY, 1); assert.equal(summary.BLOCKED, 1); assert.equal(summary.reason_breakdown[0].code, 'PROBE_COMPROMISED');
  ok('generic-inbox detection and the reason breakdown summary');
}

// ── 2. audience builder over a workbook ────────────────────────────────────
const AG = ['agency_id', 'agency_name', 'clean_agency_name', 'location', 'branch_count', 'crm_name', 'owner_md', 'outreach_contact_name', 'outreach_contact_email', 'email_verification_status', 'current_pipeline_status', 'suppression_status', 'primary_contact_email', 'main_phone'];
const CT = ['contact_id', 'agency_id', 'contact_name', 'contact_role', 'email', 'contact_type', 'verification_status', 'is_selected_for_outreach'];
const PR = ['probe_id', 'probe_reference', 'agency_id', 'portal', 'property_address', 'property_street', 'probe_timestamp', 'probe_status', 'compromised', 'observation_closed_at', 'created_at'];
const RE = ['reply_event_id', 'agency_id', 'outreach_id', 'lead_email', 'instantly_email_id', 'received_at', 'classification', 'suppression_type', 'cleaned_reply_text', 'next_action', 'action_status'];
const OB = ['outbound_id', 'agency_id', 'probe_id', 'outreach_contact_email', 'instantly_lead_id', 'instantly_added_at', 'outbound_status', 'property_street', 'demo_url', 'created_at', 'updated_at'];
const PS = ['probe_id', 'agency_id', 'email_observation', 'email_commercial_hook', 'created_at'];
const workbook = () => ({
  AGENCIES: [AG,
    ['ag_1', 'Alpha Estates', 'Alpha Estates', 'Chelmsford', '2', 'Reapit', 'Jane Smith', 'Jane Smith', 'jane@alpha.co.uk', 'VALID', '', '', '', '01245 000001'],
    ['ag_2', 'Beta Homes', 'Beta Homes', 'Brentwood', '1', 'Alto', '', 'Info', 'info@beta.co.uk', 'VALID', '', '', '', '01277 000002'],
    ['ag_3', 'Gamma Lettings', 'Gamma Lettings', 'Chelmsford', '4', 'Reapit', 'Sam Jones', 'Sam Jones', 'sam@gamma.co.uk', 'RISKY', '', '', '', ''],
    ['ag_4', 'Delta Sales', 'Delta Sales', 'Romford', '1', '', '', 'Pat Lee', 'pat@delta.co.uk', 'VALID', 'MEETING_BOOKED', '', '', ''],
    ['ag_5', 'Epsilon', 'Epsilon', 'Brentwood', '1', '', '', '', '', '', '', '', '', ''],
    ['ag_6', 'Zeta & Co', 'Zeta & Co', 'Chelmsford', '3', 'Alto', '', 'Kim Chan', 'kim@zeta.co.uk', 'VALID', '', '', '', ''],
  ],
  CONTACTS: [CT,
    ['cnt_1', 'ag_1', 'Jane Smith', 'Director', 'jane@alpha.co.uk', 'OWNER_DIRECT', 'VALID', 'TRUE'],
    ['cnt_6', 'ag_6', 'Kim Chan', 'Branch Manager', 'kim@zeta.co.uk', 'NAMED_HUMAN', 'VALID', 'TRUE'],
  ],
  PROBES: [PR,
    ['pr_1', 'RM-0001', 'ag_1', 'rightmove', '12 High St, Chelmsford', '12 High St', iso(T0 - 20 * DAY), 'closed', 'FALSE', iso(T0 - 13 * DAY), iso(T0 - 20 * DAY)],
    ['pr_2', 'RM-0002', 'ag_2', 'rightmove', '3 Mill Lane', '3 Mill Lane', iso(T0 - 10 * DAY), 'closed', 'FALSE', iso(T0 - 3 * DAY), iso(T0 - 10 * DAY)],
    ['pr_3', 'RM-0003', 'ag_3', 'rightmove', '9 Park Rd', '9 Park Rd', iso(T0 - 5 * DAY), 'observing', 'FALSE', '', iso(T0 - 5 * DAY)],
    ['pr_4', 'RM-0004', 'ag_4', 'rightmove', '1 Ash Cl', '1 Ash Cl', iso(T0 - 30 * DAY), 'closed', 'FALSE', iso(T0 - 23 * DAY), iso(T0 - 30 * DAY)],
    ['pr_6', 'RM-0006', 'ag_6', 'rightmove', '7 Elm Ave', '7 Elm Ave', iso(T0 - 40 * DAY), 'closed', 'FALSE', iso(T0 - 33 * DAY), iso(T0 - 40 * DAY)],
  ],
  INTELLIGENCE: [['intelligence_id', 'agency_id', 'probe_id', 'grade']],
  PERSONALISATION: [PS, ['pr_1', 'ag_1', 'They replied in 4 minutes', 'Every enquiry counts', iso(T0 - 12 * DAY)], ['pr_6', 'ag_6', 'obs', 'hook', iso(T0 - 30 * DAY)]],
  DEMOS: [['demo_id', 'agency_id', 'probe_id', 'demo_slug', 'demo_status', 'first_viewed_at', 'cta_clicked_at', 'meeting_booked_at', 'view_count']],
  OUTBOUND: [OB, ['out_6', 'ag_6', 'pr_6', 'kim@zeta.co.uk', 'lead_legacy_6', iso(T0 - 25 * DAY), 'READY', '7 Elm Ave', 'https://demo.getnovus.co.uk/zeta', iso(T0 - 26 * DAY), iso(T0 - 25 * DAY)]],
  REPLY_EVENTS: [RE],
  SALES_MESSAGES: [['sales_message_id', 'agency_id', 'outreach_id', 'message_type', 'send_outcome', 'sent_at', 'subject', 'body_text', 'created_at']],
  ACTIONS: [ACTIONS_HEADER.slice()],
  CALLS: [['call_id', 'agency_id', 'started_at', 'outcome', 'connected_at', 'owner_reached', 'call_status', 'contact_name', 'metadata_json', 'created_at'],
    ['cal_1', 'ag_1', iso(T0 - 2 * DAY), 'CALLBACK_REQUESTED', iso(T0 - 2 * DAY), 'TRUE', 'completed', 'Jane Smith', '{}', iso(T0 - 2 * DAY)]],
  COMMUNICATIONS: [['communication_id', 'agency_id', 'probe_id', 'occurred_at', 'received_at', 'channel', 'direction', 'subject', 'automated_or_human'],
    ['com_1', 'ag_1', 'pr_1', iso(T0 - 20 * DAY + 3600000), iso(T0 - 20 * DAY + 3600000), 'email', 'inbound', 'Re: 12 High St', 'human']],
  CAMPAIGNS: [CAMPAIGNS_HEADER.slice(), CAMPAIGNS_HEADER.map((_, i) => (i === 0 ? 'SCHEMA NOTE' : ''))],
  CAMPAIGN_MEMBERS: [CAMPAIGN_MEMBERS_HEADER.slice(), CAMPAIGN_MEMBERS_HEADER.map((_, i) => (i === 0 ? 'SCHEMA NOTE' : ''))],
  CAMPAIGN_EVENTS: [CAMPAIGN_EVENTS_HEADER.slice(), CAMPAIGN_EVENTS_HEADER.map((_, i) => (i === 0 ? 'SCHEMA NOTE' : ''))],
});
const tablesOf = (store) => Object.fromEntries(Object.entries(store).map(([tab, values]) => [tab, { header: values[0] || [], rows: values.slice(1) }]));
{
  const { store } = makeStore(workbook());
  const tables = tablesOf(store);
  const a = buildCampaignAudience(tables, tables, { filters: {}, campaign: { campaign_type: 'ENQUIRY_FOLLOWUP' }, now: iso(T0) });
  const byId = Object.fromEntries(a.rows.map((r) => [r.agency_id, r]));
  assert.equal(a.total_agencies, 6);
  // Default filters: email must exist and be VALID → ag_3 (RISKY) and ag_5 (no email) are not selected.
  assert.deepEqual(Object.keys(byId).sort(), ['ag_1', 'ag_2', 'ag_4', 'ag_6']);
  assert.equal(byId.ag_1.eligibility.status, 'READY', 'a logged call with no open ACTIONS row is not an active follow-up');
  ok(`default audience selects VALID-email agencies only (${a.selected} of ${a.total_agencies})`);
  assert.equal(byId.ag_4.eligibility.status, 'BLOCKED'); assert.ok(byId.ag_4.eligibility.blocks.includes('MEETING_BOOKED'));
  assert.equal(byId.ag_2.eligibility.status, 'WARNING'); assert.ok(byId.ag_2.eligibility.warnings.includes('GENERIC_EMAIL'));
  assert.equal(byId.ag_6.eligibility.status, 'READY', JSON.stringify(byId.ag_6.eligibility));
  assert.ok(byId.ag_6.eligibility.reasons.includes('PRIOR_OUTREACH_OUTSIDE_COOLING'), 'legacy handoff 25 days ago counts as prior outreach');
  assert.equal(byId.ag_6.prior.email_count, 1);
  assert.equal(byId.ag_1.spoken_to, true);
  ok('per-lead decisions: meeting booked blocks, generic inbox warns, legacy Instantly handoff counts as prior outreach, owner spoken-to from CALLS');

  const risky = buildCampaignAudience(tables, tables, { filters: { include_risky: true }, policy: { allow_risky_email: true }, campaign: { campaign_type: 'ENQUIRY_FOLLOWUP' }, now: iso(T0) });
  assert.ok(risky.rows.some((r) => r.agency_id === 'ag_3' && r.eligibility.status === 'WARNING'));
  const direct = buildCampaignAudience(tables, tables, { filters: { contact_kind: 'direct' }, campaign: { campaign_type: 'ENQUIRY_FOLLOWUP' }, now: iso(T0) });
  assert.ok(!direct.rows.some((r) => r.agency_id === 'ag_2'));
  const loc = buildCampaignAudience(tables, tables, { filters: { location: 'chelms', never_emailed: true }, campaign: { campaign_type: 'ENQUIRY_FOLLOWUP' }, now: iso(T0) });
  assert.deepEqual(loc.rows.map((r) => r.agency_id), ['ag_1']);
  const explicit = buildCampaignAudience(tables, tables, { filters: { agency_ids: ['ag_6', 'ag_2'], exclude_agency_ids: ['ag_2'] }, campaign: { campaign_type: 'ENQUIRY_FOLLOWUP' }, now: iso(T0) });
  assert.deepEqual(explicit.rows.map((r) => r.agency_id), ['ag_6']);
  assert.equal(explicit.summary.READY, 1);
  ok('filters: include risky, direct-only, location + never emailed, explicit ids with exclusions');

  const payload = leadPayloadFor(byId.ag_6, { campaignId: 'cmp_x' });
  assert.equal(payload.email, 'kim@zeta.co.uk'); assert.equal(payload.first_name, 'Kim'); assert.equal(payload.company_name, 'Zeta & Co');
  assert.equal(payload.custom_variables.property_street, '7 Elm Ave'); assert.equal(payload.custom_variables.demo_url, 'https://demo.getnovus.co.uk/zeta');
  assert.equal(payload.custom_variables.email_observation, 'obs'); assert.equal(payload.custom_variables.novus_agency_id, 'ag_6');
  ok('Instantly lead payload mirrors the proven OUTBOUND variable set plus NOVUS ids');
  assert.deepEqual(normaliseFilters({ verification: 'valid,risky', never_emailed: 'true', branch_count_min: '2' }).verification, ['VALID', 'RISKY']);
  ok('filter normalisation accepts form-shaped input');

  // Multi-branch: two agency rows share kim@zeta.co.uk. Exactly one keeps the address.
  const dupStore = makeStore(workbook()).store;
  dupStore.AGENCIES.push(['ag_6b', 'Zeta & Co Brentwood', 'Zeta & Co Brentwood', 'Brentwood', '1', 'Alto', '', 'Kim Chan', 'kim@zeta.co.uk', 'VALID', '', '', '', '']);
  dupStore.PROBES.push(['pr_6b', 'RM-0007', 'ag_6b', 'rightmove', '8 Elm Ave', '8 Elm Ave', iso(T0 - 41 * DAY), 'closed', 'FALSE', iso(T0 - 34 * DAY), iso(T0 - 41 * DAY)]);
  const dupTables = tablesOf(dupStore);
  const dup = buildCampaignAudience(dupTables, dupTables, { filters: { agency_ids: ['ag_6', 'ag_6b'] }, campaign: { campaign_type: 'ENQUIRY_FOLLOWUP' }, now: iso(T0) });
  const dupBy = Object.fromEntries(dup.rows.map((r) => [r.agency_id, r]));
  assert.equal(dupBy.ag_6.eligibility.status, 'READY', 'the personalised probe keeps the address');
  assert.equal(dupBy.ag_6b.eligibility.status, 'BLOCKED'); assert.ok(dupBy.ag_6b.eligibility.blocks.includes('DUPLICATE_EMAIL'));
  assert.equal(dup.buckets.selected.eligible_contacts, 1);
  ok('a contact address shared by two agency rows is kept exactly once (the personalised row) and the other branch is DUPLICATE_EMAIL');
}

// ── 3. Instantly client ────────────────────────────────────────────────────
{
  const calls = [];
  let attempt = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.Authorization });
    if (url.includes('/campaigns/analytics')) { attempt += 1; if (attempt === 1) return new Response('{"error":"slow down"}', { status: 429, headers: { 'retry-after': '0' } }); return new Response(JSON.stringify([{ campaign_id: 'ic_1', emails_sent_count: 9 }]), { status: 200 }); }
    if (url.endsWith('/leads/list')) return new Response(JSON.stringify({ items: [{ id: 'l1', email: 'a@b.c' }], next_starting_after: null }), { status: 200 });
    if (url.includes('/campaigns/bad')) return new Response('<html>nope</html>', { status: 200 });
    if (url.includes('/campaigns/missing')) return new Response(JSON.stringify({ statusCode: 404, error: 'Not Found', message: 'no such campaign' }), { status: 404 });
    return new Response('{}', { status: 200 });
  };
  const client = createInstantlyClient({ apiKey: 'sk_secret', fetchImpl, sleepImpl: async () => {} });
  const analytics = await client.getCampaignAnalytics('ic_1');
  assert.equal(analytics.emails_sent_count, 9); assert.equal(attempt, 2);
  ok('429 is retried with backoff and the analytics row is picked by campaign id');
  const leads = await client.listCampaignLeads('ic_1');
  assert.equal(leads.items.length, 1); assert.equal(calls.at(-1).body.campaign, 'ic_1'); assert.equal(calls.at(-1).body.limit, 100);
  ok('lead listing is a POST with the documented cursor shape');
  await assert.rejects(() => client.getCampaign('bad'), (err) => err instanceof InstantlyApiError && err.code === 'MALFORMED');
  await assert.rejects(() => client.getCampaign('missing'), (err) => err instanceof InstantlyApiError && err.status === 404 && err.detail === 'no such campaign' && !/sk_secret/.test(JSON.stringify(err)));
  ok('malformed and 404 responses become typed errors that never echo the key');
  await assert.rejects(() => client.addLeads({ campaignId: 'ic_1', leads: [] }), /non-empty/);
  assert.ok(calls.every((c) => c.auth === 'Bearer sk_secret'));
  ok('input validation before any request; bearer auth on every call');

  const seq = normaliseSequence({ steps: [{ subject: 'Hi {{firstName}}', body: 'Line 1\nLine 2' }, { subject: 'Re: Hi', body: 'Bump', delay_days: 3 }, { subject: 'Last', body: 'Bye', delay_days: 4 }] });
  assert.equal(seq.errors.length, 0);
  const payload = buildInstantlyCampaignPayload({ name: 'Test', sequence: seq.sequence, schedule: { name: 'S', from: '09:00', to: '17:00', timezone: 'Europe/Isle_of_Man', days: { 0: false, 1: true, 2: true, 3: true, 4: true, 5: true, 6: false } }, sending: { email_list: ['joe@novushq.co.uk'], daily_limit: 40, stop_on_reply: true, stop_on_auto_reply: false, open_tracking: true, link_tracking: false, text_only: false, daily_max_leads: 0 } });
  assert.deepEqual(payload.sequences[0].steps.map((s) => s.delay), [3, 4, 0], 'NOVUS "wait before this step" becomes Instantly "wait before next step"');
  assert.equal(payload.sequences[0].steps[0].variants[0].body, '<div>Line 1</div><div>Line 2</div>');
  assert.equal(payload.campaign_schedule.schedules[0].days['1'], true);
  assert.equal(payload.email_list[0], 'joe@novushq.co.uk'); assert.equal(payload.daily_limit, 40); assert.equal(payload.daily_max_leads, undefined);
  assert.ok(normaliseSequence({ steps: [{ subject: 'x', body: '' }] }).errors.length);
  ok('Instantly campaign payload: delays shift by one, bodies use HTML blocks, schedule/sending map to the documented fields');
}

// ── 4. handlers end to end ─────────────────────────────────────────────────
{
  const { store, repo } = makeStore((() => { const w = workbook(); delete w.CAMPAIGNS; delete w.CAMPAIGN_MEMBERS; delete w.CAMPAIGN_EVENTS; return w; })());
  __setRepoForTests(repo);
  process.env.NOVUS_BASIC_AUTH_USER = 'novus'; process.env.NOVUS_BASIC_AUTH_PASS = 'testpass';
  process.env.INSTANTLY_API_KEY = 'sk_write'; process.env.INSTANTLY_REPLY_API_KEY = 'sk_read'; process.env.INSTANTLY_WEBHOOK_SECRET = 'whsec';
  const { default: handler } = await import('../api/novus/personalisation.js');
  const basic = 'Basic ' + Buffer.from('novus:testpass').toString('base64');
  const response = () => ({ statusCode: 200, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; }, setHeader(k, v) { this.headers[k] = v; } });
  const call = async (method, operation, body, query = {}, headers = {}) => { const res = response(); await handler({ method, query: { novus_operation: operation, ...query }, headers: { authorization: basic, ...headers }, body }, res); return res; };

  // Fake Instantly. Records every write so the test can assert what was sent.
  const instantly = { campaigns: new Map(), leads: new Map(), calls: [], failNextAdd: false, dropSequenceOnCreate: true, activated: [], paused: [] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname !== 'api.instantly.ai') throw new Error(`unexpected fetch ${url}`);
    const body = init.body ? JSON.parse(init.body) : null;
    instantly.calls.push({ path: u.pathname, method: init.method, body });
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status });
    if (init.method === 'GET' && u.pathname === '/api/v2/campaigns') return json({ items: [...instantly.campaigns.values()], next_starting_after: null });
    if (init.method === 'POST' && u.pathname === '/api/v2/campaigns') { const id = `ic_${instantly.campaigns.size + 1}`; const c = { ...body, id, status: 0 }; if (instantly.dropSequenceOnCreate) { c.sequences = []; instantly.dropSequenceOnCreate = false; } instantly.campaigns.set(id, c); return json(c); }
    const m = u.pathname.match(/^\/api\/v2\/campaigns\/([^/]+)(\/activate|\/pause)?$/);
    if (m && m[1] !== 'analytics') {
      const c = instantly.campaigns.get(m[1]); if (!c) return json({ statusCode: 404, error: 'Not Found', message: 'no campaign' }, 404);
      if (m[2] === '/activate') { c.status = 1; instantly.activated.push(c.id); return json(c); }
      if (m[2] === '/pause') { c.status = 2; instantly.paused.push(c.id); return json(c); }
      if (init.method === 'PATCH') { Object.assign(c, body); return json(c); }
      return json(c);
    }
    if (u.pathname === '/api/v2/leads/add') {
      if (instantly.failNextAdd) { instantly.failNextAdd = false; return json({ statusCode: 500, error: 'Internal', message: 'boom' }, 500); }
      const created = []; let dup = 0;
      body.leads.forEach((lead, index) => {
        const key = `${body.campaign_id}|${lead.email}`;
        if (instantly.leads.has(key)) { dup += 1; return; }
        const id = `lead_${instantly.leads.size + 1}`;
        instantly.leads.set(key, { id, email: lead.email, campaign: body.campaign_id, status: 1, lt_interest_status: null, email_reply_count: 0, payload: lead.custom_variables });
        created.push({ index, id, email: lead.email });
      });
      return json({ status: 'success', total_sent: body.leads.length, leads_uploaded: created.length, duplicated_leads: dup, in_blocklist: 0, skipped_count: 0, invalid_email_count: 0, created_leads: created });
    }
    if (u.pathname === '/api/v2/leads/list') return json({ items: [...instantly.leads.values()].filter((l) => l.campaign === body.campaign), next_starting_after: null });
    if (u.pathname === '/api/v2/campaigns/analytics') return json([{ campaign_id: u.searchParams.get('id'), leads_count: 2, contacted_count: 2, emails_sent_count: 3, reply_count: 1, reply_count_unique: 1, bounced_count: 0, unsubscribed_count: 0, open_count_unique: 2, completed_count: 0 }]);
    if (u.pathname === '/api/v2/campaigns/analytics/steps') return json([{ step: 1, variant: 1, sent: 2, opened: 2, unique_opened: 2, replies: 1, unique_replies: 1 }, { step: 2, variant: 1, sent: 1, opened: 0, unique_opened: 0, replies: 0, unique_replies: 0 }]);
    if (u.pathname === '/api/v2/accounts') return json({ items: [{ email: 'joe@novushq.co.uk', status: 1, daily_limit: 30, warmup_status: 1 }], next_starting_after: null });
    if (u.pathname === '/api/v2/emails') {
      const cid = u.searchParams.get('campaign_id');
      return json({ items: [
        { id: 'em_1', ue_type: 1, campaign_id: cid, lead: 'kim@zeta.co.uk', eaccount: 'joe@novushq.co.uk', from_address_email: 'joe@novushq.co.uk', to_address_email_list: 'kim@zeta.co.uk', subject: 'Hi Kim', timestamp_created: iso(T0 + 1 * DAY), step: 1 },
        { id: 'em_2', ue_type: 1, campaign_id: cid, lead: 'kim@zeta.co.uk', eaccount: 'joe@novushq.co.uk', from_address_email: 'joe@novushq.co.uk', to_address_email_list: 'kim@zeta.co.uk', subject: 'Re: Hi Kim', timestamp_created: iso(T0 + 4 * DAY), step: 2 },
        { id: 'em_3', ue_type: 2, campaign_id: cid, lead: 'kim@zeta.co.uk', eaccount: 'joe@novushq.co.uk', from_address_email: 'kim@zeta.co.uk', to_address_email_list: 'joe@novushq.co.uk', subject: 'Re: Hi Kim', body: { text: 'Sounds interesting, call me' }, timestamp_created: iso(T0 + 5 * DAY) },
      ], next_starting_after: null });
    }
    return json({ statusCode: 404, error: 'Not Found', message: u.pathname }, 404);
  };

  const denied = response();
  await handler({ method: 'GET', query: { novus_operation: 'campaigns-list' }, headers: {} }, denied);
  assert.equal(denied.statusCode, 401);
  ok('campaign operations require Basic Auth');

  let res = await call('GET', 'campaigns-list', null, { refresh: '1' });
  assert.equal(res.statusCode, 200); assert.equal(res.body.setup.available, false);
  assert.deepEqual(res.body.setup.missing.sort(), ['CAMPAIGNS', 'CAMPAIGN_EVENTS', 'CAMPAIGN_MEMBERS']);
  assert.equal(res.body.config.instantly_write_configured, true);
  ok('list reports missing tabs instead of failing');
  res = await call('POST', 'campaign-setup', {}); assert.equal(res.statusCode, 400);
  res = await call('POST', 'campaign-setup', { confirm: 'SETUP_CAMPAIGN_TABS' }); assert.equal(res.statusCode, 200);
  assert.equal(store.CAMPAIGNS[0].join(','), CAMPAIGNS_HEADER.join(','));
  assert.equal(store.CAMPAIGN_MEMBERS[1][0], 'SCHEMA NOTE');
  ok('setup creates the three tabs with header + SCHEMA NOTE rows');

  const quotaError = Object.assign(new Error('RESOURCE_EXHAUSTED'), { statusCode: 429 });
  __setRepoForTests({ ...repo, getTable: async (tab) => { if (tab === 'CONTACTS') throw quotaError; return repo.getTable(tab); } });
  res = await call('POST', 'campaign-audience', { campaign_type: 'ENQUIRY_FOLLOWUP', filters: {} });
  assert.equal(res.statusCode, 429); assert.match(res.body.error, /could not be verified/);
  __setRepoForTests(repo);
  ok('a quota error in an optional audience tab fails closed instead of making a partial audience');

  res = await call('POST', 'campaign-audience', { campaign_type: 'ENQUIRY_FOLLOWUP', filters: { include_risky: true }, policy: { allow_risky_email: true } });
  assert.equal(res.statusCode, 200); assert.equal(res.body.selected, 5);
  assert.equal(res.body.summary.READY, 2); assert.equal(res.body.summary.WARNING, 2); assert.equal(res.body.summary.BLOCKED, 1);
  assert.ok(res.body.rows.every((r) => r.eligibility.facts === undefined), 'facts are not shipped to the browser');
  ok(`audience preview: ${res.body.selected} selected → ${res.body.summary.READY} ready / ${res.body.summary.WARNING} warning / ${res.body.summary.BLOCKED} blocked`);

  const sequence = { steps: [{ subject: 'Your enquiry on {{property_street}}', body: 'Hi {{firstName}},\n{{email_observation}}' }, { subject: 'Re: {{property_street}}', body: 'Bump', delay_days: 3 }] };
  const sending = { email_list: ['joe@novushq.co.uk'], daily_limit: 30 };
  res = await call('POST', 'campaign-create', { name: 'Enquiry → Quick Call V1', sequence, sending, filters: { include_risky: true }, policy: { allow_risky_email: true } });
  assert.equal(res.statusCode, 400); assert.match(res.body.error, /confirm/);
  res = await call('POST', 'campaign-create', { confirm: 'CREATE_CAMPAIGN', confirm_recipient_count: 5, name: 'Enquiry → Quick Call V1', campaign_type: 'ENQUIRY_FOLLOWUP', sequence, sending, filters: { include_risky: true }, policy: { allow_risky_email: true } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const campaignId = res.body.campaign_id;
  assert.equal(res.body.members, 5);
  assert.equal(instantly.calls.length, 0, 'create never touches Instantly');
  ok('create writes a DRAFT campaign and a member snapshot without calling Instantly');
  res = await call('POST', 'campaign-create', { confirm: 'CREATE_CAMPAIGN', name: 'enquiry → quick call v1', sequence, sending });
  assert.equal(res.statusCode, 409);
  ok('duplicate campaign names are refused');

  res = await call('GET', 'campaign-detail', null, { campaign_id: campaignId });
  assert.equal(res.statusCode, 200);
  const detail = res.body;
  assert.equal(detail.campaign.status, 'DRAFT'); assert.equal(detail.campaign.metrics.leads, 4); assert.equal(detail.campaign.metrics.excluded, 1);
  assert.equal(detail.campaign.metrics.warning_unacknowledged, 2);
  assert.equal(detail.members.find((m) => m.agency_id === 'ag_4').member_status, 'EXCLUDED');
  assert.equal(detail.events.filter((e) => e.event_type === 'LEAD_ADDED').length, 4);
  assert.equal(detail.campaign.sequence.steps.length, 2);
  ok('detail: members carry their eligibility snapshot, blocked leads are EXCLUDED, LEAD_ADDED events exist');

  // Launch before push must be refused.
  res = await call('POST', 'campaign-launch', { confirm: 'LAUNCH_CAMPAIGN', campaign_id: campaignId, acknowledge: true });
  assert.equal(res.statusCode, 409); assert.match(res.body.error, /not been pushed/);
  ok('launch is refused before a push');

  // Push READY only.
  res = await call('POST', 'campaign-push', { confirm: 'PUSH_TO_INSTANTLY', campaign_id: campaignId });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.created_instantly_campaign, true); assert.equal(res.body.pushed, 2); assert.equal(res.body.warnings_held, 2); assert.equal(res.body.blocked_at_push, 0);
  const instantlyId = res.body.instantly_campaign_id;
  const createCall = instantly.calls.find((c) => c.path === '/api/v2/campaigns' && c.method === 'POST');
  assert.equal(createCall.body.name, 'Enquiry → Quick Call V1'); assert.equal(createCall.body.sequences[0].steps[0].delay, 3);
  assert.equal(instantly.calls.filter((c) => c.path === `/api/v2/campaigns/${instantlyId}` && c.method === 'PATCH').length, 1, 'a shell-only create is repaired once before enrolment');
  assert.equal(instantly.campaigns.get(instantlyId).sequences[0].steps.length, 2);
  assert.deepEqual(createCall.body.email_list, ['joe@novushq.co.uk']);
  const addCall = instantly.calls.find((c) => c.path === '/api/v2/leads/add');
  assert.deepEqual(addCall.body.leads.map((l) => l.email), ['jane@alpha.co.uk', 'kim@zeta.co.uk']); assert.equal(addCall.body.skip_if_in_campaign, true);
  assert.equal(addCall.body.leads[1].custom_variables.property_street, '7 Elm Ave');
  assert.equal(instantly.activated.length, 0, 'push NEVER activates');
  ok('push creates the Instantly campaign as a draft and adds only READY leads; warnings are held, nothing is activated');

  res = await call('GET', 'campaign-detail', null, { campaign_id: campaignId });
  const kim = res.body.members.find((m) => m.agency_id === 'ag_6');
  assert.equal(kim.member_status, 'PUSHED'); assert.equal(kim.instantly_lead_id, 'lead_2');
  assert.equal(res.body.campaign.instantly_campaign_id, instantlyId); assert.equal(res.body.campaign.status, 'DRAFT'); assert.ok(res.body.campaign.pushed_at);
  ok('member gets its Instantly lead id; campaign stays DRAFT with pushed_at set');

  // Acknowledge warnings, push again with a provider failure: the pushed
  // leads are not re-sent, the warned ones are marked PUSH_FAILED.
  res = await call('POST', 'campaign-update', { campaign_id: campaignId, acknowledge_warnings: true });
  assert.equal(res.statusCode, 200);
  let callsBefore = instantly.calls.length;
  instantly.failNextAdd = true;
  res = await call('POST', 'campaign-push', { confirm: 'PUSH_TO_INSTANTLY', campaign_id: campaignId, include_warnings: true });
  assert.equal(res.statusCode, 200); assert.equal(res.body.success, false); assert.equal(res.body.failed, 2); assert.equal(res.body.errors[0].stage, 'add_leads');
  assert.ok(!instantly.calls.slice(callsBefore).some((c) => c.path === '/api/v2/campaigns' && c.method === 'POST'), 'no second Instantly campaign');
  let failedAdd = instantly.calls.slice(callsBefore).find((c) => c.path === '/api/v2/leads/add');
  assert.deepEqual(failedAdd.body.leads.map((l) => l.email).sort(), ['info@beta.co.uk', 'sam@gamma.co.uk'], 'already-pushed members are not re-sent');
  res = await call('GET', 'campaign-detail', null, { campaign_id: campaignId });
  const beta = res.body.members.find((m) => m.agency_id === 'ag_2');
  assert.equal(beta.member_status, 'PUSH_FAILED'); assert.match(beta.last_error, /boom/); assert.match(res.body.campaign.last_error, /boom/);
  assert.ok(res.body.events.some((e) => e.event_type === 'LEAD_PUSH_FAILED' && e.agency_id === 'ag_2'));
  ok('a failed add marks the affected members PUSH_FAILED with the provider error and records the event; pushed members are never re-sent');

  // Retry: PUSH_FAILED members go again; nothing else does.
  callsBefore = instantly.calls.length;
  res = await call('POST', 'campaign-push', { confirm: 'PUSH_TO_INSTANTLY', campaign_id: campaignId, include_warnings: true });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body)); assert.equal(res.body.success, true); assert.equal(res.body.pushed, 2); assert.equal(res.body.warnings_held, 0);
  const retryAdd = instantly.calls.slice(callsBefore).find((c) => c.path === '/api/v2/leads/add');
  assert.deepEqual(retryAdd.body.leads.map((l) => l.email).sort(), ['info@beta.co.uk', 'sam@gamma.co.uk']);
  assert.equal(instantly.campaigns.get(instantlyId).sequences[0].steps.length, 2, 'repeat push does not append sequence steps');
  assert.equal(instantly.calls.slice(callsBefore).filter((c) => c.method === 'PATCH' && c.path === `/api/v2/campaigns/${instantlyId}`).length, 0, 'matching provider sequence is not rewritten');
  res = await call('GET', 'campaign-detail', null, { campaign_id: campaignId });
  assert.equal(res.body.members.filter((m) => m.member_status === 'PUSHED').length, 4); assert.equal(res.body.campaign.last_error, '');
  ok('retrying a push is idempotent: only PUSH_FAILED members are re-sent, the error clears');

  // Launch: needs acknowledge=true, then activates exactly once.
  res = await call('POST', 'campaign-launch', { confirm: 'LAUNCH_CAMPAIGN', campaign_id: campaignId });
  assert.equal(res.statusCode, 400);
  const remoteBeforeLaunch = instantly.campaigns.get(instantlyId);
  const approvedBody = remoteBeforeLaunch.sequences[0].steps[0].variants[0].body;
  remoteBeforeLaunch.sequences[0].steps[0].variants[0].body = 'Changed copy';
  res = await call('POST', 'campaign-launch', { confirm: 'LAUNCH_CAMPAIGN', campaign_id: campaignId, acknowledge: true });
  assert.equal(res.statusCode, 409); assert.match(res.body.error, /step 1 body/);
  assert.equal(instantly.activated.length, 0);
  remoteBeforeLaunch.sequences[0].steps[0].variants[0].body = approvedBody;
  ok('launch blocks material provider copy drift after a successful push');
  res = await call('POST', 'campaign-launch', { confirm: 'LAUNCH_CAMPAIGN', campaign_id: campaignId, acknowledge: true });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body)); assert.equal(res.body.status, 'ACTIVE');
  assert.deepEqual(instantly.activated, [instantlyId]);
  res = await call('GET', 'campaign-detail', null, { campaign_id: campaignId });
  assert.equal(res.body.campaign.status, 'ACTIVE'); assert.ok(res.body.campaign.launched_at);
  assert.ok(res.body.events.some((e) => e.event_type === 'CAMPAIGN_LAUNCHED'));
  ok('launch requires the confirm token AND acknowledge=true, activates once, records CAMPAIGN_LAUNCHED');
  res = await call('POST', 'campaign-launch', { confirm: 'LAUNCH_CAMPAIGN', campaign_id: campaignId, acknowledge: true });
  assert.equal(res.statusCode, 409);
  res = await call('POST', 'campaign-update', { campaign_id: campaignId, sequence });
  assert.equal(res.statusCode, 409);
  ok('an ACTIVE campaign cannot be launched again or have its sequence edited');

  res = await call('POST', 'campaign-pause', { confirm: 'PAUSE_CAMPAIGN', campaign_id: campaignId });
  assert.equal(res.statusCode, 200); assert.deepEqual(instantly.paused, [instantlyId]);
  res = await call('POST', 'campaign-resume', { confirm: 'RESUME_CAMPAIGN', campaign_id: campaignId });
  assert.equal(res.statusCode, 200); assert.equal(instantly.activated.length, 2);
  ok('pause and resume map to Instantly pause/activate with their own confirm tokens');

  // Webhook.
  const hook = async (payload, secret = 'whsec') => { const res = response(); await handler({ method: 'POST', query: { novus_operation: 'instantly-webhook' }, headers: { 'x-novus-instantly-secret': secret }, body: payload }, res); return res; };
  res = await hook({ event_type: 'email_sent', campaign_id: instantlyId, lead_email: 'kim@zeta.co.uk', timestamp: iso(T0 + DAY), email_id: 'em_1', step: 1 }, 'wrong');
  assert.equal(res.statusCode, 401);
  res = await hook({ event_type: 'email_sent', campaign_id: instantlyId, lead_email: 'kim@zeta.co.uk', timestamp: iso(T0 + DAY), email_id: 'em_1', step: 1, email_subject: 'Hi Kim' });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body)); assert.equal(res.body.duplicate, false); assert.equal(res.body.event_type, 'EMAIL_SENT'); assert.equal(res.body.agency_id, 'ag_6');
  const again = await hook({ event_type: 'email_sent', campaign_id: instantlyId, lead_email: 'kim@zeta.co.uk', timestamp: iso(T0 + DAY), email_id: 'em_1', step: 1, email_subject: 'Hi Kim' });
  assert.equal(again.body.duplicate, true);
  res = await hook({ event_type: 'reply_received', campaign_id: instantlyId, lead_email: 'kim@zeta.co.uk', timestamp: iso(T0 + 5 * DAY), email_id: 'em_3', reply_text_snippet: 'Sounds interesting' });
  res = await hook({ event_type: 'lead_interested', campaign_id: instantlyId, lead_email: 'kim@zeta.co.uk', timestamp: iso(T0 + 5 * DAY + 60000) });
  res = await hook({ event_type: 'email_bounced', campaign_id: instantlyId, lead_email: 'sam@gamma.co.uk', timestamp: iso(T0 + 2 * DAY), email_id: 'em_9' });
  res = await hook({ event_type: 'email_sent', campaign_id: 'legacy_campaign', lead_email: 'jane@alpha.co.uk', timestamp: iso(T0 + 2 * DAY), email_id: 'em_legacy' });
  assert.equal(res.statusCode, 200); assert.equal(res.body.agency_id, 'ag_1'); assert.equal(res.body.campaign_id, '');
  res = await call('GET', 'campaign-detail', null, { campaign_id: campaignId });
  const kim2 = res.body.members.find((m) => m.agency_id === 'ag_6');
  assert.equal(kim2.emails_sent_count, 1); assert.ok(kim2.replied_at); assert.equal(kim2.interest_status, 'INTERESTED'); assert.equal(kim2.last_event_type, 'LEAD_INTERESTED');
  const sam = res.body.members.find((m) => m.agency_id === 'ag_3');
  assert.ok(sam.bounced_at); assert.equal(sam.instantly_lead_status, 'BOUNCED');
  assert.equal(res.body.campaign.metrics.replies, 1); assert.equal(res.body.campaign.metrics.positive, 1); assert.equal(res.body.campaign.metrics.bounces, 1);
  assert.equal(webhookDedupeKey({ event_type: 'email_sent', campaign_id: 'a', lead_email: 'X@y.z', timestamp: 't' }), webhookDedupeKey({ event_type: 'email_sent', campaign_id: 'a', lead_email: 'x@y.z', timestamp: 't' }));
  ok('webhook: bad secret 401, duplicate delivery is a no-op, sends/replies/interest/bounces update the member, legacy-campaign events still land on the agency');
  const interpreted = interpretWebhookPayload({ event_type: 'lead_meeting_booked', campaign_id: 'x', lead_email: 'a@b.c', timestamp: iso(T0), email_html: '<b>big</b>' }, { member: { member_id: 'm', emails_sent_count: '2' } });
  assert.equal(interpreted.memberPatch.interest_status, 'MEETING_BOOKED'); assert.ok(interpreted.memberPatch.meeting_booked_at);
  assert.equal(interpreted.event.payload_json.email_html, undefined, 'HTML bodies are dropped from the stored payload');
  ok('meeting booked sets member interest + meeting_booked_at; stored payload is bounded');

  // Sync / reconciliation.
  res = await call('POST', 'campaign-sync', { campaign_id: campaignId });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body)); assert.equal(res.body.synced, 1);
  const sync = res.body.results[0];
  assert.deepEqual(sync.errors, []); assert.equal(sync.status_after, 'ACTIVE');
  assert.equal(sync.events_appended, 1, 'em_1 and em_3 already arrived via webhook (same email id → deduped across sources); only the em_2 send is new');
  res = await call('GET', 'campaign-detail', null, { campaign_id: campaignId });
  assert.equal(res.body.campaign.analytics.emails_sent_count, 3); assert.equal(res.body.campaign.metrics.emails_sent, 3); assert.equal(res.body.campaign.step_analytics.length, 2);
  assert.equal(res.body.campaign.last_synced_at.length > 0, true);
  const kim3 = res.body.members.find((m) => m.agency_id === 'ag_6');
  assert.equal(kim3.emails_sent_count, 2); assert.equal(kim3.instantly_lead_status, 'ACTIVE');
  const syncAgain = await call('POST', 'campaign-sync', {});
  assert.equal(syncAgain.body.results[0].events_appended, 0); assert.equal(syncAgain.body.results[0].events_duplicate, 3);
  ok('sync: status, analytics, step analytics, lead state and send/reply events reconcile from Instantly; a second sync appends nothing');

  // Provider status wins on sync (paused in the Instantly UI).
  instantly.campaigns.get(instantlyId).status = 2;
  res = await call('POST', 'campaign-sync', { campaign_id: campaignId });
  assert.equal(res.body.results[0].status_after, 'PAUSED');
  res = await call('GET', 'campaigns-list', null, { refresh: '1' });
  assert.equal(res.body.campaigns[0].status, 'PAUSED'); assert.equal(res.body.campaigns[0].metrics.replies, 1); assert.equal(res.body.campaigns[0].metrics.emails_sent, 3);
  assert.equal(res.body.counts.by_status.PAUSED, 1);
  ok('a campaign paused inside Instantly is reported PAUSED after sync; the list shows the reconciled metrics');

  // Live detail.
  res = await call('GET', 'campaign-detail', null, { campaign_id: campaignId, live: '1' });
  assert.equal(res.body.instantly.live, true); assert.equal(res.body.instantly.campaign.status_label, 'Paused'); assert.equal(res.body.instantly.accounts[0].email, 'joe@novushq.co.uk');
  res = await call('GET', 'campaign-accounts', null, {});
  assert.equal(res.body.accounts[0].daily_limit, 30);
  ok('live detail and sending accounts come from Instantly on demand');

  // Eligibility engine also protects the second campaign from overlap.
  res = await call('POST', 'campaign-audience', { campaign_type: 'GENERAL', filters: {} });
  const zeta = res.body.rows.find((r) => r.agency_id === 'ag_6');
  assert.equal(zeta.eligibility.status, 'BLOCKED'); assert.ok(zeta.eligibility.blocks.includes('IN_ACTIVE_CAMPAIGN'));
  assert.equal(zeta.campaigns[0].name, 'Enquiry → Quick Call V1');
  ok('a lead in a paused/active campaign is BLOCKED from a new one (IN_ACTIVE_CAMPAIGN)');

  // Timeline.
  res = await call('GET', 'lead-timeline', null, { agency_id: 'ag_6' });
  assert.equal(res.statusCode, 200);
  const types = res.body.entries.map((e) => e.type);
  assert.deepEqual(types, ['PROBE_SENT', 'PROBE_CLOSED', 'HANDED_TO_INSTANTLY', 'LEAD_ADDED', 'LEAD_PUSHED', 'EMAIL_SENT', 'EMAIL_SENT', 'REPLY_RECEIVED', 'LEAD_INTERESTED'], JSON.stringify(types));
  assert.equal(res.body.campaigns[0].member_status, 'PUSHED');
  const t1 = buildLeadTimeline(tablesOf(store), 'ag_1', { now: iso(T0) });
  assert.deepEqual(t1.entries.map((e) => e.type), ['PROBE_SENT', 'PROBE_EMAIL_IN', 'PROBE_CLOSED', 'CALL_OUTBOUND', 'LEAD_ADDED', 'LEAD_PUSHED', 'EMAIL_SENT']);
  assert.match(t1.entries.find((e) => e.type === 'CALL_OUTBOUND').title, /callback requested/);
  ok('lead timeline is one chronological story: probe → agency reply → legacy handoff → campaign → sends → reply → interest, with calls interleaved');

  // The new campaign requires an explicit cohort. A provider member left by a
  // previous partial push is recovered before any lead-add request.
  store.AGENCIES.push(['ag_7', 'Oak Homes', 'Oak Homes', 'London', '1', '', 'Jo Owner', 'Jo Owner', 'jo@oak.test', 'VALID', '', '', '', '020 7000 0000']);
  store.CONTACTS.push(['cnt_7', 'ag_7', 'Jo Owner', 'Owner', 'jo@oak.test', 'OWNER_DIRECT', 'VALID', 'TRUE']);
  store.PROBES[0].push('enquiry_text');
  store.PROBES.push(['pr_7', 'RM-0007', 'ag_7', 'rightmove', '10 High Street, London', '10 High Street', iso(T0 - 8 * DAY), 'closed', 'FALSE', iso(T0 - DAY), iso(T0 - 8 * DAY), 'Declared: has a property to sell, not yet on the market.']);
  res = await call('POST', 'campaign-create', { confirm: 'CREATE_CAMPAIGN', name: PROBE_CALL_CAMPAIGN_NAME, campaign_type: PROBE_CALL_CAMPAIGN_TYPE, sequence: PROBE_CALL_SEQUENCE, sending, filters: {} });
  assert.equal(res.statusCode, 400); assert.match(res.body.error, /explicit agency ID cohort/);
  res = await call('POST', 'campaign-create', { confirm: 'CREATE_CAMPAIGN', confirm_recipient_count: 1, name: PROBE_CALL_CAMPAIGN_NAME, campaign_type: PROBE_CALL_CAMPAIGN_TYPE, sequence: PROBE_CALL_SEQUENCE, sending, filters: { agency_ids: ['ag_7'] } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body)); assert.equal(res.body.summary.READY, 1);
  const probeCampaignId = res.body.campaign_id;
  const remoteProbeCampaign = { id: 'ic_probe', ...buildInstantlyCampaignPayload({ name: PROBE_CALL_CAMPAIGN_NAME, sequence: PROBE_CALL_SEQUENCE, schedule: { name: 'NOVUS working hours', from: '09:00', to: '17:00', timezone: 'Europe/Isle_of_Man', days: { 0: false, 1: true, 2: true, 3: true, 4: true, 5: true, 6: false } }, sending: { email_list: ['joe@novushq.co.uk'], daily_limit: 30, stop_on_reply: true, stop_on_auto_reply: false, open_tracking: true, link_tracking: false, text_only: false } }), status: 0 };
  instantly.campaigns.set('ic_probe', remoteProbeCampaign);
  instantly.leads.set('ic_probe|jo@oak.test', { id: 'lead_recovered', email: 'jo@oak.test', campaign: 'ic_probe', status: 1 });
  const beforeRecovery = instantly.calls.filter((item) => item.path === '/api/v2/leads/add').length;
  remoteProbeCampaign.stop_on_reply = false;
  res = await call('POST', 'campaign-push', { confirm: 'PUSH_TO_INSTANTLY', campaign_id: probeCampaignId });
  assert.equal(res.statusCode, 502); assert.match(res.body.error, /Instantly read-back differs: stop_on_reply/);
  remoteProbeCampaign.stop_on_reply = true;
  res = await call('POST', 'campaign-push', { confirm: 'PUSH_TO_INSTANTLY', campaign_id: probeCampaignId });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body)); assert.equal(res.body.skipped, 1);
  assert.equal(instantly.calls.filter((item) => item.path === '/api/v2/leads/add').length, beforeRecovery);
  res = await call('GET', 'campaign-detail', null, { campaign_id: probeCampaignId });
  assert.equal(res.body.members[0].instantly_lead_id, 'lead_recovered');
  assert.equal(res.body.members[0].member_status, 'PUSHED');
  assert.equal(instantly.activated.includes('ic_probe'), false);
  ok('probe-call campaign requires an explicit cohort, verifies provider draft safety, and recovers existing members without duplicate enrolment or launch');

  globalThis.fetch = realFetch;
  __setRepoForTests(null);
}

// ── 5. historical import: parsers, matching, link idempotency, CSV history,
//       and the suppression/eligibility truth table over imported history ──
{
  // Parsers: quotes, embedded newlines, BOM, Instantly's column names.
  const csv = '﻿id,contact,campaign,status,lt_interest_status,email_reply_count,timestamp_created,timestamp_last_reply,First Name,companyName,demo_url,property_street,email_observation\n'
    + 'l1,Jane@Alpha.co.uk,ic_old,3,1,1,2026-08-30T16:37:58Z,2026-09-02T13:44:00Z,Jane,Alpha Estates,https://demo.getnovus.co.uk/alpha-1,High St,"Line one\nLine ""two"""\n'
    + 'l2,info@beta.co.uk,ic_old,1,,0,2026-08-30T16:38:00Z,,,Beta Homes,,,\n';
  const leads = parseInstantlyLeadsCsv(csv);
  assert.equal(leads.length, 2); assert.equal(leads[0].email, 'jane@alpha.co.uk'); assert.equal(leads[0].status, 3); assert.equal(leads[0].lt_interest_status, 1);
  assert.equal(leads[0].payload.email_observation, 'Line one\nLine "two"'); assert.equal(leads[1].lt_interest_status, null);
  const act = parseInstantlyActivityCsv('Date,Action,Sender Email,Recipient Email,Step,Link Clicked\n2026-09-03T11:30:59.138Z,Email Sent,joe@novushq.co.uk,jane@alpha.co.uk,Step 1,\n2026-09-03T15:10:20.485Z,Reply Received,joe@novushq.co.uk,jane@alpha.co.uk,Step 1,\n2026-09-03T15:32:38Z,Unibox Reply,,jane@alpha.co.uk,,\n2026-09-04T09:00:00Z,Bounce,joe@novushq.co.uk,info@beta.co.uk,Step 1,\n2026-09-05T09:00:00Z,Not interested,,jane@alpha.co.uk,Step 1,\n');
  assert.deepEqual(act.map((e) => e.event_type), ['EMAIL_SENT', 'REPLY_RECEIVED', 'MANUAL_REPLY_SENT', 'EMAIL_BOUNCED', 'LEAD_NOT_INTERESTED']);
  assert.equal(act[0].step, '1'); assert.equal(parseCsv('a,b\n"x,y",2\n')[0].a, 'x,y');
  ok('Instantly leads + activity exports parse (BOM, quotes, embedded newlines, action vocabulary)');

  // Matching order and ambiguity.
  const idx = buildNovusMatchIndex({
    AGENCIES: { header: AG, rows: workbook().AGENCIES.slice(1).concat([['ag_7', 'Zeta Lettings', 'Zeta Lettings', 'Chelmsford', '1', '', '', '', 'lettings@zeta.co.uk', 'VALID', '', '', '', '']]) },
    CONTACTS: { header: CT, rows: workbook().CONTACTS.slice(1) },
    OUTBOUND: { header: OB, rows: workbook().OUTBOUND.slice(1) },
    DEMOS: { header: ['demo_id', 'agency_id', 'probe_id', 'demo_slug'], rows: [['dmo_2', 'ag_2', 'pr_2', 'beta-7']] },
  });
  let m = matchInstantlyLead({ id: 'x', email: 'kim@zeta.co.uk', payload: {} }, idx);
  assert.equal(m.match_status, 'MATCHED'); assert.equal(m.match_method, 'OUTBOUND_EMAIL'); assert.equal(m.agency_id, 'ag_6'); assert.equal(m.outbound_id, 'out_6'); assert.equal(m.contact_id, 'cnt_6');
  m = matchInstantlyLead({ id: 'lead_legacy_6', email: 'kim.chan@other.com', payload: {} }, idx);
  assert.equal(m.match_method, 'OUTBOUND_LEAD_ID'); assert.equal(m.agency_id, 'ag_6');
  m = matchInstantlyLead({ id: 'x', email: 'jane@alpha.co.uk', payload: {} }, idx);
  assert.equal(m.match_method, 'CONTACT_EMAIL'); assert.equal(m.agency_id, 'ag_1');
  m = matchInstantlyLead({ id: 'x', email: 'unknown@nowhere.com', payload: { demo_url: 'https://demo.getnovus.co.uk/beta-7' } }, idx);
  assert.equal(m.match_method, 'DEMO_SLUG'); assert.equal(m.agency_id, 'ag_2');
  m = matchInstantlyLead({ id: 'x', email: 'someone@gamma.co.uk', payload: {} }, idx);
  assert.equal(m.match_status, 'MATCHED'); assert.equal(m.match_method, 'DOMAIN'); assert.equal(m.agency_id, 'ag_3'); assert.match(m.match_note, /review/);
  m = matchInstantlyLead({ id: 'x', email: 'other@zeta.co.uk', payload: {} }, idx);
  assert.equal(m.match_status, 'AMBIGUOUS'); assert.equal(m.match_method, 'DOMAIN'); assert.equal(m.agency_id, ''); assert.deepEqual(m.candidates.map((c) => c.agency_id).sort(), ['ag_6', 'ag_7']);
  m = matchInstantlyLead({ id: 'x', email: 'nobody@example.org', payload: {} }, idx);
  assert.equal(m.match_status, 'UNMATCHED');
  ok('matching: OUTBOUND email → Instantly lead id → CONTACTS → demo slug → unique domain (flagged for review); shared domain is AMBIGUOUS, unknown is UNMATCHED');

  // Link an existing Instantly campaign end to end, twice.
  const { store, repo } = makeStore(workbook());
  // A second agency on zeta.co.uk makes an unknown address at that domain ambiguous.
  store.AGENCIES.push(['ag_7', 'Zeta Lettings', 'Zeta Lettings', 'Chelmsford', '1', '', '', '', 'lettings@zeta.co.uk', 'VALID', '', '', '', '']);
  store.REPLY_EVENTS.push(['rev_6', 'ag_6', 'out_6', 'kim@zeta.co.uk', 'em_old_6r', iso(T0 - 6 * DAY), 'POSITIVE_SEND_DEMO', 'NONE', 'Sounds interesting, send it over', 'SEND_DEMO', 'COMPLETED']);
  __setRepoForTests(repo);
  const { default: handler } = await import('../api/novus/personalisation.js');
  const basic = 'Basic ' + Buffer.from('novus:testpass').toString('base64');
  const response = () => ({ statusCode: 200, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; }, setHeader(k, v) { this.headers[k] = v; } });
  const call = async (method, operation, body, query = {}) => { const res = response(); await handler({ method, query: { novus_operation: operation, ...query }, headers: { authorization: basic }, body }, res); return res; };
  const OLD = '77ccd627-0000-4000-8000-000000000001';
  const oldLeads = [
    { id: 'L6', email: 'kim@zeta.co.uk', campaign: OLD, status: 3, lt_interest_status: 1, email_reply_count: 1, timestamp_created: iso(T0 - 20 * DAY), timestamp_last_reply: iso(T0 - 6 * DAY), payload: { property_street: '7 Elm Ave' } },
    { id: 'L1', email: 'jane@alpha.co.uk', campaign: OLD, status: 1, lt_interest_status: null, email_reply_count: 0, timestamp_created: iso(T0 - 20 * DAY), payload: {} },
    { id: 'L2', email: 'info@beta.co.uk', campaign: OLD, status: -1, lt_interest_status: null, email_reply_count: 0, timestamp_created: iso(T0 - 20 * DAY), timestamp_updated: iso(T0 - 4 * DAY), payload: {} },
    { id: 'L3', email: 'sam@gamma.co.uk', campaign: OLD, status: 3, lt_interest_status: -1, email_reply_count: 1, timestamp_created: iso(T0 - 20 * DAY), timestamp_last_reply: iso(T0 - 5 * DAY), payload: {} },
    { id: 'L4', email: 'pat@delta.co.uk', campaign: OLD, status: 3, lt_interest_status: null, email_reply_count: 0, timestamp_created: iso(T0 - 20 * DAY), payload: {} },
    { id: 'L8', email: 'owner@unknownagency.co.uk', campaign: OLD, status: 1, lt_interest_status: null, email_reply_count: 0, timestamp_created: iso(T0 - 20 * DAY), payload: { demo_url: '' } },
    { id: 'L9', email: 'ops@zeta.co.uk', campaign: OLD, status: -2, lt_interest_status: null, email_reply_count: 0, timestamp_created: iso(T0 - 20 * DAY), timestamp_updated: iso(T0 - 8 * DAY), payload: {} },
  ];
  const sends = (email, n, firstDaysAgo) => Array.from({ length: n }, (_, i) => ({ id: `em_${email.split('@')[0]}_${i + 1}`, ue_type: 1, campaign_id: OLD, lead: email, eaccount: 'joe@novushq.co.uk', from_address_email: 'joe@novushq.co.uk', to_address_email_list: email, subject: `Step ${i + 1}`, timestamp_created: iso(T0 - (firstDaysAgo - i * 3) * DAY), step: i + 1 }));
  const oldEmails = [
    ...sends('kim@zeta.co.uk', 2, 12), { id: 'em_old_6r', ue_type: 2, campaign_id: OLD, lead: 'kim@zeta.co.uk', eaccount: 'joe@novushq.co.uk', from_address_email: 'kim@zeta.co.uk', to_address_email_list: 'joe@novushq.co.uk', subject: 'Re: Step 2', body: { text: 'Sounds interesting, send it over' }, timestamp_created: iso(T0 - 6 * DAY) },
    ...sends('jane@alpha.co.uk', 1, 3),
    ...sends('info@beta.co.uk', 1, 5),
    ...sends('sam@gamma.co.uk', 3, 14), { id: 'em_old_3r', ue_type: 2, campaign_id: OLD, lead: 'sam@gamma.co.uk', eaccount: 'joe@novushq.co.uk', from_address_email: 'sam@gamma.co.uk', to_address_email_list: 'joe@novushq.co.uk', subject: 'Re', body: { text: 'No thanks' }, timestamp_created: iso(T0 - 5 * DAY) },
    ...sends('pat@delta.co.uk', 4, 25),
    ...sends('ops@zeta.co.uk', 1, 9),
  ];
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url); const body = init.body ? JSON.parse(init.body) : null; calls.push({ path: u.pathname, method: init.method });
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
    if (init.method === 'GET' && u.pathname === '/api/v2/campaigns') return json({ items: [{ id: OLD, name: 'NOVUS - Estate Agents - Aug 2026', status: 2, timestamp_created: iso(T0 - 21 * DAY), email_list: ['joe@novushq.co.uk'], daily_limit: 40 }], next_starting_after: null });
    if (u.pathname === `/api/v2/campaigns/${OLD}`) return json({ id: OLD, name: 'NOVUS - Estate Agents - Aug 2026', status: 2, timestamp_created: iso(T0 - 21 * DAY), email_list: ['joe@novushq.co.uk', 'joe@trynovus.co.uk'], daily_limit: 40, stop_on_reply: true, open_tracking: true, campaign_schedule: { schedules: [{ name: 'Old', timing: { from: '08:30', to: '17:30' }, days: { 0: false, 1: true, 2: true, 3: true, 4: true, 5: true, 6: false }, timezone: 'Europe/Isle_of_Man' }] }, sequences: [{ steps: [{ delay: 2, variants: [{ subject: 'Your enquiry', body: 'Hi {{firstName}}<br/><br/>Line' }] }, { delay: 3, variants: [{ subject: 'Re: Your enquiry', body: 'Bump' }] }, { delay: 0, variants: [{ subject: 'Last', body: 'Bye' }] }] }] });
    if (u.pathname.match(/\/campaigns\/[^/]+\/(activate|pause)$/)) throw new Error(`LINK MUST NEVER ${u.pathname}`);
    if (u.pathname === '/api/v2/leads/add') throw new Error('LINK MUST NEVER ADD LEADS');
    if (u.pathname === '/api/v2/leads/list') return json({ items: body.campaign === OLD ? oldLeads : [], next_starting_after: null });
    if (u.pathname === '/api/v2/emails') return json({ items: u.searchParams.get('campaign_id') === OLD ? oldEmails : [], next_starting_after: null });
    if (u.pathname === '/api/v2/campaigns/analytics') return json([{ campaign_id: u.searchParams.get('id'), leads_count: 7, contacted_count: 6, emails_sent_count: 12, reply_count: 2, reply_count_unique: 2, bounced_count: 1, unsubscribed_count: 1, open_count_unique: 3, completed_count: 3 }]);
    if (u.pathname === '/api/v2/campaigns/analytics/steps') return json([]);
    return json({ statusCode: 404, error: 'Not Found', message: u.pathname }, 404);
  };
  await call('POST', 'campaign-setup', { confirm: 'SETUP_CAMPAIGN_TABS' });
  let res = await call('GET', 'campaign-discover');
  assert.equal(res.statusCode, 200); assert.equal(res.body.campaigns[0].instantly_campaign_id, OLD); assert.equal(res.body.campaigns[0].linked, false); assert.equal(res.body.campaigns[0].status_label, 'Paused');
  ok('discover lists the pre-existing Instantly campaign as not linked');
  res = await call('POST', 'campaign-link', { instantly_campaign_id: OLD });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body)); assert.equal(res.body.dry_run, true); assert.equal(res.body.leads_in_instantly, 7); assert.equal(res.body.members_to_add, 7);
  assert.deepEqual(res.body.matches, { MATCHED: 5, AMBIGUOUS: 1, UNMATCHED: 1, DOMAIN: 0 });
  assert.equal(res.body.config.sequence.steps.length, 3); assert.deepEqual(res.body.config.sequence.steps.map((st) => st.delay_days), [0, 2, 3]); assert.equal(res.body.config.sequence.steps[0].variants[0].body, 'Hi {{firstName}}\n\nLine');
  assert.equal(store.CAMPAIGNS.length, 2, 'dry run wrote nothing');
  ok('link dry-run: plan with match counts, review list and the Instantly configuration; nothing written');
  res = await call('POST', 'campaign-link', { instantly_campaign_id: OLD, dry_run: false });
  assert.equal(res.statusCode, 400);
  res = await call('POST', 'campaign-link', { instantly_campaign_id: OLD, dry_run: false, confirm: 'LINK_INSTANTLY_CAMPAIGN' });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body)); assert.equal(res.body.already_linked, false); assert.equal(res.body.novus_status, 'PAUSED');
  const oldCampaignId = res.body.campaign_id;
  assert.deepEqual(res.body.sync.errors, []); assert.equal(res.body.sync.events_appended, 14, '12 sends + 2 replies');
  assert.ok(!calls.some((c) => /activate|pause|leads\/add/.test(c.path)), 'Instantly was only read');
  res = await call('GET', 'campaign-detail', null, { campaign_id: oldCampaignId });
  assert.equal(res.body.campaign.source, 'IMPORTED'); assert.equal(res.body.campaign.status, 'PAUSED'); assert.equal(res.body.members.length, 7);
  const kimOld = res.body.members.find((x) => x.email === 'kim@zeta.co.uk');
  assert.equal(kimOld.member_status, 'PUSHED'); assert.equal(kimOld.instantly_lead_id, 'L6'); assert.equal(kimOld.instantly_lead_status, 'COMPLETED'); assert.equal(kimOld.interest_status, 'INTERESTED'); assert.equal(kimOld.emails_sent_count, 2); assert.equal(kimOld.agency_id, 'ag_6'); assert.equal(kimOld.match_method, 'OUTBOUND_EMAIL'); assert.equal(kimOld.eligibility_status, '', 'NOVUS made no eligibility decision for an imported member');
  assert.equal(res.body.members.find((x) => x.email === 'ops@zeta.co.uk').match_status, 'AMBIGUOUS');
  assert.equal(res.body.members.find((x) => x.email === 'owner@unknownagency.co.uk').match_status, 'UNMATCHED');
  assert.equal(res.body.members.find((x) => x.email === 'info@beta.co.uk').instantly_lead_status, 'BOUNCED');
  assert.equal(res.body.campaign.metrics.emails_sent, 12); assert.equal(res.body.campaign.metrics.leads, 7);
  ok('link: CAMPAIGNS row mirrors Instantly (PAUSED, IMPORTED), 7 members with lead ids/states, 12 real sends + 2 replies from /emails; nothing activated or re-added');
  const before = { c: store.CAMPAIGNS.length, m: store.CAMPAIGN_MEMBERS.length, e: store.CAMPAIGN_EVENTS.length };
  res = await call('POST', 'campaign-link', { instantly_campaign_id: OLD, dry_run: false, confirm: 'LINK_INSTANTLY_CAMPAIGN' });
  assert.equal(res.statusCode, 200); assert.equal(res.body.already_linked, true); assert.equal(res.body.campaign_id, oldCampaignId); assert.equal(res.body.members_to_add, 0); assert.equal(res.body.sync.events_appended, 0);
  assert.deepEqual({ c: store.CAMPAIGNS.length, m: store.CAMPAIGN_MEMBERS.length, e: store.CAMPAIGN_EVENTS.length }, before);
  ok('linking the same campaign twice adds no campaign, member or event');

  // Activity CSV after the API: same sends/replies under different keys must not duplicate; new facts (bounce date, interest, manual replies) are added.
  const csvActivity = 'Date,Action,Sender Email,Recipient Email,Step,Link Clicked\n'
    + oldEmails.filter((e) => e.ue_type === 1).map((e) => `${new Date(Date.parse(e.timestamp_created) + 400).toISOString()},Email Sent,${e.eaccount},${e.lead},Step ${e.step},`).join('\n') + '\n'
    + `${iso(T0 - 6 * DAY + 500)},Reply Received,joe@novushq.co.uk,kim@zeta.co.uk,Step 2,\n`
    + `${iso(T0 - 6 * DAY + 3600000)},Interested,,kim@zeta.co.uk,Step 2,\n`
    + `${iso(T0 - 6 * DAY + 7200000)},Unibox Reply,,kim@zeta.co.uk,,\n`
    + `${iso(T0 - 5 * DAY + 100)},Reply Received,joe@novushq.co.uk,sam@gamma.co.uk,Step 3,\n`
    + `${iso(T0 - 5 * DAY + 60000)},Not interested,,sam@gamma.co.uk,Step 3,\n`
    + `${iso(T0 - 4 * DAY)},Bounce,joe@novushq.co.uk,info@beta.co.uk,Step 1,\n`
    + `${iso(T0 - 8 * DAY)},Unsubscribe,,ops@zeta.co.uk,Step 1,\n`;
  res = await call('POST', 'campaign-import-activity', { campaign_id: oldCampaignId, activity_csv: csvActivity });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body)); assert.equal(res.body.dry_run, true); assert.equal(res.body.activity_rows, 19); assert.equal(res.body.events_duplicate, 14); assert.equal(res.body.events_to_append, 5);
  ok('activity CSV dry-run: the 12 sends + 2 replies already on the ledger are recognised as the same moments (±90s); 5 new facts would be added');
  res = await call('POST', 'campaign-import-activity', { campaign_id: oldCampaignId, activity_csv: csvActivity, dry_run: false, confirm: 'IMPORT_CAMPAIGN_ACTIVITY' });
  assert.equal(res.statusCode, 200); assert.equal(res.body.events_to_append, 5);
  const again = await call('POST', 'campaign-import-activity', { campaign_id: oldCampaignId, activity_csv: csvActivity, dry_run: false, confirm: 'IMPORT_CAMPAIGN_ACTIVITY' });
  assert.equal(again.body.events_to_append, 0); assert.equal(again.body.events_duplicate, 19);
  res = await call('GET', 'campaign-detail', null, { campaign_id: oldCampaignId });
  const beta = res.body.members.find((x) => x.email === 'info@beta.co.uk'); assert.equal(beta.bounced_at, iso(T0 - 4 * DAY));
  const ops = res.body.members.find((x) => x.email === 'ops@zeta.co.uk'); assert.ok(ops.unsubscribed_at);
  assert.equal(res.body.members.find((x) => x.email === 'kim@zeta.co.uk').emails_sent_count, 2, 'send count unchanged by the CSV copy of the same sends');
  const kimEvents = res.body.events.filter((e) => e.lead_email === 'kim@zeta.co.uk').map((e) => e.event_type).sort();
  assert.deepEqual(kimEvents, ['EMAIL_SENT', 'EMAIL_SENT', 'LEAD_IMPORTED', 'LEAD_INTERESTED', 'MANUAL_REPLY_SENT', 'REPLY_RECEIVED']);
  ok('activity CSV import is idempotent and keeps real timestamps: bounce/unsubscribe dates land on members, sends are not double counted');

  // Reconciliation report.
  res = await call('GET', 'campaign-reconciliation', null, { campaign_id: oldCampaignId });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const R = Object.fromEntries(res.body.rows.map((r) => [r.email, r]));
  assert.deepEqual(R['kim@zeta.co.uk'].steps_sent, [1, 2]); assert.equal(R['kim@zeta.co.uk'].positive, true); assert.equal(R['kim@zeta.co.uk'].manual_replies_sent, 1); assert.equal(R['kim@zeta.co.uk'].sequence_completed, true); assert.equal(R['kim@zeta.co.uk'].manual_conversation, true, 'NOVUS stage (demo sent) shows alongside Instantly history');
  assert.equal(R['pat@delta.co.uk'].emails_sent, 4); assert.deepEqual(R['pat@delta.co.uk'].steps_sent, [1, 2, 3, 4]); assert.equal(R['pat@delta.co.uk'].novus_stage, 'MEETING_BOOKED');
  assert.equal(R['sam@gamma.co.uk'].negative, true); assert.equal(R['info@beta.co.uk'].bounced, true); assert.equal(R['ops@zeta.co.uk'].unsubscribed, true);
  assert.equal(res.body.summary.matched, 5); assert.equal(res.body.summary.ambiguous, 1); assert.equal(res.body.summary.unmatched, 1); assert.equal(res.body.summary.emails_sent_total, 12); assert.equal(res.body.review.length, 2);
  assert.ok(res.body.summary.first_send_at < res.body.summary.last_send_at);
  ok('reconciliation report: per-lead sends/steps/dates/replies/positive/negative/bounce/unsubscribe/interest + NOVUS stage, with the match audit');

  // THE TRUTH TABLE: eligibility for a new ENQUIRY_FOLLOWUP campaign over the imported history + NOVUS history.
  store.CALLS.push(['cal_2', 'ag_1', iso(T0 - DAY), 'BOOKED_MEETING', iso(T0 - DAY), 'TRUE', 'completed', 'Jane Smith', '{}', iso(T0 - DAY)]);
  store.ACTIONS.push(ACTIONS_HEADER.map((k) => ({ action_id: 'act_meet', agency_id: 'ag_1', action_type: 'PREPARE_MEETING', action_owner: 'JOE', action_status: 'PENDING', due_at: iso(T0 + DAY), reason: 'meeting booked on call', dedupe_key: 'k1', created_at: iso(T0 - DAY), updated_at: iso(T0 - DAY) }[k] ?? '')));
  store.AGENCIES.push(['ag_8', 'Eta Sales', 'Eta Sales', 'Harlow', '1', 'Alto', 'Nat Eta', 'Nat Eta', 'nat@eta.co.uk', 'VALID', '', '', '', '']);
  store.PROBES.push(['pr_8', 'RM-0008', 'ag_8', 'rightmove', '2 Oak Rd', '2 Oak Rd', iso(T0 - 30 * DAY), 'closed', 'FALSE', iso(T0 - 23 * DAY), iso(T0 - 30 * DAY)]);
  store.PERSONALISATION.push(['pr_8', 'ag_8', 'obs', 'hook', iso(T0 - 20 * DAY)], ['pr_4', 'ag_4', 'obs', 'hook', iso(T0 - 20 * DAY)]);
  store.AGENCIES.push(['ag_9', 'Theta Homes', 'Theta Homes', 'Harlow', '1', '', '', 'Dee Theta', 'dee@theta.co.uk', 'VALID', '', '', '', '']);
  res = await call('POST', 'campaign-audience', { campaign_type: 'ENQUIRY_FOLLOWUP', filters: { verification: ['VALID', 'RISKY'], email_exists: false, include_opted_out: true, include_bounced: true, probe_not_compromised: false }, policy: { cooling_days: 14, allow_risky_email: true } });
  assert.equal(res.statusCode, 200);
  const A = Object.fromEntries(res.body.rows.map((r) => [r.agency_id, r]));
  const expect = (id, status, code, why) => { assert.equal(A[id].eligibility.status, status, `${id} (${why}): ${JSON.stringify(A[id].eligibility)}`); if (code) assert.ok([...A[id].eligibility.blocks, ...A[id].eligibility.warnings, ...A[id].eligibility.reasons].includes(code), `${id} expected ${code}: ${JSON.stringify(A[id].eligibility)}`); };
  expect('ag_8', 'READY', 'NO_PRIOR_OUTREACH', 'never sent, probe complete, VALID');
  expect('ag_1', 'BLOCKED', 'ACTIVE_FOLLOWUP', 'email 1 three days ago AND meeting booked on a call yesterday (NOVUS-only fact)');
  assert.equal(A.ag_1.eligibility.facts, undefined); assert.deepEqual([A.ag_1.prior.email_count, A.ag_1.prior.last_emailed_days], [1, 3], 'recent send is visible even though a stronger block applies: ' + JSON.stringify(A.ag_1.prior));
  expect('ag_4', 'BLOCKED', 'MEETING_BOOKED', 'four emails + completed sequence, NOVUS meeting booked');
  assert.equal(A.ag_4.prior.email_count, 4);
  expect('ag_6', 'BLOCKED', 'ACTIVE_CONVERSATION', 'positive reply, demo sent, Instantly interested — completed old sequence is not a fresh lead');
  assert.ok(A.ag_6.campaigns.some((c) => c.instantly_lead_status === 'COMPLETED'));
  expect('ag_3', 'BLOCKED', 'NEGATIVE_REPLY', 'replied not interested (Instantly) after 3 sends');
  expect('ag_2', 'BLOCKED', 'HARD_BOUNCE', 'bounced in the old campaign');
  expect('ag_5', 'BLOCKED', 'NO_EMAIL', 'probe exists but no usable email');
  expect('ag_9', 'BLOCKED', 'MISSING_PROBE', 'VALID email but never probed');
  assert.equal(res.body.unlinked_members.count, 2); assert.equal(res.body.unlinked_members.ambiguous, 1);
  assert.ok(res.body.unlinked_members.rows.some((r) => r.email === 'ops@zeta.co.uk' && r.instantly_lead_status === 'UNSUBSCRIBED'), 'the unsubscribed Instantly-only lead is surfaced rather than lost');
  const b = res.body.buckets.selected;
  assert.equal(b.eligible_agencies, 1); assert.equal(b.clean_untouched, 1); assert.equal(b.previously_emailed, 5); assert.equal(b.recently_contacted, 4); assert.equal(b.meeting_booked, 2); assert.equal(b.missing_probe, 3, "ag_5, ag_7, ag_9 never probed"); assert.equal(b.missing_email, 1); assert.equal(b.invalid_or_bounced, 1);
  ok('truth table over imported + NOVUS history: never-sent READY; recent send, many sends, completed sequence, positive reply, demo, NOVUS-booked meeting, negative reply, bounce, no probe, no email all decided correctly; buckets and unlinked leads reported');

  const later = buildCampaignAudience(tablesOf(store), tablesOf(store), { filters: { agency_ids: ['ag_1'] }, policy: { block_active_followup: false, block_meeting_booked: false, block_active_campaign: false }, campaign: { campaign_type: 'ENQUIRY_FOLLOWUP', campaign_id: 'cmp_new' }, now: iso(T0) });
  assert.equal(later.rows[0].eligibility.status, 'WARNING', JSON.stringify(later.rows[0].eligibility)); assert.ok(later.rows[0].eligibility.warnings.includes('RECENTLY_EMAILED') && later.rows[0].eligibility.warnings.includes('LAST_EMAIL_3_DAYS_AGO') && later.rows[0].eligibility.warnings.includes('IN_ACTIVE_CAMPAIGN'));
  const cooled = buildCampaignAudience(tablesOf(store), tablesOf(store), { filters: { agency_ids: ['ag_4'] }, policy: { block_meeting_booked: false }, campaign: { campaign_type: 'ENQUIRY_FOLLOWUP', campaign_id: 'cmp_new' }, now: iso(T0) });
  assert.equal(cooled.rows[0].eligibility.status, 'READY', JSON.stringify(cooled.rows[0].eligibility)); assert.ok(cooled.rows[0].eligibility.reasons.includes('PRIOR_SEQUENCE_COMPLETED')); assert.ok(!cooled.rows[0].eligibility.reasons.includes('NO_PRIOR_OUTREACH'));
  assert.ok(!cooled.rows[0].eligibility.blocks.includes('IN_ACTIVE_CAMPAIGN'), 'a COMPLETED lead in a paused campaign is not a sending conflict');
  const conflict = buildCampaignAudience(tablesOf(store), tablesOf(store), { filters: { agency_ids: ['ag_1'] }, policy: { block_active_followup: false, block_meeting_booked: false }, campaign: { campaign_type: 'ENQUIRY_FOLLOWUP', campaign_id: 'cmp_new' }, now: iso(T0) });
  assert.ok(conflict.rows[0].eligibility.blocks.includes('IN_ACTIVE_CAMPAIGN'), 'an ACTIVE lead in the paused old campaign could still be mailed → conflict');
  ok('cooling warning carries the day count; a completed old sequence outside cooling is READY but flagged PRIOR_SEQUENCE_COMPLETED; an unfinished lead in a paused campaign is a conflict');

  res = await call('GET', 'lead-timeline', null, { agency_id: 'ag_6' });
  const tl = res.body.entries.map((e) => e.type);
  assert.equal(tl.filter((t) => t === 'REPLY_RECEIVED').length, 1, `one reply, not two: ${tl}`);
  assert.equal(tl.filter((t) => t === 'EMAIL_SENT').length, 2);
  assert.deepEqual(tl, ['PROBE_SENT', 'PROBE_CLOSED', 'HANDED_TO_INSTANTLY', 'LEAD_IMPORTED', 'EMAIL_SENT', 'EMAIL_SENT', 'REPLY_RECEIVED', 'LEAD_INTERESTED', 'MANUAL_REPLY_SENT'], JSON.stringify(tl));
  const kimSend = res.body.entries.find((e) => e.type === 'EMAIL_SENT'); assert.equal(kimSend.at, iso(T0 - 12 * DAY), 'real send timestamp, not the import time');
  ok('agency timeline: probe → handoff → imported sends → reply (classified REPLY_EVENTS row wins over the imported copy) → interest → manual reply, in real time order');

  oldLeads.push({ id: 'L10', email: 'dee@theta.co.uk', campaign: OLD, status: 1, lt_interest_status: null, email_reply_count: 0, timestamp_created: iso(T0), payload: {} });
  oldEmails.push(...sends('dee@theta.co.uk', 1, 0));
  const hook = async (payload) => { const r = response(); await handler({ method: 'POST', query: { novus_operation: 'instantly-webhook' }, headers: { 'x-novus-instantly-secret': 'whsec' }, body: payload }, r); return r; };
  res = await hook({ event_type: 'email_sent', campaign_id: OLD, lead_email: 'dee@theta.co.uk', timestamp: iso(T0 + 200), email_id: 'em_dee_1', step: 1 });
  assert.equal(res.body.duplicate, false); assert.equal(res.body.member_id, '', 'no member yet — event still stored');
  res = await call('POST', 'campaign-sync', { campaign_id: oldCampaignId });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body)); assert.equal(res.body.results[0].members_imported, 1); assert.equal(res.body.results[0].events_appended, 0, 'the webhook copy of the same send is recognised');
  res = await call('GET', 'campaign-detail', null, { campaign_id: oldCampaignId });
  const dee = res.body.members.find((x) => x.email === 'dee@theta.co.uk'); assert.equal(dee.agency_id, 'ag_9'); assert.equal(dee.member_status, 'PUSHED'); assert.equal(dee.emails_sent_count, 1);
  ok('ongoing sync imports a lead added inside Instantly, matches it to NOVUS, and does not double count a send already delivered by webhook');

  globalThis.fetch = realFetch;
  __setRepoForTests(null);
}

// ── 6. automated poll (Growth plan, no webhooks): auth gating, reentrancy,
//       per-campaign cooldown, incremental /emails cursor, and the full
//       create → push → launch → poll → pause lifecycle with the webhook
//       secret UNSET throughout, proving nothing needs it to operate ──────
{
  const MIN = 60_000;
  delete process.env.INSTANTLY_WEBHOOK_SECRET; // the whole block runs with webhooks off
  delete process.env.NOVUS_CAMPAIGN_POLLER_SECRET;
  const { store, repo } = makeStore(workbook());
  __setRepoForTests(repo);
  const { default: handler } = await import('../api/novus/personalisation.js');
  const basic = 'Basic ' + Buffer.from('novus:testpass').toString('base64');
  const response = () => ({ statusCode: 200, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; }, setHeader(k, v) { this.headers[k] = v; } });
  const call = async (method, operation, body, query = {}, headers = {}) => { const res = response(); await handler({ method, query: { novus_operation: operation, ...query }, headers: { authorization: basic, ...headers }, body }, res); return res; };
  const callRaw = async (req) => { const res = response(); await handler(req, res); return res; };

  // ── auth gating: two layers, exactly like the reply poller ──────────────
  let res = await call('POST', 'campaign-sync-poll', {});
  assert.equal(res.statusCode, 500); assert.match(res.body.error, /NOVUS_CAMPAIGN_POLLER_SECRET is not set/);
  ok('campaign-sync-poll refuses to run with no poller secret configured (fails closed, never touches Instantly or Sheets)');
  process.env.NOVUS_CAMPAIGN_POLLER_SECRET = 'pollsecret';
  res = await call('POST', 'campaign-sync-poll', {}, {}, { 'x-novus-campaign-poller-secret': 'wrong' });
  assert.equal(res.statusCode, 403);
  res = await callRaw({ method: 'POST', query: { novus_operation: 'campaign-sync-poll' }, headers: { 'x-novus-campaign-poller-secret': 'pollsecret' } });
  assert.equal(res.statusCode, 401, 'Basic Auth is still required even with a correct poller secret');
  res = await call('POST', 'campaign-sync-poll', {}, {}, { 'x-novus-campaign-poller-secret': 'pollsecret' });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body)); assert.equal(res.body.success, true); assert.equal(res.body.synced, 0); assert.equal(res.body.skipped, 0);
  ok('wrong secret is 403, missing Basic Auth is still 401, and the correct secret + Basic Auth runs (no campaigns pushed yet, so nothing to sync)');

  // ── fake Instantly: create/activate/pause/leads/emails, with /emails
  //    actually honouring min_timestamp_created so the incremental window
  //    is proven, not assumed ──────────────────────────────────────────────
  const instantly = { campaigns: new Map(), leads: new Map() };
  const emails = [];
  const apiCalls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url); const body = init.body ? JSON.parse(init.body) : null;
    apiCalls.push({ path: u.pathname, method: init.method, query: Object.fromEntries(u.searchParams) });
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
    if (init.method === 'POST' && u.pathname === '/api/v2/campaigns') { const id = `poll_ic_${instantly.campaigns.size + 1}`; const c = { ...body, id, status: 0 }; instantly.campaigns.set(id, c); return json(c); }
    const m = u.pathname.match(/^\/api\/v2\/campaigns\/([^/]+)(\/activate|\/pause)?$/);
    if (m && m[1] !== 'analytics') {
      const c = instantly.campaigns.get(m[1]); if (!c) return json({ statusCode: 404, error: 'Not Found', message: 'no campaign' }, 404);
      if (m[2] === '/activate') { c.status = 1; return json(c); }
      if (m[2] === '/pause') { c.status = 2; return json(c); }
      return json(c);
    }
    if (u.pathname === '/api/v2/leads/add') {
      const created = [];
      body.leads.forEach((lead, index) => { const key = `${body.campaign_id}|${lead.email}`; if (instantly.leads.has(key)) return; const id = `poll_lead_${instantly.leads.size + 1}`; instantly.leads.set(key, { id, email: lead.email, campaign: body.campaign_id, status: 1, lt_interest_status: null, email_reply_count: 0 }); created.push({ index, id, email: lead.email }); });
      return json({ status: 'success', total_sent: body.leads.length, leads_uploaded: created.length, duplicated_leads: 0, in_blocklist: 0, skipped_count: 0, invalid_email_count: 0, created_leads: created });
    }
    if (u.pathname === '/api/v2/leads/list') return json({ items: [...instantly.leads.values()].filter((l) => l.campaign === body.campaign), next_starting_after: null });
    if (u.pathname === '/api/v2/campaigns/analytics') return json([{ campaign_id: u.searchParams.get('id'), leads_count: 1, contacted_count: 1, emails_sent_count: emails.length, reply_count: 0, reply_count_unique: 0, bounced_count: 0, unsubscribed_count: 0, open_count_unique: 0, completed_count: 0 }]);
    if (u.pathname === '/api/v2/campaigns/analytics/steps') return json([]);
    if (u.pathname === '/api/v2/emails') {
      const cid = u.searchParams.get('campaign_id');
      const since = u.searchParams.get('min_timestamp_created');
      const sinceMs = since ? Date.parse(since) : null;
      const items = emails.filter((e) => e.campaign_id === cid && (sinceMs === null || Date.parse(e.timestamp_created) >= sinceMs));
      return json({ items, next_starting_after: null });
    }
    return json({ statusCode: 404, error: 'Not Found', message: u.pathname }, 404);
  };

  // ag_1 (Jane Smith, jane@alpha.co.uk) is a clean, never-contacted, closed-
  // probe, personalised, VALID-email agency — the same one section 2 proves
  // reads READY for a fresh ENQUIRY_FOLLOWUP campaign.
  res = await call('POST', 'campaign-create', { confirm: 'CREATE_CAMPAIGN', confirm_recipient_count: 1, name: 'Growth Plan Poll Test', campaign_type: 'ENQUIRY_FOLLOWUP', sequence: { steps: [{ subject: 'Hi {{firstName}}', body: 'Hello' }] }, sending: { email_list: ['joe@novushq.co.uk'] }, filters: { agency_ids: ['ag_1'] } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body)); assert.equal(res.body.summary.READY, 1);
  const campaignId = res.body.campaign_id;
  res = await call('POST', 'campaign-push', { confirm: 'PUSH_TO_INSTANTLY', campaign_id: campaignId });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body)); assert.equal(res.body.pushed, 1);
  const instantlyId = res.body.instantly_campaign_id;
  res = await call('POST', 'campaign-launch', { confirm: 'LAUNCH_CAMPAIGN', campaign_id: campaignId, acknowledge: true });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body)); assert.equal(res.body.status, 'ACTIVE');
  ok('create → push → launch works exactly as before, with INSTANTLY_WEBHOOK_SECRET unset the whole time');

  // ── poll #1: first sync after launch, no cursor yet → full sweep ────────
  emails.push({ id: 'poll_em_1', ue_type: 1, campaign_id: instantlyId, lead: 'jane@alpha.co.uk', eaccount: 'joe@novushq.co.uk', from_address_email: 'joe@novushq.co.uk', to_address_email_list: 'jane@alpha.co.uk', subject: 'Hi Jane', timestamp_created: iso(T0 - 5 * MIN), step: 1 });
  res = await call('POST', 'campaign-sync-poll', {}, {}, { 'x-novus-campaign-poller-secret': 'pollsecret' });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body)); assert.equal(res.body.synced, 1); assert.equal(res.body.skipped, 0);
  assert.equal(res.body.results[0].mode, 'poll'); assert.equal(res.body.results[0].events_appended, 1); assert.equal(res.body.results[0].status_after, 'ACTIVE');
  const firstEmailsCall = apiCalls.filter((c) => c.path === '/api/v2/emails').at(-1);
  assert.equal(firstEmailsCall.query.min_timestamp_created, undefined, 'no stored cursor yet, so the first poll sweeps in full');
  res = await call('GET', 'campaign-detail', null, { campaign_id: campaignId });
  assert.equal(res.body.members[0].emails_sent_count, 1); assert.ok(res.body.campaign.emails_synced_through, 'the cursor is now set for next time');
  const cursorAfterFirstPoll = res.body.campaign.emails_synced_through;
  ok('poll #1 reconciles status/leads/analytics and does a full /emails sweep (no cursor to trust yet), then stores emails_synced_through');

  // ── poll #2, immediately: the durable per-campaign cooldown skips it ────
  const apiCallsBeforeSecondPoll = apiCalls.length;
  res = await call('POST', 'campaign-sync-poll', {}, {}, { 'x-novus-campaign-poller-secret': 'pollsecret' });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body)); assert.equal(res.body.synced, 0); assert.equal(res.body.skipped, 1);
  assert.equal(res.body.skipped_campaigns[0].skipped, 'synced_recently');
  assert.equal(apiCalls.length, apiCallsBeforeSecondPoll, 'a campaign inside its cooldown makes zero further Instantly calls');
  ok('an immediate second poll makes no Instantly calls at all — the cooldown is read from CAMPAIGNS.last_synced_at, not an in-memory timer');

  // ── reentrancy: two concurrent poll requests, only one actually runs ────
  const [pollA, pollB] = await Promise.all([
    call('POST', 'campaign-sync-poll', {}, {}, { 'x-novus-campaign-poller-secret': 'pollsecret' }),
    call('POST', 'campaign-sync-poll', {}, {}, { 'x-novus-campaign-poller-secret': 'pollsecret' }),
  ]);
  const outcomes = [pollA.body, pollB.body];
  assert.equal(outcomes.filter((o) => o.skipped === true).length, 1, 'exactly one of the two concurrent calls is turned away as already running');
  assert.ok(outcomes.some((o) => o.reason === 'a campaign sync poll is already running in this instance'));
  ok('two poll requests fired at once: the second is refused immediately by the in-process reentrancy guard, not run twice in parallel');

  // ── manual Sync Now ignores the cooldown, and picks up a NEW email ──────
  emails.push({ id: 'poll_em_2', ue_type: 1, campaign_id: instantlyId, lead: 'jane@alpha.co.uk', eaccount: 'joe@novushq.co.uk', from_address_email: 'joe@novushq.co.uk', to_address_email_list: 'jane@alpha.co.uk', subject: 'Follow-up', timestamp_created: iso(T0 - MIN), step: 1 });
  res = await call('POST', 'campaign-sync', { campaign_id: campaignId });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body)); assert.equal(res.body.results[0].events_appended, 1); assert.equal(res.body.results[0].events_duplicate, 1, 'the first email is recognised, not re-added');
  assert.equal(res.body.results[0].mode, 'full');
  const manualEmailsCall = apiCalls.filter((c) => c.path === '/api/v2/emails').at(-1);
  assert.equal(manualEmailsCall.query.min_timestamp_created, undefined, 'Sync Now always does the full correctness-first sweep, cooldown or no cooldown');
  ok('the manual Sync Now button bypasses the poll cooldown entirely and always sweeps in full');

  // ── a genuinely incremental pass narrows the /emails window ─────────────
  emails.push({ id: 'poll_em_3', ue_type: 1, campaign_id: instantlyId, lead: 'jane@alpha.co.uk', eaccount: 'joe@novushq.co.uk', from_address_email: 'joe@novushq.co.uk', to_address_email_list: 'jane@alpha.co.uk', subject: 'Third', timestamp_created: iso(T0 + MIN), step: 1 });
  const cursorBeforeIncrementalPoll = (await call('GET', 'campaign-detail', null, { campaign_id: campaignId })).body.campaign.emails_synced_through;
  const pollClient = createInstantlyClient({ apiKey: 'sk_write_poll', fetchImpl: globalThis.fetch });
  const incrementalOut = await syncCampaigns(repo, pollClient, { campaignId, incremental: true });
  assert.equal(incrementalOut.results[0].mode, 'poll'); assert.equal(incrementalOut.results[0].events_appended, 1, 'only the third, genuinely new email is appended');
  const incrementalEmailsCall = apiCalls.filter((c) => c.path === '/api/v2/emails').at(-1);
  assert.equal(incrementalEmailsCall.query.min_timestamp_created, new Date(Date.parse(cursorBeforeIncrementalPoll) - 30 * MIN).toISOString(), 'the incremental sweep asks Instantly for mail from (stored cursor - 30 minute overlap) onward');
  res = await call('GET', 'campaign-detail', null, { campaign_id: campaignId });
  assert.equal(res.body.campaign.emails_synced_through, iso(T0 + MIN), 'the cursor advances to the newest email actually seen');
  assert.equal(res.body.members[0].emails_sent_count, 3);
  ok('an incremental sync narrows the /emails request to (cursor - overlap) onward via min_timestamp_created, appends only the new email, and advances the cursor');

  // ── suppression discovered purely by polling reaches new-campaign
  //    eligibility, with no webhook involved anywhere in this block ───────
  const leadRow = instantly.leads.get(`${instantlyId}|jane@alpha.co.uk`);
  leadRow.lt_interest_status = -1; // Instantly-side "Not Interested", set as if a human marked it in the Instantly UI
  await syncCampaigns(repo, pollClient, { campaignId, incremental: true, minIntervalMs: 0 });
  res = await call('GET', 'campaign-detail', null, { campaign_id: campaignId });
  assert.equal(res.body.members[0].interest_status, 'NOT_INTERESTED');
  const audience = await call('POST', 'campaign-audience', { campaign_type: 'ENQUIRY_FOLLOWUP', filters: { agency_ids: ['ag_1'] } });
  const ag1 = audience.body.rows.find((r) => r.agency_id === 'ag_1');
  assert.equal(ag1.eligibility.status, 'BLOCKED'); assert.ok(ag1.eligibility.blocks.includes('NEGATIVE_REPLY'), JSON.stringify(ag1.eligibility));
  ok('a "not interested" mark discovered purely by polling /leads/list blocks a brand-new campaign audience for that agency — no webhook delivery involved anywhere in this test');

  // ── pause still works, and the optional webhook endpoint fails softly
  //    (not silently broken, just unusable) with its secret unset ─────────
  res = await call('POST', 'campaign-pause', { confirm: 'PAUSE_CAMPAIGN', campaign_id: campaignId });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body)); assert.equal(res.body.status, 'PAUSED');
  res = await callRaw({ method: 'POST', query: { novus_operation: 'instantly-webhook' }, headers: {}, body: { event_type: 'email_sent', campaign_id: instantlyId, lead_email: 'jane@alpha.co.uk' } });
  assert.equal(res.statusCode, 500); assert.match(res.body.error, /INSTANTLY_WEBHOOK_SECRET is not configured/);
  ok('pause completes the lifecycle; the webhook endpoint itself just refuses to run without its own (still-optional) secret — nothing else is affected');

  globalThis.fetch = realFetch;
  __setRepoForTests(null);
}

console.log(`\n✅ novus-campaigns-selftest: ${passed} checks passed`);
