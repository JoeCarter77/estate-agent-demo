# Pipeline regression fixtures

CSV exports of the four NOVUS workbook tabs, in the exact live header order,
used by `npm run novus:pipeline-regression`.

These are **production-shaped**: every `COMMUNICATIONS` row already carries an
`automated_or_human` value (written by an earlier deploy) with
`communication_classification`, `intent` and `contact_quality` left blank —
the state that the old stale-classification guard made permanent, and which
the rebuild now repairs.

## Using your own exports

Export the four tabs from `NOVUS_Data_V1_Master_v2` as CSV, keeping the header
row (row 2's `SCHEMA NOTE` row may stay — it is skipped), then:

```
npm run novus:pipeline-regression -- --dir ./path/to/exports
```

The directory must contain `PROBES.csv`, `COMMUNICATIONS.csv`,
`INTELLIGENCE.csv` and `DIAGNOSIS.csv`.

Nothing is written back to Google Sheets — the CSVs are loaded into the same
in-memory fake Sheets transport the self-tests use. The run reports the
before/after population counts for every field the rebuild should fill in, and
exits non-zero if any field is populated on fewer rows after the rebuild than
before it, if the rebuild reports problems, or if a second rebuild changes
anything.

## What each fixture probe covers

| probe | shape |
|---|---|
| `prb_fix_001` | vendor declared; auto-ack, then a human email offering a free valuation and a slot, then a chasing voicemail |
| `prb_fix_002` | vendor declared; genuine human email + SMS that never mention selling |
| `prb_fix_003` | no declaration; automated acknowledgement only, no human ever |
| `prb_fix_004` | no declaration; complete silence, nothing at all |
| `prb_fix_005` | vendor declared; voicemail that actually books the valuation |
| `prb_fix_006` | no declaration; one reactive human call whose transcript matches no phrase rule |
