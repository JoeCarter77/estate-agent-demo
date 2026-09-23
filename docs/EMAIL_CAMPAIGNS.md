# NOVUS Email / Campaigns — Instantly as the execution layer

`/novus/campaigns.html` is the control layer for cold-email campaigns. NOVUS
owns who is contacted, why they are eligible, which campaign they are in, the
full campaign/email history and the next action. Instantly owns sending
infrastructure, mailbox rotation, throttling, schedules and deliverability.

## Where the code is

| Layer | File |
|---|---|
| Instantly API v2 client (campaigns, leads, analytics, accounts, emails; typed errors, 429 backoff, timeouts) | `lib/instantly-client.mjs` |
| Workbook tabs, parsing, setup, patch helpers, status mappings | `lib/campaign-store.mjs` |
| Eligibility / suppression engine (pure rule table) | `lib/campaign-eligibility.mjs` |
| Audience builder over NOVUS tables (pure) | `lib/campaign-audience.mjs` |
| Unified per-agency timeline (pure) | `lib/lead-timeline.mjs` |
| HTTP operations + webhook + reconciliation | `lib/campaign-handlers.mjs` |
| Router (`?novus_operation=` branches, 12-function ceiling) | `api/novus/personalisation.js` |
| Nightly reconciliation (step F) | `api/novus/intelligence/finalize.js` |
| Page | `novus/campaigns.html` (+ `Email` sidebar group on operator/calling) |
| Lead profile History tab | `novus/operator.html` → `?novus_operation=lead-timeline` |
| Hermetic test | `npm run novus:campaigns-selftest` |

## Data model (three new tabs, created by one click)

Created by **Campaigns → "Create the tabs"** (`campaign-setup`,
`confirm=SETUP_CAMPAIGN_TABS`). Existing tabs are untouched. Row 1 = header,
row 2 = SCHEMA NOTE, as everywhere else in the workbook.

- `CAMPAIGNS` — one row per NOVUS campaign: `instantly_campaign_id`, `status`
  (DRAFT / ACTIVE / PAUSED / COMPLETED / ERROR), `campaign_type`
  (ENQUIRY_FOLLOWUP / GENERAL), `sequence_json`, `schedule_json`,
  `sending_json`, `audience_filters_json`, `policy_json`, `analytics_json`,
  `step_analytics_json`, `last_synced_at`, `last_error`, timestamps.
- `CAMPAIGN_MEMBERS` — one row per campaign + agency: contact/email snapshot,
  `custom_variables_json`, `eligibility_status` + `eligibility_reasons`,
  `warnings_acknowledged`, `member_status` (SELECTED → PUSHED / SKIPPED /
  PUSH_FAILED; EXCLUDED for blocked), `instantly_lead_id`,
  `instantly_lead_status`, `interest_status`, `emails_sent_count`,
  `last_event_*`, `replied_at`, `bounced_at`, `unsubscribed_at`,
  `meeting_booked_at`.
- `CAMPAIGN_EVENTS` — append-only ledger: `dedupe_key` (idempotency),
  `source` (WEBHOOK / RECONCILE / NOVUS), normalised `event_type`,
  `instantly_email_id`, step/variant, subject/snippet, bounded `payload_json`.

Why not `RAW_EVENTS` / `COMMUNICATIONS`: every Twilio/probe-email webhook
reads `RAW_EVENTS` in full for idempotency, and `COMMUNICATIONS` feeds the
probe intelligence engine. Campaign send/open events would slow the former and
corrupt the latter. `REPLY_EVENTS` remains the reply system of record (with
its classifier); campaign reply events link to it by Instantly email id.

## Environment variables

```text
INSTANTLY_API_KEY           write key: campaigns:all, leads:all, accounts:read, emails:read
INSTANTLY_REPLY_API_KEY     read key (already used by reply polling); read-only fallback
NOVUS_CAMPAIGN_POLLER_SECRET  shared secret the ~10-15 minute external poller sends as
                              X-Novus-Campaign-Poller-Secret — REQUIRED for automatic sync
                              on Instantly's Growth plan (no webhooks); see ## Polling below
INSTANTLY_WEBHOOK_SECRET    OPTIONAL — only usable on Instantly's Hyper Growth plan or above.
                            Growth-plan workspaces (the common case) skip this entirely; the
                            poller above is the real-time path either way.
```

Legacy `INSTANTLY_CAMPAIGN_ID` (the single OUTBOUND handoff campaign) is
unchanged and unrelated to campaigns created here.

**None of `INSTANTLY_REPLY_API_KEY`, `NOVUS_CAMPAIGN_POLLER_SECRET` or
`INSTANTLY_WEBHOOK_SECRET` are required for the app to run.** Without the
poller secret, campaigns still work end to end via **Sync Now** (manual) and
the nightly reconciliation — just not automatically every 10-15 minutes.

## Polling (primary sync — works on Instantly Growth, no webhooks needed)

Instantly webhooks require the **Hyper Growth** plan. On **Growth** (API v2,
no webhooks) NOVUS instead **polls** every open campaign roughly every 10-15
minutes. This is the primary way campaign status, lead activity, sends,
replies, bounces, unsubscribes and analytics reach NOVUS — not a fallback.

**Why not Vercel Cron.** `vercel.json` already schedules the nightly
finalizer (`0 3 * * *`); on the **Hobby** plan (this project's plan — see the
12-serverless-function ceiling noted elsewhere in this repo) Vercel only
triggers cron jobs **once a day**, so a native `vercel.json` cron entry cannot
poll every 10-15 minutes here. Sub-daily scheduling needs something outside
Vercel's own cron.

**What polls it instead: a free GitHub Actions workflow**, not a paid
service — `.github/workflows/campaign-sync-poll.yml`, already in this repo,
scheduled `*/15 * * * *` (every 15 minutes; GitHub's own minimum is 5 minutes,
but schedules that tight can be delayed under load, so 15 is the reliable
choice) plus `workflow_dispatch` for an on-demand test run from the Actions
tab. It does one authenticated `curl` per tick:

```text
POST https://<your-domain>/api/novus/personalisation?novus_operation=campaign-sync-poll
Authorization: Basic <NOVUS_BASIC_AUTH_USER:NOVUS_BASIC_AUTH_PASS>
X-Novus-Campaign-Poller-Secret: <NOVUS_CAMPAIGN_POLLER_SECRET>
```

**Setup** (GitHub repo → Settings → Secrets and variables → Actions → New
repository secret): add `NOVUS_BASE_URL`, `NOVUS_BASIC_AUTH_USER`,
`NOVUS_BASIC_AUTH_PASS`, `NOVUS_CAMPAIGN_POLLER_SECRET` (the same value set in
Vercel). That's the entire setup — no third-party scheduler account, nothing
to pay for. If you'd rather not use GitHub Actions, any scheduler that can
make one authenticated POST every 10-15 minutes works identically (a free
tier of cron-job.org, a `launchd`/`cron` entry on a machine that's always on,
a Zapier/Make schedule you already have, etc.) — the endpoint doesn't care who
calls it, only that the two secrets match.

**What the poll operation does** (`campaign-sync-poll`,
`lib/campaign-handlers.mjs`):
- Guarded by Basic Auth **and** the dedicated `NOVUS_CAMPAIGN_POLLER_SECRET`
  (same two-layer pattern as the existing live reply poller) — never by the
  webhook secret, which this path does not touch.
- Every open (non-COMPLETED) linked campaign not synced in the last 8 minutes
  (`CAMPAIGNS.last_synced_at`, read fresh each call — this is what makes the
  cooldown durable across cold starts and concurrent invocations, not an
  in-memory timer) gets: campaign status, `/leads/list` (status, interest,
  bounce/unsubscribe/meeting/reply flags), an **incremental** `/emails` sweep,
  and analytics + per-step analytics.
- **Incremental, not full, sends/replies fetch.** Each campaign stores
  `emails_synced_through`, the newest `/emails` timestamp it has fully
  reconciled. A poll asks Instantly only for mail at/after that point (minus a
  30-minute overlap for clock skew and eventual consistency), then advances
  the cursor — so a campaign with months of history costs one small request
  per poll, not a full re-sweep. A **manual Sync Now** and the **nightly**
  pass ignore the cursor and always do the full bounded sweep, so an
  incremental miss self-heals within 24 hours regardless.
- Every write is idempotent (dedupe keys / provider-moment matching, patch-
  by-diff on members), so an overlapping or duplicate poll tick is wasteful at
  worst, never wrong — deliberately not hardened further, since a real
  distributed lock would mean adding infrastructure this project doesn't have.
- Never activates, pauses, or adds leads. Same write surface as Sync Now, on
  a schedule.

**Staleness in the UI.** Every campaign shows when it last synced; an
**ACTIVE** campaign not synced in the last 20 minutes is marked amber
("stale"), and not in 90 minutes, red ("very stale") — on the campaigns list
and on the campaign page. A paused/draft/completed campaign is never flagged
this way, since it isn't sending. If automatic polling isn't configured yet,
the campaigns page banner says so and points here.

## Webhook (optional — needs Instantly Hyper Growth or above)

Skip this entirely on Growth; polling above already does everything a
webhook would. If you later upgrade to Hyper Growth, the endpoint below still
works unchanged and simply makes campaign events land in NOVUS within
seconds instead of one poll cycle. Instantly cannot sign payloads but can
attach custom headers. Create one webhook (Instantly → Settings →
Integrations → Webhooks, or `POST /api/v2/webhooks`):

```text
target_hook_url : https://<your-domain>/api/novus/webhooks/instantly
event_type      : all_events
headers         : { "X-Novus-Instantly-Secret": "<INSTANTLY_WEBHOOK_SECRET>" }
```

The route is a `vercel.json` rewrite onto `personalisation.js`
(`novus_operation=instantly-webhook`); `middleware.js` already exempts
`/api/novus/webhooks/*` from Basic Auth. Payloads carry no event id, so the
idempotency key is a hash of (event_type, campaign_id, lead_email, timestamp,
email_id, step, variant); a send/reply already seen by reconciliation under
its Instantly email id is also treated as a duplicate. Events for campaigns
NOVUS did not create (e.g. the legacy sequence) are still stored and
attributed to the agency by address, so they appear on the History tab.

## Operations (all Basic-Auth, POST unless noted)

| Operation | What it does |
|---|---|
| `campaigns-list` (GET) | list + metrics + setup/config status |
| `campaign-detail` (GET, `&live=1` for Instantly status/accounts) | one campaign |
| `campaign-accounts` (GET) | Instantly sending accounts (cached 2 min) |
| `lead-timeline` (GET `agency_id`) | full chronological story |
| `campaign-audience` | filters + policy → eligibility preview; **writes nothing** |
| `campaign-setup` `confirm=SETUP_CAMPAIGN_TABS` | create tabs |
| `campaign-create` `confirm=CREATE_CAMPAIGN` | DRAFT + member snapshot; **no Instantly call** |
| `campaign-update` | acknowledge warnings, remove members, edit config while DRAFT/PAUSED, rebuild audience before push |
| `campaign-push` `confirm=PUSH_TO_INSTANTLY` (+`include_warnings`) | create Instantly campaign (Draft) if needed, add READY (+acknowledged WARNING) leads; BLOCKED never |
| `campaign-launch` `confirm=LAUNCH_CAMPAIGN` + `acknowledge:true` | **the only call that starts sending** |
| `campaign-pause` / `campaign-resume` | own confirm tokens |
| `campaign-sync` | manual "Sync Now": full reconcile — status, leads (imports members Instantly has and NOVUS lacks), sends/replies, analytics |
| `campaign-sync-poll` (dedicated `NOVUS_CAMPAIGN_POLLER_SECRET` + Basic Auth) | the ~10-15 minute automated poll: same reconciliation, incremental `/emails` window, per-campaign 8-minute cooldown |
| `campaign-discover` (GET) | Instantly workspace campaigns + link state |
| `campaign-link` (`dry_run` default; `confirm=LINK_INSTANTLY_CAMPAIGN`) | link an existing Instantly campaign, import members + history; read-only on Instantly |
| `campaign-import-activity` (`dry_run` default; `confirm=IMPORT_CAMPAIGN_ACTIVITY`) | activity / leads CSV exports → events + member state |
| `campaign-reconciliation` (GET) | per-lead truth table + match audit |

## Eligibility

`lib/campaign-eligibility.mjs` evaluates a rule table per candidate. BLOCK →
`BLOCKED` (never pushed); WARN → `WARNING` (pushed only after explicit
acknowledgement); otherwise `READY` with positive facts recorded
(`EMAIL_VALID`, `PROBE_COMPLETE`, `NO_PRIOR_OUTREACH`, …). Policy switches
(cooling days, allow RISKY, allow generic, require owner, block active
campaign / negative reply / active conversation / active follow-up / meeting
booked, requires probe) are stored per campaign. Eligibility is re-evaluated
against the live workbook at push time.

## Locked presets

The A1, A2 and B founding audiences are private Production environment
variables: `NOVUS_FOUNDING_COHORT_A1_IDS`, `NOVUS_FOUNDING_COHORT_A2_IDS`, and
`NOVUS_FOUNDING_COHORT_B_IDS`. Set each as a Vercel **Secret** using the exact
comma-separated IDs from the corresponding ignored file in
`docs/commercial-reset/cohorts/`. The required counts are 75, 75 and 55, with
no overlap. Missing or malformed configuration blocks preview and creation.
The local files must never be committed to the public repository. A new
production deployment is required after adding or changing the variables.

`lib/campaign-presets.mjs` registers the campaign types whose name, copy,
delays and safety policy are fixed in code: `PROBE_FIVE_MINUTE_CALL`
(`lib/probe-call-campaign.mjs`) and the founding-pilot A/B test,
`FOUNDING_PILOT_OUTCOME` (no probe allowed) and `FOUNDING_PILOT_PROBE`
(closed probe with a seller signal required), in `lib/founding-pilot-campaign.mjs`.
Every locked preset gets the same treatment: an explicit agency cohort, the
strict policy, a provider draft check before any lead is added, member-scoped
reply matching, deterministic reply classification with CRITICAL call actions,
the preset's call script in Calling Mode, and the per-campaign funnel on the
detail page. The two founding types share a cohort, so `IN_OTHER_COHORT` stops an
agency from joining both arms. While an agency's founding sequence is
unfinished, `buildCallingWorkspace` keeps it out of the cold-call pool
(`counts.in_email_test`). To change copy, add a new preset with a new name;
never edit one that has sent. Test: `npm run novus:founding-pilot-selftest`.

## Safe testing without emailing anyone

1. Set the env vars and deploy (`NOVUS_CAMPAIGN_POLLER_SECRET` if you want
   automatic polling — see ## Polling). Open **Campaigns** and click
   **Create the tabs**.
2. **New campaign** → filter the audience (counts update live) → sequence →
   pick sending accounts → review → **Create draft campaign**. Nothing has
   touched Instantly.
3. On the campaign page, **Push to Instantly**. This creates the Instantly
   campaign in its **Draft** state and adds leads. Instantly does not send
   from a Draft campaign. Verify in the Instantly UI that the campaign is
   Draft, then use **Live status** / **Sync Now** to confirm the lead count.
   If you've wired up the GitHub Actions poller, trigger it once manually
   (Actions tab → `campaign-sync-poll` → *Run workflow*) and confirm the
   campaign's *synced* time updates without you touching Sync Now.
4. To test a real send safely, create a campaign whose audience is only your
   own test agency (Audience filter "Agency name contains"), or remove every
   other member with ✕ before pushing. Only then click **Launch…**, tick the
   acknowledgement and confirm.
5. **Nothing launches automatically.** `campaign-create`, `campaign-push`,
   `campaign-sync` and `campaign-sync-poll` never call `/activate`; only
   `campaign-launch` and `campaign-resume` do, each behind its own explicit
   confirmation. The nightly cron and the 10-15 minute poll only reconcile.
6. Locally (no Sheets/Instantly credentials) `npm run novus:campaigns-selftest`
   exercises the whole flow — including the poll path with
   `INSTANTLY_WEBHOOK_SECRET` unset — against an in-memory workbook and fake
   API.

## Bringing an existing Instantly campaign under NOVUS (historical import)

A campaign that existed in Instantly before this layer (e.g. *NOVUS - Estate
Agents - Aug 2026*) is **linked, never recreated**, and Instantly is only read:

1. **Campaigns → Instantly workspace → Check Instantly** (`campaign-discover`)
   lists the workspace's campaigns and whether NOVUS links them.
2. **Link…** runs a dry run (`campaign-link`, `dry_run:true`): Instantly status
   mirrored → NOVUS status, the lead count, how every lead matches the master
   data, and the review list. Nothing is written.
3. **Link and import history** (`confirm=LINK_INSTANTLY_CAMPAIGN`) writes one
   `CAMPAIGNS` row (`source=IMPORTED`), one `CAMPAIGN_MEMBERS` row per Instantly
   lead (`member_status=PUSHED`, eligibility blank — NOVUS made no decision),
   then runs the same sync as the Sync button: campaign status, per-lead status
   /interest, real sends and replies from `/emails`, analytics. Re-linking is
   idempotent. `/activate`, `/pause` and `/leads/add` are never called.
4. **Reconciliation tab** shows, per lead: agency, contact, email, Instantly lead
   id, lead status, interest, emails actually sent, steps, first/last send,
   replies, auto-replies, replies NOVUS sent, positive/negative, bounce,
   unsubscribe, meeting, and the NOVUS lifecycle stage — plus the match audit.
5. **Import Instantly exports** on that tab (`campaign-import-activity`):
   the *Campaign activity* CSV (opens, clicks, interest changes, bounces with
   dates, Unibox replies — things the API does not expose) and the *Leads*
   CSV. Preview first; import is idempotent on the provider moment.

**Matching** (`lib/campaign-import.mjs`), first unique hit wins:
`OUTBOUND.outreach_contact_email` → `OUTBOUND.instantly_lead_id` →
`CONTACTS.email` → `AGENCIES` outreach/primary email → `DEMOS.demo_slug`
(from the lead's `demo_url`) → unique email domain (kept, but flagged for
review). A domain shared by several agencies is `AMBIGUOUS`; anything else
`UNMATCHED`. Both are imported (history kept, address suppressed) without an
`agency_id` and listed under **Needs review**.

**Idempotency keys.** Webhook: hash of the payload's identifying fields.
API reconciliation: `rc_sent_<email id>` / `rc_reply_<email id>`. CSV:
`nv_csv_<type>_<email>_<timestamp>`. Across sources the same `(event_type,
instantly_email_id)` or the same `(event_type, lead_email)` within ±90 s is one
event. Real timestamps are always the event's `occurred_at`.

**Eligibility over history.** `prior_email_count` is the number of `EMAIL_SENT`
rows on the ledger (fallbacks: membership counter, live execution read, legacy
OUTBOUND handoff — never added together). A lead still `ACTIVE` in another
ACTIVE/PAUSED campaign is a conflict; a lead whose old sequence `COMPLETED` is
not, but carries `PRIOR_SEQUENCE_COMPLETED` instead of `NO_PRIOR_OUTREACH`. An
Instantly "interested" mark, a positively classified reply, any demo-sent
stage, a NOVUS meeting booked on a call (`CALLS.outcome=BOOKED_MEETING`) or an
open follow-up action all block cold outreach. An address shared by several
agency rows is kept once (personalised probe first) and the other rows are
`DUPLICATE_EMAIL`.

**CLI (deployed endpoints, Basic Auth, dry-run by default):**

```bash
npm run novus:instantly-link -- --discover
npm run novus:instantly-link -- --campaign <instantly_campaign_id>          # plan only
npm run novus:instantly-link -- --campaign <instantly_campaign_id> --link
npm run novus:instantly-link -- --import --campaign-id <cmp_…> --activity ~/Downloads/activity.csv --leads ~/Downloads/leads.csv [--confirm]
npm run novus:instantly-link -- --report --campaign-id <cmp_…> [--out report.json]
npm run novus:instantly-link -- --audience [--out audience.json]             # Enquiry → Quick Call V1 readiness, no write
```

## Reconciliation

Three independent layers, all calling the same `syncOneCampaign` logic, so
they can never disagree about what "synced" means:

1. **Automatic poll** — `campaign-sync-poll`, driven by the external ~10-15
   minute scheduler (see ## Polling). Incremental, per-campaign cooldown,
   the primary path on Growth.
2. **Manual "Sync Now"** — one campaign from its detail page, or **Sync
   Instantly** in the top bar for every pushed campaign. Always a full sweep,
   no cooldown; use it to force a refresh without waiting for the next poll.
3. **Nightly safety net** — the existing cron (`/api/novus/intelligence/finalize`,
   03:00 UTC) runs step F, a full `syncCampaigns({ onlyOpen: true })`,
   failure-isolated from the rest of the nightly pipeline. This is what
   catches anything the poller missed (misconfigured secret, an outage, a
   truncated incremental window) within 24 hours even if nothing else ran.

Provider execution state wins: a campaign paused/launched in the Instantly UI
becomes PAUSED/ACTIVE here; lead status, bounces, unsubscribes, sends and
replies come from `/leads/list` and `/emails` — regardless of which of the
three layers pulled them. NOVUS sales state (AGENCIES pipeline, ACTIONS,
REPLY_EVENTS classification) is never written by any of them, or by the
webhook. Because eligibility (`lib/campaign-eligibility.mjs`) always reads
live `CAMPAIGN_MEMBERS` rows rather than a cached snapshot, a reply,
unsubscribe or bounce picked up by the poller flows into the next audience
preview or push automatically — no webhook required for that either.

## V1 limits

- One variant per step is editable in the UI; the data model stores
  `variants[]` per step so A/B can be added later.
- Sequence edits after creation are only mirrored to Instantly while the
  campaign is DRAFT; otherwise create a new campaign.
- Replies are recorded as `CAMPAIGN_EVENTS` from whichever of the three
  reconciliation layers sees them first (poll, manual sync, webhook if ever
  enabled); classification into `REPLY_EVENTS` still happens through the
  separate, pre-existing reply poller, unchanged by any of this.
