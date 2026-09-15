# NOVUS Calling workspace

`/novus/calling` — Calling · Call Actions · Scripts, plus full-screen Calling Mode.
Page: `novus/calling.html`. Server: operations on `api/novus/personalisation.js`
implemented in `lib/calling-*.mjs` (the 12-function ceiling rules out new files).

## Workbook tabs (created by the page's "Set up calling tabs" button, or `npm run novus:calling-setup` to paste by hand)

| tab | one row per | notes |
|---|---|---|
| `SCRIPTS` | script **version** | `script_key` groups versions; only one row is `CURRENT`; content is frozen once a call references it |
| `OBJECTIONS` | objection **version** | `active=TRUE` rows show in Calling Mode; rewording a clicked objection makes a new version |
| `CALLS` | dial | immutable; `outcome`, `connected`, `owner_reached`, `pitched` drive the funnel; Twilio ids + recording live here |
| `CALL_OBJECTION_EVENTS` | objection encountered on a call | `source=LIVE` (clicked during the call) or `MANUAL` (added in review) |

Call follow-ups go into the existing `ACTIONS` ledger:

* phone work (`RETRY_CALL`, `CALL_PROSPECT` with `metadata_json.call_action=true`) → **Call Actions** tab (`CALLING` queue, never the generic Actions list)
* `SEND_INFORMATION`, `PREPARE_MEETING` → generic **Actions** (Joe's manual queue)
* `NOT_INTERESTED` / `BOOKED_MEETING` also set `AGENCIES.current_pipeline_status`, exactly like the legacy drawer outcome

**Gatekeeper/owner classification.** Once a call connects, Calling Mode shows a
plain answer screen ("Hi, is that {{first_name}}?") with two buttons —
`OWNER` and `GATEKEEPER` — before the sales script appears. `OWNER` opens the
lead's assigned script and the objection sidebar as before. `GATEKEEPER` opens
a fixed, global gatekeeper script (not versioned, not lead-specific) with a
single `GOT THROUGH TO OWNER` button that switches the *same* call into the
owner script + sidebar without ending the call or opening a new `CALLS` row.
This is tracked on `CALLS` independently of the outcome-derived
`owner_reached` column: `gatekeeper_reached`, `gatekeeper_reached_at`,
`owner_reached_at`, `owner_reach_source` (`DIRECT` | `VIA_GATEKEEPER`) —
appended at the end of `CALLS_HEADER` so an existing production sheet only
needs those four header cells added to row 1 after `updated_at`, never a
column insert that would shift existing data. `lib/calling-queue.mjs`'s
`scriptFunnel` exposes `gatekeeper_reached`, `owner_reached_direct`,
`owner_reached_via_gatekeeper` and `gatekeeper_to_owner_pct` for the
conversion numbers.

Suppression is **derived** from `CALLS` (`DO_NOT_CALL`, `WRONG_NUMBER`, `NOT_INTERESTED`, `BOOKED_MEETING`) plus terminal pipeline status and the agency-level all-contact flag `AGENCIES.suppression_status=SUPPRESSED`. An **email** opt-out (`REPLY_EVENTS`) is channel-specific: it is shown on the lead as context, never as phone suppression. Nothing is written to `AGENCIES` for it.

**Times.** Automatic callbacks/retries are computed on the Europe/London wall clock (`lib/london-time.mjs`) — "09:00 tomorrow" is 09:00 UK time in BST and GMT alike — and stored as UTC instants. Operator-chosen times come from the browser as explicit instants.

**No transactions.** `calling-save` writes the `CALLS` row first, then runs the idempotent follow-up step (`applyCallFollowups`: actions keyed by `call_id`, terminal status only if unset, objection events only if missing). The row carries `metadata_json.followups = PENDING|COMPLETE`; a retried save or `calling-repair` re-runs the step for PENDING rows from the stored row alone, so a saved call never loses its callback.

## Queue order (`lib/calling-queue.mjs`)

1. callback overdue (due before today) · 2. callback due today · 3. no-answer retry due · 4. any other due call action · 5. never called.
A callback whose time has not arrived is scheduled work (Call Actions), not queue.

## Outcome semantics (`lib/calling-outcomes.mjs`)

| outcome | pitched | owner reached | creates |
|---|---|---|---|
| No answer | no | no | `RETRY_CALL` next day 09:00 London |
| Gatekept | no | no | `RETRY_CALL` +14 days |
| Owner unavailable | no | no | `CALL_PROSPECT` at chosen time |
| Callback requested | if decision-maker | asked | `CALL_PROSPECT` at chosen time |
| More information | yes | yes | `SEND_INFORMATION` now + `CALL_PROSPECT` (+2 working days, editable) |
| Not interested | yes | yes | agency → `NOT_INTERESTED`; reason required |
| Booked meeting | yes | yes | agency → `MEETING_BOOKED`; `PREPARE_MEETING` |
| Wrong number | no | no | number never dialled again |
| Not the decision-maker | override | no | `CALL_PROSPECT` to the referred person if a name/phone was captured |
| Do not call again | override | asked | removed from all calling queues |

## Browser calling (Twilio)

Env: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (existing), `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`,
`TWILIO_TWIML_APP_SID`, `TWILIO_CALLER_ID`, `NOVUS_PUBLIC_BASE_URL`. See `.env.example`.
Without them the page runs in manual mode and says which are missing.

Twilio Console: create a TwiML App with Voice Request URL
`https://<host>/api/novus/webhooks/voice-outbound` (POST). The TwiML sets the
status (`…/voice-outbound-status`) and recording (`…/voice-outbound-recording`)
callbacks itself. All three are rewrites in `vercel.json` onto
`personalisation.js` operations, excluded from Basic Auth by `middleware.js`
and verified by `X-Twilio-Signature`.

Flow: `calling-start` opens the `CALLS` row → `Device.connect({ params: { call_id } })` →
TwiML dials the number **stored on that row** with `record="record-from-answer-dual"` →
status/recording webhooks patch the row by parent `CallSid` → `calling-save`
patches the outcome onto the same row (cell writes, so concurrent webhook
patches never clobber each other). Only the **RecordingSid** is stored — never
Twilio's media URL. Recordings stream through
`?novus_operation=calling-recording&call_id=…` (Basic Auth), which rebuilds
the URL and authenticates server-side, so no Twilio credential or public media
URL reaches the browser. Switch on **Enforce HTTP Auth on media URLs** in the
Twilio Console (Voice → Settings) so the media URLs are useless without the
account credentials.

## Tests

`npm run novus:calling-selftest` — hermetic (in-memory workbook, signed fake Twilio webhooks).
