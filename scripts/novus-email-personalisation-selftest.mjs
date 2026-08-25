import assert from 'node:assert';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';
import {
  formatPropertyReference, introducesUnselectedFinding, personaliseProbe, _internal,
} from '../lib/probe-personalisation.mjs';
import { buildDemoRow } from '../lib/demos.mjs';

let passed = 0;
const ok = (message) => { passed += 1; console.log(`  ✓ ${message}`); };

const PROBE = {
  probe_id: 'prb_email_001', agency_id: 'agc_email_001', probe_reference: 'NOV-EMAIL-001',
  property_address: 'Grey Lady Place (2 bed terrace, £425,000)', property_price: '£425,000',
  property_url: '', portal: 'Rightmove', probe_timestamp: '2026-08-21T20:14:00Z',
  observation_deadline: '2026-08-25T20:14:00Z',
  enquiry_text: 'I would like to view and I also have a property to sell that is not yet on the market.',
};

const F = {
  positive: { finding_index: 4, finding_type: 'positive', finding: 'The team replied quickly and progressed the viewing.', evidence: 'A human reply arrived in 8 minutes and offered a viewing slot.', significance_note: 'Fast buyer-side handling.' },
  noFollowUp: { finding_index: 1, finding_type: 'problem', finding: 'No follow-up was sent after the first reply.', evidence: 'Contact attempts: 1; follow-ups: 0.', significance_note: 'The enquiry had no second attempt.' },
  sellerMissed: { finding_index: 2, finding_type: 'opportunity', finding: 'The declared seller opportunity was missed completely.', evidence: 'The enquiry declared a property to sell; nobody mentioned it.', significance_note: 'A potential valuation was invisible.' },
  sellerUnprogressed: { finding_index: 5, finding_type: 'opportunity', finding: 'The declared seller opportunity was recognised but not progressed.', evidence: 'The team asked whether the property was on the market but offered no valuation or next step.', significance_note: 'Recognition did not become progression.' },
  qualification: { finding_index: 3, finding_type: 'problem', finding: 'Buyer qualification was weak and incomplete.', evidence: 'No budget, funding or timescale questions were asked.', significance_note: 'Buyer readiness remained unknown.' },
  noResponse: { finding_index: 6, finding_type: 'problem', finding: 'No meaningful human response was received during the four-day observation period.', evidence: 'Human contact: none over four days.', significance_note: 'No conversation was created.' },
};

const ordered = (...items) => items.sort((a, b) => a.finding_index - b.finding_index);

function answer({ positive = 4, main = 1, second = 2, observation, hook, overrides = {} } = {}) {
  return {
    story_reasoning: `1. ${positive ?? 'none'}. 2. ${main ?? 'none'}. 3. ${second ?? 'none'}. Same selected story.`,
    positive_finding_index: positive,
    main_finding_index: main,
    wider_finding_index: second,
    primary_narrative: 'A concise internal summary of the selected story.',
    supporting_findings: '',
    fair_observation: positive == null ? '' : 'you replied quickly and progressed the viewing.',
    main_finding: main == null ? '' : 'the enquiry did not receive the next step it needed.',
    commercial_consequence: main == null ? '' : 'one part of the commercial opportunity remained unprogressed.',
    email_observation: observation || 'You replied quickly and progressed the viewing, but no follow-up was sent and nobody picked up that I also had a property to sell.',
    email_commercial_hook: hook || 'That is 2 commercial opportunities from 1 enquiry, with the seller side and the follow-up both left unprogressed.',
    novus_counterfactual: 'NOVUS would have progressed both sides in the same conversation.',
    ...overrides,
  };
}

async function runPersonalisation({ findings, result, intelligence = {} }) {
  let calls = 0;
  __setAiCallerForTests(async () => {
    calls += 1;
    return typeof result === 'function' ? result(calls) : result;
  });
  const row = await personaliseProbe(
    PROBE,
    { human_contact: 'yes', response_hours: 0.13, contact_attempts: 1, follow_ups: 0, viewing_progression: 'invited', seller_recognition: 'none', grade: 'D', ...intelligence },
    { diagnosis_summary: 'final', novus_opportunity: 'Core (front desk)' },
    findings,
    { agency_name: 'Example Estates' },
  );
  return { row, calls };
}

async function main() {
  console.log('Findings-grounded Instantly variables — hermetic selftest\n');

  let aiCalls = 0;
  __setAiCallerForTests(async () => { aiCalls += 1; throw new Error('AI must not run'); });
  assert.strictEqual(formatPropertyReference(PROBE), 'Grey Lady Place on 21 August at 21:14');
  assert.strictEqual(aiCalls, 0);
  assert.strictEqual(formatPropertyReference({ ...PROBE, probe_timestamp: '2026-12-21T21:14:00Z' }), 'Grey Lady Place on 21 December at 21:14');
  ok('property_reference is deterministic, strips analyst notes and formats both BST and GMT in Europe/London with zero AI');

  {
    const { row, calls } = await runPersonalisation({
      findings: ordered(F.noFollowUp, F.positive),
      result: answer({ second: null, observation: 'You replied quickly, but no follow-up was sent after that first response.', hook: 'So 1 live enquiry received a fast first reply but no second attempt.' }),
    });
    assert.strictEqual(calls, 1);
    assert.strictEqual(row.narrative_finding_indexes, '1,4');
    assert.ok(row.email_observation.includes('replied quickly'));
    assert.ok(row.email_observation.includes('no follow-up'));
    ok('positive + one problem uses one traceable selection');
  }

  let coherentRow;
  {
    const { row } = await runPersonalisation({
      findings: ordered(F.noFollowUp, F.sellerMissed, F.positive),
      result: answer(),
    });
    coherentRow = row;
    assert.strictEqual(row.narrative_finding_indexes, '1,2,4');
    assert.match(row.email_observation, /no follow-up/i);
    assert.match(row.email_observation, /property to sell/i);
    assert.match(row.email_commercial_hook, /2 commercial opportunities/i);
    assert.doesNotMatch(row.evidence, /qualification/i);
    ok('positive + two connected problems, including no follow-up + seller missed, share the same selected findings');
  }

  {
    const noResponseAnswer = answer({
      positive: null, main: 6, second: 2,
      observation: 'We did not receive a response at all during the four-day observation period, and the property I had said I needed to sell was never picked up.',
      hook: 'That is 2 live opportunities from 1 enquiry, with 0 conversations created.',
      overrides: { fair_observation: '', main_finding: '', commercial_consequence: 'no buyer or seller conversation was created.' },
    });
    const { row } = await runPersonalisation({
      findings: ordered(F.sellerMissed, F.noResponse), result: noResponseAnswer,
      intelligence: { human_contact: 'none', response_hours: '', viewing_progression: 'none' },
    });
    assert.strictEqual(row.positive_finding_index, '');
    assert.strictEqual(row.fair_observation, '');
    assert.doesNotMatch(row.email_observation, /quick|prompt|well handled/i);
    assert.strictEqual(row.narrative_finding_indexes, '2,6');
    ok('no-response case omits a fake positive while retaining the supported seller opportunity');
  }

  {
    const { row } = await runPersonalisation({
      findings: ordered(F.sellerUnprogressed, F.positive),
      result: answer({ main: 5, second: null, observation: 'You replied quickly and recognised that I had a property to sell, but no valuation or seller next step followed.', hook: 'So the seller opportunity was visible, but 0 seller actions were created from it.' }),
      intelligence: { seller_recognition: 'weak', viewing_progression: 'invited' },
    });
    assert.strictEqual(row.main_finding_index, 5);
    assert.match(row.email_observation, /recognised/i);
    assert.match(row.email_commercial_hook, /visible/i);
    ok('seller opportunity recognised but not progressed is distinct from a fully missed seller opportunity');
  }

  {
    const { row } = await runPersonalisation({
      findings: ordered(F.sellerMissed, F.positive),
      result: answer({ main: 2, second: null, observation: 'You handled the viewing side quickly, but nobody picked up that I had also said I had a property to sell.', hook: 'So 1 of the 2 commercial opportunities in that enquiry was invisible to the process.' }),
      intelligence: { viewing_progression: 'booked' },
    });
    assert.match(row.email_observation, /viewing side/i);
    assert.match(row.email_commercial_hook, /1 of the 2/i);
    ok('buyer progressed + seller missed stays one coherent commercial story');
  }

  {
    const rows = ordered(F.noFollowUp, F.sellerMissed, F.qualification, F.positive);
    const leaked = answer({ hook: 'The seller side was missed, and buyer qualification was weak and incomplete.' });
    const corrected = answer();
    const { row, calls } = await runPersonalisation({ findings: rows, result: (call) => call === 1 ? leaked : corrected });
    assert.strictEqual(calls, 2);
    assert.doesNotMatch(row.email_commercial_hook, /qualification/i);
    assert.strictEqual(row.narrative_finding_indexes, '1,2,4');
    assert.strictEqual(introducesUnselectedFinding(leaked.email_commercial_hook, [F.noFollowUp, F.sellerMissed, F.positive], rows), true);
    ok('the hook cannot introduce an unselected diagnosis finding and the bounded correction preserves the shared selection');
  }

  for (const deleted of ['email_variant', 'wider_observation', 'wider_consequence', 'additional_findings_hook', 'email_body', 'enquiry_date', 'property_address']) {
    assert.ok(!(deleted in coherentRow), `${deleted} must not be generated`);
  }
  assert.deepStrictEqual(
    ['property_reference', 'email_observation', 'email_commercial_hook'].filter((field) => field in coherentRow),
    ['property_reference', 'email_observation', 'email_commercial_hook'],
  );
  assert.strictEqual(_internal.MAX_PERSONALISATION_ATTEMPTS, 2);
  assert.ok(!('CONSEQUENCE_TOOL' in _internal));
  assert.ok(!('wider_observation' in _internal.TOOL.input_schema.properties));
  assert.ok(!('email_body' in _internal.TOOL.input_schema.properties));
  ok('deleted fields and the old full-email/consequence-only retry contract are gone');

  const compiled = buildDemoRow({
    probe: PROBE,
    agency: { agency_name: 'Example Estates' },
    intelligence: { human_contact: 'yes', response_hours: 0.13, contact_attempts: 1, follow_ups: 0, viewing_progression: 'invited', seller_recognition: 'none', grade: 'D' },
    findings: ordered(F.noFollowUp, F.sellerMissed, F.positive),
    personalisation: { personalisation_id: 'psn_email_001', ...coherentRow },
    communications: [], now: '2026-08-25T12:00:00.000Z',
  });
  assert.ok(compiled.row.hero_journey);
  assert.ok(compiled.row.main_finding);
  assert.ok(compiled.row.commercial_consequence);
  ok('the current demo still compiles from the retained PERSONALISATION fields');

  console.log(`\n${passed} checks passed.`);
}

main().catch((error) => { console.error(error); process.exit(1); });
