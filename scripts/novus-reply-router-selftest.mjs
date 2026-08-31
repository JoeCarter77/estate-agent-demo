// Hermetic NOVUS reply-router tests. Run: npm run novus:reply-router-selftest
//
// Fully offline: no network, no Google Sheets, no Instantly, no AI, no sends.
// The only repo is an in-test fake recording every call, so ANY accidental
// Sheets access shows up as a failed assertion. globalThis.fetch is replaced by
// a throwing stub for the whole run to prove nothing reaches the network.

import assert from 'node:assert/strict';
import {
  REPLY_EVENTS_HEADER,
  REPLY_EVENTS_TAB,
  REPLY_EVENTS_IDEMPOTENCY_COLUMN,
  OUTREACH_ID_SOURCE_COLUMN,
  MATCH_PLAN,
  CLASSIFICATIONS,
  NEXT_ACTIONS,
  PRIORITIES,
  SUPPRESSION_TYPES,
  ACTION_STATUSES,
  DIRECTIONS,
  UE_TYPE,
  POLLER_QUERY_PLAN,
  parseUeType,
  addressRelationship,
  novusAccountsFor,
  ROUTING_TABLE,
  DEFAULT_DRY_RUN,
  extractEmails,
  cleanReplyText,
  detectDirection,
  normalizeInstantlyEmail,
  detectOptOut,
  routeReply,
  buildReplyEventRow,
  persistReplyEvent,
  findExistingReplyEvent,
  processReplyEmail,
} from '../lib/reply-router.mjs';
import { OUTBOUND_HEADER, OUTBOUND_STATUSES } from '../lib/outbound.mjs';

const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('network access is forbidden in this self-test'); };

let assertions = 0;
function check(fn) { fn(); assertions += 1; }

// ---------------------------------------------------------------------------
// THE REAL OBSERVED OBJECTS, from one controlled Instantly test exchange.
// Both arrived in the SAME API result, which is exactly why direction has to be
// deterministic: the poller sees our own sent email alongside the reply.
// ---------------------------------------------------------------------------
// Field names below are the ones confirmed present in available_fields
// (from_address_email, to_address_email_list, lead, timestamp_email, ue_type,
// eaccount, message_id, content_preview), not the abbreviated summary names.
const REAL_INBOUND = {
  id: '01a0596e-d338-72e6-a586-98eac9e4ba20',
  timestamp_email: '2026-08-31T20:07:11.000Z',
  subject: 'Re: TEST',
  from_address_email: 'joedcarter1@gmail.com',
  to_address_email_list: 'joe@novushq.co.uk',
  lead: 'joedcarter1@gmail.com',
  campaign_id: 'ba02b5cd-f734-465a-9251-1a565270b876',
  thread_id: 'ba-AayEOdow6Hjmghl06cSGgbe',
  message_id: '<CAF=inbound@mail.gmail.com>',
  eaccount: 'joe@novushq.co.uk',
  ue_type: 2,                 // Received
  is_unread: 1,
  content_preview: 'Yes send On Mon, 31 Aug 2026 at 21:01, Joe Carter <joe@novushq.co.uk> wrote: >',
};

const REAL_OUTBOUND = {
  id: 'outbound-copy-1',
  timestamp_email: '2026-08-31T20:01:00.000Z',
  subject: 'TEST',
  from_address_email: 'joe@novushq.co.uk',
  to_address_email_list: 'joedcarter1@gmail.com',
  lead: 'joedcarter1@gmail.com',
  campaign_id: 'ba02b5cd-f734-465a-9251-1a565270b876',
  thread_id: 'ba-AayEOdow6Hjmghl06cSGgbe',
  message_id: '<CAF=outbound@novushq.co.uk>',
  eaccount: 'joe@novushq.co.uk',
  ue_type: 1,                 // Sent from campaign
  is_unread: 0,
  content_preview: 'Hi Joe, quick note about your listing.',
};

// --- Schema matches the REPLY_EVENTS tab exactly -----------------------------
const EXPECTED_HEADER = [
  'reply_event_id', 'instantly_email_id', 'agency_id', 'outreach_id', 'lead_email',
  'campaign_id', 'thread_id', 'received_at', 'subject', 'body_text', 'cleaned_reply_text',
  'is_auto_reply', 'classification', 'confidence', 'suppression_type', 'next_action',
  'priority', 'processed_at', 'action_status', 'action_completed_at', 'classifier_reason',
  'error', 'notes',
];
check(() => assert.deepEqual(REPLY_EVENTS_HEADER, EXPECTED_HEADER, 'header must match the tab exactly'));
check(() => assert.equal(REPLY_EVENTS_TAB, 'REPLY_EVENTS'));
check(() => assert.equal(REPLY_EVENTS_IDEMPOTENCY_COLUMN, 'instantly_email_id'));

for (const [classification, route] of Object.entries(ROUTING_TABLE)) {
  check(() => assert.ok(CLASSIFICATIONS.includes(classification)));
  check(() => assert.ok(NEXT_ACTIONS.includes(route.next_action)));
  check(() => assert.ok(PRIORITIES.includes(route.priority)));
  check(() => assert.ok(SUPPRESSION_TYPES.includes(route.suppression_type)));
}
check(() => assert.equal(Object.keys(ROUTING_TABLE).length, CLASSIFICATIONS.length, 'every classification is routed'));

// No STOP-style action exists: Instantly owns the automatic sequence stop.
check(() => assert.ok(!NEXT_ACTIONS.some((a) => /STOP|PAUSE/i.test(a)), 'no stop/pause action'));

// NOVUS-local suppression rides on a status OUTBOUND already supports.
check(() => assert.ok(OUTBOUND_STATUSES.includes('SUPPRESSED')));
check(() => assert.ok(OUTBOUND_HEADER.includes(OUTREACH_ID_SOURCE_COLUMN), 'outreach_id sources from OUTBOUND.outbound_id'));
check(() => assert.ok(!OUTBOUND_HEADER.includes('outreach_id')));
// Matching is implemented in lib/instantly-reply-poll.mjs, email-only because
// OUTBOUND carries no campaign_id to corroborate against.
check(() => assert.equal(MATCH_PLAN.implemented, true));
check(() => assert.equal(MATCH_PLAN.method, 'EMAIL_ONLY'));
check(() => assert.equal(MATCH_PLAN.campaign_corroboration_available, false));
check(() => assert.equal(MATCH_PLAN.primary.to, 'OUTBOUND.outreach_contact_email'));

// --- Address parsing ---------------------------------------------------------
check(() => assert.deepEqual(extractEmails('joe@novushq.co.uk'), ['joe@novushq.co.uk']));
check(() => assert.deepEqual(extractEmails('Joe Carter <Joe@Novushq.co.uk>'), ['joe@novushq.co.uk']));
check(() => assert.deepEqual(extractEmails('a@b.com, c@d.com'), ['a@b.com', 'c@d.com']));
check(() => assert.deepEqual(extractEmails(['a@b.com', 'a@b.com']), ['a@b.com'], 'de-duplicated'));
check(() => assert.deepEqual(extractEmails(null), []));

// --- Direction: provider signal + address cross-check ------------------------
const inbound = normalizeInstantlyEmail(REAL_INBOUND);
const outbound = normalizeInstantlyEmail(REAL_OUTBOUND);

check(() => assert.equal(UE_TYPE.RECEIVED, 2));
check(() => assert.equal(parseUeType('2'), 2, 'string ue_type parses'));
check(() => assert.equal(parseUeType(9), null, 'unrecognised ue_type is not a signal'));
check(() => assert.equal(parseUeType(undefined), null));

// ue_type=2 + valid addresses => INBOUND
check(() => assert.equal(inbound.ue_type, 2));
check(() => assert.equal(inbound.direction, 'INBOUND', 'ue_type 2 + validated addresses'));
check(() => assert.ok(DIRECTIONS.includes(inbound.direction)));

// ue_type=1 + outbound addresses => OUTBOUND
check(() => assert.equal(outbound.ue_type, 1));
check(() => assert.equal(outbound.direction, 'OUTBOUND', 'ue_type 1 + outbound addresses'));

// ue_type=2 + CONTRADICTORY addresses => UNKNOWN, never INBOUND.
check(() => assert.equal(normalizeInstantlyEmail({
  ...REAL_INBOUND, from_address_email: 'someone.else@agency.com',
}).direction, 'UNKNOWN', 'sender is not the lead'));
check(() => assert.equal(normalizeInstantlyEmail({
  ...REAL_INBOUND, to_address_email_list: 'stranger@elsewhere.com', eaccount: '',
  }, { mailboxes: ['joe@novushq.co.uk'] }).direction, 'UNKNOWN', 'recipient is not the NOVUS account'));
check(() => assert.equal(normalizeInstantlyEmail({
  ...REAL_INBOUND, lead: 'different.lead@agency.com',
}).direction, 'UNKNOWN', 'lead does not match the sender'));

// ue_type 1/3/4 can NEVER produce INBOUND, even with inbound-shaped addresses.
for (const ueType of [1, 3, 4]) {
  const spoofed = normalizeInstantlyEmail({ ...REAL_INBOUND, ue_type: ueType });
  check(() => assert.notEqual(spoofed.direction, 'INBOUND', `ue_type ${ueType} is never INBOUND`));
  check(() => assert.equal(spoofed.direction, 'UNKNOWN', `ue_type ${ueType} contradicting addresses => UNKNOWN`));
}
// ...and the sent types agree with outbound-shaped addresses.
for (const ueType of [1, 3, 4]) {
  check(() => assert.equal(normalizeInstantlyEmail({ ...REAL_OUTBOUND, ue_type: ueType }).direction, 'OUTBOUND'));
}
check(() => assert.equal(normalizeInstantlyEmail({ ...REAL_OUTBOUND, ue_type: 2 }).direction, 'UNKNOWN',
  'received claim on our own sent copy is a contradiction'));

// Absent/unrecognised ue_type falls back to addresses alone (pre-ue_type behaviour).
check(() => assert.equal(normalizeInstantlyEmail({ ...REAL_INBOUND, ue_type: undefined }).direction, 'INBOUND'));
check(() => assert.equal(normalizeInstantlyEmail({ ...REAL_INBOUND, ue_type: 99 }).direction, 'INBOUND'));
check(() => assert.equal(normalizeInstantlyEmail({ ...REAL_OUTBOUND, ue_type: undefined }).direction, 'OUTBOUND'));

// --- eaccount validates the NOVUS account, preferred over any configured list -
check(() => assert.equal(inbound.eaccount, 'joe@novushq.co.uk'));
check(() => assert.deepEqual(novusAccountsFor({ eaccount: 'joe@novushq.co.uk' }),
  { accounts: ['joe@novushq.co.uk'], source: 'eaccount' }));
check(() => assert.equal(novusAccountsFor({ eaccount: '' }).source, 'configured', 'falls back when absent'));
check(() => assert.equal(novusAccountsFor({ eaccount: 'not-an-address' }).source, 'configured', 'falls back when unusable'));
check(() => assert.deepEqual(novusAccountsFor({ eaccount: 'Joe <Joe@Novushq.co.uk>' }).accounts, ['joe@novushq.co.uk']));

// eaccount wins over the configured list: a NEW sending identity validates with
// no code change, which is the whole point of preferring it.
const newIdentity = normalizeInstantlyEmail(
  { ...REAL_INBOUND, to_address_email_list: 'sales@novushq.co.uk', eaccount: 'sales@novushq.co.uk' },
  { mailboxes: ['joe@novushq.co.uk'] },
);
check(() => assert.equal(newIdentity.direction, 'INBOUND', 'eaccount validates an identity absent from the list'));
// With eaccount removed, the same object falls back to the list and fails.
check(() => assert.equal(normalizeInstantlyEmail(
  { ...REAL_INBOUND, to_address_email_list: 'sales@novushq.co.uk', eaccount: '' },
  { mailboxes: ['joe@novushq.co.uk'] },
).direction, 'UNKNOWN', 'fallback list does not know the new identity'));

// --- is_unread / i_status / ai_interest_value are NOT direction inputs -------
check(() => assert.equal(normalizeInstantlyEmail({ ...REAL_INBOUND, is_unread: 0 }).direction, 'INBOUND'));
check(() => assert.equal(normalizeInstantlyEmail({ ...REAL_OUTBOUND, is_unread: 1 }).direction, 'OUTBOUND'));
check(() => assert.equal(normalizeInstantlyEmail({ ...REAL_INBOUND, is_unread: undefined }).direction, 'INBOUND'));
check(() => assert.equal(normalizeInstantlyEmail({ ...REAL_INBOUND, i_status: 3, ai_interest_value: 1 }).direction, 'INBOUND'));
check(() => assert.equal(normalizeInstantlyEmail({ ...REAL_OUTBOUND, i_status: 3, ai_interest_value: 1 }).direction, 'OUTBOUND'));
// ...but is_unread is still normalised and preserved.
check(() => assert.equal(inbound.is_unread, true));
check(() => assert.equal(outbound.is_unread, false));

// --- Raw address-relationship helper ----------------------------------------
check(() => assert.equal(addressRelationship({ fromEmail: 'x@y.com', toEmails: ['z@w.com'], leadEmail: 'a@b.com' }), 'UNKNOWN'));
check(() => assert.equal(addressRelationship({ fromEmail: '', toEmails: ['joe@novushq.co.uk'], leadEmail: 'a@b.com' }), 'UNKNOWN'));
check(() => assert.equal(addressRelationship({ fromEmail: 'a@b.com', toEmails: [], leadEmail: 'a@b.com' }), 'UNKNOWN'));
// lead_email that IS the NOVUS account satisfies both tests at once -> ambiguous.
check(() => assert.equal(addressRelationship({
  fromEmail: 'joe@novushq.co.uk', toEmails: ['joe@novushq.co.uk'], leadEmail: 'joe@novushq.co.uk',
  eaccount: 'joe@novushq.co.uk',
}), 'UNKNOWN'));
// A ue_type 2 on that ambiguous pair still cannot force INBOUND.
check(() => assert.equal(detectDirection({
  ueType: 2, fromEmail: 'joe@novushq.co.uk', toEmails: ['joe@novushq.co.uk'],
  leadEmail: 'joe@novushq.co.uk', eaccount: 'joe@novushq.co.uk',
}), 'UNKNOWN'));

// --- Poller query plan: recorded, not implemented ----------------------------
check(() => assert.equal(POLLER_QUERY_PLAN.implemented, false));
check(() => assert.equal(POLLER_QUERY_PLAN.supports_received_only_filter, true));
check(() => assert.equal(POLLER_QUERY_PLAN.params.email_type, 'received'));

// --- Normalised field mapping from the REAL inbound object -------------------
check(() => assert.equal(inbound.email_id, '01a0596e-d338-72e6-a586-98eac9e4ba20'));
check(() => assert.equal(inbound.timestamp, '2026-08-31T20:07:11.000Z'));
check(() => assert.equal(inbound.subject, 'Re: TEST'));
check(() => assert.equal(inbound.from_email, 'joedcarter1@gmail.com'));
check(() => assert.deepEqual(inbound.to_emails, ['joe@novushq.co.uk']));
check(() => assert.equal(inbound.lead_email, 'joedcarter1@gmail.com'));
check(() => assert.equal(inbound.campaign_id, 'ba02b5cd-f734-465a-9251-1a565270b876'));
check(() => assert.equal(inbound.thread_id, 'ba-AayEOdow6Hjmghl06cSGgbe'));
check(() => assert.equal(inbound.is_auto_reply, false, 'absent flag must never default to automated'));
check(() => assert.equal(inbound.message_id, '<CAF=inbound@mail.gmail.com>', 'message_id preserved'));
// ue_type is preserved in provider_hints for auditability — including when the
// address cross-check overrides it, so the raw provider claim is never lost.
check(() => assert.equal(inbound.provider_hints.ue_type, 2));
check(() => assert.equal(inbound.provider_hints.eaccount, 'joe@novushq.co.uk'));
check(() => assert.equal(inbound.provider_hints.message_id, '<CAF=inbound@mail.gmail.com>'));
const contradicted = normalizeInstantlyEmail({ ...REAL_INBOUND, from_address_email: 'someone.else@agency.com' });
check(() => assert.equal(contradicted.direction, 'UNKNOWN'));
check(() => assert.equal(contradicted.provider_hints.ue_type, 2, 'the rejected claim is still auditable'));
check(() => assert.equal(contradicted.ue_type, 2, 'normalised ue_type survives an UNKNOWN verdict'));
// Fields we must never route on are still captured for audit.
const noisy = normalizeInstantlyEmail({ ...REAL_INBOUND, i_status: 3, ai_interest_value: 1, is_focused: 1 });
check(() => assert.equal(noisy.provider_hints.i_status, 3));
check(() => assert.equal(noisy.provider_hints.ai_interest_value, 1));
check(() => assert.equal(noisy.direction, 'INBOUND', 'and they change nothing'));

// --- Quoted-history cleaning on the REAL body --------------------------------
check(() => assert.equal(inbound.cleaned_reply_text, 'Yes send', 'the real preview cleans to "Yes send"'));
// Raw body is preserved verbatim — cleaning never deletes content.
check(() => assert.equal(inbound.raw_body_text, REAL_INBOUND.content_preview));
check(() => assert.ok(inbound.raw_body_text.includes('wrote:')));
check(() => assert.ok(inbound.raw_body_text.length > inbound.cleaned_reply_text.length));

check(() => assert.equal(cleanReplyText('Yes send\n> quoted line'), 'Yes send'));
check(() => assert.equal(cleanReplyText('Sounds good\n-----Original Message-----\nblah'), 'Sounds good'));
check(() => assert.equal(cleanReplyText('Interested\n\nFrom: Joe\nSent: Monday\nTo: me'), 'Interested'));
check(() => assert.equal(cleanReplyText('No markers here'), 'No markers here'));
check(() => assert.equal(cleanReplyText('   spaced   out   '), 'spaced out'));
check(() => assert.equal(cleanReplyText(''), ''));
// "From" in ordinary prose is not a quoted header (needs Sent:/To:/Subject:).
check(() => assert.equal(cleanReplyText('From the listing it looks fine'), 'From the listing it looks fine'));
// A body that is ONLY quoted history falls back to the raw text rather than
// going empty — an empty cleaned text would hide an opt-out phrase.
check(() => assert.equal(cleanReplyText('> only quoted'), '> only quoted'));

// --- Routing: the REAL reply ------------------------------------------------
// "Yes send" is plainly POSITIVE_SEND_DEMO to a human, and that is precisely
// what must NOT happen automatically: AI is not wired, so it goes to a human.
const realDecision = routeReply(inbound);
check(() => assert.equal(realDecision.classification, 'OTHER_UNCLEAR'));
check(() => assert.equal(realDecision.next_action, 'MANUAL_REVIEW'));
check(() => assert.equal(realDecision.priority, 'HIGH'));
check(() => assert.equal(realDecision.suppression_type, 'NONE'));
check(() => assert.equal(realDecision.confidence, null, 'no fabricated score without a model'));
check(() => assert.deepEqual(Object.keys(realDecision).sort(),
  ['classification', 'confidence', 'next_action', 'priority', 'reason', 'suppression_type']));

// --- Rule 1: auto-reply ------------------------------------------------------
const ooo = routeReply(normalizeInstantlyEmail({ ...REAL_INBOUND, is_auto_reply: true, content_preview: 'I am out of the office' }));
check(() => assert.equal(ooo.classification, 'OOO_AUTOMATED'));
check(() => assert.equal(ooo.confidence, 1));
check(() => assert.equal(ooo.suppression_type, 'NONE'));
check(() => assert.equal(ooo.next_action, 'NONE'));
check(() => assert.equal(ooo.priority, 'LOW'));
// Auto-reply is checked FIRST, so an OOO quoting our footer cannot suppress a
// live prospect.
const oooQuoting = routeReply(normalizeInstantlyEmail({ ...REAL_INBOUND, is_auto_reply: true, content_preview: 'Out of office. To unsubscribe click here' }));
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
  'Please do not email me again',
  'Please  remove   me',            // collapsed whitespace
  'please don’t email me again',  // curly apostrophe
];
for (const body of OPT_OUT_BODIES) {
  const d = routeReply(normalizeInstantlyEmail({ ...REAL_INBOUND, content_preview: body }));
  check(() => assert.equal(d.classification, 'OPT_OUT', `opt-out: ${body}`));
  check(() => assert.equal(d.confidence, 1, `certain: ${body}`));
  check(() => assert.equal(d.suppression_type, 'PERMANENT', `permanent: ${body}`));
  check(() => assert.equal(d.next_action, 'NONE', `no action: ${body}`));
  check(() => assert.equal(d.priority, 'NORMAL', `normal: ${body}`));
}
check(() => assert.equal(routeReply(normalizeInstantlyEmail({ ...REAL_INBOUND, subject: 'Unsubscribe' })).classification, 'OPT_OUT'));
check(() => assert.equal(detectOptOut({ cleaned_reply_text: 'sounds good, send it over' }), null));

// Opt-out matching reads CLEANED text: a positive reply above a quoted footer
// containing "unsubscribe" is NOT an opt-out.
const positiveOverFooter = normalizeInstantlyEmail({
  ...REAL_INBOUND,
  content_preview: 'Yes please send it On Mon, 31 Aug 2026 at 21:01, Joe Carter <joe@novushq.co.uk> wrote: > unsubscribe here',
});
check(() => assert.equal(positiveOverFooter.cleaned_reply_text, 'Yes please send it'));
check(() => assert.equal(routeReply(positiveOverFooter).classification, 'OTHER_UNCLEAR', 'quoted footer must not suppress'));

// --- Row construction from the REAL reply ------------------------------------
const row = buildReplyEventRow(inbound, realDecision, { replyEventId: 'rpl_test', now: '2026-08-31T20:07:12.000Z' });
check(() => assert.deepEqual(Object.keys(row), EXPECTED_HEADER, 'row key order matches the tab'));
check(() => assert.equal(row.instantly_email_id, '01a0596e-d338-72e6-a586-98eac9e4ba20'));
check(() => assert.equal(row.received_at, '2026-08-31T20:07:11.000Z'));
check(() => assert.equal(row.lead_email, 'joedcarter1@gmail.com'));
check(() => assert.equal(row.campaign_id, 'ba02b5cd-f734-465a-9251-1a565270b876'));
check(() => assert.equal(row.thread_id, 'ba-AayEOdow6Hjmghl06cSGgbe'));
check(() => assert.equal(row.body_text, REAL_INBOUND.content_preview, 'raw body preserved in the row'));
check(() => assert.equal(row.cleaned_reply_text, 'Yes send'));
check(() => assert.equal(row.is_auto_reply, 'FALSE'));
check(() => assert.equal(row.confidence, '', 'null confidence serialises to blank'));
check(() => assert.equal(row.action_status, 'REVIEW'));
check(() => assert.ok(ACTION_STATUSES.includes(row.action_status)));
check(() => assert.equal(row.action_completed_at, ''));
// No match step yet: identity fields stay blank rather than guessed.
check(() => assert.equal(row.agency_id, ''));
check(() => assert.equal(row.outreach_id, ''));
// The id factory follows the repo's existing convention.
const minted = buildReplyEventRow(inbound, realDecision, { now: 'T' });
check(() => assert.match(minted.reply_event_id, /^rpl_[0-9a-z]+_[0-9a-z]+$/));

const optOutRow = buildReplyEventRow(
  normalizeInstantlyEmail({ ...REAL_INBOUND, content_preview: 'unsubscribe' }),
  routeReply(normalizeInstantlyEmail({ ...REAL_INBOUND, content_preview: 'unsubscribe' })),
  { now: 'T' },
);
check(() => assert.equal(optOutRow.confidence, '1'));
check(() => assert.equal(optOutRow.suppression_type, 'PERMANENT'));
// PENDING, not NO_ACTION: NOVUS still owes itself a suppression write.
check(() => assert.equal(optOutRow.action_status, 'PENDING'));

// --- No live writes ----------------------------------------------------------
function fakeRepo(existing = null) {
  return {
    calls: [],
    async findById(tab, col, val) { this.calls.push(['findById', tab, col, val]); return existing; },
    async appendRecord(tab, obj) { this.calls.push(['appendRecord', tab, obj]); },
    async updateById() { this.calls.push(['updateById']); throw new Error('REPLY_EVENTS rows are never updated'); },
    async updateCell() { this.calls.push(['updateCell']); throw new Error('no cell writes'); },
  };
}

check(() => assert.equal(DEFAULT_DRY_RUN, true));

let repo = fakeRepo();
let result = await persistReplyEvent(row);
check(() => assert.equal(result.dryRun, true));
check(() => assert.equal(result.persisted, false));
check(() => assert.equal(result.skipped, 'dry_run'));

repo = fakeRepo();
result = await persistReplyEvent(row, { repo });
check(() => assert.equal(result.persisted, false));
check(() => assert.deepEqual(repo.calls, [], 'dry-run makes ZERO repo calls — no read, no write'));

await assert.rejects(() => persistReplyEvent(row, { dryRun: false }), /requires a repo/);
assertions += 1;

// Live append only after the idempotency check (not reachable in production yet).
repo = fakeRepo(null);
result = await persistReplyEvent(row, { repo, dryRun: false });
check(() => assert.equal(result.persisted, true));
check(() => assert.deepEqual(repo.calls[0], ['findById', 'REPLY_EVENTS', 'instantly_email_id', '01a0596e-d338-72e6-a586-98eac9e4ba20']));
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

// --- End-to-end on the real pair ---------------------------------------------
const processedInbound = await processReplyEmail(REAL_INBOUND);
check(() => assert.equal(processedInbound.reply.direction, 'INBOUND'));
check(() => assert.equal(processedInbound.decision.classification, 'OTHER_UNCLEAR'));
check(() => assert.equal(processedInbound.row.cleaned_reply_text, 'Yes send'));
check(() => assert.equal(processedInbound.persistence.dryRun, true));
check(() => assert.equal(processedInbound.persistence.persisted, false));

// Our own sent copy, present in the SAME API result, must not become an event.
const processedOutbound = await processReplyEmail(REAL_OUTBOUND);
check(() => assert.equal(processedOutbound.reply.direction, 'OUTBOUND'));
check(() => assert.equal(processedOutbound.decision, null, 'outbound copy is never routed'));
check(() => assert.equal(processedOutbound.row, null, 'outbound copy creates no REPLY_EVENTS row'));
check(() => assert.equal(processedOutbound.skipped, 'direction_outbound'));

// One email = one row: a later reply on the same thread is a NEW event.
const second = await processReplyEmail({ ...REAL_INBOUND, id: 'em_second', content_preview: 'following up' });
check(() => assert.notEqual(processedInbound.row.reply_event_id, second.row.reply_event_id));
check(() => assert.notEqual(processedInbound.row.instantly_email_id, second.row.instantly_email_id));
check(() => assert.equal(processedInbound.row.thread_id, second.row.thread_id));

globalThis.fetch = originalFetch;
console.log(`\n✅ NOVUS reply-router self-test passed (${assertions} focused assertions).`);
