# Reply-ingest incident — 7 September 2026

## Proven root cause

The affected message is Instantly email `01a07b2c-1a22-7af1-a335-d861fcfd6ba0`, received at `2026-09-07T09:21:23Z` on thread `77-h9Mp0NIBN5ovZlyReFbDF46` for Morris Armitage Estate Agents.

The exact provider shape was:

- `ue_type=2` (received)
- `lead=simon@morrisarmitage.co.uk`
- `from=simon.morris@morrisarmitage.co.uk`
- `to/eaccount=joe@trynovus.co.uk`
- reply: “Morning Please do. Many thanks…”
- immediately preceding NOVUS CTA: “Want me to send it over?”

The production dry-run returned this id as `direction_unknown`. The old direction gate required `from === lead`, so the legitimate alternate sender caused the message to stop before idempotency, OUTBOUND matching, KV claim, REPLY_EVENTS append, classification, action routing, and `executeSendDemo`. It was not a Sheets append or KV failure: neither was attempted. It was not outside the 50-email window: the received-only poll returned 19 messages.

The fix accepts this shape only when three exact facts agree: Instantly says received, the message was delivered to the exact per-message NOVUS `eaccount`, and the sender is external. It does not trust an arbitrary sender or use fuzzy matching.

## Matching and durability

Matching now uses the strongest exact evidence available, in order:

1. `Instantly lead_id` → `OUTBOUND.instantly_lead_id`
2. exact `thread_id` → a previously matched REPLY_EVENTS journey
3. exact normalized Instantly `lead` → `OUTBOUND.outreach_contact_email`

An exact unique result continues normally. An ambiguous or absent result is appended to REPLY_EVENTS with blank agency/outreach identity, `OTHER_UNCLEAR`, `MANUAL_REVIEW`, `CRITICAL`, and `UNRESOLVED_INBOUND_{AMBIGUOUS|UNMATCHED}`. The Command Centre presents orphan reply events as “Unresolved inbound reply — needs matching.” Nothing is associated by fuzzy inference.

## Pagination and reconciliation

The old poll fetched one descending page of 50. More than 50 arrivals between successful runs therefore created a permanent blind spot. The poll now follows Instantly's returned `next_starting_after` cursor, using 100-item pages, bounded to 20 pages (19 when classification reserves one request for thread context), and reports `pages`, `truncated`, and `next_starting_after` explicitly. This stays within the provider's documented 20 requests/minute limit. A bounded continuation passes that returned cursor back as `starting_after`; idempotency makes overlapping continuation passes safe.

The authenticated dry-run accepts a bounded `days` window (default seven), performs the same paginated comparison, writes nothing, and reports received examined, already persisted, missing exact matches, unmatched, ambiguous, and would-be `POSITIVE_SEND_DEMO` events. Dry-run never calls automatic execution.

After that report is approved, the separately confirmed `instantly-reply-reconcile` POST (`confirm=RECONCILE_REPLIES_NO_SEND`) uses the same seven-day window and matching/idempotency rules to persist missing matched, unmatched, and ambiguous replies. It deliberately has no call to `runAutoSendDemo`; it returns `historical_auto_execution=false` and `auto_send_attempts=0`. A later ordinary poll sees every backfilled Instantly id as a duplicate, so historical rows cannot be sent indirectly on the next poll either.

## Live trigger audit

There is no reply-poll scheduler in this repository. `vercel.json` schedules only `/api/novus/intelligence/finalize` at `0 3 * * *`; the Command Centre is statically prevented from calling the live poll route. The live route requires Basic Auth plus `X-NOVUS-REPLY-POLLER-SECRET`, so its present trigger is external or manual, but the repository does not identify it.

The last successful run that can be proven from application evidence happened after the Oakheart inbound at `2026-09-07T10:24:02Z`: that reply has a durable REPLY_EVENTS id and the resulting demo send occurred at approximately `10:24:14Z`. This does not establish a frequency. Failures are returned to the caller and logged, but there is no durable poll-run ledger or configured alert in this repository, so failed invocations are not reliably observable here.

## First reconciliation evidence

The pre-change production dry-run examined the current 19-message received set: 16 were already persisted, two old test-lead messages were unmatched, and the Morris Armitage message was the sole direction rejection. Applying the corrected gate and exact email fallback yields the review-only reconciliation projection: 19 examined, 16 already persisted, one missing exact match, two unmatched, zero ambiguous, and one would classify `POSITIVE_SEND_DEMO`. No historical send has been run. A post-deployment dry-run is still required before any historical backfill is enabled.
