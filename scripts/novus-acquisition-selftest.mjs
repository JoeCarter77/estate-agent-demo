// Hermetic Phase 4 lifecycle/action/funnel coverage. No network, credentials,
// live sends, real agency deletes, meetings, or call outcomes.
import assert from 'node:assert/strict';
import { resolveLifecycleStage } from '../lib/acquisition-stage.mjs';
import { actionQueue, deriveExpectedActions, isManualSalesAction, MANUAL_SALES_ACTION_TYPES, reconcileActions } from '../lib/acquisition-actions.mjs';
import { ACQUISITION_POLICY } from '../lib/acquisition-policy.mjs';
import { ACTIONS_HEADER, appendAction, buildActionsSetupPlan } from '../lib/actions-store.mjs';
import { buildAcquisitionDashboard, buildFunnelMetrics, enforceNextActionInvariant } from '../lib/operator-funnel.mjs';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';

const NOW = '2026-09-03T12:00:00.000Z';
const hoursAgo = (hours) => new Date(Date.parse(NOW) - hours * 3600000).toISOString();
const base = (overrides = {}) => ({
  agency: { agency_id: 'ag_1', agency_name: 'One', rightmove_sales_branch_url: 'https://rightmove.test/one' },
  probe: null, outbound: null, replyEvents: [], salesMessages: [], demo: null,
  intelligence: null, personalisation: null, actions: [], outreachReady: false,
  preparationReason: '', now: NOW, nowMs: Date.parse(NOW), ...overrides,
});
const stage = (e) => resolveLifecycleStage(e).stage;
let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };
function check(name, fn) { fn(); ok(name); }

console.log('\nLifecycle precedence and stage resolution');
check('unprobed eligible agency -> READY_TO_PROBE', () => assert.equal(stage(base()), 'READY_TO_PROBE'));
check('draft probe -> PROBE_IN_PROGRESS', () => assert.equal(stage(base({ probe: { probe_id: 'p1', probe_status: 'draft' } })), 'PROBE_IN_PROGRESS'));
check('sent probe -> PROBE_OBSERVING', () => assert.equal(stage(base({ probe: { probe_id: 'p1', probe_status: 'observing', observation_deadline: hoursAgo(-24) } })), 'PROBE_OBSERVING'));
check('closed probe without intelligence -> PROBE_COMPLETE', () => assert.equal(stage(base({ probe: { probe_id: 'p1', probe_status: 'closed' } })), 'PROBE_COMPLETE'));
check('closed probe waiting downstream -> PREPARING_OUTREACH', () => assert.equal(stage(base({ probe: { probe_id: 'p1', probe_status: 'closed' }, intelligence: { intelligence_id: 'i1' }, preparationReason: 'waiting for contact' })), 'PREPARING_OUTREACH'));
check('prepared evidence -> READY_FOR_OUTREACH', () => assert.equal(stage(base({ probe: { probe_id: 'p1', probe_status: 'closed' }, intelligence: {}, outreachReady: true })), 'READY_FOR_OUTREACH'));
check('Instantly handoff without stored send -> WAITING_FOR_FIRST_EMAIL', () => assert.equal(stage(base({ outbound: { outbound_id: 'o1', instantly_lead_id: 'l1', outbound_status: 'READY' } })), 'WAITING_FOR_FIRST_EMAIL'));
check('stored SENT sequence -> SEQUENCE_RUNNING', () => assert.equal(stage(base({ outbound: { outbound_id: 'o1', instantly_lead_id: 'l1', outbound_status: 'SENT' } })), 'SEQUENCE_RUNNING'));
const question = { reply_event_id: 'r1', classification: 'QUESTION', received_at: hoursAgo(1), action_status: 'PENDING' };
check('QUESTION -> REPLIED_NEEDS_HUMAN', () => assert.equal(stage(base({ replyEvents: [question] })), 'REPLIED_NEEDS_HUMAN'));
const positive = { reply_event_id: 'r2', classification: 'POSITIVE_SEND_DEMO', received_at: hoursAgo(3), next_action: 'SEND_DEMO', action_status: 'PENDING' };
check('positive before send -> DEMO_REQUESTED', () => assert.equal(stage(base({ replyEvents: [positive] })), 'DEMO_REQUESTED'));
const sent = { ...positive, action_status: 'COMPLETED', action_completed_at: hoursAgo(2) };
check('demo sent unopened', () => assert.equal(stage(base({ replyEvents: [sent], demo: {} })), 'DEMO_SENT_UNOPENED'));
check('demo opened', () => assert.equal(stage(base({ replyEvents: [sent], demo: { first_viewed_at: hoursAgo(1), last_viewed_at: hoursAgo(1), view_count: '1' } })), 'DEMO_OPENED'));
check('demo engaged by CTA', () => assert.equal(stage(base({ replyEvents: [sent], demo: { first_viewed_at: hoursAgo(1), cta_clicked_at: hoursAgo(.5), view_count: '1' } })), 'DEMO_ENGAGED'));
check('manual reply waiting', () => assert.equal(stage(base({ replyEvents: [question], salesMessages: [{ sales_message_id: 's1', message_type: 'MANUAL_REPLY', send_outcome: 'SENT', sent_at: hoursAgo(.5) }] })), 'MANUAL_REPLY_SENT_WAITING'));
check('due call action -> CALL_DUE', () => assert.equal(stage(base({ actions: [{ action_type: 'CALL_PROSPECT', action_status: 'DUE', due_at: hoursAgo(1) }] })), 'CALL_DUE'));
check('new genuine inbound supersedes a stale due call', () => assert.equal(stage(base({
  replyEvents: [question],
  actions: [{ action_type: 'CALL_PROSPECT', action_status: 'DUE', due_at: hoursAgo(1), created_at: hoursAgo(2) }],
})), 'REPLIED_NEEDS_HUMAN'));
check('meeting terminal overrides opt-out and errors', () => assert.equal(stage(base({ agency: { agency_id: 'ag_1', current_pipeline_status: 'MEETING_BOOKED' }, replyEvents: [{ classification: 'OPT_OUT', suppression_type: 'PERMANENT' }], outbound: { outbound_status: 'ERROR' } })), 'MEETING_BOOKED'));
check('opt-out overrides not interested', () => assert.equal(stage(base({ replyEvents: [{ classification: 'OPT_OUT', suppression_type: 'PERMANENT' }, { classification: 'NOT_INTERESTED' }] })), 'OPTED_OUT'));
check('not interested is terminal', () => assert.equal(stage(base({ replyEvents: [{ classification: 'NOT_INTERESTED' }] })), 'NOT_INTERESTED'));

console.log('\nAction rules and idempotent reconciliation');
function expectedFor(evidence) {
  const resolved = resolveLifecycleStage(evidence); evidence.stage = resolved.stage; evidence.stageReason = resolved.reason;
  return deriveExpectedActions(evidence, NOW);
}
check('unopened demo follow-up due exactly 24h after send', () => {
  const action = expectedFor(base({ replyEvents: [{ ...sent, received_at: hoursAgo(25), action_completed_at: hoursAgo(24) }], demo: {} }))[0];
  assert.equal(action.action_type, 'DEMO_UNOPENED_FOLLOWUP'); assert.equal(action.action_status, 'DUE'); assert.equal(action.due_at, NOW);
});
check('opened demo follow-up uses 24h policy', () => {
  const e = base({ replyEvents: [{ ...sent, received_at: hoursAgo(26), action_completed_at: hoursAgo(25) }], demo: { first_viewed_at: hoursAgo(24), last_viewed_at: hoursAgo(24), view_count: '1' } });
  assert.equal(expectedFor(e)[0].action_type, 'DEMO_OPENED_FOLLOWUP'); assert.equal(expectedFor(e)[0].due_at, NOW);
});
check('demo follow-up ignored 48h -> call', () => {
  const e = base({ salesMessages: [{ sales_message_id: 'f1', message_type: 'FOLLOW_UP', send_outcome: 'SENT', sent_at: hoursAgo(48) }] });
  assert.equal(expectedFor(e)[0].action_type, 'CALL_PROSPECT'); assert.equal(expectedFor(e)[0].action_status, 'DUE');
});
check('manual reply ignored 48h -> Joe follow-up', () => {
  const e = base({ salesMessages: [{ sales_message_id: 'm1', message_type: 'MANUAL_REPLY', send_outcome: 'SENT', sent_at: hoursAgo(48) }] });
  assert.equal(expectedFor(e)[0].action_type, 'FOLLOW_UP_CONVERSATION'); assert.equal(expectedFor(e)[0].action_owner, 'JOE');
});
check('OOO creates a 48h SYSTEM checkpoint and replaces a stale human call', () => {
  const e = base({
    replyEvents: [{ reply_event_id: 'ooo1', classification: 'OOO_AUTOMATED', received_at: hoursAgo(1) }],
    actions: [{ action_id: 'call1', action_type: 'CALL_PROSPECT', action_owner: 'JOE', action_status: 'DUE', due_at: hoursAgo(2), created_at: hoursAgo(3), dedupe_key: 'old-call' }],
  });
  const expectedRows = expectedFor(e);
  assert.equal(expectedRows[0].action_type, 'OUT_OF_OFFICE_CHECKPOINT');
  assert.equal(expectedRows[0].action_owner, 'SYSTEM');
  assert.equal(expectedRows[0].due_at, hoursAgo(-47));
  assert.equal(reconcileActions(e.actions, expectedRows, NOW).cancel[0].action_id, 'call1');
});
check('new inbound replaces and cancels stale no-reply action', () => {
  const expectedRows = expectedFor(base({ replyEvents: [question] }));
  const plan = reconcileActions([{ action_id: 'a1', dedupe_key: 'old', action_status: 'PENDING' }], expectedRows, NOW);
  assert.equal(plan.cancel.length, 1); assert.equal(plan.create[0].action_type, 'HUMAN_REPLY');
});
check('terminal meeting/opt-out/not interested derive no actions', () => {
  for (const current_pipeline_status of ['MEETING_BOOKED', 'NOT_INTERESTED', 'CLOSED']) {
    assert.deepEqual(expectedFor(base({ agency: { agency_id: 'ag_1', current_pipeline_status } })), []);
  }
  assert.deepEqual(expectedFor(base({ replyEvents: [{ classification: 'OPT_OUT', suppression_type: 'PERMANENT' }] })), []);
});
check('same active dedupe key is reused, never duplicated', () => {
  const row = expectedFor(base())[0]; const plan = reconcileActions([{ ...row, action_id: 'a1' }], [row], NOW);
  assert.deepEqual(plan.create, []); assert.deepEqual(plan.cancel, []);
});
check('PENDING crosses due boundary -> DUE update', () => {
  const row = { ...expectedFor(base())[0], action_status: 'DUE' };
  const existing = { ...row, action_id: 'a1', action_status: 'PENDING' };
  assert.equal(reconcileActions([existing], [row], NOW).update[0].patch.action_status, 'DUE');
});
check('central policy values are exact and easy to change', () => {
  assert.equal(ACQUISITION_POLICY.demoUnopenedFollowupMs, 24 * 3600000);
  assert.equal(ACQUISITION_POLICY.callNoAnswerRetryMs, 48 * 3600000);
});

console.log('\nACTIONS schema/store');
check('setup plan is exact header + schema note and no fake data', () => {
  const plan = buildActionsSetupPlan(); assert.deepEqual(plan.header_row, ACTIONS_HEADER); assert.equal(plan.data_rows.length, 0); assert.equal(plan.schema_note_row.length, 19);
});
{
  const table = { header: [...ACTIONS_HEADER], rows: [ACTIONS_HEADER.map((_, i) => i === 0 ? 'SCHEMA NOTE' : '')] };
  const repo = { async getTable() { return table; }, async appendRowsBatch(_tab, rows) { table.rows.push(...rows); } };
  const input = { agency_id: 'ag_1', action_type: 'PROBE_AGENCY', action_owner: 'JOE', action_status: 'DUE', dedupe_key: 'ag_1:probe', source_stage: 'READY_TO_PROBE' };
  await appendAction(repo, input, NOW); const second = await appendAction(repo, input, NOW);
  assert.equal(table.rows.length, 2); assert.equal(second.reused, true);
  ok('append is sequentially idempotent by active dedupe_key');
}

console.log('\nFunnel metrics');
check('non-terminal state with no action is promoted to NO_NEXT_ACTION', () => {
  assert.equal(enforceNextActionInvariant('SEQUENCE_RUNNING', null), 'NO_NEXT_ACTION');
  assert.equal(enforceNextActionInvariant('MEETING_BOOKED', null), 'MEETING_BOOKED');
});
check('metrics count mutually exclusive stages and valid conversions', () => {
  const evidence = [
    base({ stage: 'READY_TO_PROBE' }),
    base({ stage: 'SEQUENCE_RUNNING', probe: {}, outbound: {}, replyEvents: [positive] }),
    base({ stage: 'MEETING_BOOKED', probe: {}, outbound: {}, replyEvents: [positive], demo: { first_viewed_at: NOW } }),
  ];
  const metrics = buildFunnelMetrics(evidence);
  assert.equal(metrics.by_stage.READY_TO_PROBE, 1); assert.equal(metrics.meeting_booked, 1);
  assert.deepEqual(metrics.conversions.outreach_to_meeting, { numerator: 1, denominator: 2, percent: 50 });
});
check('zero denominator produces null, never a misleading percentage', () => {
  assert.equal(buildFunnelMetrics([base({ stage: 'READY_TO_PROBE' })]).conversions.outreach_to_reply.percent, null);
});
check('agency-wide dashboard never drops a pre-OUTBOUND lead and enforces the next-action invariant', () => {
  const table = (header, objects = []) => ({ header, rows: objects.map((obj) => header.map((key) => obj[key] ?? '')) });
  const tables = {
    AGENCIES: table(['agency_id', 'agency_name', 'rightmove_sales_branch_url', 'current_pipeline_status'], [
      { agency_id: 'ag_ready', agency_name: 'Ready', rightmove_sales_branch_url: 'https://rightmove.test/ready' },
      { agency_id: 'ag_closed', agency_name: 'Closed', current_pipeline_status: 'CLOSED' },
    ]),
    PROBES: table(['probe_id', 'agency_id']), INTELLIGENCE: table(['intelligence_id', 'probe_id']),
    PERSONALISATION: table(['probe_id', 'agency_id']), DEMOS: table(['demo_id', 'agency_id', 'probe_id']),
    OUTBOUND: table(['outbound_id', 'agency_id', 'probe_id']), REPLY_EVENTS: table(['reply_event_id', 'agency_id']),
    SALES_MESSAGES: table([], []), ACTIONS: table([], []),
  };
  const dashboard = buildAcquisitionDashboard(tables, { now: NOW, actionsAvailable: false });
  assert.equal(dashboard.leads.length, 2);
  const ready = dashboard.leads.find((lead) => lead.agency_id === 'ag_ready');
  assert.equal(ready.current_stage, 'READY_TO_PROBE'); assert.equal(ready.current_action.action_type, 'PROBE_AGENCY');
  assert.equal(dashboard.global_exceptions[0].type, 'ACTION_LEDGER_UNAVAILABLE');
});

console.log('\nManual action queue semantics (Needs your attention)');
{
  const queueOf = (action_type, action_owner = 'JOE') => actionQueue({ action_type, action_owner, action_status: 'DUE' });
  for (const type of MANUAL_SALES_ACTION_TYPES) {
    check(`${type} owned by JOE is a manual sales action`, () => {
      assert.equal(queueOf(type), 'JOE');
      assert.equal(isManualSalesAction({ action_type: type, action_owner: 'JOE', action_status: 'DUE' }), true);
    });
  }
  check('PROBE_AGENCY is PROBER queue work, never a daily manual sales action', () => {
    assert.equal(queueOf('PROBE_AGENCY'), 'PROBER');
    assert.equal(isManualSalesAction({ action_type: 'PROBE_AGENCY', action_owner: 'JOE', action_status: 'DUE' }), false);
  });
  check('COMPLETE_PROBE is PROBER queue work too', () => assert.equal(queueOf('COMPLETE_PROBE'), 'PROBER'));
  for (const type of ['OBSERVATION_CHECKPOINT', 'PREPARE_OUTREACH', 'HANDOFF_TO_INSTANTLY', 'FIRST_EMAIL_CHECKPOINT', 'SEQUENCE_CHECKPOINT', 'SEND_DEMO', 'OUT_OF_OFFICE_CHECKPOINT', 'DEMO_UNOPENED_FOLLOWUP', 'DEMO_OPENED_FOLLOWUP']) {
    check(`${type} is pipeline/system work, not Joe's queue`, () => {
      assert.equal(queueOf(type, 'SYSTEM'), 'SYSTEM');
      assert.equal(isManualSalesAction({ action_type: type, action_owner: 'SYSTEM', action_status: 'DUE' }), false);
    });
  }
  check('a RESOLVE_EXCEPTION that NOVUS owns is not Joe\'s manual action', () =>
    assert.equal(isManualSalesAction({ action_type: 'RESOLVE_EXCEPTION', action_owner: 'NOVUS', action_status: 'DUE' }), false));
  check('a completed manual action is no longer in the queue', () =>
    assert.equal(isManualSalesAction({ action_type: 'HUMAN_REPLY', action_owner: 'JOE', action_status: 'COMPLETED' }), false));
}
{
  // End-to-end through the dashboard: probing must not reach needs_attention.
  const agenciesHeader = ['agency_id', 'agency_name', 'rightmove_sales_branch_url', 'probe_sent'];
  const tables = {
    AGENCIES: { header: agenciesHeader, rows: [
      ['ag_probe', 'Unprobed Agency', 'https://rightmove.test/probe', ''],
      ['ag_reply', 'Replied Agency', 'https://rightmove.test/reply', 'YES'],
      ['ag_done', 'Probed Agency', 'https://rightmove.test/done', 'YES'],
    ] },
    PROBES: { header: ['probe_id', 'agency_id', 'probe_status', 'observation_deadline'], rows: [
      ['prb_done', 'ag_done', 'observing', hoursAgo(-48)],
    ] },
    INTELLIGENCE: { header: ['intelligence_id', 'probe_id'], rows: [] },
    PERSONALISATION: { header: ['probe_id', 'agency_id'], rows: [] },
    DEMOS: { header: ['demo_id', 'agency_id', 'probe_id'], rows: [] },
    OUTBOUND: { header: ['outbound_id', 'agency_id', 'probe_id'], rows: [] },
    REPLY_EVENTS: { header: ['reply_event_id', 'agency_id', 'classification', 'received_at'], rows: [
      ['r_q', 'ag_reply', 'QUESTION', hoursAgo(1)],
    ] },
    SALES_MESSAGES: { header: [], rows: [] },
    ACTIONS: { header: [], rows: [] },
  };
  const dashboard = buildAcquisitionDashboard(tables, { now: NOW, actionsAvailable: false });
  const lead = (id) => dashboard.leads.find((row) => row.agency_id === id);
  check('READY_TO_PROBE never enters the manual action queue', () => {
    assert.equal(lead('ag_probe').current_stage, 'READY_TO_PROBE');
    assert.equal(lead('ag_probe').current_action.action_type, 'PROBE_AGENCY');
    assert.equal(lead('ag_probe').needs_human, false);
    assert.equal(lead('ag_probe').action_queue, 'PROBER');
  });
  check('a genuine reply still needs a human', () => {
    assert.equal(lead('ag_reply').needs_human, true);
    assert.equal(lead('ag_reply').action_queue, 'JOE');
    assert.equal(lead('ag_reply').next_action.type, 'HUMAN_REPLY');
  });
  check('a running observation stays with the system', () => {
    assert.equal(lead('ag_done').needs_human, false);
    assert.equal(lead('ag_done').action_queue, 'SYSTEM');
  });
  check('needs_attention counts only manual sales actions', () =>
    assert.equal(dashboard.counts.needs_attention, 1));
  check('probe queue depth comes from the physical probe_sent cell', () => {
    assert.equal(dashboard.counts.probe_queue, 1);
    assert.equal(lead('ag_probe').probe_queue_eligible, true);
    assert.equal(lead('ag_done').probe_queue_eligible, false);
  });
}

console.log('\nAPI security and read shape');
{
  const store = {
    AGENCIES: [['agency_id', 'agency_name', 'rightmove_sales_branch_url'], ['ag_api', 'API Agency', 'https://rightmove.test/api']],
    PROBES: [['probe_id', 'agency_id']], INTELLIGENCE: [['intelligence_id', 'probe_id']],
    PERSONALISATION: [['probe_id', 'agency_id']], DEMOS: [['demo_id', 'agency_id', 'probe_id']],
    OUTBOUND: [['outbound_id', 'agency_id', 'probe_id']], REPLY_EVENTS: [['reply_event_id', 'agency_id']],
    SALES_MESSAGES: [], ACTIONS: [ACTIONS_HEADER.slice(), ACTIONS_HEADER.map((_, i) => i === 0 ? 'SCHEMA NOTE' : '')],
  };
  const reads = [];
  const repo = createRepo({
    async get(range) { const tab = String(range).split('!')[0]; reads.push(tab); return (store[tab] || []).map((row) => row.slice()); },
    async append() { throw new Error('dashboard must not append'); }, async update() { throw new Error('dashboard must not update'); },
    async batchUpdate() { throw new Error('dashboard must not batch-update'); },
  });
  __setRepoForTests(repo);
  process.env.NOVUS_BASIC_AUTH_USER = 'novus'; process.env.NOVUS_BASIC_AUTH_PASS = 'testpass';
  const { default: handler } = await import('../api/novus/personalisation.js');
  const response = () => ({ statusCode: 200, body: null, headers: {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end() { return this; }, setHeader(k, v) { this.headers[k] = v; } });
  const denied = response();
  await handler({ method: 'GET', query: { novus_operation: 'operator-dashboard' }, headers: {} }, denied);
  assert.equal(denied.statusCode, 401); assert.equal(reads.length, 0); ok('operator dashboard blocks unauthenticated reads');
  const basic = 'Basic ' + Buffer.from('novus:testpass').toString('base64');
  const allowed = response();
  await handler({ method: 'GET', query: { novus_operation: 'operator-dashboard', refresh: '1' }, headers: { authorization: basic } }, allowed);
  assert.equal(allowed.statusCode, 200); assert.equal(allowed.body.leads[0].current_stage, 'READY_TO_PROBE');
  assert.equal(allowed.body.leads[0].current_action.action_type, 'PROBE_AGENCY'); ok('authenticated dashboard is agency-wide and read-only');
  reads.length = 0;
  for (const operation of ['operator-actions-reconcile', 'operator-mark-meeting-booked', 'operator-call-outcome']) {
    const res = response();
    await handler({ method: 'POST', query: { novus_operation: operation }, body: {}, headers: { authorization: basic } }, res);
    assert.equal(res.statusCode, 400, operation); assert.equal(reads.length, 0, operation);
  }
  ok('all acquisition writes require explicit confirmation/input before any Sheets access');
  __setRepoForTests(null);

  function makeCallFixture() {
    const action = { ...Object.fromEntries(ACTIONS_HEADER.map((key) => [key, ''])) };
    Object.assign(action, {
      action_id: 'act_call', agency_id: 'ag_call', action_type: 'CALL_PROSPECT', action_owner: 'JOE',
      action_status: 'DUE', due_at: '2000-01-01T00:00:00.000Z', reason: 'Call is due', source_stage: 'CALL_DUE',
      dedupe_key: 'ag_call:CALL_PROSPECT:test', created_at: '2000-01-01T00:00:00.000Z', updated_at: '2000-01-01T00:00:00.000Z', metadata_json: '{}',
    });
    const tables = {
      AGENCIES: { header: ['agency_id', 'agency_name', 'current_pipeline_status', 'updated_at'], rows: [['ag_call', 'Call Agency', '', '']] },
      PROBES: { header: ['probe_id', 'agency_id'], rows: [] },
      INTELLIGENCE: { header: ['intelligence_id', 'probe_id'], rows: [] },
      PERSONALISATION: { header: ['probe_id', 'agency_id'], rows: [] },
      DEMOS: { header: ['demo_id', 'agency_id', 'probe_id'], rows: [] },
      OUTBOUND: { header: ['outbound_id', 'agency_id', 'probe_id'], rows: [] },
      REPLY_EVENTS: { header: ['reply_event_id', 'agency_id'], rows: [] },
      SALES_MESSAGES: { header: [], rows: [] },
      ACTIONS: { header: [...ACTIONS_HEADER], rows: [ACTIONS_HEADER.map((key) => action[key] ?? '')] },
    };
    const find = (tab, idColumn, idValue) => {
      const table = tables[tab]; const idIndex = table.header.indexOf(idColumn);
      const index = table.rows.findIndex((row) => row[idIndex] === idValue);
      return index < 0 ? null : { index, rowNumber: index + 2, obj: Object.fromEntries(table.header.map((key, i) => [key, table.rows[index][i] ?? ''])) };
    };
    const repo = {
      async getTable(tab) { const table = tables[tab]; if (!table) throw new Error(`missing ${tab}`); return table; },
      async findById(tab, idColumn, idValue) { return find(tab, idColumn, idValue); },
      async updateCell(tab, idColumn, idValue, columnName, value) {
        const table = tables[tab]; const record = find(tab, idColumn, idValue); const column = table.header.indexOf(columnName);
        if (!record || column < 0) return false; table.rows[record.index][column] = value; return true;
      },
      async updateById(tab, idColumn, idValue, patch) {
        const table = tables[tab]; const record = find(tab, idColumn, idValue); if (!record) return null;
        const merged = { ...record.obj, ...patch }; table.rows[record.index] = table.header.map((key) => merged[key] ?? ''); return merged;
      },
      async appendRowsBatch(tab, rows) { tables[tab].rows.push(...rows.map((row) => row.slice())); },
    };
    return { repo, tables, actionRows: () => tables.ACTIONS.rows.map((row) => Object.fromEntries(ACTIONS_HEADER.map((key, i) => [key, row[i] ?? '']))) };
  }

  const invokeCall = async (outcome, extra = {}) => {
    const fixture = makeCallFixture(); __setRepoForTests(fixture.repo);
    const res = response();
    await handler({ method: 'POST', query: { novus_operation: 'operator-call-outcome' }, headers: { authorization: basic }, body: {
      action_id: 'act_call', outcome, confirm: 'RECORD_CALL_OUTCOME', ...extra,
    } }, res);
    assert.equal(res.statusCode, 200, `${outcome}: ${res.body?.error || ''}`);
    return fixture;
  };
  {
    const fixture = await invokeCall('NO_ANSWER');
    assert.equal(fixture.actionRows().find((row) => row.action_id === 'act_call').action_status, 'COMPLETED');
    assert.equal(fixture.actionRows().find((row) => row.action_type === 'RETRY_CALL')?.action_status, 'PENDING');
    ok('call NO_ANSWER completes the call and creates the central-policy retry');
  }
  for (const outcome of ['MEETING_BOOKED', 'NOT_INTERESTED']) {
    const fixture = await invokeCall(outcome);
    assert.equal(fixture.tables.AGENCIES.rows[0][2], outcome);
  }
  ok('terminal call outcomes persist MEETING_BOOKED and NOT_INTERESTED');
  {
    const due_at = new Date(Date.now() + 86400000).toISOString();
    const fixture = await invokeCall('CALL_LATER', { due_at });
    assert.equal(fixture.actionRows().find((row) => row.action_id !== 'act_call')?.due_at, due_at);
    ok('CALL_LATER creates the required future call checkpoint');
  }
  {
    const due_at = new Date(Date.now() + 86400000).toISOString();
    const fixture = await invokeCall('SPOKE_CONTINUE', { due_at, next_action_type: 'SET_NEXT_STEP' });
    assert.equal(fixture.actionRows().find((row) => row.action_id !== 'act_call')?.action_type, 'SET_NEXT_STEP');
    ok('SPOKE_CONTINUE cannot complete without an explicit future next step');
  }
  {
    const fixture = makeCallFixture(); __setRepoForTests(fixture.repo);
    const res = response();
    await handler({ method: 'POST', query: { novus_operation: 'operator-mark-meeting-booked' }, headers: { authorization: basic }, body: {
      agency_id: 'ag_call', confirm: 'MARK_MEETING_BOOKED',
    } }, res);
    assert.equal(res.statusCode, 200); assert.equal(fixture.tables.AGENCIES.rows[0][2], 'MEETING_BOOKED');
    assert.equal(fixture.actionRows().find((row) => row.action_id === 'act_call').action_status, 'CANCELLED');
    ok('manual Mark Meeting Booked persists terminal state and cancels the active call');
  }
  __setRepoForTests(null);
}

console.log(`\nNOVUS acquisition self-test passed (${passed} focused assertions).`);
