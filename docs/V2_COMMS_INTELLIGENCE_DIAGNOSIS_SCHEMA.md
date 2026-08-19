# COMMUNICATIONS → INTELLIGENCE → DIAGNOSIS — Proposed V2 (demo-ready)

**Status: PROPOSAL. Nothing implemented. No code and no sheet changed.**

Scope: `COMMUNICATIONS`, `INTELLIGENCE`, `DIAGNOSIS`.
Not in scope: Personalisation, Demo, SEND DEMO, Instantly, Outreach, `AGENCIES`, `PROBES`, `RAW_EVENTS`, `ACTIONS`.

Totals: **`COMMUNICATIONS` +0 columns**, **`INTELLIGENCE` 20 fields**, **`DIAGNOSIS` 9 fields**. Two AI calls per probe. No fingerprint layer, no fourth tab.

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

## 4. `DIAGNOSIS` — 9 fields, one row per probe

Written only when `observation_status = closed`. Reads the `INTELLIGENCE` row and nothing else — no new evidence, no counts, no grade.

| # | Field | Derivation |
|---|---|---|
| 1 | `primary_problem` | The single most commercially damaging thing the evidence shows. **Blank is a legal, meaningful value** — see §5. Written for this probe, never selected from a list. |
| 2 | `primary_evidence` | The quote or the number it rests on. Mandatory whenever field 1 is non-empty. |
| 3 | `secondary_problem` | The next most damaging, **only if the evidence supports a second one**. Often blank. |
| 4 | `secondary_evidence` | Same rule as field 2. |
| 5 | `strengths` | What they did well, from `INTELLIGENCE.did_well` + the numbers. May legitimately be the longest field on the row. |
| 6 | `missed_opportunities` | Named commercial value that was on the table and not taken — the BUYING and SELLING opportunities from §1, specifically. |
| 7 | `commercial_implication` | What this costs *this* agency. Must contain at least one probe-specific fact — the property, a time, their own words. A sentence that would read identically for another agency is rejected. |
| 8 | `novus_opportunity` | Where NOVUS actually fits, given the evidence. `Core (front desk)`, `Growth (valuation list / seller conversion)`, or **`None evidenced`** when the probe genuinely doesn't establish one. |
| 9 | `diagnosis_summary` | The two-or-three-sentence commercial read, generated from fields 1–8. This is the sentence Joe says on the call. |

Plus `diagnosis_id`, `agency_id`, `probe_id`, `created_at`, `updated_at`.

**Retired:** `grade` and `tier` (grade lives on `INTELLIGENCE`; tier is `novus_opportunity`'s job now), `evidence_summary` (the concatenated blob), `recommended_solution`, `sales_angle` (the 8 canned strings).

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
