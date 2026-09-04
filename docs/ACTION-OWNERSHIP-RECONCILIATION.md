# Action ownership reconciliation — 4 Sept 2026

Source: live `operator-dashboard` read, 768 agencies, `generated_at`
2026-09-04T13:56Z. Recomputed against the execution authority registry now in
`lib/acquisition-actions.mjs`.

## Rule

NOVUS decides **what** should happen next for every lead. It may only be
recorded as the **execution owner** of an action type that has a deliberately
enabled, named, tested executor running in production today. Everything else
falls back:

| Executor | Commercially meaningful | Owner | Queue |
|---|---|---|---|
| `ENABLED` | — | `NOVUS` | NOVUS |
| `NONE` | yes (reaches the prospect, or decides whether they are contacted) | `JOE` | Manual |
| `NONE` | no (internal preparation, never touches the prospect) | `SYSTEM` | NOVUS |

`recommended_by` is always `NOVUS`. An action type the registry has never heard
of fails **closed** to Joe.

## Audit of every action type previously assigned to NOVUS

| Action type | Real automated executor? | Evidence | Was | Now |
|---|---|---|---|---|
| `SEND_DEMO` | **Yes** | `runAutoSendDemo()` in `api/novus/personalisation.js` runs on every live reply poll pass and calls `executeSendDemo()` behind the same gate as the manual route. Covered by `novus:reply-poll-auto-send-selftest` and `novus:send-demo-selftest`. | NOVUS / NOVUS | **unchanged** |
| `DEMO_UNOPENED_FOLLOWUP` | No | No executor exists anywhere. The only references are the type list, the completion map and a UI label. | NOVUS / NOVUS | **Joe / Manual** |
| `DEMO_OPENED_FOLLOWUP` | No | Same — nothing composes, schedules or sends it. | NOVUS / NOVUS | **Joe / Manual** |
| `HANDOFF_TO_INSTANTLY` | No | Only path is `scripts/instantly-outbound.mjs`, an operator CLI that refuses to run without a typed confirmation phrase. A human-gated CLI is manual execution. | NOVUS / NOVUS | **Joe / Manual** |
| `PREPARE_OUTREACH` | No | Nothing schedules preparation; the rebuild routes are human-triggered. But it never contacts the prospect, so it cannot materially affect a live lead. | NOVUS / NOVUS | **SYSTEM / NOVUS** (owner corrected, queue unchanged) |

`SYSTEM`-owned checkpoints (`OBSERVATION_CHECKPOINT`, `FIRST_EMAIL_CHECKPOINT`,
`SEQUENCE_CHECKPOINT`, `OUT_OF_OFFICE_CHECKPOINT`) are waits, not executions —
nothing is meant to fire, so they are untouched. `PROBE_AGENCY` /
`COMPLETE_PROBE` remain Joe-owned Prober queue work, as before.

## Every lead with a genuine future-dated action (`due_at > now`): 128

| # | Action type | Owner | Queue | Executor | In Future actions? | After the fix |
|---|---|---|---|---|---|---|
| 1 | `DEMO_UNOPENED_FOLLOWUP` | NOVUS | NOVUS | none | **No — the bug** | **Joe / Manual — yes** |
| 5 | `FOLLOW_UP_CONVERSATION` | Joe | Manual | none | Yes | unchanged |
| 116 | `OBSERVATION_CHECKPOINT` | SYSTEM | NOVUS | n/a (a wait) | No — correct | unchanged |
| 6 | `SEQUENCE_CHECKPOINT` | SYSTEM | NOVUS | n/a (a wait) | No — correct | unchanged |

**The only row that changes:**

| Lead | Action | Due | Was | Now |
|---|---|---|---|---|
| Henton Kirkman Residential | Follow up unopened demo | 2026-09-05T09:12Z (in 20h) | NOVUS / NOVUS queue / absent from Future actions | Joe / Manual / **in Future actions** |

No other lead was hiding the same defect — the audit found no second case, and
the registry now prevents a third.

## Full active ledger, before → after

| Count | Action type | Owner/queue before | Owner/queue after |
|---|---|---|---|
| 537 | `PROBE_AGENCY` | Joe / Prober | unchanged |
| 116 | `OBSERVATION_CHECKPOINT` | SYSTEM / NOVUS | unchanged |
| 85 | `FIRST_EMAIL_CHECKPOINT` | SYSTEM / NOVUS | unchanged |
| 15 | `PREPARE_OUTREACH` | NOVUS / NOVUS | SYSTEM / NOVUS |
| 6 | `SEQUENCE_CHECKPOINT` | SYSTEM / NOVUS | unchanged |
| 5 | `FOLLOW_UP_CONVERSATION` | Joe / Manual | unchanged |
| 1 | `CALL_PROSPECT` | Joe / Manual | unchanged |
| 1 | `DEMO_UNOPENED_FOLLOWUP` | NOVUS / NOVUS | **Joe / Manual** |

Joe's live Actions queue is unchanged at 6 due-now items; Future actions goes
from 5 to 6.

## Durability

The read path resolves ownership on every render, so a stored row written under
the old rule is corrected immediately without a migration. `reconcileActions()`
also treats `action_owner` as a reconciled field, so the next reconciliation
pass rewrites the ACTIONS ledger to match — and would rewrite it again if an
executor were later enabled or removed.
