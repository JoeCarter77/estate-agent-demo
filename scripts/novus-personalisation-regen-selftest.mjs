// scripts/novus-personalisation-regen-selftest.mjs — hermetic test (no
// network, no creds) for the exact production state that failed:
//
//   finalised INTELLIGENCE + finalised DIAGNOSIS + DIAGNOSIS_FINDINGS rows
//   present, PERSONALISATION row ABSENT, DEMOS row ABSENT, run as a TARGETED
//   { probe_ids: [...] } rebuild.
//
// WHY THIS EXISTS. Five probes had their PERSONALISATION and DEMOS rows
// deleted and were handed straight back to POST /api/novus/intelligence/
// rebuild-all as probe_ids. Nothing regenerated, and the summary read as if
// nothing had even been attempted:
//
//   personalisations_with_findings=5   ai_personalisations_run=0
//   personalisation_created=0          remaining_personalisations=0
//   demos_compiled=0                   complete=true
//
// ROOT CAUSE, reproduced below in check 1. Every one of the five got a first
// AI answer whose prose failed one gate, which is the ordinary case the
// BOUNDED CORRECTION exists for. The correction call is attempt 2 of 2, so an
// error raised by the correction call ITSELF — the wire's required-field
// contract in lib/ai-structured-output.mjs, or any transport failure — was
// rethrown out of personaliseProbe() with `attempt === MAX`, discarding the
// complete, gated attempt-1 candidate that was already in hand. The probe was
// recorded in `problems` with no row written, so it also had no demo; and
// because ai_personalisations_run is only incremented on the RETURN path, the
// two calls each probe had just spent were reported as zero.
//
// Hermetic self-tests could not see any of it: lib/ai-client.mjs's injected
// fake deliberately runs with requireComplete:false, so a fixture's tool
// result is never held to the completeness contract a real response is.
//
// This suite proves:
//   1. a failed CORRECTION no longer costs the probe its row — the same
//      soft-fallback answer a correction that came back and still missed
//      would have persisted is persisted here too
//   2. all five targeted probes regenerate PERSONALISATION and all five DEMOS
//      compile in the same pass
//   3. the counters report what actually happened, AI calls included
//   4. unrelated probes are left byte-identical
//   5. a steady-state rerun is idempotent: no AI, no writes, no duplicates
//   6. a probe whose FIRST answer is unusable still fails loudly — no row, a
//      problem recorded, and no counter inflated by the attempt
//
// Run: npm run novus:personalisation-regen-selftest

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';
import { AiStructuredOutputError } from '../lib/ai-structured-output.mjs';
import { runRebuildPass } from '../lib/rebuild-pass.mjs';
import { DEMOS_HEADER } from '../lib/demos.mjs';

const PROBES_HEADER = [
  'agency_id', 'probe_id', 'probe_reference', 'portal', 'property_address', 'property_url',
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
  'probe_id', 'probe_ref', 'agency_id', 'observation_status', 'human_contact',
  'response_hours', 'first_human_response_at', 'contact_attempts', 'follow_ups',
  'channels_used', 'viewing_progression', 'buyer_qualification', 'buyer_questions_asked',
  'seller_recognition', 'communication_quality', 'did_well', 'missed', 'evidence',
  'grade', 'grade_reason',
];
const DIAGNOSIS_HEADER = [
  'probe_id', 'probe_ref', 'agency_id', 'strengths', 'missed_opportunities',
  'commercial_implication', 'novus_opportunity', 'diagnosis_summary',
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

// The five probes handed to the endpoint, and two the request never named —
// already personalised, already compiled, and required to come out untouched.
const TARGETS = ['prb_hist_0004', 'prb_hist_0005', 'prb_hist_0020', 'prb_hist_0021', 'prb_hist_0022'];
const UNRELATED = ['prb_hist_0001', 'prb_hist_0002'];
const OLD = '2020-01-01T09:00:00.000Z';

function row(header, obj) { return header.map((k) => obj[k] ?? ''); }
function toObj(header, r) { return Object.fromEntries(header.map((k, i) => [k, r[i] ?? ''])); }
function rowsOf(store, tab, header) {
  const idIdx = header.indexOf('probe_id');
  return store[tab].slice(1)
    .filter((r) => r[idIdx] && r[idIdx] !== 'SCHEMA NOTE')
    .map((r) => toObj(header, r));
}
function byProbe(store, tab, header) {
  return new Map(rowsOf(store, tab, header).map((r) => [r.probe_id, r]));
}

function makeFakeSheet() {
  const store = {
    PROBES: [PROBES_HEADER.slice(), row(PROBES_HEADER, { probe_id: 'SCHEMA NOTE' })],
    COMMUNICATIONS: [COMMUNICATIONS_HEADER.slice(), row(COMMUNICATIONS_HEADER, { communication_id: 'SCHEMA NOTE' })],
    INTELLIGENCE: [INTELLIGENCE_HEADER.slice()],
    DIAGNOSIS: [DIAGNOSIS_HEADER.slice()],
    DIAGNOSIS_FINDINGS: [DIAGNOSIS_FINDINGS_HEADER.slice()],
    PERSONALISATION: [PERSONALISATION_HEADER.slice()],
    DEMOS: [DEMOS_HEADER.slice(), row(DEMOS_HEADER, { demo_slug: 'SCHEMA NOTE' })],
    AGENCIES: [AGENCIES_HEADER.slice(), row(AGENCIES_HEADER, { agency_id: 'SCHEMA NOTE' })],
  };
  const tabOf = (range) => String(range).split('!')[0];
  const startRowOf = (range) => {
    const m = String(range).match(/!\D+(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  };
  const valuesApi = {
    async get(range) {
      const tab = tabOf(range);
      if (!(tab in store)) throw new Error(`Sheets API GET ${tab} failed (400): Unable to parse range`);
      return store[tab].map((r) => r.slice());
    },
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
        while (store[tab].length < start - 1) store[tab].push([]);
        values.forEach((r, i) => { store[tab][start - 1 + i] = r.slice(); });
      }
    },
  };
  return { store, repo: createRepo(valuesApi) };
}

// A probe frozen exactly as the live historical ones are: closed, finalised
// Intelligence, finalised Diagnosis (non-blank diagnosis_summary) and its own
// DIAGNOSIS_FINDINGS rows. withPersonalisation seeds the already-finished
// state — a complete PERSONALISATION row and its compiled DEMOS row.
function seed(store, ids, { withPersonalisation }) {
  for (const probeId of ids) {
    store.PROBES.push(row(PROBES_HEADER, {
      agency_id: `agc_${probeId}`, probe_id: probeId, probe_reference: probeId.toUpperCase(),
      // No property_url: the demo compile then settles the hero image as
      // 'none' rather than 'pending', so the idempotency check below measures
      // this pass, not the image budget's own retry.
      property_address: `${probeId} Street`,
      property_price: '£300,000', probe_timestamp: OLD,
      observation_deadline: '2020-01-05T09:00:00.000Z', probe_status: 'closed',
    }));
    store.AGENCIES.push(row(AGENCIES_HEADER, { agency_id: `agc_${probeId}`, agency_name: `Agency ${probeId}` }));
    store.INTELLIGENCE.push(row(INTELLIGENCE_HEADER, {
      probe_id: probeId, agency_id: `agc_${probeId}`, observation_status: 'closed',
      human_contact: 'yes', response_hours: 5, contact_attempts: 1, follow_ups: 0,
      channels_used: 'email', viewing_progression: 'none', communication_quality: 'generic', grade: 'D',
      grade_reason: 'Pre-seeded.',
    }));
    store.DIAGNOSIS.push(row(DIAGNOSIS_HEADER, {
      probe_id: probeId, agency_id: `agc_${probeId}`, strengths: 'Pre-existing strength.',
      novus_opportunity: 'Core (front desk)', diagnosis_summary: `Pre-existing diagnosis for ${probeId}.`,
    }));
    store.DIAGNOSIS_FINDINGS.push(row(DIAGNOSIS_FINDINGS_HEADER, {
      probe_id: probeId, finding_index: 1, finding_type: 'problem',
      finding: 'The buyer enquiry was not progressed to a viewing invitation.',
      evidence: 'Viewing progression was recorded as none.',
      significance_note: 'The buyer enquiry had no concrete next step.',
    }));
    store.DIAGNOSIS_FINDINGS.push(row(DIAGNOSIS_FINDINGS_HEADER, {
      probe_id: probeId, finding_index: 2, finding_type: 'positive',
      finding: 'They did come back on the enquiry.',
      evidence: 'A human replied within five hours.',
      significance_note: 'The enquiry was picked up.',
    }));
    if (withPersonalisation) {
      store.PERSONALISATION.push(row(PERSONALISATION_HEADER, {
        personalisation_id: `psn_${probeId}`, agency_id: `agc_${probeId}`, probe_id: probeId,
        hero_journey: 'slow_response_gap', primary_narrative: 'Existing narrative.',
        fair_observation: 'you did come back to us.',
        main_finding: 'that nobody asked what we were looking for.',
        commercial_consequence: 'the buyer stayed anonymous.',
        email_observation: 'Existing observation.',
        email_commercial_hook: 'Existing hook.',
        email_commercial_hook_email_2: 'Existing second hook.',
        created_at: OLD, updated_at: OLD,
      }));
      store.DEMOS.push(row(DEMOS_HEADER, {
        demo_id: `dmo_${probeId}`, demo_slug: `slug-${probeId}`, demo_status: 'ready',
        agency_id: `agc_${probeId}`, probe_id: probeId, personalisation_id: `psn_${probeId}`,
        created_at: OLD, updated_at: OLD,
      }));
    }
  }
}

// The answer a real first call produces for these probes: a complete,
// well-formed result whose HOOK merely restates the observation — the ordinary
// soft rejection the bounded correction exists for.
const FIRST_ANSWER = {
  story_reasoning: 'Stub reasoning.',
  primary_narrative: 'Stub narrative.',
  supporting_findings: '',
  positive_finding_index: 2,
  main_finding_index: 1,
  wider_finding_index: null,
  fair_observation: 'you did come back to us.',
  novus_counterfactual: 'Stub counterfactual.',
  main_finding: 'that nobody asked what we were looking for.',
  commercial_consequence: 'stub consequence.',
  email_observation: 'You did come back to us, but nobody asked what we were looking for.',
  // Deliberately the observation again — a SOFT rejection, so the probe goes
  // to the bounded correction with a usable candidate already banked.
  email_commercial_hook: 'You did come back to us, but nobody asked what we were looking for.',
  email_commercial_hook_email_2: 'The reply itself was fine — the part worth a look is that you still know nothing about what we were actually after.',
};

// correctionFails: the correction call raises exactly what the wire raises
// when the model's patch does not satisfy the tool's required-field contract
// (lib/ai-structured-output.mjs). firstAnswerFails: the FIRST call is the one
// that never produces a usable record.
function installAiStub({ correctionFails = false, firstAnswerFails = false } = {}) {
  let personaliseCalls = 0;
  let correctionCalls = 0;
  __setAiCallerForTests(async ({ tool, prompt }) => {
    if (tool?.name === 'realise_personalisation_facts') {
      personaliseCalls += 1;
      if (firstAnswerFails) {
        throw new AiStructuredOutputError('Model response hit max_tokens before the tool result was complete', {
          truncated: true, missing: ['email_commercial_hook_email_2'],
        });
      }
      if (personaliseCalls % 2 === 1) {
        return {
          email_observation: 'After I replied, you called three times about a new seller instruction.',
          email_commercial_hook: 'That caused a sale.',
          email_commercial_hook_email_2: 'Every branch lost £20,000.',
        };
      }
      const line = (label) => {
        const value = prompt.match(new RegExp(`^${label}: (.*)$`, 'm'))?.[1] || '';
        return value.startsWith('(empty because') ? '' : value;
      };
      return {
        email_observation: line('Observation'),
        email_commercial_hook: line('Commercial hook'),
        email_commercial_hook_email_2: line('Hook 2'),
      };
    }
    if (tool?.name === 'correct_probe_personalisation_fields') {
      correctionCalls += 1;
      if (correctionFails) {
        throw new AiStructuredOutputError(
          `Tool result is missing required fields: ${tool.input_schema.required.join(', ')}`,
          { truncated: false, missing: tool.input_schema.required },
        );
      }
      return Object.fromEntries(tool.input_schema.required.map((field) => [
        field,
        field === 'email_commercial_hook'
          ? 'So a buyer already in front of you stayed a name in the inbox rather than someone you knew anything about.'
          : 'a corrected line.',
      ]));
    }
    if (tool?.name === 'record_probe_personalisation') {
      personaliseCalls += 1;
      if (firstAnswerFails) {
        throw new AiStructuredOutputError('Model response hit max_tokens before the tool result was complete', {
          truncated: true, missing: ['email_commercial_hook_email_2'],
        });
      }
      return FIRST_ANSWER;
    }
    throw new Error(`unexpected AI tool: ${tool?.name}`);
  });
  return { counts: () => ({ personaliseCalls, correctionCalls }) };
}

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

async function run() {
  console.log('targeted PERSONALISATION/DEMOS regeneration — hermetic selftest\n');

  // ── 1-4. The reported state, run exactly as the endpoint runs it ──
  {
    const { store, repo } = makeFakeSheet();
    __setRepoForTests(repo);
    // The five: everything upstream intact, PERSONALISATION and DEMOS rows
    // deleted. The other two: already finished, and never named in the request.
    seed(store, TARGETS, { withPersonalisation: false });
    seed(store, UNRELATED, { withPersonalisation: true });
    const unrelatedRows = () => JSON.stringify([
      ...store.PERSONALISATION.filter((r) => UNRELATED.includes(r[PERSONALISATION_HEADER.indexOf('probe_id')])),
      ...store.DEMOS.filter((r) => UNRELATED.includes(r[DEMOS_HEADER.indexOf('probe_id')])),
    ]);
    const untouchedBefore = unrelatedRows();

    const stub = installAiStub();
    const summary = await runRebuildPass(repo, {
      maxAiCalls: 15, probeIds: TARGETS,
    });

    assert.strictEqual(stub.counts().personaliseCalls, TARGETS.length * 2,
      'every target reaches the fact-constrained validator and its one bounded facts-only correction');
    assert.deepStrictEqual(summary.personalisation.problems, [], 'a failed correction is not a failed probe');
    assert.strictEqual(summary.personalisation.personalisation_created, TARGETS.length,
      'all five eligible targeted probes regenerate PERSONALISATION');
    assert.deepStrictEqual(new Set(summary.personalisation.personalised_probe_ids), new Set(TARGETS));

    const personalised = byProbe(store, 'PERSONALISATION', PERSONALISATION_HEADER);
    for (const probeId of TARGETS) {
      const written = personalised.get(probeId);
      assert.ok(written, `${probeId} has a PERSONALISATION row`);
      assert.ok(String(written.primary_narrative).trim(), `${probeId} has the finalised signal set`);
      assert.ok(String(written.email_commercial_hook).trim(),
        `${probeId} persists a supplied deterministic consequence`);
      assert.ok(String(written.email_observation).trim(), `${probeId} keeps its email observation`);
    }
    ok('all targeted fact-complete probes reject invented first drafts and regenerate complete constrained PERSONALISATION rows');

    // 2. The demos.
    assert.strictEqual(summary.demos.demos_created, TARGETS.length, 'the five DEMOS compile in the same pass');
    const demoProbeIds = new Set(store.DEMOS.slice(1)
      .map((r) => r[DEMOS_HEADER.indexOf('probe_id')]).filter(Boolean));
    for (const probeId of TARGETS) assert.ok(demoProbeIds.has(probeId), `${probeId} has a DEMOS row`);
    ok('PERSONALISATION completing compiles the five DEMOS rows in the same invocation');

    // 3. The counters report the constrained calls actually spent.
    const p = summary.personalisation;
    assert.strictEqual(p.ai_personalisations_run, stub.counts().personaliseCalls + stub.counts().correctionCalls,
      'ai_personalisations_run reports every AI call actually spent, correction calls included');
    assert.strictEqual(p.personalisations_processed, TARGETS.length);
    assert.strictEqual(p.personalisations_with_findings, TARGETS.length,
      'personalisations_with_findings counts probes personalised WITH findings, not probes that merely reached the attempt');
    assert.strictEqual(p.personalisation_updated, 0);
    assert.strictEqual(p.remaining_personalisations, 0);
    assert.strictEqual(p.skipped_not_diagnosed, 0);
    assert.strictEqual(summary.probes_finalized_skipped, TARGETS.length,
      'the frozen five are still never re-interpreted or re-diagnosed');
    assert.strictEqual(summary.diagnosis.ai_diagnoses_run, 0, 'no Diagnosis is regenerated');
    assert.strictEqual(summary.complete, true);
    ok('the counters describe what happened — AI calls spent, probes written, nothing left remaining');

    // 4. Unrelated probes.
    assert.strictEqual(unrelatedRows(), untouchedBefore,
      'every PERSONALISATION and DEMOS row belonging to a probe the request never named is byte-identical');
    ok('the probes the request never named are left byte-identical — no AI spent, no row rewritten');

    // 5. Steady state: rerunning the same request changes nothing.
    const beforeRerun = JSON.stringify(store);
    const callsBefore = stub.counts();
    const second = await runRebuildPass(repo, {
      maxAiCalls: 15, probeIds: TARGETS,
    });
    assert.strictEqual(second.personalisation.ai_personalisations_run, 0, 'no AI on a steady-state rerun');
    assert.strictEqual(second.personalisation.personalisations_processed, 0, 'nothing is rewritten');
    assert.strictEqual(second.personalisation.personalisations_with_findings, 0,
      'and no counter reports work that did not happen');
    assert.strictEqual(second.demos.demos_compiled, 0, 'no demo is recompiled');
    assert.deepStrictEqual(stub.counts(), callsBefore, 'not one further AI call');
    assert.strictEqual(JSON.stringify(store), beforeRerun, 'the whole workbook is byte-identical after the rerun');
    ok('the targeted rebuild is idempotent in steady state — one row per probe, no duplicates, no AI');
  }

  // ── 6. The half-record rule is unchanged ──
  //    A FIRST answer that never produced a usable record still fails loudly:
  //    no row (so the next pass retries it), a problem recorded, and no
  //    counter inflated by the attempt.
  {
    const { store, repo } = makeFakeSheet();
    __setRepoForTests(repo);
    seed(store, TARGETS.slice(0, 1), { withPersonalisation: false });
    const stub = installAiStub({ firstAnswerFails: true });

    const summary = await runRebuildPass(repo, {
      maxAiCalls: 15, probeIds: TARGETS.slice(0, 1),
    });

    assert.strictEqual(stub.counts().personaliseCalls, 1, 'a transport-level failure stops before any candidate can be persisted');
    assert.strictEqual(summary.personalisation.personalisation_created, 0, 'no half row is persisted');
    assert.strictEqual(summary.personalisation.problems.length, 1, 'the probe is reported as a problem');
    assert.strictEqual(summary.personalisation.personalisations_with_findings, 0,
      'and the summary never claims a personalisation that did not happen');
    assert.strictEqual(rowsOf(store, 'PERSONALISATION', PERSONALISATION_HEADER).length, 0);
    ok('a probe whose first answer is truncated or unusable still fails loudly with no row written — the retry-next-pass rule is unchanged');
  }

  console.log(`\n${passed} checks passed.`);
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
