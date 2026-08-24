# COMMUNICATIONS → INTELLIGENCE → DIAGNOSIS — Proposed V2 (demo-ready)

**Status: IMPLEMENTED.** `COMMUNICATIONS`/`INTELLIGENCE`/`DIAGNOSIS` per §1–§4; `DIAGNOSIS_FINDINGS` per §4a; `PERSONALISATION` per §4b; the email structure per §4c.

Scope: `COMMUNICATIONS`, `INTELLIGENCE`, `DIAGNOSIS`.
Not in scope: Demo, SEND DEMO, Outreach, `AGENCIES`, `PROBES`, `RAW_EVENTS`, `ACTIONS`. (`DIAGNOSIS_FINDINGS` and `PERSONALISATION` were added to this document in §4a/§4b when the Personalisation layer was rebuilt — see those sections.)

Totals: **`COMMUNICATIONS` +0 columns**, **`INTELLIGENCE` 20 fields**, **`DIAGNOSIS` 8 fields + `DIAGNOSIS_FINDINGS` 6 fields**, **`PERSONALISATION` 24 fields**. Two AI calls per probe for `COMMUNICATIONS`→`DIAGNOSIS`, plus one for `PERSONALISATION`. No fingerprint layer.

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

## 4b. `PERSONALISATION` — 24 fields, one row per probe

One step further on: `DIAGNOSIS` says *what the genuine findings are*;
`PERSONALISATION` decides **what the story is**, and writes it as
sentence-ready copy. One AI call, no re-diagnosis, no second engine.

### Two inputs, and only two

```
COMMUNICATIONS → INTELLIGENCE → DIAGNOSIS → DIAGNOSIS_FINDINGS
                                            → PERSONALISATION + PROBE → EMAIL
```

The story-generation call receives **the `PROBES` row's factual context**
(property, value, enquiry date, what our enquiry said) and **that probe's
`DIAGNOSIS_FINDINGS` rows**. Nothing else. The `DIAGNOSIS` prose, the
`INTELLIGENCE` prose and the raw `COMMUNICATIONS` are **not** in the prompt —
every one of them restated in paragraphs what the findings already state as
structured facts, and handing them back invited the model to re-diagnose from
the transcript instead of selecting from the findings. `INTELLIGENCE` and
`DIAGNOSIS` are still *read* by `lib/personalisation-rebuild.mjs`, for the
deterministic decisions code owns (the eligibility gate, `email_variant`, the
`hero_journey` lookup); `COMMUNICATIONS` is not loaded for this step at all.

### The story is selected, not composed

Three indexes into the findings list decide which finding each email beat is
written from — chosen *before* any sentence — and every one is validated in
code:

| Field | Must be | Null when |
|---|---|---|
| `positive_finding_index` | a `positive` finding | the list carries no positive, or there was no human contact |
| `main_finding_index` | a `problem` or `opportunity` | the list carries no problem or opportunity at all |
| `wider_finding_index` | a `problem` or `opportunity`, **a genuinely different underlying event from the main one** | there is no distinct second finding — a complete and correct answer |

**This is what fixes the duplicated-story bug.** A probe whose sharpest finding
was the seller / valuation opportunity used to get that opportunity as its main
story *and again* as its wider beat: two paragraphs, one event, one paragraph
apart. Nothing could see it, because the two paragraphs were different
*sentences* about the same *thing* and only the sentences were compared.
Selecting each beat by index makes the event itself comparable, so the
duplicate is refused three ways:

1. **Same index** — the wider beat is the main finding's own number.
2. **Same event, different number** — two findings whose text is the same thing
   reworded (`findingsAreDistinct`).
3. **Same wording** — a valid selection whose `wider_observation` still
   restates `main_finding` (`isDistinctText`).

In every case the wider beat is dropped *and* the answer is sent back for
repair, so the email says the thing once or the paragraph does not appear.
**The wider beat exists only where a wider finding was selected** — an
observation with no finding behind it is an invented finding, whatever it says.

Regression suite: `npm run novus:personalisation-story-selection-selftest`.

**What the email is for.** It is not selling NOVUS. Its only job is to make the
agency curious enough to ask to see what we found. It reads like: we sent you
an enquiry, here is what happened from our side, here is what that meant
commercially, and we found some other interesting things too. The reader should
think *"fair enough, I can see what they mean"*, and then *"what else did they
find?"*.

**The single rule at the centre of this layer.** *Do not optimise for
describing problems. Optimise for revealing missed opportunities.* For every
finding, the question is: **because this happened, what did the agency fail to
find out, progress, convert, or uncover?** The answer to *that* is what the
email is made of — which is why `commercial_consequence`, not `main_finding`,
is the field this layer exists to get right, and why a consequence that merely
rephrases the finding is refused in code (`consequenceGoesBeyondFinding`).

**Sentence-ready is the contract.** Every email field is copy that drops
straight into the email with no repair — never a label like `Poor follow-up`
or `Weak qualification` (those are Diagnosis concepts, not email copy), never a
fragment the code has to fix up.

**The grammar contract.** The assembler owns the **fixed opening words** of
four paragraphs, so those four fields are stored as **lower-case
continuations** and every other narrative field is a whole sentence:

| Fixed wording (assembler) | Field (continuation) |
|---|---|
| `I want to say upfront that ` | `fair_observation` |
| `What stood out, though, was ` | `main_finding` |
| `That meant ` | `commercial_consequence` |
| `That also meant ` | `wider_consequence` |
| *(none — its own sentence)* | `wider_observation` |

`asContinuation()` enforces the first four (a prefix the model wrote is
stripped in either tense, the first letter is lower-cased — except the pronoun
"I" and genuine acronyms — and terminal punctuation is guaranteed);
`asStandaloneSentence()` enforces the last. `withPrefix()` in the assembler is
the backstop against a prefix ever printing twice.

**Voice.** The email is written *to* the agency by the person who actually sent
the enquiry: they are "you", we are "I"/"me"/"we". Detached third-person
commentary ("They didn't let this one go cold") is the failure mode and is
blanked by `readsAsDetachedThirdPerson()`.

The row splits in two. **Internal** fields drive the breakdown and the demo and
are never shown to a prospect. **Email copy** is read by a real estate agent.

### Internal — the breakdown / demo / our own reasoning

| # | Field | Derivation |
|---|---|---|
| 1 | `hero_journey` | DET — the breakdown/demo journey, a lookup from Intelligence shape + whether findings exist. Never asked of the model. |
| 2 | `primary_narrative` | The single strongest commercially consequential story. **Combining several findings into one broader problem is the normal answer, not the exception** — most enquiries contain more than one useful finding. Not "finding #1". |
| 3 | `narrative_finding_indexes` | Which `DIAGNOSIS_FINDINGS.finding_index` values the three beats rest on, ascending, e.g. `1,2,4`. Written from the selection below rather than from a free list the model returns alongside it. |
| 3a | `positive_finding_index` | **New column.** The finding the fair observation was written from. Blank where none was selected. |
| 3b | `main_finding_index` | **New column.** The finding the main story was written from. |
| 3c | `wider_finding_index` | **New column.** The finding the wider beat was written from. Blank when there is no distinct second finding — which is a correct answer, not a gap. |
| 4 | `supporting_findings` | The genuine `problem`/`opportunity` findings left *outside* the selection. Forced empty when the selection already covers them all. An unselected positive is not an outstanding finding. |
| 5 | `evidence` | **No longer asked of the model.** The evidence of the findings the story selected, joined — grounded by construction, since the model never sees a raw message to misquote. |
| 6 | `novus_counterfactual` | What NOVUS would have done at *this* moment. Matches the handling, rather than inventing a gap, when the handling was strong. |

### Email copy — sentence-ready, read by the prospect

| # | Field | Derivation |
|---|---|---|
| 7 | `enquiry_date` | DET — the probe's own `probe_timestamp`, formatted `18 August` in Europe/London so an evening probe keeps the date the agency would recognise. |
| 8 | `property_address` | DET — `PROBES.property_address`, stripped of the analyst's trailing bracketed note (which can contain a stray price). **Blank when the address was never established**, which makes the row unsendable (field 14). |
| 9 | `email_variant` | DET — `no_response` when `INTELLIGENCE.human_contact` is `none`, otherwise `normal`. Selects the email structure (§4c). |
| 10 | `fair_observation` | **Mandatory in the normal variant. Continuation of `"I want to say upfront that "`.** Written from the finding at `positive_finding_index`. Its job is to *disarm*: something genuinely good, backed by the strongest specific evidence available — *"…you followed up properly — three attempts across phone and email inside 14.5 hours, with my name and Fox Cottage referenced correctly and a clear way to get back in touch."* Specific, but not a dump of every positive detail. Rejected (and the row left unsendable) when it reads as detached commentary or **sneaks criticism in** with *eventually / although / despite / however* (`readsAsSnuckCriticism`); forced blank in the no-response case, where there is no positive finding to write it from. |
| 11 | `main_finding` | **Continuation of `"What stood out, though, was "`.** The most important thing not handled well: specific, grounded in what actually happened, understandable without the underlying analysis, written from the enquiry's perspective, and about **behaviour** rather than an abstract business judgement (*"Your qualification process was weak"* is wrong). Where several findings are really one story, they are woven into this so it reads as one thing that happened. Blank in the no-response case. |
| 12 | `commercial_consequence` | **Continuation of `"That meant "`. The most important field in the email.** Answers *"so what did this actually mean for the agency?"*: what happened → what opportunity should have been captured → what was not captured or progressed → why that matters. It must **not paraphrase field 11** — one that restates it is dropped, which makes the row unsendable (field 16) rather than sending an email that describes a problem and never says what it cost. |
| 13 | `wider_observation` | **Optional.** A standalone sentence naming a second thing the enquiry carried that never came into the conversation — *"I'd also mentioned that I had a property of my own that I was considering selling, but that never really came into the conversation."* Never invented to fill the field. |
| 14 | `wider_consequence` | **Optional. Continuation of `"That also meant "`.** One level beyond field 12, only when there is a genuinely *distinct* second commercial implication — *"…a potential seller instruction sitting inside the same enquiry was never explored."* A value that merely restates field 12 is dropped rather than printed twice (`distinctWiderConsequence`). If the main consequence tells the whole story, this stays empty. Never forced. |
| 15 | `additional_findings_hook` | DET — **not AI-authored.** One fixed tease line ("There were a couple of other things from the enquiry that caught our attention too.") shown only when a real finding sits outside the primary narrative; blank otherwise, and always blank in the no-response case. It must **not** reveal what the other findings were — that is the question the email exists to provoke. |
| 16 | `email_body` | DET — the complete email, assembled by `lib/email-assembly.mjs` from fields 7–15 (§4c). **Blank when the row cannot make a complete, honest email**, which is the signal that a human should look. |

Plus `personalisation_id`, `agency_id`, `probe_id`, `created_at`, `updated_at`.

**The seller side** is considered explicitly. When our enquiry said we also had
a property of our own to sell, that enquiry was not just a potential buyer —
there was a valuation and an instruction sitting inside it — and that is often
the sharpest part of `commercial_consequence` or `wider_consequence`. It is
never forced onto an enquiry that did not say so.

**Retired from `PERSONALISATION`:** `personalised_opener`, `quotes_used`
(renamed `evidence`), `wider_leakage`, `systemic_promise`, `why_novus`,
`objection_response`, `demo_intro`, `email_main_point` (renamed
`main_finding`), `email_consequence` (renamed `commercial_consequence`),
`email_secondary_hook` (renamed `additional_findings_hook`), and
`commercial_story` — superseded by `commercial_consequence` /
`wider_consequence`, which say the same thing in copy the email can use.

**Added:** `wider_observation` — the standalone sentence that sets up
`wider_consequence` (the *"I'd also mentioned…"* line) — and
`positive_finding_index` / `main_finding_index` / `wider_finding_index`, the
stored selection. All four are written through the same header-driven row
builder as every other column: if the live `PERSONALISATION` tab does not carry
one yet, the value is simply not persisted, and `email_body` is assembled and
stored at write time so the sent email is unaffected. The columns should be
added to keep the row complete and the selection auditable.

**Retired (this revision):** `evidence_quotes` on the AI tool — the model no
longer sees the raw messages, so there is no quote for it to produce or
fabricate, and `evidence` is derived from the selected findings instead.

---

## 4c. The email — a fixed structure in `lib/email-assembly.mjs`

The email is **not** generated as a blob by the AI, and it does not live in a
template in another product. The *sentences* come from Personalisation; the
*shape* is fixed, so it lives in code where a human controls it:
`assembleEmail()` owns the intro, the paragraph order, which optional
paragraphs appear, which structure to use, the locked CTA and the merge fields.
Nothing in the assembler rewrites an AI sentence.

### The normal structure

```
Hi {{first_name}},

We sent your team an enquiry on {enquiry_date} about {property_address}.

I want to say upfront that {fair_observation}        (optional)

What stood out, though, was {main_finding}

That meant {commercial_consequence}

{wider_observation}                 (optional)

That also meant {wider_consequence} (optional)

{additional_findings_hook}          (optional)

I've put together a personalised breakdown of what we found. Happy to send it
over if you'd like to see it.

Joe
```

### The no-response structure (`email_variant = no_response`)

A probe that was never replied to has no conversation to describe, so it gets
its own shape rather than a normal email with empty paragraphs. **The failure
IS the silence**, so nothing is invented to fill it: no imagined replies, no
imagined conversation, and no extra communication findings.

```
Hi {{first_name}},

We sent your team an enquiry on {enquiry_date} about {property_address}.

We never received a reply.

That meant {commercial_consequence}

{wider_observation}                 (optional)

That also meant {wider_consequence} (optional)

We found a couple of things that may explain it, so we've put together a short
breakdown that might be useful.

Happy to send it over if you'd like to see it.

Joe
```

The wider consequence still applies here — a seller/valuation opportunity our
own enquiry explicitly declared is still lost — and the closing lines are
reworded so the offer makes sense when there was nothing to discuss.

### Consequences enforced in code, not just prompted for

- **The CTA is locked** and never AI-authored. It is a *breakdown*, never an
  "audit" — the assembler's own test asserts the word never appears.
- **The fixed openers are never printed twice.** Each of the four prefixed
  fields is stored as a continuation with any prefix the model wrote stripped,
  and `withPrefix()` in the assembler refuses to double one that survived.
- **`fair_observation` is either genuinely fair or absent** — hedged praise
  (*eventually / although / despite / however*) is dropped, not repaired.
- **`commercial_consequence` must go beyond `main_finding`** — a restatement is
  dropped, and the row then assembles no email at all.
- No field may carry a greeting, sign-off, CTA, transition, or merge-field
  syntax of its own.
- No field may carry our internal reasoning about the analysis. A model asked
  for a fair observation when there is nothing fair to say will often explain
  *itself* ("there is no strength to point to here") instead of returning the
  empty string it was asked for; `readsAsInternalReasoning()` blanks any such
  value rather than sending it.
- Optional paragraphs are **omitted entirely** when blank — the email closes
  up rather than leaving a gap.
- `additional_findings_hook` is never free text the model writes — one fixed
  tease line or blank — so it can never turn into a second paragraph of
  analysis, a second consequence, or a reveal of the findings it exists to
  tease.
- `{{first_name}}` is the **only** unresolved merge field in the assembled
  body; `enquiry_date` and `property_address` are resolved from the probe's own
  facts.
- A row missing anything its structure needs (no address, no date, no
  consequence, or no main finding in the normal structure) assembles **no
  email at all**. A blank `email_body` means a human decides, never a
  half-written email.

---

## 4d. `DEMOS` — 43 fields, one row per published personalised demo

One step past the email. `PERSONALISATION` decides *what the story is*;
`DEMOS` is that story **frozen as render-ready copy** for the page the
prospect actually opens at `/demo/{demo_slug}`.

**Why the tab exists.** The demo must not query `PROBES` + `AGENCIES` +
`INTELLIGENCE` + `DIAGNOSIS_FINDINGS` + `PERSONALISATION` from a browser on
every open. It resolves one slug, reads one row, renders it. `DEMOS` is a
projection of the five tabs above, written once at build time by
`lib/demos.mjs`'s `buildDemoRow()` (via `POST /api/demo {action:'build'}`).

**It is strictly downstream.** Nothing in the demo path writes back into the
pipeline. A demo can be rebuilt, republished or deleted without touching a
single upstream row.

**The demo shows the probe as at build time.** Rebuilding is an explicit
action; a page view never re-derives anything.

| Group | Fields |
|---|---|
| Identity | `demo_id` (`dmo_*`), `demo_slug`, `demo_status` (`draft`/`published`/`archived`), `demo_version` |
| Links back | `agency_id`, `probe_id`, `personalisation_id`, `hero_journey` |
| Beat 1 — the real event | `agency_name`, `property_address`, `property_price`, `property_url`, `property_image_url`, `enquiry_at`, `enquiry_date`, `enquiry_time` |
| Beat 2 — the observed facts | `seller_declared`, `response_time`, `response_hours`, `contact_attempts`, `follow_ups`, `channels_used`, `viewing_progression`, `seller_recognition` |
| The copy read by the prospect | `demo_hook`, `positive_observation`, `demo_reveal`, `main_finding`, `commercial_consequence`, `systemic_bridge`, `cta_headline` |
| Collections (JSON, short by design) | `observed_events_json`, `novus_detected_json`, `novus_decisions_json`, `novus_actions_json` |
| Plumbing | `created_at`, `updated_at`, `published_at` |
| Telemetry | `first_viewed_at`, `last_viewed_at`, `view_count`, `cta_clicked_at`, `meeting_booked_at` |

### Where each field comes from

Nothing here is invented. Prospect-facing prose is `PERSONALISATION`'s own
copy, raised to a standalone sentence and never rewritten:

| Field | Source |
|---|---|
| `positive_observation` | `PERSONALISATION.fair_observation`, sentence-cased |
| `main_finding` | `PERSONALISATION.main_finding`, sentence-cased |
| `commercial_consequence` | `PERSONALISATION.commercial_consequence`, sentence-cased |
| `property_address` | `PROBES.property_address` through the same `cleanAddressForEmail()` the email uses |
| `enquiry_date` / `enquiry_time` | `PROBES.probe_timestamp`, Europe/London |
| `seller_declared` | `hasVendorDeclaration(probe)` — the deterministic marker, not an AI read |
| `response_time` … `seller_recognition` | the `INTELLIGENCE` row verbatim (`response_time` is `response_hours` formatted) |
| `observed_events_json` | derived from those `INTELLIGENCE` fields — no prose, no findings text |
| `novus_detected_json` | this probe's `DIAGNOSIS_FINDINGS` plus the facts that make them real |
| `novus_decisions_json` | leads with `PERSONALISATION.novus_counterfactual`, then the journey's product decisions |
| `demo_hook` / `demo_reveal` / `novus_actions_json` / `systemic_bridge` / `cta_headline` | authored per journey in `lib/demo-journeys.mjs` — product copy, identical for every agency on a journey |

### `hero_journey` support

`lib/demo-journeys.mjs` carries a **shell of four** — `complete_miss`,
`slow_response_gap`, `fast_response_stalled_follow_up`,
`weak_seller_qualification` — of which only `weak_seller_qualification` is
authored and publishable. The other three build, warn, and stay `draft`.

The three journeys `pickHeroJourney()` can still emit and the demo has no
design for — `automated_ack_only`,
`strong_handling_database_opportunity`, `strong_handling_no_opportunity` —
are **refused by name** (HTTP 422) rather than fudged into the nearest shape.

### The renderer is journey-blind

`demo.html` contains no `hero_journey` branch. It renders whatever the row
carries and hides whatever is blank, which is what stops four journeys
becoming four demo pages. Adding a journey is authoring content in
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
  6. PERSONALISE  if the DIAGNOSIS is finalised → one AI call, reading the whole
                  DIAGNOSIS row + its DIAGNOSIS_FINDINGS rows + the probe facts +
                  the raw communications → upsert the PERSONALISATION row, its
                  sentence-ready email copy and the assembled email (§4b, §4c)
```

The full pipeline is therefore:

```
COMMUNICATIONS → INTELLIGENCE → DIAGNOSIS → DIAGNOSIS_FINDINGS → PERSONALISATION + PROBE → EMAIL → personalised breakdown / demo journey
```

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
