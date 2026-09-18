# NOVUS Calling workspace

`/novus/calling` — Calling · Call Actions · Scripts · Calling Analytics, plus full-screen Calling Mode.
Page: `novus/calling.html`. Server: operations on `api/novus/personalisation.js`
implemented in `lib/calling-*.mjs` (the 12-function ceiling rules out new files).

## Workbook tabs (created by the page's "Set up calling tabs" button, or `npm run novus:calling-setup` to paste by hand)

| tab | one row per | notes |
|---|---|---|
| `SCRIPTS` | script **version** | `script_key` groups versions; only one row is `CURRENT`; content is frozen once a call references it |
| `OBJECTIONS` | objection **version** | `active=TRUE` rows show in Calling Mode; rewording a clicked objection makes a new version |
| `CALLS` | dial | immutable; `outcome`, `connected`, `owner_reached`, `pitched` drive the funnel; Twilio ids + recording live here; `call_status=discarded` marks a technical discard that every reader ignores |
| `CALL_OBJECTION_EVENTS` | objection encountered on a call | `source=LIVE` (clicked during the call) or `MANUAL` (added in review) |

Call follow-ups go into the existing `ACTIONS` ledger:

* phone work (`RETRY_CALL`, `CALL_PROSPECT` with `metadata_json.call_action=true`) → **Call Actions** tab (`CALLING` queue, never the generic Actions list)
* `SEND_INFORMATION`, `PREPARE_MEETING` → generic **Actions** (Joe's manual queue)
* `NOT_INTERESTED` / `BOOKED_MEETING` also set `AGENCIES.current_pipeline_status`, exactly like the legacy drawer outcome

**Gatekeeper/owner classification.** The moment the operator presses Call
(state `connecting`, then `ringing`, then `connected`) Calling Mode shows a
plain answer screen ("Hi, is that {{first_name}}?") with two buttons —
`OWNER` and `GATEKEEPER` — plus End call and Keypad, so the first line is in
front of the operator before anyone picks up. Showing the screen records
nothing: the reach fields below are written only by those two clicks, and
`connected_at` only by Twilio's `accept` event (or a manual-mode dial). `OWNER` opens the
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

**Technical issue — discard call.** The outcome screen carries one option that is
not an outcome: "Technical issue — discard call" (keypad/Twilio/audio/browser
fault, accidental dial, IVR could not be navigated), behind the confirmation
"Discard this call as a technical issue? It will not count as an attempt and the
lead will remain available to call." `POST ?novus_operation=calling-discard`
(`confirm=DISCARD_CALL`, `call_id`/`client_key`, `agency_id`) **flags** the opened
`CALLS` row — `call_status=discarded`, `outcome` blank,
`metadata_json.discarded=true` + `discard_reason`/`discarded_at` — and
`lib/calling-store.mjs liveCallRecords()` hides it from every reader: queue
(attempts, last call, suppression), attempt numbering in `calling-start` /
`calling-save`, `scriptFunnel`, the analytics read model (not even
`unclassified`), workspace counts and the follow-up integrity list. Any
`CALL_OBJECTION_EVENTS` rows for the call are physically deleted and any ACTIONS
it created (`dedupe_key` ending `:call:<call_id>`) are `CANCELLED`; both are
normally empty because the option is offered before an outcome is saved. A
discarded call cannot be saved (`calling-save` → 409), re-dialled (the TwiML
webhook hangs up) or un-flagged by a late Twilio status callback; a repeated
discard is a no-op (`reused=true`); a call with a saved outcome cannot be
discarded (409). Why a flag and not a delete: the status/recording webhooks
patch `CALLS` by row number for seconds after hangup, and a row deletion in that
window would shift a concurrent patch onto another call. In the browser the lead
is reopened idle with a fresh `client_key` and is **not** added to the session's
done set, so it stays in the pool exactly where it was. **Retry** after a failed
dial (connect rejected, signalling error while connecting/ringing, no dialable
number — `failed` is only ever a pre-connection state) runs the same
`discardOpenedRow()` path on the failed row before opening the fresh
`client_key` / row, so a failed dial never lingers as an unclassified attempt.

**Keypad (DTMF).** The Keypad button (visible from `connecting` onwards) opens a
compact 3×4 panel under the header. Each key calls the Twilio Voice SDK's
`Call.sendDigits(digit)` on the Call object returned by `Device.connect()` — real
in-band DTMF for IVRs, nothing synthesised locally. Keys are disabled until that
Call exists, digit keys on the keyboard work while the panel is open, the panel
shows the digits sent, and closing it never touches the call.

**Due call-action notifications.** Every 60s (and on every workspace load) the page
re-reads `call_actions` from the workspace payload (server-cached 30s — the
existing ACTIONS projection, no new table or operation) and shows a small top-right
toast for each call action that is due, still active and actionable (a number, not
suppressed): "Time to call {agency}" · reason · contact · due time. At most three
are visible; the rest queue. Clicking opens that lead in Call actions (highlighted);
in Calling Mode the toast is subtler and a click defers the jump until the call is
over, never changing call state. Click or dismiss acknowledges the toast for this
browser session only (`sessionStorage`); the ACTION itself is never completed by a
toast — only by saving a call.

Suppression is **derived** from `CALLS` (`DO_NOT_CALL`, `WRONG_NUMBER`, `NOT_INTERESTED`, `BOOKED_MEETING`) plus terminal pipeline status and the agency-level all-contact flag `AGENCIES.suppression_status=SUPPRESSED`. An **email** opt-out (`REPLY_EVENTS`) is channel-specific: it is shown on the lead as context, never as phone suppression. Nothing is written to `AGENCIES` for it.

**Times.** Automatic callbacks/retries are computed on the Europe/London wall clock (`lib/london-time.mjs`) — "09:00 tomorrow" is 09:00 UK time in BST and GMT alike — and stored as UTC instants. Operator-chosen times come from the browser as explicit instants.

**No transactions.** `calling-save` writes the `CALLS` row first, then runs the idempotent follow-up step (`applyCallFollowups`: actions keyed by `call_id`, terminal status only if unset, objection events only if missing). The row carries `metadata_json.followups = PENDING|COMPLETE`; a retried save or `calling-repair` re-runs the step for PENDING rows from the stored row alone, so a saved call never loses its callback.

## Calling Analytics (`#calling-analytics`)

Read-only. `GET ?novus_operation=calling-analytics&range=today|7d|30d|all|custom[&from=YYYY-MM-DD&to=YYYY-MM-DD][&script_id=…]`
on `personalisation.js` → `lib/calling-handlers.mjs handleCallingAnalytics` → the pure
read model `lib/calling-analytics.mjs buildCallingAnalytics(tables)`. Six tab reads in
parallel (`CALLS`, `CALL_OBJECTION_EVENTS`, `SCRIPTS`, `OBJECTIONS`, `ACTIONS`, `AGENCIES`
for names), one aggregation, cached 30s per filter set and cleared by every calling write.
No new tab, no new column, no new function. Response sections: `summary`, `funnel`,
`outcomes`, `objections`, `scripts`, `gatekeeper`, `timing`, `followups`, `explorer`, `enums`.

**Filters.** Date range and `script_id` are applied server-side to every section (London-local
calendar days; `to` is inclusive). Outcome / objection / gatekeeper / owner / meeting / pitched
filters narrow only the call explorer, in the browser, so the sections above keep their true
denominators. Clicking an outcome, objection, funnel step or KPI filters the explorer.

**Denominators** (also in the module header):

| figure | numerator / denominator |
|---|---|
| calls | classified `CALLS` rows (outcome set) with `started_at` in range; opened-but-unclassified rows are reported as `unclassified`, never counted |
| connected | `connected=TRUE` |
| gatekeeper reached | `gatekeeper_reached=TRUE` |
| owner reached | `owner_reached=TRUE` **or** `owner_reach_source` ∈ {DIRECT, VIA_GATEKEEPER}; a call can be both gatekeeper- and owner-reached |
| gatekeeper → owner % | gatekeeper reached **and** owner reached / gatekeeper reached |
| owner → meeting % | `BOOKED_MEETING` / owner reached |
| pitch → meeting % | `BOOKED_MEETING` / `pitched=TRUE` (NO_ANSWER and gatekept calls are not failed pitches) |
| objection frequency | unique **owner** calls with ≥1 event for the objection family / owner calls |
| objection → meeting % | `BOOKED_MEETING` calls containing the objection / unique calls containing it |
| script objection rate | owner calls on that script with ≥1 event / owner calls on that script |
| follow-ups | actions whose `metadata_json.call_id` names a call in range; the answering call is linked by `CALLS.source_action_id` or the action's `completion_reason "(call_id)"` — nothing is inferred from agency status |

Objection events are grouped by `objection_key` (family), so a reworded objection is one line;
`event_count` (clicks) and `call_count` (unique calls) are both returned and the page ranks by
unique calls. Scripts are counted against `CALLS.script_id` exactly. Owner calls saved before the
answer screen existed have `reach_source=UNKNOWN` and are counted on neither the direct nor the
via-gatekeeper side. Timing uses `lib/london-time.mjs` (Europe/London weekday × hour).

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

## Global lead search (⌘K / Ctrl+K)

Every `/novus` page loads the shared shell — `novus/novus-shell.css`,
`novus/novus-search.js`, `novus/novus-inbound.js` (after the vendored Twilio SDK) —
and carries a search control in its topbar. The palette calls one read-only
operation, `GET ?novus_operation=lead-search&q=…` (`lib/calling-inbound.mjs
handleLeadSearch` → `lib/lead-search.mjs`), which searches every AGENCIES row
regardless of status: agency name, contact names/roles (AGENCIES + CONTACTS),
email, website/domain, town, PROBES property address / street, enquiry text and
the `agency_id`. A query that looks like a number goes through the **same phone
path the callback overlay uses** (`normalizePhoneNumber` → `findLeadsByPhone` →
`rankPhoneMatches`), then partial digit matching for a half-typed number. The
index (`buildLeadIndex`, seven tab reads in parallel: AGENCIES, CONTACTS, PROBES,
CALLS, ACTIONS, INTELLIGENCE, DIAGNOSIS) is cached in-process for 30s and cleared
by every calling write. Choosing a result opens the lead in Calling Mode
(`/novus/calling.html?lead=<agency_id>`; in place when already on the calling page).

**Phone normalisation** (`normalizePhoneNumber`): `07700 900123`, `07700900123`,
`+447700900123`, `447700900123`, `07700-900-123`, `0044…`, `+44 (0)…`, a trailing
extension and a national number typed without its 0 all normalise to
`+447700900123`. Only matching uses it; the number shown is always the stored string.
Numbers are read from every AGENCIES/CONTACTS column named *phone/mobile/tel*,
referral numbers on ACTIONS (`metadata_json.contact_override`) and CALLS
(`referred_contact_json`), and the `phone` of every CALLS row — so a number linked
to a lead during an unknown-caller call matches automatically next time with
nothing written to AGENCIES.

## Incoming callbacks (`lib/calling-inbound.mjs`)

`api/novus/webhooks/voice-inbound.js` (the NOVUS number's Voice webhook) still
writes RAW_EVENTS + COMMUNICATIONS exactly as before, then — when browser calling
is configured — `ringInboundCall()`: `findLeadsByPhone` + `rankPhoneMatches` on the
caller id, a **CALLS row opened at ring time** (`metadata_json.direction=INBOUND`,
`metadata_json.inbound = { from, candidates, attempts, … }`, `twilio_call_sid` =
the inbound CallSid, `agency_id`/contact preset when one candidate is
overwhelmingly likely), and TwiML `<Dial answerOnBridge record="record-from-answer-dual"
action=/api/novus/webhooks/voice-inbound-action><Client>novus-operator
<Parameter call_id/></Client></Dial>`. Twilio delivers that to the open NOVUS
page as the Voice SDK's `incoming` event — **the SDK is the real-time channel**;
no polling. The `<Client>` leg's status callback and the recording callback are
the existing outbound handlers (they find the row by the parent CallSid). Without
browser calling configured the caller gets the voicemail prompt, as before.

Ranking is deterministic (`rankPhoneMatches`): last **outbound** call to the lead
(≤1h +60, ≤24h +40, ≤7d +20), callback expected (last outcome NO_ANSWER /
OWNER_UNAVAILABLE / CALLBACK_REQUESTED / GATEKEPT / MORE_INFO or an active call
action) +10, the number being a specific contact's +5, latest activity as tie-break.
The top candidate is **preselected** when it is the only one or leads by ≥20.
Duplicate records on one number stay separate candidates; nothing is merged.

Browser (`novus/novus-inbound.js`, which owns the one `Twilio.Device` per page —
`calling.html` dials through `NovusVoice.ready()`'s Device, and the token now
grants `incoming.allow`): the overlay reads `GET ?novus_operation=calling-inbound
&call_id=…` (caller, ranked candidates with role / last call / probe property /
diagnosis summary, flags) and posts `?novus_operation=calling-inbound-intent`
(`confirm=INBOUND_CALL`, `intent=decline|handoff|answer|link`, optional
`agency_id`/`contact_name`/`contact_role`/`script_id`).

* **Answer on calling.html** → `call.accept()`, then `answerInbound()` builds the
  same `CALL` object `beginCall()` builds (lead from the workspace payload, assigned
  script, `call_id` of the ring row) and opens the **existing** Calling Mode — answer
  screen, script, objections, keypad, outcome, follow-ups, all unchanged.
  `calling-save` patches the outcome onto the ring row (an inbound row may adopt
  the agency chosen at answer/link time; outbound rows still never change agency).
* **Answer on any other page** → intent `handoff`, the ring is rejected, the page
  goes to `/novus/calling.html?inbound=<call_id>&lead=<agency_id>`. Rejecting ends
  the `<Dial>`; the Dial action (`handleVoiceInboundAction`, a `vercel.json`
  rewrite onto `personalisation.js?novus_operation=twilio-voice-inbound-action`)
  sees the handoff flag and **rings again** ("Connecting you now." once); the
  calling page auto-answers the re-ring. The same re-ring covers a refresh mid-ring
  or a page that had not registered yet (`failed`/`canceled` inside 45s), bounded
  by `MAX_RING_ATTEMPTS`; then voicemail. `completed` → `<Hangup/>`; `no-answer` →
  voicemail (`inbound.result=missed`); declined → voicemail.
* **Multiple matches** → "Incoming callback — N possible leads", pick then Answer.
  **Unknown caller** → Answer / Search leads / Dismiss; Answer opens Calling Mode as
  "Unknown caller" with **Link to lead** (⌘K in pick mode) available during or after
  the call; saving requires a linked lead.
* **Never over a live call**: the SDK refuses a second incoming while a Twilio call
  is up (busy → voicemail); a manual-mode call or a half-logged outcome is reported
  by `NovusVoice.isBusy()` and the callback is declined to voicemail with a toast.

A missed/declined inbound ring has no outcome by design: it is not an attempt,
does not move the queue, and is excluded from analytics `unclassified`; the lead's
search row shows "Called back … · missed". Answered callbacks with an outcome
count in the funnel like any call (`metadata_json.direction=INBOUND` distinguishes
them). No tab or column was added.

## Tests

`npm run novus:calling-selftest` — hermetic (in-memory workbook, signed fake Twilio webhooks).
`npm run novus:calling-analytics-selftest` — hermetic denominator tests for the analytics read model and its operation.
`npm run novus:lead-search-selftest` — phone normalisation, ⌘K search, phone-match ranking, and the inbound flow end to end through the real handlers (ring → overlay read → handoff re-ring → answer → `calling-save` on the same row; unknown caller linked mid-call).
`npm run novus:sidebar-parity-selftest` — the four Calling tabs on both sidebars.
