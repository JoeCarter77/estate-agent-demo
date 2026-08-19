# Pipeline regression fixtures

CSV exports of the four NOVUS workbook tabs, in the exact live header order,
used by `npm run novus:pipeline-regression`.

These are **production-shaped**: every `COMMUNICATIONS` row already carries an
`automated_or_human` value (written by an earlier deploy). `INTELLIGENCE` and
`DIAGNOSIS` are in the V2 schema (docs/V2_COMMS_INTELLIGENCE_DIAGNOSIS_SCHEMA.md)
— the rebuild AI-interprets every probe once (`communication_quality` etc. are
blank until then) and never again once populated.

Running the regression makes real AI calls unless you inject a fake caller —
see `scripts/novus-pipeline-regression.mjs`'s use of
`lib/ai-client.mjs`'s `__setAiCallerForTests()`.

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
