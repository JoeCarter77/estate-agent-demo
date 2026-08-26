// scripts/novus-probe-id-whitespace-selftest.mjs — regression test for the
// duplicate-row bug reported after the first live 3-probe test: each of the
// three targeted probes ended up with TWO PERSONALISATION rows even though
// only one row's worth of AI work should ever be needed for a probe whose
// Diagnosis is frozen.
//
// Root cause: lib/intelligence-rebuild.mjs, lib/diagnosis-rebuild.mjs,
// lib/personalisation-rebuild.mjs and lib/diagnosis-findings.mjs each keyed
// their upsert-by-probe_id lookups off the RAW cell value read from the
// sheet, with no trimming. A probe_id cell carrying a stray leading or
// trailing space — easy to introduce by hand-typing or copy-pasting into a
// Google Sheet, and invisible when just looking at the cell — reads back as
// a value that never equal()s the clean probe_id the rest of the pipeline
// uses to look an existing row up. The lookup misses, the row reads back as
// "doesn't exist yet", and a second, genuinely duplicate row gets appended
// instead of the existing one being updated in place.
//
// This suite plants a DIAGNOSIS row and a PERSONALISATION row exactly as an
// earlier, otherwise-successful rebuild would have left them — except the
// PERSONALISATION row's own probe_id cell carries a trailing space, as
// happens from ordinary hand-editing a sheet — and proves that running the
// pipeline again finds and updates that existing row instead of creating a
// second one.
//
// Run: npm run novus:probe-id-whitespace-selftest

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';
import { runRebuildPass } from '../lib/rebuild-pass.mjs';

const PROBES_HEADER = [
  'probe_id', 'probe_reference', 'agency_id', 'portal', 'property_address', 'property_url',
  'property_price', 'property_status', 'enquiry_text', 'probe_email', 'probe_phone',
  'probe_timestamp', 'observation_deadline', 'probe_status', 'compromised', 'compromise_reason',
  'observation_closed_at', 'sent_from', 'observation_notes', 'created_at', 'updated_at',
];
const COMMUNICATIONS_HEADER = [
  'communication_id', 'agency_id', 'probe_id', 'occurred_at', 'channel', 'direction',
  'source_identifier_normalized', 'subject', 'body_text', 'transcript', 'raw_content',
  'match_status', 'automated_or_human', 'manual_override', 'created_at', 'updated_at',
];
const INTELLIGENCE_HEADER = [
  'intelligence_id', 'agency_id', 'probe_id', 'observation_status', 'observation_deadline',
  'observation_closed_at', 'human_contact', 'response_hours', 'first_human_response_at',
  'contact_attempts', 'follow_ups', 'channels_used',
  'viewing_progression', 'buyer_qualification', 'buyer_questions_asked', 'seller_recognition',
  'communication_quality', 'did_well', 'missed', 'evidence',
  'grade', 'grade_reason', 'created_at', 'updated_at',
];
const DIAGNOSIS_HEADER = [
  'diagnosis_id', 'agency_id', 'probe_id',
  'strengths', 'missed_opportunities', 'commercial_implication', 'novus_opportunity',
  'diagnosis_summary', 'created_at', 'updated_at',
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

function makeFakeSheet() {
  const store = {
    PROBES: [PROBES_HEADER.slice(), ['SCHEMA NOTE', 'Fixture']],
    COMMUNICATIONS: [COMMUNICATIONS_HEADER.slice(), ['SCHEMA NOTE', 'Fixture']],
    INTELLIGENCE: [INTELLIGENCE_HEADER.slice(), ['SCHEMA NOTE', 'Fixture']],
    DIAGNOSIS: [DIAGNOSIS_HEADER.slice(), ['SCHEMA NOTE', 'Fixture']],
    DIAGNOSIS_FINDINGS: [DIAGNOSIS_FINDINGS_HEADER.slice()],
    PERSONALISATION: [PERSONALISATION_HEADER.slice()],
    AGENCIES: [AGENCIES_HEADER.slice(), ['agc_1', 'Test Agency']],
  };
  function tabOf(range) { return String(range).split('!')[0]; }
  function startRowOf(range) {
    const m = String(range).match(/!\D+(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }
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
      for (const { range, values } of data) {
        const tab = tabOf(range); const start = startRowOf(range);
        store[tab] = store[tab] || [];
        values.forEach((row, i) => { store[tab][start - 1 + i] = row.slice(); });
      }
    },
  };
  return { store, repo: createRepo(valuesApi) };
}

function row(header, obj) { return header.map((k) => obj[k] ?? ''); }
function toObj(header, r) { return Object.fromEntries(header.map((k, i) => [k, r[i]])); }
function dataRows(store, tab, header) {
  return store[tab].slice(1)
    .filter((r) => r[0] && r[0] !== 'SCHEMA NOTE')
    .map((r) => toObj(header, r));
}

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

async function run() {
  console.log('probe_id whitespace regression (duplicate DIAGNOSIS/PERSONALISATION rows)\n');

  const { store, repo } = makeFakeSheet();
  __setRepoForTests(repo);

  const CLEAN_PROBE_ID = 'prb_hist_0003';
  // Exactly what hand-editing a sheet can leave behind: a trailing space on
  // the id cell of an existing row, invisible when just looking at the cell.
  const WHITESPACE_PROBE_ID = 'prb_hist_0003 ';

  // PROBES, COMMUNICATIONS and INTELLIGENCE are clean — the whitespace only
  // ever landed on the DIAGNOSIS/PERSONALISATION rows an earlier rebuild
  // already wrote, which is the realistic shape of the reported bug: the
  // rebuild clearly succeeded once (Personalisation generated real content
  // from the real communications), the corruption is only in the id cell of
  // the rows it wrote.
  store.PROBES.push(row(PROBES_HEADER, {
    probe_id: CLEAN_PROBE_ID, agency_id: 'agc_1', property_address: '14 Oak Road',
    property_price: '£425,000', enquiry_text: 'Enquiring about a viewing.',
    probe_timestamp: '2020-01-01T09:00:00.000Z', observation_deadline: '2020-01-05T09:00:00.000Z',
  }));
  store.COMMUNICATIONS.push(row(COMMUNICATIONS_HEADER, {
    communication_id: 'com_1', agency_id: 'agc_1', probe_id: CLEAN_PROBE_ID,
    occurred_at: '2020-01-01T12:00:00.000Z', channel: 'email',
    body_text: 'Give us a call back when you want to view.', match_status: 'matched',
    automated_or_human: 'human',
  }));
  // A probe that already has a finalised DIAGNOSIS must, by construction,
  // already have a finalised INTELLIGENCE row too (Diagnosis reads
  // Intelligence, never the other way round) — so the earlier rebuild left
  // one behind, clean, exactly as intelligence-rebuild.mjs itself would.
  store.INTELLIGENCE.push(row(INTELLIGENCE_HEADER, {
    intelligence_id: 'itl_existing', agency_id: 'agc_1', probe_id: CLEAN_PROBE_ID,
    observation_status: 'closed', human_contact: 'yes', response_hours: '3',
    contact_attempts: '1', follow_ups: '0', channels_used: 'email',
    communication_quality: 'generic', grade: 'D',
    created_at: '2020-01-06T00:00:00.000Z', updated_at: '2020-01-06T00:00:00.000Z',
  }));

  // An earlier, otherwise-successful rebuild's DIAGNOSIS row — finalised
  // (non-blank diagnosis_summary), frozen for good — carrying the whitespace.
  store.DIAGNOSIS.push(row(DIAGNOSIS_HEADER, {
    diagnosis_id: 'dgn_existing', agency_id: 'agc_1', probe_id: WHITESPACE_PROBE_ID,
    strengths: 'Replied the same day.', missed_opportunities: 'No qualifying question asked.',
    commercial_implication: 'A viewing slot went to an unqualified buyer.',
    novus_opportunity: 'Core (front desk)', diagnosis_summary: 'Fast but shallow handling.',
    created_at: '2020-01-06T00:00:00.000Z', updated_at: '2020-01-06T00:00:00.000Z',
  }));
  store.DIAGNOSIS_FINDINGS.push(row(DIAGNOSIS_FINDINGS_HEADER, {
    probe_id: WHITESPACE_PROBE_ID, finding_index: 1,
    finding: 'No qualifying question was asked before inviting a viewing.',
    evidence: 'Buyer qualification recorded as none.',
    significance_note: 'The viewing slot is committed to an unqualified buyer.',
  }));
  // And a legacy PERSONALISATION row whose old narrative is complete but whose
  // new Instantly variables do not exist yet. needsPersonalisation() must
  // backfill it once. The question this test also asks is whether regeneration
  // UPDATES this whitespace-tainted row or DUPLICATES it.
  store.PERSONALISATION.push(row(PERSONALISATION_HEADER, {
    personalisation_id: 'psn_existing', agency_id: 'agc_1', probe_id: WHITESPACE_PROBE_ID,
    hero_journey: 'fast_response_stalled_follow_up',
    primary_narrative: 'Legacy narrative from the previous email schema.',
    created_at: '2020-01-06T00:00:00.000Z', updated_at: '2020-01-06T00:00:00.000Z',
  }));

  __setAiCallerForTests(async ({ tool }) => {
    if (tool.name === 'record_probe_personalisation') {
      return {
        story_reasoning: 'Finding 1 is the selected story.',
        primary_narrative: 'You replied the same day but never asked a single qualifying question.',
        positive_finding_index: null, main_finding_index: 1, wider_finding_index: null,
        supporting_findings: '',
        fair_observation: 'You did reply the same day.',
        main_finding: 'There is no qualifying question asked before inviting you to view.',
        commercial_consequence: 'a viewing slot went to someone nobody had checked could buy.',
        email_observation: 'You replied the same day, but no qualifying question was asked before the viewing invitation.',
        // States the SHAPE rather than rewording the observation, so this
        // suite costs exactly the one personalisation call it asserts on.
        email_commercial_hook: 'So the buyer side moved forward, while the potential seller was missed entirely.',
        // Email 2's own job: the extra thing neither line above said.
        email_commercial_hook_email_2: 'Worth a second look: you invited me in without ever finding out whether I could actually buy the place.',
        novus_counterfactual: 'NOVUS would have asked budget and timescale on the first call.',
      };
    }
    return {
      viewing_progression: 'invited', buyer_questions_asked: [], seller_recognition: 'none',
      communication_quality: 'generic', did_well: 'Replied the same day.', missed: 'No qualifying question asked.', evidence: [],
    };
  });

  assert.strictEqual(dataRows(store, 'DIAGNOSIS', DIAGNOSIS_HEADER).length, 1, 'starting state: one DIAGNOSIS row, whitespace and all');
  assert.strictEqual(dataRows(store, 'PERSONALISATION', PERSONALISATION_HEADER).length, 1, 'starting state: one incomplete PERSONALISATION row, whitespace and all');

  const summary = await runRebuildPass(repo, { maxAiCalls: 10 });

  assert.strictEqual(summary.diagnosis.ai_diagnoses_run, 0, 'DIAGNOSIS is already finalised (frozen) — no AI call, whitespace or not');
  assert.strictEqual(summary.personalisation.ai_personalisations_run, 1, 'PERSONALISATION regenerates once to backfill its missing Instantly variables');
  assert.strictEqual(summary.personalisation.personalisation_created, 0, 'THE FIX: this is an UPDATE to the existing row...');
  assert.strictEqual(summary.personalisation.personalisation_updated, 1, '...not the creation of a new one');

  const diagRows = dataRows(store, 'DIAGNOSIS', DIAGNOSIS_HEADER);
  const personRows = dataRows(store, 'PERSONALISATION', PERSONALISATION_HEADER);
  assert.strictEqual(diagRows.length, 1, 'still exactly one DIAGNOSIS row — the bug produced two here');
  assert.strictEqual(personRows.length, 1, 'still exactly one PERSONALISATION row — the bug produced two here');
  ok('a PERSONALISATION row whose probe_id cell carries a stray trailing space is found and updated in place, not duplicated');

  const personRow = personRows[0];
  assert.strictEqual(personRow.personalisation_id, 'psn_existing', 'the SAME row was updated, not replaced with a new id');
  assert.ok(personRow.primary_narrative, 'primary_narrative is now populated');
  assert.ok(personRow.main_finding, 'main_finding is populated');
  assert.ok(personRow.property_reference, 'the deterministic property reference is populated');
  assert.ok(personRow.email_observation, 'the Instantly observation variable is populated');
  assert.ok(personRow.email_commercial_hook, 'the Instantly commercial hook is populated');
  assert.ok(personRow.email_commercial_hook_email_2, 'and so is the Email 2 hook the row was missing');
  ok('the existing row is fully populated after the fix — not left blank, not duplicated alongside a second, complete row');

  console.log(`\n${passed} checks passed.`);
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
