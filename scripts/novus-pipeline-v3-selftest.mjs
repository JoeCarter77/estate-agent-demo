// scripts/novus-pipeline-v3-selftest.mjs — hermetic regression suite (no
// network, no creds) for the simplified acquisition pipeline:
//
//   PROBE + COMMUNICATIONS
//     -> deterministic observation                 (no AI)
//     -> ONE final commercial assessment at close  (the only AI call)
//     -> deterministic personalised copy + demo    (no AI)
//     -> OUTBOUND -> Instantly
//
// What it proves, in order:
//   1.  an OBSERVING probe causes ZERO AI calls of any kind
//   2.  an expired, closed probe costs AT MOST ONE new AI assessment, and the
//       next run costs none (frozen)
//   3.  normal Personalisation uses ZERO AI calls
//   4.  deterministic downstream work proceeds with maxAiCalls = 0 — an AI
//       backlog can never starve Personalisation, DEMOS or OUTBOUND
//   5.  a diagnosed historical backlog reaches PERSONALISATION + DEMO +
//       OUTBOUND with zero AI calls, and repeated rebuilds converge
//   6.  an existing frozen personalisation is never regenerated
//   7.  a blank property_street with a valid property_address does not block
//       OUTBOUND, and a nonblank historical property_street is preserved
//   8.  existing Instantly markers prevent a duplicate upload
//   9.  Sheets reads are bounded per invocation and do NOT grow with the
//       number of agencies
//   10. action reconciliation batches its writes instead of re-reading ACTIONS
//       per action
//   11. strong handling stays a valid outcome — no fake problem is invented
//   12. a seller declaration alone never becomes a valuation opportunity
//
// Run: npm run novus:pipeline-v3-selftest

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';
import { createSnapshotRepo } from '../lib/pipeline-snapshot.mjs';
import { runRebuildPass } from '../lib/rebuild-pass.mjs';
import { rebuildAllAssessments } from '../lib/assessment-rebuild.mjs';
import { isPersonalised } from '../lib/demo-compile.mjs';
import { uploadEligibleOutboundLeads } from '../lib/instantly-outbound.mjs';
import { reconcileActionEngine } from '../lib/action-engine.mjs';
import { sanitizeDiagnosisResult } from '../lib/probe-diagnosis.mjs';
import { _internal as assessmentInternal } from '../lib/probe-assessment.mjs';
import { DEMOS_HEADER } from '../lib/demos.mjs';
import { OUTBOUND_HEADER } from '../lib/outbound.mjs';
import { ACTIONS_HEADER } from '../lib/actions-store.mjs';

const PROBES_HEADER = [
  'agency_id', 'probe_id', 'probe_reference', 'portal', 'property_address', 'property_street',
  'property_url', 'property_price', 'property_status', 'enquiry_text', 'probe_email', 'probe_phone',
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
  'diagnosis_id', 'agency_id', 'probe_id', 'findings', 'enquiry_signals', 'unresolved_context',
  'recommended_actions', 'handling_summary', 'handling_quality',
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
  'enquiry_signals', 'unresolved_context', 'recommended_actions',
  'handling_summary', 'handling_quality', 'created_at', 'updated_at',
];
const AGENCIES_HEADER = [
  'agency_id', 'agency_name', 'clean_agency_name', 'outreach_contact_name',
  'outreach_contact_email', 'email_verification_status',
];
const REPLY_EVENTS_HEADER = ['reply_event_id', 'agency_id', 'outreach_id', 'classification', 'received_at', 'processed_at'];

const OLD = '2020-01-01T09:00:00.000Z';
const OLD_DEADLINE = '2020-01-05T09:00:00.000Z';

const row = (header, obj) => header.map((k) => obj[k] ?? '');
const toObj = (header, r) => Object.fromEntries(header.map((k, i) => [k, r[i] ?? '']));
function rowsOf(store, tab, header, idColumn = 'probe_id') {
  const idIdx = header.indexOf(idColumn);
  return store[tab].slice(1)
    .filter((r) => r[idIdx] && r[idIdx] !== 'SCHEMA NOTE')
    .map((r) => toObj(header, r));
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
    OUTBOUND: [OUTBOUND_HEADER.slice()],
    AGENCIES: [AGENCIES_HEADER.slice(), row(AGENCIES_HEADER, { agency_id: 'SCHEMA NOTE' })],
    ACTIONS: [ACTIONS_HEADER.slice()],
    REPLY_EVENTS: [REPLY_EVENTS_HEADER.slice()],
    SALES_MESSAGES: [['message_id', 'agency_id', 'message_type', 'sent_at', 'created_at']],
  };
  const counts = { get: 0, append: 0, update: 0, batchUpdate: 0, getByTab: {} };
  const tabOf = (range) => String(range).split('!')[0];
  const startRowOf = (range) => {
    const m = String(range).match(/!\D+(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  };
  // 'OUTBOUND!Q2:Q2' -> 16 (zero-based). A1-only ranges start at column A.
  const colIndexOf = (range) => {
    const m = String(range).match(/!([A-Z]+)\d+/);
    if (!m) return 0;
    let n = 0;
    for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  const valuesApi = {
    async get(range) {
      const tab = tabOf(range);
      counts.get += 1;
      counts.getByTab[tab] = (counts.getByTab[tab] || 0) + 1;
      if (!(tab in store)) throw new Error(`Sheets API GET ${tab} failed (400): Unable to parse range`);
      return store[tab].map((r) => r.slice());
    },
    async append(range, rows) {
      const tab = tabOf(range);
      counts.append += 1;
      store[tab] = store[tab] || [];
      for (const r of rows) store[tab].push(r.slice());
      return { updates: { updatedRows: rows.length } };
    },
    async update(range, rows) {
      const tab = tabOf(range); const start = startRowOf(range);
      counts.update += 1;
      store[tab] = store[tab] || [];
      while (store[tab].length < start - 1) store[tab].push([]);
      rows.forEach((r, i) => { store[tab][start - 1 + i] = r.slice(); });
    },
    // Column-aware, unlike the simpler fakes elsewhere: repo.writeCellsBatch
    // sends single-CELL ranges (e.g. 'OUTBOUND!Q2:Q2'), and a fake that
    // replaced the whole row with a one-element array would silently wipe every
    // other column — which is exactly what the Instantly marker path writes.
    async batchUpdate(data) {
      counts.batchUpdate += 1;
      for (const { range, values } of data) {
        const tab = tabOf(range);
        const start = startRowOf(range);
        const startCol = colIndexOf(range);
        store[tab] = store[tab] || [];
        while (store[tab].length < start - 1) store[tab].push([]);
        values.forEach((r, i) => {
          const target = (store[tab][start - 1 + i] || []).slice();
          r.forEach((value, j) => { target[startCol + j] = value; });
          store[tab][start - 1 + i] = target;
        });
      }
    },
  };
  return { store, repo: createRepo(valuesApi), counts };
}

// The one assessment answer. Deliberately shaped like a real one: a genuine
// problem, a genuine positive, and nothing invented.
function assessmentAnswer(overrides = {}) {
  return {
    viewing_progression: 'none',
    buyer_questions_asked: [],
    seller_recognition: 'none',
    findings: [{
      issue: 'The buyer enquiry was not progressed to a viewing invitation.',
      evidence: 'No viewing invitation, availability request or slot appears anywhere in the reply.',
    }],
    positive_findings: [{
      positive: 'The team came back on the enquiry the same day.',
      evidence: 'A human reply was recorded five hours after the enquiry.',
    }],
    enquiry_signals: [{ label: 'Viewing', value: 'Not progressed', context: 'No invitation or slot was offered.' }],
    unresolved_context: [{ question: 'When does the buyer want to move?', why_it_matters: 'It establishes urgency.' }],
    ...overrides,
  };
}

function installAi(answer = assessmentAnswer()) {
  const calls = { total: 0, byTool: {} };
  __setAiCallerForTests(async ({ tool }) => {
    calls.total += 1;
    calls.byTool[tool.name] = (calls.byTool[tool.name] || 0) + 1;
    if (tool.name === 'record_probe_assessment') return typeof answer === 'function' ? answer() : answer;
    throw new Error(`unexpected AI tool on the production path: ${tool.name}`);
  });
  return calls;
}

// A probe with an expired window and one human reply — closed on the next
// deterministic pass, and then eligible for exactly one assessment.
function seedClosedProbe(store, probeId, {
  agencyId = `agc_${probeId}`,
  propertyStreet = '',
  propertyAddress = `${probeId} Whitmore Way, Basildon, SS14`,
  enquiryText = 'Interested in a viewing. I also have a property to sell.',
} = {}) {
  store.PROBES.push(row(PROBES_HEADER, {
    agency_id: agencyId, probe_id: probeId, probe_reference: probeId.toUpperCase(),
    property_address: propertyAddress, property_street: propertyStreet,
    property_price: '£300,000', enquiry_text: enquiryText,
    probe_timestamp: OLD, observation_deadline: OLD_DEADLINE, probe_status: 'observing',
  }));
  store.COMMUNICATIONS.push(row(COMMUNICATIONS_HEADER, {
    communication_id: `com_${probeId}`, agency_id: agencyId, probe_id: probeId,
    occurred_at: '2020-01-01T14:00:00.000Z', channel: 'email',
    body_text: 'Thanks for your enquiry, we have received it.', match_status: 'matched',
  }));
  seedAgency(store, agencyId);
}

function seedAgency(store, agencyId) {
  if (rowsOf(store, 'AGENCIES', AGENCIES_HEADER, 'agency_id').some((a) => a.agency_id === agencyId)) return;
  store.AGENCIES.push(row(AGENCIES_HEADER, {
    agency_id: agencyId, agency_name: `Agency ${agencyId}`, clean_agency_name: `Agency ${agencyId}`,
    outreach_contact_name: 'Sam Taylor', outreach_contact_email: `${agencyId}@example.com`,
    email_verification_status: 'VALID',
  }));
}

// A historical probe already carrying a finalised assessment but nothing after
// it — the "diagnosed but not personalised" backlog shape.
function seedDiagnosedBacklogProbe(store, probeId, { propertyStreet = '', demoReady = false } = {}) {
  const agencyId = `agc_${probeId}`;
  store.PROBES.push(row(PROBES_HEADER, {
    agency_id: agencyId, probe_id: probeId, probe_reference: probeId.toUpperCase(),
    property_address: `${probeId} Whitmore Way, Basildon, SS14`, property_street: propertyStreet,
    property_price: '£300,000', enquiry_text: 'Interested in a viewing.',
    probe_timestamp: OLD, observation_deadline: OLD_DEADLINE, probe_status: 'closed',
  }));
  seedAgency(store, agencyId);
  store.INTELLIGENCE.push(row(INTELLIGENCE_HEADER, {
    intelligence_id: `itl_${probeId}`, agency_id: agencyId, probe_id: probeId,
    observation_status: 'closed', observation_deadline: OLD_DEADLINE, observation_closed_at: OLD_DEADLINE,
    human_contact: 'yes', response_hours: 5, contact_attempts: 1, follow_ups: 0, channels_used: 'email',
    viewing_progression: 'none', buyer_qualification: 'none', seller_recognition: '',
    communication_quality: 'generic', did_well: 'Replied the same day.', missed: 'No viewing offered.',
    grade: 'D', grade_reason: 'Pre-seeded.', created_at: OLD, updated_at: OLD,
  }));
  store.DIAGNOSIS.push(row(DIAGNOSIS_HEADER, {
    diagnosis_id: `dgn_${probeId}`, agency_id: agencyId, probe_id: probeId,
    findings: JSON.stringify([
      {
        finding_type: 'problem',
        finding: 'The buyer enquiry was not progressed to a viewing invitation.',
        evidence: 'No viewing invitation, availability request or slot appears anywhere in the reply.',
        significance_note: 'A live buyer enquiry ended without a next step.',
      },
      {
        finding_type: 'positive',
        finding: 'The team came back on the enquiry the same day.',
        evidence: 'A human reply was recorded five hours after the enquiry.',
        significance_note: 'The enquiry was picked up rather than ignored.',
      },
    ]),
    handling_summary: 'The team replied within five hours but offered no viewing.',
    handling_quality: 'mixed', novus_opportunity: 'Core (front desk)',
    diagnosis_summary: `Pre-existing assessment for ${probeId}.`,
    created_at: OLD, updated_at: OLD,
  }));
  if (demoReady) {
    store.DEMOS.push(row(DEMOS_HEADER, {
      demo_id: `dmo_${probeId}`, demo_slug: `slug-${probeId}`, demo_status: 'ready',
      demo_version: '', property_image_status: 'ok', property_image_url: 'https://img/x.jpg',
      enquiry_date: '1 January', enquiry_time: '09:00',
      agency_id: agencyId, probe_id: probeId, created_at: OLD, updated_at: OLD,
    }));
  }
  return agencyId;
}

let passed = 0;
const ok = (msg) => { passed += 1; console.log(`  ✓ ${msg}`); };

async function run() {
  console.log('simplified acquisition pipeline — hermetic regression suite\n');

  {
    const expected = [
      'viewing_progression', 'buyer_questions_asked', 'seller_recognition',
      'findings', 'positive_findings', 'enquiry_signals', 'unresolved_context',
    ];
    assert.deepStrictEqual(Object.keys(assessmentInternal.TOOL.input_schema.properties), expected);
    assert.deepStrictEqual(assessmentInternal.TOOL.input_schema.required, expected);
    const wireContract = `${assessmentInternal.SYSTEM_PROMPT}\n${JSON.stringify(assessmentInternal.TOOL.input_schema)}`;
    for (const retired of [
      'handling_quality', 'handling_summary', 'buyer_qualification', 'communication_quality',
      'did_well', 'missed_opportunities', 'commercial_implication', 'recommended_actions',
      'significance_note', 'novus_opportunity', 'diagnosis_summary', 'finding_type',
    ]) assert.ok(!wireContract.includes(retired), `${retired} is absent from the model contract`);
    assert.strictEqual(isPersonalised({ primary_narrative: 'legacy story', email_observation: '' }), true,
      'historical rows can still use the legacy finalisation marker');
    ok('the Anthropic assessment contract contains exactly the seven retained semantic fields');
  }

  // ── 1. An OBSERVING probe reaches no model at all ─────────────────────────
  {
    const { store, repo } = makeFakeSheet();
    __setRepoForTests(repo);
    const calls = installAi();
    // Deadline in the far future: the window is open.
    store.PROBES.push(row(PROBES_HEADER, {
      agency_id: 'agc_open', probe_id: 'prb_open', property_address: 'Open Road, Basildon',
      property_price: '£300,000', enquiry_text: 'Interested.',
      probe_timestamp: new Date().toISOString(),
      observation_deadline: new Date(Date.now() + 4 * 24 * 3600 * 1000).toISOString(),
      probe_status: 'observing',
    }));
    seedAgency(store, 'agc_open');
    store.COMMUNICATIONS.push(row(COMMUNICATIONS_HEADER, {
      communication_id: 'com_open', agency_id: 'agc_open', probe_id: 'prb_open',
      occurred_at: new Date().toISOString(), channel: 'email',
      body_text: 'Thanks for your enquiry.', match_status: 'matched',
    }));

    const summary = await runRebuildPass(repo, { maxAiCalls: 50, rebuildOutbound: true });
    assert.strictEqual(calls.total, 0, 'an observing probe costs ZERO Anthropic calls');
    assert.strictEqual(summary.ai_calls_used, 0);
    assert.strictEqual(summary.probes_observing, 1, 'and it is reported as observing, not as remaining work');
    assert.strictEqual(summary.assessments_remaining, 0, 'an open window is not a backlog');
    assert.strictEqual(rowsOf(store, 'DIAGNOSIS', DIAGNOSIS_HEADER).length, 0, 'and no assessment row is written');
    ok('an observing probe causes zero final-assessment AI calls and is reported separately from real backlog');
  }

  // ── 2 + 3. An expired closed probe costs exactly ONE call, for everything ──
  {
    const { store, repo } = makeFakeSheet();
    __setRepoForTests(repo);
    const calls = installAi();
    seedClosedProbe(store, 'prb_close');

    const first = await runRebuildPass(repo, { maxAiCalls: 50, rebuildOutbound: true });
    assert.strictEqual(calls.total, 1, 'ONE Anthropic call for the whole probe — interpretation and assessment together');
    assert.deepStrictEqual(Object.keys(calls.byTool), ['record_probe_assessment'],
      'and it is the merged assessment tool, not a chain of per-stage tools');
    assert.strictEqual(first.ai_calls_used, 1);
    assert.strictEqual(first.personalisation.ai_personalisations_run, 0, 'Personalisation spends nothing');
    ok('an expired closed probe requires at most ONE new AI assessment, and normal Personalisation uses zero AI calls');

    // The assessment wrote BOTH halves.
    const intel = rowsOf(store, 'INTELLIGENCE', INTELLIGENCE_HEADER)[0];
    assert.strictEqual(intel.observation_status, 'closed', 'the window closed deterministically');
    assert.ok(intel.grade, 'and the unchanged A-H grade was computed without a model');
    assert.strictEqual(intel.viewing_progression, 'none', 'the retained semantic INTELLIGENCE fields came from the same one call');
    assert.strictEqual(intel.communication_quality, '', 'retired INTELLIGENCE compatibility fields are not populated for new rows');
    const diag = rowsOf(store, 'DIAGNOSIS', DIAGNOSIS_HEADER)[0];
    assert.strictEqual(diag.diagnosis_summary, 'assessed', 'completion is a deterministic sentinel');
    for (const field of ['strengths', 'missed_opportunities', 'commercial_implication', 'recommended_actions']) {
      assert.strictEqual(diag[field], '', `${field} remains a blank compatibility column on new rows`);
    }
    assert.strictEqual(JSON.parse(diag.findings).length, 2, 'the canonical structured findings record is on the DIAGNOSIS row');
    assert.strictEqual(rowsOf(store, 'DIAGNOSIS_FINDINGS', DIAGNOSIS_FINDINGS_HEADER).length, 2,
      'and the granular tab is still written as the audit projection');
    const person = rowsOf(store, 'PERSONALISATION', PERSONALISATION_HEADER)[0];
    for (const field of ['primary_narrative', 'property_reference', 'narrative_finding_indexes', 'positive_finding_index', 'main_finding_index', 'wider_finding_index', 'supporting_findings', 'evidence', 'novus_counterfactual', 'recommended_actions']) {
      assert.strictEqual(person[field], '', `${field} remains unwritten for new personalisation rows`);
    }
    assert.ok(person.commercial_consequence, 'the live commercial consequence remains deterministically populated');
    assert.match(person.enquiry_signals, /Viewing/, 'enquiry signals survive into Personalisation');
    assert.match(person.unresolved_context, /urgency/, 'unresolved context survives into Personalisation');
    ok('one call writes the semantic INTELLIGENCE fields, the DIAGNOSIS row, its canonical findings record and the audit projection');

    const second = await runRebuildPass(repo, { maxAiCalls: 50, rebuildOutbound: true });
    assert.strictEqual(calls.total, 1, 'a second run spends nothing — the assessment is frozen');
    assert.strictEqual(second.assessments_created, 0);
    assert.strictEqual(second.personalisation.personalisation_created, 0, 'and the personalisation is frozen too');
    ok('a frozen probe is never reassessed or re-personalised, however often the rebuild runs');
  }

  // ── 4 + 5. maxAiCalls = 0 still drains everything deterministic ───────────
  {
    const { store, repo } = makeFakeSheet();
    __setRepoForTests(repo);
    const calls = installAi();
    // Six probes already assessed but with nothing after them, plus one closed
    // probe that WOULD need an assessment — the exact production shape where an
    // AI backlog used to freeze everything behind it.
    const backlog = ['prb_b1', 'prb_b2', 'prb_b3', 'prb_b4', 'prb_b5', 'prb_b6'];
    for (const probeId of backlog) seedDiagnosedBacklogProbe(store, probeId, { demoReady: true });
    seedClosedProbe(store, 'prb_needs_ai');

    const summary = await runRebuildPass(repo, { maxAiCalls: 0, rebuildOutbound: true });

    assert.strictEqual(calls.total, 0, 'a zero budget means zero AI calls');
    assert.strictEqual(summary.assessments_remaining, 1, 'and the one probe needing an assessment is reported as remaining');
    assert.strictEqual(summary.personalisation.personalisation_created, backlog.length,
      'but every already-assessed probe is personalised anyway — the budget does not govern deterministic work');
    const outboundRows = rowsOf(store, 'OUTBOUND', OUTBOUND_HEADER);
    assert.strictEqual(outboundRows.length, backlog.length,
      'and every one of them reaches OUTBOUND in the SAME run');
    assert.strictEqual(summary.outbound_created, backlog.length);
    ok('deterministic Personalisation, DEMOS and OUTBOUND all complete with maxAiCalls = 0 — an AI backlog can no longer starve them');

    // property_street: none of these probes has one, and none is blocked.
    for (const outboundRow of outboundRows) {
      assert.strictEqual(outboundRow.property_street, `${outboundRow.probe_id} Whitmore Way`,
        'the street reference is derived deterministically from property_address');
    }
    assert.strictEqual(summary.outbound_blocked.missing_property_reference, 0);
    ok('a blank property_street with a valid property_address does not block OUTBOUND');

    // Idempotence: run it twice more and nothing of substance moves.
    // updated_at is excluded deliberately — a probe that is not yet finalised
    // has its deterministic row re-confirmed on every pass, which is the
    // self-healing behaviour, and OUTBOUND restamps its own updated_at when it
    // re-confirms a compiled row. Every value that carries meaning must be
    // identical.
    const stripStamps = () => JSON.parse(JSON.stringify(store, (key, value) => (
      key === 'updated_at' ? undefined : value
    )));
    const stampIndexes = {
      INTELLIGENCE: INTELLIGENCE_HEADER.indexOf('updated_at'),
      OUTBOUND: OUTBOUND_HEADER.indexOf('updated_at'),
      PERSONALISATION: PERSONALISATION_HEADER.indexOf('updated_at'),
      DEMOS: DEMOS_HEADER.indexOf('updated_at'),
      PROBES: PROBES_HEADER.indexOf('updated_at'),
      DIAGNOSIS: DIAGNOSIS_HEADER.indexOf('updated_at'),
    };
    const meaningful = () => Object.fromEntries(Object.entries(store).map(([tab, rows]) => {
      const idx = stampIndexes[tab];
      return [tab, rows.map((r) => (idx >= 0 ? r.map((v, i) => (i === idx ? '' : v)) : r))];
    }));
    await runRebuildPass(repo, { maxAiCalls: 0, rebuildOutbound: true });
    const afterOne = JSON.stringify(meaningful());
    await runRebuildPass(repo, { maxAiCalls: 0, rebuildOutbound: true });
    assert.strictEqual(JSON.stringify(meaningful()), afterOne,
      'a third run changes no value that carries meaning');
    void stripStamps;
    assert.strictEqual(rowsOf(store, 'OUTBOUND', OUTBOUND_HEADER).length, backlog.length,
      'no duplicate OUTBOUND row is ever appended');
    assert.strictEqual(rowsOf(store, 'PERSONALISATION', PERSONALISATION_HEADER).length, backlog.length,
      'and no duplicate PERSONALISATION row either');
    assert.strictEqual(calls.total, 0, 'and no AI was spent regenerating good work');

    ok('the recovery rebuild is idempotent and converges — repeated runs never duplicate a one-probe-per-row entity');
  }

  // ── 6. A frozen prospect story is never rewritten ─────────────────────────
  {
    const { store, repo } = makeFakeSheet();
    __setRepoForTests(repo);
    installAi();
    seedDiagnosedBacklogProbe(store, 'prb_frozen', { demoReady: true });
    store.PERSONALISATION.push(row(PERSONALISATION_HEADER, {
      personalisation_id: 'psn_frozen', agency_id: 'agc_prb_frozen', probe_id: 'prb_frozen',
      hero_journey: 'slow_response_gap', primary_narrative: 'The story this prospect was already sent.',
      email_observation: 'The story this prospect was already sent.',
      email_commercial_hook: 'The hook this prospect was already sent.',
      created_at: OLD, updated_at: OLD,
    }));

    await runRebuildPass(repo, { maxAiCalls: 50, rebuildOutbound: true });
    const written = rowsOf(store, 'PERSONALISATION', PERSONALISATION_HEADER)[0];
    assert.strictEqual(rowsOf(store, 'PERSONALISATION', PERSONALISATION_HEADER).length, 1, 'still exactly one row');
    assert.strictEqual(written.email_observation, 'The story this prospect was already sent.');
    assert.strictEqual(written.email_commercial_hook, 'The hook this prospect was already sent.');
    assert.strictEqual(written.updated_at, OLD, 'the row was not even rewritten');
    ok('an existing frozen personalisation is never regenerated — a prospect\'s story does not change under them');
  }

  // ── 7. A nonblank historical property_street wins, end to end ─────────────
  {
    const { store, repo } = makeFakeSheet();
    __setRepoForTests(repo);
    installAi();
    seedDiagnosedBacklogProbe(store, 'prb_street', { propertyStreet: '10 High Street', demoReady: true });

    await runRebuildPass(repo, { maxAiCalls: 50, rebuildOutbound: true });
    const probe = rowsOf(store, 'PROBES', PROBES_HEADER)[0];
    assert.strictEqual(probe.property_street, '10 High Street', 'the stored value is never overwritten by the self-heal');
    assert.strictEqual(rowsOf(store, 'OUTBOUND', OUTBOUND_HEADER)[0].property_street, '10 High Street',
      'and it is the value the Instantly custom variable receives');
    ok('a nonblank historical property_street is preserved and always wins over the derivable address');

    // And the blank case is filled in on the sheet itself, once.
    const { store: store2, repo: repo2 } = makeFakeSheet();
    __setRepoForTests(repo2);
    installAi();
    seedDiagnosedBacklogProbe(store2, 'prb_blank', { demoReady: true });
    await runRebuildPass(repo2, { maxAiCalls: 50, rebuildOutbound: true });
    assert.strictEqual(rowsOf(store2, 'PROBES', PROBES_HEADER)[0].property_street, 'prb_blank Whitmore Way',
      'a blank property_street is backfilled from property_address');
    const snapshot = JSON.stringify(store2.PROBES);
    await runRebuildPass(repo2, { maxAiCalls: 50, rebuildOutbound: true });
    assert.strictEqual(JSON.stringify(store2.PROBES), snapshot, 'and the backfill is idempotent');
    ok('a blank property_street is backfilled once from property_address, and never rewritten after that');
  }

  // ── 8. Instantly markers prevent a duplicate upload ───────────────────────
  {
    const { store, repo } = makeFakeSheet();
    __setRepoForTests(repo);
    installAi();
    seedDiagnosedBacklogProbe(store, 'prb_up1', { demoReady: true });
    seedDiagnosedBacklogProbe(store, 'prb_up2', { demoReady: true });
    await runRebuildPass(repo, { maxAiCalls: 50, rebuildOutbound: true });
    assert.strictEqual(rowsOf(store, 'OUTBOUND', OUTBOUND_HEADER).length, 2);

    let posted = 0;
    const fetchImpl = async () => {
      posted += 1;
      return { ok: true, status: 200, async text() { return JSON.stringify({ id: `lead_${posted}` }); } };
    };
    const firstUpload = await uploadEligibleOutboundLeads(repo, {
      apiKey: 'k', campaignId: 'c', fetchImpl,
    });
    assert.strictEqual(firstUpload.uploaded_rows, 2);
    assert.strictEqual(posted, 2);

    const secondUpload = await uploadEligibleOutboundLeads(repo, {
      apiKey: 'k', campaignId: 'c', fetchImpl,
    });
    assert.strictEqual(secondUpload.uploaded_rows, 0, 'nothing is uploaded a second time');
    assert.strictEqual(posted, 2, 'and not one further request reaches Instantly');
    assert.strictEqual(secondUpload.skip_reasons.instantly_lead_id_nonblank, 2,
      'the existing markers are the reason, stated explicitly');

    // And a rebuild after the handoff must not disturb the markers.
    await runRebuildPass(repo, { maxAiCalls: 50, rebuildOutbound: true });
    for (const outboundRow of rowsOf(store, 'OUTBOUND', OUTBOUND_HEADER)) {
      assert.ok(outboundRow.instantly_lead_id, 'a rebuild preserves every Instantly execution field');
    }
    ok('existing Instantly markers prevent a duplicate upload, and a rebuild never clears them');
  }

  // ── 9. Sheets reads are bounded, and independent of dataset size ──────────
  {
    async function readsFor(agencyCount) {
      const { store, repo, counts } = makeFakeSheet();
      __setRepoForTests(repo);
      installAi();
      for (let i = 0; i < agencyCount; i += 1) {
        seedDiagnosedBacklogProbe(store, `prb_scale_${i}`, { demoReady: true });
      }
      const snapshotRepo = createSnapshotRepo(repo);
      await runRebuildPass(snapshotRepo, { maxAiCalls: 50, rebuildOutbound: true });
      return { reads: counts.get, byTab: counts.getByTab, store };
    }

    const small = await readsFor(3);
    const large = await readsFor(12);
    assert.strictEqual(small.reads, large.reads,
      `Sheets reads must not grow with the number of agencies (3 agencies: ${small.reads}, 12: ${large.reads})`);
    for (const [tab, times] of Object.entries(large.byTab)) {
      assert.strictEqual(times, 1, `${tab} must be downloaded at most once per invocation, was ${times}`);
    }
    assert.ok(large.reads <= 12, `a whole rebuild reads a bounded handful of tabs, not dozens of times (was ${large.reads})`);
    ok(`Sheets reads are bounded (${large.reads} per invocation, one per tab) and do not grow with the number of agencies`);
  }

  // ── 10. Action reconciliation batches instead of re-reading per action ────
  {
    const { store, repo, counts } = makeFakeSheet();
    __setRepoForTests(repo);
    installAi();
    const agencyIds = [];
    for (let i = 0; i < 8; i += 1) agencyIds.push(seedDiagnosedBacklogProbe(store, `prb_act_${i}`, { demoReady: true }));
    await runRebuildPass(repo, { maxAiCalls: 50, rebuildOutbound: true });

    const before = { ...counts };
    const beforeActionsReads = counts.getByTab.ACTIONS || 0;
    const beforeAppends = counts.append;
    const snapshotRepo = createSnapshotRepo(repo);
    const result = await reconcileActionEngine(snapshotRepo, { execution: { available: false } });

    assert.ok(result.available, 'the ledger is available');
    assert.ok(result.created > 0, `the reconciler created work for ${agencyIds.length} agencies (created ${result.created})`);
    const actionsReads = (counts.getByTab.ACTIONS || 0) - beforeActionsReads;
    assert.strictEqual(actionsReads, 1, `ACTIONS is read ONCE for the whole reconciliation, was ${actionsReads}`);
    const appends = counts.append - beforeAppends;
    assert.strictEqual(appends, 1, `every new action is appended in ONE batched request, was ${appends}`);
    assert.ok(result.created >= 8, 'and every agency still got its action');

    ok('action reconciliation reads ACTIONS once and batches its writes — no re-read or read-modify-write per action');

    // Scoping: naming the changed agencies reconciles only those.
    const scoped = await reconcileActionEngine(createSnapshotRepo(repo), {
      agencyIds: agencyIds.slice(0, 2), execution: { available: false },
    });
    assert.strictEqual(scoped.agencies, 2, 'a scoped reconciliation touches only the agencies whose evidence changed');
    assert.strictEqual(scoped.scope, 'affected_agencies');
    ok('nightly reconciliation can be scoped to the agencies that actually changed, with the full sweep still available');
  }

  // ── 11. Strong handling stays a valid outcome ─────────────────────────────
  {
    const { store, repo } = makeFakeSheet();
    __setRepoForTests(repo);
    // An assessment that found NO problem: empty findings, one genuine
    // positive, handling_quality strong. Nothing downstream may invent a "but".
    const calls = installAi(assessmentAnswer({
      viewing_progression: 'slot_offered',
      buyer_questions_asked: [
        { topic: 'budget', quote: 'What is your budget?', communication_id: 'com_prb_strong' },
        { topic: 'finance', quote: 'Do you have a mortgage?', communication_id: 'com_prb_strong' },
        { topic: 'timescale', quote: 'When would you like to move?', communication_id: 'com_prb_strong' },
      ],
      findings: [],
      positive_findings: [{
        positive: 'The team came back on the enquiry the same day.',
        evidence: 'A human reply was recorded five hours after the enquiry.',
      }],
    }));
    seedClosedProbe(store, 'prb_strong', { enquiryText: 'Interested in a viewing.' });
    store.COMMUNICATIONS.at(-1)[COMMUNICATIONS_HEADER.indexOf('body_text')] =
      'What is your budget? Do you have a mortgage? When would you like to move? Saturday at 10am is available.';

    await runRebuildPass(repo, { maxAiCalls: 50, rebuildOutbound: true });
    assert.strictEqual(calls.total, 1);
    const diag = rowsOf(store, 'DIAGNOSIS', DIAGNOSIS_HEADER)[0];
    const findings = JSON.parse(diag.findings);
    assert.strictEqual(findings.filter((f) => f.finding_type !== 'positive').length, 0,
      'no problem finding is manufactured for a well-handled enquiry');
    assert.strictEqual(diag.handling_quality, 'strong', 'and the strong verdict survives to the row');
    const person = rowsOf(store, 'PERSONALISATION', PERSONALISATION_HEADER)[0];
    assert.ok(person, 'a well-handled probe is still personalised');
    assert.ok(person.email_observation, 'with a real observation sentence');
    assert.strictEqual(person.main_finding, '', 'and no invented main finding');
    assert.ok(!/but|however|although/i.test(person.email_observation),
      `strong handling must not acquire a fake "but": ${person.email_observation}`);
    ok('strong handling remains a valid outcome — no fake problem is invented anywhere downstream');
  }

  // ── 12. A seller declaration alone is never a valuation opportunity ───────
  {
    // Straight at the shared sanitiser, because that is the single place both
    // the merged assessment and the retired standalone diagnosis go through.
    const probe = {
      property_address: '12 Whitmore Way, Basildon',
      property_price: '£300,000',
      enquiry_text: 'Interested in a viewing. I also have a property to sell.',
      probe_timestamp: OLD,
    };
    const intelligence = { human_contact: 'yes', response_hours: '5', contact_attempts: '1', follow_ups: '0' };
    const result = sanitizeDiagnosisResult({
      findings: [{
        finding_type: 'opportunity',
        finding: 'The declared property to sell was a valuation opportunity that was never taken.',
        evidence: 'The enquiry declared a property to sell and no valuation was offered.',
        significance_note: 'A valuation would have been worth chasing.',
      }],
      positive_findings: [],
      enquiry_signals: [], unresolved_context: [], recommended_actions: [],
      handling_summary: 'The team replied.', handling_quality: 'mixed',
      strengths: '', missed_opportunities: '', commercial_implication: 'Specific to this agency.',
      novus_opportunity: 'Growth (valuation list / seller conversion)',
      diagnosis_summary: 'Replied but left the seller side open.',
    }, intelligence, probe);

    assert.strictEqual(JSON.parse(result.findings).length, 0,
      'a declaration plus an absent valuation is dropped: it is unresolved context, not an opportunity');
    assert.strictEqual(result.novus_opportunity, 'None evidenced',
      'and the Growth routing is downgraded, because nothing evidenced it');
    ok('a seller declaration alone never becomes a valuation opportunity, at the one place both callers share');
  }

  // ── 13. The summary explains every mismatched count ───────────────────────
  {
    const probe = {
      property_address: '12 Whitmore Way, Basildon', property_price: '£300,000',
      enquiry_text: 'Interested in a viewing and I would also like a valuation of my current home.',
      probe_timestamp: OLD,
    };
    const result = sanitizeDiagnosisResult({
      findings: [{
        issue: 'The requested valuation was not progressed.',
        evidence: 'The original enquiry explicitly requested a valuation, but no response addressed it.',
      }],
      positive_findings: [], enquiry_signals: [], unresolved_context: [],
    }, { human_contact: 'yes', response_hours: '5', contact_attempts: '1', follow_ups: '0', grade: 'D' }, probe);
    assert.strictEqual(JSON.parse(result.findings).length, 1,
      'an explicitly requested valuation remains a legitimate evidence-backed story finding');
    ok('the all-story seller safety gate retains genuinely supported valuation findings');
  }

  {
    const { store, repo } = makeFakeSheet();
    __setRepoForTests(repo);
    installAi();
    seedDiagnosedBacklogProbe(store, 'prb_rep_ok', { demoReady: true });
    // Personalisable, but its agency has no verified email: OUTBOUND-blocked
    // for a reason the summary must name.
    const blockedAgency = seedDiagnosedBacklogProbe(store, 'prb_rep_blocked', { demoReady: true });
    const agencyIdx = AGENCIES_HEADER.indexOf('agency_id');
    const emailIdx = AGENCIES_HEADER.indexOf('outreach_contact_email');
    for (const agencyRow of store.AGENCIES) {
      if (agencyRow[agencyIdx] === blockedAgency) agencyRow[emailIdx] = '';
    }

    const summary = await runRebuildPass(repo, { maxAiCalls: 50, rebuildOutbound: true });
    for (const field of [
      'probes_total', 'probes_observing', 'probes_closed',
      'assessments_existing', 'assessments_created', 'assessments_remaining', 'ai_calls_used',
      'personalisation_existing', 'personalisation_created', 'personalisation_remaining',
      'demos_existing', 'demos_created', 'demos_remaining',
      'outbound_existing', 'outbound_created', 'outbound_blocked', 'sheets',
    ]) {
      assert.ok(field in summary, `the summary reports ${field}`);
    }
    assert.strictEqual(summary.outbound_blocked.missing_email, 1,
      'and a blocked lead is explained by its actual blocking reason');
    assert.strictEqual(summary.outbound_created, 1, 'while the eligible one still went through');
    assert.ok(Number.isInteger(summary.sheets.sheets_read_count), 'the Sheets request counts are reported');
    ok('the rebuild summary makes every mismatched count explainable, with explicit block reasons');
  }

  console.log(`\n${passed} checks passed.`);
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
