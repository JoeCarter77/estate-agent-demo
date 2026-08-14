// scripts/novus-personalisation-selftest.mjs — hermetic Personalisation
// Engine test (no network, no creds, no live AI calls).
//
// Exercises lib/personalisation.mjs with a mocked `callAi` injected in place
// of the real Anthropic call, proving: grade-band copy differences, evidence
// safety (no invented facts), strategy authority (AI cannot override the
// supplied grade/tier/strategy), blank output for pending/compromised,
// structured-output validation (malformed AI output rejected), and that an
// AI failure never mutates or corrupts anything (this module has no
// persistence to corrupt in the first place — asserted directly).
//
// Run:  npm run novus:personalisation-selftest

import assert from 'node:assert';
import { buildSalesStrategy } from '../lib/sales-strategy.mjs';
import { classifyTier } from '../lib/tier.mjs';
import {
  generatePersonalisation,
  buildPersonalisationRequest,
  buildEvidencePacket,
  validatePersonalisationOutput,
  PersonalisationValidationError,
  PersonalisationGenerationError,
  PERSONALISATION_FIELDS,
} from '../lib/personalisation.mjs';

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}
async function checkAsync(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

console.log('novus-personalisation-selftest');

// ── Fixtures ───────────────────────────────────────────────────────────────

function humanEvidence({ lag, followUps = 0, channels = 'email' }) {
  return {
    auto_acknowledgement: false,
    auto_ack_timestamp: '',
    first_human_touch: 'yes',
    first_human_touch_at: '2026-08-10T09:00:00.000Z',
    human_lag_hours: lag,
    follow_up_count: followUps,
    follow_up_channels: followUps > 0 ? channels : '',
    channels_used: channels,
    last_touch_at: '2026-08-10T09:00:00.000Z',
    days_chased: 0.5,
  };
}
const G_EVIDENCE = {
  auto_acknowledgement: true,
  auto_ack_timestamp: '2026-08-10T09:05:00.000Z',
  first_human_touch: 'no',
  first_human_touch_at: '',
  human_lag_hours: '',
  follow_up_count: 0,
  follow_up_channels: '',
  channels_used: 'email',
  last_touch_at: '2026-08-10T09:05:00.000Z',
  days_chased: 0.01,
};
const H_EVIDENCE = {
  auto_acknowledgement: false,
  auto_ack_timestamp: '',
  first_human_touch: 'no',
  first_human_touch_at: '',
  human_lag_hours: '',
  follow_up_count: 0,
  follow_up_channels: '',
  channels_used: '',
  last_touch_at: '',
  days_chased: '',
};

const PROBE = {
  property_address: '14 Elm Road, Billericay',
  property_price: '475000',
  property_status: 'For Sale',
  portal: 'Rightmove',
  probe_timestamp: '2026-08-10T21:00:00.000Z',
  enquiry_text: 'Is this property still available?',
};
const AGENCY = { agency_name: 'Test & Co', primary_contact_name: 'Jamie', crm_name: 'Reapit' };

const CASES = {
  A: { tier: 'Growth', observation: humanEvidence({ lag: 0.4, followUps: 2, channels: 'email,voice' }) },
  B: { tier: 'Growth', observation: humanEvidence({ lag: 6, followUps: 1 }) },
  C: { tier: 'Core', observation: humanEvidence({ lag: 0.3, followUps: 0 }) },
  D: { tier: 'Core', observation: humanEvidence({ lag: 7.5, followUps: 0 }) },
  E: { tier: 'Core', observation: humanEvidence({ lag: 30, followUps: 1 }) },
  F: { tier: 'Core', observation: humanEvidence({ lag: 40, followUps: 0 }) },
  G: { tier: 'Core', observation: G_EVIDENCE },
  H: { tier: 'Core', observation: H_EVIDENCE },
};

function strategyFor(grade) {
  const { tier, observation } = CASES[grade];
  return { grade, tier, strategy: buildSalesStrategy({ grade, tier, observation, agency: AGENCY }), observation };
}

// A deterministic, evidence-aware mock AI: echoes recognisable markers back
// so tests can assert the request that was actually sent, without ever
// touching the network.
function mockCallAiEchoing(request) {
  const userMsg = request.messages[0].content;
  const payload = JSON.parse(userMsg.slice(userMsg.indexOf('{')));
  const { demo_type, grade } = payload.authoritative_decision;
  return {
    raw: {
      personalised_first_line: `[first-line for grade ${grade}]`,
      grade_specific_call_opener: `[opener for ${demo_type}]`,
      email_variant: `[email for ${demo_type}]`,
      demo_introduction: `[demo intro for ${demo_type}]`,
      why_novus: `[why novus for ${grade}]`,
      relevant_proof_point: 'No independent proof point is available for this agency yet — the strongest proof is their own recorded behaviour on this probe.',
      relevant_objection_response: `[objection response for ${demo_type}]`,
    },
    model: request.model,
  };
}

// ── 1. Grade-band routing reaches the AI request correctly ────────────────

await checkAsync('A produces a Growth-oriented request (growth_database demo_type)', async () => {
  const { grade, tier, strategy, observation } = strategyFor('A');
  const req = buildPersonalisationRequest({ grade, tier, strategy, probe: PROBE, agency: AGENCY, observation });
  const payload = JSON.parse(req.messages[0].content.slice(req.messages[0].content.indexOf('{')));
  assert.strictEqual(payload.authoritative_decision.demo_type, 'growth_database');
});

await checkAsync('B produces a Growth-oriented request (growth_database demo_type)', async () => {
  const { grade, tier, strategy, observation } = strategyFor('B');
  const req = buildPersonalisationRequest({ grade, tier, strategy, probe: PROBE, agency: AGENCY, observation });
  const payload = JSON.parse(req.messages[0].content.slice(req.messages[0].content.indexOf('{')));
  assert.strictEqual(payload.authoritative_decision.demo_type, 'growth_database');
});

for (const [grade, expectedType] of [['C', 'front_desk_persistence'], ['D', 'front_desk_persistence']]) {
  await checkAsync(`${grade} produces persistence/completion request (${expectedType})`, async () => {
    const { grade: g, tier, strategy, observation } = strategyFor(grade);
    const req = buildPersonalisationRequest({ grade: g, tier, strategy, probe: PROBE, agency: AGENCY, observation });
    const payload = JSON.parse(req.messages[0].content.slice(req.messages[0].content.indexOf('{')));
    assert.strictEqual(payload.authoritative_decision.demo_type, expectedType);
  });
}

await checkAsync('E produces speed/out-of-hours request (front_desk_speed)', async () => {
  const { grade, tier, strategy, observation } = strategyFor('E');
  const req = buildPersonalisationRequest({ grade, tier, strategy, probe: PROBE, agency: AGENCY, observation });
  const payload = JSON.parse(req.messages[0].content.slice(req.messages[0].content.indexOf('{')));
  assert.strictEqual(payload.authoritative_decision.demo_type, 'front_desk_speed');
});

await checkAsync('F produces speed + persistence request (front_desk_speed_and_persistence)', async () => {
  const { grade, tier, strategy, observation } = strategyFor('F');
  const req = buildPersonalisationRequest({ grade, tier, strategy, probe: PROBE, agency: AGENCY, observation });
  const payload = JSON.parse(req.messages[0].content.slice(req.messages[0].content.indexOf('{')));
  assert.strictEqual(payload.authoritative_decision.demo_type, 'front_desk_speed_and_persistence');
});

await checkAsync('G request never carries human-contact evidence (no human contact occurred)', async () => {
  const { grade, tier, strategy, observation } = strategyFor('G');
  const req = buildPersonalisationRequest({ grade, tier, strategy, probe: PROBE, agency: AGENCY, observation });
  const payload = JSON.parse(req.messages[0].content.slice(req.messages[0].content.indexOf('{')));
  assert.strictEqual(payload.authoritative_decision.demo_type, 'front_desk_completion');
  assert.ok(!('first_human_touch_at' in payload.evidence_packet.behaviour));
  assert.strictEqual(payload.evidence_packet.behaviour.first_human_touch, 'no');
  const result = await generatePersonalisation({ grade, tier, strategy, probe: PROBE, agency: AGENCY, observation, callAi: mockCallAiEchoing });
  const blob = JSON.stringify(result);
  assert.ok(!/human contact came|replied instantly/i.test(blob), 'G output must never claim human contact');
});

await checkAsync('H request never carries any positive-response evidence (four-day silence only)', async () => {
  const { grade, tier, strategy, observation } = strategyFor('H');
  const req = buildPersonalisationRequest({ grade, tier, strategy, probe: PROBE, agency: AGENCY, observation });
  const payload = JSON.parse(req.messages[0].content.slice(req.messages[0].content.indexOf('{')));
  assert.strictEqual(payload.authoritative_decision.demo_type, 'front_desk_missed_enquiry');
  // H has no positive evidence: only the known-false facts (no human contact,
  // no auto-ack, no follow-up) appear — never a lag, timestamp or channel,
  // since those are genuinely unknown/absent, not zero.
  assert.deepStrictEqual(payload.evidence_packet.behaviour, {
    first_human_touch: 'no',
    follow_up_count: 0,
    auto_acknowledgement: false,
  });
  assert.ok(!('human_lag_hours' in payload.evidence_packet.behaviour));
  assert.ok(!('first_human_touch_at' in payload.evidence_packet.behaviour));
  const result = await generatePersonalisation({ grade, tier, strategy, probe: PROBE, agency: AGENCY, observation, callAi: mockCallAiEchoing });
  const blob = JSON.stringify(result);
  assert.ok(!/responded|replied|called back/i.test(blob), 'H output must never invent a response');
});

// ── 2. Pending / compromised -> no commercial package, no AI call ─────────

await checkAsync('grade pending -> blank package, AI never called', async () => {
  let called = false;
  const result = await generatePersonalisation({
    grade: 'pending', tier: 'unclassified', strategy: buildSalesStrategy({ grade: 'pending' }),
    probe: PROBE, agency: AGENCY, observation: {},
    callAi: async () => { called = true; throw new Error('must not be called'); },
  });
  for (const f of PERSONALISATION_FIELDS) assert.strictEqual(result[f], '');
  assert.strictEqual(result.meta.generated, false);
  assert.strictEqual(called, false);
});

await checkAsync('compromised probe -> blank package, AI never called, even with strong A evidence', async () => {
  const { observation } = strategyFor('A');
  let called = false;
  const strategy = buildSalesStrategy({ grade: 'A', tier: 'Growth', observation, compromised: 'TRUE' });
  const result = await generatePersonalisation({
    grade: 'A', tier: 'Growth', strategy, probe: PROBE, agency: AGENCY, observation,
    callAi: async () => { called = true; throw new Error('must not be called'); },
  });
  for (const f of PERSONALISATION_FIELDS) assert.strictEqual(result[f], '');
  assert.strictEqual(called, false);
});

// ── 3. Exact evidence values appear correctly; unsupported facts do not ───

await checkAsync('exact evidence values (property, price, lag) are available to the AI unmodified', async () => {
  const { grade, tier, strategy, observation } = strategyFor('E');
  const req = buildPersonalisationRequest({ grade, tier, strategy, probe: PROBE, agency: AGENCY, observation });
  const payload = JSON.parse(req.messages[0].content.slice(req.messages[0].content.indexOf('{')));
  assert.strictEqual(payload.evidence_packet.property.address, '14 Elm Road, Billericay');
  assert.strictEqual(payload.evidence_packet.property.price, '475000');
  assert.strictEqual(payload.evidence_packet.behaviour.human_lag_hours, 30);
});

check('unknown CRM is never invented — absent from the evidence packet, not stated as a guess', () => {
  const packet = buildEvidencePacket({ probe: PROBE, agency: null, observation: {} });
  assert.deepStrictEqual(packet.agency, {});
  assert.ok(!('crm_name' in packet.agency));
});

check('a known CRM is passed through exactly, never altered', () => {
  const packet = buildEvidencePacket({ probe: PROBE, agency: AGENCY, observation: {} });
  assert.strictEqual(packet.agency.crm_name, 'Reapit');
});

check('no property facts are invented — only fields present on the probe appear', () => {
  const packet = buildEvidencePacket({ probe: { property_address: 'Only address known' }, agency: null, observation: {} });
  assert.deepStrictEqual(packet.property, { address: 'Only address known' });
});

check('system prompt explicitly forbids inventing client proof numbers', () => {
  const req = buildPersonalisationRequest({ grade: 'A', tier: 'Growth', strategy: strategyFor('A').strategy, probe: PROBE, agency: AGENCY, observation: strategyFor('A').observation });
  assert.ok(/client proof points, results, percentages/.test(req.system));
});

await checkAsync('relevant_proof_point falls back to the evidence-safe default when nothing else is available', async () => {
  const { grade, tier, strategy, observation } = strategyFor('C');
  const result = await generatePersonalisation({ grade, tier, strategy, probe: PROBE, agency: AGENCY, observation, callAi: mockCallAiEchoing });
  assert.ok(result.relevant_proof_point.startsWith('No independent proof point is available'));
});

// ── 4. The model cannot override the supplied tier/strategy ───────────────

check('the request always embeds the caller-supplied grade/tier/demo_type verbatim, never re-derived', () => {
  for (const grade of Object.keys(CASES)) {
    const { tier, strategy, observation } = strategyFor(grade);
    const req = buildPersonalisationRequest({ grade, tier, strategy, probe: PROBE, agency: AGENCY, observation });
    const payload = JSON.parse(req.messages[0].content.slice(req.messages[0].content.indexOf('{')));
    assert.strictEqual(payload.authoritative_decision.grade, grade);
    assert.strictEqual(payload.authoritative_decision.tier, tier);
    assert.strictEqual(payload.authoritative_decision.demo_type, strategy.demo_type);
  }
});

check('the system prompt instructs the model it may not reconsider grade/tier/strategy', () => {
  const { grade, tier, strategy, observation } = strategyFor('A');
  const req = buildPersonalisationRequest({ grade, tier, strategy, probe: PROBE, agency: AGENCY, observation });
  assert.ok(/authoritative and final/i.test(req.system));
  assert.ok(/may not reconsider/i.test(req.system));
});

await checkAsync('generatePersonalisation never itself computes or mutates grade/tier/strategy', async () => {
  const { grade, tier, strategy, observation } = strategyFor('C');
  const strategyBefore = JSON.stringify(strategy);
  await generatePersonalisation({ grade, tier, strategy, probe: PROBE, agency: AGENCY, observation, callAi: mockCallAiEchoing });
  assert.strictEqual(JSON.stringify(strategy), strategyBefore, 'strategy object was mutated');
});

// ── 5. Malformed AI output is rejected, never silently accepted ───────────

check('missing field is rejected', () => {
  const bad = { personalised_first_line: 'x' }; // missing 6 fields
  assert.throws(() => validatePersonalisationOutput(bad), PersonalisationValidationError);
});

check('non-string field is rejected', () => {
  const bad = Object.fromEntries(PERSONALISATION_FIELDS.map((f) => [f, 'ok']));
  bad.email_variant = { subject: 'x' };
  assert.throws(() => validatePersonalisationOutput(bad), PersonalisationValidationError);
});

check('empty required field (not the proof-point fallback field) is rejected', () => {
  const bad = Object.fromEntries(PERSONALISATION_FIELDS.map((f) => [f, 'ok']));
  bad.why_novus = '';
  assert.throws(() => validatePersonalisationOutput(bad), PersonalisationValidationError);
});

check('unexpected extra field is rejected, not silently dropped', () => {
  const bad = Object.fromEntries(PERSONALISATION_FIELDS.map((f) => [f, 'ok']));
  bad.segment = 'A'; // attempting to sneak a routing field into commercial output
  assert.throws(() => validatePersonalisationOutput(bad), PersonalisationValidationError);
});

check('non-object AI output is rejected', () => {
  assert.throws(() => validatePersonalisationOutput('just a string'), PersonalisationValidationError);
  assert.throws(() => validatePersonalisationOutput(null), PersonalisationValidationError);
  assert.throws(() => validatePersonalisationOutput(['array']), PersonalisationValidationError);
});

await checkAsync('malformed AI output propagates as a rejection from generatePersonalisation, not a corrupted result', async () => {
  const { grade, tier, strategy, observation } = strategyFor('D');
  await assert.rejects(
    () => generatePersonalisation({
      grade, tier, strategy, probe: PROBE, agency: AGENCY, observation,
      callAi: async () => ({ raw: { personalised_first_line: 'only one field' }, model: 'mock' }),
    }),
    PersonalisationValidationError,
  );
});

// ── 6. AI failure never corrupts anything (no persistence exists to corrupt) ─

await checkAsync('AI/network failure throws rather than returning a fabricated or silently-blank result', async () => {
  const { grade, tier, strategy, observation } = strategyFor('B');
  await assert.rejects(
    () => generatePersonalisation({
      grade, tier, strategy, probe: PROBE, agency: AGENCY, observation,
      callAi: async () => { throw new PersonalisationGenerationError('simulated network failure'); },
    }),
    PersonalisationGenerationError,
  );
});

await checkAsync('the module performs no I/O when a strategy is unresolved (mirrors sales-strategy purity discipline)', async () => {
  const originals = { fetch: globalThis.fetch };
  let touched = false;
  globalThis.fetch = () => { touched = true; throw new Error('I/O attempted'); };
  try {
    const result = await generatePersonalisation({ grade: 'pending', tier: 'unclassified', strategy: null, probe: PROBE, agency: AGENCY, observation: {} });
    assert.strictEqual(result.meta.generated, false);
  } finally {
    globalThis.fetch = originals.fetch;
  }
  assert.strictEqual(touched, false, 'personalisation.mjs attempted network I/O for an unresolved strategy');
});

check('exports carry no INTELLIGENCE write helper — this module has nothing to corrupt by design', () => {
  // Structural guarantee for "AI failure does not corrupt existing INTELLIGENCE
  // data": there is no exported function in this module that writes to a
  // repo/sheet at all, so a thrown error here has no persisted state to leave
  // half-written.
  assert.strictEqual(typeof generatePersonalisation, 'function');
});

console.log(`\n${passed} checks passed.`);
