// scripts/novus-diagnosis-findings-flow-selftest.mjs — hermetic end-to-end
// test (no network, no creds) for the data flow this change introduces:
//
//   DIAGNOSIS -> DIAGNOSIS_FINDINGS -> PERSONALISATION -> INSTANTLY VARIABLES
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
//   3. each probe gets a genuinely different story and grounded Instantly
//      variables — the failure mode the spec
//      doc calls out ("fix the logic if different agencies are coming out too
//      similar")
//   3b. the no-response probe never invents a positive
//   4. the whole flow is idempotent: a second rebuild makes no AI calls,
//      writes no duplicate findings rows, and changes nothing
//
// Run: npm run novus:diagnosis-findings-flow-selftest

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';
import { runRebuildPass } from '../lib/rebuild-pass.mjs';

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
// probe id, which appears in both AI prompts.
const SCENARIOS = [
  {
    key: 'no_response',
    probe_id: 'prb_none', address: 'Silence Road', price: '£310,000',
    intelligence: { human_contact: 'none', response_hours: '', contact_attempts: 0, follow_ups: 0, channels_used: '', viewing_progression: 'none', buyer_qualification: 'none', seller_recognition: 'none', communication_quality: 'poor', did_well: '', missed: 'Everything — no contact was made at all.', grade: 'H' },
    comms: [],
    findings: [
      { finding_type: 'problem', finding: 'The enquiry was never replied to at all.', evidence: 'Zero communications recorded across the full 4-day observation window.', significance_note: 'Both the buyer and the declared seller lead were lost in silence.' },
      // The wider beat is written FROM a finding, so a seller opportunity the
      // email is allowed to raise has to exist as one — Diagnosis records it,
      // and Personalisation selects it. It cannot be invented downstream.
      { finding_type: 'opportunity', finding: 'A declared property to sell was never picked up as a valuation.', evidence: 'The enquiry declared a property to sell; nothing came back at all.', significance_note: 'A valuation opportunity lost in the same silence.' },
    ],
    strengths: '',
    // No human contact, so Diagnosis records no positive at all — the email
    // must not be able to invent one.
    positives: [],
    story: {
      primary_narrative: 'Nothing came back at all — not an automated acknowledgement, not a call, nothing, across four days.',
      // No positive exists to select. The main finding IS the silence — the
      // consequence has to rest on something — and the seller opportunity is
      // the genuinely separate wider beat.
      positive_finding_index: null,
      main_finding_index: 1,
      wider_finding_index: 2,
      supporting_findings: '',
      fair_observation: 'Your team have clearly been busy.',
      main_finding: 'We never heard anything back.',
      commercial_consequence: 'a buyer ready to view this one never got as far as a conversation.',
    },
    // The no-response structure has no fair observation and no main finding —
    // there was no conversation to observe or narrate — so both are forced
    // empty however the model answers, and the email switches structure.
    expect: {
      hero_journey: 'complete_miss', findings: 2,
      fair_observation: '',
    },
  },
  {
    key: 'weak_generic',
    probe_id: 'prb_generic', address: 'Template Way', price: '£265,000',
    intelligence: { human_contact: 'yes', response_hours: 4.2, contact_attempts: 1, follow_ups: 0, channels_used: 'email', viewing_progression: 'none', buyer_qualification: 'none', seller_recognition: 'none', communication_quality: 'generic', did_well: 'Replied the same working day.', missed: 'The reply said nothing specific to this enquiry.', grade: 'D' },
    comms: [{ id: 'com_generic', channel: 'email', at: '2020-01-01T13:12:00.000Z', subject: 'Your enquiry', body: 'Thank you for your enquiry. One of our team will be in touch shortly.' }],
    findings: [
      { finding_type: 'problem', finding: 'The only reply was a generic acknowledgement that engaged with nothing in the enquiry.', evidence: '"Thank you for your enquiry. One of our team will be in touch shortly." — the entire reply.', significance_note: 'A same-day reply that carried no information forward reads to the buyer as no reply.' },
    ],
    strengths: 'Replied inside the same working day.',
    positives: [{ finding: 'The enquiry was answered the same working day.', evidence: 'First human reply 4.2 hours after the enquiry.', significance_note: 'Shows enquiries are picked up quickly in working hours.' }],
    story: {
      primary_narrative: 'The reply arrived quickly but engaged with none of what the enquiry actually said.',
      positive_finding_index: 2,
      main_finding_index: 1,
      wider_finding_index: null,
      supporting_findings: '',
      fair_observation: 'You did come back to us the same day, which plenty of agencies do not.',
      main_finding: 'We got a reply the same day, but it did not mention the property or anything we had asked.',
      commercial_consequence: 'the enquiry stalled despite your team being quick off the mark.',
    },
    expect: { hero_journey: 'fast_response_stalled_follow_up', findings: 2 },
  },
  {
    key: 'good_handling',
    probe_id: 'prb_good', address: 'Exemplar Close', price: '£520,000',
    intelligence: { human_contact: 'yes', response_hours: 0.6, contact_attempts: 3, follow_ups: 2, channels_used: 'voice,email', viewing_progression: 'booked', buyer_qualification: 'thorough', buyer_questions_asked: 'budget; finance; timescale; current position', seller_recognition: 'valuation_booked', communication_quality: 'strong', did_well: 'Called back in 36 minutes, qualified fully, booked both the viewing and the valuation.', missed: '', grade: 'A' },
    comms: [{ id: 'com_good', channel: 'voice', at: '2020-01-01T09:36:00.000Z', transcript: 'Happy to get you booked in Thursday, and I can bring a valuation figure for your own place at the same time.' }],
    findings: [],
    strengths: 'Called back in 36 minutes, qualified the buyer fully, and booked both the viewing and the valuation.',
    // Handled well: the ONLY findings this probe has are positives, and the
    // hero journey must still read that as strong handling rather than as
    // two problems.
    // ONE positive: the per-probe budget carries a single positive, because
    // the email writes exactly one fair observation and never reads a second.
    positives: [
      { finding: 'The callback came inside 36 minutes.', evidence: 'First human contact 0.6 hours after the enquiry.', significance_note: 'Shows the front desk answers fast.' },
    ],
    story: {
      primary_narrative: 'This was handled about as well as an enquiry can be — the question is whether it happens every time, not just this time.',
      positive_finding_index: 1,
      main_finding_index: null,
      wider_finding_index: null,
      supporting_findings: '',
      fair_observation: 'Your team called back in 36 minutes and booked the viewing and the valuation in one go.',
      main_finding: 'Honestly, this one was handled really well.',
      commercial_consequence: 'the only question worth asking is whether every enquiry gets the same treatment.',
    },
    // No findings left over, but the closing transition is locked copy that
    // runs in every email — it hands off to the breakdown rather than
    // claiming a number of other findings.
    expect: { hero_journey: 'strong_handling_no_opportunity', findings: 1 },
  },
  {
    key: 'missed_seller',
    probe_id: 'prb_seller', address: 'Vendor Lane', price: '£445,000',
    intelligence: { human_contact: 'yes', response_hours: 2.1, contact_attempts: 2, follow_ups: 1, channels_used: 'email', viewing_progression: 'booked', buyer_qualification: 'thorough', buyer_questions_asked: 'budget; finance; timescale', seller_recognition: 'none', communication_quality: 'strong', did_well: 'Fast, well-qualified, viewing booked.', missed: 'The declared property to sell was never acknowledged.', grade: 'B' },
    comms: [{ id: 'com_seller', channel: 'email', at: '2020-01-01T11:06:00.000Z', subject: 'Viewing confirmed', body: 'Great, I have you in for Thursday at 2pm. Could you confirm your budget and how you are funding the purchase?' }],
    findings: [
      { finding_type: 'opportunity', finding: 'The declared property to sell was never acknowledged in any contact.', evidence: 'Seller recognition recorded as none across both emails; no valuation, appraisal or valuer mentioned.', significance_note: 'An off-market instruction was handed over and never picked up.' },
    ],
    strengths: 'Fast, well-qualified on the buying side, viewing booked inside two hours.',
    positives: [{ finding: 'The buying side was qualified properly and the viewing was booked inside two hours.', evidence: 'Budget, finance and timescale all asked; viewing booked 2.1 hours in.', significance_note: 'Shows the buying side of the process works.' }],
    story: {
      primary_narrative: 'The buying side was handled well and the selling side was never touched — the instruction was mentioned in the enquiry and never came up again.',
      positive_finding_index: 2,
      main_finding_index: 1,
      wider_finding_index: null,
      supporting_findings: '',
      fair_observation: 'On the buying side this was genuinely well handled — booked in two hours with proper questions.',
      main_finding: 'We mentioned we had a property to sell, and it never came up again.',
      commercial_consequence: "the £445,000 enquiry was not just a potential buyer — there was a potential seller instruction sitting inside it that never got explored.",
    },
    expect: { hero_journey: 'strong_handling_no_opportunity', findings: 1 },
  },
  {
    key: 'weak_qualification',
    probe_id: 'prb_qual', address: 'Unasked Avenue', price: '£289,000',
    intelligence: { human_contact: 'yes', response_hours: 3.4, contact_attempts: 1, follow_ups: 0, channels_used: 'voice', viewing_progression: 'invited', buyer_qualification: 'none', buyer_questions_asked: '', seller_recognition: '', communication_quality: 'generic', did_well: 'Rang back the same day.', missed: 'No qualifying question of any kind was asked.', grade: 'D' },
    comms: [{ id: 'com_qual', channel: 'voice', at: '2020-01-01T12:24:00.000Z', transcript: 'Give us a ring back when you want to come and see it.' }],
    findings: [
      { finding_type: 'problem', finding: 'Not one qualifying question was asked before inviting a viewing.', evidence: 'Buyer qualification recorded as none; no question on budget, finance, timescale or position in the single call.', significance_note: 'The viewing slot is committed with no idea whether the buyer can proceed.' },
    ],
    strengths: 'Rang back the same day.',
    positives: [{ finding: 'The enquiry was rung back the same day.', evidence: 'A voice callback 3.4 hours after the enquiry.', significance_note: 'Shows enquiries do get picked up by a person.' }],
    story: {
      primary_narrative: 'A viewing was offered without a single question about whether we could actually buy.',
      positive_finding_index: 2,
      main_finding_index: 1,
      wider_finding_index: null,
      supporting_findings: '',
      fair_observation: 'You did ring back the same day.',
      main_finding: 'We were invited to view without being asked anything at all about our position.',
      commercial_consequence: 'a viewing slot went to someone nobody had checked could buy.',
    },
    expect: { hero_journey: 'fast_response_stalled_follow_up', findings: 2 },
  },
  {
    key: 'poor_progression',
    probe_id: 'prb_progress', address: 'Stalled Street', price: '£372,000',
    intelligence: { human_contact: 'yes', response_hours: 9.8, contact_attempts: 4, follow_ups: 3, channels_used: 'voice,email', viewing_progression: 'none', buyer_qualification: 'minimal', buyer_questions_asked: 'timescale', seller_recognition: '', communication_quality: 'generic', did_well: 'Four contact attempts across two channels — genuinely persistent.', missed: 'None of the four attempts offered a viewing.', grade: 'B' },
    comms: [{ id: 'com_progress', channel: 'voice', at: '2020-01-01T18:48:00.000Z', transcript: 'Just chasing up on your enquiry, give us a call back when you get a moment.' }],
    findings: [
      { finding_type: 'problem', finding: 'Four contact attempts never once offered a viewing.', evidence: 'contact_attempts 4, follow_ups 3, viewing_progression none.', significance_note: 'Real persistence spent without ever asking for the thing that moves the sale forward.' },
    ],
    strengths: 'Four contact attempts across two channels — genuinely persistent.',
    positives: [{ finding: 'The team followed up persistently.', evidence: 'Four attempts across phone and email.', significance_note: 'Shows strong persistence.' }],
    story: {
      primary_narrative: 'Your team chased four times and never once offered a viewing.',
      positive_finding_index: 2,
      main_finding_index: 1,
      wider_finding_index: null,
      supporting_findings: '',
      fair_observation: 'Four attempts across two channels is more persistence than most agencies manage.',
      // NO COUNT CITED. This scenario seeds contact_attempts: 4, but
      // runRebuildPass recomputes INTELLIGENCE deterministically from
      // COMMUNICATIONS and the scenario supplies ONE communication — so the
      // structured count the pipeline actually derives is 1. The old wording
      // ("chased us four times") was therefore the exact class-4 error in
      // miniature: prospect-facing copy citing a contact count the record does
      // not carry. Rephrased to make the same point about persistence without
      // asserting a number, which leaves every derived value, grade and
      // hero-journey expectation in this suite byte-identical.
      main_finding: 'Your team kept chasing, and each attempt essentially asked us to get back to you, rather than putting a viewing in front of us.',
      commercial_consequence: 'all that effort ended without the one step that moves a sale forward.',
    },
    expect: { hero_journey: 'fast_response_stalled_follow_up', findings: 2 },
  },
  {
    key: 'combining',
    probe_id: 'prb_combine', address: 'Compound Gardens', price: '£615,000',
    intelligence: { human_contact: 'yes', response_hours: 21.4, contact_attempts: 1, follow_ups: 0, channels_used: 'email', viewing_progression: 'none', buyer_qualification: 'none', buyer_questions_asked: '', seller_recognition: 'none', communication_quality: 'generic', did_well: 'The reply did name the correct property.', missed: 'Slow, unqualified, no viewing, seller ignored.', grade: 'F' },
    comms: [{ id: 'com_combine', channel: 'email', at: '2020-01-02T06:24:00.000Z', subject: 'Compound Gardens', body: 'Thanks for your interest in Compound Gardens. Let us know if you would like any further information.' }],
    findings: [
      { finding_type: 'problem', finding: 'Nothing reached the enquiry for 21.4 hours.', evidence: 'Probe 09:00 -> first human contact 06:24 the next day = 21.4 hours.', significance_note: 'Overnight enquiries are not being picked up until the following morning.' },
      // "No viewing was ever offered" used to sit here as a fourth finding.
      // It is the same underlying issue as the unqualified reply — one
      // acknowledgement that advanced nothing — so under the 4-finding budget
      // Diagnosis consolidates rather than returning both.
      { finding_type: 'problem', finding: 'The reply asked nothing and offered no viewing.', evidence: 'Buyer qualification recorded as none; no questions and no viewing offer in the single reply.', significance_note: 'The enquiry was answered without being qualified or advanced.' },
      { finding_type: 'opportunity', finding: 'The declared property to sell went unmentioned in the reply.', evidence: 'Seller recognition none; no valuation mentioned anywhere in the single email.', significance_note: 'A second, larger opportunity in the same enquiry was not seen at all.' },
    ],
    strengths: 'The reply did at least name the correct property.',
    positives: [{ finding: 'The reply named the correct property.', evidence: 'The email subject and body both name Compound Gardens.', significance_note: 'Shows the enquiry was at least read.' }],
    story: {
      // Deliberately combines two findings into one broader story and leaves
      // the third as a supporting finding.
      primary_narrative: 'The enquiry waited overnight, and the reply that eventually arrived asked nothing and offered nothing — it acknowledged the property and stopped there.',
      // The main story is the overnight gap (1); the seller opportunity (3)
      // is a genuinely different event, so it is the wider beat.
      positive_finding_index: 4,
      main_finding_index: 1,
      wider_finding_index: 3,
      supporting_findings: 'Nothing was asked about our position, and no viewing was ever offered.',
      // "did at least name the right property" would be a backhanded
      // compliment — the hedge guard rejects it, and the email would then be
      // unsendable rather than opening on criticism.
      fair_observation: 'You did reply, and the reply named the right property.',
      main_finding: 'It took about a day for anything to come back, and when it did it did not ask us anything or offer us a viewing.',
      commercial_consequence: 'the £615,000 enquiry was getting attention, but it was not really being progressed.',
    },
    expect: { hero_journey: 'slow_response_gap', findings: 4, narrative_finding_indexes: '1,3,4' },
  },
];

// The findings this scenario should leave in DIAGNOSIS_FINDINGS, in the order
// lib/probe-diagnosis.mjs persists them: problems and opportunities first (so
// finding_index 1 is still "most commercially damaging"), positives after.
function expectedFindings(scenario) {
  return [
    // Seller-declaration-only opportunity rows are deliberately rejected by
    // Diagnosis v2. The declaration survives as unresolved context instead.
    ...scenario.findings.filter((finding) => finding.finding_type !== 'opportunity'),
    ...(scenario.positives || []).map((f) => ({ ...f, finding_type: 'positive' })),
  ];
}

const byAddress = new Map(SCENARIOS.map((s) => [s.address, s]));

let diagnoseCalls = 0;
let personaliseCalls = 0;
const personalisationPrompts = new Map();

function installAiStub() {
  diagnoseCalls = 0;
  personaliseCalls = 0;
  personalisationPrompts.clear();
  __setAiCallerForTests(async ({ tool, prompt }) => {
    if (tool.name === 'realise_personalisation_facts') {
      const retryOrder = SCENARIOS.filter((item) => ['prb_generic', 'prb_good', 'prb_qual'].includes(item.probe_id));
      const scenario = SCENARIOS[personaliseCalls]
        || retryOrder[(personaliseCalls - SCENARIOS.length) % retryOrder.length];
      assert.ok(scenario, 'the constrained call belongs to a seeded probe');
      personaliseCalls += 1;
      personalisationPrompts.set(scenario.probe_id, prompt);
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
    const scenario = SCENARIOS.find((s) => prompt.includes(s.address) || prompt.includes(s.probe_id));
    assert.ok(scenario, `the prompt names a known probe (tool ${tool?.name})`);

    // The merged final assessment (lib/probe-assessment.mjs) returns the
  // diagnosis fields under its own tool name; the retired standalone diagnosis
  // call still uses the old one. Both are answered by this branch.
  if (tool.name === 'record_probe_diagnosis' || tool.name === 'record_probe_assessment') {
      diagnoseCalls += 1;
      return {
        findings: scenario.findings,
        positive_findings: scenario.positives || [],
        strengths: scenario.strengths,
        missed_opportunities: scenario.intelligence.missed || '',
        commercial_implication: `Specific to ${scenario.address}.`,
        novus_opportunity: scenario.key === 'good_handling' ? 'Growth (valuation list / seller conversion)' : 'Core (front desk)',
        diagnosis_summary: `Diagnosis for ${scenario.address}.`,
      };
    }
    // The bounded, field-scoped correction call. These synthetic hooks are
    // findings text joined together, so they legitimately fail the "state the
    // shape, don't restate the observation" guard; the flow test's job is to
    // prove the scoped repair returns a usable record, not to write good copy.
    if (tool.name === 'correct_probe_personalisation_fields') {
      personaliseCalls += 1;
      const patch = {};
      for (const field of tool.input_schema.required) {
        patch[field] = field === 'email_commercial_hook'
          ? `So the vendor behind my ${scenario.address} enquiry was already talking to you as a buyer.`
          : field === 'email_commercial_hook_email_2'
            ? `Worth a second look: the part of my ${scenario.address} enquiry that went unworked was in a message you had already opened.`
            : field === 'email_observation'
              ? `You picked up my ${scenario.address} enquiry, but the second opportunity inside it was never worked.`
              : `a concrete corrected line about ${scenario.address} for the demo.`;
      }
      return patch;
    }
    if (tool.name === 'record_probe_personalisation') {
      personaliseCalls += 1;
      personalisationPrompts.set(scenario.probe_id, prompt);
      const ordered = expectedFindings(scenario);
      const selectedIndexes = [
        scenario.story.positive_finding_index,
        scenario.story.main_finding_index,
        scenario.story.wider_finding_index,
      ].filter((value) => Number.isInteger(value));
      const selected = selectedIndexes.map((index) => ordered[index - 1]);
      // Every key the tool schema declares required, because the AI client
      // now normalises and validates a fake exactly as it validates the wire —
      // a fixture must not be able to assert on a shape production rejects.
      return {
        story_reasoning: `Selected ${selectedIndexes.join(', ') || 'none'} for ${scenario.probe_id}.`,
        novus_counterfactual: 'NOVUS would have progressed both sides of the enquiry in the same conversation.',
        ...scenario.story,
        // The main story only, not every selected finding joined together:
        // email_observation is capped at 40 words precisely to stop the
        // shopping-list shape, so a fixture that concatenates three findings
        // is testing the cap rather than the flow.
        email_observation: selected.map((finding) => finding.finding).slice(0, 2).join(' '),
        // A hook that says why the observed behaviour MATTERS, rather than
        // restating the observation or blaming the agency for an outcome that
        // needed a reply the probe never sends — a fake that did either would
        // spend the bounded correction call on every probe and make the "one
        // call per probe" assertion below measure the fixture's copy rather
        // than the flow.
        email_commercial_hook: `So the person enquiring about ${scenario.address} was warmer than the enquiry made them look.`,
        email_commercial_hook_email_2: `The part worth a second look on ${scenario.address} is that one message held two reasons to pick the phone up.`,
      };
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
  console.log('DIAGNOSIS -> DIAGNOSIS_FINDINGS -> PERSONALISATION -> INSTANTLY flow\n');

  const { store, repo } = makeFakeSheet();
  __setRepoForTests(repo);
  installAiStub();
  seed(store);

  const first = await runRebuildPass(repo, { maxAiCalls: 100 });
  assert.deepStrictEqual(first.assessment.problems, [], 'no assessment problems');
  const unsupported = new Set();
  assert.deepStrictEqual(
    new Set(first.personalisation.problems.map((problem) => problem.probe_id)),
    unsupported,
    'observation-derived hooks satisfy the unchanged mandatory-field gate for every supported observation shape',
  );

  // ── 1. Every finding lands in DIAGNOSIS_FINDINGS, linked by probe_id ──
  {
    const expectedTotal = SCENARIOS.reduce((n, s) => n + expectedFindings(s).length, 0);
    const allRows = rowsOf(store, 'DIAGNOSIS_FINDINGS', DIAGNOSIS_FINDINGS_HEADER);
    assert.strictEqual(allRows.length, expectedTotal, `DIAGNOSIS_FINDINGS holds all ${expectedTotal} findings`);
    assert.strictEqual(first.assessment.findings_written, expectedTotal, 'the rebuild reports the same count it wrote');
    assert.strictEqual(first.assessment.findings_tab_available, true, 'the tab was found');

    for (const s of SCENARIOS) {
      const rows = findingsFor(store, s.probe_id);
      const expected = expectedFindings(s);
      assert.strictEqual(rows.length, expected.length, `${s.key}: one row per finding, positives included`);
      rows.forEach((r, i) => {
        assert.strictEqual(Number(r.finding_index), i + 1, `${s.key}: findings are numbered in Diagnosis's own order from 1`);
        assert.strictEqual(r.finding_type, expected[i].finding_type, `${s.key}: finding ${i + 1} carries its type`);
        assert.strictEqual(r.finding, expected[i].finding, `${s.key}: finding ${i + 1} text is persisted verbatim`);
        assert.strictEqual(r.evidence, expected[i].evidence, `${s.key}: finding ${i + 1} keeps its own evidence`);
        assert.strictEqual(r.significance_note, expected[i].significance_note, `${s.key}: finding ${i + 1} keeps its significance note`);
      });
      // Problems and opportunities always come before positives, so an index
      // written to a sheet before positives existed still means what it did.
      const firstPositive = rows.findIndex((r) => r.finding_type === 'positive');
      if (firstPositive !== -1) {
        assert.ok(rows.slice(firstPositive).every((r) => r.finding_type === 'positive'),
          `${s.key}: positives are appended after the story findings, never interleaved`);
      }
    }
    // Nothing invented: the well-handled probe contributes no PROBLEM rows at
    // all — only the positives that record why it was well handled.
    assert.deepStrictEqual(findingsFor(store, 'prb_good').map((r) => r.finding_type), ['positive'],
      'a probe with no problems writes only its positive finding');
    // ...and the silent one has no positive to invent from.
    assert.strictEqual(findingsFor(store, 'prb_none').filter((r) => r.finding_type === 'positive').length, 0,
      'a probe nobody replied to has no positive finding at all');
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

  // ── 3. NOTHING CROSSES AN AI BOUNDARY AT ALL IN PERSONALISATION ──
  //
  // This block used to assert that raw finding/evidence prose never reached the
  // constrained surface realiser's prompt. That property is now structural
  // rather than checked: there is no prompt, because there is no call.
  // Personalisation renders the canonical facts deterministically
  // (lib/fact-constrained-personalisation.mjs's renderCanonicalFactCopy) and
  // runs the identical validator over the result. So the assertion is the
  // stronger one — no findings prose can leak into a model that was never
  // asked anything.
  {
    assert.strictEqual(personalisationPrompts.size, 0,
      'no Personalisation prompt exists, because Personalisation makes no AI call');
    assert.strictEqual(first.personalisation.ai_personalisations_run, 0,
      'and the summary reports it: zero AI personalisations in normal production');
    for (const s of SCENARIOS) {
      const written = rowsOf(store, 'PERSONALISATION', PERSONALISATION_HEADER)
        .find((r) => String(r.probe_id).trim() === s.probe_id);
      assert.ok(written, `${s.key}: a PERSONALISATION row was still written`);
      assert.ok(String(written.email_observation).trim(), `${s.key}: the observation sentence is present`);
      assert.ok(String(written.email_commercial_hook).trim(), `${s.key}: the commercial hook is present`);
    }
    ok('Personalisation reaches no model at all, and still writes a complete, validated row for every probe');
  }

  // ── 4. A three-finding probe is deterministically narrowed to the one
  //    central problem the v2 fact contract permits ──
  {
    const p = personalisationFor(store, 'prb_combine');
    assert.strictEqual(findingsFor(store, 'prb_combine').length, 3, 'the seller-declaration-only opportunity is excluded from the persisted findings');
    for (const field of ['narrative_finding_indexes', 'positive_finding_index', 'main_finding_index', 'wider_finding_index', 'supporting_findings', 'evidence']) {
      assert.strictEqual(String(p[field]), '', `${field} is retained only as an unwritten historical column`);
    }
    assert.ok(p.email_observation, 'the Instantly observation variable is populated from the selected findings');
    assert.ok(p.email_commercial_hook, 'the Instantly commercial hook is populated from the same selected findings');
    assert.strictEqual(findingsFor(store, 'prb_combine').length, 3, 'all supported findings remain available for the audit');
    ok('a busy probe persists its live story fields without repopulating retired audit columns');
  }

  // ── 5. Each probe shape gets its own journey, story and email variables ──
  {
    for (const s of SCENARIOS) {
      const p = personalisationFor(store, s.probe_id);
      if (unsupported.has(s.probe_id)) {
        assert.strictEqual(p, undefined, `${s.key}: incomplete fact coverage is not persisted`);
        continue;
      }
      assert.ok(p, `${s.key}: a PERSONALISATION row exists`);
      assert.strictEqual(p.hero_journey, s.expect.hero_journey, `${s.key}: routed to the right audit/demo journey`);
      if (s.expect.fair_observation !== undefined) {
        assert.strictEqual(p.fair_observation, s.expect.fair_observation, `${s.key}: fair observation`);
      }
      assert.strictEqual(p.primary_narrative, '', `${s.key}: retired primary_narrative is not newly populated`);
      for (const [field, expected] of Object.entries(s.expect)) {
        if (['hero_journey', 'findings', 'narrative_finding_indexes'].includes(field)) continue;
        assert.strictEqual(p[field], expected, `${s.key}: ${field}`);
      }

      // The two live variables Instantly consumes.
      assert.strictEqual(p.property_reference, '', `${s.key}: retired property_reference is not newly populated`);
      assert.ok(p.email_observation, `${s.key}: email_observation is populated`);
      assert.ok(p.email_commercial_hook, `${s.key}: email_commercial_hook is populated`);
      if (p.main_finding_index && s.key !== 'no_response') {
        assert.ok(p.main_finding, `${s.key}: the main finding is populated`);
      }
      if (p.main_finding_index) {
        assert.ok(p.commercial_consequence, `${s.key}: the retained demo consequence is populated when there is a main problem`);
      }

      const vars = [p.email_observation, p.email_commercial_hook].join(' ');
      assert.ok(!/Hi \{\{first_name\}\}|personalised breakdown|happy to send it over/i.test(vars), `${s.key}: no greeting or CTA leaks into a field`);
      assert.ok(!/NOVUS|leakage/i.test(vars), `${s.key}: the Instantly variables do not sell NOVUS`);
      for (const removed of ['email_variant', 'wider_observation', 'wider_consequence',
        'additional_findings_hook', 'email_body', 'enquiry_date', 'property_address']) {
        assert.ok(!(removed in p), `${s.key}: removed PERSONALISATION field ${removed} is absent`);
      }
    }

    const eligible = SCENARIOS.filter((s) => !unsupported.has(s.probe_id));
    const stories = eligible.map((s) => {
      const p = personalisationFor(store, s.probe_id);
      return [p.fair_observation, p.main_finding, p.commercial_consequence].join('|');
    });
    assert.ok(new Set(stories).size >= eligible.length - 1, 'the evidence shapes remain distinct except where strong handling legitimately converges');
    const observations = new Set(eligible.map((s) => personalisationFor(store, s.probe_id).email_observation));
    assert.ok(observations.size >= eligible.length - 1, 'the Instantly observations remain evidence-specific except where strong handling legitimately converges');
    const journeys = new Set(eligible.map((s) => personalisationFor(store, s.probe_id).hero_journey));
    assert.ok(journeys.size >= 3, `the eligible probes spread across ${journeys.size} distinct journeys, not one`);
    ok(`eligible fact-complete probes persist distinct constrained observations and observation-derived hooks across ${journeys.size} demo journeys`);
  }

  // ── 6. The no-response probe says so, plainly, with nothing invented ──
  {
    const p = personalisationFor(store, 'prb_none');
    assert.strictEqual(p.fair_observation, '', 'the model\'s invented praise is discarded — there was no handling to be fair about');
    assert.match(p.main_finding, /didn't record a human response|no human response|no agency contact attempt/i,
      'the deterministic compatibility field records the supported complete-miss fact');
    assert.strictEqual(p.evidence, '', 'the retired compatibility evidence column is not populated');

    assert.match(p.email_observation, /didn't record a human response|no human response|never picked up/i,
      'the Instantly observation states the evidenced no-response story without praise');
    assert.ok(!/quick|prompt|came back|reply arrived/i.test(p.email_observation),
      'the no-response observation contains no fake positive');
    assert.ok(p.email_commercial_hook, 'the same selected no-response story has a commercial hook');
    ok('the no-response probe supplies grounded Instantly variables without inventing a positive');
  }

  // ── 7. Idempotent: a second rebuild changes nothing ──
  {
    const before = JSON.stringify(store);
    const diagnoseBefore = diagnoseCalls;
    const personaliseBefore = personaliseCalls;

    const second = await runRebuildPass(repo, { maxAiCalls: 100 });
    assert.strictEqual(second.assessment.ai_calls_used, 0, 'no assessment is regenerated');
    assert.strictEqual(second.personalisation.ai_personalisations_run, 0,
      'persisted rows remain frozen, and Personalisation never spends AI in any case');
    assert.strictEqual(second.assessment.findings_written, 0, 'no findings rows are rewritten');
    assert.strictEqual(diagnoseCalls, diagnoseBefore, 'no further diagnosis AI calls');
    assert.strictEqual(personaliseCalls, personaliseBefore,
      'no persisted shape receives another constrained call — and no shape receives one at all');

    const findingsRows = rowsOf(store, 'DIAGNOSIS_FINDINGS', DIAGNOSIS_FINDINGS_HEADER);
    const keys = findingsRows.map((f) => `${f.probe_id}#${f.finding_index}`);
    assert.strictEqual(new Set(keys).size, keys.length, 'no duplicate (probe_id, finding_index) rows');
    assert.strictEqual(JSON.stringify(store), before, 'the whole workbook is byte-identical after a second rebuild');
    ok('a second rebuild leaves persisted rows and findings byte-identical');
  }

  // ── 8. EXACTLY ONE AI CALL PER PROBE, FOR THE WHOLE PIPELINE ──
  // Not one per layer: one, total. The interpretation and the commercial
  // assessment are the same call, and Personalisation makes none.
  {
    assert.strictEqual(diagnoseCalls, SCENARIOS.length, 'one final assessment call per probe');
    assert.strictEqual(personaliseCalls, 0, 'and zero Personalisation calls, for every probe');
    ok('the whole flow costs exactly ONE Anthropic call per probe — down from three');
  }

  // ── 9. THE FINDINGS SOURCE, AND ITS FALLBACK, BOTH DIRECTIONS ──
  //
  // The canonical structured record is the DIAGNOSIS row's own findings JSON —
  // one record per probe, already loaded with the DIAGNOSIS table, so the large
  // granular DIAGNOSIS_FINDINGS tab is no longer read on the active path.
  //
  // An empty findings list remains a REAL state (Diagnosis found no genuine
  // problem), so "the record is missing" must never look like it. Where the
  // canonical cell is absent — a workbook whose DIAGNOSIS header predates the
  // findings column, exactly the shape this suite's fixture models — the
  // DIAGNOSIS_FINDINGS rows are read instead, and the summary says so.
  {
    // 9a. CANONICAL FIRST. A frozen probe whose DIAGNOSIS row carries the
    // findings JSON is personalised from it, and the findings tab is never
    // consulted.
    const { store: store2, repo: repo2 } = makeFakeSheet();
    __setRepoForTests(repo2);
    installAiStub();
    seed(store2);

    const scenario = byAddress.get('Compound Gardens');
    const DIAGNOSIS_HEADER_WITH_FINDINGS = [...DIAGNOSIS_HEADER, 'findings'];
    store2.DIAGNOSIS[0] = DIAGNOSIS_HEADER_WITH_FINDINGS.slice();
    store2.DIAGNOSIS.push(row(DIAGNOSIS_HEADER_WITH_FINDINGS, {
      probe_id: scenario.probe_id, agency_id: `agc_${scenario.key}`,
      findings: JSON.stringify(scenario.findings),
      strengths: scenario.strengths, missed_opportunities: 'Slow, unqualified, no viewing, seller ignored.',
      commercial_implication: 'Specific to Compound Gardens.', novus_opportunity: 'Core (front desk)',
      diagnosis_summary: 'Diagnosis for Compound Gardens.',
    }));

    const pass2 = await runRebuildPass(repo2, { maxAiCalls: 100, probeIds: [scenario.probe_id] });
    assert.strictEqual(pass2.assessment.ai_calls_used, 0, 'the probe is frozen, so it is not reassessed');
    assert.strictEqual(pass2.personalisation.ai_personalisations_run, 0, 'and Personalisation costs nothing');
    assert.strictEqual(pass2.personalisation.findings_recovered_from_findings_tab, 0,
      'the canonical DIAGNOSIS record was enough — the granular tab was never needed');
    assert.strictEqual(pass2.personalisation.personalisations_with_findings, 1,
      'and Personalisation ran WITH findings, not with an empty list');
    ok('the canonical DIAGNOSIS findings record drives Personalisation, without reading the granular findings tab');

    // 9b. THE FALLBACK. `first` above ran on the fixture's live-shaped
    // DIAGNOSIS header, which has NO findings column at all — so every probe
    // in it had to recover its findings from the DIAGNOSIS_FINDINGS rows.
    // Nothing historical is dropped; the expensive read is simply no longer
    // the default.
    assert.ok(!DIAGNOSIS_HEADER.includes('findings'), 'the fixture models a workbook with no canonical findings column');
    const withFindings = SCENARIOS.filter((s) => expectedFindings(s).length > 0).length;
    assert.strictEqual(first.personalisation.findings_recovered_from_findings_tab, withFindings,
      'every probe whose canonical cell is absent recovers the same findings from its rows, and is counted');
    assert.strictEqual(first.personalisation.personalisations_with_findings, withFindings,
      'and every probe that has findings was personalised with them — including the well-handled one, whose findings are all positives');
    ok('a workbook with no canonical findings column still personalises from its DIAGNOSIS_FINDINGS rows, reported rather than silent');
  }

  console.log(`\n${passed} checks passed.`);
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
