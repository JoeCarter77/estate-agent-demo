#!/usr/bin/env node
import assert from 'node:assert/strict';
import handler from '../api/novus/personalisation.js';
import { __setRepoForTests } from '../lib/sheets.mjs';
import { ACTIONS_HEADER } from '../lib/actions-store.mjs';
import { isActiveAction, reconcileActions } from '../lib/acquisition-actions.mjs';
import { buildReplyEventRow, normalizeInstantlyEmail, routeReply } from '../lib/reply-router.mjs';

process.env.NOVUS_BASIC_AUTH_USER = 'u';
process.env.NOVUS_BASIC_AUTH_PASS = 'p';
const AUTH = { authorization: `Basic ${Buffer.from('u:p').toString('base64')}` };
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const agencies = [{ agency_id: 'ag_1', agency_name: 'Test Agency' }];
const actions = [];
const rowFor = (obj) => ACTIONS_HEADER.map((key) => obj[key] ?? '');
const repo = {
  async getTable(tab) {
    if (tab !== 'ACTIONS') throw new Error(`unexpected table ${tab}`);
    return { header: [...ACTIONS_HEADER], rows: actions.map(rowFor) };
  },
  async findById(tab, key, value) {
    const rows = tab === 'AGENCIES' ? agencies : actions;
    const obj = rows.find((row) => String(row[key]) === String(value));
    return obj ? { rowNumber: rows.indexOf(obj) + 2, obj } : null;
  },
  async appendRowsBatch(tab, rows) {
    assert.equal(tab, 'ACTIONS');
    for (const row of rows) actions.push(Object.fromEntries(ACTIONS_HEADER.map((key, i) => [key, row[i] ?? ''])));
  },
  async updateById(tab, key, value, patch) {
    assert.equal(tab, 'ACTIONS');
    const row = actions.find((item) => item[key] === value);
    if (!row) return null;
    Object.assign(row, patch);
    return row;
  },
};
__setRepoForTests(repo);

async function call(operation, body) {
  const res = { statusCode: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; }, end() { return this; } };
  await handler({ method: 'POST', query: { novus_operation: operation }, headers: AUTH, body }, res);
  return res;
}

let res = await call('operator-action-create', {
  confirm: 'CREATE_ACTION', agency_id: 'ag_1', action_type: 'CALL', due_at: iso(NOW + 86400000), note: 'Call the director',
});
assert.equal(res.statusCode, 201);
assert.equal(actions.length, 1);
assert.equal(actions[0].reply_event_id, '');
assert.equal(JSON.parse(actions[0].metadata_json).manual, true);

const current = actions[0];
res = await call('operator-action-complete', {
  confirm: 'COMPLETE_ACTION', action_id: current.action_id,
  next_action: { action_type: 'FOLLOW_UP', due_at: iso(NOW + 3 * 86400000), note: 'Follow up in three days' },
});
assert.equal(res.statusCode, 200);
assert.equal(current.action_status, 'COMPLETED');
assert.ok(current.completed_at);
assert.equal(isActiveAction(current), false);
assert.equal(actions.length, 2);
assert.equal(actions[1].action_status, 'PENDING');
assert.equal(actions[1].due_at, iso(NOW + 3 * 86400000));

// A completed system-derived action with the same dedupe key is durable and
// is never recreated merely because reconciliation runs again.
const expected = { ...current, action_status: 'PENDING' };
assert.equal(reconcileActions(actions, [expected], iso(NOW + 1000)).create.length, 0);

res = await call('operator-action-snooze', {
  confirm: 'SNOOZE_ACTION', action_id: actions[1].action_id, due_at: iso(NOW + 5 * 86400000),
});
assert.equal(res.statusCode, 200);
assert.equal(actions[1].action_status, 'SNOOZED');
assert.equal(actions[1].completed_at, '');
assert.equal(isActiveAction(actions[1]), false, 'future snooze is hidden');
const dueSnooze = { ...actions[1], due_at: iso(NOW - 1000) };
assert.equal(isActiveAction(dueSnooze), true, 'snoozed action becomes active when due');
assert.equal(reconcileActions([dueSnooze], [{ ...dueSnooze, action_status: 'PENDING' }], iso(NOW)).update[0].patch.action_status, 'DUE');

const autoAck = normalizeInstantlyEmail({
  id: 'auto-1', ue_type: 2, lead: 'person@agency.test', from_address_email: 'person@agency.test',
  to_address_email_list: 'joe@novushq.co.uk', eaccount: 'joe@novushq.co.uk',
  subject: 'Automatic reply: hello', body: 'We have received your email and will respond shortly.',
});
const autoDecision = routeReply(autoAck);
assert.equal(autoDecision.classification, 'OOO_AUTOMATED');
assert.equal(autoDecision.next_action, 'NONE');
const autoRow = buildReplyEventRow(autoAck, autoDecision, { agencyId: 'ag_1', outreachId: 'out_1', now: iso(NOW) });
assert.equal(autoRow.action_status, 'NO_ACTION');
assert.equal(autoRow.next_action, 'NONE');

console.log('✅ NOVUS Action Lifecycle V2 self-test passed (manual create, complete, follow-up, snooze, durable completion, auto-ack routing).');
