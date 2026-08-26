// scripts/novus-findings-duplication-selftest.mjs — regression test for the
// reported bug: ONE rebuild, run once, left DIAGNOSIS_FINDINGS with two copies
// of every finding for a probe, while DIAGNOSIS itself still held exactly one
// row for that probe.
//
// ROOT CAUSE (reproduced below as case 1, and it is NOT repeated HTTP
// requests). lib/diagnosis-rebuild.mjs iterates INTELLIGENCE ROWS. INTELLIGENCE
// is one row per probe_id by construction, not by enforcement, and since the
// probe_id trim went in ('prb_x' and 'prb_x ' now normalise to the same id) a
// workbook carrying two rows for one probe puts that probe through the
// diagnosis loop TWICE inside a single pass. On each visit:
//   - DIAGNOSIS was upserted through a probe_id -> row Map, so both visits
//     resolved to the SAME row and the tab still showed one row per probe —
//     which is exactly why the duplication was invisible there; but
//   - the findings writer re-derived "which rows does this probe already own?"
//     from the table SNAPSHOT loaded at the start of the pass, which never
//     changes during it. The second visit therefore saw none of the first
//     visit's rows, took a fresh block from the row counter, and appended a
//     complete second copy.
// N findings -> 2N rows, one rebuild, one request, and two AI calls spent.
//
// THE INVARIANT THIS SUITE LOCKS DOWN:
//   ONE rebuild -> ONE DIAGNOSIS row per probe
//              -> ONE DIAGNOSIS_FINDINGS row per finding per probe
//              -> ONE PERSONALISATION row per probe
// A probe with 8 findings leaves exactly 8 findings rows behind. Not
// deduplicated after the fact — never written twice in the first place.
//
// Cases:
//   1. the exact reported shape: duplicate INTELLIGENCE rows for one probe,
//      ONE rebuild -> one row per finding, 1 DIAGNOSIS row, 1 PERSONALISATION
//      row, 1 diagnosis AI call
//   2. the same, across several probes at once — no probe's block of rows
//      lands on top of another's
//   3. the report's own number: 8 findings written twice in one pass still
//      leave exactly 8 rows; and a re-diagnosis with FEWER findings leaves no
//      orphaned surplus row behind
//   4. the single-probe recompute path (webhooks) persists findings too, and
//      running it repeatedly never duplicates them
//   5. repo.writeRowsBatch never sends two writes for the same range
//   6. a batched rebuild — several bounded invocations, one logical rebuild —
//      still ends at exactly one row per finding
//
// Run: npm run novus:findings-duplication-selftest

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';
import { runRebuildPass } from '../lib/rebuild-pass.mjs';
import { rebuildAllDiagnosis } from '../lib/diagnosis-rebuild.mjs';
import { recomputeProbeObservation } from '../lib/observation-recompute.mjs';
import { createFindingsWriter } from '../lib/diagnosis-findings.mjs';

const PROBES_HEADER = [
  'probe_id', 'agency_id', 'property_address', 'property_price', 'enquiry_text',
  'probe_timestamp', 'observation_deadline', 'probe_status', 'created_at', 'updated_at',
];
const COMMUNICATIONS_HEADER = [
  'communication_id', 'agency_id', 'probe_id', 'occurred_at', 'channel', 'direction',
  'subject', 'body_text', 'transcript', 'match_status', 'automated_or_human',
  'manual_override', 'created_at', 'updated_at',
];
const INTELLIGENCE_HEADER = [
  'intelligence_id', 'agency_id', 'probe_id', 'observation_status', 'human_contact',
  'response_hours', 'contact_attempts', 'follow_ups', 'channels_used',
  'viewing_progression', 'buyer_qualification', 'buyer_questions_asked', 'seller_recognition',
  'communication_quality', 'did_well', 'missed', 'evidence', 'grade', 'grade_reason',
  'created_at', 'updated_at',
];
const DIAGNOSIS_HEADER = [
  'diagnosis_id', 'agency_id', 'probe_id', 'findings', 'strengths', 'missed_opportunities',
  'commercial_implication', 'novus_opportunity', 'diagnosis_summary', 'created_at', 'updated_at',
];
const DIAGNOSIS_FINDINGS_HEADER = ['probe_id', 'finding_index', 'finding_type', 'finding', 'evidence', 'significance_note'];
const PERSONALISATION_HEADER = [
  'personalisation_id', 'agency_id', 'probe_id', 'hero_journey', 'primary_narrative',
  'narrative_finding_indexes', 'positive_finding_index', 'main_finding_index',
  'wider_finding_index', 'supporting_findings', 'evidence', 'novus_counterfactual',
  'fair_observation', 'main_finding', 'commercial_consequence',
  'property_reference', 'email_observation', 'email_commercial_hook',
  'email_commercial_hook_email_2',
  'created_at', 'updated_at',
];
const AGENCIES_HEADER = ['agency_id', 'agency_name'];

// Long past, so every probe's 4-day observation window has closed.
const PROBE_AT = '2020-01-01T09:00:00.000Z';
const DEADLINE = '2020-01-05T09:00:00.000Z';

function makeFakeSheet() {
  const store = {
    PROBES: [PROBES_HEADER.slice()],
    COMMUNICATIONS: [COMMUNICATIONS_HEADER.slice()],
    INTELLIGENCE: [INTELLIGENCE_HEADER.slice()],
    DIAGNOSIS: [DIAGNOSIS_HEADER.slice()],
    DIAGNOSIS_FINDINGS: [DIAGNOSIS_FINDINGS_HEADER.slice()],
    PERSONALISATION: [PERSONALISATION_HEADER.slice()],
    AGENCIES: [AGENCIES_HEADER.slice(), ['agc_1', 'Test Agency']],
  };
  const tabOf = (range) => String(range).split('!')[0];
  const startRowOf = (range) => {
    const m = String(range).match(/!\D+(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  };
  // Every range written through batchUpdate, in order, so case 5 can assert
  // that no range is ever written twice in one batch.
  const writtenRanges = [];
  const valuesApi = {
    async get(range) { return (store[tabOf(range)] || []).map((r) => r.slice()); },
    async append(range, rows) {
      const tab = tabOf(range);
      store[tab] = store[tab] || [];
      for (const r of rows) store[tab].push(r.slice());
      return { updates: { updatedRows: rows.length } };
    },
    async update(range, rows) {
      const tab = tabOf(range); const start = startRowOf(range);
      store[tab] = store[tab] || [];
      rows.forEach((r, i) => { store[tab][start - 1 + i] = r.slice(); });
    },
    async batchUpdate(data) {
      const batch = [];
      for (const { range, values } of data) {
        batch.push(range);
        const tab = tabOf(range); const start = startRowOf(range);
        store[tab] = store[tab] || [];
        values.forEach((row, i) => { store[tab][start - 1 + i] = row.slice(); });
      }
      writtenRanges.push(batch);
    },
  };
  return { store, repo: createRepo(valuesApi), writtenRanges };
}

function row(header, obj) { return header.map((k) => obj[k] ?? ''); }
function toObj(header, r) { return Object.fromEntries(header.map((k, i) => [k, r[i]])); }

function dataRows(store, tab, header) {
  return store[tab].slice(1)
    .filter((r) => String(r[0] ?? '').trim() && r[0] !== 'SCHEMA NOTE')
    .map((r) => toObj(header, r));
}

function findingsFor(store, probeId) {
  return dataRows(store, 'DIAGNOSIS_FINDINGS', DIAGNOSIS_FINDINGS_HEADER)
    .filter((f) => String(f.probe_id).trim() === probeId);
}

// n distinct, evidence-backed findings — the shape lib/probe-diagnosis.mjs's
// evidence gate lets through. That module caps a probe at 4 (3 story + 1
// positive, split by splitToBudget below), so the "8 findings" case in the
// brief is exercised through the writer directly (case 3) as well as through
// the full pipeline.
function stubFindings(n, tag) {
  return Array.from({ length: n }, (_, i) => ({
    finding: `${tag}: finding number ${i + 1}.`,
    evidence: `${tag}: the specific evidence behind finding ${i + 1}.`,
    significance_note: `${tag}: why finding ${i + 1} matters.`,
  }));
}

// n stub findings -> the two arrays lib/probe-diagnosis.mjs accepts, inside
// its 3-story + 1-positive per-probe budget, so N stubs still persist as N
// rows in Diagnosis's own order (problems/opportunities first, positive last).
function splitToBudget(findings) {
  return {
    findings: findings.slice(0, 3),
    positive_findings: findings.slice(3, 4).map(({ finding, evidence, significance_note }) => ({ finding, evidence, significance_note })),
  };
}

function seedProbe(store, probeId, { address }) {
  store.PROBES.push(row(PROBES_HEADER, {
    probe_id: probeId, agency_id: 'agc_1', property_address: address,
    property_price: '£425,000', enquiry_text: 'Enquiring about a viewing. I also have a place of my own to sell.',
    probe_timestamp: PROBE_AT, observation_deadline: DEADLINE,
  }));
  store.COMMUNICATIONS.push(row(COMMUNICATIONS_HEADER, {
    communication_id: `com_${probeId}`, agency_id: 'agc_1', probe_id: probeId,
    occurred_at: '2020-01-01T12:00:00.000Z', channel: 'email',
    body_text: 'Give us a call back when you want to view.', match_status: 'matched',
    automated_or_human: 'human',
  }));
}

function intelligenceRow(probeId) {
  return row(INTELLIGENCE_HEADER, {
    intelligence_id: `itl_${probeId}`, agency_id: 'agc_1', probe_id: probeId,
    observation_status: 'closed', human_contact: 'yes', response_hours: '3',
    contact_attempts: '1', follow_ups: '0', channels_used: 'email',
    viewing_progression: 'invited', buyer_qualification: 'none', seller_recognition: 'none',
    communication_quality: 'generic', did_well: 'Replied the same day.',
    missed: 'No qualifying question asked.', grade: 'D',
    created_at: PROBE_AT, updated_at: PROBE_AT,
  });
}

let diagnoseCalls = 0;
let personaliseCalls = 0;

function installAi(findingsByTag) {
  __setAiCallerForTests(async ({ tool, prompt }) => {
    if (tool.name === 'record_probe_diagnosis') {
      diagnoseCalls += 1;
      const tag = Object.keys(findingsByTag).find((t) => prompt.includes(t)) || Object.keys(findingsByTag)[0];
      // Diagnosis's per-probe budget is 3 problem/opportunity findings plus 1
      // positive (lib/probe-diagnosis.mjs), so a stub of N findings is SPLIT
      // on that boundary rather than handed over as N problems. This suite
      // counts ROWS, and a stub that overflowed the story cap would quietly
      // lose one before it ever reached the tab.
      return {
        ...splitToBudget(findingsByTag[tag]),
        strengths: 'Replied the same day.',
        missed_opportunities: 'No qualifying question asked.',
        commercial_implication: 'A viewing slot went to an unqualified buyer.',
        novus_opportunity: 'Core (front desk)',
        diagnosis_summary: `Fast but shallow handling of ${tag}.`,
      };
    }
    if (tool.name === 'record_probe_personalisation') {
      personaliseCalls += 1;
      return {
        primary_narrative: 'You replied the same day but never asked a single qualifying question.',
        // The stub diagnosis now carries a positive at index 4 (splitToBudget
        // above), and Personalisation refuses an answer that ignores an
        // available positive — so the stub selects it rather than burning
        // this suite's AI-call counts on repair attempts.
        positive_finding_index: 4, main_finding_index: 1, wider_finding_index: null,
        supporting_findings: 'There were other gaps too.',
        fair_observation: 'you did reply the same day.',
        main_finding: 'that nobody asked anything about my position before inviting me to view.',
        commercial_consequence: 'a viewing slot went to someone nobody had checked could actually buy.',
        email_observation: 'You replied the same day, but nobody asked anything about my position before inviting me to view.',
        email_commercial_hook: 'So the buyer opportunity reached a viewing invitation without being qualified.',
        email_commercial_hook_email_2: 'The invitation itself was fine — the gap is that you still know nothing about whether I could buy it.',
        novus_counterfactual: 'NOVUS would have asked budget and timescale on the first call.',
      };
    }
    return {
      viewing_progression: 'invited', buyer_questions_asked: [], seller_recognition: 'none',
      communication_quality: 'generic', did_well: 'Replied the same day.',
      missed: 'No qualifying question asked.', evidence: [],
    };
  });
}

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

async function run() {
  console.log('DIAGNOSIS_FINDINGS duplication regression — one rebuild, one row per finding\n');

  // ── 1. The exact reported shape ────────────────────────────────────────────
  // Two INTELLIGENCE rows for one probe (the second carrying the invisible
  // trailing space that made them two rows in the first place), a DIAGNOSIS
  // row already present with a BLANK summary (so the probe is not frozen and
  // will be diagnosed this pass), and a diagnosis that produces 4 findings.
  {
    diagnoseCalls = 0; personaliseCalls = 0;
    const { store, repo } = makeFakeSheet();
    __setRepoForTests(repo);
    installAi({ 'Oak Road': stubFindings(4, 'Oak Road') });

    seedProbe(store, 'prb_dup', { address: '14 Oak Road' });
    store.INTELLIGENCE.push(intelligenceRow('prb_dup'));
    store.INTELLIGENCE.push(intelligenceRow('prb_dup '));   // <- the duplicate
    store.DIAGNOSIS.push(row(DIAGNOSIS_HEADER, {
      diagnosis_id: 'dgn_dup', agency_id: 'agc_1', probe_id: 'prb_dup',
      diagnosis_summary: '',                                 // <- not frozen yet
      created_at: PROBE_AT, updated_at: PROBE_AT,
    }));

    const summary = await runRebuildPass(repo, { maxAiCalls: 50 });

    const findings = findingsFor(store, 'prb_dup');
    assert.strictEqual(findings.length, 4, 'ONE rebuild leaves exactly one row per finding, not two copies');
    assert.deepStrictEqual(findings.map((f) => String(f.finding_index)), ['1', '2', '3', '4'],
      'and the finding indexes are 1..N exactly once each');
    assert.strictEqual(new Set(findings.map((f) => f.finding)).size, 4, 'with no finding text repeated');

    assert.strictEqual(dataRows(store, 'DIAGNOSIS', DIAGNOSIS_HEADER).length, 1, 'ONE DIAGNOSIS row for the probe');
    assert.strictEqual(dataRows(store, 'PERSONALISATION', PERSONALISATION_HEADER).length, 1, 'ONE PERSONALISATION row for the probe');
    assert.strictEqual(diagnoseCalls, 1, 'and the probe was diagnosed ONCE — the duplicate visit cost no second AI call either');
    assert.strictEqual(summary.diagnosis.findings_written, 4, 'the summary counts the findings once, per probe');
    assert.strictEqual(summary.diagnosis.duplicate_intelligence_rows_skipped, 1, 'the duplicate INTELLIGENCE row is reported, not silently absorbed');
    assert.strictEqual(summary.personalisation.duplicate_intelligence_rows_skipped, 1, 'and Personalisation skips it the same way');
    ok('the reported bug: duplicate INTELLIGENCE rows for one probe no longer duplicate its findings inside a single rebuild');
  }

  // ── 2. Several probes at once — no block of rows lands on another's ────────
  {
    diagnoseCalls = 0; personaliseCalls = 0;
    const { store, repo } = makeFakeSheet();
    __setRepoForTests(repo);
    const tags = ['Oak Road', 'Elm Way', 'Ash Close'];
    installAi(Object.fromEntries(tags.map((t) => [t, stubFindings(4, t)])));

    tags.forEach((address, i) => {
      const probeId = `prb_${i}`;
      seedProbe(store, probeId, { address });
      store.INTELLIGENCE.push(intelligenceRow(probeId));
      // Every one of them duplicated, which is the worst case.
      store.INTELLIGENCE.push(intelligenceRow(`${probeId} `));
    });

    await runRebuildPass(repo, { maxAiCalls: 50 });

    const all = dataRows(store, 'DIAGNOSIS_FINDINGS', DIAGNOSIS_FINDINGS_HEADER);
    assert.strictEqual(all.length, 12, 'three probes x four findings = twelve rows, full stop');
    const keys = all.map((f) => `${String(f.probe_id).trim()}#${f.finding_index}`);
    assert.strictEqual(new Set(keys).size, keys.length, 'every (probe_id, finding_index) appears exactly once');
    for (let i = 0; i < tags.length; i += 1) {
      const mine = findingsFor(store, `prb_${i}`);
      assert.strictEqual(mine.length, 4, `prb_${i} owns exactly four rows`);
      assert.ok(mine.every((f) => f.finding.startsWith(tags[i])), `prb_${i}'s rows carry only its own findings`);
    }
    assert.strictEqual(dataRows(store, 'DIAGNOSIS', DIAGNOSIS_HEADER).length, 3, 'one DIAGNOSIS row per probe');
    assert.strictEqual(dataRows(store, 'PERSONALISATION', PERSONALISATION_HEADER).length, 3, 'one PERSONALISATION row per probe');
    assert.strictEqual(diagnoseCalls, 3, 'and one diagnosis AI call per probe');
    ok('with every probe duplicated in INTELLIGENCE, the findings tab still holds exactly one row per finding per probe, with no cross-probe collision');
  }

  // ── 3. Eight findings for one probe, and a later, shorter diagnosis ───────
  // Eight is the count from the report. lib/probe-diagnosis.mjs's own evidence
  // gate caps a diagnosis at four, so the eight-findings case is driven
  // through the writer itself — including the case that caused the bug, the
  // SAME probe written twice inside one pass — while the shrink case (a
  // re-diagnosis producing fewer findings must leave no orphan behind for
  // Personalisation to read back as genuine) runs through the real rebuild.
  {
    const table = { header: DIAGNOSIS_FINDINGS_HEADER.slice(), rows: [] };
    const writer = createFindingsWriter(table);
    writer.write('prb_eight', stubFindings(8, 'Eight Street'));
    // The second visit — exactly what a duplicate INTELLIGENCE row caused.
    writer.write('prb_eight', stubFindings(8, 'Eight Street'));

    const writes = writer.writes();
    assert.strictEqual(writes.length, 8,
      'a probe with 8 findings produces EXACTLY 8 findings rows, even written twice in one pass — the invariant from the report');
    assert.strictEqual(writer.findingsWritten(), 8, 'and is counted once, not twice');
    assert.strictEqual(new Set(writes.map((w) => w.rowNumber)).size, 8, 'across 8 distinct rows');
    const indexIdx = DIAGNOSIS_FINDINGS_HEADER.indexOf('finding_index');
    assert.deepStrictEqual(writes.map((w) => String(w.row[indexIdx])).sort(), ['1', '2', '3', '4', '5', '6', '7', '8']);

    // A second probe in the same pass gets its own rows, never the first's.
    writer.write('prb_other', stubFindings(3, 'Other Road'));
    const rowNumbers = writer.writes().map((w) => w.rowNumber);
    assert.strictEqual(new Set(rowNumbers).size, rowNumbers.length, 'a second probe never lands on the first probe\'s rows');

    // ── the shrink case, through the real rebuild ──
    diagnoseCalls = 0;
    const { store, repo } = makeFakeSheet();
    __setRepoForTests(repo);

    seedProbe(store, 'prb_shrink', { address: 'Shrink Street' });
    store.INTELLIGENCE.push(intelligenceRow('prb_shrink'));
    store.INTELLIGENCE.push(intelligenceRow('prb_shrink '));

    let findings = stubFindings(4, 'Shrink Street');
    __setAiCallerForTests(async () => {
      diagnoseCalls += 1;
      return {
        ...splitToBudget(findings),
        strengths: 'Replied the same day.', missed_opportunities: 'Several.',
        commercial_implication: 'Specific to this probe.',
        novus_opportunity: 'Core (front desk)', diagnosis_summary: 'Four things went wrong.',
      };
    });

    const probesById = new Map([['prb_shrink', { probe_id: 'prb_shrink', property_address: 'Shrink Street' }]]);
    const first = await rebuildAllDiagnosis(repo, probesById, {});
    assert.strictEqual(findingsFor(store, 'prb_shrink').length, 4, 'four findings, four rows');
    assert.strictEqual(first.findings_written, 4);
    assert.strictEqual(diagnoseCalls, 1, 'one AI call, despite the duplicate INTELLIGENCE row');

    // Unfreeze and re-diagnose with fewer findings.
    const diagIdx = DIAGNOSIS_HEADER.indexOf('diagnosis_summary');
    store.DIAGNOSIS[1][diagIdx] = '';
    findings = stubFindings(2, 'Shrink Street');
    await rebuildAllDiagnosis(repo, probesById, {});

    const after = findingsFor(store, 'prb_shrink');
    assert.strictEqual(after.length, 2, 'a shorter re-diagnosis leaves exactly two rows — the surplus two are blanked, not orphaned');
    assert.deepStrictEqual(after.map((f) => String(f.finding_index)), ['1', '2']);
    ok('eight findings persist as exactly eight rows even when the same probe is written twice in one pass, and a later, shorter diagnosis leaves no stale finding behind');
  }

  // ── 4. The single-probe recompute path writes findings, idempotently ───────
  // A diagnosis written by this path with no findings rows would be FROZEN
  // findings-less (diagnosis_summary is the freeze signal), and Personalisation
  // would then be handed an empty findings list for a probe that genuinely has
  // findings.
  {
    diagnoseCalls = 0;
    const { store, repo } = makeFakeSheet();
    __setRepoForTests(repo);
    installAi({ 'Webhook Way': stubFindings(4, 'Webhook Way') });

    seedProbe(store, 'prb_hook', { address: 'Webhook Way' });

    const firstRun = await recomputeProbeObservation(repo, 'prb_hook');
    assert.ok(firstRun.diagnosis_id, 'the closed probe is diagnosed by the single-probe path');
    assert.strictEqual(firstRun.findings_written, 4, 'and its findings are persisted, not dropped');
    assert.strictEqual(findingsFor(store, 'prb_hook').length, 4, 'four rows in the tab');

    // Frozen now — a second call must not re-diagnose or re-write anything.
    const secondRun = await recomputeProbeObservation(repo, 'prb_hook');
    assert.strictEqual(findingsFor(store, 'prb_hook').length, 4, 'a second recompute leaves exactly the same four rows');
    assert.strictEqual(secondRun.frozen, true, 'because the probe is frozen');

    // And the batch rebuild, run over the same workbook, adds nothing.
    await runRebuildPass(repo, { maxAiCalls: 50 });
    assert.strictEqual(findingsFor(store, 'prb_hook').length, 4, 'and the full rebuild pass adds no second copy either');
    const keys = findingsFor(store, 'prb_hook').map((f) => f.finding_index);
    assert.strictEqual(new Set(keys).size, 4, 'still one row per finding_index');
    ok('the single-probe recompute path persists findings through the same writer, and neither a repeat call nor a later full rebuild duplicates them');
  }

  // ── 5. No batch ever writes the same range twice ──────────────────────────
  {
    diagnoseCalls = 0;
    const { store, repo, writtenRanges } = makeFakeSheet();
    __setRepoForTests(repo);
    installAi({ 'Range Road': stubFindings(4, 'Range Road') });

    seedProbe(store, 'prb_range', { address: 'Range Road' });
    store.INTELLIGENCE.push(intelligenceRow('prb_range'));
    store.INTELLIGENCE.push(intelligenceRow('prb_range '));

    await runRebuildPass(repo, { maxAiCalls: 50 });

    for (const batch of writtenRanges) {
      assert.strictEqual(new Set(batch).size, batch.length,
        `a single batchUpdate wrote the same range twice: ${batch.filter((r, i) => batch.indexOf(r) !== i).join(', ')}`);
    }
    ok('no batched write ever contains two instructions for the same row — contradictory writes cannot reach the sheet');
  }

  // ── 6. A batched rebuild is still one rebuild ─────────────────────────────
  // The Apps Script button calls the endpoint repeatedly until complete, each
  // call bounded to a small AI budget. That is one rebuild from the user's
  // side, and it must land on exactly one row per finding too.
  {
    diagnoseCalls = 0; personaliseCalls = 0;
    const { store, repo } = makeFakeSheet();
    __setRepoForTests(repo);
    const tags = ['Batch One', 'Batch Two', 'Batch Three', 'Batch Four'];
    installAi(Object.fromEntries(tags.map((t) => [t, stubFindings(4, t)])));

    tags.forEach((address, i) => {
      const probeId = `prb_b${i}`;
      seedProbe(store, probeId, { address });
      store.INTELLIGENCE.push(intelligenceRow(probeId));
      store.INTELLIGENCE.push(intelligenceRow(`${probeId} `));
    });

    let complete = false;
    let batches = 0;
    while (!complete && batches < 25) {
      const summary = await runRebuildPass(repo, { maxAiCalls: 2 });
      complete = summary.complete;
      batches += 1;
    }
    assert.ok(complete, `the batched rebuild finished (in ${batches} batches)`);

    const all = dataRows(store, 'DIAGNOSIS_FINDINGS', DIAGNOSIS_FINDINGS_HEADER);
    assert.strictEqual(all.length, 16, 'four probes x four findings = sixteen rows across the whole batched run');
    const keys = all.map((f) => `${String(f.probe_id).trim()}#${f.finding_index}`);
    assert.strictEqual(new Set(keys).size, keys.length, 'every (probe_id, finding_index) still appears exactly once');
    assert.strictEqual(dataRows(store, 'DIAGNOSIS', DIAGNOSIS_HEADER).length, 4, 'one DIAGNOSIS row per probe');
    assert.strictEqual(dataRows(store, 'PERSONALISATION', PERSONALISATION_HEADER).length, 4, 'one PERSONALISATION row per probe');
    assert.strictEqual(diagnoseCalls, 4, 'one diagnosis AI call per probe across the whole run');
    assert.strictEqual(personaliseCalls, 4, 'and one personalisation AI call per probe');
    ok('a rebuild spread across several bounded invocations — one click of the button — still lands on exactly one row per finding');
  }

  console.log(`\n${passed} checks passed.`);
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
