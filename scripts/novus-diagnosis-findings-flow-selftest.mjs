// scripts/novus-diagnosis-findings-flow-selftest.mjs — hermetic end-to-end
// test (no network, no creds) for the data flow this change introduces:
//
//   DIAGNOSIS -> DIAGNOSIS_FINDINGS -> PERSONALISATION -> ASSEMBLED EMAIL
//
// It runs the REAL rebuild path (lib/rebuild-pass.mjs, i.e. exactly what the
// "Rebuild Intelligence" button and the finalisation cron call) over an
// in-memory workbook seeded with the LIVE sheet headers — including the fact
// that the live DIAGNOSIS tab carries no `findings` column at all, so the
// findings genuinely have nowhere to live except DIAGNOSIS_FINDINGS.
//
// It covers, as separate probes, every shape the pipeline has to handle:
//   no response · weak/generic response · genuinely good response ·
//   missed seller opportunity · weak buyer qualification · poor progression ·
//   several findings combining into one broader story
//
// and proves:
//   1. every findings[] item Diagnosis produced lands in DIAGNOSIS_FINDINGS,
//      one row per finding, linked by probe_id, numbered in Diagnosis's own
//      order — and nothing is invented along the way
//   2. Personalisation reads that complete set back for the right probe, and
//      combines them rather than defaulting to finding #1
//   3. each probe gets a genuinely different story, different sentence-ready
//      email copy and a different assembled email — the failure mode the spec
//      doc calls out ("fix the logic if different agencies are coming out too
//      similar")
//   3b. the no-response probe gets its own fixed email structure rather than
//      a normal email with empty paragraphs
//   4. the whole flow is idempotent: a second rebuild makes no AI calls,
//      writes no duplicate findings rows, and changes nothing
//
// Run: npm run novus:diagnosis-findings-flow-selftest

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';
import { runRebuildPass } from '../lib/rebuild-pass.mjs';
import {
  ADDITIONAL_FINDINGS_HOOK_LINE, CTA_LINE, NO_REPLY_LINE,
  NO_RESPONSE_BREAKDOWN_LINE, NO_RESPONSE_CTA_LINE, propertyReference,
  THAT_MEANT_PREFIX, THAT_ALSO_MEANT_PREFIX,
  FAIR_OBSERVATION_PREFIX, MAIN_FINDING_PREFIX, assembleEmail,
} from '../lib/email-assembly.mjs';

// ── The live workbook's actual headers ───────────────────────────────────────
// DIAGNOSIS deliberately has NO `findings` column — this is the live shape,
// and the point of DIAGNOSIS_FINDINGS.
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
const DIAGNOSIS_FINDINGS_HEADER = ['probe_id', 'finding_index', 'finding', 'evidence', 'significance_note'];
const PERSONALISATION_HEADER = [
  'personalisation_id', 'agency_id', 'probe_id', 'hero_journey',
  'primary_narrative', 'narrative_finding_indexes', 'supporting_findings', 'evidence',
  'novus_counterfactual',
  'enquiry_date', 'property_address', 'email_variant',
  'fair_observation', 'main_finding', 'commercial_consequence', 'wider_observation', 'wider_consequence',
  'additional_findings_hook', 'email_body',
  'created_at', 'updated_at',
];
const AGENCIES_HEADER = ['agency_id', 'agency_name', 'branch_count', 'live_listing_count', 'primary_contact_name'];

function makeFakeSheet() {
  const store = {
    PROBES: [PROBES_HEADER.slice(), ['SCHEMA NOTE', 'Fixture']],
    COMMUNICATIONS: [COMMUNICATIONS_HEADER.slice(), ['SCHEMA NOTE', 'Fixture']],
    INTELLIGENCE: [INTELLIGENCE_HEADER.slice()],
    DIAGNOSIS: [DIAGNOSIS_HEADER.slice()],
    DIAGNOSIS_FINDINGS: [DIAGNOSIS_FINDINGS_HEADER.slice()],
    PERSONALISATION: [PERSONALISATION_HEADER.slice()],
    AGENCIES: [AGENCIES_HEADER.slice(), ['SCHEMA NOTE', 'Fixture']],
  };
  function tabOf(range) { return String(range).split('!')[0]; }
  function startRowOf(range) {
    const m = String(range).match(/!\D+(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }
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
        values.forEach((row, i) => { store[tab][start - 1 + i] = row.slice(); });
      }
    },
  };
  return { store, repo: createRepo(valuesApi) };
}

function row(header, obj) { return header.map((k) => obj[k] ?? ''); }
function toObj(header, r) { return Object.fromEntries(header.map((k, i) => [k, r[i] ?? ''])); }
function rowsOf(store, tab, header) {
  return store[tab].slice(1)
    .filter((r) => r[header.indexOf('probe_id')] && r[header.indexOf('probe_id')] !== 'SCHEMA NOTE')
    .map((r) => toObj(header, r));
}
function findingsFor(store, probeId) {
  return rowsOf(store, 'DIAGNOSIS_FINDINGS', DIAGNOSIS_FINDINGS_HEADER)
    .filter((f) => f.probe_id === probeId)
    .sort((a, b) => Number(a.finding_index) - Number(b.finding_index));
}
function personalisationFor(store, probeId) {
  return rowsOf(store, 'PERSONALISATION', PERSONALISATION_HEADER).find((p) => p.probe_id === probeId);
}

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

// Long past, so the 4-day observation window has always closed by now.
const OLD = '2020-01-01T09:00:00.000Z';

// ── The seven probe shapes ───────────────────────────────────────────────────
// Each carries its own Intelligence evidence, the findings its Diagnosis
// produces, and the story its Personalisation makes of them. Keyed by
// property address, which appears in both AI prompts.
const SCENARIOS = [
  {
    key: 'no_response',
    probe_id: 'prb_none', address: 'Silence Road', price: '£310,000',
    intelligence: { human_contact: 'none', response_hours: '', contact_attempts: 0, follow_ups: 0, channels_used: '', viewing_progression: 'none', buyer_qualification: 'none', seller_recognition: 'none', communication_quality: 'poor', did_well: '', missed: 'Everything — no contact was made at all.', grade: 'H' },
    comms: [],
    findings: [
      { finding: 'The enquiry was never replied to at all.', evidence: 'Zero communications recorded across the full 4-day observation window.', significance_note: 'Both the buyer and the declared seller lead were lost in silence.' },
    ],
    strengths: '',
    story: {
      primary_narrative: 'Nothing came back at all — not an automated acknowledgement, not a call, nothing, across four days.',
      narrative_finding_indexes: [1],
      supporting_findings: '',
      fair_observation: 'Your team have clearly been busy.',
      main_finding: 'We never heard anything back.',
      commercial_consequence: 'a buyer ready to view this one never got as far as a conversation.',
      wider_observation: 'We had also mentioned a property of our own that we were thinking of selling.',
      wider_consequence: 'It also meant the property we said we had of our own was never picked up as a valuation.',
    },
    // The no-response structure has no fair observation and no main finding —
    // there was no conversation to observe or narrate — so both are forced
    // empty however the model answers, and the email switches structure.
    expect: {
      hero_journey: 'complete_miss', findings: 1, email_variant: 'no_response',
      // The no-response variant closes with its own two lines, so the normal
      // curiosity tease is not stored on top of them.
      fair_observation: '', main_finding: '', additional_findings_hook: '',
    },
  },
  {
    key: 'weak_generic',
    probe_id: 'prb_generic', address: 'Template Way', price: '£265,000',
    intelligence: { human_contact: 'yes', response_hours: 4.2, contact_attempts: 1, follow_ups: 0, channels_used: 'email', viewing_progression: 'none', buyer_qualification: 'none', seller_recognition: 'none', communication_quality: 'generic', did_well: 'Replied the same working day.', missed: 'The reply said nothing specific to this enquiry.', grade: 'D' },
    comms: [{ id: 'com_generic', channel: 'email', at: '2020-01-01T13:12:00.000Z', subject: 'Your enquiry', body: 'Thank you for your enquiry. One of our team will be in touch shortly.' }],
    findings: [
      { finding: 'The only reply was a generic acknowledgement that engaged with nothing in the enquiry.', evidence: '"Thank you for your enquiry. One of our team will be in touch shortly." — the entire reply.', significance_note: 'A same-day reply that carried no information forward reads to the buyer as no reply.' },
    ],
    strengths: 'Replied inside the same working day.',
    story: {
      primary_narrative: 'The reply arrived quickly but engaged with none of what the enquiry actually said.',
      narrative_finding_indexes: [1],
      supporting_findings: '',
      fair_observation: 'You did come back to us the same day, which plenty of agencies do not.',
      main_finding: 'We got a reply the same day, but it did not mention the property or anything we had asked.',
      commercial_consequence: 'the enquiry stalled despite your team being quick off the mark.',
      wider_consequence: '',
    },
    expect: { hero_journey: 'fast_response_stalled_follow_up', findings: 1, email_variant: 'normal' },
  },
  {
    key: 'good_handling',
    probe_id: 'prb_good', address: 'Exemplar Close', price: '£520,000',
    intelligence: { human_contact: 'yes', response_hours: 0.6, contact_attempts: 3, follow_ups: 2, channels_used: 'voice,email', viewing_progression: 'booked', buyer_qualification: 'thorough', buyer_questions_asked: 'budget; finance; timescale; current position', seller_recognition: 'valuation_booked', communication_quality: 'strong', did_well: 'Called back in 36 minutes, qualified fully, booked both the viewing and the valuation.', missed: '', grade: 'A' },
    comms: [{ id: 'com_good', channel: 'voice', at: '2020-01-01T09:36:00.000Z', transcript: 'Happy to get you booked in Thursday, and I can bring a valuation figure for your own place at the same time.' }],
    findings: [],
    strengths: 'Called back in 36 minutes, qualified the buyer fully, and booked both the viewing and the valuation.',
    story: {
      primary_narrative: 'This was handled about as well as an enquiry can be — the question is whether it happens every time, not just this time.',
      narrative_finding_indexes: [],
      supporting_findings: '',
      fair_observation: 'Your team called back in 36 minutes and booked the viewing and the valuation in one go.',
      main_finding: 'Honestly, this one was handled really well.',
      commercial_consequence: 'the only question worth asking is whether every enquiry gets the same treatment.',
      wider_consequence: '',
    },
    // No findings left over, but the closing transition is locked copy that
    // runs in every email — it hands off to the breakdown rather than
    // claiming a number of other findings.
    expect: { hero_journey: 'strong_handling_database_opportunity', findings: 0, additional_findings_hook: ADDITIONAL_FINDINGS_HOOK_LINE },
  },
  {
    key: 'missed_seller',
    probe_id: 'prb_seller', address: 'Vendor Lane', price: '£445,000',
    intelligence: { human_contact: 'yes', response_hours: 2.1, contact_attempts: 2, follow_ups: 1, channels_used: 'email', viewing_progression: 'booked', buyer_qualification: 'thorough', buyer_questions_asked: 'budget; finance; timescale', seller_recognition: 'none', communication_quality: 'strong', did_well: 'Fast, well-qualified, viewing booked.', missed: 'The declared property to sell was never acknowledged.', grade: 'B' },
    comms: [{ id: 'com_seller', channel: 'email', at: '2020-01-01T11:06:00.000Z', subject: 'Viewing confirmed', body: 'Great, I have you in for Thursday at 2pm. Could you confirm your budget and how you are funding the purchase?' }],
    findings: [
      { finding: 'The declared property to sell was never acknowledged in any contact.', evidence: 'Seller recognition recorded as none across both emails; no valuation, appraisal or valuer mentioned.', significance_note: 'An off-market instruction was handed over and never picked up.' },
    ],
    strengths: 'Fast, well-qualified on the buying side, viewing booked inside two hours.',
    story: {
      primary_narrative: 'The buying side was handled well and the selling side was never touched — the instruction was mentioned in the enquiry and never came up again.',
      narrative_finding_indexes: [1],
      supporting_findings: '',
      fair_observation: 'On the buying side this was genuinely well handled — booked in two hours with proper questions.',
      main_finding: 'We mentioned we had a property to sell, and it never came up again.',
      commercial_consequence: "the £445,000 enquiry was not just a potential buyer — there was a potential seller instruction sitting inside it that never got explored.",
      wider_consequence: '',
    },
    expect: { hero_journey: 'weak_seller_qualification', findings: 1 },
  },
  {
    key: 'weak_qualification',
    probe_id: 'prb_qual', address: 'Unasked Avenue', price: '£289,000',
    intelligence: { human_contact: 'yes', response_hours: 3.4, contact_attempts: 1, follow_ups: 0, channels_used: 'voice', viewing_progression: 'invited', buyer_qualification: 'none', buyer_questions_asked: '', seller_recognition: '', communication_quality: 'generic', did_well: 'Rang back the same day.', missed: 'No qualifying question of any kind was asked.', grade: 'D' },
    comms: [{ id: 'com_qual', channel: 'voice', at: '2020-01-01T12:24:00.000Z', transcript: 'Give us a ring back when you want to come and see it.' }],
    findings: [
      { finding: 'Not one qualifying question was asked before inviting a viewing.', evidence: 'Buyer qualification recorded as none; no question on budget, finance, timescale or position in the single call.', significance_note: 'The viewing slot is committed with no idea whether the buyer can proceed.' },
    ],
    strengths: 'Rang back the same day.',
    story: {
      primary_narrative: 'A viewing was offered without a single question about whether we could actually buy.',
      narrative_finding_indexes: [1],
      supporting_findings: '',
      fair_observation: 'You did ring back the same day.',
      main_finding: 'We were invited to view without being asked anything at all about our position.',
      commercial_consequence: 'a viewing slot went to someone nobody had checked could buy.',
      wider_consequence: '',
    },
    expect: { hero_journey: 'fast_response_stalled_follow_up', findings: 1 },
  },
  {
    key: 'poor_progression',
    probe_id: 'prb_progress', address: 'Stalled Street', price: '£372,000',
    intelligence: { human_contact: 'yes', response_hours: 9.8, contact_attempts: 4, follow_ups: 3, channels_used: 'voice,email', viewing_progression: 'none', buyer_qualification: 'minimal', buyer_questions_asked: 'timescale', seller_recognition: '', communication_quality: 'generic', did_well: 'Four contact attempts across two channels — genuinely persistent.', missed: 'None of the four attempts offered a viewing.', grade: 'B' },
    comms: [{ id: 'com_progress', channel: 'voice', at: '2020-01-01T18:48:00.000Z', transcript: 'Just chasing up on your enquiry, give us a call back when you get a moment.' }],
    findings: [
      { finding: 'Four contact attempts never once offered a viewing.', evidence: 'contact_attempts 4, follow_ups 3, viewing_progression none.', significance_note: 'Real persistence spent without ever asking for the thing that moves the sale forward.' },
    ],
    strengths: 'Four contact attempts across two channels — genuinely persistent.',
    story: {
      primary_narrative: 'Your team chased four times and never once offered a viewing.',
      narrative_finding_indexes: [1],
      supporting_findings: '',
      fair_observation: 'Four attempts across two channels is more persistence than most agencies manage.',
      main_finding: 'Your team chased us four times, and each one essentially asked us to get back to you, rather than putting a viewing in front of us.',
      commercial_consequence: 'all that effort ended without the one step that moves a sale forward.',
      wider_consequence: '',
    },
    expect: { hero_journey: 'fast_response_stalled_follow_up', findings: 1 },
  },
  {
    key: 'combining',
    probe_id: 'prb_combine', address: 'Compound Gardens', price: '£615,000',
    intelligence: { human_contact: 'yes', response_hours: 21.4, contact_attempts: 1, follow_ups: 0, channels_used: 'email', viewing_progression: 'none', buyer_qualification: 'none', buyer_questions_asked: '', seller_recognition: 'none', communication_quality: 'generic', did_well: 'The reply did name the correct property.', missed: 'Slow, unqualified, no viewing, seller ignored.', grade: 'F' },
    comms: [{ id: 'com_combine', channel: 'email', at: '2020-01-02T06:24:00.000Z', subject: 'Compound Gardens', body: 'Thanks for your interest in Compound Gardens. Let us know if you would like any further information.' }],
    findings: [
      { finding: 'Nothing reached the enquiry for 21.4 hours.', evidence: 'Probe 09:00 -> first human contact 06:24 the next day = 21.4 hours.', significance_note: 'Overnight enquiries are not being picked up until the following morning.' },
      { finding: 'No qualifying question was asked at any point.', evidence: 'Buyer qualification recorded as none; no questions in the single reply.', significance_note: 'The agency has no idea whether this buyer can proceed.' },
      { finding: 'No viewing was ever offered.', evidence: 'viewing_progression none across the single contact.', significance_note: 'The enquiry was answered without being advanced.' },
      { finding: 'The declared property to sell went unmentioned in the reply.', evidence: 'Seller recognition none; no valuation mentioned anywhere in the single email.', significance_note: 'A second, larger opportunity in the same enquiry was not seen at all.' },
    ],
    strengths: 'The reply did at least name the correct property.',
    story: {
      // Deliberately combines three findings into one broader story and
      // leaves the fourth as a supporting finding.
      primary_narrative: 'The enquiry waited overnight, and the reply that eventually arrived asked nothing and offered nothing — it acknowledged the property and stopped there.',
      narrative_finding_indexes: [1, 2, 3],
      supporting_findings: 'The property we said we had to sell was never mentioned either.',
      // "did at least name the right property" would be a backhanded
      // compliment — the hedge guard rejects it, and the email would then be
      // unsendable rather than opening on criticism.
      fair_observation: 'You did reply, and the reply named the right property.',
      main_finding: 'It took about a day for anything to come back, and when it did it did not ask us anything or offer us a viewing.',
      commercial_consequence: 'the £615,000 enquiry was getting attention, but it was not really being progressed.',
      wider_consequence: '',
    },
    expect: { hero_journey: 'slow_response_gap', findings: 4, narrative_finding_indexes: '1,2,3' },
  },
];

const byAddress = new Map(SCENARIOS.map((s) => [s.address, s]));

let diagnoseCalls = 0;
let personaliseCalls = 0;
const personalisationPrompts = new Map();

function installAiStub() {
  diagnoseCalls = 0;
  personaliseCalls = 0;
  personalisationPrompts.clear();
  __setAiCallerForTests(async ({ tool, prompt }) => {
    const scenario = SCENARIOS.find((s) => prompt.includes(s.address));
    assert.ok(scenario, `the prompt names a known probe (tool ${tool?.name})`);

    if (tool.name === 'record_probe_diagnosis') {
      diagnoseCalls += 1;
      return {
        findings: scenario.findings,
        strengths: scenario.strengths,
        missed_opportunities: scenario.intelligence.missed || '',
        commercial_implication: `Specific to ${scenario.address}.`,
        novus_opportunity: scenario.key === 'good_handling' ? 'Growth (valuation list / seller conversion)' : 'Core (front desk)',
        diagnosis_summary: `Diagnosis for ${scenario.address}.`,
      };
    }
    if (tool.name === 'record_probe_personalisation') {
      personaliseCalls += 1;
      personalisationPrompts.set(scenario.probe_id, prompt);
      return { evidence_quotes: [], ...scenario.story };
    }
    // Intelligence interpretation — deterministic fields are already seeded,
    // this only needs to satisfy the interpretation step.
    return {
      viewing_progression: scenario.intelligence.viewing_progression || 'none',
      buyer_questions_asked: scenario.intelligence.buyer_questions_asked ? scenario.intelligence.buyer_questions_asked.split('; ') : [],
      seller_recognition: scenario.intelligence.seller_recognition || 'none',
      communication_quality: scenario.intelligence.communication_quality || 'generic',
      did_well: scenario.intelligence.did_well || '',
      missed: scenario.intelligence.missed || '',
      evidence: [],
    };
  });
}

function seed(store) {
  for (const s of SCENARIOS) {
    store.AGENCIES.push(row(AGENCIES_HEADER, {
      agency_id: `agc_${s.key}`, agency_name: s.key, branch_count: 2, live_listing_count: 30, primary_contact_name: 'Sam Taylor',
    }));
    store.PROBES.push(row(PROBES_HEADER, {
      agency_id: `agc_${s.key}`, probe_id: s.probe_id, property_address: s.address, property_price: s.price,
      enquiry_text: 'Rightmove property enquiry. Declared: has a property to sell, yes, it is not yet on the market.',
      probe_timestamp: OLD, observation_deadline: '2020-01-05T09:00:00.000Z', probe_status: 'observing',
    }));
    for (const c of s.comms) {
      store.COMMUNICATIONS.push(row(COMMUNICATIONS_HEADER, {
        communication_id: c.id, agency_id: `agc_${s.key}`, probe_id: s.probe_id, occurred_at: c.at,
        channel: c.channel, direction: 'inbound', subject: c.subject || '', body_text: c.body || '',
        transcript: c.transcript || '', match_status: 'matched', automated_or_human: 'human',
      }));
    }
    // INTELLIGENCE is seeded already-closed with its evidence, so this test
    // exercises the Diagnosis -> findings -> Personalisation flow rather than
    // re-testing the interpretation layer (which has its own suite).
    store.INTELLIGENCE.push(row(INTELLIGENCE_HEADER, {
      probe_id: s.probe_id, agency_id: `agc_${s.key}`, observation_status: 'closed',
      ...s.intelligence,
      evidence: `Evidence for ${s.address}.`,
      grade_reason: `Graded ${s.intelligence.grade}.`,
    }));
  }
}

async function run() {
  console.log('DIAGNOSIS -> DIAGNOSIS_FINDINGS -> PERSONALISATION -> EMAIL flow\n');

  const { store, repo } = makeFakeSheet();
  __setRepoForTests(repo);
  installAiStub();
  seed(store);

  const first = await runRebuildPass(repo, { maxAiCalls: 100 });
  assert.deepStrictEqual(first.diagnosis.problems, [], 'no diagnosis problems');
  assert.deepStrictEqual(first.personalisation.problems, [], 'no personalisation problems');

  // ── 1. Every finding lands in DIAGNOSIS_FINDINGS, linked by probe_id ──
  {
    const expectedTotal = SCENARIOS.reduce((n, s) => n + s.findings.length, 0);
    const allRows = rowsOf(store, 'DIAGNOSIS_FINDINGS', DIAGNOSIS_FINDINGS_HEADER);
    assert.strictEqual(allRows.length, expectedTotal, `DIAGNOSIS_FINDINGS holds all ${expectedTotal} findings`);
    assert.strictEqual(first.diagnosis.findings_written, expectedTotal, 'the rebuild reports the same count it wrote');
    assert.strictEqual(first.diagnosis.findings_tab_available, true, 'the tab was found');

    for (const s of SCENARIOS) {
      const rows = findingsFor(store, s.probe_id);
      assert.strictEqual(rows.length, s.findings.length, `${s.key}: one row per finding`);
      rows.forEach((r, i) => {
        assert.strictEqual(Number(r.finding_index), i + 1, `${s.key}: findings are numbered in Diagnosis's own order from 1`);
        assert.strictEqual(r.finding, s.findings[i].finding, `${s.key}: finding ${i + 1} text is persisted verbatim`);
        assert.strictEqual(r.evidence, s.findings[i].evidence, `${s.key}: finding ${i + 1} keeps its own evidence`);
        assert.strictEqual(r.significance_note, s.findings[i].significance_note, `${s.key}: finding ${i + 1} keeps its significance note`);
      });
    }
    // Nothing invented: the well-handled probe contributes no rows at all.
    assert.strictEqual(findingsFor(store, 'prb_good').length, 0, 'a probe with no findings writes no findings rows');
    ok(`every findings[] item reaches DIAGNOSIS_FINDINGS — ${expectedTotal} rows across ${SCENARIOS.length} probes, one row per finding, linked by probe_id, and none invented`);
  }

  // ── 2. The live DIAGNOSIS header has no findings column, and that is fine ──
  {
    assert.ok(!DIAGNOSIS_HEADER.includes('findings'), 'the live DIAGNOSIS tab has no findings column');
    const diagnosisRows = rowsOf(store, 'DIAGNOSIS', DIAGNOSIS_HEADER);
    assert.strictEqual(diagnosisRows.length, SCENARIOS.length, 'every probe still gets its DIAGNOSIS row');
    for (const d of diagnosisRows) {
      assert.ok(d.diagnosis_summary, 'the whole-probe diagnosis is still written');
    }
    ok('the whole-probe DIAGNOSIS row is unaffected — findings live in DIAGNOSIS_FINDINGS, exactly as the live sheet is shaped');
  }

  // ── 3. Personalisation reads the complete set back, for the right probe ──
  {
    for (const s of SCENARIOS) {
      const prompt = personalisationPrompts.get(s.probe_id);
      assert.ok(prompt, `${s.key}: Personalisation ran`);
      for (const f of s.findings) {
        assert.ok(prompt.includes(f.finding), `${s.key}: every persisted finding reached Personalisation`);
        assert.ok(prompt.includes(f.evidence), `${s.key}: with its own evidence`);
      }
      // And no other probe's findings leaked into it.
      for (const other of SCENARIOS) {
        if (other.probe_id === s.probe_id) continue;
        for (const f of other.findings) {
          assert.ok(!prompt.includes(f.finding), `${s.key}: no finding from ${other.key} leaked in`);
        }
      }
    }
    ok('Personalisation receives exactly its own probe\'s complete findings set, with no cross-probe leakage');
  }

  // ── 4. Several findings combine into ONE narrative, not just finding #1 ──
  {
    const p = personalisationFor(store, 'prb_combine');
    assert.strictEqual(p.narrative_finding_indexes, '1,2,3', 'three findings combined into the primary narrative');
    assert.ok(p.supporting_findings.includes('property we said we had to sell'), 'the fourth stays a supporting finding');
    assert.strictEqual(p.additional_findings_hook, ADDITIONAL_FINDINGS_HOOK_LINE, 'the email\'s additional-findings hook is exactly the fixed tease line, never AI-written analysis');
    assert.ok(!p.additional_findings_hook.includes('property we said we had to sell'), 'and it never reveals what the leftover finding actually was');
    assert.strictEqual(findingsFor(store, 'prb_combine').length, 4, 'all four findings remain available for the audit');
    ok('a probe with four findings combines three into one broader narrative and keeps the fourth as a supporting finding — not simply finding #1');
  }

  // ── 5. Each probe shape gets its own journey, story and email variables ──
  {
    for (const s of SCENARIOS) {
      const p = personalisationFor(store, s.probe_id);
      assert.ok(p, `${s.key}: a PERSONALISATION row exists`);
      assert.strictEqual(p.hero_journey, s.expect.hero_journey, `${s.key}: routed to the right audit/demo journey`);
      if (s.expect.fair_observation !== undefined) {
        assert.strictEqual(p.fair_observation, s.expect.fair_observation, `${s.key}: fair observation`);
      }
      assert.ok(p.primary_narrative, `${s.key}: has a primary narrative`);
      for (const [field, expected] of Object.entries(s.expect)) {
        if (['hero_journey', 'findings', 'narrative_finding_indexes'].includes(field)) continue;
        assert.strictEqual(p[field], expected, `${s.key}: ${field}`);
      }

      // The sentence-ready email copy.
      assert.strictEqual(p.enquiry_date, '1 January', `${s.key}: enquiry_date is the probe's own date`);
      assert.strictEqual(p.property_address, s.address, `${s.key}: property_address is this probe's own property`);
      assert.ok(p.commercial_consequence, `${s.key}: the commercial consequence is populated`);
      assert.ok(!/^that mean(s|t)/i.test(p.commercial_consequence), `${s.key}: the consequence never repeats the assembler's "That meant"`);
      if (p.email_variant !== 'no_response') {
        assert.ok(p.main_finding, `${s.key}: the main finding is populated`);
      }

      // No email furniture anywhere — the assembler owns all of it.
      // THE GRAMMAR CONTRACT, across every probe shape: the four prefixed
      // fields are lower-case continuations, wider_observation stands alone.
      for (const [field, value] of Object.entries({
        fair_observation: p.fair_observation,
        main_finding: p.main_finding,
        commercial_consequence: p.commercial_consequence,
        wider_consequence: p.wider_consequence,
      })) {
        if (!value) continue;
        assert.ok(/^[a-z£"']/.test(value), `${s.key}: ${field} is the lower-case continuation its fixed opener needs`);
        assert.ok(/[.!?]$/.test(value), `${s.key}: ${field} is terminated`);
      }
      if (p.wider_observation) {
        assert.ok(/^[A-Z"']/.test(p.wider_observation), `${s.key}: wider_observation is a standalone sentence`);
      }

      const vars = [p.fair_observation, p.main_finding, p.commercial_consequence, p.wider_observation, p.wider_consequence].join(' ');
      assert.ok(!/Hi \{\{first_name\}\}|personalised breakdown|happy to send it over/i.test(vars), `${s.key}: no greeting or CTA leaks into a field`);
      assert.ok(!/NOVUS|leakage/i.test(vars), `${s.key}: the email copy does not sell NOVUS`);

      // And the assembled body is exactly what the assembler makes of that
      // row — nothing is stored that the fields do not reproduce.
      assert.strictEqual(p.email_body, assembleEmail(p), `${s.key}: email_body is the deterministic assembly of this row`);
      assert.ok(p.email_body.startsWith('Hi {{first_name}},'), `${s.key}: the email opens with the merge field`);
      // propertyReference() decides the wording: a road-only address reads as
      // "a house on Perry Street", never "about Perry Street".
      assert.ok(p.email_body.includes(`We sent your team an enquiry on 1 January about ${propertyReference(s.address)}.`),
        `${s.key}: the intro names this probe's own date and property`);
      assert.ok(p.email_body.includes(`${THAT_MEANT_PREFIX}${p.commercial_consequence}`), `${s.key}: "That meant " is assembled in code, once`);
      if (p.email_variant !== 'no_response') {
        // The locked paragraph order from the brief: fair observation (when
        // there is one), then the finding, then the consequence.
        assert.ok(p.email_body.includes(`${MAIN_FINDING_PREFIX}${p.main_finding}`), `${s.key}: the finding opens with the fixed "What stood out, though, was"`);
        assert.ok(p.email_body.indexOf(MAIN_FINDING_PREFIX) < p.email_body.indexOf(THAT_MEANT_PREFIX), `${s.key}: the finding comes before its consequence`);
        if (p.fair_observation) {
          assert.ok(p.email_body.includes(`${FAIR_OBSERVATION_PREFIX}${p.fair_observation}`), `${s.key}: the fair observation opens with the fixed "I want to say upfront that"`);
          assert.ok(p.email_body.indexOf(FAIR_OBSERVATION_PREFIX) < p.email_body.indexOf(MAIN_FINDING_PREFIX), `${s.key}: fairness comes first`);
        }
      }
      assert.ok(p.email_body.endsWith('\n\nJoe'), `${s.key}: and signs off`);
      assert.ok(!/audit/i.test(p.email_body), `${s.key}: the email never calls it an audit`);
    }

    const stories = SCENARIOS.map((s) => {
      const p = personalisationFor(store, s.probe_id);
      return [p.fair_observation, p.main_finding, p.commercial_consequence, p.wider_observation, p.wider_consequence].join('|');
    });
    assert.strictEqual(new Set(stories).size, SCENARIOS.length, 'all seven sets of email copy are genuinely different');
    const bodies = new Set(SCENARIOS.map((s) => personalisationFor(store, s.probe_id).email_body));
    assert.strictEqual(bodies.size, SCENARIOS.length, 'and so are all seven assembled emails');
    const journeys = new Set(SCENARIOS.map((s) => personalisationFor(store, s.probe_id).hero_journey));
    assert.ok(journeys.size >= 4, `the seven probes spread across ${journeys.size} distinct journeys, not one`);
    ok(`all seven probe shapes produce distinct email copy, distinct assembled emails, and spread across ${journeys.size} distinct breakdown/demo journeys — no two agencies get the same story`);
  }

  // ── 6. The no-response probe says so, plainly, with nothing invented ──
  {
    const p = personalisationFor(store, 'prb_none');
    assert.strictEqual(p.email_variant, 'no_response', 'it uses the no-response structure, not a normal email with gaps');
    assert.strictEqual(p.fair_observation, '', 'the model\'s invented praise is discarded — there was no handling to be fair about');
    assert.strictEqual(p.main_finding, '', 'and no main finding is narrated — the failure is the silence itself');
    assert.strictEqual(p.evidence, '', 'nothing was said, so nothing is quoted');

    // The fixed no-response shape, in order.
    const body = p.email_body;
    assert.ok(body.includes(`\n\n${NO_REPLY_LINE}\n\n`), 'the assembler supplies the plain no-reply line');
    assert.ok(body.endsWith(`${NO_RESPONSE_BREAKDOWN_LINE}\n\n${NO_RESPONSE_CTA_LINE}\n\nJoe`),
      'and it closes with the no-response variant\'s own locked two paragraphs');
    assert.ok(!body.includes(ADDITIONAL_FINDINGS_HOOK_LINE), 'never the normal tease on top of them');
    assert.ok(body.indexOf(NO_REPLY_LINE) < body.indexOf(THAT_MEANT_PREFIX), 'the silence is stated before its consequence');
    assert.strictEqual(p.wider_consequence, 'the property we said we had of our own was never picked up as a valuation.',
      'a seller opportunity our own enquiry declared still carries a wider consequence, as the continuation of the fixed "That also meant "');
    assert.ok(body.includes('\n\nWe had also mentioned a property of our own that we were thinking of selling.\n\n'),
      'and the observation that set it up is its own paragraph');
    assert.ok(body.includes(`\n\n${THAT_ALSO_MEANT_PREFIX}${p.wider_consequence}\n\n`), 'with the fixed wording supplied by the assembler, once');
    ok('the no-response probe gets its own fixed email structure — the plain no-reply line, no invented conversation, its consequence, and its own locked closing');
  }

  // ── 7. Idempotent: a second rebuild changes nothing ──
  {
    const before = JSON.stringify(store);
    const diagnoseBefore = diagnoseCalls;
    const personaliseBefore = personaliseCalls;

    const second = await runRebuildPass(repo, { maxAiCalls: 100 });
    assert.strictEqual(second.diagnosis.ai_diagnoses_run, 0, 'no diagnosis is regenerated');
    assert.strictEqual(second.personalisation.ai_personalisations_run, 0, 'no personalisation is regenerated');
    assert.strictEqual(second.diagnosis.findings_written, 0, 'no findings rows are rewritten');
    assert.strictEqual(diagnoseCalls, diagnoseBefore, 'no further diagnosis AI calls');
    assert.strictEqual(personaliseCalls, personaliseBefore, 'no further personalisation AI calls');

    const findingsRows = rowsOf(store, 'DIAGNOSIS_FINDINGS', DIAGNOSIS_FINDINGS_HEADER);
    const keys = findingsRows.map((f) => `${f.probe_id}#${f.finding_index}`);
    assert.strictEqual(new Set(keys).size, keys.length, 'no duplicate (probe_id, finding_index) rows');
    assert.strictEqual(JSON.stringify(store), before, 'the whole workbook is byte-identical after a second rebuild');
    ok('a second rebuild makes no AI calls, writes no duplicate findings rows, and leaves the workbook byte-identical');
  }

  // ── 8. Exactly one AI call per probe per layer — no extra call was added ──
  {
    assert.strictEqual(diagnoseCalls, SCENARIOS.length, 'one Diagnosis call per probe');
    assert.strictEqual(personaliseCalls, SCENARIOS.length, 'one Personalisation call per probe');
    ok('the flow costs exactly one Diagnosis call and one Personalisation call per probe — persisting findings added no AI call');
  }

  // ── 9. Personalisation never silently falls back to the Diagnosis prose ──
  //    An empty findings list is a REAL state — it means Diagnosis found no
  //    genuine problem, and the prompt says exactly that. So missing
  //    DIAGNOSIS_FINDINGS rows must never look like it: that would quietly
  //    tell the model a badly-handled enquiry was handled perfectly and let it
  //    write the story off the Diagnosis prose instead. A diagnosed probe with
  //    no rows falls back to the SAME findings out of its own DIAGNOSIS row's
  //    findings cell — and says so in the summary.
  {
    const { store: store2, repo: repo2 } = makeFakeSheet();
    __setRepoForTests(repo2);
    installAiStub();
    seed(store2);

    const scenario = byAddress.get('Compound Gardens');
    // The workbook this suite models has no DIAGNOSIS.findings column (it
    // mirrors the live V2 header, where the findings live in their own tab).
    // Recovery reads that cell, so this case adds it — which is also exactly
    // the shape a probe diagnosed before DIAGNOSIS_FINDINGS existed has.
    const DIAGNOSIS_HEADER_WITH_FINDINGS = [...DIAGNOSIS_HEADER, 'findings'];
    store2.DIAGNOSIS[0] = DIAGNOSIS_HEADER_WITH_FINDINGS.slice();

    // A probe finalised by a path that never wrote its findings rows: a
    // non-blank diagnosis_summary (so it is frozen, and the rebuild will never
    // regenerate it) with the findings only in the DIAGNOSIS row's own cell.
    store2.DIAGNOSIS.push(row(DIAGNOSIS_HEADER_WITH_FINDINGS, {
      probe_id: scenario.probe_id, agency_id: `agc_${scenario.key}`,
      findings: JSON.stringify(scenario.findings),
      strengths: scenario.strengths, missed_opportunities: 'Slow, unqualified, no viewing, seller ignored.',
      commercial_implication: 'Specific to Compound Gardens.', novus_opportunity: 'Core (front desk)',
      diagnosis_summary: 'Diagnosis for Compound Gardens.',
    }));

    const pass2 = await runRebuildPass(repo2, { maxAiCalls: 100, probeIds: [scenario.probe_id] });
    assert.strictEqual(pass2.diagnosis.ai_diagnoses_run, 0, 'the probe is frozen, so it is not re-diagnosed');
    assert.strictEqual(findingsFor(store2, scenario.probe_id).length, 0, 'and it genuinely has no DIAGNOSIS_FINDINGS rows');
    assert.strictEqual(pass2.personalisation.findings_recovered_from_diagnosis_row, 1,
      'the missing rows are reported, not absorbed in silence');
    assert.strictEqual(pass2.personalisation.personalisations_with_findings, 1,
      'and Personalisation ran WITH findings, not with an empty list');

    const prompt = personalisationPrompts.get(scenario.probe_id);
    for (const f of scenario.findings) {
      assert.ok(prompt.includes(f.finding), 'every finding still reaches the Personalisation prompt');
      assert.ok(prompt.includes(f.evidence), 'with its evidence');
    }
    assert.ok(!prompt.includes('(none — the evidence shows no genuine problem)'),
      'the prompt never tells the model this enquiry had no genuine problem when it had four');

    // And the primary path is unchanged: where the ROWS exist, they are what
    // is used, and nothing is recovered from the diagnosis row.
    assert.strictEqual(first.personalisation.findings_recovered_from_diagnosis_row, 0,
      'the first pass, where every probe had its rows, recovered nothing');
    assert.strictEqual(first.personalisation.personalisations_with_findings,
      SCENARIOS.filter((s) => s.findings.length > 0).length,
      'and every probe that has findings was personalised with them');
    ok('Personalisation is driven by the persisted DIAGNOSIS_FINDINGS rows, and a diagnosed probe missing them recovers the same findings from its DIAGNOSIS row rather than silently reading as "no problem found"');
  }

  console.log(`\n${passed} checks passed.`);
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
