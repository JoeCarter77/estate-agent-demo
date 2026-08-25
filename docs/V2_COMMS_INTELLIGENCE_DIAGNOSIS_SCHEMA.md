# COMMUNICATIONS → INTELLIGENCE → DIAGNOSIS — Proposed V2 (demo-ready)

**Status: IMPLEMENTED.** `COMMUNICATIONS`/`INTELLIGENCE`/`DIAGNOSIS` per §1–§4; `DIAGNOSIS_FINDINGS` per §4a; `PERSONALISATION` and the Instantly variable contract per §4b–§4c.

Scope: `COMMUNICATIONS`, `INTELLIGENCE`, `DIAGNOSIS`.
Not in scope: Demo, SEND DEMO, Outreach, `AGENCIES`, `PROBES`, `RAW_EVENTS`, `ACTIONS`. (`DIAGNOSIS_FINDINGS` and `PERSONALISATION` were added to this document in §4a/§4b when the Personalisation layer was rebuilt — see those sections.)

Totals: **`COMMUNICATIONS` +0 columns**, **`INTELLIGENCE` 20 fields**, **`DIAGNOSIS` 8 fields + `DIAGNOSIS_FINDINGS` 6 fields**, **`PERSONALISATION` 20 fields**. Two AI calls per probe for `COMMUNICATIONS`→`DIAGNOSIS`, plus normally one for `PERSONALISATION` (one bounded correction is possible). No fingerprint layer.

---

## 1. The probe creates exactly two opportunities

Every NOVUS probe deliberately puts two commercial opportunities on the table at once. Everything `INTELLIGENCE` measures is *what the agency did with these two*:

| | Opportunity | What "handled well" looks like |
|---|---|---|
| **BUYING** | A viewing on the listed property, plus a buyer worth qualifying | Progress the viewing toward a real appointment, and find out who this buyer actually is |
| **SELLING** | A declared property to sell, not yet on the market | Notice it, ask about it, and convert it into a valuation |

That is the whole framework. No opportunity taxonomy, no per-enquiry opportunity registry — two named opportunities, hard-coded, because the probe always creates exactly these two.

---

## 2. `COMMUNICATIONS` — no schema change at all

It stays what it already is: the raw ledger of what literally happened. **No new columns. No renames. No migration.**

**Still written** — all raw evidence (`occurred_at`, `channel`, `direction`, `source_identifier_*`, `subject`, `body_text`, `transcript`, `duration_seconds`, `voicemail_present`, …), all matching columns, all `manual_*` columns, and **`automated_or_human`** — the one per-message judgement the deterministic rollups genuinely need.

**Stop being written** (left physically in the sheet, historical values preserved, simply never read or updated again):

| Column | Why it goes |
|---|---|
| `human_contact` | Duplicates `automated_or_human`; the disagreement between the two is what `isHumanCommunication()` exists to paper over |
| `follow_up`, `callback_attempt`, `successful_conversation` | Probe-level rollups, recomputed in memory each run — nothing needs them stored per row |
| `booking_attempt` | → `INTELLIGENCE.viewing_progression` (a boolean can't say *invited* vs *slot offered* vs *booked*) |
| `intent` | → `INTELLIGENCE.seller_recognition` |
| `communication_classification`, `contact_quality` | → `INTELLIGENCE.communication_quality` |
| `ai_summary`, `ai_confidence`, `ai_model` | The AI pass is per-probe in V2, not per-message |

Net: 11 columns quietly retired, **zero added**. `COMMUNICATIONS` gets simpler, not bigger.

---

## 3. `INTELLIGENCE` — 20 fields, one row per probe

Recomputed from `PROBES` + **all** of that probe's `COMMUNICATIONS`, every time. Never incremental.

Classes: **RAW** (keys) · **DET** (deterministic arithmetic, no AI) · **AI** (read of the actual message content).

### Keys and window

| # | Field | Class | Derivation |
|---|---|---|---|
| 1 | `intelligence_id` | RAW | `itl_*` from `lib/ids.mjs`. One row per `probe_id`, upserted. |
| 2 | `agency_id` | RAW | Copied from the `PROBES` row. |
| 3 | `probe_id` | RAW | The `PROBES` row. Unique — this is the upsert key. |
| 4 | `observation_status` | DET | `closed` when `now >= probe_timestamp + 4 days` (§10), else `observing`. |

### Response speed / human contact

| # | Field | Class | Derivation |
|---|---|---|---|
| 5 | `human_contact` | DET | `yes` if any `COMMUNICATIONS` row for this probe has `automated_or_human = human`. Else `automated_only` if an auto-acknowledgement exists. Else `none`. |
| 6 | `response_hours` | DET | `first_human_response_at − PROBES.probe_timestamp`, in hours, 2dp. Blank when `human_contact ≠ yes`. |
| 7 | `first_human_response_at` | DET | `occurred_at` of the earliest human row, any channel. Blank if none. |

### Follow-up / persistence

| # | Field | Class | Derivation |
|---|---|---|---|
| 8 | `contact_attempts` | DET | Human rows grouped under the §9 30-minute rule anchored to attempt start. Voicemail + email 5 minutes apart = **one** attempt. Existing `lib/observation.mjs` logic, unchanged. |
| 9 | `follow_ups` | DET | `max(contact_attempts − 1, 0)`. This is the persistence number the grade uses. |
| 10 | `channels_used` | DET | Distinct `channel` values across all rows, comma-joined, in first-seen order. |

### BUYING opportunity

| # | Field | Class | Derivation |
|---|---|---|---|
| 11 | `viewing_progression` | AI | How far they moved the viewing, from the actual content. Ordinal: `none` → `mentioned` → `invited` → `availability_requested` → `slot_offered` → `booked`. |
| 12 | `buyer_qualification` | AI | How deeply they qualified the buyer: `none` / `minimal` / `standard` / `thorough`. Floored deterministically by the count in field 13 (0 → none, 1–2 → minimal, 3–5 → standard, 6+ → thorough); the AI may not rate it above what it can list. |
| 13 | `buyer_questions_asked` | AI | The qualification topics they actually asked about, normalised and semicolon-joined — e.g. `current property position; finance; budget; requirements; areas`. Blank when they asked nothing. This is what makes field 12 a finding rather than an opinion. |

### SELLING opportunity

| # | Field | Class | Derivation |
|---|---|---|---|
| 14 | `seller_recognition` | AI | How far they took the declared property-to-sell. Ordinal: `none` → `asked_position` → `acknowledged` → `valuation_offered` → `valuation_booked`. Reads intent, not keywords — *"are you on the market?"* and *"confirm your position — sold/selling/nothing to sell?"* both count as `asked_position`. Blank when `PROBES.enquiry_text` carries no seller declaration. |

### Quality and evidence

| # | Field | Class | Derivation |
|---|---|---|---|
| 15 | `communication_quality` | AI | The craft of the response, independent of speed: `poor` / `generic` / `competent` / `strong`. Judged on whether it names the property and the person, reads as written for this enquiry rather than blasted, gives a route back, and moves toward something. |
| 16 | `did_well` | AI | What they got right, in prose, only where the content supports it. Blank is a legitimate value. |
| 17 | `missed` | AI | What was on the table and not taken, in prose. Absence is a finding: *"no valuation was offered in either message"* is a conclusion, not a blank. |
| 18 | `evidence` | AI | The verbatim quotes the rest of the row rests on, each tagged `(channel, timestamp)`. Every quote is checked to be a literal substring of the message it came from; one that isn't is dropped, along with the claim it supported. |

### Grade

| # | Field | Class | Derivation |
|---|---|---|---|
| 19 | `grade` | DET | A–H from `lib/grading.mjs`, **completely unchanged**. Inputs: `human_contact`, `response_hours`, `follow_ups`, auto-ack, window state. AI never touches this. |
| 20 | `grade_reason` | DET | The rule that fired, verbatim from the grading engine. |

Plus `created_at` / `updated_at` as row plumbing.

**Retired from `INTELLIGENCE`:** `tier`, `tier_reason`, `sales_angle`, `segment` (commercial — they belong on `DIAGNOSIS`, and are blank on every live row today while duplicated there), `contact_quality`, `proactive_reactive`, `persistence_profile`, `ai_evidence_summary`, `crm_*`, and the counter columns now covered by fields 8–10 (`callback_attempts`, `voicemail_count`, `inbound_sms_count`, `email_touch_count`, `days_chased`, `follow_up_channels`, `last_touch_at`, `auto_ack_timestamp`).

---

## 4. `DIAGNOSIS` — 8 fields, one row per probe

Written only when `observation_status = closed`. Reads the `INTELLIGENCE` row and nothing else — no new evidence, no counts, no grade.

| # | Field | Derivation |
|---|---|---|
| 1 | `findings` | The genuine, distinct, evidence-backed problems and opportunities that earn their place — **0 to 3 items**, most commercially damaging first, plus **at most 1 `positive`** for a hard cap of **4 findings per probe** (§4a). Not a catalogue: the slots are roles — [0] the main story, [1] a genuinely distinct wider commercial opportunity where one is evidenced, [2] one optional supporting problem when it is materially different from [0]. Two candidate findings describing the same underlying issue are consolidated into the stronger one; nothing is invented to fill a slot, so 2–3 findings is a complete answer. **Persisted to the separate `DIAGNOSIS_FINDINGS` tab, one row per finding** (§4a) — the `DIAGNOSIS` row itself carries no `findings` column. In transit between `lib/probe-diagnosis.mjs` and `lib/diagnosis-rebuild.mjs` it is a JSON array of `{ finding_type, finding, evidence, significance_note }`, with the **`positive_findings[]` the same call now returns appended after it** — problems and opportunities keep indexes 1..N so nothing already written changes meaning. **An empty array is a legal, meaningful value** — see §5. Each item's `evidence` is mandatory whenever `finding` is non-empty (same evidence-gating discipline as the old primary/secondary fields, applied per item). `significance_note` says why this specific finding matters commercially and whether the agency would likely notice it themselves — the raw material Personalisation needs to judge and rank findings, not a whole-probe sentence. |
| 2 | `strengths` | What they did well, from `INTELLIGENCE.did_well` + the numbers. May legitimately be the longest field on the row. **No longer the source the email's fair observation is drawn from** — that comes from the `positive` findings in §4a. Still written, still the prose for the row and the sales call. |
| 3 | `missed_opportunities` | Named commercial value that was on the table and not taken — the BUYING and SELLING opportunities from §1, specifically. |
| 4 | `commercial_implication` | What this costs *this* agency. Must contain at least one probe-specific fact — the property, a time, their own words. A sentence that would read identically for another agency is rejected. |
| 5 | `novus_opportunity` | Where NOVUS actually fits, given the evidence. `Core (front desk)`, `Growth (valuation list / seller conversion)`, or **`None evidenced`** when the probe genuinely doesn't establish one. |
| 6 | `diagnosis_summary` | The two-or-three-sentence commercial read, generated from fields 1–5. This is the sentence Joe says on the call. |

Plus `diagnosis_id`, `agency_id`, `probe_id`, `created_at`, `updated_at`.

**Retired:** `grade` and `tier` (grade lives on `INTELLIGENCE`; tier is `novus_opportunity`'s job now), `evidence_summary` (the concatenated blob), `recommended_solution`, `sales_angle` (the 8 canned strings).

**Superseded (this revision):** the original `primary_problem`/`primary_evidence`/`secondary_problem`/`secondary_evidence` four-field shape capped Diagnosis at exactly one or two discrete problems. It's replaced by the `findings` array above so a probe whose evidence genuinely supports three or four distinct problems isn't forced to compress them into two, or bury the rest inside the `missed_opportunities` prose blob. This is additive to the pipeline described below — no new AI call, no change to `INTELLIGENCE`, no change to the grade — Diagnosis still states *what* the genuine findings are and *why each matters*; it does not decide which of them make the strongest combined story. That selection is the Personalisation layer's job, one level up.

---

## 4a. `DIAGNOSIS_FINDINGS` — 6 fields, one row per finding

**This tab is the canonical story source.** Personalisation reads nothing else
about what happened — not the `DIAGNOSIS` prose, not the `INTELLIGENCE` prose,
not the raw `COMMUNICATIONS` (§4b). Everything the outreach email is allowed to
say therefore has to exist *here*, as a structured finding.

`DIAGNOSIS` holds the whole-probe commercial read. The findings are *separate*,
independently evidence-backed items, so they do not fit one cell of that row —
they are persisted here instead, one row each.

| # | Field | Derivation |
|---|---|---|
| 1 | `probe_id` | The link back to `PROBES` / `DIAGNOSIS`. One probe has 0–6 rows here. |
| 2 | `finding_index` | 1-based, in the order Diagnosis ranked them: **1 = most commercially damaging**. Problems and opportunities are numbered first, positives after them, so an index written before positives existed still means what it did. |
| 3 | `finding_type` | `problem` · `opportunity` · `positive`. **New column** — see below. A blank cell (any row written before it existed) reads back as `problem`, never as a positive. |
| 4 | `finding` | The finding itself, verbatim from Diagnosis. |
| 5 | `evidence` | The specific fact or quote this one finding rests on. Mandatory — a row without it is never written, and is dropped on the way back out. |
| 6 | `significance_note` | Why this specific finding matters commercially. The raw material Personalisation selects on. |

### `finding_type`, and why `strengths` is no longer a story source

| Type | Meaning | Where it lands in the email |
|---|---|---|
| `problem` | Something handled badly or not at all. The default. | `main_finding` or the wider beat |
| `opportunity` | Commercial value sitting inside the enquiry that was never taken — most often the declared property to sell and the valuation behind it. | `main_finding` or the wider beat |
| `positive` | Something the agency genuinely did well. | `fair_observation`, and nothing else |

`DIAGNOSIS.strengths` is unchanged and still written — it is the prose for the
row and for the sales call. What changed is that it is no longer what the email
is built from: `lib/probe-diagnosis.mjs` now also returns `positive_findings[]`
(0–1 items — the single strongest one), each one *one specific act* with its own evidence and its own
one-line significance note, in exactly the same shape as a problem —

> `finding`: "The team followed up quickly."
> `evidence`: "Three attempts across phone and email within one day."
> `significance_note`: "Shows strong persistence."

— not the strengths paragraph chopped up. A probe with no human contact returns
an empty `positive_findings[]`, so a no-response email has no positive to
invent from.

Findings are capped at **4 per probe**: at most 3 problems/opportunities plus
at most 1 positive. The budget is shaped by what Personalisation actually uses
— one fair observation from a `positive`, one main story, and one optional
wider beat — so a fifth or sixth finding never reached a prospect; it only gave
the selection step more near-duplicates to tell apart. Every slot may be empty:
no positive is invented where none is evidenced, and no wider opportunity is
invented where the enquiry did not carry one.

Written by `lib/diagnosis-rebuild.mjs` in the **same batch write** as the
`DIAGNOSIS` row — no extra request, no AI call, and a diagnosis can never be
written without its findings. `lib/observation-recompute.mjs` (the single-probe
/ webhook path) writes them through the **same writer**, so a diagnosis
finalised by that path is never frozen findings-less. Read back by
`lib/personalisation-rebuild.mjs`. Nothing invents a finding here: these rows
are exactly the items that survived §4's evidence gate.

### The write invariant

> **ONE rebuild → ONE `DIAGNOSIS` row per probe → ONE `DIAGNOSIS_FINDINGS` row
> per finding per probe → ONE `PERSONALISATION` row per probe.**
> A probe with 8 findings leaves exactly 8 rows behind.

This is *enforced*, not assumed, because it was once broken: a workbook
carrying two `INTELLIGENCE` rows for one `probe_id` (e.g. `prb_x` and
`prb_x `, which normalise to the same trimmed id) put that probe through the
diagnosis loop **twice inside a single pass**. `DIAGNOSIS` survived it — both
visits resolved through a `probe_id → row` map to the same row — while the
findings writer re-derived "which rows does this probe already own?" from the
table *snapshot* taken at the start of the pass, saw none of the first visit's
rows, and appended a complete second copy. One rebuild, one HTTP request, `N`
findings → `2N` rows. Three things now hold the invariant up:

1. `rebuildAllDiagnosis` and `rebuildAllPersonalisation` visit each `probe_id`
   **at most once per pass**, reporting any duplicate `INTELLIGENCE` rows as
   `duplicate_intelligence_rows_skipped` rather than absorbing them silently.
2. `createFindingsWriter` (`lib/diagnosis-findings.mjs`) keeps its row index
   **live for the whole pass**, so a repeat write for a probe overwrites the
   rows it already claimed, upserts per `(probe_id, finding_index)`, blanks any
   surplus row from a longer previous run, and never hands out a row another
   probe occupies.
3. `repo.writeRowsBatch` collapses two writes to the same range, so a batch can
   never carry contradictory instructions for one row.

Regression suite: `npm run novus:findings-duplication-selftest`.

---

## 4b. `PERSONALISATION` — 20 fields, one row per probe

`DIAGNOSIS_FINDINGS` says what genuinely happened. `PERSONALISATION`
selects one coherent story from those settled findings and supplies the small
set of prose required by Instantly and the current demo.

```
COMMUNICATIONS → INTELLIGENCE → DIAGNOSIS → DIAGNOSIS_FINDINGS
                                            → PERSONALISATION
                                               ├─ Instantly variables
                                               └─ DEMOS
```

### Inputs and source boundary

The model receives:

- the probe id, property value and original enquiry text as factual context;
- that probe's complete, ordered `DIAGNOSIS_FINDINGS` rows; and
- the one deterministic agency scale fact, when available.

It does **not** receive raw `COMMUNICATIONS`, `INTELLIGENCE` prose,
`DIAGNOSIS` prose, the property address, or the probe timestamp.
`lib/personalisation-rebuild.mjs` still reads `INTELLIGENCE` for eligibility,
the no-human-contact rule and the deterministic demo journey, and reads
`DIAGNOSIS` for finalisation/fallback handling. Those rows are not a second
source of model-authored email claims.

### One authoritative selection

The model chooses the story first:

| Field | Valid value |
|---|---|
| `positive_finding_index` | One genuine `positive` finding, or blank when none exists / no human contact occurred |
| `main_finding_index` | The primary `problem` or `opportunity`, or blank only when no story finding exists |
| `wider_finding_index` | An optional, distinct second `problem` or `opportunity` |

Code validates the index types, finding types and main/second distinctness.
`narrative_finding_indexes` is then derived from those three fields rather
than accepted as an independent model answer. `evidence` is likewise rebuilt
from the selected findings' stored evidence.

That selection is authoritative for both `email_observation` and
`email_commercial_hook`. The prompt requires both lines to use all and only
that story. Code rejects either line if distinctive vocabulary reveals an
unselected diagnosis finding. The model receives at most one bounded correction
with the exact failed field and previous selection; it cannot switch to a
separate commercial-classification path.

### The 20 columns

| # | Field | Derivation / consumer |
|---|---|---|
| 1 | `personalisation_id` | DET id assigned by the rebuild |
| 2 | `agency_id` | DET from the probe |
| 3 | `probe_id` | DET from the probe |
| 4 | `hero_journey` | DET lookup from the Intelligence shape and available findings; consumed by DEMOS |
| 5 | `primary_narrative` | AI internal/demo summary of the selected story |
| 6 | `narrative_finding_indexes` | DET sorted union of the three selected indexes |
| 7 | `positive_finding_index` | AI selection, validated as `positive` |
| 8 | `main_finding_index` | AI selection, validated as `problem`/`opportunity` |
| 9 | `wider_finding_index` | AI optional second selection, validated as distinct |
| 10 | `supporting_findings` | AI internal/demo prose for genuine unselected story findings; forced blank when none remain |
| 11 | `evidence` | DET join of the selected findings' stored evidence |
| 12 | `novus_counterfactual` | AI demo copy describing what NOVUS would do |
| 13 | `fair_observation` | AI demo-required sentence, available only when a selected positive exists |
| 14 | `main_finding` | AI demo-required sentence, blank in the no-response case |
| 15 | `commercial_consequence` | AI demo-required consequence retained for the current renderer |
| 16 | `property_reference` | DET from `PROBES.property_address` + `probe_timestamp`, Europe/London |
| 17 | `email_observation` | AI concise Instantly variable from the authoritative selected findings |
| 18 | `email_commercial_hook` | AI Instantly variable that sharpens/quantifies the same selected findings |
| 19 | `created_at` | DET timestamp |
| 20 | `updated_at` | DET timestamp |

### `property_reference`

No model call is involved. Code strips the analyst's trailing bracketed address
note and formats the probe timestamp in `Europe/London`:

```
Grey Lady Place on 21 August at 21:14
```

If either part is unresolved, the value is blank. BST and GMT are handled by
`Intl.DateTimeFormat`, not by manual offsets.

### AI use and bounded correction

A complete valid result costs one Personalisation call. A second and final call
is made only for a fixable selection/coherence failure: invalid selection,
blank/overlong observation, fake praise in a no-response case, or either
Instantly variable introducing an unselected finding.

The retained demo prose does not trigger an email retry. There is no full-email
sendability contract, email-body reassembly loop, variant repair, wider
paragraph repair, or consequence-only repair tool.

Regression suite: `npm run novus:email-personalisation-selftest`.

---

## 4c. The Instantly email contract

Instantly owns the fixed template. NOVUS supplies only
`property_reference`, `email_observation` and `email_commercial_hook`:

```
Hi {{first_name}},

We sent your team an enquiry about {{property_reference}}.

{{email_observation}}

{{email_commercial_hook}}

We picked up a couple of other things from the same enquiry and put together a short personalised breakdown around it.

Worth sending it over?

Joe
```

NOVUS does not generate a greeting, CTA, sign-off, email variant, date/address
paragraph, wider email paragraphs or complete body. A no-response probe uses the
same fixed template; its observation simply states the evidenced absence of a
meaningful response and never forces a positive.

The following former `PERSONALISATION` columns and their dedicated production
logic are retired:

- `email_variant`
- `wider_observation`
- `wider_consequence`
- `additional_findings_hook`
- `email_body`
- `enquiry_date`
- `property_address`

`PROBES.property_address` and `DEMOS.property_address` remain: the former is
the deterministic source of `property_reference`, and the latter is still
required by the demo's first beat. `DEMOS.enquiry_date` also remains and is
compiled deterministically from the probe timestamp.

---

## 4d. `DEMOS` — 55 fields, one row per personalised demo

The last step of the pipeline:

```
PROBE -> COMMUNICATIONS -> INTELLIGENCE -> DIAGNOSIS ->
DIAGNOSIS_FINDINGS -> PERSONALISATION -> DEMOS
```

`PERSONALISATION` decides *what the story is*; `DEMOS` is that story frozen as
a **self-contained, render-ready snapshot** for the page the prospect opens at
`/demo/{demo_slug}`.

### Compiled automatically, never by hand

`lib/demo-compile.mjs` runs as the **last step of `lib/rebuild-pass.mjs`**,
immediately after `rebuildAllPersonalisation`. A probe that finishes
Personalisation comes out of that same invocation with a live demo. There is no
manual build step in the acquisition workflow, and no compilation of any kind
at prospect page-load time.

`rebuildAllPersonalisation` now returns `personalised_probe_ids`; the compile
step takes that list and compiles exactly those probes, **plus** any
already-personalised probe with no demo row yet — so a tab created after the
fact, a budget-capped earlier pass, or a row deleted by hand all self-heal on
the next pass rather than needing a human.

The step makes **no AI calls** and takes no share of the AI budget — it only
packages and displays intelligence the pipeline already produced upstream, in
`COMMUNICATIONS`/`INTELLIGENCE`/`DIAGNOSIS`/`PERSONALISATION`. It has its own
budgets (`maxDemoCompiles`, default 25; `maxDemoImageFetches`, default 6)
because a serverless invocation has a wall clock, and whatever it cannot reach
is picked up next pass. It is wrapped so it can never fail the pipeline: a
missing `DEMOS` tab is a flagged no-op, and a per-probe failure is reported,
not thrown.

### Opening a demo reads one tab

`GET /api/demo?slug=…` resolves the slug in `DEMOS`, loads that row, returns
it. No join, no AI, no Rightmove request. `npm run novus:demo-selftest`
asserts this directly by recording every tab the request reads.

**Only `ready` resolves to a normal request.** A `needs_review` row is an
unfinished prospect experience, so a plain request to it gets the exact same
404 an unknown slug gets — nothing distinguishes "not ready yet" from "never
existed" from the outside. The only way to see one is `?preview=1`, the
internal viewing mechanism (also how a demo is opened without inflating its
own view count). `archived` stays gone under `?preview=1` too — preview
reveals an unfinished demo, never a retired one.

### Duplication here is the point

Fields are copied down from five tabs so one row answers everything the page
needs to *render* and everything a human needs to *debug why a demo says what
it says*. Only genuinely derivable fields are left out.

| Group | Fields |
|---|---|
| Identity | `demo_id` (`dmo_*`), `demo_slug`, `demo_status`, `demo_version`, `review_reasons` |
| Pipeline links | `agency_id`, `probe_id`, `probe_reference`, `personalisation_id`, `hero_journey` |
| Beat 1 — the real event | `agency_name`, `property_address`, `property_price`, `property_url`, `property_image_url`, `property_image_status`, `portal`, `enquiry_at`, `enquiry_date`, `enquiry_time` |
| Beat 2 — the observed facts | `seller_declared`, `human_contact`, `response_time`, `response_hours`, `contact_attempts`, `follow_ups`, `channels_used`, `viewing_progression`, `seller_recognition`, `grade` |
| The copy the prospect reads | `demo_headline`, `demo_hook`, `positive_observation`, `demo_reveal`, `demo_reveal_support`, `main_finding`, `commercial_consequence`, `novus_transition`, `scale_line`, `systemic_bridge`, `cta_headline` |
| Collections (JSON, short by design) | `observed_events_json`, `novus_detected_json`, `novus_decisions_json`, `novus_actions_json` |
| Provenance | `created_at`, `updated_at`, `compiled_at`, `compiled_by`, `ready_at` |
| Analytics — never reset | `first_viewed_at`, `last_viewed_at`, `view_count`, `cta_clicked_at`, `meeting_booked_at` |

### Where each field comes from

Nothing is invented. Prospect-facing prose is `PERSONALISATION`'s own copy,
raised to a standalone sentence and never rewritten.

| Field | Source |
|---|---|
| `positive_observation` | `PERSONALISATION.fair_observation`, sentence-cased |
| `main_finding` | `PERSONALISATION.main_finding`, sentence-cased |
| `commercial_consequence` | `PERSONALISATION.commercial_consequence`, sentence-cased |
| `hero_journey`, `personalisation_id` | the `PERSONALISATION` row |
| `property_*`, `portal`, `probe_reference`, `enquiry_*` | the `PROBES` row (`property_address` through the same address cleaner used by `property_reference`; `enquiry_date`/`enquiry_time` in Europe/London) |
| `seller_declared` | `hasVendorDeclaration(probe)` — the deterministic marker, not an AI read |
| `agency_name` | the `AGENCIES` row |
| `human_contact` … `grade` | the `INTELLIGENCE` row verbatim (`response_time` is `response_hours` formatted) |
| `observed_events_json` | the probe's matched `COMMUNICATIONS` rows, by fixed rules — see below — falling back to an `INTELLIGENCE`-only summary when none are matched |
| `novus_detected_json` | this probe's `DIAGNOSIS_FINDINGS` plus the facts that make them real |
| `novus_decisions_json` | leads with `PERSONALISATION.novus_counterfactual`, then the journey's product decisions |
| `demo_headline`, `demo_hook`, `demo_reveal`, `demo_reveal_support`, `novus_transition`, `scale_line`, `novus_actions_json`, `systemic_bridge`, `cta_headline` | authored per journey in `lib/demo-journeys.mjs` — product copy, chosen by that probe's own evidence (see "Four journeys, one shell" below) |
| `demo_reveal_support` | the journey's own supporting sentence, used **only** where `PERSONALISATION` produced neither a `commercial_consequence` nor a `main_finding` |

### `observed_events_json` — real evidence, zero AI

`lib/demos.mjs`'s `selectCommunicationEvidence()` reads the probe's matched
`COMMUNICATIONS` rows ("matched" = `probe_id === probeId`, the same rule
`lib/observation-recompute.mjs` already uses) and picks up to three events by
**fixed rules over fields the pipeline already wrote when each message
arrived** — `occurred_at`, `channel`, `automated_or_human` (read through
`isHumanCommunication()`, the same deterministic classifier
`lib/observation.mjs`'s own `INTELLIGENCE` rollup uses), `voicemail_present`,
and the message's own stored `transcript`/`body_text`/`subject`. It never
calls `lib/ai-client.mjs` — nothing here selects, ranks, summarises or
rewrites with a model.

**One fixed chronology, whichever journey is running.** The blocks are always
written in this order, and the DATA decides which of them appear:

| Block | When | What it says |
|---|---|---|
| `Enquiry sent` | always (where the probe carries a property or a declaration) | the property, the date and time it was sent, and what the buyer declared — including whether that property was already on the market |
| `Fast first response` / `First meaningful response` | a human touched the enquiry | the **measured delay first** (`Fast` only where `response_hours < 1` — a fact about the number, never about the journey), then the most useful sentence of that first touch, or simply *"Voicemail left."* for an unanswered call |
| `Automated acknowledgement` | no human ever touched it, but an automated message exists | named as automated in both the label and the sentence, and always followed by the block below — it is never allowed to stand in for a response |
| `No meaningful human response` | no human ever touched it | *"No meaningful human contact was recorded by email, phone or SMS during the four-day observation period."* — the window is the probe's own (`resolveObservationDeadline()`), degrading to generic phrasing rather than a guessed number |
| `Buyer / viewing progression` | `viewing_progression` is set | the ordinal in prospect-facing language, so the agency is **credited** for what it genuinely did before anything is said about the vendor |
| `What happened next` | a human touched the enquiry | the remaining genuine attempts by count and channel (`lib/observation.mjs`'s own 30-minute grouping, so it can never disagree with the metric strip), or an explicit *"No further contact attempt was made after the first response."* |
| `Seller opportunity` | the enquiry declared a property to sell | `seller_recognition` in prospect-facing language. `asked_position` is **recognition** — *"recognised … but it never reached a valuation or any other seller-side next step"* — and is never described as ignored or missed |

Where a message's own text is shown, it is a **mechanical extraction** of what
is already stored: the sentences are scored against fixed phrase lists, the
highest-scoring one is taken and truncated to 170 characters with an ellipsis
— never a summary, never reworded. A probe with no matched `COMMUNICATIONS`
still gets the metric strip and the explicit absence, so the section is never
blank.

"Relevant to the stored `hero_journey`" is satisfied by the **data**, not a
branch on it: a `complete_miss` probe has no human touches, so it gets the
acknowledgement and absence blocks; a `fast_response_stalled_follow_up` probe
has one attempt and no follow-up, so `What happened next` states exactly that.
`selectCommunicationEvidence()` stays journey-blind, same as the renderer and
same as `lib/demo-journeys.mjs`'s own architecture.

Regression suite: Part N of `npm run novus:demo-selftest`.

### Four journeys, one shell

`/demo/{slug}` is the **single entry point**. The slug resolves to the agency's
own `DEMOS` row, that row carries `hero_journey`, and `hero_journey` is what
selected the narrative when the row was compiled. There are no per-journey
URLs, no hand-assigned pages, and `demo.html` contains **no `hero_journey`
branch at all** — it renders whatever the row carries.

| `hero_journey` | The story |
|---|---|
| `weak_seller_qualification` | the buyer was worked; the declared vendor was not |
| `slow_response_gap` | the enquiry did get human attention, but only after a commercially meaningful delay |
| `fast_response_stalled_follow_up` | the response was genuinely fast; the opportunity stopped moving after it |
| `complete_miss` | no meaningful human progression at all inside the observation window |

Anything else `lib/probe-personalisation.mjs` can emit is **refused**
(`journeySupport()` → `unsupported_hero_journey`), and a blank `hero_journey`
is refused too. No row is compiled, so the link resolves to nothing rather
than to another journey's narrative — the routing fails safe rather than
silently showing the wrong story.

**The seller finding is never buried.** `hero_journey` names the *primary*
operational story, not the only one worth telling. Where the enquiry declared
a property to sell and that opportunity never reached a seller-side next step,
that finding is carried into the hero and the conclusion of whichever journey
is running — a slow reply is a speed problem, an unworked vendor is a revenue
one, and the second is usually the larger.

**Personalisation happens inside a journey, not just between them.** Every
clause is picked from that probe's own evidence, so two agencies on the same
journey do not read the same:

| Signal | What it changes |
|---|---|
| `seller_declared` | whether the hero, the conclusion and the UNDERSTANDS list mention a vendor at all |
| `seller_recognition` | `none` → *"never acknowledged or explored"*; `asked_position` / `acknowledged` → *"recognised, but not progressed"*; `valuation_offered` / `valuation_booked` → no seller gap, and the seller story is dropped from the hero entirely |
| `viewing_progression` | the credit line, and whether the conclusion can draw the *"the viewing was actively progressed, the potential vendor wasn't"* contrast |
| `response_hours` | the measured delay in the hero, and whether the first-response block reads as fast. "Quickly" is only ever used where no time was established |
| `contact_attempts` / `follow_ups` | whether the team is described as having followed up, and the real follow-up count in UNDERSTANDS |
| `channels_used` | the channels named in `What happened next` |
| `voicemail_present` | *"Voicemail left."* instead of a quoted excerpt |

Three of the journeys also override headings the shell would otherwise write
itself — `demo_headline` (act 1), `novus_transition` (act 3) and `scale_line`
(act 3). **A blank value means "the shell's own default is already right"**,
which is why `weak_seller_qualification` leaves all three empty and renders
exactly as it did before journeys could set them.

Regression suite: Part Q of `npm run novus:demo-selftest`.

### `ready` vs `needs_review`

The lifecycle is compile-driven, not publish-driven. `reviewReasonsFor()` in
`lib/demos.mjs` is the whole rule: **any** reason means `needs_review`, none
means `ready`. The reasons are written to `review_reasons` so a human can
triage from the sheet.

| Reason | When |
|---|---|
| unreviewed journey | `hero_journey` is supported but not yet in `AUTHORED_HERO_JOURNEYS`. All four current journeys are authored, so nothing produces this reason today; it is the gate a newly added journey passes through |
| `agency_name` blank | the CTA cannot name the agency |
| `property_address` blank | beat 1 has no property to show |
| `commercial_consequence` blank | beat 2 has no payoff |
| `positive_observation` blank | **and** `human_contact = yes` — where nobody responded there is genuinely nothing to credit, so a `complete_miss` demo is not flagged for it |
| `novus_detected` empty | beat 3 has nothing for NOVUS to have recognised |
| fewer than 2 observed events | beat 2 has no evidence; one event is just "an enquiry arrived" |

**A missing property image is not a review reason.** The renderer falls back to
the drawn placeholder and the demo reads correctly without it; it is recorded
in `property_image_status` (`ok` / `manual` / `unavailable` / `pending` /
`none`) instead. `pending` (the pass's image budget ran out) is retried next
pass; `unavailable` is not, so a dead listing is not re-fetched forever.

`needs_review` demos are **internal-only** — see "Opening a demo reads one
tab" above: a normal request 404s exactly like an unknown slug, and only
`?preview=1` can see one, flagged in the page chrome, so it can be checked
before the link is ever sent. `archived` 404s under every request, preview
included, and is **sticky** — a recompile refreshes an archived demo's
snapshot but never brings its link back.

### A recompile updates the snapshot, never the identity or the history

Rebuilding Personalisation before outreach may recompile the demo. Carried over
from the existing row, unchanged: `demo_id`, `demo_slug`, `created_at`,
`ready_at`, and every column in `ANALYTICS_COLUMNS` (`view_count`,
`first_viewed_at`, `last_viewed_at`, `cta_clicked_at`, `meeting_booked_at`).
That list lives in code, not in a convention.

### `hero_journey` support

`lib/demo-journeys.mjs` carries a **shell of four** — `complete_miss`,
`slow_response_gap`, `fast_response_stalled_follow_up`,
`weak_seller_qualification` — of which only `weak_seller_qualification` is
authored. The other three compile but are held at `needs_review`.

The three journeys `pickHeroJourney()` can still emit and the demo has no
design for — `automated_ack_only`,
`strong_handling_database_opportunity`, `strong_handling_no_opportunity` —
are **refused by name** rather than fudged into the nearest shape. The
automatic pass counts them (`skipped_unsupported_journey`) and carries on.

### The renderer is journey-blind

`demo.html` contains no `hero_journey` branch. It renders whatever the row
carries and hides whatever is blank, which is what stops four journeys becoming
four demo pages. Adding a journey is authoring content in
`lib/demo-journeys.mjs`; the page does not change.

Regression suite: `npm run novus:demo-selftest`.

---

## 5. The three rules that stop it going canned

1. **Grade never selects a paragraph.** Today `primary_problem` and `sales_angle` are each one of 8 strings keyed off the grade letter. In V2 the grade is not an input to `DIAGNOSIS` at all. Two probes graded `F` produce different diagnoses because their evidence is different — demonstrated in §7.

2. **`primary_problem` may be blank.** A `DIAGNOSIS` row exists only for a closed, diagnosed observation, so blank means *"assessed, no problem found"*, not *"not computed"* — no status column needed. When it's blank, `strengths`, `missed_opportunities` and `novus_opportunity` carry the row, and `diagnosis_summary` says plainly that they handled the probe well. If the evidence also shows no wider opening, `novus_opportunity` is `None evidenced`. **Nothing is invented to fill the field.**

3. **Every claim is quoted, and every quote is checked.** Each AI field must cite verbatim text that is validated as a literal substring of the message it came from. A quote that fails validation is dropped and so is the claim. This cuts both ways: it stops the current phrase-list blindness (missing *"are you on the market?"*) without letting the AI invent wording that was never there.

---

## 6. Data flow

### New communication arrives

```
webhook → RAW_EVENTS → deterministic agency + probe match → COMMUNICATIONS row
                                                                  │
                                              recomputeProbe(probe_id)
                                                                  │
  1. LOAD      PROBES row + ALL COMMUNICATIONS for this probe  (complete evidence, always)
  2. DET       fields 4–10 + 19–20 — recomputed from scratch, every time
  3. AI        fields 11–18 — one call, because evidence just changed
  4. WRITE     upsert the one INTELLIGENCE row for this probe
  5. DIAGNOSE  if observation_status = closed → one AI call → upsert the DIAGNOSIS row
                                               + one DIAGNOSIS_FINDINGS row per finding
                                                 (same batch write — see §4a)
  6. PERSONALISE  if the DIAGNOSIS is finalised → normally one AI call, reading
                  this probe's DIAGNOSIS_FINDINGS plus limited probe context →
                  upsert the PERSONALISATION row and its Instantly variables
                  (one bounded selection/coherence correction is possible; §4b, §4c)
  7. COMPILE THE DEMO  no AI call. Every probe step 6 just personalised (plus any
                  already-personalised probe with no demo row yet) → upsert one
                  DEMOS row: the render-ready snapshot behind /demo/{demo_slug}
                  (§4d). Best-effort listing-image fetch; never blocks.
```

The full pipeline is therefore:

```
PROBE → COMMUNICATIONS → INTELLIGENCE → DIAGNOSIS → DIAGNOSIS_FINDINGS → PERSONALISATION → DEMOS
                                                                              │
                                                                              ├→ EMAIL (§4c)
                                                                              └→ /demo/{demo_slug} (§4d)
```

Steps 1–6 are `recomputeProbeObservation` (the webhook path) and
`runRebuildPass` (the batch path); **step 7 runs in `runRebuildPass` only**, as
its last step. A probe finalised by the webhook path gets its demo on the next
rebuild pass or cron run.

### Rebuild Intelligence

Identical pipeline, batch-loaded once per tab (the existing `lib/intelligence-rebuild.mjs` shape, kept for the Sheets read quota), run over **every** `PROBES` row — including probes with zero communications and probes whose `INTELLIGENCE` row is blank today.

Because step 1 always reloads the complete stored evidence and nothing is derived from the arriving message alone, **the live path and the rebuild path are the same code**, and historical rows fill in on the first press.

### When the AI runs

No fingerprints, no hashing. One rule:

| Situation | AI runs? |
|---|---|
| A new communication just landed for this probe | **Yes** — evidence changed by definition |
| Rebuild, and the row's AI fields are blank (every historical probe today) | **Yes** |
| Rebuild, and the row's AI fields are already populated | **No** — reused as-is |
| `POST {"force_ai": true}` | **Yes** — for when the prompt changes |

Deterministic fields are recomputed on every run regardless, so they self-heal. Because a second rebuild finds the AI fields populated and skips them, `npm run novus:pipeline-regression`'s existing *"a second rebuild changes nothing"* invariant still holds.

Two AI calls per probe, once. Roughly 30 live probes → ~60 calls to populate the entire history. Suggested model: `claude-sonnet-5` (the key is already configured for `api/chat.js`).

### To go live

1. Add the new columns to the `INTELLIGENCE` and `DIAGNOSIS` header rows.
2. Press **Rebuild Intelligence**.

`repo.appendRecord`/`updateById` already drop keys the header doesn't have, so step 1 is the only sheet prerequisite and nothing breaks in between.

### To go live with demos (§4d)

1. Create a `DEMOS` tab whose row 1 is exactly `DEMOS_HEADER` from
   `lib/demos.mjs` (`node -e "import('./lib/demos.mjs').then(m=>console.log(m.DEMOS_HEADER.join('\t')))"`
   prints a tab-separated line to paste). **An existing tab needs the same
   check whenever `DEMO_VERSION` is bumped**: a row is written against the LIVE
   header, so a column the sheet does not have is silently dropped rather than
   erroring. `DEMO_VERSION 4` added `demo_headline`, `demo_reveal_support`,
   `novus_transition` and `scale_line`; until those four columns exist, the
   three new journeys render with the shell's default headings instead of
   their own.
2. Press **Rebuild Intelligence** once.

That single pass backfills a demo for **every** already-personalised probe —
the compile step treats "personalised, but no demo row" as work to do. Until
the tab exists the step is a flagged no-op (`demos_tab_missing`) and nothing
else in the pipeline is affected.

---

## 7. Worked examples from the live data

*(Written against the original `primary_problem`/`secondary_problem` shape — still accurate on content and reasoning, since §4's `findings` array is the same evidence-gated judgement, just no longer capped at two items. Where an example below shows a "primary" and a "secondary" problem, read those as the first two entries of `findings`.)*

### 7.1 Barn Field — `RM-0031`, Ensum Brown (strong handling, real speed problem)

Probe sent `2026-08-17T22:34:41Z` (11:34pm) on *Barn Field, Chevington, IP29*, £375,000, declaring a property to sell that is not yet on the market.

**Voicemail**, `16:25:30` the next day, 38s: *"…this is Vicky calling from [Ensum Brown]… reaching out on your inquiry… **Just wanted to have a quick chat. See what your position is at the moment.** Take some details and we can **get you booked in for a [viewing]** and **I'll follow up with an email for you.**"*

**Email**, `16:26:51` — 81 seconds later, subject *"Ensum Brown | Viewing Enquiry"*: *"Thank you for your enquiry on **Barn Field, Chevington, IP29**. I'd be happy to arrange a viewing for you. **I tried to give you a call, but I appreciate you may be busy, so I thought I'd follow up by email.**"* — then eight questions: partner details · address · ***"What is the situation with your current property? Are you on the market or renting for example?"*** · finance/mortgage (with an affordability-check offer) · budget · specifications · areas · comments — and *"**Please also let us know your availability for a viewing**, and we'll do our best to arrange a suitable time."* Signed **Vicky**.

**`INTELLIGENCE`:**

| Field | Value |
|---|---|
| `human_contact` | `yes` |
| `response_hours` | `17.85` |
| `first_human_response_at` | `2026-08-18T16:25:30.507Z` |
| `contact_attempts` / `follow_ups` | `1` / `0` — the call and the email are 81 seconds apart, one attempt under the 30-minute rule |
| `channels_used` | `voice,email` |
| `viewing_progression` | `availability_requested` |
| `buyer_qualification` | `thorough` |
| `buyer_questions_asked` | `partner details; current address; current property position; finance/mortgage; budget; requirements; areas; viewing availability` |
| `seller_recognition` | `asked_position` |
| `communication_quality` | `strong` |
| `did_well` | Called first, then emailed 81 seconds later on a second channel, and said why. Named the property and the prospect. Gave a direct dial. Asked eight qualification questions including the buyer's current property position and finance. Offered an affordability check. Asked for viewing availability. Signed by a named person. |
| `missed` | Asked whether the prospect was on the market but never offered a valuation or market appraisal in either message. The enquiry asked for more detail on the property; neither message supplied any — the email asked the buyer to complete a registration first. |
| `evidence` | *"Are you on the market or renting for example?"* (email, 16:26:51) · *"See what your position is at the moment."* (voice, 16:25:30) · *"Please also let us know your availability for a viewing"* (email, 16:26:51) · *"I tried to give you a call… so I thought I'd follow up by email"* (email, 16:26:51) |
| `grade` / `grade_reason` | `F` / *Slow human contact (>16h) with 0 genuine follow-up attempts (§10)* — unchanged |

**What today's system says instead:** `Vendor opportunity: no_evidence` — because `lib/vendor-intent.mjs` needs the literal string *"free valuation"* or *"market appraisal"*. Vicky asked the seller question in the words a real agent uses, and the pipeline reports she ignored the instruction lead. It also has nowhere to record eight qualification questions; that fact currently reduces to `contact_quality = "Booking attempt"`.

**`DIAGNOSIS`** (once the window closes with nothing further):

| Field | Value |
|---|---|
| `primary_problem` | Nothing reached the enquiry for 17.8 hours. It went in at 11:34pm and first contact came at 5:25pm the following **afternoon** — past the first half of the next working day. |
| `primary_evidence` | Probe `2026-08-17T22:34:41Z` → first human contact `2026-08-18T16:25:30Z` = 17.85 hours. |
| `secondary_problem` | The declared seller was asked about their position and then never offered a valuation. The instruction lead was noticed and dropped. |
| `secondary_evidence` | *"What is the situation with your current property? Are you on the market or renting for example?"* — no valuation, appraisal or valuer mentioned in either message. |
| `strengths` | Once engaged, among the strongest handling in the set. Voicemail and email inside 81 seconds across two channels. Named the property and the prospect. Explained why she was emailing after calling. Direct dial given. Eight structured qualification questions. Affordability check offered. Viewing availability requested. Signed by a named person. |
| `missed_opportunities` | An off-market instruction on a £375,000 enquiry, recognised in words and never converted to a valuation. The property detail the enquiry asked for and never received. |
| `commercial_implication` | Ensum Brown's handling isn't the problem — their clock is. A £375,000 Chevington enquiry carrying an off-market instruction sat untouched from 11:34pm until nearly 5:30pm the next day. Vicky then handled it better than most agencies in the set. NOVUS doesn't need to write her a better reply; it needs to send *her* reply at 11:35pm. |
| `novus_opportunity` | `Core (front desk)` — for out-of-hours coverage specifically. The qualification and the viewing push are already in place and would be preserved, not replaced. Growth is the stronger fit if the valuation conversion is the priority, since the seller thread was opened and dropped rather than never seen. |
| `diagnosis_summary` | Strong front desk, wrong hours. Seventeen hours of silence on an enquiry carrying an off-market instruction, then a genuinely good response that asked the right questions and stopped one question short of a valuation. Sell the clock, not the conversation. |

Note what the diagnosis does **not** do: it doesn't call this a front-desk weakness. The evidence shows the opposite once they engaged, so `strengths` is the longest field on the row and the problem is stated as timing, backed by two timestamps.

### 7.2 Chalmers Agency — `prb_hist_0010` (same grade, opposite diagnosis)

One human email, 63.6 hours after the probe: *"Hi Joe. Thank you for your Rightmove enquiry regarding Flat 7, 151A High Street, Brentwood. A member of our team will be in touch soon. In the mean time, if you want to see more details about the property, register."* Nothing else, ever.

**`INTELLIGENCE`:** `human_contact` `yes` · `response_hours` `63.57` · `contact_attempts` `1` · `follow_ups` `0` · `channels_used` `email` · `viewing_progression` `none` · `buyer_qualification` `none` · `buyer_questions_asked` *(blank)* · `seller_recognition` `none` · `communication_quality` `generic` · `did_well` *"Came from a named mailbox and named the correct property. No other positive signal is evidenced."* · `missed` *"No viewing proposed. No qualification question of any kind. The declared property to sell is not mentioned in any message. The promise that 'a member of our team will be in touch' was never kept."* · **`grade` `F`** — the same letter as Barn Field.

**`DIAGNOSIS`:** `primary_problem` — *63.6 hours (two and a half days) to any human contact, and what arrived was a holding line, not a response.* `secondary_problem` — *the declared seller was never mentioned in any message; an off-market instruction lead went entirely unrecognised.* `missed_opportunities` — *both of them: no viewing was proposed and no valuation was offered.* `novus_opportunity` — `Core (front desk)`. `diagnosis_summary` — *Three days of silence on a Brentwood enquiry that also carried an instruction, answered by a message that asked for nothing and offered nothing. By the time it arrived the buyer had had 63 hours to book elsewhere, and the seller half was never seen at all.*

**Same grade letter, four specific findings instead of one, and a completely different commercial read** — because `DIAGNOSIS` reads the evidence, not the grade.

### 7.3 What a genuinely strong probe produces

Fast human contact, a real chase, thorough qualification, the viewing booked **and** the valuation booked:

`primary_problem` **blank** · `secondary_problem` **blank** · `strengths` full · `missed_opportunities` *"None evidenced. Both opportunities the probe created were taken."* · `novus_opportunity` either `Growth (valuation list / seller conversion)` where the evidence supports a wider opening, or **`None evidenced`** · `diagnosis_summary` — *"They handled this probe better than the system was built to fault. No front-desk gap is evidenced."*

This is the outcome today's `computeDiagnosis()` structurally cannot reach.

---

## 8. What changed from the first proposal

| | First proposal | This one |
|---|---|---|
| `COMMUNICATIONS` | +6 columns, 1 rename | **+0 columns, 0 renames** |
| `INTELLIGENCE` | ~60 fields | **20** |
| `DIAGNOSIS` | 26 fields | **9** |
| Opportunity model | `enquiry_opportunities` vocabulary + 4 recognition fields | **Two hard-coded opportunities: BUYING and SELLING** |
| AI idempotency | `evidence_fingerprint` hashing layer | **Run when blank, or when a communication just arrived, or when forced** |
| Extra tabs | Fourth AI tab floated | **None** |
| Provenance / confidence / warning fields | 8 | **0** |

Dropped deliberately, and easy to add later if they earn it: `ai_confidence`, `evidence_strength`, `interpretation_warnings`, `qualification_gaps`, `personalisation_level`, `named_individual`, CRM signature detection, `responded_next_working_morning`, `attempt_timeline`.

Unchanged throughout: the A–H grading engine, deterministic agency/probe matching, the 30-minute contact-attempt grouping rule, the 4-day observation window, and the webhook ingest path.
