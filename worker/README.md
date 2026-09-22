# NOVUS autonomous probe operator

A local browser worker that performs the manual Prober workflow: it drives the
**existing** NOVUS Prober at `/novus/probe` and the authorised Rightmove enquiry
flow, and produces its probe records through the existing endpoints by clicking
the existing controls.

It is an **additional operating mode**. The manual Prober is unchanged and
remains the reference implementation.

## What it does not do

* It does not write to Google Sheets. Every probe, every `probe_sent` stamp and
  every skip is produced by the existing `/api/novus/probe` route, reached by
  clicking the existing UI.
* It does not create probe ids, probe references, probe emails or observation
  windows. Those still come from `api/novus/probe.js` and `lib/ids.mjs`.
* It does not add a Vercel function. The project is on Hobby with a
  twelve-function ceiling and none of them is spent here.
* It never resubmits an enquiry whose outcome it could not confirm.
* It never attempts to bypass a CAPTCHA or any other human-verification step.

## Why it runs locally

A long-lived, authenticated browser session cannot live inside a short-lived
Vercel serverless invocation, and a CAPTCHA can only be handed to a human
sitting at the same browser. The worker therefore runs as an ordinary Node
process on the laptop, with a persistent Chromium profile, and exposes a
loopback control API that the Prober page talks to.

## Setup

1. **Browser.** The worker uses your installed Google Chrome by default
   (`NOVUS_OPERATOR_CHANNEL=chrome`). To use Playwright's bundled Chromium
   instead, run `npx playwright install chromium` and set
   `NOVUS_OPERATOR_CHANNEL=`.

2. **Configuration.** `NOVUS_BASE_URL`, `NOVUS_BASIC_AUTH_USER` and
   `NOVUS_BASIC_AUTH_PASS` are already in the repository root `.env`. Add:

   ```
   NOVUS_OPERATOR_TOKEN=<a long random string you generate>
   NOVUS_PROBE_FIRST_NAME=<the approved enquiry first name>
   NOVUS_PROBE_LAST_NAME=<the approved enquiry surname>
   NOVUS_PROBE_EMAIL=<the same address probe-create stamps on PROBES>
   NOVUS_PROBE_PHONE=<the same number probe-create stamps on PROBES>
   NOVUS_PROBE_POSTCODE=<the enquiry postcode>
   ```

   `NOVUS_PROBE_EMAIL` and `NOVUS_PROBE_PHONE` must match what
   `api/novus/probe.js` writes onto the PROBES row. The operator refuses to
   mark a probe as sent if the Probe ready screen shows a different address
   from the one the enquiry used.

3. **Run it.**

   ```bash
   cd worker && npm start
   ```

   It prints the control endpoint and the token.

4. **In NOVUS.** Open `/novus/operator#prober`, paste the token into
   *Autonomous probing → Worker control token*, press **Save token**. The panel
   goes live within two seconds.

5. **First run is a dry run.** With `NOVUS_OPERATOR_LIVE_SUBMIT` unset the
   worker performs the whole workflow — queue, branch page, property choice,
   canonical URL, enquiry form, identity and seller-signal verification — and
   stops short of clicking **Send**. No enquiry leaves and no probe is created.

6. **Authorising live submission.** Only when you are ready:

   ```
   NOVUS_OPERATOR_LIVE_SUBMIT=1
   NOVUS_OPERATOR_ALLOWED_AGENCIES=<the agency_id you authorise for the first live test>
   ```

   Restart the worker. Clear `NOVUS_OPERATOR_ALLOWED_AGENCIES` once the first
   live probe has been checked end to end.

## The approved enquiry

The operator fills the Rightmove form from the configured identity and sets
exactly one commercial signal:

* `sellingSituationType = pr_not_on_mrk` — "Yes, it is not yet on the market".
  This is the browser twin of the `VENDOR_DECLARATION` that
  `api/novus/probe.js` writes into `PROBES.enquiry_text`.
* "Get a free valuation of my property" is left **unticked**. If the form
  arrives with it ticked, the operator stops for a human.

Anything else on the form that disagrees with the approved identity is a hard
stop, never an overwrite.

## The two enquiry layouts

Rightmove renders the enquiry form two ways and the operator handles both:

* **Signed out** — editable inputs (`#firstName`, `#email`, `#phone.number`,
  `#sellingSituationType`). The operator fills them from the configured
  identity and sets the declaration.
* **Signed in** — the account's name, email and telephone as read-only text
  with an **Edit** control and no `#email` input. There is nothing to fill, so
  the operator *verifies*: it reads the enquiry region and checks the displayed
  name, email and telephone against the configured probe identity, confirms the
  "not yet on the market" declaration (set if still asked as a select, accepted
  if shown back as text), and finds the Send control.

**Edit is never clicked.** When the details already match there is nothing to
change; when they do not, the signed-in account is not the probe identity, and
that is an escalation rather than something to rewrite in a Rightmove profile.

The identity check matches against your configured values rather than against
Rightmove class names, so a redesigned wrapper cannot break it. If a layout is
refused anyway, the operator saves a screenshot **and** the page's HTML into
`.state/evidence/` and names the file in the escalation.

## Pacing

`NOVUS_OPERATOR_COOLDOWN_MIN_SECONDS` / `_MAX_SECONDS` (default 30–60) put a
randomised wait between one confirmed enquiry and the next agency. It runs only
after an enquiry actually went out, never after the last probe of a batch,
after a skip, or after a dry run. Pause and emergency stop are honoured during
it, and the panel shows the countdown so a waiting worker does not look like a
hung one. It is a delay and nothing else: it retries nothing and does not
interact with verification.

## Human intervention

The worker pauses, keeps every tab exactly where it is, sends a macOS
notification and shows the reason in the Prober panel for:

CAPTCHA · expired Rightmove sign-in · unexpected verification · unavailable
agency page · uncertain property suitability · unexpected enquiry form ·
uncertain submission result · repeated browser failure · a probe NOVUS did not
record as sent.

Finish whatever is needed in the operator's own browser window, then press
**I have finished — release the session** (or **Abandon this agency**).

A notification never claims a probe was sent. "Confirmed sent" appears only
after the PROBES row has been read back and found `observing` with a timestamp
and an observation deadline.

## Recovery

Operational state lives in `.state/operator-state.json` and is written before
every irreversible action, not after.

| Where it stopped | What the next start does |
|---|---|
| before the enquiry | restarts the agency from the queue |
| **during** the enquiry | human review — never resubmits |
| after the enquiry, before Create probe | resumes at Create probe |
| after Create probe | resumes at Mark as sent, on the same probe id |
| after Mark as sent | closes the cycle and moves on |

## Tests

```bash
cd worker && npm test
```

Every Rightmove request is routed to a mock that reproduces the real DOM; the
NOVUS half is an isolated in-memory backend serving the **real**
`novus/probe.html`. No test can reach Rightmove and no test can send an enquiry.

## Cost

Ordinary Playwright does all navigation, tab handling, URL reading, clicking and
form filling — no model involved. A model is consulted only when a listing type
is unreadable or a page is unrecognised. Calls, tokens and approximate USD are
metered and shown in the panel.
