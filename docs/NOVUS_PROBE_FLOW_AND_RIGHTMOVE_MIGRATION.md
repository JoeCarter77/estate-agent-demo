# NOVUS — Probe flow + Rightmove migration

Companion to the code changes on `claude/novus-rightmove-migration-306vjs`.
The live Google Sheet `NOVUS_Data_V1_Master_v2`
(`1qCw6HxTyhgxNk9inlYzXxvN1Hjkh7sFwFFnlaEWirRA`) remains the sole source of
truth. Nothing here creates a parallel database.

---

## 1. The chain, and what was broken

```
AGENCY ──> PROBE ──> COMMUNICATION ──> INTELLIGENCE ──> ACTION
   agency_id   probe_id      probe_id        probe_id      probe_id
                             agency_id       agency_id     agency_id
```

Probe matching is keyed on the **agency**. `lib/matching.mjs matchProbe()` and
`lib/phone-matching.mjs matchActiveProbe()` both select PROBES rows
`WHERE agency_id = <deterministically matched agency> AND the observation window
is open`.

`api/novus/probe-create.js` used to write **`agency_id: ''`** on every probe.
So every probe created through the UI was permanently unmatchable: a reply
resolved to `match_status = 'unmatched'`, no `probe_id` landed on the
COMMUNICATION, no INTELLIGENCE recompute ran, and no ACTION could be filed.
Only the imported `ag_hist_*` / `prb_hist_*` rows worked, because the importer
had set their `agency_id`.

That is the central fix: **agency_id is now required, validated against
AGENCIES, and carried from the agency the probe was launched from.**

`ACTIONS` was a second break — a full 15-column schema plus a CONFIG
`action_status` vocabulary, with no code reading or writing it. The chain
physically ended at INTELLIGENCE. `api/novus/action-create.js` closes it.

---

## 2. Agency URL vs property URL

Two different things that must never be interchanged.

| | Column | Meaning | Example |
|---|---|---|---|
| Agency | `AGENCIES.rightmove_sales_branch_url` | The agency's Rightmove profile — where you *find* its listings | `/estate-agents/agent/Fisks/Rayleigh-90210.html` |
| Property | `PROBES.property_url` | The one specific listing being probed | `/properties/173617499` |

`lib/rightmove-urls.mjs` is the single authority. It classifies a URL as
`agency_profile`, `property`, `property_search`, `agent_search`,
`not_rightmove`, or `unknown`, and **only ever returns a storable value for the
first two**. A rejected kind yields `normalized: ''`, so a generic search URL
cannot reach either column even by mistake.

Rejected by name (these are the shapes the earlier research produced by
accident):

- `/property-for-sale/Rayleigh.html` — area search
- `/property-for-sale/find.html?locationIdentifier=…` — property search
- `/estate-agents/find.html?…` — generic agent search
- `/estate-agents/Essex.html`, `/estate-agents/UK.html` — agent index

---

## 3. Running the migration

Google Sheets access is **keyless by design**: a token only exists inside a real
Vercel invocation (Vercel OIDC → Workload Identity Federation → impersonated
`novus-sheets` service account, see `lib/sheets.mjs`). There is no private key,
so a migration cannot be run from a laptop directly against the sheet. Both
steps below therefore go through authenticated endpoints on the deployed app.

### Step 1 — add the columns (additive, idempotent)

```bash
BASE=https://<your-novus-domain>
AUTH=$(printf '%s:%s' "$NOVUS_BASIC_AUTH_USER" "$NOVUS_BASIC_AUTH_PASS" | base64)

# Dry run — reports what WOULD be added, writes nothing
curl -s -X POST "$BASE/api/novus/admin/ensure-schema" \
  -H "Authorization: Basic $AUTH" -H 'Content-Type: application/json' \
  -d '{"dry_run":true}' | jq

# Apply
curl -s -X POST "$BASE/api/novus/admin/ensure-schema" \
  -H "Authorization: Basic $AUTH" -H 'Content-Type: application/json' \
  -d '{"dry_run":false}' | jq
```

Adds, and nothing else:

| Tab | Columns added |
|---|---|
| `AGENCIES` | `rightmove_sales_branch_url`, `rightmove_status`, `rightmove_checked_at`, `rightmove_notes` |
| `PROBES` | `property_type`, `property_bedrooms`, `property_id` |

`INTELLIGENCE` gets nothing — `contact_attempt_count` **already exists** in the
live tab, so adding it would duplicate a column.

`repo.ensureColumns()` writes **row 1 only**. Existing columns are never
reordered, renamed or removed; every existing record simply gains trailing empty
cells. Old code reading the old columns is unaffected.

### Step 2 — merge the research

Export the Rightmove review to CSV, then:

```bash
export NOVUS_BASE_URL=$BASE
node scripts/novus-rightmove-migrate.mjs --file rightmove.csv           # dry run
node scripts/novus-rightmove-migrate.mjs --file rightmove.csv --apply   # writes
```

The source file needs an `agency_id` column plus at least one of
`rightmove_sales_branch_url` / `rightmove_status` / `rightmove_notes`. Common
header spellings are accepted (`Rightmove URL`, `Rightmove Status`, `Notes`, …)
— see `FIELD_ALIASES` in `lib/rightmove-migrate.mjs`.

**Always read the dry-run report first.** It gives the same counts the real run
will produce, including every rejected URL and every downgraded status.

### Migration rules (enforced, not trusted)

- `agency_id` is the only join key. Row order is never used.
- Only the four `rightmove_*` fields are written — plus **one deliberate reuse**:
  an agency the research flags lettings-only / non-sales also gets
  `sales_led_lettings_only = 'lettings_only'`, but **only when that cell is
  blank**, so live human-entered data is never overwritten. No new
  "is_lettings" column is invented.
- **`confirmed` is not taken at face value.** Confirmed requires a genuine
  agency-profile URL. If the research says confirmed but the URL is generic or
  missing, the status is downgraded (`candidate` / `unresolved`) and the reason
  is written into `rightmove_notes`. This is the specific failure the re-check
  existed to catch.
- Unrecognised status wording falls back to `candidate`, never `confirmed`.
- Idempotent: a second apply writes zero rows.

`rightmove_status` vocabulary: `confirmed`, `candidate`, `unresolved`,
`not_applicable`.

---

## 4. The probe flow

1. Operator opens `/novus/probe?agency_id=<id>` (or searches in the picker).
2. `GET /api/novus/agencies?agency_id=…` resolves the agency so the UI shows a
   **name**, not an opaque id, and offers its Rightmove profile as the place to
   find a listing.
3. Operator pastes an **individual property URL**. An agency profile or a search
   page is refused with a message saying which it was.
4. `POST /api/novus/probe-create { agency_id, url }`:
   - validates the agency exists and is not `suppressed`;
   - validates and normalises the property URL;
   - de-duplicates on `(agency_id, property_url)` so a double-click cannot mint
     two probes;
   - mints `probe_reference` from `max(existing RM-####) + 1`, not a row count;
   - best-effort enrichment (`property_address`, `property_price`,
     `property_status`, `property_type`, `property_bedrooms`) from one short
     fetch. Blank on failure — never blocks creation.
5. The address bar becomes `?probe_id=…`, so the probe is linkable and survives
   a reload via the pre-existing (previously uncalled) `probe-get` endpoint.
6. Operator submits the genuine enquiry manually, then **Mark as Sent** — the
   server timestamps it and opens the 4-day observation window.

Enquiry submission is the real-world confirmation of the property/agency
relationship. There is deliberately **no** listing-agent scraping and **no**
MATCHED/MISMATCH/UNRESOLVED validation layer.

---

## 5. Tests

```bash
npm run novus:selftest              # 15 — repo logic + create/mark-sent contract
npm run novus:comms-selftest        #  7 — email ingestion + matching
npm run novus:observation-selftest  # 15 — grading engine
npm run novus:phone-selftest        # 11 — voice/SMS ingestion
npm run novus:probe-flow-selftest   # 56 — URL rules, migration, full chain
npm run novus:probe-ui-selftest     # 34 — browser: picker + deep links
```

All hermetic: no network, no credentials, no outreach. The UI test skips
cleanly (exit 0) where Playwright or Chromium is unavailable.
