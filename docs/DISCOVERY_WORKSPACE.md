# NOVUS Meetings — discovery, diagnosis and personalised pitch

`/novus/meetings` (`novus/meetings.html`). Server: `?novus_operation=discovery-*` branches on
`api/novus/personalisation.js` implemented in `lib/discovery-*.mjs` (the 12-function ceiling rules
out a new API file). Test: `npm run novus:discovery-selftest` (in-memory workbook + fake model).

Workflow: booked meeting → **Open discovery** → Situation → Foundations → Intelligence → Diagnosis →
Pitch → Pilot & outcome. Entry points: the Meetings page (every `CALLS` row with `outcome=BOOKED_MEETING`,
active `PREPARE_MEETING` action, `DEMOS.meeting_booked_at`, `AGENCIES.current_pipeline_status=MEETING_BOOKED`,
plus every session), the lead drawer ("Open discovery workspace" / "Start discovery"), and the agency
picker (any agency — the ⌘K `lead-search` operation).

## Modules

| file | owns |
|---|---|
| `lib/discovery-questions.mjs` | the **versioned question registry** (`QUESTIONS_VERSION`): 11 commercial questions, 10 dimension primaries (F1–F5, I1–I5), each with simpler wording, an example, options with `level`, and the conditional exploration (`verify`, `cause`, `consequence`, `frequency`, `tried`, `example`, dimension-specific `detail`). `isVisible()` / `effectiveLevel()` are the only conditional logic — the page mirrors them. |
| `lib/discovery-rules.mjs` | the **versioned deployment rule registry** (`RULES_VERSION`): ten rules with triggers, required evidence, consequence, intervention, steps, data/access, responsibilities, dependencies, measurement, scope limits, pitch explanation and a maintained `delivery_status`; the founding offer; the five plan phases. |
| `lib/discovery-engine.mjs` | the **deterministic diagnosis**: `assessDimensions` → evidence status, `evaluateInterventions` → feasibility + dependency resolution, `computeEconomics`, `decideSuitability`, `buildPlan`, `diagnose`. No I/O, no model. |
| `lib/discovery-pitch.mjs` | pitch input (structured, no customer PII), the deterministic template pitch, `validatePitch`, `generatePitch` (model via `lib/ai-client.mjs`, validated, template fallback). |
| `lib/discovery-store.mjs` | tabs `DISCOVERY_SESSIONS` (one row per session, patched in place) and `DISCOVERY_PITCHES` (one immutable row per pitch version). |
| `lib/discovery-handlers.mjs` | `discovery-meetings`, `discovery-session` (GET); `discovery-setup`, `discovery-start`, `discovery-save`, `discovery-pitch`, `discovery-outcome` (POST, Basic Auth + confirm tokens). |

## Evidence statuses (never upgraded by anything but a recorded override)

| status | rule |
|---|---|
| `CONFIRMED` | weak/partial primary + a real cause + a real consequence ("don't know" does not count) |
| `PROVISIONAL` | weak/partial primary, exploration incomplete |
| `UNKNOWN` | no usable primary answer (skipped, or "don't know") |
| `EXISTING_STRENGTH` | strong primary; `verified` = the verification question confirmed it. A verification answer marked `downgrade` makes the dimension **partial** and opens the exploration instead |
| `OUTSIDE_SCOPE` | F1 with cause = staff adoption only and "a process exists and isn't followed" — a management issue; F1 is not prescribed |

Unknown numbers are unknown, never zero. A prefilled answer (`branch_count`, `crm_name` from `AGENCIES`) carries
`prefilled:true, source:'AGENCIES'` and is shown as such until confirmed.

## Interventions and dependencies

A rule is a candidate when its dimension is weak/partial with CONFIRMED or PROVISIONAL evidence (or included by
override). Feasibility: `FEASIBLE` · `FEASIBLE_WITH_FOUNDATION` (a dependency is provided by a selected
foundation rule) · `REQUIRES_ASSESSMENT` (CRM access unsure, matching/data quality unknown, low volume, a
dependency not established) · `INFEASIBLE` (CRM blocked for F2/I2/I3, history outside the CRM for I3, a dependency
outside scope). An existing strength satisfies a dependency by reuse; a weak foundation whose rule was not
selected is **added** to the plan as a dependency. Rule overrides (`include: true|false` + reason) and dimension
overrides (`evidence_status` / `level` + reason) are recorded with the original — the answers are never rewritten.

## Suitability

`POTENTIAL_FIT` · `FURTHER_VALIDATION_REQUIRED` (incomplete discovery, all findings provisional, every relevant
rule needs assessment, no commercial baseline) · `NOT_CURRENTLY_SUITABLE` (insufficient demand — under
`SUITABILITY_POLICY` on both enquiries and database; existing capability with no established gap; every
intervention infeasible). A strong agency is not disqualified for strong foundations: the intelligence gaps are
assessed separately (`STRONG_FOUNDATIONS_INTELLIGENCE_GAP`).

## Pitch

The model receives the diagnosis (findings with the owner's words, selected rules in their own wording, plan,
economics with sources, offer, `allowed_money_figures`) and returns eight spoken sections through a forced
tool. `validatePitch` rejects: a £ figure not supplied, "guarantee"/AI marketing/jargon, any rule not proposed,
a missing section, the price in a non-pilot outcome. A rejected or failed generation stores the **template**
pitch (built from `pitch_explanation`) with the reason; every version is an immutable `DISCOVERY_PITCHES` row and
the page shows when the diagnosis has moved on since a pitch was generated. Modes: `PILOT`, `VALIDATION`,
`NO_PITCH`.

## Plan and outcome

`buildPlan` fills the five phases from the selected rules (days 4–7 = selected foundations or "reuse",
days 8–14 = the first feasible intelligence workflow in priority order I1, I3, I2, I4, I5 — or the first
foundation when none is feasible; 15–30 = the rest and anything pending assessment; 31–60 = progression,
review, evaluation, extension clause). `discovery-outcome` completes the session, freezes
`question_snapshot_json` (labels only, so old sessions stay readable after a registry change), stores the
agreed scope with an onboarding **checklist** on `PILOT_AGREED`, marks the agency `NOT_INTERESTED`/`CLOSED` for
those outcomes, and creates one `MEETING_FOLLOW_UP` action (`dedupe_key discovery:<session>:followup`) when a
follow-up date is given. Completed sessions need `reopen:true` to edit.

## Page behaviour (`novus/meetings.html`)

One question at a time; **Make simpler** / **Give an example** reveal the registry's alternative wording
(keys `S` / `E`); options by click or keys `1–9`; `Enter`/`→` next, `←` back; **Don't know** and **Skip…**
(with a reason) on every question. Left rail = section navigator with answer state; right rail = live diagnosis
(dimension chips, suitability, interventions, economics, what we already know, meeting notes). Autosave 800 ms
after any change (`discovery-save` recomputes the diagnosis server-side); a failed save is kept in
`localStorage` and offered back on reopen. Local check: scratchpad `meetings-dev-server.mjs`
(`.claude/launch.json` → `meetings-dev`, `/dev/ai?mode=ok|fail|invalid` switches the fake model).

## Maintaining the registries

Add questions with new ids; never change what an existing option value means; bump `QUESTIONS_VERSION` /
`RULES_VERSION` when a stored answer could read differently. `delivery_status` on each rule is a claim Joe
maintains — review it before every pilot; nothing derives it from code and the model cannot change it.
