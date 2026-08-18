# COMMUNICATIONS → INTELLIGENCE → DIAGNOSIS — Proposed V2 Schema

**Status: PROPOSAL. Nothing implemented. No code and no sheet changed.**

Scope: `COMMUNICATIONS`, `INTELLIGENCE`, `DIAGNOSIS` only.
Untouched: Personalisation, Demo, Instantly, Outreach, `AGENCIES`, `PROBES`, `RAW_EVENTS`, `ACTIONS`, and the A–H grading engine.

---

## 0. What is actually wrong today

Grounded in the live workbook `NOVUS_Data_V1_Master_v2` and the probe `prb_msxta3fe_56unf9` (`RM-0031`, Barn Field, Chevington — Ensum Brown).

| # | Observed defect | Evidence from the live sheet |
|---|---|---|
| 1 | **Interpretation is smeared across `COMMUNICATIONS`.** 12 of its 47 columns are judgement, not evidence (`booking_attempt`, `intent`, `contact_quality`, `communication_classification`, `ai_summary`…). | `COMMUNICATIONS` header, cols 30–44 |
| 2 | **Vendor recognition is a literal phrase list, so it fails on real wording.** Every single `DIAGNOSIS` row in the live sheet reads `Vendor opportunity: no_evidence` — 100% of them. | `lib/vendor-intent.mjs` `DISCUSSED_PHRASES`; all 20+ `DIAGNOSIS` rows |
| 3 | Ensum Brown **did** ask the seller question — in words the list doesn't contain. | *"What is the situation with your current property? Are you on the market or renting for example?"* → still scored `no_evidence` |
| 4 | Period Homes asked it even more explicitly and was also missed. | *"Please could you also confirm your position - sold/selling/nothing to sell?"* → `no_evidence` |
| 5 | Blueprint's own subject line contained the word *valuation* and was missed. | Subject: `RE: Potential valuation: Rayleigh Road - Buyer from CM12` → `no_evidence` |
| 6 | **`primary_problem` is one of 8 canned strings selected by grade letter**, plus 4 canned candidates. `sales_angle` is one of 8 canned strings. | `lib/diagnosis.mjs` `PRIMARY_PROBLEM_BY_GRADE`, `SALES_ANGLE_BY_GRADE`, `PROBLEM_CANDIDATES` |
| 7 | **The system cannot say "no problem here".** `PROBLEM_CANDIDATES` always yields at least the grade's own finding, so a strong agency is still handed a deficiency. | `computeDiagnosis()` — `ranked[0]` is always non-empty |
| 8 | **Qualification depth is not measured at all.** Ensum Brown asked 8 structured questions. The workbook records this as `contact_quality = "Booking attempt"`. | `INTELLIGENCE` row `itl_msykdvo2_ebbwb1` |
| 9 | **No field records what the enquiry offered**, so "opportunities they failed to recognise" is uncomputable — you cannot subtract from a set you never wrote down. | No such column exists on any tab |
| 10 | **`ai_evidence_summary` is a concatenated string that a regex parses back out.** Two engines share one cell through string surgery. | `readVendorStatus()` regex over `ai_evidence_summary` |
| 11 | `tier` / `sales_angle` / `segment` exist on **both** `INTELLIGENCE` and `DIAGNOSIS`; on `INTELLIGENCE` they are blank on every row. Source Master §28: *"Never allow multiple systems to silently maintain competing versions of the same fact."* | `INTELLIGENCE` cols 30–33 |

---

## 1. Architectural rule

Source Master §19 — *"Never store only the conclusion. Store the evidence that produced it."*

Four field classes, one per tab-region, never mixed:

| Class | Definition | Who writes it | Reproducible? |
|---|---|---|---|
| **RAW EVIDENCE** | What literally arrived. Never recomputed, never overwritten. | Webhooks | n/a — immutable |
| **DETERMINISTIC** | Arithmetic and counting over raw evidence. No AI, ever. | `lib/observation.mjs`, `lib/grading.mjs` | Byte-identical every run |
| **AI INTERPRETATION** | Semantic reading of message content, constrained to quoted evidence. | New `lib/probe-interpretation.mjs` | Stable via evidence fingerprint |
| **COMMERCIAL DIAGNOSIS** | What it means for selling NOVUS. | New `lib/probe-diagnosis.mjs` | Stable via evidence fingerprint |

Tab assignment follows directly:

- **`COMMUNICATIONS`** — RAW EVIDENCE, plus the *four* deterministic per-message facts the probe-level rollups require. No commercial interpretation of any kind.
- **`INTELLIGENCE`** — one row per probe. DETERMINISTIC rollups + AI INTERPRETATION of the enquiry against **every** communication received so far.
- **`DIAGNOSIS`** — one row per probe. COMMERCIAL DIAGNOSIS only. Reads `INTELLIGENCE`, adds no evidence.

**A–H grading is unchanged.** Source Master §29: *"A–H grade | Rules engine | Commercial methodology must be stable."* AI never touches grade, tier, or any count.

---

## 2. `COMMUNICATIONS` V2

### 2.1 Retained raw evidence (unchanged)

`communication_id`, `agency_id`, `probe_id`, `interaction_id`, `occurred_at`, `received_at`, `channel`, `direction`, `communication_type`, `provider`, `provider_event_id`, `source_identifier_raw`, `source_identifier_normalized`, `destination_identifier`, `display_name`, `call_status`, `duration_seconds`, `voicemail_present`, `recording_reference`, `transcript`, `email_message_id`, `email_thread_id`, `subject`, `body_text`, `raw_content`, `raw_payload_reference`, `matching_method`, `match_score`, `match_status`, `manual_review_status`, `manual_override`, `override_reason`, `created_at`, `updated_at`

All RAW EVIDENCE except `matching_*` (deterministic) and `manual_*` (human). Written once by the webhook, never recomputed.

### 2.2 New / changed columns

| Column | Class | What it means | Source data | Updates on new comm? | Barn Field example |
|---|---|---|---|---|---|
| `sequence_index` | Deterministic | 1-based position of this message in the probe's ordered timeline. | Sort of all `COMMUNICATIONS.occurred_at` for this `probe_id` | **Yes** — every row for the probe is renumbered on each recompute | Voicemail = `1`, email = `2` |
| `hours_since_probe` | Deterministic | Hours from `PROBES.probe_timestamp` to this message. Makes every row self-explaining without a lookup. | `occurred_at` − `probe_timestamp` | Yes (own row only) | Voicemail = `17.85`, email = `17.87` |
| `attempt_index` | Deterministic | Which contact attempt this message belongs to, under the §9 30-minute grouping rule anchored to attempt start. **Replaces the lossy `follow_up` boolean.** | 30-min grouping over human touches | **Yes** — regrouped across the whole probe | Both = `1` (81 seconds apart → one attempt) |
| `sender_type` | Deterministic + AI fallback | `human` / `automated` / `unknown`. **Renames `automated_or_human`.** Hard signals first (sender pattern, known template), AI only where hard signals are silent — Source Master §29. | Sender local-part, domain, template signatures, then AI | Yes (own row only) | Both = `human` |
| `sender_type_basis` | Deterministic | *Why* that decision — the rule name or AI verdict plus the matched signal. §19 audit requirement. | The deciding rule | Yes (own row only) | `personal_intro_pattern:"this is Vicky calling"` / `named_mailbox:newmarket@ensumbrown.com` |
| `content_fingerprint` | Deterministic | SHA-256 of `subject + body_text + transcript`. Detects identical template resends and feeds the probe-level evidence fingerprint (§5.3). | Message content | Yes (own row only) | `a4f1…` / `9c02…` |

### 2.3 Columns retired from `COMMUNICATIONS`

Retired = **left physically in the sheet, no longer written, no longer read**. Nothing is deleted; historical values stay visible for audit. A later cleanup pass can drop the columns once V2 is trusted.

| Retired column | Where the concept goes | Why |
|---|---|---|
| `automated_or_human` | → `sender_type` | Rename only |
| `human_contact` | — | Fully redundant with `sender_type`; the duplication is the exact bug `isHumanCommunication()` exists to paper over |
| `follow_up` | → `attempt_index` | Boolean loses which attempt |
| `callback_attempt` | → `INTELLIGENCE.callback_attempts` | Derivable from `channel` + `call_status` |
| `successful_conversation` | → `INTELLIGENCE.successful_conversations` | Derivable from `call_status` + `duration_seconds` |
| `booking_attempt` | → `INTELLIGENCE.viewing_push_level` | Boolean cannot express *invited* vs *slot offered* vs *booked* |
| `communication_classification` | → `INTELLIGENCE.communication_quality` | Probe-level judgement, not message-level |
| `intent` | → `INTELLIGENCE.vendor_recognition_level` | Commercial interpretation — belongs off the ledger |
| `contact_quality` | → `INTELLIGENCE.viewing_push_level` | Commercial interpretation |
| `ai_summary`, `ai_confidence`, `ai_model` | → `INTELLIGENCE.evidence_narrative` + provenance | The AI pass is per-probe in V2, not per-message |

**Net effect: `COMMUNICATIONS` becomes a ledger.** 6 new columns, 10 retired.

---

## 3. `INTELLIGENCE` V2 — one row per probe

Continuously re-interpreted from the enquiry plus **every** communication received so far. Never incremental.

### 3.A Identity & observation window

| Column | Class | Meaning | Source | Updates? | Barn Field |
|---|---|---|---|---|---|
| `intelligence_id` | Raw | Primary key, `itl_*` | `lib/ids.mjs` | No | `itl_msykdvo2_ebbwb1` |
| `agency_id` | Raw | FK | `PROBES.agency_id` | No | `ag_hist_ensum-brown-ex9i` |
| `probe_id` | Raw | FK, **unique** — one row per probe | `PROBES.probe_id` | No | `prb_msxta3fe_56unf9` |
| `observation_status` | Deterministic | `observing` / `closed` | `now >= observation_deadline` | Yes | `observing` |
| `observation_deadline` | Deterministic | `probe_timestamp + 4 days` (§10) | `PROBES` | No | `2026-08-21T22:34:41.149Z` |
| `observation_closed_at` | Deterministic | When the window shut | Deadline once passed | Yes | *(blank — still open)* |
| `communications_count` | Deterministic | How many `COMMUNICATIONS` rows this reading rests on. Distinguishes *"nothing happened"* from *"never computed"*. | `COUNT(COMMUNICATIONS)` for probe | **Yes** | `2` |
| `evidence_fingerprint` | Deterministic | SHA-256 over `probe_id` + `enquiry_text` + every `communication_id`/`occurred_at`/`content_fingerprint`. Drives AI reuse and idempotency (§5.3). | The evidence set | **Yes** | `7be3…` |
| `last_recomputed_at` | Deterministic | Last pipeline run over this probe | `now` | Yes | `2026-08-18T22:22:49.323Z` |

### 3.B The enquiry side — what was on offer *(new — the missing half)*

You cannot compute *"opportunities they failed to recognise"* without first recording what the enquiry contained. Nothing on any tab does this today.

| Column | Class | Meaning | Source | Updates? | Barn Field |
|---|---|---|---|---|---|
| `enquiry_opportunities` | Deterministic | Semicolon list from a closed vocabulary of what this probe put on the table: `viewing_interest`, `vendor_lead_not_on_market`, `vendor_lead_on_market`, `information_request`, `callback_request`, `finance_openness`. | Parsed from `PROBES.enquiry_text` + probe config | No (fixed at probe creation) | `viewing_interest;vendor_lead_not_on_market;information_request` |
| `enquiry_summary` | Deterministic | The enquiry restated in one line, for readability. | `PROBES.enquiry_text`, `property_address`, `property_price` | No | `Rightmove enquiry on Barn Field, Chevington, IP29 (£375,000): wants more property detail, wants a viewing, and declared a property to sell that is not yet on the market.` |
| `vendor_opportunity_declared` | Deterministic | `TRUE` when the probe declared a property to sell. | `PROBES.enquiry_text` marker | No | `TRUE` |

### 3.C Response speed

| Column | Class | Meaning | Source | Updates? | Barn Field |
|---|---|---|---|---|---|
| `auto_acknowledgement` | Deterministic | Automated ack seen | `sender_type` = automated + ack signature | Yes | `FALSE` |
| `auto_ack_timestamp` | Deterministic | When | Earliest such row | Yes | *(blank)* |
| `first_human_touch` | Deterministic | `yes` / `no` (§9) | Any `sender_type = human` row | Yes | `yes` |
| `first_human_touch_at` | Deterministic | Timestamp of it | Earliest human row | Yes | `2026-08-18T16:25:30.507Z` |
| `human_lag_hours` | Deterministic | Probe → first human touch, hours (§9) | Arithmetic | Yes | `17.847` |
| `first_human_channel` | Deterministic | **New.** Which channel the human used first — voice-first and email-first are commercially different. | `channel` of first human row | Yes | `voice` |
| `response_speed_band` | Deterministic | **New.** `very_fast` ≤1h / `fast` >1–16h / `slow` >16h / `none` (§10). Readable without recomputing. | `human_lag_hours` | Yes | `slow` |
| `responded_next_working_morning` | Deterministic | **New.** `TRUE` if first human contact landed before 13:00 local on the next working day. Makes the §10 "9pm probe" rationale explicit and lets diagnosis say *when* they got to it, not just *how long*. | `probe_timestamp`, `first_human_touch_at`, UK calendar | Yes | `FALSE` — probe 22:34, contact 17:25 BST the next **afternoon** |

### 3.D Human contact, persistence and channels

| Column | Class | Meaning | Source | Updates? | Barn Field |
|---|---|---|---|---|---|
| `contact_attempt_count` | Deterministic | Distinct attempts under the 30-min rule (§9) | Grouping | Yes | `1` |
| `follow_up_count` | Deterministic | Attempts after the first (§9) | `contact_attempt_count − 1`, floored at 0 | Yes | `0` |
| `follow_up_channels` | Deterministic | Channels used in follow-ups | Follow-up rows | Yes | *(blank)* |
| `channels_used` | Deterministic | All channels seen | Distinct `channel` | Yes | `voice,email` |
| `channel_count` | Deterministic | **New.** How many distinct channels. | `len(channels_used)` | Yes | `2` |
| `callback_attempts` | Deterministic | Inbound voice attempts | `channel = voice` rows | Yes | `1` |
| `successful_conversations` | Deterministic | Live answered conversations (§11 — a deliberately unanswered call is persistence, not conversation) | `call_status = completed` **and** not voicemail | Yes | `0` |
| `voicemail_count` | Deterministic | Voicemails left | `voicemail_present` | Yes | `1` |
| `inbound_sms_count` | Deterministic | Human SMS touches | `channel = sms` + human | Yes | `0` |
| `email_touch_count` | Deterministic | Human email touches | `channel = email` + human | Yes | `1` |
| `last_touch_at` | Deterministic | Latest evidence of any kind | Max `occurred_at` | Yes | `2026-08-18T16:26:51.000Z` |
| `days_chased` | Deterministic | Probe → last touch, days (§9 — a duration) | Arithmetic | Yes | `0.74` |
| `persistence_profile` | Deterministic | `none`/`low`/`moderate`/`high`/`multi-channel` (§11) | `follow_up_count`, `channel_count` | Yes | `multi-channel` |
| `attempt_timeline` | Deterministic | **New.** The whole persistence story in one readable cell: `attempt#\|time\|channel\|form\|detail`, ` → ` separated. Replaces reading five count columns to picture what happened. | Ordered communications + `attempt_index` | Yes | `1\|2026-08-18T16:25:30Z\|voice\|voicemail\|38s → 1\|2026-08-18T16:26:51Z\|email\|reply\|"Ensum Brown \| Viewing Enquiry"` |

### 3.E Booking / viewing push

| Column | Class | Meaning | Source | Updates? | Barn Field |
|---|---|---|---|---|---|
| `viewing_push_level` | **AI** | Ordinal, **replaces the `booking_attempt` boolean and the `contact_quality` string**: `none` < `mentioned` < `invited` < `availability_requested` < `slot_offered` < `booked`. | AI over all human message content | **Yes** | `availability_requested` |
| `viewing_push_evidence` | AI (quoted) | Verbatim quote + `communication_id` supporting the level. Empty ⇒ level must be `none`. | Cited message | Yes | `"I'd be happy to arrange a viewing for you… Please also let us know your availability for a viewing, and we'll do our best to arrange a suitable time." (com_msyvr15t_dv3bo9, email, 2026-08-18T16:26:51Z)` |
| `booking_attempt` | Deterministic | Kept for continuity with existing grading/tests. `= viewing_push_level != 'none'`. | Derived | Yes | `TRUE` |

### 3.F Valuation / seller opportunity push

Replaces `lib/vendor-intent.mjs`'s phrase lists **and** the `readVendorStatus()` regex over `ai_evidence_summary`.

| Column | Class | Meaning | Source | Updates? | Barn Field |
|---|---|---|---|---|---|
| `vendor_recognition_level` | **AI** | Ordinal: `none` < `implicit_question` < `explicit_acknowledgement` < `valuation_offered` < `valuation_booked`. `implicit_question` is the level the current phrase list cannot see. | AI over all human message content, gated on `vendor_opportunity_declared = TRUE` | **Yes** | `implicit_question` — **today's system says `no_evidence`** |
| `vendor_recognition_evidence` | AI (quoted) | Verbatim quote(s) + `communication_id`. Empty ⇒ level must be `none`. | Cited messages | Yes | `"What is the situation with your current property? Are you on the market or renting for example?" (com_msyvr15t_dv3bo9, email)` and `"Just wanted to have a quick chat. See what your position is at the moment." (com_msyvj8v9_8rd6r7, voice)` |
| `vendor_conversion_gap` | AI | Where the seller thread stopped. `n/a` when no vendor lead was declared. | Highest level reached vs `valuation_booked` | Yes | `Asked the position question but never offered a valuation or market appraisal in either message.` |

### 3.G Qualification depth

| Column | Class | Meaning | Source | Updates? | Barn Field |
|---|---|---|---|---|---|
| `questions_asked` | **AI** | Normalised, from a closed taxonomy: `partner_details`, `current_address`, `current_property_position`, `finance_position`, `budget`, `requirements`, `target_areas`, `timescale`, `motivation`, `chain_position`, `viewing_availability`, `contact_preference`. | AI over all human message content | **Yes** | `partner_details;current_address;current_property_position;finance_position;budget;requirements;target_areas;viewing_availability` |
| `questions_asked_verbatim` | AI (quoted) | The questions exactly as written, `\|`-separated, each with `communication_id`. This is the auditable backing for the line above. | Cited messages | Yes | `"Are you buying with a partner? If so, can I have their name and contact details please?" \| "What is the situation with your current property? Are you on the market or renting for example?" \| "Your financial position e.g. will you be a cash buyer or require a mortgage?" \| "Your minimum and maximum budget" \| …` |
| `questions_asked_count` | Deterministic | `len(questions_asked)` | Derived | Yes | `8` |
| `qualification_depth` | Deterministic | `none` (0) / `minimal` (1–2) / `standard` (3–5) / `thorough` (6+), floored by count then confirmed by AI. | `questions_asked_count` | Yes | `thorough` |
| `qualification_gaps` | AI | Taxonomy items the **enquiry made relevant** but that were never asked. Not every unasked question — only relevant ones. | `enquiry_opportunities` − `questions_asked` | Yes | `timescale;motivation` |

### 3.H Opportunity recognition — the direct answer to *"what did they miss"*

Computed as set operations against `enquiry_opportunities` (§3.B), which is why that column has to exist.

| Column | Class | Meaning | Source | Updates? | Barn Field |
|---|---|---|---|---|---|
| `opportunities_recognised` | **AI** | Enquiry opportunities the agency demonstrably engaged with and acted on. | AI ∩ `enquiry_opportunities` | **Yes** | `viewing_interest` |
| `opportunities_partially_recognised` | AI | Noticed but not carried through — the state today's binary cannot express. | AI | Yes | `vendor_lead_not_on_market` — asked the position question, never offered a valuation |
| `opportunities_missed` | AI | Never engaged with in any message. | `enquiry_opportunities` − the two above | Yes | `information_request` — the enquiry asked for more property detail; the reply supplied none and asked the buyer to register first |
| `opportunity_evidence` | AI (quoted) | Per-opportunity quote or the explicit finding of absence. | Cited messages | Yes | `viewing_interest: "I'd be happy to arrange a viewing for you" (com_msyvr15t_dv3bo9). vendor_lead_not_on_market: "Are you on the market or renting for example?" — no valuation offered in either message. information_request: no property detail supplied in either message.` |

### 3.I Communication quality

| Column | Class | Meaning | Source | Updates? | Barn Field |
|---|---|---|---|---|---|
| `personalisation_level` | AI | `none` / `templated` / `named_property` / `named_property_and_person` | AI over content | Yes | `named_property_and_person` |
| `named_individual` | AI | The person who actually responded, `''` if nobody. Feeds Personalisation later — not built now. | Signature / transcript | Yes | `Vicky` |
| `communication_quality` | AI | `weak` / `adequate` / `strong` — the craft of the response, independent of speed and of grade. | AI over content | Yes | `strong` |
| `communication_quality_reason` | AI (evidence-backed) | Why, citing specifics. | Cited messages | Yes | `Called and emailed within 81 seconds; named the prospect and the exact property; explained why she was emailing after calling; gave a direct dial; asked eight structured qualification questions; offered a no-obligation affordability check; asked for viewing availability.` |

### 3.J Narrative, grade and provenance

| Column | Class | Meaning | Source | Updates? | Barn Field |
|---|---|---|---|---|---|
| `evidence_narrative` | **AI** | A written account of what happened on this probe, every claim tied to a timestamp or a quote. **Replaces the concatenated `ai_evidence_summary`.** No other field is parsed back out of it — ever. | Deterministic rollup + cited messages | **Yes** | *(see §6.2)* |
| `evidence_quotes` | AI (quoted) | Every quote used, with `communication_id`, channel and timestamp, held separately so the narrative is checkable line by line. | Cited messages | Yes | 2 quotes, both validated as literal substrings |
| `grade` | **Deterministic** | A–H (§10). **AI never writes this.** | `lib/grading.mjs`, unchanged | Yes | `F` |
| `grade_reason` | Deterministic | The rule that fired. | `lib/grading.mjs`, unchanged | Yes | `Slow human contact (>16h) with 0 genuine follow-up attempts (Source Master §10).` |
| `ai_model` | Provenance | Model that produced the AI block. | Runtime | Yes | `claude-sonnet-5` |
| `ai_confidence` | AI | `high` / `medium` / `low` — how confident the interpretation is given the content available. | AI | Yes | `high` — 2 messages, both full-text, one a clean email body |
| `ai_interpreted_at` | Provenance | When the AI block was last generated. | Runtime | Yes | `2026-08-18T22:22:49.323Z` |
| `interpretation_warnings` | Deterministic | Quality flags raised during validation — dropped quotes, garbled transcripts, missing content. Never silent. | Validator (§5.4) | Yes | `voice transcript is machine-garbled ("in some brown" = Ensum Brown, "phone field" = Barn Field); interpreted with reduced weight` |
| `manual_override` | Human | Human corrected this row | Human | No | *(blank)* |
| `override_reason` | Human | Why | Human | No | *(blank)* |
| `created_at`, `updated_at` | Deterministic | Row lifecycle | Runtime | Yes | — |

### 3.K CRM detection (kept, and finally populatable)

`crm_detected`, `crm_name`, `crm_evidence` — deterministic. Today the signature registry is empty so every row reads `unknown`. The live data already contains three usable signatures: `noreply@apex27.co.uk` → **Apex27**, `noreply@send.agentresponse…` → **AgentResponse**, and SendGrid tracking footers on Tyler Estates mail. Populating the registry is a small, separate task — flagged, not folded into this proposal.

### 3.L Columns retired from `INTELLIGENCE`

| Retired | Reason |
|---|---|
| `tier`, `tier_reason`, `sales_angle`, `segment` | Commercial. They belong on `DIAGNOSIS` and only there. Blank on every live `INTELLIGENCE` row today while duplicated on `DIAGNOSIS` — the §28 competing-facts problem, literally present in the sheet |
| `contact_quality` | Split into `viewing_push_level` (§3.E) and `communication_quality` (§3.I). One enum was carrying two unrelated concepts |
| `proactive_reactive` | Now fully derivable from `viewing_push_level` + `follow_up_count`; keeping it invites drift |
| `ai_evidence_summary` | → `evidence_narrative` + `evidence_quotes` + typed fields. Nothing is regex-parsed out of prose again |

---

## 4. `DIAGNOSIS` V2 — one row per probe

Reads `INTELLIGENCE`. Adds no evidence, no counts, no grade.

### 4.1 Anti-template rules

These are the schema's load-bearing constraints, not commentary:

1. **`diagnosis_status` may be `no_problem_found`.** A strong probe produces a diagnosis that says so and points at a different, wider opportunity. Today this outcome is unreachable.
2. **The grade letter never selects a problem string.** Grade routes `tier` and nothing else.
3. **Every problem carries its own `*_evidence`.** A problem with no verbatim quote or no numeric fact is not written at all.
4. **Problems are ranked by commercial value, not by grade** — and there can be several at once.
5. **`commercial_implication` must name at least one probe-specific fact** (this property, this time, this quote, this agency's own words). A sentence that would read identically for another agency fails validation.
6. **`recommended_intervention` may differ from the `tier` default** when the evidence says so, and must justify itself in `intervention_reason`. Source Master §20: *"Do not force a Tier/product assignment where the available evidence does not establish a relevant opportunity."*

### 4.2 Schema

| Column | Class | Meaning | Source | Updates? |
|---|---|---|---|---|
| `diagnosis_id` | Raw | Primary key `dgn_*` | `lib/ids.mjs` | No |
| `agency_id`, `probe_id` | Raw | FKs, `probe_id` unique | `INTELLIGENCE` | No |
| `diagnosis_status` | Commercial | **New, and the key field.** `diagnosed` / `no_problem_found` / `insufficient_evidence` / `pending_window_open`. This is what lets the system decline to invent a problem. | Evidence + window state | Yes |
| `grade` | Deterministic | Copied verbatim, never re-derived | `INTELLIGENCE.grade` | Yes |
| `tier` | Deterministic | `Growth` (A/B) / `Core` (C–H) — the Tier Sheet routing default | Routing table | Yes |
| `tier_reason` | Deterministic | Why that routing | Routing table | Yes |
| `primary_problem` | **Commercial (AI)** | The single most commercially damaging finding, **written for this probe**. Blank when `diagnosis_status = no_problem_found`. | AI over the whole `INTELLIGENCE` row | Yes |
| `primary_problem_evidence` | Commercial (quoted) | The quote or numeric fact it rests on. Mandatory whenever `primary_problem` is non-empty. | `INTELLIGENCE` fields + quotes | Yes |
| `primary_problem_severity` | Commercial | `high` / `medium` / `low` | AI | Yes |
| `secondary_problem` | Commercial (AI) | The next most damaging, if the evidence supports one. | AI | Yes |
| `secondary_problem_evidence` | Commercial (quoted) | Same rule as primary | `INTELLIGENCE` | Yes |
| `other_problems` | Commercial (AI) | Everything further the evidence supports, ranked, `\|`-separated. Nothing found is discarded. | AI | Yes |
| `strengths` | **Commercial (AI)** | **New.** What they did well, evidence-backed. May legitimately be the longest field on the row. | AI | Yes |
| `strengths_evidence` | Commercial (quoted) | Quotes and facts behind it | `INTELLIGENCE` | Yes |
| `missed_opportunities` | **Commercial (AI)** | **New.** Named commercial value that was on the table and was not taken. | `opportunities_missed` + `opportunities_partially_recognised` + `vendor_conversion_gap` | Yes |
| `commercial_implication` | Commercial (AI) | What this costs the agency, in their own situation. Must contain a probe-specific fact (rule 5). | AI | Yes |
| `identified_opportunity` | **Commercial (AI)** | **New.** The wider commercial opening — the field that lets a strong agency get a real answer instead of a manufactured weakness. | AI | Yes |
| `recommended_intervention` | Commercial | `NOVUS Core (Front Desk)` / `NOVUS Growth` / `No intervention indicated` / `Insufficient evidence`. Renamed from `recommended_solution`. | AI, constrained by `tier` | Yes |
| `intervention_reason` | Commercial (AI) | Why this product for **this** evidence, including any departure from the `tier` default | AI | Yes |
| `confidence` | Commercial | `high` / `medium` / `low` — confidence in the reasoning | AI | Yes |
| `evidence_strength` | **Deterministic** | **New, and separate from `confidence`.** `strong` / `moderate` / `weak` / `none` — how much the diagnosis rests on. Function of `communications_count`, `observation_status`, content availability and `interpretation_warnings`. Deterministic so it can never be talked up. | `INTELLIGENCE` | Yes |
| `diagnosis_narrative` | Commercial (AI) | The written commercial read, for the demo page and the sales conversation | AI | Yes |
| `ai_model`, `ai_confidence`, `diagnosed_at` | Provenance | Which model, when | Runtime | Yes |
| `manual_override`, `override_reason` | Human | Human correction, retained alongside the original (§19) | Human | No |
| `created_at`, `updated_at` | Deterministic | Row lifecycle | Runtime | Yes |

**Retired:** `evidence_summary` (the concatenated blob) → replaced by the typed `*_evidence` fields plus `diagnosis_narrative`. `recommended_solution` → renamed `recommended_intervention`. `sales_angle` → absorbed into `intervention_reason` + `identified_opportunity`; the 8 canned strings go.

---

## 5. Architecture and data flow

### 5.1 New communication arrives

```
inbound webhook (email / sms / voice / voice-recording)
  └─> RAW_EVENTS                       immutable, idempotent on provider+provider_event_id
  └─> deterministic agency match → deterministic probe match      (UNCHANGED)
  └─> COMMUNICATIONS row               raw evidence only
  └─> recomputeProbe(probe_id)  ───────────────────────────────┐
                                                               │
  1. LOAD      PROBES row + ALL COMMUNICATIONS for this probe   │  ← complete evidence,
  2. FACTS     per-message deterministic pass:                  │    never incremental
               sequence_index, hours_since_probe,               │
               attempt_index, sender_type, content_fingerprint  │
  3. ROLLUP    deterministic observation metrics (§3.C/D)       │
  4. GRADE     lib/grading.mjs — rules engine, UNCHANGED        │
  5. FINGERPRINT  evidence_fingerprint over the evidence set    │
  6. INTERPRET if fingerprint changed → ONE AI call →           │
               §3.E–J AI block; else reuse stored values        │
  7. VALIDATE  every quote must be a literal substring of the   │
               message it cites; failures drop the claim        │
  8. WRITE     upsert exactly one INTELLIGENCE row              │
  9. DIAGNOSE  if observation_status = closed →                 │
               AI commercial pass → upsert one DIAGNOSIS row    │
               else DIAGNOSIS.diagnosis_status =                │
                    pending_window_open                         ─┘
```

**The load in step 1 always reads the complete stored evidence.** That single rule is what makes the live path and the rebuild path the same code.

### 5.2 Rebuild Intelligence (all probes)

Identical pipeline, batch-loaded once per tab (the existing `lib/intelligence-rebuild.mjs` shape, preserved to stay inside the Sheets read quota), run for **every** `PROBES` row:

- probes with zero communications → valid intelligence (`communications_count = 0`, grade `pending` or `H`)
- probes whose `INTELLIGENCE` row is blank → `evidence_fingerprint` is empty → treated as changed → fully computed
- probes already complete and unchanged → fingerprint matches → **AI is skipped**, deterministic fields rewritten identically

Because every field derives from stored evidence and nothing from the arriving message alone, **historical rows that were previously blank fill in on the first rebuild** — the requirement that motivated this whole change.

### 5.3 Idempotency and AI cost

The `evidence_fingerprint` is the mechanism:

| Situation | Fingerprint | AI call? | Result |
|---|---|---|---|
| New communication on a probe | Changed | Yes | Full re-interpretation |
| Rebuild, evidence unchanged | Matches | **No** | Deterministic fields rewritten byte-identically; AI block reused verbatim |
| Historical row, never interpreted | Empty | Yes | Fills in |
| Manual `force_ai=true` | ignored | Yes | For prompt changes |

So `npm run novus:pipeline-regression`'s existing invariant — *"a second rebuild changes nothing"* — still holds, which a naive AI pass would break. Steady-state rebuild cost stays near zero.

### 5.4 Keeping AI honest

The interpretation call receives **only**: `enquiry_text`, property, `probe_timestamp`, the ordered communications with verbatim content and timestamps, and the deterministic rollup. It returns typed JSON via a tool schema.

Four hard constraints:

1. **AI never returns a grade, a tier, or any count.** Those are computed and passed *in*.
2. **Every non-empty interpretive field must cite `communication_id` + a verbatim `quote`.**
3. **Post-validation checks each quote is a literal substring of the message it cites.** A quote that fails is dropped, the claim it supported is dropped with it, `ai_confidence` is lowered, and the reason is written to `interpretation_warnings`.
4. **Absence is a finding, not a blank.** "No valuation was offered in either message" is a recorded, citable conclusion — distinct from "not yet computed", which `communications_count` and `evidence_fingerprint` disambiguate.

Rule 3 is the guard against the mirror-image of today's bug: the current phrase list is blind to real wording; an unconstrained AI would confabulate wording that was never there. Substring validation cuts both.

### 5.5 Migration posture

- Columns are **retired, not deleted** — appended new columns, old ones left in place and unwritten. No historical value is destroyed.
- The A–H grading engine, deterministic matching, the 30-minute grouping rule and the webhook ingest path are **untouched**.
- `lib/vendor-intent.mjs`'s phrase lists and `lib/diagnosis.mjs`'s canned tables are deleted only once the AI path is verified against the live data on a copy of the workbook.

---

## 6. Worked example — Barn Field (`prb_msxta3fe_56unf9`, Ensum Brown)

### 6.1 The raw evidence

**Probe** — `RM-0031`, sent `2026-08-17T22:34:41.149Z` (11:34pm BST) on *Barn Field, Chevington, IP29*, £375,000. Enquiry: *"Rightmove property enquiry. Declared: has a property to sell, yes, it is not yet on the market; wants more details on this property."*

**Communication 1** — voice, `2026-08-18T16:25:30.507Z`, from `+441638280030`, 38s voicemail, transcript (machine-garbled):

> "Hello, this is Vicky calling from [Ensum Brown]. I'm just reaching out on your inquiry for property in [Chevington] … it's on [Barn Field]. A 3 bedroom [£]375. Just wanted to have a quick chat. **See what your position is at the moment.** Take some details and we can **get you booked in for a [viewing]** and **I'll follow up with an email for you.** … feel free to give me a call back on [01638 280030]."

**Communication 2** — email, `2026-08-18T16:26:51.000Z` (**81 seconds later**), from `newmarket@ensumbrown.com`, subject *"Ensum Brown | Viewing Enquiry"*:

> "Hello Joe, Thank you for your enquiry on **Barn Field, Chevington, IP29**. I'd be happy to arrange a viewing for you. **I tried to give you a call, but I appreciate you may be busy, so I thought I'd follow up by email.** … please give us a call on 01638 28 00 30, or simply reply to this email with the information below so we can complete your registration and arrange your viewing.
> — Are you buying with a partner? If so, can I have their name and contact details please?
> — Your address …
> — **What is the situation with your current property? Are you on the market or renting for example?**
> — Your financial position e.g. will you be a cash buyer or require a mortgage? If you'd like, I can also arrange a complimentary, no-obligation affordability check with Expert Mortgages …
> — Your minimum and maximum budget
> — Your property specifications e.g. number of bedrooms, garden space, parking, garage, type of house …
> — Which areas are you looking to move to?
> — Any additional comments
> **Please also let us know your availability for a viewing**, and we'll do our best to arrange a suitable time.
> Kind regards, Vicky"

### 6.2 What V2 `INTELLIGENCE` extracts

| Field | Value |
|---|---|
| `communications_count` | `2` |
| `enquiry_opportunities` | `viewing_interest;vendor_lead_not_on_market;information_request` |
| `vendor_opportunity_declared` | `TRUE` |
| `response_speed_band` | `slow` |
| `human_lag_hours` | `17.847` |
| `first_human_channel` | `voice` |
| `responded_next_working_morning` | `FALSE` |
| `contact_attempt_count` / `follow_up_count` | `1` / `0` |
| `channels_used` / `channel_count` | `voice,email` / `2` |
| `persistence_profile` | `multi-channel` |
| `attempt_timeline` | `1\|16:25:30\|voice\|voicemail\|38s → 1\|16:26:51\|email\|reply\|"Ensum Brown \| Viewing Enquiry"` |
| `viewing_push_level` | `availability_requested` |
| `viewing_push_evidence` | *"I'd be happy to arrange a viewing for you… Please also let us know your availability for a viewing, and we'll do our best to arrange a suitable time."* (`com_msyvr15t_dv3bo9`) |
| **`vendor_recognition_level`** | **`implicit_question`** |
| **`vendor_recognition_evidence`** | *"What is the situation with your current property? Are you on the market or renting for example?"* (email) + *"See what your position is at the moment."* (voicemail) |
| `vendor_conversion_gap` | Asked the position question; never offered a valuation or market appraisal in either message |
| `questions_asked` | `partner_details;current_address;current_property_position;finance_position;budget;requirements;target_areas;viewing_availability` |
| `questions_asked_count` | `8` |
| `qualification_depth` | `thorough` |
| `qualification_gaps` | `timescale;motivation` |
| `opportunities_recognised` | `viewing_interest` |
| `opportunities_partially_recognised` | `vendor_lead_not_on_market` |
| `opportunities_missed` | `information_request` — the enquiry asked for more detail on the property; neither message supplied any, and the email asked the buyer to complete a registration first |
| `personalisation_level` | `named_property_and_person` |
| `named_individual` | `Vicky` |
| `communication_quality` | `strong` |
| `communication_quality_reason` | Called and emailed within 81 seconds; named the prospect and the exact property; explained why she was emailing after calling; gave a direct dial; asked eight structured qualification questions; offered a no-obligation affordability check; asked for viewing availability |
| `grade` / `grade_reason` | `F` / *Slow human contact (>16h) with 0 genuine follow-up attempts (§10)* — **unchanged** |
| `ai_confidence` | `high` |
| `interpretation_warnings` | Voice transcript is machine-garbled (*"in some brown"* = Ensum Brown, *"phone field"* = Barn Field); interpreted with reduced weight, email carries the load |
| `evidence_narrative` | *"The enquiry went in at 11:34pm on 17 August. Nothing happened until 5:25pm the following afternoon — 17.8 hours — when Vicky called and left a 38-second voicemail, then emailed 81 seconds later. Both messages named the property; the email named Joe and was signed. She explained the email was a follow-up to the call she'd just made, gave a direct dial, asked eight structured qualification questions covering partner, address, current property position, finance, budget, requirements and target areas, offered an affordability check, and asked for viewing availability. On the declared seller: she asked 'What is the situation with your current property? Are you on the market or renting for example?' and, on the voicemail, wanted to 'see what your position is at the moment' — but no valuation or market appraisal was offered in either message. The enquiry's request for more detail on the property went unanswered; the reply asked for registration first. No further contact by the time of this reading."* |

**The three things V2 extracts that V1 cannot:**

1. **`vendor_recognition_level = implicit_question`.** Today: `Vendor opportunity: no_evidence` — because `DISCUSSED_PHRASES` requires the literal strings *"free valuation"*, *"market appraisal"*, *"value your property"*. Vicky asked the seller question in the language a real agent uses. The current system reports she ignored the instruction lead. She did not.
2. **`questions_asked_count = 8`, `qualification_depth = thorough`.** Today this is recorded as `contact_quality = "Booking attempt"`. Eight structured questions is the single strongest positive signal in the entire live dataset and the schema has nowhere to put it.
3. **`opportunities_missed = information_request`.** A real, specific, evidenced failure that no existing field can represent.

### 6.3 Why `DIAGNOSIS` for Barn Field is `pending_window_open`

`observation_deadline` = `2026-08-21T22:34:41Z`. Still open. So:

- `diagnosis_status` = `pending_window_open`
- every commercial field stays empty
- `evidence_strength` = `moderate`

This is itself the anti-forcing principle working: **an incomplete observation produces no diagnosis rather than a premature one.**

### 6.4 What the diagnosis becomes if the window closes with nothing further

| Field | Value |
|---|---|
| `diagnosis_status` | `diagnosed` |
| `grade` / `tier` | `F` / `Core` (routing default) |
| `primary_problem` | Nothing reached the enquiry for 17.8 hours. It went in at 11:34pm and the first contact came at 5:25pm the following **afternoon** — well past the first half of the next working day, which is what the 16-hour threshold is there to test. |
| `primary_problem_evidence` | `probe_timestamp 2026-08-17T22:34:41Z` → `first_human_touch_at 2026-08-18T16:25:30Z` = 17.85h; `responded_next_working_morning = FALSE` |
| `primary_problem_severity` | `high` |
| `secondary_problem` | The declared seller was asked about their position and then never offered a valuation. The instruction lead was recognised and dropped. |
| `secondary_problem_evidence` | *"What is the situation with your current property? Are you on the market or renting for example?"* — no valuation, appraisal or valuer mentioned in either message |
| `other_problems` | The enquiry asked for more detail on the property; neither message supplied any — the reply asked the buyer to complete a registration first |
| **`strengths`** | Once engaged, this was among the strongest handling observed across the whole probe set. Voicemail and email inside 81 seconds — two channels, one attempt. Named the prospect and the exact property. Explained why she was emailing after calling. Direct dial supplied. Eight structured qualification questions — partner, address, current property position, finance, budget, requirements, target areas. Offered a no-obligation affordability check. Asked for viewing availability. Signed by a named person, Vicky. |
| `strengths_evidence` | 8 verbatim questions in `questions_asked_verbatim`; `attempt_timeline` shows 81-second voice→email; `personalisation_level = named_property_and_person` |
| `missed_opportunities` | An off-market instruction on a £375,000 enquiry, recognised in words and never converted to a valuation appointment. Plus the property detail that was asked for and never sent. |
| `commercial_implication` | Ensum Brown's handling is not the problem — their clock is. A £375,000 Chevington enquiry carrying an off-market instruction sat untouched for 17.8 hours, from 11:34pm until nearly 5:30pm the next day. Vicky then handled it better than most agencies in the set. Every hour of that gap is time a seller had to reach the next agent; half of sellers see three agents before choosing. NOVUS does not need to write her a better reply. It needs to send *her* reply at 11:35pm. |
| `identified_opportunity` | Out-of-hours coverage on an otherwise strong front desk, plus automatic valuation conversion the moment a buyer answers the "are you on the market?" question she is already asking. |
| `recommended_intervention` | `NOVUS Core (Front Desk)` |
| `intervention_reason` | Core, but **not** because the front desk is weak — because it is unmanned outside hours. The 60-second answer is the whole value here; the qualification and the booking push are already in place and would be preserved, not replaced. If the valuation conversion is the priority instead, Growth is the stronger fit, since the gap is a seller thread that was opened and dropped rather than an unanswered enquiry. |
| `confidence` | `high` |
| `evidence_strength` | `moderate` — 2 communications, single probe, one machine-garbled transcript |

Compare with what the system produces today for this probe: *"Slow first response (over 16 hours) and no follow-up persistence"* + *"The vendor opportunity was never picked up… no human communication ever mentioned selling"* + *"Slow first reply and no chase after it — the exact gap Core is built to close."* All three are canned, and the middle one is **factually wrong**.

### 6.5 The contrast case — Chalmers Agency (`prb_hist_0010`, grade `F`)

Same grade letter. Completely different diagnosis, generated from evidence rather than from `F`.

Evidence: `human_lag_hours = 63.57` (2.6 days). One human email — *"Hi Joe. Thank you for your Rightmove enquiry regarding Flat 7, 151A High Street, Brentwood. A member of our team will be in touch soon. In the mean time, if you want to see more details about the property, register."* `follow_up_count = 0`. No viewing proposed. No questions asked. Vendor lead declared and never mentioned.

| Field | Value |
|---|---|
| `diagnosis_status` | `diagnosed` |
| `primary_problem` | 63.6 hours — two and a half days — to any human contact, and what arrived was a holding line, not a response. |
| `secondary_problem` | The declared seller was never mentioned in any message. An off-market instruction lead was handed over and went entirely unrecognised. |
| `other_problems` | No viewing or valuation was ever proposed \| Zero qualification questions asked \| Single channel \| Zero follow-up after the one message \| The reply promised *"a member of our team will be in touch"* and nobody was |
| `strengths` | Limited. The message came from a named mailbox and named the correct property. No other positive signal is evidenced. |
| `commercial_implication` | Three days of silence on a Brentwood enquiry that also carried an instruction, answered by a message that asked for nothing and offered nothing. By the time it arrived the prospect had had 63 hours to book with someone else, and the seller half of the enquiry was never seen at all. |
| `identified_opportunity` | The whole front desk. This is the clearest Core case in the set short of total silence. |
| `recommended_intervention` | `NOVUS Core (Front Desk)` |
| `confidence` / `evidence_strength` | `high` / `strong` — window closed, evidence complete |

**Four failures, ranked, each evidenced, none invented — from the same grade letter that produced the strong Barn Field diagnosis.** That is the test this schema is built to pass.

---

## 7. Summary of changes

| Tab | Added | Retired | Unchanged |
|---|---|---|---|
| `COMMUNICATIONS` | 6 (`sequence_index`, `hours_since_probe`, `attempt_index`, `sender_type`, `sender_type_basis`, `content_fingerprint`) | 10 interpretation columns | 34 raw-evidence / matching / override columns |
| `INTELLIGENCE` | 28 (enquiry side, speed detail, viewing push, vendor recognition, qualification, opportunity recognition, quality, narrative, provenance) | 6 (`tier`, `tier_reason`, `sales_angle`, `segment`, `contact_quality`, `proactive_reactive`, `ai_evidence_summary`) | grade engine, all deterministic rollups |
| `DIAGNOSIS` | 17 (`diagnosis_status`, per-problem evidence, `strengths`, `missed_opportunities`, `identified_opportunity`, `evidence_strength`, provenance) | 3 (`evidence_summary` blob, `recommended_solution`, `sales_angle`) | `grade`, `tier` routing |

**Not touched:** Personalisation, Demo, Instantly, Outreach, `AGENCIES`, `PROBES`, `RAW_EVENTS`, `ACTIONS`, deterministic agency/probe matching, the 30-minute grouping rule, the 4-day observation window, and the A–H grading engine.

---

## 8. Open questions for approval

1. **`INTELLIGENCE` reaches ~60 columns.** Acceptable in a working sheet, or should the AI block move to a fourth tab keyed by `probe_id`?
2. **Model choice** — `claude-sonnet-5` for interpretation and diagnosis. `claude-haiku-4-5` is what `api/chat.js` uses today and would be roughly a tenth the cost; the judgement quality needed here argues for Sonnet.
3. **Retire vs delete.** Proposal keeps retired columns physically present. Say the word if you'd rather cut them at migration.
4. **`responded_next_working_morning`** needs a UK bank-holiday calendar to be exactly right. Weekend-only handling first, holidays deferred?
5. **CRM signature registry** — three signatures are sitting in the live data (Apex27, AgentResponse, SendGrid). Fold into this change, or keep separate?
6. **Diagnosis re-run on window close.** Probes currently `observing` will need a diagnosis pass when their window shuts. Rebuild-all covers it, but it means rebuild-all should be scheduled, not just manual.
