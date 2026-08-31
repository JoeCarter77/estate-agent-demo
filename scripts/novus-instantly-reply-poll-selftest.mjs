// Hermetic NOVUS inbound reply-poll tests.
// Run: npm run novus:reply-poll-selftest
//
// Fully offline. fetch is a stub that records the URL it was asked for; the
// repo is a fake that records every call and THROWS on any write method, so a
// live write fails the suite rather than passing quietly.

import assert from 'node:assert/strict';
import {
  buildReceivedEmailsUrl,
  fetchReceivedEmails,
  matchOutboundByEmail,
  campaignCorroboration,
  pollInstantlyReplies,
  DEFAULT_POLL_LIMIT,
  MATCH_METHOD_EMAIL_ONLY,
  MATCH_STATUSES,
} from '../lib/instantly-reply-poll.mjs';
import { OUTBOUND_HEADER } from '../lib/outbound.mjs';

const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('unstubbed network access is forbidden in this self-test'); };

let assertions = 0;
function check(fn) { fn(); assertions += 1; }

// --- The real controlled reply ----------------------------------------------
const REAL_REPLY = {
  id: '01a0596e-d338-72e6-a586-98eac9e4ba20',
  timestamp_email: '2026-08-31T20:07:11.000Z',
  subject: 'Re: TEST',
  from_address_email: 'joedcarter1@gmail.com',
  to_address_email_list: 'joe@novushq.co.uk',
  lead: 'joedcarter1@gmail.com',
  campaign_id: 'ba02b5cd-f734-465a-9251-1a565270b876',
  thread_id: 'ba-AayEOdow6Hjmghl06cSGgbe',
  message_id: '<CAF=inbound@mail.gmail.com>',
  eaccount: 'joe@novushq.co.uk',   // confirmed from a real object
  ue_type: 2,
  is_unread: 1,
  content_preview: 'Yes send On Mon, 31 Aug 2026 at 21:01, Joe Carter <joe@novushq.co.uk> wrote: >',
};

// Our own campaign send, which email_type=received should exclude — but the
// direction gate must catch it anyway if the filter ever fails us.
const OUR_SENT_COPY = {
  ...REAL_REPLY,
  id: 'sent-copy-1',
  from_address_email: 'joe@novushq.co.uk',
  to_address_email_list: 'joedcarter1@gmail.com',
  ue_type: 1,
};

// ue_type says received, addresses disagree -> UNKNOWN -> skipped.
const CONTRADICTORY = { ...REAL_REPLY, id: 'contradictory-1', from_address_email: 'stranger@elsewhere.com' };

function outboundRow(overrides = {}) {
  const obj = Object.fromEntries(OUTBOUND_HEADER.map((k) => [k, '']));
  return { rowNumber: 2, obj: { ...obj, ...overrides } };
}

const MATCHING_OUTBOUND = outboundRow({
  outbound_id: 'obd_123', agency_id: 'agc_9', probe_id: 'prb_7',
  outreach_contact_email: 'joedcarter1@gmail.com', outbound_status: 'SENT',
  instantly_lead_id: 'ilead_1', demo_slug: 'demo-x',
});

function fakeRepo({ outbound = [], replyEvents = [] } = {}) {
  return {
    calls: [],
    async getRecords(tab) { this.calls.push(['getRecords', tab]); return tab === 'OUTBOUND' ? outbound : replyEvents; },
    async findById(tab, col, val) {
      this.calls.push(['findById', tab, col, val]);
      return replyEvents.find((r) => r.obj[col] === val) || null;
    },
    async appendRecord(tab) { this.calls.push(['appendRecord', tab]); throw new Error('LIVE WRITE in dry-run'); },
    async appendRowsBatch(tab) { this.calls.push(['appendRowsBatch', tab]); throw new Error('LIVE WRITE in dry-run'); },
    async updateById(tab) { this.calls.push(['updateById', tab]); throw new Error('LIVE WRITE in dry-run'); },
    async updateCell(tab) { this.calls.push(['updateCell', tab]); throw new Error('LIVE WRITE in dry-run'); },
  };
}

function stubFetch(emails, { ok = true, status = 200, body } = {}) {
  const seen = { urls: [], headers: [] };
  const impl = async (url, options) => {
    seen.urls.push(url);
    seen.headers.push(options?.headers?.Authorization);
    return { ok, status, text: async () => (body !== undefined ? body : JSON.stringify({ items: emails })) };
  };
  return { impl, seen };
}

// --- 1. Received-only filtering query ----------------------------------------
const url = buildReceivedEmailsUrl();
check(() => assert.ok(url.startsWith('https://api.instantly.ai/api/v2/emails?')));
check(() => assert.ok(url.includes('email_type=received'), 'asks the API for received mail only'));
check(() => assert.ok(url.includes('limit=50')));
check(() => assert.ok(url.includes('sort_order=desc')));
check(() => assert.equal(DEFAULT_POLL_LIMIT, 50, 'bounded batch, not the whole mailbox'));
// latest_of_thread would hide a second reply on a thread; one email = one row.
check(() => assert.ok(!url.includes('latest_of_thread')));
check(() => assert.ok(buildReceivedEmailsUrl({ limit: 10 }).includes('limit=10')));

let { impl, seen } = stubFetch([REAL_REPLY]);
await fetchReceivedEmails({ apiKey: 'SECRET', fetchImpl: impl });
check(() => assert.ok(seen.urls[0].includes('email_type=received')));
check(() => assert.equal(seen.headers[0], 'Bearer SECRET'));
await assert.rejects(() => fetchReceivedEmails({ apiKey: '', fetchImpl: impl }), /INSTANTLY_REPLY_API_KEY is not set/);
assertions += 1;
// API errors surface status + message, never the key.
const errStub = stubFetch([], { ok: false, status: 401, body: JSON.stringify({ message: 'unauthorized' }) });
await assert.rejects(async () => {
  try { await fetchReceivedEmails({ apiKey: 'SECRET', fetchImpl: errStub.impl }); }
  catch (e) {
    assert.equal(e.instantly_status, 401);
    assert.equal(e.instantly_error, 'unauthorized');
    assert.ok(!JSON.stringify(e.instantly_error).includes('SECRET'));
    throw e;
  }
});
assertions += 1;

// --- 2. OUTBOUND matching ----------------------------------------------------
check(() => assert.deepEqual(MATCH_STATUSES, ['MATCHED', 'UNMATCHED', 'AMBIGUOUS']));
check(() => assert.equal(MATCH_METHOD_EMAIL_ONLY, 'EMAIL_ONLY'));
// Every field lifted from a match already exists in OUTBOUND — none invented.
const one = matchOutboundByEmail([MATCHING_OUTBOUND], 'joedcarter1@gmail.com');
check(() => assert.equal(one.status, 'MATCHED'));
check(() => assert.equal(one.match_method, 'EMAIL_ONLY'));
check(() => assert.equal(one.match.outbound_id, 'obd_123'));
check(() => assert.equal(one.match.agency_id, 'agc_9'));
check(() => assert.equal(one.match.probe_id, 'prb_7'));
check(() => assert.equal(one.match.outbound_status, 'SENT'));
for (const key of Object.keys(one.match)) {
  check(() => assert.ok(OUTBOUND_HEADER.includes(key), `${key} is a real OUTBOUND column`));
}
// Case-insensitive, trimmed.
check(() => assert.equal(matchOutboundByEmail([MATCHING_OUTBOUND], '  JoeDCarter1@Gmail.COM  ').status, 'MATCHED'));
check(() => assert.equal(matchOutboundByEmail(
  [outboundRow({ outbound_id: 'o1', outreach_contact_email: '  JoeDCarter1@Gmail.com ' })],
  'joedcarter1@gmail.com',
).status, 'MATCHED'));

// Zero matches -> UNMATCHED, never a guess. This is the expected result for the
// real test lead, which was never uploaded to OUTBOUND.
check(() => assert.equal(matchOutboundByEmail([], 'joedcarter1@gmail.com').status, 'UNMATCHED'));
check(() => assert.equal(matchOutboundByEmail([outboundRow({ outbound_id: 'o1', outreach_contact_email: 'other@x.com' })], 'joedcarter1@gmail.com').status, 'UNMATCHED'));
check(() => assert.equal(matchOutboundByEmail([MATCHING_OUTBOUND], '').status, 'UNMATCHED'));
check(() => assert.equal(matchOutboundByEmail([MATCHING_OUTBOUND], '').match, null));

// Duplicates -> AMBIGUOUS. Nothing is chosen; both are listed for a human.
const dupes = matchOutboundByEmail([
  MATCHING_OUTBOUND,
  outboundRow({ outbound_id: 'obd_456', agency_id: 'agc_9', probe_id: 'prb_8', outreach_contact_email: 'JOEDCARTER1@gmail.com', outbound_status: 'READY' }),
], 'joedcarter1@gmail.com');
check(() => assert.equal(dupes.status, 'AMBIGUOUS'));
check(() => assert.equal(dupes.match, null, 'never silently chooses between duplicates'));
check(() => assert.equal(dupes.candidates.length, 2));
check(() => assert.deepEqual(dupes.candidates.map((c) => c.outbound_id), ['obd_123', 'obd_456']));

// Campaign corroboration is advisory only — OUTBOUND stores no campaign_id.
check(() => assert.equal(campaignCorroboration('c1', 'c1'), 'MATCHES_CONFIGURED_CAMPAIGN'));
check(() => assert.equal(campaignCorroboration('c1', 'c2'), 'DIFFERENT_CAMPAIGN'));
check(() => assert.equal(campaignCorroboration('c1', ''), 'NOT_CONFIGURED'));
check(() => assert.ok(!OUTBOUND_HEADER.includes('campaign_id'), 'OUTBOUND has no campaign_id column'));

// --- 3. Full poll: the real reply, matched -----------------------------------
let repo = fakeRepo({ outbound: [MATCHING_OUTBOUND] });
({ impl } = stubFetch([REAL_REPLY]));
let summary = await pollInstantlyReplies({
  repo, apiKey: 'SECRET', fetchImpl: impl, now: 'T',
  configuredCampaignId: 'ba02b5cd-f734-465a-9251-1a565270b876',
});
check(() => assert.equal(summary.dry_run, true));
check(() => assert.equal(summary.fetched, 1));
check(() => assert.equal(summary.inbound_confirmed, 1));
check(() => assert.equal(summary.duplicates_skipped, 0));
check(() => assert.equal(summary.matched, 1));
check(() => assert.equal(summary.unmatched, 0));
check(() => assert.equal(summary.ambiguous, 0));
check(() => assert.equal(summary.proposed_events.length, 1));

const proposed = summary.proposed_events[0];
// outbound_id maps to REPLY_EVENTS.outreach_id.
check(() => assert.equal(proposed.row.outreach_id, 'obd_123'));
check(() => assert.equal(proposed.row.agency_id, 'agc_9'));
check(() => assert.equal(proposed.row.instantly_email_id, '01a0596e-d338-72e6-a586-98eac9e4ba20'));
check(() => assert.equal(proposed.row.lead_email, 'joedcarter1@gmail.com'));
check(() => assert.equal(proposed.row.campaign_id, 'ba02b5cd-f734-465a-9251-1a565270b876'));
check(() => assert.equal(proposed.row.thread_id, 'ba-AayEOdow6Hjmghl06cSGgbe'));
check(() => assert.equal(proposed.row.received_at, '2026-08-31T20:07:11.000Z'));
check(() => assert.equal(proposed.row.subject, 'Re: TEST'));
check(() => assert.equal(proposed.row.body_text, REAL_REPLY.content_preview, 'raw body preserved'));
check(() => assert.equal(proposed.row.cleaned_reply_text, 'Yes send'));
check(() => assert.equal(proposed.row.is_auto_reply, 'FALSE'));
// Deterministic-only classification: "Yes send" is obvious to a human, and that
// is exactly why it must go to a human while AI is unwired.
check(() => assert.equal(proposed.row.classification, 'OTHER_UNCLEAR'));
check(() => assert.equal(proposed.row.next_action, 'MANUAL_REVIEW'));
check(() => assert.equal(proposed.row.priority, 'HIGH'));
check(() => assert.equal(proposed.row.suppression_type, 'NONE'));
check(() => assert.equal(proposed.row.confidence, ''));
check(() => assert.ok(proposed.row.classifier_reason.length > 0));
check(() => assert.match(proposed.row.reply_event_id, /^rpl_/));
check(() => assert.equal(proposed.match_method, 'EMAIL_ONLY'));
check(() => assert.equal(proposed.campaign_corroboration, 'MATCHES_CONFIGURED_CAMPAIGN'));
check(() => assert.equal(proposed.persisted, false, 'nothing persisted in dry-run'));

// NO LIVE WRITES: only reads reached the repo.
check(() => assert.ok(repo.calls.every((c) => ['getRecords', 'findById'].includes(c[0])), 'reads only'));
check(() => assert.deepEqual(repo.calls[0], ['getRecords', 'OUTBOUND']));
check(() => assert.deepEqual(repo.calls[1], ['findById', 'REPLY_EVENTS', 'instantly_email_id', '01a0596e-d338-72e6-a586-98eac9e4ba20']));

// --- 4. Duplicate REPLY_EVENTS skip ------------------------------------------
repo = fakeRepo({
  outbound: [MATCHING_OUTBOUND],
  replyEvents: [{ rowNumber: 2, obj: { instantly_email_id: REAL_REPLY.id, reply_event_id: 'rpl_existing' } }],
});
({ impl } = stubFetch([REAL_REPLY]));
summary = await pollInstantlyReplies({ repo, apiKey: 'SECRET', fetchImpl: impl, now: 'T' });
check(() => assert.equal(summary.inbound_confirmed, 1));
check(() => assert.equal(summary.duplicates_skipped, 1));
check(() => assert.equal(summary.matched, 0, 'a duplicate is not re-matched'));
check(() => assert.equal(summary.proposed_events.length, 0, 'no second row generated'));
check(() => assert.equal(summary.skipped[0].reason, 'duplicate_reply_event'));
check(() => assert.equal(summary.skipped[0].existing_reply_event_id, 'rpl_existing'));

// --- 5. Zero match: the real test lead is not in OUTBOUND ---------------------
repo = fakeRepo({ outbound: [] });
({ impl } = stubFetch([REAL_REPLY]));
summary = await pollInstantlyReplies({ repo, apiKey: 'SECRET', fetchImpl: impl, now: 'T' });
check(() => assert.equal(summary.inbound_confirmed, 1));
check(() => assert.equal(summary.unmatched, 1));
check(() => assert.equal(summary.matched, 0));
check(() => assert.equal(summary.proposed_events.length, 0, 'UNMATCHED never guesses a row'));
check(() => assert.equal(summary.skipped[0].reason, 'no_outbound_match'));
check(() => assert.equal(summary.skipped[0].match_method, 'EMAIL_ONLY'));

// --- 6. Ambiguous duplicates flagged for manual review -----------------------
repo = fakeRepo({
  outbound: [MATCHING_OUTBOUND, outboundRow({ outbound_id: 'obd_456', outreach_contact_email: 'joedcarter1@gmail.com' })],
});
({ impl } = stubFetch([REAL_REPLY]));
summary = await pollInstantlyReplies({ repo, apiKey: 'SECRET', fetchImpl: impl, now: 'T' });
check(() => assert.equal(summary.ambiguous, 1));
check(() => assert.equal(summary.matched, 0));
check(() => assert.equal(summary.proposed_events.length, 0));
check(() => assert.equal(summary.skipped[0].reason, 'ambiguous_outbound_match'));
check(() => assert.equal(summary.skipped[0].needs_manual_review, true));
check(() => assert.equal(summary.skipped[0].candidates.length, 2));

// --- 7. Non-inbound is skipped before anything else --------------------------
repo = fakeRepo({ outbound: [MATCHING_OUTBOUND] });
({ impl } = stubFetch([OUR_SENT_COPY, CONTRADICTORY]));
summary = await pollInstantlyReplies({ repo, apiKey: 'SECRET', fetchImpl: impl, now: 'T' });
check(() => assert.equal(summary.fetched, 2));
check(() => assert.equal(summary.inbound_confirmed, 0));
check(() => assert.equal(summary.skipped_not_inbound, 2));
check(() => assert.equal(summary.proposed_events.length, 0));
check(() => assert.equal(summary.skipped[0].reason, 'direction_outbound', 'our own send is skipped'));
check(() => assert.equal(summary.skipped[1].reason, 'direction_unknown', 'contradictory ue_type is skipped'));
// Skipped-for-direction never reaches the idempotency read.
check(() => assert.ok(!repo.calls.some((c) => c[0] === 'findById'), 'no lookup for non-inbound mail'));

// --- 8. Mixed batch ----------------------------------------------------------
repo = fakeRepo({ outbound: [MATCHING_OUTBOUND] });
({ impl } = stubFetch([
  REAL_REPLY,
  OUR_SENT_COPY,
  { ...REAL_REPLY, id: 'reply-2', lead: 'nobody@nowhere.com', from_address_email: 'nobody@nowhere.com' },
  { ...REAL_REPLY, id: 'reply-3', content_preview: 'please unsubscribe' },
]));
summary = await pollInstantlyReplies({ repo, apiKey: 'SECRET', fetchImpl: impl, now: 'T' });
check(() => assert.equal(summary.fetched, 4));
check(() => assert.equal(summary.inbound_confirmed, 3));
check(() => assert.equal(summary.skipped_not_inbound, 1));
check(() => assert.equal(summary.matched, 2));
check(() => assert.equal(summary.unmatched, 1));
// The opt-out routes deterministically, with permanent NOVUS suppression.
const optOut = summary.proposed_events.find((e) => e.row.instantly_email_id === 'reply-3');
check(() => assert.equal(optOut.row.classification, 'OPT_OUT'));
check(() => assert.equal(optOut.row.suppression_type, 'PERMANENT'));
check(() => assert.equal(optOut.row.next_action, 'NONE'));
check(() => assert.equal(optOut.row.confidence, '1'));
check(() => assert.equal(optOut.row.action_status, 'PENDING', 'NOVUS still owes a suppression write'));
// OUTBOUND is read ONCE for the whole batch.
check(() => assert.equal(repo.calls.filter((c) => c[0] === 'getRecords').length, 1));
// Still no writes anywhere.
check(() => assert.ok(repo.calls.every((c) => ['getRecords', 'findById'].includes(c[0]))));

// --- 9. Auto-reply routes OOO_AUTOMATED --------------------------------------
repo = fakeRepo({ outbound: [MATCHING_OUTBOUND] });
({ impl } = stubFetch([{ ...REAL_REPLY, id: 'ooo-1', is_auto_reply: true, content_preview: 'I am out of the office' }]));
summary = await pollInstantlyReplies({ repo, apiKey: 'SECRET', fetchImpl: impl, now: 'T' });
check(() => assert.equal(summary.proposed_events[0].row.classification, 'OOO_AUTOMATED'));
check(() => assert.equal(summary.proposed_events[0].row.next_action, 'NONE'));
check(() => assert.equal(summary.proposed_events[0].row.priority, 'LOW'));
check(() => assert.equal(summary.proposed_events[0].row.action_status, 'NO_ACTION'));

// --- 10. Empty mailbox is a clean no-op --------------------------------------
repo = fakeRepo({ outbound: [MATCHING_OUTBOUND] });
({ impl } = stubFetch([]));
summary = await pollInstantlyReplies({ repo, apiKey: 'SECRET', fetchImpl: impl, now: 'T' });
check(() => assert.equal(summary.fetched, 0));
check(() => assert.equal(summary.proposed_events.length, 0));
check(() => assert.deepEqual(repo.calls, [], 'an empty batch does not even read OUTBOUND'));

globalThis.fetch = originalFetch;
console.log(`\n✅ NOVUS Instantly reply-poll self-test passed (${assertions} focused assertions).`);
