# NOVUS acquisition operations audit — 19 Oct 2026

Scope: the real implementation (code + a read-only snapshot of the live
`operator-dashboard` and `discovery-meetings` feeds). No prospect names here —
this repo is public.

## How the journey actually works

| Stage | Entry trigger | Stored in | Next-action owner | Moves forward by | Can strand? |
|---|---|---|---|---|---|
| Identified | CSV import / scrape | AGENCIES | nobody (LEAD_POOL derives no action) | contact resolution + valid email → Prober queue | by design (resting pool) |
| Qualified / probed | Prober "Mark as sent" | PROBES, AGENCIES.probe_sent | SYSTEM (observation window) | 4-day window closes → intelligence | yes if nightly rebuild lags (225 PREPARE_OUTREACH waiting) |
| Contacted | Instantly handoff / Calling Mode dial | OUTBOUND, CAMPAIGN_*, CALLS | SYSTEM checkpoint / caller | reply poll / call outcome | no |
| Interested | reply classification / call outcome | REPLY_EVENTS, CALLS | ACTIONS row (JOE or call action) | manual reply, call | **yes** — actions sit overdue with no escalation |
| Meeting booked | call outcome BOOKED_MEETING, or "mark meeting booked" | CALLS.meeting_at, AGENCIES.current_pipeline_status | PREPARE_MEETING (assigned to the *caller*) | discovery session | **yes** — see D2–D4 |
| Attended / discovery | Meetings page session | DISCOVERY_SESSIONS | Joe | discovery-outcome | **yes** — nothing asks for the outcome |
| Proposal / decision | discovery outcome PROPOSAL_REQUESTED etc. | DISCOVERY_SESSIONS.outcome | MEETING_FOLLOW_UP only if a date was typed | — | **yes** — see D5 |
| Paid pilot / onboarding | outcome PILOT_AGREED | DISCOVERY_SESSIONS.agreed_scope_json (checklist) | nobody | — | **yes** — no onboarding action |

`MEETING_BOOKED` is a terminal lifecycle stage, so the action engine derives
nothing after a meeting is booked. Everything after that point depends on a
human remembering.

## Confirmed defects (fixed in this change unless noted)

- **D1** `operator-call-outcome` marked the call action COMPLETED *before*
  writing the follow-up; a failed append left a completed action with no next
  step. → now appends first, completes second, rolls back on failure.
- **D2** A meeting booked on a call created PREPARE_MEETING assigned to the
  caller (the setter), not the person running the meeting, and with no
  handover notes. → assigned to Joe (`admin`) with the caller's handover.
- **D3** Nothing notices a meeting whose time has passed without a recorded
  outcome. Live: one Oct meeting has no session at all; another's prep task is
  still open a month after the meeting. → surfaced as a priority ("MEETING
  HAPPENED — RECORD THE OUTCOME"), and stale prep tasks re-worded accordingly.
- **D4** "Mark meeting booked" (drawer) records no date and no prep task. →
  surfaced as an exception ("MEETING BOOKED BUT NO DATE").
- **D5** Discovery outcomes PROPOSAL_REQUESTED / FOLLOW_UP_REQUIRED /
  PILOT_AGREED etc. only create a follow-up if a date was typed. → a default
  London-working-day follow-up is now created (2 working days; next working
  day for PILOT_AGREED onboarding).
- **D6** Overdue work never escalates. Live: ~43 open human actions, nearly
  all 17–40 days overdue, including an unanswered director question from 9 Sep.
  → Your Priorities ranks by commercial urgency and keeps overdue items visible.
- **D7** Callbacks/retries live only in Calling → Call actions; email/meeting
  work only in Actions. Neither view shows everything. → one Priorities view.
- **D9** Rescheduling (snooze) an engine-derived action was silently undone by
  the next reconciliation, which rewrote `due_at` from lifecycle evidence. →
  snooze now records `metadata.rescheduled`; the reconciler keeps that date.
- **D10** Opening Calling Mode from a deep link could show the lead's owner as
  "former team member" (roster loaded after the call screen). → waits for it.
- **D8** "Calls today" counters slice the UTC date; 00:00–01:00 BST calls land
  on the wrong day. → London day in the new code (old counters noted, not touched).

## Verified working (reused, not rebuilt)

- ACTIONS ledger: dedupe_key, one active row per key, batch writers, history never deleted.
- Calling save: idempotent on `client_key`; completes the source + every open call action for the agency; creates follow-ups with London-time defaults; `followups=PENDING` repair path.
- Reconciler preserves assignees (since 77d94ba); never cancels `manual:true` rows.
- Lead ownership: append-only LEAD_OWNERSHIP replay; claim hooks in human ops only.
- Suppression: derived from CALLS (DNC / wrong number / not interested / booked) and REPLY_EVENTS opt-outs.

## Time zone (America/Los_Angeles sheet)

All writes use `valueInputOption=RAW` with ISO-8601 UTC strings and reads
return those strings unchanged; the Apps Script files do no date formatting.
The sheet's time zone therefore does **not** affect callbacks, deadlines or
reporting computed by NOVUS. It only affects humans typing dates into the
sheet or sheet formulas (`NOW()`/`TODAY()`). No code change needed; changing
the sheet setting to Europe/London is a safe manual tidy-up.

## Risks / unverified

- **Positioning conflict:** the committed founding-pilot campaign presets
  (`lib/founding-pilot-campaign.mjs`) promise "£250 back for every valuation we
  don't hit", while discovery's `FOUNDING_OFFER` is £1,500 / 60 days with no
  guaranteed number of valuations. Not changed (outreach copy needs Joe's sign-off).
- Due-call toasts in Calling Mode cover the Start call button.
- TEST agencies ("TEST - …") appear in live actions and meetings and inflate counts.
- OOO follow-ups are created unassigned (no lead owner yet) — they show as "Unassigned".
- One OOO return date parsed ~7 months out; the parser guesses a year when none is given.
- 3 replies are unmatched to any agency (dashboard global exception).
- Reply latency is hours (GitHub schedule throttling), not 15 minutes.
- Not verified here: Twilio webhook completeness on live calls, Instantly send failures (no API access locally).
