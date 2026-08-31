// Hermetic NOVUS reply-router tests. Run: npm run novus:reply-router-selftest
//
// Fully offline: no network, no Google Sheets, no Instantly, no AI. The only
// repo used is an in-test fake that records every call, so any accidental
// Sheets access shows up as a failed assertion.

import assert from 'node:assert/strict';
import {
  REPLY_EVENTS_HEADER,
  REPLY_EVENTS_TAB,
  REPLY_EVENTS_IDEMPOTENCY_COLUMN,
  OUTREACH_ID_SOURCE_COLUMN,
  CLASSIFICATIONS,
  NEXT_ACTIONS,
  PRIORITIES,
  SUPPRESSION_TYPES,
  ACTION_STATUSES,
  ROUTING_TABLE,
  DEFAULT_DRY_RUN,
  normalizeReplyEmail,
  detectOptOut,
  routeReply,
  buildReplyEventRow,
  persistReplyEvent,
  findExistingReplyEvent,
  processReplyEmail,
} from '../lib/reply-router.mjs';
import { OUTBOUND_HEADER, OUTBOUND_STATUSES } from '../lib/outbound.mjs';

let assertions = 0;
function check(fn) { fn(); assertions += 1; }

// --- Schema matches the REPLY_EVENTS tab exactly -----------------------------
const EXPECTED_HEADER = [
  'reply_event_id', 'instantly_email_id', 'agency_id', 'outreach_id', 'lead_email',
  'campaign_id', 'thread_id', 'received_at', 'subject', 'body_text', 'is_auto_reply',
  'classification', 'confidence', 'suppression_type', 'next_action', 'priority',
  'processed_at', 'action_status', 'action_completed_at', 'classifier_reason',
  'error', 'notes',
];
check(() => assert.deepEqual(REPLY_EVENTS_HEADER, EXPECTED_HEADER, 'header must match the tab exactly'));
check(() => assert.equal(REPLY_EVENTS_TAB, 'REPLY_EVENTS'));
check(() => assert.equal(REPLY_EVENTS_IDEMPOTENCY_COLUMN, 'instantly_email_id'));

// The routing table only ever names values from the agreed enums.
for (const [classification, route] of Object.entries(ROUTING_TABLE)) {
  check(() => assert.ok(CLASSIFICATIONS.includes(classification), `${classification} in enum`));
  check(() => assert.ok(NEXT_ACTIONS.includes(route.next_action), `${route.next_action} in enum`));
  check(() => assert.ok(PRIORITIES.includes(route.priority), `${route.priority} in enum`));
  check(() => assert.ok(SUPPRESSION_TYPES.includes(route.suppression_type)));
}
check(() => assert.equal(Object.keys(ROUTING_TABLE).length, CLASSIFICATIONS.length, 'every classification is routed'));

// No STOP-style action exists: Instantly owns the automatic sequence stop.
check(() => assert.ok(!NEXT_ACTIONS.some((a) => /STOP|PAUSE/i.test(a)), 'no stop/pause action'));

// NOVUS-local suppression rides on a value OUTBOUND already supports, so no
// schema change is needed for opt-outs to survive an Instantly recreate.
check(() => assert.ok(OUTBOUND_STATUSES.includes('SUPPRESSED')));
check(() => assert.ok(OUTBOUND_HEADER.includes(OUTREACH_ID_SOURCE_COLUMN), 'outreach_id sources from OUTBOUND.outbound_id'));
check(() => assert.ok(!OUTBOUND_HEADER.includes('outreach_id'), 'OUTBOUND has no literal outreach_id column'));

// --- Normalisation is defensive about an unknown payload shape ---------------
check(() => assert.deepEqual(normalizeReplyEmail(null), {
  email_id: undefined, lead_email: undefined, subject: '', body_text: '',
  is_auto_reply: false, campaign_id: undefined, thread_id: undefined, timestamp: undefined,
}));
check(() => assert.equal(normalizeReplyEmail({ body: { text: 'hi' } }).body_text, 'hi'));
check(() => assert.equal(normalizeReplyEmail({ content: 'hi' }).body_text, 'hi'));
// An unknown/missing auto-reply flag must never default to "automated", or a
// real human reply would be routed to no-action.
check(() => assert.equal(normalizeReplyEmail({}).is_auto_reply, false));
check(() => assert.equal(normalizeReplyEmail({ is_auto_reply: 'true' }).is_auto_reply, true));
check(() => assert.equal(normalizeReplyEmail({ auto_reply: 1 }).is_auto_reply, true));
check(() => assert.equal(normalizeReplyEmail({ is_auto_reply: 'no' }).is_auto_reply, false));

// --- Rule 1: auto-reply ------------------------------------------------------
const ooo = routeReply({ is_auto_reply: true, body_text: 'I am out of the office' });
check(() => assert.equal(ooo.classification, 'OOO_AUTOMATED'));
check(() => assert.equal(ooo.suppression_type, 'NONE'));
check(() => assert.equal(ooo.next_action, 'NONE'));
check(() => assert.equal(ooo.priority, 'LOW'));

// An OOO that quotes our own footer must stay OOO — auto-reply wins, and it is
// checked before opt-out matching precisely so this cannot suppress a live lead.
const oooQuoting = routeReply({ is_auto_reply: true, body_text: 'Out of office. To unsubscribe click here' });
check(() => assert.equal(oooQuoting.classification, 'OOO_AUTOMATED'));
check(() => assert.equal(oooQuoting.suppression_type, 'NONE'));

// --- Rule 2: deterministic opt-out, before any AI ----------------------------
const OPT_OUT_BODIES = [
  'please unsubscribe',
  'Remove me from your list',
  'remove my details please',
  'Do not contact me again',
  "don't contact me",
  'STOP EMAILING ME',
  "Please don't email me again",
  'Please  remove   me',           // collapsed whitespace
  'please don’t email me again', // curly apostrophe
];
for (const body of OPT_OUT_BODIES) {
  const d = routeReply({ is_auto_reply: false, body_text: body });
  check(() => assert.equal(d.classification, 'OPT_OUT', `opt-out: ${body}`));
  check(() => assert.equal(d.suppression_type, 'PERMANENT', `permanent: ${body}`));
  check(() => assert.equal(d.next_action, 'NONE', `no action: ${body}`));
  check(() => assert.equal(d.priority, 'NORMAL', `normal: ${body}`));
}
// Opt-out language in the subject counts too.
check(() => assert.equal(routeReply({ subject: 'Unsubscribe', body_text: 'thanks' }).classification, 'OPT_OUT'));
check(() => assert.ok(detectOptOut({ body_text: 'remove me' })));
check(() => assert.equal(detectOptOut({ body_text: 'sounds good, send it over' }), null));

// --- Rule 3: everything semantic is a human's problem for now ----------------
for (const body of ['Yes please send the demo', 'Can you do Tuesday at 3?', 'Not right now', 'what is this?']) {
  const d = routeReply({ is_auto_reply: false, body_text: body });
  check(() => assert.equal(d.classification, 'OTHER_UNCLEAR', `unclear: ${body}`));
  check(() => assert.equal(d.next_action, 'MANUAL_REVIEW', `review: ${body}`));
  check(() => assert.equal(d.priority, 'HIGH', `high: ${body}`));
  check(() => assert.equal(d.suppression_type, 'NONE'));
}

// --- Row construction --------------------------------------------------------
const reply = normalizeReplyEmail({
  id: 'em_1', lead: 'a@b.com', subject: 'Re: hi', body: { text: 'remove me' },
  campaign_id: 'c1', thread_id: 't1', timestamp: '2026-08-31T10:00:00Z',
});
const row = buildReplyEventRow(reply, routeReply(reply), { replyEventId: 'rpl_test', now: '2026-08-31T10:00:01Z' });
check(() => assert.deepEqual(Object.keys(row), EXPECTED_HEADER, 'row key order matches the tab'));
check(() => assert.equal(row.instantly_email_id, 'em_1'));
check(() => assert.equal(row.classification, 'OPT_OUT'));
check(() => assert.equal(row.suppression_type, 'PERMANENT'));
// OPT_OUT is PENDING, not NO_ACTION: NOVUS still owes a suppression write.
check(() => assert.equal(row.action_status, 'PENDING'));
check(() => assert.ok(ACTION_STATUSES.includes(row.action_status)));
check(() => assert.equal(row.is_auto_reply, 'FALSE'));
check(() => assert.equal(row.action_completed_at, ''));
// No match step yet, so identity fields stay blank rather than guessed.
check(() => assert.equal(row.agency_id, ''));
check(() => assert.equal(row.outreach_id, ''));

const oooRow = buildReplyEventRow({ email_id: 'em_2', is_auto_reply: true }, routeReply({ is_auto_reply: true }), { now: 'T' });
check(() => assert.equal(oooRow.action_status, 'NO_ACTION'));
check(() => assert.equal(oooRow.is_auto_reply, 'TRUE'));
const unclearRow = buildReplyEventRow({ email_id: 'em_3' }, routeReply({ body_text: 'hmm' }), { now: 'T' });
check(() => assert.equal(unclearRow.action_status, 'REVIEW'));
check(() => assert.equal(unclearRow.confidence, '', 'no confidence score without a model'));

// --- Persistence is dry-run by default and never touches Sheets --------------
function fakeRepo(existing = null) {
  return {
    calls: [],
    async findById(tab, col, val) { this.calls.push(['findById', tab, col, val]); return existing; },
    async appendRecord(tab, obj) { this.calls.push(['appendRecord', tab, obj]); },
    async updateById() { this.calls.push(['updateById']); throw new Error('REPLY_EVENTS rows are never updated'); },
  };
}

check(() => assert.equal(DEFAULT_DRY_RUN, true));

let repo = fakeRepo();
let result = await persistReplyEvent(row); // no options at all
check(() => assert.equal(result.dryRun, true));
check(() => assert.equal(result.persisted, false));
check(() => assert.equal(result.skipped, 'dry_run'));

repo = fakeRepo();
result = await persistReplyEvent(row, { repo }); // repo supplied but still dry-run
check(() => assert.equal(result.persisted, false));
check(() => assert.deepEqual(repo.calls, [], 'dry-run makes ZERO repo calls — no read, no write'));

// Live mode is opt-in and demands a repo.
await assert.rejects(() => persistReplyEvent(row, { dryRun: false }), /requires a repo/);
assertions += 1;

// Live append happens only after the idempotency check.
repo = fakeRepo(null);
result = await persistReplyEvent(row, { repo, dryRun: false });
check(() => assert.equal(result.persisted, true));
check(() => assert.deepEqual(repo.calls[0], ['findById', 'REPLY_EVENTS', 'instantly_email_id', 'em_1']));
check(() => assert.equal(repo.calls[1][0], 'appendRecord'));
check(() => assert.equal(repo.calls.length, 2));

// Duplicate external event: no second row, no update, nothing executed.
repo = fakeRepo({ obj: { ...row, notes: 'already stored' } });
result = await persistReplyEvent(row, { repo, dryRun: false });
check(() => assert.equal(result.persisted, false));
check(() => assert.equal(result.skipped, 'duplicate_instantly_email_id'));
check(() => assert.ok(!repo.calls.some((c) => c[0] === 'appendRecord'), 'no append on duplicate'));
check(() => assert.ok(!repo.calls.some((c) => c[0] === 'updateById'), 'existing rows are never overwritten'));

await assert.rejects(() => findExistingReplyEvent(fakeRepo(), '  '), /instantly_email_id is required/);
assertions += 1;

// --- One email = one row: a later reply on the same thread is a NEW event ----
const first = await processReplyEmail({ id: 'em_10', thread_id: 't9', body: 'hello' });
const second = await processReplyEmail({ id: 'em_11', thread_id: 't9', body: 'following up' });
check(() => assert.notEqual(first.row.reply_event_id, second.row.reply_event_id));
check(() => assert.notEqual(first.row.instantly_email_id, second.row.instantly_email_id));
check(() => assert.equal(first.row.thread_id, second.row.thread_id));
check(() => assert.equal(first.persistence.dryRun, true));
check(() => assert.equal(second.persistence.persisted, false));

// --- The decision object is exactly the agreed five keys ---------------------
check(() => assert.deepEqual(
  Object.keys(routeReply({ body_text: 'anything' })).sort(),
  ['classification', 'next_action', 'priority', 'reason', 'suppression_type'],
));

console.log(`\n✅ NOVUS reply-router self-test passed (${assertions} focused assertions).`);
