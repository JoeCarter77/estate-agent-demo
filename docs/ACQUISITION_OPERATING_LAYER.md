# NOVUS acquisition operating layer

This layer is a deterministic projection around the existing probe, Instantly,
reply, demo and manual-reply implementations. It makes no AI/model calls and it
does not replace SEND_DEMO, reply classification, probe grading or Instantly
handoff.

## Lifecycle precedence

`resolveLifecycleStage` evaluates stored evidence in this order:

1. `MEETING_BOOKED`
2. `OPTED_OUT`
3. `NOT_INTERESTED`
4. `CLOSED`
5. unresolved/new human reply states, then due calls
6. manual reply/follow-up waiting states
7. demo engagement, open and sent states
8. sequence/Instantly states
9. probe and pre-outreach states
10. lead pool/error; the dashboard promotes any non-terminal projection with
   no process/checkpoint/action to `NO_NEXT_ACTION`

Exact emitted enum:

`MEETING_BOOKED`, `OPTED_OUT`, `NOT_INTERESTED`, `CLOSED`,
`REPLIED_NEEDS_HUMAN`, `MEETING_INTENT`, `DEMO_REQUESTED`,
`MANUAL_REPLY_SENT_WAITING`, `CALL_DUE`, `DEMO_FOLLOWUP_SENT`,
`DEMO_ENGAGED`, `DEMO_OPENED`, `DEMO_SENT_UNOPENED`, `SEQUENCE_RUNNING`,
`WAITING_FOR_FIRST_EMAIL`, `READY_FOR_OUTREACH`, `PREPARING_OUTREACH`,
`PROBE_COMPLETE`, `PROBE_OBSERVING`, `PROBE_IN_PROGRESS`, `READY_TO_PROBE`,
`LEAD_POOL`, `NO_NEXT_ACTION`, `ERROR`.

## Reply routing projection

The existing classifier remains authoritative. The operating layer maps every
existing classification as follows:

| Classification | Stage/action |
| --- | --- |
| `POSITIVE_SEND_DEMO` | `DEMO_REQUESTED` / NOVUS `SEND_DEMO`; if already sent, JOE `HUMAN_REPLY` (no duplicate demo) |
| `POSITIVE_MEETING` | `MEETING_INTENT` / JOE `HUMAN_REPLY` |
| `QUESTION` | `REPLIED_NEEDS_HUMAN` / JOE `HUMAN_REPLY` |
| `OTHER_UNCLEAR` | `REPLIED_NEEDS_HUMAN` / JOE `MANUAL_REVIEW` |
| `NOT_NOW` | `REPLIED_NEEDS_HUMAN` / JOE `SET_NEXT_STEP` |
| `NOT_INTERESTED` | terminal `NOT_INTERESTED`; active actions cancelled |
| `OPT_OUT` | terminal `OPTED_OUT`; permanent suppression wins over later rows and active actions are cancelled |
| `OOO_AUTOMATED` | underlying lifecycle stage remains factual; SYSTEM `OUT_OF_OFFICE_CHECKPOINT` is scheduled for 48h, with no human action or sales-engagement promotion |

A genuine new inbound changes the expected action dedupe key and causes the
previous no-reply action to be cancelled at reconciliation. A new inbound after
a historical `NOT_INTERESTED` is surfaced for `MANUAL_REVIEW`; it does not
automatically reopen the lead.

## Action rules

Timing lives only in `lib/acquisition-policy.mjs`.

| Trigger | Delay | Action | Owner | Cancelled when | Completed when |
| --- | ---: | --- | --- | --- | --- |
| eligible, unprobed agency | now | `PROBE_AGENCY` | JOE | probe created/state changes | state advances |
| draft probe | now | `COMPLETE_PROBE` | JOE | probe sent/deleted | state advances |
| observing probe | stored deadline | `OBSERVATION_CHECKPOINT` | SYSTEM | probe closes/terminal | state advances |
| downstream preparation incomplete | now | `PREPARE_OUTREACH` | NOVUS | preparation/outbound advances | state advances |
| OUTBOUND ready | now | `HANDOFF_TO_INSTANTLY` | NOVUS | Instantly id appears/terminal | state advances |
| in Instantly, first email not evidenced | 24h | `FIRST_EMAIL_CHECKPOINT` | SYSTEM | sequence advances/reply/terminal | state advances |
| sequence active | 7d checkpoint | `SEQUENCE_CHECKPOINT` | SYSTEM | reply/demo/terminal | state advances |
| question/meeting/unclear/not-now reply | now | `HUMAN_REPLY`, `MANUAL_REVIEW` or `SET_NEXT_STEP` | JOE | newer inbound/manual send/terminal | operator completes resulting workflow |
| automated out-of-office reply | 48h | `OUT_OF_OFFICE_CHECKPOINT` | SYSTEM | newer genuine activity/terminal | reconciliation re-evaluates the underlying journey |
| positive demo request | now | existing `SEND_DEMO` | NOVUS | sent/new reply/terminal | existing SEND_DEMO completion evidence |
| demo sent, unopened | 24h | `DEMO_UNOPENED_FOLLOWUP` | NOVUS | view/reply/meeting/terminal | future safe executor or operator completion |
| demo opened | 24h from latest meaningful view | `DEMO_OPENED_FOLLOWUP` | NOVUS | reply/meeting/terminal | future safe executor or operator completion |
| demo CTA/repeat views | now | `CALL_PROSPECT` | JOE | reply/meeting/terminal | call outcome recorded |
| demo follow-up sent, ignored | 48h | `CALL_PROSPECT` | JOE | reply/meeting/terminal | call outcome recorded |
| manual reply sent, ignored | 48h | `FOLLOW_UP_CONVERSATION` | JOE | reply/meeting/terminal | operator completes next step |
| call no answer | 48h | `RETRY_CALL` | JOE | reply/meeting/terminal | call outcome recorded |

New demo follow-up actions are ledger/visibility only in this build. No new
automatic email transport was added. Existing SEND_DEMO automation is unchanged.

## ACTIONS setup

Run `npm run novus:actions-setup`, create a Google Sheet tab named exactly
`ACTIONS`, and paste the emitted tab-separated row 1 into A1 and row 2 into A2.
Do not add sample data. The nightly existing finalizer performs periodic
reconciliation; reply ingestion, manual reply and probe-send paths also perform
failure-isolated event reconciliation.

## Evidence limits in the current workbook

- `OUTBOUND` has no first-email-sent timestamp or Instantly step field. A row
  with an `instantly_lead_id` that remains `READY` is therefore truthfully
  `WAITING_FOR_FIRST_EMAIL`; only stored `outbound_status=SENT` can resolve
  `SEQUENCE_RUNNING`. The dashboard does not poll the whole Instantly workspace.
- There is no audited test/synthetic flag shared by all current tabs. Metrics do
  not guess from agency names, so historical synthetic rows cannot be safely
  excluded until a canonical flag is added upstream.
- Manual meeting booking uses the existing
  `AGENCIES.current_pipeline_status=MEETING_BOOKED`. Existing public demo
  booking telemetry in `DEMOS.meeting_booked_at` remains an equally valid
  terminal evidence source; the resolver accepts either without copying one
  into the other.
- Genuine demo views are visible in the dashboard projection immediately from
  `DEMOS`; the durable delayed follow-up row is guaranteed by periodic
  reconciliation. The public one-tab telemetry path is intentionally unchanged
  for latency and preview-safety reasons. Preview views remain excluded by the
  existing `preview=1` safeguard.
