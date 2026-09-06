# NOVUS OUTBOUND → Instantly V1

Google Sheets `OUTBOUND` is the source of truth. Instantly is only the outbound
execution layer. Uploading a lead never changes `outbound_status` to `SENT`.

The active custom-variable payload contains `property_street`, `probe_date`,
`probe_time`, `email_observation`, `email_commercial_hook` and `demo_url`.
`email_commercial_hook_email_2` is deprecated: its historical Sheet column is
preserved, but it is neither required for eligibility nor sent to Instantly.

## Server-side environment

Configure these in the Vercel project environment for every deployment target
that will use the handoff, then redeploy so the function can read them:

```text
INSTANTLY_API_KEY=...
INSTANTLY_CAMPAIGN_ID=...
```

Both values remain server-side. The operator CLI sends neither value. The API
key must not be placed in browser code, CLI flags, logs, or committed files.

The local operator shell also needs the existing protected-endpoint settings:

```text
NOVUS_BASE_URL=https://...
NOVUS_BASIC_AUTH_USER=...
NOVUS_BASIC_AUTH_PASS=...
```

## Commands

Read-only dry-run, with three exact payload samples by default:

```bash
npm run novus:instantly-dry-run
```

Use `-- --sample-limit 5` to change the bounded sample count (maximum 20).

Controlled test-email upload using one real OUTBOUND row's variables while
overriding only the destination email:

```bash
npm run novus:instantly-live -- \
  --outbound-id out_... \
  --confirm UPLOAD_ONE_TO_INSTANTLY \
  --test-email you@example.com
```

This test mode makes one Instantly request but never writes to OUTBOUND.

Controlled real single-lead handoff:

```bash
npm run novus:instantly-live -- \
  --outbound-id out_... \
  --confirm UPLOAD_ONE_TO_INSTANTLY
```

Production bulk handoff for every eligible OUTBOUND row:

```bash
npm run novus:instantly-live -- \
  --bulk \
  --confirm UPLOAD_ALL_ELIGIBLE_TO_INSTANTLY
```

The bulk operation is safely rerunnable. It selects only `READY` rows with
both `instantly_lead_id` and `instantly_added_at` blank, writes those markers
only after Instantly returns a nonblank lead ID, preserves `READY`, and
continues after individual failures. Before a live command, confirm manually
that the target Instantly campaign is in the intended non-sending/test state.

The existing Vercel nightly finalizer owns automation. Its existing
`0 3 * * *` UTC schedule runs the normal pipeline, rebuilds OUTBOUND, then
uses this same bulk handoff for any newly eligible rows. No second scheduler
is used.
