# NOVUS — multi-user operations (Joe + Louis, Oct 2026)

How NOVUS works for more than one person: identity and sign-in, scripts,
connected inboxes, lead ownership, meetings and analytics. Test:
`npm run novus:multi-admin-selftest` (two administrators, mocked providers).

## 1. Accounts, roles and sign-in

| | Joe | Louis (and future people) |
|---|---|---|
| Account | the env credential `NOVUS_BASIC_AUTH_USER/PASS`, user id `admin` | a `USERS` row, created from **Team & access** |
| Role | ADMIN | ADMIN after **Team → Change role** (or SETTER) |
| Password | changed in Vercel env | **Change password** in the rail, or an admin **Reset password** |

Permissions follow the **role only**: a promoted admin gets exactly the env
admin's access (`novus:role-change-selftest` proves parity on every
operation). Identity stays personal: every call, email, note, callback,
meeting booking and reassignment records the `user_id` that did it.

**Sessions.** One signed cookie (`novus_session`) per browser, backed by a
Redis record. 12 h absolute, 2 h idle (sliding). Sign in at
`https://app.getnovus.co.uk` — older hosts redirect browsers there, because
the cookie is per host.

**What used to log Louis out (fixed).** Louis's account is a `USERS` row in
Google Sheets; Joe's is an env variable. Every request re-checks a `USERS`-row
session against Sheets. When that read failed (a 429 under the shared Sheets
quota, a timeout), `loadUserRows` swallowed the error and cached *"no users"*
for 30 s. So Louis's valid session looked like a deleted account → **401** →
the page sent him to the login screen → his correct password was checked
against the same empty list → **"Incorrect username or password"** → counted
as a failure → after five, the **15-minute lock**. Joe never read Sheets to
sign in, so it never happened to him. A Redis blip did the same at the edge.

Now: an unreadable account or session store is *unavailable* (HTTP 503, the
page stays signed in and says so), never *signed out*; a warm instance keeps
re-checking against the last good `USERS` read for up to 15 min (safe:
disable / reset / role change also delete the Redis session records);
sign-in during an outage answers 503 and **never counts towards the lockout**.
Also: lockout messages say how many attempts are left and how long the lock
lasts; an admin password reset unlocks the account immediately; pasted
whitespace around a password is ignored; people choose their own password
(≥ 12 characters; other devices are signed out, this one stays signed in);
an open tab reloads if someone else signs in in the same browser.

## 2. Scripts — main and gatekeeper

One `SCRIPTS` tab, one version model, one editor (**Calling → Scripts**, tabs
*Main script* / *Gatekeeper script*). The kind is the family key's prefix
(`scr_` main, `gk_` gatekeeper), so the tab's header is unchanged and every
existing row is a main script.

* **Create / edit / rename / save** — as before. A version any call used is
  frozen; saving creates the next version. For a gatekeeper version "used"
  means a call marked *Gatekeeper* while it was on screen
  (`CALLS.metadata_json.gatekeeper_script_id`).
* **Duplicate as new version** (same script) or **Duplicate as new script**
  (a separate script, v1).
* **Company default** — one CURRENT per kind. Making a gatekeeper the default
  never touches the main script, and vice versa.
* **Use for my calls** — a personal pick, stored in *your* preferences. Joe and
  Louis can use different versions without changing each other's or the
  default. If your pick is archived, you follow the newest live version of
  the same script; if it is deleted, the company default (the page says so).
* **Archive / restore** via status; **Delete version** only when no call ever
  used it and it is not a default.
* **Calling Mode** shows your gatekeeper version (with an in-call switcher);
  the main script follows the existing cohort rule — a lead already called
  stays on the version it was called with; a never-called lead gets *your*
  pick, else the company default.

The old hard-coded gatekeeper text in `calling.html` is gone; it now lives
only in `lib/calling-store.mjs` as the fallback. On an existing workbook,
open **Scripts → Gatekeeper script → + New script** (it starts from that
wording) and **Save** — that becomes gatekeeper v1 and the company default.
Until then Calling Mode shows the same built-in wording. (A fresh workbook's
`calling-setup` seeds it automatically.)

## 3. Personal preferences

`novus:prefs:<user_id>` in Redis (not Sheets: read on every Calling load).
Allow-listed keys: `main_script_id`, `gatekeeper_script_id`,
`queue_owner_filter` (Everyone's / My / Unassigned leads, on the Calling
queue), `email_signature`. Shared data (agencies, contacts, the script and
template libraries) stays shared.

## 4. Email — three different things

| | Instantly campaigns | Instantly inbox replies | **Your own inbox (new)** |
|---|---|---|---|
| What | cold-outreach sequences | a person replying in an Instantly thread | one-to-one email from Calling Mode / a lead profile |
| Sender | Instantly's sending accounts set on the campaign | the Instantly account (`eaccount`) the thread is on | **the signed-in person's** connected Google / Microsoft inbox |
| Who triggers | `campaign-launch` (confirm + acknowledgement); steps then run on Instantly's schedule | a person pressing Send in the drawer's Conversation pane | a person pressing **Send email** in compose |
| Records | `CAMPAIGN_EVENTS`, `CAMPAIGN_MEMBERS` | `SALES_MESSAGES` (`sent_by` = person) | `EMAIL_MESSAGES` (sender, from address, status, provider id) |
| Timeline | "campaign" entries | "Manual reply sent" | "Email sent by <person>" |

Cold outreach stays in Instantly. Nothing changed there.

### Automated email — the complete list

* **Instantly campaign steps** after an explicit launch (`campaign-launch` /
  `campaign-resume` are the only calls to Instantly `/activate`). Sender: the
  campaign's Instantly accounts.
* The reply poller (GitHub Actions every 15 min) **classifies** replies; its
  automatic demo send is **disabled in code** (`runAutoSendDemo` returns
  `disabled`).
* `send-demo` (live) needs the poller secret and is a deliberate call.
* **No call outcome sends email.** *More info requested*, *Referred to email*,
  *Booked meeting* create follow-up actions only; Calling Mode then *offers*
  to open the compose window. Nothing new was automated.

### Connect your inbox (Settings → Email accounts)

Sign in with Google Workspace / Gmail or Microsoft 365 / Outlook (OAuth 2 +
PKCE). NOVUS never sees a password. Scopes are **send-only** (`gmail.send`;
`Mail.Send` + `User.Read`): NOVUS cannot read your mailbox. Tokens are
AES-256-GCM encrypted at rest (key `NOVUS_MAIL_TOKEN_KEY`), bound to your
user id, and never returned by any API. One address ↔ one NOVUS user; with
`NOVUS_MAIL_ALLOWED_DOMAINS` set, company domains only. The page shows your
address, provider, status, last send, last error; **Reconnect**,
**Disconnect**, **Send test email** (to an address you type). Admins also see
who has connected which inbox (never tokens).

### Sending (compose)

Template (suggested from the call outcome) → recipient → **From (your
inbox, read-only)** → subject → body, with lead/sender placeholders filled
and any unfilled `{{…}}` blocking Send. On Send:

1. Your own connection only — never another person's, never a fallback. Not
   connected / expired → a clear "Connect / Reconnect" and nothing is sent.
   If your connected address changed since the window opened, it refuses.
2. Opted-out agency → refused unless you confirm they asked for it (recorded).
3. Exactly once: an idempotency key per compose window, taken atomically in
   Redis before sending (double click, retry, two tabs → one email).
4. An `EMAIL_MESSAGES` row (SENDING) is written **before** the provider call,
   then SENT (provider accepted: Gmail message id; Outlook 202) or FAILED
   (refused — nothing sent, may retry) or **UNCONFIRMED** (connection dropped
   mid-send — check Sent items; the same compose cannot send again).
5. You see "Accepted by Gmail/Outlook at …"; the agency timeline shows it;
   the lead is claimed for you if it had no owner.

### Replies

Replies go to **your own inbox** like any email. NOVUS does **not** import
them — no inbox sync was built (it would need read scopes; `gmail.readonly`
is a Google *restricted* scope). The timeline shows what was sent; reply
handling for these threads happens in Gmail/Outlook. Instantly reply
ingestion is unchanged.

### Templates (Settings → Email templates)

Shared `EMAIL_TEMPLATES` library, seeded with five price-free starters on
first use. Versioned like scripts: one in-use version per template; a version
a sent email used is frozen (editing creates the next). Admins edit; everyone
can use them.

## 5. Leads, queues, meetings

* **Owner** = the append-only `LEAD_OWNERSHIP` ledger (unchanged). First
  meaningful interaction claims an unassigned lead — calls and now emails.
  Admins reassign from the drawer.
* **Queue** — shared; filter Everyone's / My / Unassigned (remembered per
  person); *Start calling* works through the filtered list. Callbacks and
  call actions belong to the caller who created them.
* **Duplicate-call protection** — a dial opened by someone else in the last
  20 min with no outcome yet: the queue says "<name> is on a call to them";
  dialling asks for confirmation (server-enforced for Twilio dials).
* **Meetings** — a booked meeting keeps `handover.booked_by` (the caller) and
  the call notes forever. Who **runs** it is the PREPARE_MEETING action's
  assignee: by default the booker if they are an admin, otherwise Joe. Any
  admin reassigns it from **Meetings** (Booked by · Runs it) or Your
  Priorities; it moves to that person's Priorities, attribution unchanged.

## 6. Team analytics (Calling → Team)

Per person and **Company — everyone** (sum; each call/email belongs to one
person). Definitions are on every tile (hover) and in
`lib/call-sessions.mjs METRIC_DEFINITIONS`: dials, connected, gatekeepers,
owners reached, owner conversations, positive responses, callbacks,
**emails sent (own inbox, accepted, tests excluded)**, meetings booked,
meetings attended (completed discovery session), **qualified opportunities**
and **pilots agreed** (discovery outcome; credited to the booker — sessions
do not record who ran them).

## 7. Setup still required (not done by code)

1. **Promote Louis**: Team & access → Louis → *Change role* → ADMIN. His
   sessions end once; he signs in again.
2. Vercel env (Production):
   * `NOVUS_MAIL_TOKEN_KEY` — `openssl rand -base64 32`. Changing it later
     forces everyone to reconnect.
   * `NOVUS_MAIL_ALLOWED_DOMAINS=getnovus.co.uk` (recommended).
   * Google: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` — Google
     Cloud → OAuth client (Web), redirect URI
     `https://app.getnovus.co.uk/api/novus/mail/oauth/callback`, enable the
     Gmail API, consent screen **Internal** (Workspace) with scopes `openid
     email profile gmail.send`.
   * Microsoft: `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET`
     (`MICROSOFT_OAUTH_TENANT` = your tenant id, default `organizations`) —
     Entra ID app registration, Web redirect URI as above, delegated
     permissions `Mail.Send`, `User.Read`, `offline_access`.
   * Optional `NOVUS_APP_ORIGIN=https://app.getnovus.co.uk` to pin the
     redirect host.
3. Scripts → Gatekeeper script → **+ New script → Save** (creates gatekeeper v1).
4. Each person: Settings → Email accounts → Connect → Send test email.
