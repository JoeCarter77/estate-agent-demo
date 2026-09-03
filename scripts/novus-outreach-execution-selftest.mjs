// scripts/novus-outreach-execution-selftest.mjs — hermetic contract test for
// the canonical outreach execution state and the pipeline stages that consume
// it.
//
// No network, no credentials, no live sends. Every Instantly response is a
// fixture. The headline scenario reproduces the real campaign shape observed on
// 2026-09-03: 100 OUTBOUND rows handed to Instantly, of which 49 have actually
// had email 1 sent and 51 have not.
//
// Run:  npm run novus:outreach-execution-selftest

import assert from 'node:assert/strict';
import {
  EXECUTION_PAGE_LIMIT,
  EXECUTION_STATES,
  buildExecutionSweepUrl,
  buildOutreachExecutionState,
  fetchCampaignEmails,
  lookupOutreachExecution,
  unavailableExecution,
} from '../lib/instantly-execution-state.mjs';
import { resolveLifecycleStage } from '../lib/acquisition-stage.mjs';
import { deriveExpectedActions } from '../lib/acquisition-actions.mjs';
import { buildAcquisitionDashboard, emailExecutionMetrics } from '../lib/operator-funnel.mjs';

let passed = 0;
const ok = (msg) => { passed += 1; console.log(`  ✓ ${msg}`); };
const check = (msg, fn) => { const out = fn(); if (out && typeof out.then === 'function') return out.then(() => ok(msg)); ok(msg); return undefined; };
const section = (name) => console.log(`\n${name}`);

const CAMPAIGN = 'camp_novus_1';
const MAILBOX = 'joe@novushq.co.uk';
const NOW = '2026-09-03T12:00:00.000Z';

// One Instantly email object, in the shape lib/reply-router.mjs normalises.
function sent(lead, { at, step, ueType = 1, campaign = CAMPAIGN, id = '' } = {}) {
  return {
    id: id || `e_${lead}_${step || 0}_${at}`,
    timestamp: at,
    campaign_id: campaign,
    lead,
    ue_type: ueType,
    step,
    eaccount: MAILBOX,
    from_address_email: MAILBOX,
    to_address_email_list: lead,
    subject: 'Your enquiry',
    body_text: 'hello',
  };
}
function received(lead, { at, campaign = CAMPAIGN } = {}) {
  return {
    id: `r_${lead}_${at}`,
    timestamp: at,
    campaign_id: campaign,
    lead,
    ue_type: 2,
    eaccount: MAILBOX,
    from_address_email: lead,
    to_address_email_list: MAILBOX,
    subject: 'Re: Your enquiry',
    body_text: 'thanks',
  };
}

// ── 1. the sweep URL ───────────────────────────────────────────────────────
section('The bounded read');

check('the sweep is campaign-scoped, paginated and never filtered by email_type', () => {
  const url = new URL(buildExecutionSweepUrl({ campaignId: CAMPAIGN }));
  assert.equal(url.origin + url.pathname, 'https://api.instantly.ai/api/v2/emails');
  assert.equal(url.searchParams.get('campaign_id'), CAMPAIGN);
  assert.equal(url.searchParams.get('limit'), String(EXECUTION_PAGE_LIMIT));
  assert.equal(url.searchParams.get('sort_order'), 'desc');
  // email_type is classified locally from ue_type, never trusted server-side.
  assert.equal(url.searchParams.get('email_type'), null);
  assert.equal(url.searchParams.get('starting_after'), null);
});

check('a cursor is carried through as starting_after', () => {
  const url = new URL(buildExecutionSweepUrl({ campaignId: CAMPAIGN, startingAfter: 'cur_9' }));
  assert.equal(url.searchParams.get('starting_after'), 'cur_9');
});

check('pagination follows only the cursor the API returns, and stops without one', async () => {
  const calls = [];
  const pages = [
    { items: [sent('a@x.com', { at: '2026-09-01T09:00:00Z', step: 1 })], next_starting_after: 'c1' },
    { items: [sent('b@x.com', { at: '2026-09-01T10:00:00Z', step: 1 })] },
  ];
  let n = 0;
  const fetchImpl = async (url) => {
    calls.push(url);
    const body = JSON.stringify(pages[n]); n += 1;
    return { ok: true, status: 200, text: async () => body };
  };
  const result = await fetchCampaignEmails({ apiKey: 'k', campaignId: CAMPAIGN, fetchImpl });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /starting_after=c1/);
  assert.equal(result.emails.length, 2);
  assert.equal(result.pages, 2);
  assert.equal(result.truncated, false);
});

check('the page ceiling is absolute and reports truncation rather than a short count', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ items: [sent(`l${n}@x.com`, { at: '2026-09-01T09:00:00Z', step: 1 })], next_starting_after: `c${n}` }) };
  };
  const result = await fetchCampaignEmails({ apiKey: 'k', campaignId: CAMPAIGN, fetchImpl, maxPages: 3 });
  assert.equal(n, 3);
  assert.equal(result.pages, 3);
  assert.equal(result.truncated, true);
});

check('a missing credential refuses before any request is made', async () => {
  let called = false;
  await assert.rejects(
    () => fetchCampaignEmails({ apiKey: '', campaignId: CAMPAIGN, fetchImpl: async () => { called = true; } }),
    /credential is not set/,
  );
  assert.equal(called, false);
});

check('an API error never echoes the credential', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: 'unauthorized' }) });
  await assert.rejects(async () => {
    try { await fetchCampaignEmails({ apiKey: 'super-secret-key', campaignId: CAMPAIGN, fetchImpl }); }
    catch (err) {
      assert.equal(JSON.stringify({ m: err.message, e: err.instantly_error }).includes('super-secret-key'), false);
      throw err;
    }
  });
});

// ── 2. derivation ──────────────────────────────────────────────────────────
section('Handoff is not a send');

check('a handed lead with no sent email is WAITING_FIRST_EMAIL, not EMAIL_1_SENT', () => {
  const state = buildOutreachExecutionState({ emails: [], campaignId: CAMPAIGN, handedEmails: ['nobody@x.com'] });
  const lead = lookupOutreachExecution(state, { email: 'nobody@x.com', handed: true });
  assert.equal(lead.execution_state, 'WAITING_FIRST_EMAIL');
  assert.equal(lead.handed_to_instantly, true);
  assert.equal(lead.waiting_for_first_email, true);
  assert.equal(lead.emails_sent_count, 0);
  assert.equal(lead.first_email_sent_at, '');
});

check('one campaign send is EMAIL_1_SENT with real timestamps', () => {
  const state = buildOutreachExecutionState({
    emails: [sent('one@x.com', { at: '2026-09-01T09:00:00.000Z', step: 1 })],
    campaignId: CAMPAIGN, handedEmails: ['one@x.com'],
  });
  const lead = lookupOutreachExecution(state, { email: 'one@x.com', handed: true });
  assert.equal(lead.execution_state, 'EMAIL_1_SENT');
  assert.equal(lead.emails_sent_count, 1);
  assert.equal(lead.first_email_sent_at, '2026-09-01T09:00:00.000Z');
  assert.equal(lead.last_email_sent_at, '2026-09-01T09:00:00.000Z');
  assert.equal(lead.last_sequence_step, 1);
  assert.equal(lead.waiting_for_first_email, false);
});

check('two and three sends are follow-up 1 and follow-up 2, four is a later step', () => {
  const cases = [
    [[1, 2], 'FOLLOWUP_1_SENT'],
    [[1, 2, 3], 'FOLLOWUP_2_SENT'],
    [[1, 2, 3, 4], 'LATER_STEP_SENT'],
  ];
  for (const [steps, want] of cases) {
    const emails = steps.map((step) => sent('seq@x.com', { at: `2026-09-0${step}T09:00:00.000Z`, step }));
    const state = buildOutreachExecutionState({ emails, campaignId: CAMPAIGN, handedEmails: ['seq@x.com'] });
    const lead = lookupOutreachExecution(state, { email: 'seq@x.com', handed: true });
    assert.equal(lead.execution_state, want);
    assert.equal(lead.emails_sent_count, steps.length);
  }
});

check('every emitted state is in the declared enum', () => {
  const emails = [1, 2, 3, 4, 5].map((step) => sent('deep@x.com', { at: `2026-09-0${step}T09:00:00.000Z`, step }));
  const state = buildOutreachExecutionState({ emails, campaignId: CAMPAIGN, handedEmails: ['deep@x.com'] });
  for (const lead of state.by_email.values()) assert.ok(EXECUTION_STATES.includes(lead.execution_state));
});

check('a missing step number falls back to the observed send count, never to zero', () => {
  const emails = [
    sent('nostep@x.com', { at: '2026-09-01T09:00:00.000Z' }),
    sent('nostep@x.com', { at: '2026-09-02T09:00:00.000Z' }),
  ];
  const state = buildOutreachExecutionState({ emails, campaignId: CAMPAIGN, handedEmails: ['nostep@x.com'] });
  const lead = lookupOutreachExecution(state, { email: 'nostep@x.com', handed: true });
  assert.equal(lead.last_sequence_step, null);
  assert.equal(lead.sequence_position, 2);
  assert.equal(lead.execution_state, 'FOLLOWUP_1_SENT');
});

check('a manual NOVUS reply is never counted as a sequence email', () => {
  const emails = [
    sent('manual@x.com', { at: '2026-09-01T09:00:00.000Z', step: 1 }),
    sent('manual@x.com', { at: '2026-09-02T09:00:00.000Z', ueType: 3 }),
  ];
  const state = buildOutreachExecutionState({ emails, campaignId: CAMPAIGN, handedEmails: ['manual@x.com'] });
  const lead = lookupOutreachExecution(state, { email: 'manual@x.com', handed: true });
  assert.equal(lead.emails_sent_count, 1);
  assert.equal(lead.manual_emails_sent_count, 1);
  assert.equal(lead.execution_state, 'EMAIL_1_SENT');
});

check('a received email is a reply, never a send', () => {
  const emails = [
    sent('rep@x.com', { at: '2026-09-01T09:00:00.000Z', step: 1 }),
    received('rep@x.com', { at: '2026-09-02T09:00:00.000Z' }),
  ];
  const state = buildOutreachExecutionState({ emails, campaignId: CAMPAIGN, handedEmails: ['rep@x.com'] });
  const lead = lookupOutreachExecution(state, { email: 'rep@x.com', handed: true });
  assert.equal(lead.emails_sent_count, 1);
  assert.equal(lead.replied, true);
  assert.equal(lead.last_reply_at, '2026-09-02T09:00:00.000Z');
});

check('an email whose direction contradicts its ue_type is not counted', () => {
  const contradiction = sent('bad@x.com', { at: '2026-09-01T09:00:00.000Z', step: 1 });
  contradiction.from_address_email = 'someone-else@elsewhere.com';
  const state = buildOutreachExecutionState({ emails: [contradiction], campaignId: CAMPAIGN, handedEmails: ['bad@x.com'] });
  const lead = lookupOutreachExecution(state, { email: 'bad@x.com', handed: true });
  assert.equal(lead.emails_sent_count, 0);
  assert.equal(lead.execution_state, 'WAITING_FIRST_EMAIL');
});

check("another campaign's mail is discarded locally, not trusted from the filter", () => {
  const emails = [sent('other@x.com', { at: '2026-09-01T09:00:00.000Z', step: 1, campaign: 'camp_other' })];
  const state = buildOutreachExecutionState({ emails, campaignId: CAMPAIGN, handedEmails: ['other@x.com'] });
  assert.equal(state.ignored_other_campaign, 1);
  assert.equal(lookupOutreachExecution(state, { email: 'other@x.com', handed: true }).emails_sent_count, 0);
});

check('correlation is case- and whitespace-insensitive on the lead address', () => {
  const state = buildOutreachExecutionState({
    emails: [sent('mixed@x.com', { at: '2026-09-01T09:00:00.000Z', step: 1 })],
    campaignId: CAMPAIGN, handedEmails: ['mixed@x.com'],
  });
  assert.equal(lookupOutreachExecution(state, { email: '  MIXED@X.com ', handed: true }).emails_sent_count, 1);
});

check('an unavailable read is UNAVAILABLE, never a zero-send claim', () => {
  const lead = lookupOutreachExecution({ available: false, error: 'no key' }, { email: 'x@x.com', handed: true });
  assert.equal(lead.source, 'UNAVAILABLE');
  assert.equal(unavailableExecution().source, 'UNAVAILABLE');
});

// ── 3. the stages ──────────────────────────────────────────────────────────
section('Pipeline uses execution state');

const agency = { agency_id: 'ag_1', rightmove_sales_branch_url: 'https://www.rightmove.co.uk/x' };
function evidenceFor(execution) {
  return {
    agency, probe: null, outbound: { outbound_id: 'out_1', instantly_lead_id: 'lead_1', outbound_status: 'READY' },
    execution, replyEvents: [], salesMessages: [], demo: null, intelligence: null, actions: [],
    now: NOW, nowMs: Date.parse(NOW),
  };
}
function stageFor(email, emails) {
  const state = buildOutreachExecutionState({ emails, campaignId: CAMPAIGN, handedEmails: [email] });
  return resolveLifecycleStage(evidenceFor(lookupOutreachExecution(state, { email, handed: true })));
}

check('handed with no send stays in WAITING_FOR_FIRST_EMAIL', () => {
  const resolved = stageFor('w@x.com', []);
  assert.equal(resolved.stage, 'WAITING_FOR_FIRST_EMAIL');
  assert.match(resolved.reason, /records no sent campaign email/);
});

check('an instantly_lead_id alone can never produce EMAIL_1_SENT', () => {
  const resolved = resolveLifecycleStage(evidenceFor(unavailableExecution('no read')));
  assert.equal(resolved.stage, 'WAITING_FOR_FIRST_EMAIL');
});

check('one proven send moves the lead to EMAIL_1_SENT and says why', () => {
  const resolved = stageFor('s1@x.com', [sent('s1@x.com', { at: '2026-09-01T09:00:00.000Z', step: 1 })]);
  assert.equal(resolved.stage, 'EMAIL_1_SENT');
  assert.match(resolved.reason, /Instantly records 1 sent campaign email/);
});

check('proven follow-ups map to FOLLOWUP_1_SENT, FOLLOWUP_2_SENT and SEQUENCE_RUNNING', () => {
  const want = { 2: 'FOLLOWUP_1_SENT', 3: 'FOLLOWUP_2_SENT', 4: 'SEQUENCE_RUNNING' };
  for (const [count, stage] of Object.entries(want)) {
    const emails = Array.from({ length: Number(count) }, (_, i) => sent('f@x.com', { at: `2026-09-0${i + 1}T09:00:00.000Z`, step: i + 1 }));
    assert.equal(stageFor('f@x.com', emails).stage, stage);
  }
});

check('the pre-integration fallback is preserved exactly when the read is unavailable', () => {
  const evidence = evidenceFor(unavailableExecution('no key'));
  evidence.outbound.outbound_status = 'SENT';
  assert.equal(resolveLifecycleStage(evidence).stage, 'SEQUENCE_RUNNING');
});

check('conversation and terminal evidence still outrank execution state', () => {
  const state = buildOutreachExecutionState({
    emails: [sent('t@x.com', { at: '2026-09-01T09:00:00.000Z', step: 1 })],
    campaignId: CAMPAIGN, handedEmails: ['t@x.com'],
  });
  const evidence = evidenceFor(lookupOutreachExecution(state, { email: 't@x.com', handed: true }));
  evidence.replyEvents = [{ reply_event_id: 're_1', classification: 'NOT_INTERESTED', received_at: '2026-09-02T09:00:00.000Z' }];
  assert.equal(resolveLifecycleStage(evidence).stage, 'NOT_INTERESTED');
});

check('every executed-sequence stage still derives exactly one next action', () => {
  for (const stage of ['WAITING_FOR_FIRST_EMAIL', 'EMAIL_1_SENT', 'FOLLOWUP_1_SENT', 'FOLLOWUP_2_SENT', 'SEQUENCE_RUNNING']) {
    const evidence = { ...evidenceFor(unavailableExecution()), stage, stageReason: 'x' };
    evidence.execution = { source: 'INSTANTLY', last_email_sent_at: '2026-09-01T09:00:00.000Z' };
    const actions = deriveExpectedActions(evidence, NOW);
    assert.equal(actions.length, 1, stage);
    assert.equal(actions[0].action_owner, 'SYSTEM', stage);
    assert.equal(actions[0].action_type, stage === 'WAITING_FOR_FIRST_EMAIL' ? 'FIRST_EMAIL_CHECKPOINT' : 'SEQUENCE_CHECKPOINT', stage);
  }
});

check('a sequence checkpoint hangs off the last observed send, not the handoff', () => {
  const evidence = { ...evidenceFor(unavailableExecution()), stage: 'EMAIL_1_SENT', stageReason: 'x' };
  evidence.outbound.instantly_added_at = '2026-08-01T09:00:00.000Z';
  evidence.execution = { source: 'INSTANTLY', last_email_sent_at: '2026-09-01T09:00:00.000Z' };
  const [action] = deriveExpectedActions(evidence, NOW);
  assert.equal(action.due_at, '2026-09-08T09:00:00.000Z');
});

// ── 4. the live campaign shape ─────────────────────────────────────────────
section('The real campaign: 100 handed, 49 sent, 51 waiting');

// 100 OUTBOUND rows, all handed. The first 49 have had email 1 sent.
const HANDED = 100;
const SENT_COUNT = 49;
const emailFor = (i) => `lead${String(i).padStart(3, '0')}@agency.co.uk`;
const liveEmails = [];
for (let i = 0; i < SENT_COUNT; i += 1) {
  liveEmails.push(sent(emailFor(i), { at: '2026-09-01T09:00:00.000Z', step: 1 }));
}
const liveState = buildOutreachExecutionState({
  emails: liveEmails, campaignId: CAMPAIGN,
  handedEmails: Array.from({ length: HANDED }, (_, i) => emailFor(i)),
});

check('the sweep accounts for all 100 handed leads', () => {
  assert.equal(liveState.totals.leads_with_evidence, HANDED);
});

check('49 have had email 1 sent and 51 are genuinely still waiting', () => {
  assert.equal(liveState.totals.first_emails_sent, SENT_COUNT);
  assert.equal(liveState.totals.waiting_for_first_email, HANDED - SENT_COUNT);
  assert.equal(liveState.totals.by_state.EMAIL_1_SENT, SENT_COUNT);
  assert.equal(liveState.totals.by_state.WAITING_FIRST_EMAIL, HANDED - SENT_COUNT);
});

check('total emails sent is 49, NOT the 100 that were handed over', () => {
  assert.equal(liveState.totals.total_emails_sent, SENT_COUNT);
  assert.notEqual(liveState.totals.total_emails_sent, HANDED);
  assert.equal(liveState.totals.followup_emails_sent, 0);
});

check('the metrics projection separates leads added from emails sent', () => {
  const rows = Array.from({ length: HANDED }, (_, i) => ({
    outbound: { instantly_lead_id: `l${i}` },
    execution: lookupOutreachExecution(liveState, { email: emailFor(i), handed: true }),
  }));
  const metrics = emailExecutionMetrics(rows);
  assert.equal(metrics.leads_added_to_outreach, HANDED);
  assert.equal(metrics.first_emails_sent, SENT_COUNT);
  assert.equal(metrics.total_emails_sent, SENT_COUNT);
  assert.equal(metrics.waiting_for_first_email, HANDED - SENT_COUNT);
  assert.equal(metrics.execution_available, true);
});

// ── 5. the whole dashboard ─────────────────────────────────────────────────
section('Pipeline and Analytics cannot disagree');

function table(header, rows) { return { header, rows }; }
function dashboardFor(execution) {
  const agencyHeader = ['agency_id', 'agency_name', 'clean_agency_name', 'outreach_contact_email', 'email_verification_status', 'rightmove_sales_branch_url', 'probe_sent', 'current_pipeline_status', 'suppression_status', 'main_phone', 'location'];
  const outboundHeader = ['outbound_id', 'agency_id', 'probe_id', 'outreach_contact_email', 'outbound_status', 'instantly_lead_id', 'instantly_added_at', 'updated_at'];
  const agencies = [];
  const outbound = [];
  for (let i = 0; i < HANDED; i += 1) {
    agencies.push([`ag_${i}`, `Agency ${i}`, `Agency ${i}`, emailFor(i), 'VALID', 'https://www.rightmove.co.uk/x', '2026-08-01', '', '', '', 'Essex']);
    outbound.push([`out_${i}`, `ag_${i}`, `pr_${i}`, emailFor(i), 'READY', `lead_${i}`, '2026-08-30T16:37:58.502Z', '2026-08-30T16:37:58.502Z']);
  }
  return buildAcquisitionDashboard({
    AGENCIES: table(agencyHeader, agencies),
    OUTBOUND: table(outboundHeader, outbound),
    PROBES: table(['probe_id'], []),
    INTELLIGENCE: table(['intelligence_id'], []),
    PERSONALISATION: table(['probe_id'], []),
    DEMOS: table(['demo_id'], []),
    REPLY_EVENTS: table(['reply_event_id'], []),
    SALES_MESSAGES: table([], []),
    ACTIONS: table([], []),
  }, { now: NOW, actionsAvailable: true, execution });
}

const liveDashboard = dashboardFor(liveState);

check('the Pipeline shows 49 at EMAIL_1_SENT and 51 waiting', () => {
  assert.equal(liveDashboard.counts.by_stage.EMAIL_1_SENT, SENT_COUNT);
  assert.equal(liveDashboard.counts.by_stage.WAITING_FOR_FIRST_EMAIL, HANDED - SENT_COUNT);
});

check('Analytics reports 49 emails sent against 100 leads added', () => {
  assert.equal(liveDashboard.counts.leads_added_to_outreach, HANDED);
  assert.equal(liveDashboard.counts.first_emails_sent, SENT_COUNT);
  assert.equal(liveDashboard.counts.total_emails_sent, SENT_COUNT);
  assert.notEqual(liveDashboard.counts.total_emails_sent, HANDED);
});

check('Pipeline stage counts and the Analytics totals are the same evidence', () => {
  const stages = liveDashboard.counts.by_stage;
  const sentStages = (stages.EMAIL_1_SENT || 0) + (stages.FOLLOWUP_1_SENT || 0)
    + (stages.FOLLOWUP_2_SENT || 0) + (stages.SEQUENCE_RUNNING || 0);
  assert.equal(sentStages, liveDashboard.metrics.first_emails_sent);
  assert.equal(stages.WAITING_FOR_FIRST_EMAIL, liveDashboard.metrics.waiting_for_first_email);
});

check('every lead carries the canonical execution object the views read', () => {
  const lead = liveDashboard.leads.find((row) => row.agency_id === 'ag_0');
  assert.equal(lead.outreach_execution.source, 'INSTANTLY');
  assert.equal(lead.outreach_execution.emails_sent_count, 1);
  assert.equal(lead.current_stage, 'EMAIL_1_SENT');
});

check('an unavailable read degrades to the previous behaviour and warns', () => {
  const fallback = dashboardFor({ available: false, error: 'INSTANTLY_REPLY_API_KEY is not set in this environment.' });
  assert.equal(fallback.counts.by_stage.WAITING_FOR_FIRST_EMAIL, HANDED);
  assert.equal(fallback.counts.by_stage.EMAIL_1_SENT, undefined);
  assert.equal(fallback.counts.outreach_execution_available, false);
  assert.equal(fallback.counts.total_emails_sent, 0);
  assert.ok(fallback.warnings.some((w) => w.code === 'outreach_execution_unavailable'));
});

check('a truncated sweep is reported rather than presented as complete', () => {
  const truncated = dashboardFor({ ...liveState, truncated: true, pages: 12 });
  assert.ok(truncated.warnings.some((w) => w.code === 'outreach_execution_truncated'));
});

// ── 6. the reconciler shares the same definition of "sent" ────────────────
section('The action ledger cannot disagree with the Command Centre');

const { reconcileActionEngine } = await import('../lib/action-engine.mjs');
const { ACTIONS_HEADER } = await import('../lib/actions-store.mjs');

// A repo stub that records every write and serves one handed lead which
// Instantly HAS emailed, holding a live SEQUENCE_CHECKPOINT.
function stubRepo() {
  const writes = [];
  const agencyHeader = ['agency_id', 'agency_name', 'clean_agency_name', 'outreach_contact_email', 'email_verification_status', 'rightmove_sales_branch_url', 'probe_sent', 'current_pipeline_status', 'suppression_status'];
  const outboundHeader = ['outbound_id', 'agency_id', 'probe_id', 'outreach_contact_email', 'outbound_status', 'instantly_lead_id', 'instantly_added_at', 'updated_at'];
  const action = Object.fromEntries(ACTIONS_HEADER.map((key) => [key, '']));
  Object.assign(action, {
    action_id: 'act_1', agency_id: 'ag_1', outreach_id: 'out_1', action_type: 'SEQUENCE_CHECKPOINT',
    action_owner: 'SYSTEM', action_status: 'PENDING', due_at: '2026-09-08T09:00:00.000Z',
    reason: 'Instantly sequence is handling this lead', source_stage: 'EMAIL_1_SENT',
    dedupe_key: 'ag_1:SEQUENCE_CHECKPOINT:out_1', created_at: '2026-09-01T09:00:00.000Z',
    updated_at: '2026-09-01T09:00:00.000Z', metadata_json: '{}',
  });
  const tables = {
    AGENCIES: { header: agencyHeader, rows: [['ag_1', 'Agency One', 'Agency One', 'one@agency.co.uk', 'VALID', 'https://www.rightmove.co.uk/x', '2026-08-01', '', '']] },
    OUTBOUND: { header: outboundHeader, rows: [['out_1', 'ag_1', 'pr_1', 'one@agency.co.uk', 'READY', 'lead_1', '2026-08-30T16:37:58.502Z', '2026-08-30T16:37:58.502Z']] },
    PROBES: { header: ['probe_id'], rows: [] },
    INTELLIGENCE: { header: ['intelligence_id'], rows: [] },
    PERSONALISATION: { header: ['probe_id'], rows: [] },
    DEMOS: { header: ['demo_id'], rows: [] },
    REPLY_EVENTS: { header: ['reply_event_id'], rows: [] },
    SALES_MESSAGES: { header: [], rows: [] },
    ACTIONS: { header: [...ACTIONS_HEADER], rows: [ACTIONS_HEADER.map((key) => action[key])] },
  };
  return {
    writes,
    async getTable(tab) { return tables[tab] || { header: [], rows: [] }; },
    async appendRowsBatch(tab, rows) { writes.push({ op: 'append', tab, rows }); },
    async updateById(tab, column, value, patch) { writes.push({ op: 'update', tab, value, patch }); return true; },
  };
}

const sentState = buildOutreachExecutionState({
  emails: [sent('one@agency.co.uk', { at: '2026-09-01T09:00:00.000Z', step: 1 })],
  campaignId: CAMPAIGN, handedEmails: ['one@agency.co.uk'],
});

await check('with execution state the reconciler agrees and leaves the checkpoint alone', async () => {
  const repo = stubRepo();
  const result = await reconcileActionEngine(repo, { now: NOW, execution: sentState });
  assert.equal(result.available, true);
  assert.equal(result.created, 0);
  assert.equal(result.cancelled, 0);
  assert.equal(repo.writes.filter((w) => w.op === 'append').length, 0);
});

await check('a failed execution read defers the outreach checkpoint instead of churning it', async () => {
  const repo = stubRepo();
  const result = await reconcileActionEngine(repo, { now: NOW, execution: { available: false, error: 'read failed' } });
  assert.equal(result.outreach_checkpoints_deferred, 1);
  assert.equal(result.created, 0);
  assert.equal(result.cancelled, 0);
  // The critical property: nothing was written at all, so the live
  // SEQUENCE_CHECKPOINT survives a transient Instantly outage untouched.
  assert.deepEqual(repo.writes, []);
});

console.log(`\n✅ NOVUS outreach execution self-test passed (${passed} focused assertions).`);
