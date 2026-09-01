// Hermetic NOVUS REPLY_EVENTS persistence tests.
// Run: npm run novus:reply-persistence-selftest
//
// Fully offline. fetch is stubbed; the repo is a fake in-memory sheet that
// records EVERY call. Writes other than appendRecord('REPLY_EVENTS', ...) THROW,
// so an accidental OUTBOUND update or Instantly write fails the suite rather
// than passing quietly.

import assert from 'node:assert/strict';
import { pollInstantlyReplies } from '../lib/instantly-reply-poll.mjs';
import {
  REPLY_EVENTS_HEADER,
  loadProcessedReplyEventIds,
  validateReplyEventRow,
  buildReplyEventRow,
  routeReply,
  normalizeInstantlyEmail,
} from '../lib/reply-router.mjs';
import { OUTBOUND_HEADER } from '../lib/outbound.mjs';
import { createMemoryClaimStore, __setClaimStoreForTests } from '../lib/reply-claim.mjs';


// The live poll and live SEND_DEMO now REQUIRE a cross-instance claim store and
// fail closed without one (lib/reply-claim.mjs). This file tests other
// behaviour, so it injects the offline in-memory store to satisfy that
// dependency; contention itself is proven in
// scripts/novus-reply-concurrency-selftest.mjs. A fresh store per scenario
// keeps each case independent — a claim held from an earlier scenario in this
// same file is not the race under test here.
function freshClaims() {
  const store = createMemoryClaimStore();
  __setClaimStoreForTests(store);
  return store;
}
freshClaims();

const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('unstubbed network access is forbidden in this self-test'); };

let assertions = 0;
function check(fn) { fn(); assertions += 1; }

// --- Fixtures ---------------------------------------------------------------
const REAL_REPLY = {
  id: '01a0596e-d338-72e6-a586-98eac9e4ba20',
  timestamp_email: '2026-08-31T20:07:11.000Z',
  subject: 'Re: TEST',
  from_address_email: 'joedcarter1@gmail.com',
  to_address_email_list: 'joe@novushq.co.uk',
  lead: 'joedcarter1@gmail.com',
  campaign_id: 'ba02b5cd-f734-465a-9251-1a565270b876',
  thread_id: 'ba-AayEOdow6Hjmghl06cSGgbe',
  eaccount: 'joe@novushq.co.uk',
  ue_type: 2,
  is_unread: 1,
  content_preview: 'Yes send On Mon, 31 Aug 2026 at 21:01, Joe Carter <joe@novushq.co.uk> wrote: >',
};

// ue_type claims received, addresses disagree -> UNKNOWN.
const CONTRADICTORY = { ...REAL_REPLY, id: 'contradictory-1', from_address_email: 'stranger@elsewhere.com' };
const UNMATCHED_REPLY = { ...REAL_REPLY, id: 'unmatched-1', from_address_email: 'nobody@nowhere.com', lead: 'nobody@nowhere.com' };

function outboundRow(overrides = {}) {
  const obj = Object.fromEntries(OUTBOUND_HEADER.map((k) => [k, '']));
  return { rowNumber: 2, obj: { ...obj, ...overrides } };
}

const MATCHING_OUTBOUND = outboundRow({
  outbound_id: 'obd_test_replyrouter',
  agency_id: 'ag_test_replyrouter',
  probe_id: 'prb_test_replyrouter',
  outreach_contact_email: 'joedcarter1@gmail.com',
  outbound_status: 'SENT',
  demo_url: 'https://demo.getnovus.co.uk/test-1',
});

// A second OUTBOUND row for the same email -> AMBIGUOUS.
const DUPLICATE_OUTBOUND = outboundRow({
  outbound_id: 'obd_test_duplicate',
  agency_id: 'ag_test_replyrouter',
  outreach_contact_email: 'JoeDCarter1@Gmail.com',
  outbound_status: 'SENT',
});

// --- Fakes ------------------------------------------------------------------
function fakeRepo({ outbound = [], replyEvents = [], header = REPLY_EVENTS_HEADER, failAppends = 0 } = {}) {
  // Each scenario is an independent fixture, so it gets an independent claim
  // store too — a claim left over from an earlier scenario in this file is not
  // the race under test here. Real contention lives in
  // scripts/novus-reply-concurrency-selftest.mjs.
  freshClaims();
  const rows = replyEvents.map((obj) => header.map((k) => obj[k] ?? ''));
  let remainingFailures = failAppends;
  return {
    calls: [],
    appended: [],
    async getTable(tab) {
      this.calls.push(['getTable', tab]);
      if (tab !== 'REPLY_EVENTS') throw new Error(`unexpected getTable: ${tab}`);
      return { header, rows: rows.slice(), allValues: [header, ...rows] };
    },
    async getRecords(tab) {
      this.calls.push(['getRecords', tab]);
      if (tab === 'OUTBOUND') return outbound;
      throw new Error(`unexpected getRecords: ${tab}`);
    },
    async findById(tab, idColumn, idValue) {
      this.calls.push(['findById', tab, idColumn, idValue]);
      if (tab !== 'REPLY_EVENTS') throw new Error(`unexpected findById: ${tab}`);
      const idx = header.indexOf(idColumn);
      const row = rows.find((r) => (r[idx] ?? '') === idValue);
      if (!row) return null;
      const obj = {};
      header.forEach((k, i) => { obj[k] = row[i] ?? ''; });
      return { rowNumber: 2, obj };
    },
    async appendRecord(tab, obj) {
      this.calls.push(['appendRecord', tab]);
      if (tab !== 'REPLY_EVENTS') throw new Error(`FORBIDDEN write to ${tab}`);
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error('simulated Sheets append failure');
      }
      rows.push(header.map((k) => obj[k] ?? ''));
      this.appended.push(obj);
      return obj;
    },
    // Any other write path must be loud.
    async updateCell() { throw new Error('FORBIDDEN: updateCell during reply poll'); },
    async updateById() { throw new Error('FORBIDDEN: updateById during reply poll'); },
    async writeRowsBatch() { throw new Error('FORBIDDEN: writeRowsBatch during reply poll'); },
    async writeCellsBatch() { throw new Error('FORBIDDEN: writeCellsBatch during reply poll'); },
    async appendRowsBatch() { throw new Error('FORBIDDEN: appendRowsBatch during reply poll'); },
  };
}

function stubFetch(emails) {
  const urls = [];
  const inits = [];
  const impl = async (url, init) => {
    urls.push(url);
    inits.push(init);
    return { ok: true, status: 200, text: async () => JSON.stringify({ items: emails }) };
  };
  return { impl, urls, inits };
}

const live = (over = {}) => ({ apiKey: 'SECRET', dryRun: false, now: 'PROCESSED_AT', ...over });

// --- 1. One new matched reply appends exactly once ---------------------------
let repo = fakeRepo({ outbound: [MATCHING_OUTBOUND] });
let { impl } = stubFetch([REAL_REPLY]);
let summary = await pollInstantlyReplies(live({ repo, fetchImpl: impl }));

check(() => assert.equal(summary.dry_run, false));
check(() => assert.equal(summary.fetched, 1));
check(() => assert.equal(summary.inbound_confirmed, 1));
check(() => assert.equal(summary.matched, 1));
check(() => assert.equal(summary.persisted, 1));
check(() => assert.equal(summary.failed, 0));
check(() => assert.equal(summary.duplicates_skipped, 0));
check(() => assert.equal(repo.appended.length, 1, 'exactly one REPLY_EVENTS row'));
check(() => assert.equal(summary.events.length, 1));
check(() => assert.equal(summary.events[0].persisted, true));

// The appended row is the exact schema, in the exact order.
const appended = repo.appended[0];
check(() => assert.deepEqual(Object.keys(appended), REPLY_EVENTS_HEADER, 'schema preserved exactly'));
check(() => assert.equal(appended.instantly_email_id, REAL_REPLY.id));
check(() => assert.equal(appended.agency_id, 'ag_test_replyrouter'));
check(() => assert.equal(appended.outreach_id, 'obd_test_replyrouter', 'outreach_id stores OUTBOUND.outbound_id'));
check(() => assert.equal(appended.lead_email, 'joedcarter1@gmail.com'));
check(() => assert.equal(appended.cleaned_reply_text, 'Yes send'));
check(() => assert.ok(appended.body_text.includes('wrote:'), 'raw body preserved'));
check(() => assert.equal(appended.classification, 'OTHER_UNCLEAR'));
check(() => assert.equal(appended.next_action, 'MANUAL_REVIEW'));
check(() => assert.equal(appended.priority, 'HIGH'));
check(() => assert.ok(/^re_/.test(appended.reply_event_id) || appended.reply_event_id.length > 0));
// received_at is Instantly's timestamp; processed_at is NOVUS processing time.
check(() => assert.equal(appended.received_at, '2026-08-31T20:07:11.000Z'));
check(() => assert.equal(appended.processed_at, 'PROCESSED_AT'));
check(() => assert.notEqual(appended.received_at, appended.processed_at));

// REPLY_EVENTS is loaded ONCE per pass for idempotency; no per-email findById.
check(() => assert.equal(repo.calls.filter((c) => c[0] === 'getTable').length, 1, 'REPLY_EVENTS read once'));
check(() => assert.equal(repo.calls.filter((c) => c[0] === 'findById').length, 0, 'no per-email tab reads'));
check(() => assert.equal(repo.calls.filter((c) => c[0] === 'getRecords').length, 1, 'OUTBOUND read once'));
// Exactly one Instantly call, and it is a GET.
check(() => assert.equal(repo.calls.filter((c) => c[0] === 'appendRecord').length, 1));

// --- 2. A second poll of the same email appends nothing ---------------------
repo = fakeRepo({ outbound: [MATCHING_OUTBOUND], replyEvents: [appended] });
({ impl } = stubFetch([REAL_REPLY]));
summary = await pollInstantlyReplies(live({ repo, fetchImpl: impl }));

check(() => assert.equal(summary.inbound_confirmed, 1));
check(() => assert.equal(summary.duplicates_skipped, 1));
check(() => assert.equal(summary.persisted, 0));
check(() => assert.equal(summary.matched, 0, 'a duplicate is skipped before matching'));
check(() => assert.equal(repo.appended.length, 0));
check(() => assert.equal(summary.skipped[0].reason, 'duplicate_reply_event'));

// --- 3. Two copies of one email inside ONE batch append once ----------------
repo = fakeRepo({ outbound: [MATCHING_OUTBOUND] });
({ impl } = stubFetch([REAL_REPLY, { ...REAL_REPLY }]));
summary = await pollInstantlyReplies(live({ repo, fetchImpl: impl }));

check(() => assert.equal(summary.fetched, 2));
check(() => assert.equal(summary.inbound_confirmed, 2));
check(() => assert.equal(summary.persisted, 1, 'in-batch duplicate appends once'));
check(() => assert.equal(summary.duplicates_skipped, 1, 'the set is updated the instant the append succeeds'));
check(() => assert.equal(repo.appended.length, 1));
check(() => assert.equal(repo.calls.filter((c) => c[0] === 'getTable').length, 1, 'still one read for the pass'));

// --- 4. UNMATCHED appends nothing -------------------------------------------
repo = fakeRepo({ outbound: [MATCHING_OUTBOUND] });
({ impl } = stubFetch([UNMATCHED_REPLY]));
summary = await pollInstantlyReplies(live({ repo, fetchImpl: impl }));

check(() => assert.equal(summary.inbound_confirmed, 1));
check(() => assert.equal(summary.unmatched, 1));
check(() => assert.equal(summary.persisted, 0));
check(() => assert.equal(summary.events.length, 0));
check(() => assert.equal(repo.appended.length, 0));
check(() => assert.ok(repo.calls.every((c) => c[0] !== 'appendRecord'), 'no append attempted'));

// --- 5. AMBIGUOUS appends nothing and chooses nothing -----------------------
repo = fakeRepo({ outbound: [MATCHING_OUTBOUND, DUPLICATE_OUTBOUND] });
({ impl } = stubFetch([REAL_REPLY]));
summary = await pollInstantlyReplies(live({ repo, fetchImpl: impl }));

check(() => assert.equal(summary.ambiguous, 1));
check(() => assert.equal(summary.matched, 0));
check(() => assert.equal(summary.persisted, 0));
check(() => assert.equal(repo.appended.length, 0));
check(() => assert.equal(summary.skipped[0].reason, 'ambiguous_outbound_match'));
check(() => assert.equal(summary.skipped[0].candidates.length, 2, 'both listed, neither chosen'));
check(() => assert.equal(summary.skipped[0].needs_manual_review, true));

// --- 6. UNKNOWN direction appends nothing -----------------------------------
repo = fakeRepo({ outbound: [MATCHING_OUTBOUND] });
({ impl } = stubFetch([CONTRADICTORY]));
summary = await pollInstantlyReplies(live({ repo, fetchImpl: impl }));

check(() => assert.equal(summary.inbound_confirmed, 0));
check(() => assert.equal(summary.skipped_not_inbound, 1));
check(() => assert.equal(summary.persisted, 0));
check(() => assert.equal(repo.appended.length, 0));
check(() => assert.equal(summary.skipped[0].reason, 'direction_unknown'));

// OUTBOUND direction (our own sent copy) is likewise never persisted.
repo = fakeRepo({ outbound: [MATCHING_OUTBOUND] });
({ impl } = stubFetch([{ ...REAL_REPLY, id: 'sent-copy-1', from_address_email: 'joe@novushq.co.uk', to_address_email_list: 'joedcarter1@gmail.com', ue_type: 1 }]));
summary = await pollInstantlyReplies(live({ repo, fetchImpl: impl }));
check(() => assert.equal(summary.skipped[0].reason, 'direction_outbound'));
check(() => assert.equal(summary.persisted, 0));
check(() => assert.equal(repo.appended.length, 0));

// --- 7. A failed append is reported and retried on the next poll ------------
repo = fakeRepo({ outbound: [MATCHING_OUTBOUND], failAppends: 1 });
({ impl } = stubFetch([REAL_REPLY]));
summary = await pollInstantlyReplies(live({ repo, fetchImpl: impl }));

check(() => assert.equal(summary.matched, 1));
check(() => assert.equal(summary.persisted, 0));
check(() => assert.equal(summary.failed, 1));
check(() => assert.equal(repo.appended.length, 0));
check(() => assert.equal(summary.events[0].persisted, false));
check(() => assert.ok(summary.events[0].error.includes('simulated Sheets append failure')));
check(() => assert.equal(summary.skipped.at(-1).reason, 'append_failed'));
check(() => assert.equal(summary.skipped.at(-1).will_retry_next_poll, true));

// The failure did NOT enter the in-pass processed set: a second copy in the
// same batch is still attempted rather than treated as already done.
repo = fakeRepo({ outbound: [MATCHING_OUTBOUND], failAppends: 1 });
({ impl } = stubFetch([REAL_REPLY, { ...REAL_REPLY }]));
summary = await pollInstantlyReplies(live({ repo, fetchImpl: impl }));
check(() => assert.equal(summary.failed, 1, 'first attempt failed'));
check(() => assert.equal(summary.persisted, 1, 'second copy retried and succeeded'));
check(() => assert.equal(summary.duplicates_skipped, 0, 'a failed id is not marked processed'));
check(() => assert.equal(repo.appended.length, 1, 'still exactly one row for this email'));

// And a later poll retries it cleanly.
repo = fakeRepo({ outbound: [MATCHING_OUTBOUND] });
({ impl } = stubFetch([REAL_REPLY]));
summary = await pollInstantlyReplies(live({ repo, fetchImpl: impl }));
check(() => assert.equal(summary.persisted, 1, 'retry on the next poll succeeds'));
check(() => assert.equal(summary.duplicates_skipped, 0));

// --- 8. Header drift aborts the pass before any append ----------------------
repo = fakeRepo({ outbound: [MATCHING_OUTBOUND], header: REPLY_EVENTS_HEADER.slice(0, -1) });
({ impl } = stubFetch([REAL_REPLY]));
await assert.rejects(
  () => pollInstantlyReplies(live({ repo, fetchImpl: impl })),
  (err) => err.header_mismatch !== undefined,
);
assertions += 1;
check(() => assert.equal(repo.appended.length, 0, 'nothing appended into a drifted tab'));
check(() => assert.ok(repo.calls.every((c) => c[0] !== 'appendRecord')));

// --- 9. Dry-run still works and writes nothing ------------------------------
repo = fakeRepo({ outbound: [MATCHING_OUTBOUND] });
({ impl } = stubFetch([REAL_REPLY]));
summary = await pollInstantlyReplies({ repo, apiKey: 'SECRET', fetchImpl: impl, now: 'T' });

check(() => assert.equal(summary.dry_run, true));
check(() => assert.equal(summary.matched, 1));
check(() => assert.equal(summary.persisted, 0));
check(() => assert.equal(summary.failed, 0));
check(() => assert.equal(repo.appended.length, 0, 'dry-run appends nothing'));
check(() => assert.ok(repo.calls.every((c) => ['getRecords', 'findById'].includes(c[0])), 'dry-run reads only'));
check(() => assert.equal(summary.proposed_events.length, 1, 'proposed_events alias preserved'));
check(() => assert.equal(summary.proposed_events, summary.events, 'same array'));
// The alias is non-enumerable so the HTTP response does not carry it twice.
check(() => assert.ok(!Object.keys(summary).includes('proposed_events')));
check(() => assert.ok(JSON.parse(JSON.stringify(summary)).proposed_events === undefined));

// Default dryRun (flag omitted entirely) must not write either.
repo = fakeRepo({ outbound: [MATCHING_OUTBOUND] });
({ impl } = stubFetch([REAL_REPLY]));
summary = await pollInstantlyReplies({ repo, apiKey: 'SECRET', fetchImpl: impl });
check(() => assert.equal(summary.dry_run, true, 'omitting dryRun does not write'));
check(() => assert.equal(repo.appended.length, 0));

// --- 10. No Instantly writes: exactly one GET, and only a read URL ----------
repo = fakeRepo({ outbound: [MATCHING_OUTBOUND] });
let stub = stubFetch([REAL_REPLY]);
summary = await pollInstantlyReplies(live({ repo, fetchImpl: stub.impl }));
check(() => assert.equal(stub.urls.length, 1, 'exactly one Instantly request per pass'));
check(() => assert.equal(stub.inits[0].method, 'GET'));
check(() => assert.ok(stub.urls[0].includes('email_type=received')));
check(() => assert.ok(!stub.urls[0].includes('latest_of_thread')));
// No API key leaked into the summary.
check(() => assert.ok(!JSON.stringify(summary).includes('SECRET')));

// --- 11. No OUTBOUND writes (the fake throws on any) ------------------------
// Proven by construction above: appendRecord rejects any tab but REPLY_EVENTS,
// and updateCell/updateById/writeRowsBatch/writeCellsBatch all throw. Assert
// the call log to make the guarantee explicit rather than implicit.
check(() => assert.ok(
  repo.calls.every((c) => ['getTable', 'getRecords', 'findById', 'appendRecord'].includes(c[0])),
  'only reads plus REPLY_EVENTS appends',
));
check(() => assert.ok(repo.calls.filter((c) => c[0] === 'appendRecord').every((c) => c[1] === 'REPLY_EVENTS')));

// --- 12. Unit-level: the once-per-pass loader -------------------------------
repo = fakeRepo({ replyEvents: [appended, { ...appended, instantly_email_id: '  ' }] });
let loaded = await loadProcessedReplyEventIds(repo);
check(() => assert.equal(loaded.header_matches, true));
check(() => assert.ok(loaded.ids.has(REAL_REPLY.id)));
check(() => assert.equal(loaded.ids.size, 1, 'blank ids are not events'));
check(() => assert.equal(repo.calls.length, 1, 'one read'));

// SCHEMA NOTE rows are not events either.
repo = fakeRepo({ replyEvents: [{ ...appended, instantly_email_id: 'SCHEMA NOTE' }] });
loaded = await loadProcessedReplyEventIds(repo);
check(() => assert.equal(loaded.ids.size, 0));

// --- 13. Unit-level: row validation -----------------------------------------
const reply = normalizeInstantlyEmail(REAL_REPLY);
const goodRow = buildReplyEventRow(reply, routeReply(reply), { agencyId: 'a', outreachId: 'o', now: 'T' });
check(() => assert.deepEqual(validateReplyEventRow(goodRow), []));

const missing = { ...goodRow };
delete missing.notes;
check(() => assert.ok(validateReplyEventRow(missing).some((e) => e.includes('missing column: notes'))));
check(() => assert.ok(validateReplyEventRow({ ...goodRow, surprise: 'x' }).some((e) => e.includes('unexpected column: surprise'))));
check(() => assert.ok(validateReplyEventRow({ ...goodRow, instantly_email_id: '' }).some((e) => e.includes('blank required value: instantly_email_id'))));

globalThis.fetch = originalFetch;
console.log(`\n✅ NOVUS REPLY_EVENTS persistence self-test passed (${assertions} focused assertions).`);
