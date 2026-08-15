# NOVUS — Probe Runbook (V1)

Everything needed to run real probes, and everything that is still manual.

---

## 0. One-time setup — do these in order

Nothing below is optional. Each step blocks the next.

### 0.1 Add the missing workbook columns

The Sheets layer maps records onto the header row, so **a field whose column
does not exist is dropped with no error**. The code now writes fields that the
live workbook has no columns for. Add them before probing, or that evidence is
lost silently.

**PROBES** — add these columns (order does not matter, spelling does):

```
property_id            property_postcode      property_type
property_bedrooms      listing_agent_name     listing_image_url
extraction_status      extraction_error
```

**INTELLIGENCE** — the tab already has `tier`, `tier_reason`, `sales_angle`,
`segment`, `inbound_sms_count`, `email_touch_count`, `proactive_reactive`,
`contact_attempt_count` and `next_action`. Nothing to add — these were simply
never populated before and now are.

Verify with:

```
GET /api/novus/schema-check
```

It reports, per tab, which required columns are missing and which fields are
being dropped on write. `"ok": true` and an empty `dropped_on_write` means the
workbook matches the code.

### 0.2 Import the agencies

The AGENCIES tab currently holds **one synthetic test row**. Until the real
agencies are in it, no inbound communication can match anything.

```bash
npm run novus:agencies-dryrun      # inspect first — no credentials needed
```

That reports 144 agencies, signal coverage, and any domain/phone shared by two
agencies. Then run the live import from inside a Vercel invocation (it needs a
real OIDC token, same as `novus-sheets-smoke.mjs`):

```bash
node scripts/import-agencies.mjs
```

Re-running is safe: `agency_id` is derived from the CSV slug, so an existing
agency is updated in place rather than duplicated.

**Suppress the test fixture** afterwards — set `suppression_status = suppressed`
on `ag_msstv7xg_bodbye` so it can never be picked as a probe target.

### 0.3 Set the environment variables

| Variable | Why |
|---|---|
| `NOVUS_PROBE_EMAIL` | Base reply address. Must accept plus-addressing. |
| `CRON_SECRET` | Without it the four-day close never runs and Grade H is never assigned. |
| `NOVUS_INGEST_SECRET` | Authenticates the email adapter. |
| `TWILIO_AUTH_TOKEN` | Already set — signs the voice/SMS webhooks. |

### 0.4 Connect the email inbox — **this is the remaining blocker**

Voice and SMS capture are live and proven. **Email ingestion is not connected.**
The endpoint `/api/novus/webhooks/email-inbound` is built, tested and correct,
but nothing is currently feeding it, so every agency email reply is invisible to
NOVUS.

Point an adapter (Make, Zapier, Apps Script — anything that can POST) at the
probe inbox and have it POST each new message to:

```
POST https://<your-domain>/api/novus/webhooks/email-inbound
Header: X-Novus-Ingest-Secret: <NOVUS_INGEST_SECRET>

{
  "provider": "gmail",
  "provider_event_id": "<Gmail message id>",   // drives idempotency — must be stable
  "channel": "email",
  "occurred_at": "<message Date header, ISO>",
  "from": "<sender address>",
  "to": "<the To header — carries the probe tag>",
  "delivered_to": "<Delivered-To header, if available>",
  "cc": "<Cc header, if available>",
  "subject": "...",
  "body_text": "...",
  "email_message_id": "<RFC822 Message-ID>",
  "email_thread_id": "<thread id>"
}
```

`to` / `delivered_to` / `cc` matter: they carry the per-probe address that makes
matching deterministic. Send them even when they look redundant.

---

## 1. Running one probe

1. Open `/novus/probe` (Basic Auth).
2. **Search and select the agency.** The picker warns if an agency has no
   domain or phone on record — that agency's replies can only be matched by the
   probe email address, so the address must be entered exactly.
3. **Paste the Rightmove listing URL** for one of that agency's live listings.
4. **Create Probe.** NOVUS writes a draft row and shows:
   agency · property · price · property ID · probe reference ·
   **probe email (unique to this probe)** · probe phone.
   Any warnings — extraction blocked, agency has no match signal, agency
   already has a live probe — appear here, before you commit.
5. **Open Rightmove** and submit the genuine enquiry.
   Use the **Copy** buttons for the email and phone. Do not retype them; a
   changed address breaks matching for that probe.
6. **Mark as Sent.** The server records the timestamp and opens a four-day
   observation window. This is the last manual step.
7. Walk away. Everything after this is automatic.

## 2. What happens automatically after that

| Event | What NOVUS does |
|---|---|
| Agency emails | RAW_EVENT → match by probe address → COMMUNICATION → classify → recompute intelligence → update grade/tier/action |
| Agency calls | Voicemail recorded + transcribed → COMMUNICATION → recompute |
| Agency texts | COMMUNICATION → recompute |
| Nothing arrives | Hourly cron closes the window at 4 days → Grade H → INTELLIGENCE row → next action |

No manual recompute is required in any of these paths.

## 3. Where to look

| Question | Where |
|---|---|
| What did the agency actually do? | COMMUNICATIONS filtered by `probe_id` |
| What's the verdict? | INTELLIGENCE — `grade`, `grade_reason`, `tier`, `sales_angle` |
| What do I do next? | ACTIONS — one open row per probe |
| Something looks wrong | RAW_EVENTS — the untouched provider payload |
| Did an event fail to match? | COMMUNICATIONS where `manual_review_status = pending` |

**Check the review queue.** A communication with `match_status` of `unmatched`
or `ambiguous` is retained in full but attached to nothing. That is deliberate —
NOVUS never guesses an Agency ID or Probe ID — but it means those rows need a
human to resolve them, and they will not chase you.

## 4. Grading reference

| Grade | Meaning |
|---|---|
| A | Human contact ≤1h, with 1+ genuine follow-up |
| B | Human contact >1h and ≤16h, with 1+ genuine follow-up |
| C | Human contact ≤1h, no follow-up |
| D | Human contact >1h and ≤16h, no follow-up |
| E | Human contact >16h, with 1+ genuine follow-up |
| F | Human contact >16h, no follow-up |
| G | Automated acknowledgement only, no human contact |
| H | No meaningful response when the four-day window closes |

A **follow-up** is a distinct subsequent contact attempt. Communications within
30 minutes of the **start** of an attempt belong to that same attempt; the
window does not reset per message.

## 5. Tests

```bash
npm run novus:all          # all five hermetic suites, no network or credentials
```

89 checks. Run them before and after any change to the pipeline.
