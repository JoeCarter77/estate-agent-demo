# NOVUS — Rebuild Intelligence button

A minimal Apps Script for the NOVUS Google Sheet (`NOVUS_Data_V1_Master_v2`)
that adds a **Rebuild Intelligence** button. Clicking it does exactly one
thing: calls `POST /api/novus/intelligence/rebuild-all` (the existing,
idempotent full-rebuild endpoint) and shows the returned summary. No
intelligence/grading/matching logic lives in Sheets — that stays in code.

After rebuilding INTELLIGENCE, the same click also rebuilds DIAGNOSIS (one
row per probe whose `observation_status` is `closed`) — see
`lib/diagnosis-rebuild.mjs`. This requires a **DIAGNOSIS** tab to already
exist in the spreadsheet with a header row of:
`diagnosis_id, agency_id, probe_id, grade, tier, primary_problem,
evidence_summary, commercial_implication, recommended_solution, sales_angle,
created_at, updated_at` (row 2 may hold a "SCHEMA NOTE" row, same convention
as every other tab). No other columns — DIAGNOSIS is a commercial read of an
already-closed, already-graded INTELLIGENCE row, not a new evidence store.

## One-time setup

1. Open the spreadsheet, then **Extensions → Apps Script**.
2. Paste the contents of `RebuildIntelligence.gs` into the script editor
   (as a new file, or into `Code.gs`) and save.
3. **Project Settings → Script Properties**, add:
   - `NOVUS_API_BASE_URL` — the deployed app's origin, e.g.
     `https://<your-deployment>.vercel.app`
   - `NOVUS_BASIC_AUTH_USER` / `NOVUS_BASIC_AUTH_PASS` — same credentials as
     `NOVUS_BASIC_AUTH_USER` / `NOVUS_BASIC_AUTH_PASS` on the Vercel project
     (the same Basic Auth every other `/api/novus/*` endpoint already
     requires).
4. Reload the spreadsheet. A **NOVUS** menu appears in the menu bar with
   **Rebuild Intelligence** — that's the button.

## Optional: a clickable button directly on the INTELLIGENCE sheet

The menu item above is enough on its own, but if you'd like a button placed
directly on the INTELLIGENCE tab: open the INTELLIGENCE sheet, **Insert →
Drawing**, draw a button, save, then click the drawing's ⋮ menu → **Assign
script** → enter `rebuildIntelligence`. It now calls the same handler as the
menu item.
