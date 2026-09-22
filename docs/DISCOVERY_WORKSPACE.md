# NOVUS Meetings — discovery, diagnosis and personalised pitch

`/novus/meetings` (`novus/meetings.html`). Server: `?novus_operation=discovery-*` branches on
`api/novus/personalisation.js` implemented in `lib/discovery-*.mjs` (the 12-function ceiling rules
out a new API file). Test: `npm run novus:discovery-selftest` (in-memory workbook + fake model).

Workflow: booked meeting → **Open discovery** → Situation → Foundations → Intelligence → Diagnosis →
**Conclusion** (confirm understanding → commercial opportunity → personalised NOVUS project → what we'd need
from them → 60-day deployment → *private pre-price checkpoint* → £1,500 founding pilot, with
**Present to client**) → Decision. Entry points: the Meetings page (every `CALLS` row with `outcome=BOOKED_MEETING`,
active `PREPARE_MEETING` action, `DEMOS.meeting_booked_at`, `AGENCIES.current_pipeline_status=MEETING_BOOKED`,
plus every session), the lead drawer ("Open discovery workspace" / "Start discovery"), and the agency
picker (any agency — the ⌘K `lead-search` operation).

## Modules

| file | owns |
|---|---|
| `lib/discovery-questions.mjs` | the **versioned question registry** (`QUESTIONS_VERSION`): 12 commercial questions, 10 dimension primaries (F1–F5, I1–I5), each with simpler wording, an example, options with `level`, and the conditional exploration (`verify`, `cause`, `consequence`, `frequency`, `tried`, `example`, dimension-specific `detail`), plus `SECTION_TRANSITIONS`. `isVisible()` / `effectiveLevel()` / `visibleOptions()` are the only conditional logic — the page mirrors them. |
| `lib/discovery-rules.mjs` | the **versioned deployment rule registry** (`RULES_VERSION`): ten rules with triggers, required evidence, consequence, intervention, steps, data/access, responsibilities, dependencies, measurement, scope limits, pitch explanation and a maintained `delivery_status`; the founding offer; the five plan phases. |
| `lib/discovery-engine.mjs` | the **deterministic diagnosis**: `assessDimensions` → evidence status, `evaluateInterventions` → feasibility + dependency resolution, `computeEconomics`, `decideSuitability`, `buildPlan`, `diagnose`. No I/O, no model. |
| `lib/discovery-pitch.mjs` | pitch input (structured, no customer PII), the deterministic template pitch, `validatePitch`, `generatePitch` (model via `lib/ai-client.mjs`, validated, template fallback). |
| `lib/discovery-conclusion.mjs` | the **meeting conclusion**: grouped findings in the owner's words, the owner's agreement → recorded overrides, economics illustration (1–5 additional valuations), intervention groups, the **seven commercial focus areas** (`FOCUS_AREAS`, internal ranking) and the ONE **primary commercial project** they select (`buildProject`), the four-phase deployment built from its components, the **private pre-price checkpoint** (`buildCheckpoint`), the founding pilot, the seven client-facing screens (`presentationPayload`), and the optional validated AI polish. Deterministic; no model needed. |
| `lib/discovery-store.mjs` | tabs `DISCOVERY_SESSIONS` (one row per session, patched in place; `conclusion_json` added later — an older header is extended in place) and `DISCOVERY_PITCHES` (one immutable row per pitch version). |
| `lib/discovery-handlers.mjs` | `discovery-meetings`, `discovery-session` (GET); `discovery-setup`, `discovery-start`, `discovery-save`, `discovery-pitch`, `discovery-conclusion`, `discovery-conclusion-polish`, `discovery-outcome` (POST, Basic Auth + confirm tokens). |

## Shared discovery context (questions v2)

The flow is a conversation, not a checklist. Three mechanisms in `lib/discovery-questions.mjs` (mirrored
in the page) keep it that way:

| mechanism | what it does |
|---|---|
| **Coverage rules** (`COVERAGE_RULES`, data-driven) | When a stored earlier answer already establishes what a question was designed to collect, the question is suppressed and shown as *"Already covered — …"* with the basis. Its derived answer is a **mapping of the owner's real answer** (e.g. F3 "nothing happens" → F4 "nothing"; F1 patchy + missed sellers → I1 ad hoc; C8/C9 → C11), never invented, never chained through other derived answers. A finding derived this way can only be `CONFIRMED` when the dimension it came from is `CONFIRMED`; `assessments[dim].derived` and `diagnosis.coverage` record the basis. **Ask anyway** stores `{reopened:true}` and switches the rule off; a real answer always wins. |
| **Contextual wording** (`variants`) | A question carries alternative primary wording keyed to earlier answers ("You said it's mostly down to the negotiator remembering — if one gets forgotten, does anything pick it up?"). The wording used is saved as `asked_as` for the snapshot. |
| **Option hiding** (`hide_when`) | An option an earlier answer has made redundant is not offered again (F2's "not much gets recorded" once F1 is weak/partial). |

## The opening, the order and the section cues

The meeting opens on the **commercial objective** (C1) — *"So just to start with the bigger picture, what's
the main focus commercially for you at the moment? …"* — offering **more instructions · more valuations ·
more buyer demand · greater team efficiency · something else**. Older values are never redefined:
`win_instructions` ("winning more of the valuations we do") is a narrower objective than the new
`more_instructions`, so it is kept as a `legacy` option — `optionOf()` still resolves its label, and
`visibleOptions()` only offers a legacy value again to a session whose own answer already uses it.

C1 is followed by the **desired outcome** (C1a): *"And if we were having this conversation again in six
months and things had gone really well, what would have changed for you?"* — free text with an **optional**
numerical `target`. A number is never required; when none is given the target stays `null`, never zero. It
reaches the conclusion as `objective.outcome` and is shown on the internal Today step only — their words
about their own agency are private, not a claim on a client slide.

Order: objective → outcome → obstacles → branches → enquiry volume → database size → CRM → CRM access, then
foundations, then intelligence, then the numbers. `SECTION_TRANSITIONS` (registry, published in the
registry payload) carries one **private speaking cue per section entered** — foundations, intelligence and
the commercial numbers; the opening section has none. The page shows a cue once, on the first visible
question of that section, and never in `presentationPayload` or the conclusion.

Other flow changes: the commercial-value numbers (C8–C11) are asked last (section `value`, stage 3) so the
conversation runs priorities → operation → gaps → intelligence → value; "Next" steps over optional detail
once a dimension has its cause and consequence; a blocked CRM opens `C7_block`, and "nobody's worked out
how" turns the F2/I2/I3 block into an assessment item. Related dimensions stay distinct: F2 (can a person read
the history) is never skipped because F1 (is it captured) was assessed; I2 (does the system connect events) is
never skipped because F2 was strong — only the *matching* detail is carried.

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

Three views from one diagnosis (`lib/discovery-pitch.mjs`):

* **Spoken pitch** — 150–220 words, hard cap 250, one flowing passage, no price, ends with a question. The
  ten rules are grouped into four commercial **themes** (making customer information usable F1+F2; making sure
  opportunities progress F3+F4; finding more opportunities in existing demand I1–I4; measuring and improving
  F5+I5), ranked by the owner's priority and obstacles, evidence quality, feasibility and incremental value
  beyond existing strengths; the pitch speaks about the top two or three, using each rule's `spoken_change`.
* **Personalised 60-day plan** — four phases (week 1, week 2, weeks 3–4, weeks 5–8), at most two sentences
  each, built from the selected rules' `plan_phrase`, the baseline and every feasibility caveat.
* **Internal diagnosis** — the full engine output, in an expandable section on the pitch stage.

The model receives the structured findings, selected rules, ranked themes, plan skeleton, baseline with sources
and `allowed_money_figures` (never PII, never the price) and returns `spoken` + four plan fields through a
forced tool. `validateSpoken` / `validatePlan` reject: over 250 words, bullets/headings, the price, invented £
figures, guarantees/marketing/jargon, any unproposed rule, no closing question, plan phases over two sentences.
Spoken and plan are validated separately; each part that fails is replaced by the deterministic template
(`templateSpoken` / `templatePlan`) and the source of each part (`AI` / `TEMPLATE`) is stored on the pitch
and shown in the UI. Modes: `PILOT`, `VALIDATION`, `NO_PITCH`. Every version is an immutable
`DISCOVERY_PITCHES` row; pitches stored in the older eight-section format still render.

## Meeting conclusion (stage 5) and presentation

The conclusion replaces the AI-generated speech as what happens after discovery. Everything is built by
`lib/discovery-conclusion.mjs` from the stored answers and the engine; the model is never needed and can
only reword sentences (see *Polish*). Two diagnoses back it: **base** (answers + operator overrides) and
**agreed** (the same, with the owner's corrections applied as recorded `EXISTING_STRENGTH` overrides,
`source: OWNER_CONCLUSION`, unverified → checked in days 1–3). Findings are reflected from *base* so a
rejected finding still shows as rejected; interventions, deployment and scope come from *agreed*. The
session row stores *agreed* in `diagnosis_json`; the answers and the operator's own overrides are never
rewritten, and an operator override always wins over the owner's remark.

| step | what it shows | controls |
|---|---|---|
| **Confirm understanding** | "Right {name}, correct me if I'm wrong…", the situation in their numbers (branches, CRM, enquiries, database, valuations, instructions, fee, conversion — unknown stays unknown), the two or three problems grouped by theme (capture F1+F2 · progress F3+F4 · opportunities I1–I4 · measure F5+I5), ranked by evidence, commercial consequence and the owner's priority, each in the owner's own answers ("mostly, but some gets missed"), hedged with "I think" when provisional; "Is that a fair reflection…?" | **Agree** · **Correct…** (untick the parts that are not a problem + their words) · **Not a problem** · *Show in presentation* · *They agreed with all of it* |
| **Commercial opportunity** | fee × conversion = expected gross fee income per additional valuation; selector 1–5 with monthly and annual figures, labelled *Illustration, not a forecast* (Louis: £4,500 × 30% = £1,350; 2/month = £2,700 / £32,400) | the selector (persisted) |
| **The project** | *"Here's what I'd propose for your agency."* — ONE primary project (`buildProject`, see below): headline, one or two sentences, the owner's ambition, then two or three implementation components generated from this agency's selected rules, and the ongoing statement. Supporting setup and preserved processes are in the payload and in week 1 of the roadmap | — (recomputed on every correction) |
| **60-day deployment** | Week 1 / Week 2 / Weeks 3–4 / Weeks 5–8, generated from **the project's components** (`buildDeployment(agreed, project, situation)`): week 1 = access, scope, the baseline and only the supporting setup the project needs (reuse where already strong); week 2 = the first part of the project; weeks 3–4 = the rest plus progression, with no date attached to anything still awaiting validation; weeks 5–8 = progression and the commercial review. Outcome tracking starts in week 1. Implementation detail expandable | — |
| **Pre-price checkpoint** (PRIVATE) | `buildCheckpoint`. Between the deployment and the pilot; the client keeps looking at the deployment slide. Two cues: does it make sense (*clear · questions answered · further explanation required*) and do they want it implemented (*yes · potentially · no*), plus relevant outstanding concerns and optional notes. YES → the pilot line and the £1,500 slide; POTENTIALLY → "What would you need…?" and the project's private guidance opens; NO → the outcome is recorded without a price. Never in `presentationPayload` | the two cue answers, concern ticks, "answered on the call", notes (all persisted) |
| **Founding pilot** | £1,500 all-in · 60 days · scope ticks (default = everything proposed) · included · success criteria from the scope's measurements · day-45/60 review · no long-term commitment · a short pricing script | scope ticks (persisted; the Decision stage defaults to them) |

`discovery-conclusion` (POST `{session_id, agreement?, additional_valuations?, scope_rule_ids?, clear_polish?}`)
cleans the agreement against today's findings, stores `conclusion_json`, recomputes and stores the agreed
diagnosis. `discovery-outcome` with `PILOT_AGREED` freezes the exact findings, agreement, illustration,
pilot headline and owner overrides inside `agreed_scope_json.conclusion`, next to the checklist.

**Polish** (`discovery-conclusion-polish`, optional): the model receives only the finding statements and the
change sentences and returns rewordings; each is validated (no longer than the original plus a little, no
guarantees/marketing/jargon, no figures, no rule ids, no bullets) and stored with its original — a polished
sentence is applied only while its deterministic original is unchanged, so a correction drops stale polish.
Failure or rejection leaves the plain wording.

The **confirm-understanding step** opens with a deterministic PRIVATE speaking script
(`understanding.script`, `buildTransitionScript`) — the opening line, the known demand figures, the finding
titles in one spoken sentence, then the closing question — built only from real figures/findings, never a
model. Once every finding is agreed, a second fixed script (`understanding.after_agreement_script`,
`SCREEN_SHARE_SCRIPT`) appears with a dedicated **Present to client — start on the commercial opportunity**
button that opens the presentation straight on that slide (`openPresentation({ screenId })`), skipping the
agency-overview/established slides already covered verbally. Neither script is ever part of
`presentationPayload`.

**Present to client** opens a full-screen, 16:9, NOVUS-branded presentation of seven screens rendered from
`presentationPayload` (server-built; no rule ids, evidence codes, notes, scripts or controls; only findings
approved for presentation): *Your agency today · What we've established · Commercial opportunity (live
1–5 calculator) · Here's what I'd propose for your agency · Your 60-day deployment · Founding pilot* — with *What we'd need from you* between the project and deployment (non-fit sessions show
the owner-facing next step instead of a price). The pre-price checkpoint is **not** a slide: the client
stays on the deployment screen while it is worked through. ←/→/space, Home/End, Esc exits (also leaves fullscreen), F
or the hover button uses the Fullscreen API with the edge-to-edge overlay as the fallback. The slide index
is kept per session (`sessionStorage`) so switching between the workspace and the presentation resumes
where it was. **New window ↗** opens `#present?id=<session>` — the same page in presentation-only mode
(the app shell hidden), so that window alone can be shared on Google Meet; a `BroadcastChannel` keeps
slide, calculator and every correction in step between the windows. The spoken pitch of the previous
approach stays as a read-only archive at the bottom of the stage; its versions are preserved.

## The seven commercial focus areas

`FOCUS_AREAS` in `lib/discovery-conclusion.mjs` — internal categories, not seven products and not seven
slides: **operational foundations** (F1+F2) · **incoming enquiry intelligence** (I1) · **historical database
intelligence** (I3) · **connecting customer activity** (I2) · **opportunity progression** (F3+F4) ·
**commercial prioritisation** (I4) · **commercial measurement & improvement** (F5+I5). The registry is in
implementation order and every dimension belongs to exactly one area.

The areas are scored on the AGREED diagnosis (a candidate only when it has a *selected* rule): **per rule
and averaged** on the owner's agreed findings and evidence, the commercial consequences established,
delivery feasibility and dependencies, and the incremental value beyond what already works — then adjusted
for the owner's objective and the obstacles they named. Foundations score as a headline only when a
dependency needs them; measurement only when the agency's own measurement is a real weakness. **The
ranking no longer becomes client cards** — it only decides which project the agency gets.

## The primary commercial project

One commercial objective → one personalised project → the work needed to deliver it → a 60-day pilot to
prove its value. `buildProject(agreed, situation)` in `lib/discovery-conclusion.mjs`:

* **Anchor** = the highest-scoring area that is not foundations (foundations anchor only when nothing else
  is selected). The anchor sets the `PROJECT_TYPES` entry: database/connecting → `existing_customers`,
  enquiry → `incoming_demand`, progression/prioritisation → `conversion`, measurement → `visibility`,
  foundations → `capture`. The title is worded for the owner's objective (e.g. *"Generate more valuations
  from the customers you already have."*); the description names their database/enquiries/CRM.
* **Components** (max three, never forced) come from the type's component list, and a component appears
  only when one of its rules is selected: e.g. existing customers = *Find existing opportunities* (I3) ·
  *Recognise new opportunities* (I2) · *Turn opportunities into business* (F3/F4/I4/F5/I5 combined into
  one). Each sentence is built from what is selected vs what is an existing strength (for example, "through
  your existing follow-up process"). If a rule still needs assessing, the sentence gets a hedge ("once we've…").
* **Supporting setup** = F1/F2 only when a component rule depends on them (`provided`/`added`); shown as one
  "To support this, we'd first…" line, never as a headline.
* **Future scope** = every other selected rule, kept privately (`project.future_scope`) and off the slide,
  roadmap and default scope. `pilot.scope_rule_ids` defaults to `project.rule_ids`.
* **Ambition** = the owner's C1a words ("Built around your ambition: …"), else their objective. We never add
  a number of our own.
* **Ongoing** statement built from what is in scope (identifying / progressing / refining via review).
* `null` when nothing is proposed, the verdict is NOT_CURRENTLY_SUITABLE, or no real component exists — no
  project is invented.

The roadmap (`buildDeployment(agreed, project, situation)`) is generated from the components. Week 1 =
access, scope, baseline, supporting setup and data checks. Week 2 = the first assured identify component;
if that component is not assured, it has no date. Weeks 3–4 = the remaining components plus progression.
Weeks 5–8 = run, improve, review. The expandable task lists come from the engine's `buildPlan` over the
project's rules only (`projectPlan`), and that plan and its checklist are frozen on PILOT_AGREED along with
the project (objective, desired outcome, bottleneck, title, description, components, setup, preserved,
ongoing, conditions, future scope), deployment scope, agency responsibilities, success criteria and the
commercial baseline.

`conclusion.guidance.project` (private, never in `presentationPayload`) mirrors the slide: **why**,
**supporting_answers**, **objective_link**, **say_aloud** (a founder explaining it), **what_we_implement**,
**data_access**, **need_from_team**, **team_change**, **preserved**, **ongoing**, **measures**,
**conditions**, **fallbacks**, **questions**, per-component **implementation** and **future_scope**. The
checkpoint's "potentially" opens it. Polish may reword `project.description` and component sentences
(validated; figures already in the original are allowed).

The internal Conclusion stage mirrors the seven client screens one to one, rendering the client-facing
wording from the **same** `presentation` payload the full-screen mode uses (no second copy), with the
private material underneath in expandable sections: `conclusion.guidance` (never part of
`presentationPayload`) carries the project guidance above, including *implementation details* (from the rule
registry + this agency's diagnosis: configure, systems/data, access, NOVUS vs agency responsibilities, what
changes for the team, dependencies/validation, the fallback if the preferred route is unavailable, scope
limits) and *questions & objections* (only those relevant to the selected rules); per "needs" card the
precise access / setup / act items for this agency; and closing guidance + likely objections for the pilot.
The full diagnosis stays available at the bottom of every step as "Full diagnosis / technical reference".

## Diagnosis stage (stage 4) — a one-screen review, not a technical readout

The default Diagnosis view (`renderDiagnosisSummary`) reuses the same conclusion data as the presentation —
commercial situation and objective (the "Your agency today" screen's facts), the 2–3 main findings (the
"What we've established" screen's wording), and up to three "Worth checking" items (`diagnosis.blockers` +
`diagnosis.validation`) — with one primary action, "Continue to meeting conclusion" (which lands on the
Established step, see above). The full findings/evidence/overrides/interventions/economics/plan content is
unchanged and one click away in "Full diagnosis / technical reference" (`renderDiagnosis(el, {embedded:true})`,
same function, same override controls, reused rather than duplicated). The Live Diagnosis sidebar is hidden
by default on the Diagnosis and Conclusion stages (`SIDE_HIDDEN`, toggled by the "Show/Hide live diagnosis"
button in the workspace header) and shown by default elsewhere.

## Plan and outcome

The Decision stage's scope ticks default to the conclusion's agreed scope. `buildPlan` fills the five phases from the selected rules (days 4–7 = selected foundations or "reuse",
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
