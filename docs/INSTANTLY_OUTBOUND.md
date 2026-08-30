# NOVUS OUTBOUND → Instantly V1

Google Sheets `OUTBOUND` is the source of truth. Instantly is only the outbound
execution layer. Uploading a lead never changes `outbound_status` to `SENT`.

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

There is no bulk live mode. Before either live command, confirm manually that
the target Instantly campaign is in the intended non-sending/test state.
