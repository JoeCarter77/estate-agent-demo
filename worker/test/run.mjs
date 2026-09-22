// worker/test/run.mjs — the operator's scenario suite.
//
// NOTHING HERE TOUCHES LIVE RIGHTMOVE. Every rightmove.co.uk request is routed
// to the mock server in test/mock, and the NOVUS half of the mock is an
// isolated in-memory backend serving the REAL novus/probe.html. A test that
// says "enquiry sent" means the mock form's submit handler ran.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildHarness } from './harness.mjs';
import { standardWorld, APPROVED_IDENTITY } from './mock/fixtures.mjs';
import { classifyPropertyType, chooseListing } from '../src/suitability.mjs';
import { recoveryPlan, OperatorState } from '../src/state.mjs';
import { classifySubmissionPage } from '../src/rightmove.mjs';

const results = [];
let only = process.argv[2] || '';

async function test(name, fn) {
  if (only && !name.includes(only)) return;
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ok   ${name} (${Date.now() - started}ms)`);
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, error });
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

// ── unit: suitability ──────────────────────────────────────────────────────

console.log('\nsuitability');

await test('suitable residential sales listing', async () => {
  assert.equal(classifyPropertyType('House').verdict, 'suitable');
  assert.equal(classifyPropertyType('Flat').verdict, 'suitable');
  assert.equal(classifyPropertyType('Semi-Detached').verdict, 'suitable');
  assert.equal(classifyPropertyType('Apartment').category, 'residential_sale');
});

await test('land-only and commercial listings are rejected', async () => {
  assert.equal(classifyPropertyType('Land').verdict, 'unsuitable');
  assert.equal(classifyPropertyType('Land').category, 'land');
  assert.equal(classifyPropertyType('Commercial Property').category, 'commercial');
  assert.equal(classifyPropertyType('Garage').verdict, 'unsuitable');
});

await test('unknown property types are uncertain, never assumed suitable', async () => {
  assert.equal(classifyPropertyType('Wharf Pod').verdict, 'uncertain');
  assert.equal(classifyPropertyType('').verdict, 'uncertain');
});

await test('plain residential is preferred over retirement or auction stock', async () => {
  const picked = chooseListing([
    { propertyType: 'Flat', text: 'Retirement living, over 60s only' },
    { propertyType: 'House', text: 'Three bedroom family home' },
  ]);
  assert.equal(picked.chosen.propertyType, 'House');
});

// ── unit: recovery ─────────────────────────────────────────────────────────

console.log('\nrecovery decisions');

const tx = (patch) => ({
  agency_id: 'ag-1', stage: 'idle', marked_sent: false, probe_id: '',
  submission: { state: 'none', attempts: 0 }, ...patch,
});

await test('worker interruption before submission restarts the agency', async () => {
  const plan = recoveryPlan(tx({ stage: 'form_verified', submission: { state: 'none' } }));
  assert.equal(plan.action, 'restart_agency');
});

await test('worker interruption DURING submission never resubmits', async () => {
  const plan = recoveryPlan(tx({ stage: 'submitting', submission: { state: 'in_flight' } }));
  assert.equal(plan.action, 'human');
  assert.equal(plan.reason, 'uncertain_submission');
});

await test('release after a worker restart cannot clear an uncertain Send', async () => {
  const h = await buildHarness(standardWorld());
  try {
    h.state.beginAgency({ agency_id: 'ag-alpha-1', agency_name: 'Alpha Residential' });
    h.state.markSubmitInFlight();
    h.state.requireHuman('uncertain_submission', 'outcome unknown');
    const released = h.orchestrator.release({ outcome: 'resume' });
    assert.equal(released.ok, false);
    assert.equal(h.state.data.current.submission.attempts, 1);
    assert.equal(h.state.data.run.mode, 'needs_human');
  } finally { await h.close(); }
});

await test('worker interruption after submission resumes at Create probe', async () => {
  const plan = recoveryPlan(tx({ stage: 'submitted', submission: { state: 'sent' } }));
  assert.equal(plan.action, 'resume_create_probe');
});

await test('worker interruption after Create probe resumes at Mark as sent', async () => {
  const plan = recoveryPlan(tx({ stage: 'probe_created', submission: { state: 'sent' }, probe_id: 'prb_1' }));
  assert.equal(plan.action, 'resume_mark_sent');
});

await test('worker interruption after Mark as sent just closes the cycle', async () => {
  const plan = recoveryPlan(tx({ stage: 'marked_sent', submission: { state: 'sent' }, probe_id: 'prb_1', marked_sent: true }));
  assert.equal(plan.action, 'close_cycle');
});

await test('an unreadable state file is never silently discarded', async () => {
  const file = `${process.env.TMPDIR || '/tmp'}/novus-operator-corrupt-${Date.now()}.json`;
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => new OperatorState(file), /unreadable/);
  fs.unlinkSync(file);
});

// ── integration ────────────────────────────────────────────────────────────

console.log('\nend-to-end (mocked Rightmove, isolated NOVUS)');

await test('successful submission creates one probe and marks it sent', async () => {
  const h = await buildHarness(standardWorld());
  try {
    await h.run({ batchSize: 1 });
    assert.equal(h.state.data.counters.completed, 1, 'one completed cycle');
    assert.equal(h.world.probes.length, 1, 'exactly one PROBES row');
    const probe = h.world.probes[0];
    assert.equal(probe.agency_id, 'ag-alpha-1');
    assert.equal(probe.probe_status, 'observing');
    assert.ok(probe.probe_timestamp && probe.observation_deadline, 'observation window started');
    // The URL came from the property page, not the branch page.
    assert.match(probe.property_url, /\/properties\/900002$/);
    assert.ok(!/estate-agents/.test(probe.property_url), 'never the branch URL');
    // AGENCIES.probe_sent was stamped by the existing endpoint.
    assert.equal(h.world.agencies.find((a) => a.agency_id === 'ag-alpha-1').probe_sent, 'YES');
    // Land was offered first and was not chosen.
    assert.equal(h.state.data.history[0].outcome, 'completed');
  } finally { await h.close(); }
});

await test('the approved identity and seller signal reach the form untouched', async () => {
  const h = await buildHarness(standardWorld());
  try {
    await h.run({ batchSize: 1 });
    // Asserted on what the mock form actually received, not on operator logs.
    const enquiry = h.world.log.find((entry) => entry.op === 'enquiry-submitted');
    assert.ok(enquiry, 'the enquiry form was submitted');
    assert.equal(enquiry.email, APPROVED_IDENTITY.email);
    assert.equal(enquiry.firstName, APPROVED_IDENTITY.firstName);
    assert.equal(enquiry.lastName, APPROVED_IDENTITY.lastName);
    assert.equal(enquiry.phone, APPROVED_IDENTITY.phone);
    assert.equal(enquiry.sellingSituation, 'pr_not_on_mrk', 'the approved seller signal, unchanged');
    assert.equal(enquiry.valuationRequested, false, 'no extra valuation request was selected');
    assert.equal(enquiry.propertyId, '900002', 'the enquiry is for the property that was chosen');
  } finally { await h.close(); }
});

await test('exactly one enquiry is submitted per completed probe', async () => {
  const h = await buildHarness(standardWorld());
  try {
    await h.run({ batchSize: 1 });
    const submissions = h.world.log.filter((entry) => entry.op === 'enquiry-submitted');
    assert.equal(submissions.length, 1);
  } finally { await h.close(); }
});

await test('lettings-only agency is skipped through the existing Skip workflow', async () => {
  const world = standardWorld();
  world.agencies = world.agencies.filter((a) => a.agency_id !== 'ag-alpha-1');
  const h = await buildHarness(world);
  try {
    await h.run({ batchSize: 1 });
    assert.ok(h.state.data.counters.skipped >= 1, 'at least one skip');
    const skip = h.world.log.find((entry) => entry.op === 'skip');
    assert.ok(skip, 'the existing skip-agency endpoint was called');
    assert.equal(skip.agency_id, 'ag-lettings-2');
    assert.equal(skip.reason, 'Lettings only');
    assert.equal(h.world.probes.filter((p) => p.agency_id === 'ag-lettings-2').length, 0,
      'no probe was created for the skipped agency');
  } finally { await h.close(); }
});

await test('land-only agency is skipped, not probed', async () => {
  const world = standardWorld();
  world.agencies = world.agencies.filter((a) => !['ag-alpha-1', 'ag-lettings-2'].includes(a.agency_id));
  const h = await buildHarness(world);
  try {
    await h.run({ batchSize: 1 });
    const skip = h.world.log.find((entry) => entry.op === 'skip' && entry.agency_id === 'ag-land-3');
    assert.ok(skip, 'the land-only agency was skipped');
    assert.equal(h.world.probes.filter((p) => p.agency_id === 'ag-land-3').length, 0);
  } finally { await h.close(); }
});

await test('an agency with no properties at all is skipped', async () => {
  const world = standardWorld();
  world.agencies = world.agencies.filter((a) => a.agency_id === 'ag-empty-4');
  const h = await buildHarness(world);
  try {
    await h.run({ batchSize: 1 });
    const skip = h.world.log.find((entry) => entry.op === 'skip' && entry.agency_id === 'ag-empty-4');
    assert.ok(skip, 'the empty agency was skipped');
  } finally { await h.close(); }
});

await test('a blocked popup is recovered, not treated as a dead agency', async () => {
  const world = standardWorld();
  world.blockPopups = true;
  const h = await buildHarness(world);
  try {
    await h.run({ batchSize: 1 });
    assert.equal(h.world.probes.length, 1, 'the probe still completed');
    assert.equal(h.world.probes[0].probe_status, 'observing');
  } finally { await h.close(); }
});

await test('a stray tab racing the property tab does not hijack the property URL', async () => {
  // The ag-bedfords-873 failure: a listing opened fine, but a tab that opened
  // first was read instead, so the operator reported "no property id" against
  // the agency's branch URL.
  const world = standardWorld();
  world.strayTabOnPropertyOpen = true;
  const h = await buildHarness(world);
  try {
    // Fail fast rather than hang: before the fix this escalated and blocked
    // waiting for a human, so a regression must surface as a failure.
    const run = h.run({ batchSize: 1 });
    const escalated = waitFor(() => h.state.data.current.needs_human, 30000).then((needs) => {
      throw new Error(`escalated instead of using the property tab: ${needs.reason} — ${needs.detail}`);
    }, () => null);
    await Promise.race([run, escalated]);
    assert.equal(h.world.probes.length, 1, 'the probe completed despite the racing tab');
    const probe = h.world.probes[0];
    assert.match(probe.property_url, /\/properties\/900002$/, 'the chosen property URL, captured from its own page');
    assert.ok(!/estate-agents/.test(probe.property_url), 'never the agency branch URL');
    assert.equal(h.state.data.counters.interventions, 0, 'no bogus uncertain-suitability escalation');
  } finally { await h.close(); }
});

await test('leftover Rightmove tabs are closed before returning to NOVUS', async () => {
  // One eligible agency only, so the run ends rather than immediately opening
  // the next agency's branch page (which would be a tab by design).
  const world = standardWorld();
  world.agencies = [world.agencies[0]];
  const h = await buildHarness(world);
  try {
    await h.run({ batchSize: 1 });
    assert.equal(h.browser.rightmoveTabs().length, 0, 'no Rightmove tab survives the cycle');
    assert.ok(h.browser.novusPage && !h.browser.novusPage.isClosed(), 'the NOVUS tab was never closed');
  } finally { await h.close(); }
});

await test('a form carrying somebody else\'s contact details stops for a human', async () => {
  const world = standardWorld();
  world.prefillEnquiry = { firstName: 'Someone', lastName: 'Else', email: 'someone.else@example.com', phone: '07000000000' };
  const h = await buildHarness(world);
  try {
    const run = h.run({ batchSize: 1 });
    await waitFor(() => h.state.data.current.needs_human, 25000);
    assert.equal(h.state.data.current.needs_human.reason, 'unexpected_form');
    assert.equal(h.state.data.current.submission.state, 'none', 'nothing was submitted');
    assert.equal(h.world.probes.length, 0);
    h.orchestrator.release({ outcome: 'abandon' });
    await h.orchestrator.emergencyStop();
    await run.catch(() => {});
  } finally { await h.close(); }
});

await test('a rejected submission creates no probe and escalates once', async () => {
  const world = standardWorld();
  world.submitBehaviour = 'failure';
  const h = await buildHarness(world);
  try {
    const run = h.run({ batchSize: 1 });
    await waitFor(() => h.state.data.current.needs_human, 25000);
    assert.equal(h.state.data.current.needs_human.reason, 'unexpected_form');
    assert.equal(h.state.data.current.submission.state, 'failed');
    assert.equal(h.state.data.current.submission.attempts, 1, 'the rejected enquiry was not sent again');
    assert.equal(h.world.probes.length, 0, 'no probe for a rejected enquiry');
    assert.equal(h.world.agencies.find((a) => a.agency_id === 'ag-alpha-1').probe_sent, '', 'probe_sent untouched');
    h.orchestrator.release({ outcome: 'abandon' });
    await h.orchestrator.emergencyStop();
    await run.catch(() => {});
  } finally { await h.close(); }
});

await test('an uncertain submission escalates and is never retried', async () => {
  const world = standardWorld();
  world.submitBehaviour = 'uncertain';
  const h = await buildHarness(world);
  try {
    const run = h.run({ batchSize: 1 });
    await waitFor(() => h.state.data.current.needs_human, 25000);
    assert.equal(h.state.data.current.needs_human.reason, 'uncertain_submission');
    assert.equal(h.state.data.current.submission.state, 'in_flight');
    assert.equal(h.state.data.current.submission.attempts, 1, 'submitted exactly once');
    assert.equal(h.world.probes.length, 0, 'no probe claims an unconfirmed enquiry');
    h.orchestrator.release({ outcome: 'abandon' });
    await h.orchestrator.emergencyStop();
    await run.catch(() => {});
  } finally { await h.close(); }
});

await test('a CAPTCHA pauses the worker and preserves the agency and tabs', async () => {
  const world = standardWorld();
  world.submitBehaviour = 'captcha';
  const h = await buildHarness(world);
  try {
    const run = h.run({ batchSize: 1 });
    await waitFor(() => h.state.data.current.needs_human, 25000);
    const current = h.state.data.current;
    assert.equal(current.needs_human.reason, 'captcha');
    assert.equal(current.agency_id, 'ag-alpha-1', 'the agency is preserved');
    assert.match(current.property_url, /\/properties\/900002$/, 'the property is preserved');
    assert.ok(h.browser.rightmoveTabs().length > 0, 'the Rightmove tab is still open for the human');
    assert.equal(h.state.data.run.mode, 'needs_human');
    assert.equal(h.world.probes.length, 0, 'nothing claims the probe was sent');
    h.orchestrator.release({ outcome: 'abandon' });
    await h.orchestrator.emergencyStop();
    await run.catch(() => {});
  } finally { await h.close(); }
});

await test('an unexpected browser error pauses with the agency and Chrome intact', async () => {
  const h = await buildHarness(standardWorld());
  const original = h.browser.openBackgroundTab.bind(h.browser);
  let once = true;
  h.browser.openBackgroundTab = async (url) => {
    if (once) { once = false; throw new Error('mock browser fault'); }
    return original(url);
  };
  try {
    const run = h.run({ batchSize: 1 });
    await waitFor(() => h.state.data.current.needs_human?.reason === 'repeated_failure', 10000);
    assert.equal(h.state.data.current.agency_id, 'ag-alpha-1');
    assert.equal(h.state.data.run.mode, 'needs_human');
    assert.ok(h.browser.context, 'Chrome remains open');
    h.orchestrator.release({ outcome: 'abandon' });
    await run;
  } finally { await h.close(); }
});

await test('recording failure after Send resumes without a second enquiry', async () => {
  const h = await buildHarness(standardWorld());
  const original = h.orchestrator.createProbeAndMarkSent.bind(h.orchestrator);
  let once = true;
  h.orchestrator.createProbeAndMarkSent = async (url) => {
    if (once) { once = false; throw new Error('mock NOVUS recording fault'); }
    return original(url);
  };
  try {
    const run = h.run({ batchSize: 1 });
    await waitFor(() => h.state.data.current.needs_human?.reason === 'repeated_failure', 15000);
    assert.equal(h.state.data.current.submission.state, 'sent');
    h.orchestrator.release({ outcome: 'resume' });
    await run;
    assert.equal(h.world.log.filter((entry) => entry.op === 'enquiry-submitted').length, 1);
    assert.equal(h.world.probes.length, 1);
  } finally { await h.close(); }
});

await test('recovery after a crash following submission creates the probe without resubmitting', async () => {
  const world = standardWorld();
  const h = await buildHarness(world);
  try {
    // Simulate the crashed process: the enquiry went out, nothing else did.
    h.state.beginAgency({ agency_id: 'ag-alpha-1', agency_name: 'Alpha Residential', branch_url: world.agencies[0].rightmove_sales_branch_url });
    h.state.stage('url_captured', { property_url: 'https://www.rightmove.co.uk/properties/900002' });
    h.state.markSubmitInFlight();
    h.state.settleSubmission('sent', { detail: 'confirmed before the crash' });

    await h.run({ batchSize: 1 });
    const forAlpha = h.world.probes.filter((p) => p.agency_id === 'ag-alpha-1');
    assert.equal(forAlpha.length, 1, 'exactly one probe for the recovered agency');
    assert.equal(forAlpha[0].probe_status, 'observing');
    assert.match(forAlpha[0].property_url, /900002$/, 'the preserved property URL was used');
  } finally { await h.close(); }
});

await test('a worker started on an in-flight submission refuses to run', async () => {
  const h = await buildHarness(standardWorld());
  try {
    h.state.beginAgency({ agency_id: 'ag-alpha-1', agency_name: 'Alpha Residential', branch_url: 'x' });
    h.state.markSubmitInFlight();
    const started = await h.orchestrator.start({ batchSize: 1, dailyLimit: 5, liveSubmit: true });
    assert.equal(started.ok, false);
    assert.match(started.error, /uncertain_submission/);
    assert.equal(h.world.probes.length, 0);
  } finally { await h.close(); }
});

await test('an already-probed agency is never served again', async () => {
  const world = standardWorld();
  const h = await buildHarness(world);
  try {
    await h.run({ batchSize: 2 });
    const probed = h.world.probes.map((p) => p.agency_id);
    assert.equal(new Set(probed).size, probed.length, 'no agency probed twice');
    assert.ok(!probed.includes('ag-done-5'), 'the agency with probe_sent set was skipped by the queue');
    assert.ok(!probed.includes('ag-unverified-6'), 'the unverified-email agency was never served');
  } finally { await h.close(); }
});

await test('queue exhaustion stops the run cleanly', async () => {
  const world = standardWorld();
  world.agencies = [world.agencies[0]];
  const h = await buildHarness(world);
  try {
    await h.run({ batchSize: 5 });
    assert.equal(h.state.data.run.mode, 'stopped');
    assert.match(h.state.data.run.stop_reason, /exhausted|batch complete/);
    assert.equal(h.world.probes.length, 1);
  } finally { await h.close(); }
});

await test('the daily probe limit stops the run', async () => {
  const h = await buildHarness(standardWorld());
  try {
    await h.run({ batchSize: 5, dailyLimit: 1 });
    assert.equal(h.world.probes.length, 1);
    assert.match(h.state.data.run.stop_reason, /daily probe limit/);
  } finally { await h.close(); }
});

await test('a dry run verifies the form but never clicks Send', async () => {
  const h = await buildHarness(standardWorld(), { liveSubmit: false });
  try {
    await h.run({ batchSize: 1 });
    assert.equal(h.world.probes.length, 0, 'a dry run creates no probe');
    assert.equal(h.state.data.history[0].submission, 'none', 'Send was never clicked');
    assert.ok(h.logs.some((line) => /DRY RUN/.test(line)));
  } finally { await h.close(); }
});

await test('batch of two works two different agencies in order', async () => {
  const world = standardWorld();
  world.agencies = world.agencies.filter((a) => ['ag-alpha-1', 'ag-second-7'].includes(a.agency_id));
  const h = await buildHarness(world);
  try {
    await h.run({ batchSize: 2 });
    assert.equal(h.world.probes.length, 2);
    assert.deepEqual(h.world.probes.map((p) => p.agency_id), ['ag-alpha-1', 'ag-second-7']);
  } finally { await h.close(); }
});

// ── signed-in enquiry layout ───────────────────────────────────────────────

console.log('\nsigned-in enquiry layout');

const signedInWorld = (patch = {}) => Object.assign(standardWorld(), {
  enquiryLayout: 'signed_in',
  signedInIdentity: { ...APPROVED_IDENTITY },
}, patch);

await test('the signed-in layout is recognised and probed to completion', async () => {
  const h = await buildHarness(signedInWorld());
  try {
    await h.run({ batchSize: 1 });
    assert.equal(h.world.probes.length, 1, 'the signed-in form produced a probe');
    assert.equal(h.world.probes[0].probe_status, 'observing');
    const enquiry = h.world.log.find((entry) => entry.op === 'enquiry-submitted');
    assert.ok(enquiry, 'the enquiry was submitted');
    assert.equal(enquiry.layout, 'signed_in');
    assert.ok(h.logs.some((line) => /signed-in summary/.test(line)), 'the layout was reported in the log');
  } finally { await h.close(); }
});

await test('Edit is never clicked when the signed-in details already match', async () => {
  const h = await buildHarness(signedInWorld());
  try {
    await h.run({ batchSize: 1 });
    assert.equal(h.world.log.filter((entry) => entry.op === 'enquiry-edit-clicked').length, 0,
      'the operator left the matching details alone');
    assert.equal(h.world.probes.length, 1);
  } finally { await h.close(); }
});

await test('a signed-in account that is not the probe identity stops for a human', async () => {
  const h = await buildHarness(signedInWorld({
    signedInIdentity: { firstName: 'Someone', lastName: 'Else', email: 'someone.else@example.com', phone: '07000000000' },
  }));
  try {
    const run = h.run({ batchSize: 1 });
    await waitFor(() => h.state.data.current.needs_human, 25000);
    const detail = h.state.data.current.needs_human.detail;
    assert.equal(h.state.data.current.needs_human.reason, 'unexpected_form');
    assert.match(detail, /signed_in/, 'the escalation names the layout it saw');
    assert.match(detail, /someone\.else@example\.com/, 'it names the account actually on screen');
    assert.equal(h.state.data.current.submission.state, 'none', 'nothing was submitted');
    assert.equal(h.world.log.filter((e) => e.op === 'enquiry-edit-clicked').length, 0, 'Edit was not clicked to paper over it');
    assert.equal(h.world.probes.length, 0);
    h.orchestrator.release({ outcome: 'abandon' });
    await h.orchestrator.emergencyStop();
    await run.catch(() => {});
  } finally { await h.close(); }
});

await test('a signed-in enquiry with no seller declaration is refused', async () => {
  const h = await buildHarness(signedInWorld({ signedInDeclaration: 'none' }));
  try {
    const run = h.run({ batchSize: 1 });
    await waitFor(() => h.state.data.current.needs_human, 25000);
    assert.equal(h.state.data.current.needs_human.reason, 'unexpected_form');
    assert.match(h.state.data.current.needs_human.detail, /not yet on the market/i);
    assert.equal(h.world.probes.length, 0, 'an enquiry without the declaration is not the approved probe');
    h.orchestrator.release({ outcome: 'abandon' });
    await h.orchestrator.emergencyStop();
    await run.catch(() => {});
  } finally { await h.close(); }
});

await test('a signed-in layout that still asks the seller question has it set', async () => {
  const h = await buildHarness(signedInWorld({ signedInDeclaration: 'select' }));
  try {
    await h.run({ batchSize: 1 });
    const enquiry = h.world.log.find((entry) => entry.op === 'enquiry-submitted');
    assert.equal(enquiry.sellingSituation, 'pr_not_on_mrk');
    assert.equal(h.world.probes.length, 1);
  } finally { await h.close(); }
});

await test('CAPTCHA handling still works on the signed-in layout', async () => {
  const h = await buildHarness(signedInWorld({ submitBehaviour: 'captcha' }));
  try {
    const run = h.run({ batchSize: 1 });
    await waitFor(() => h.state.data.current.needs_human, 25000);
    assert.equal(h.state.data.current.needs_human.reason, 'captcha');
    assert.equal(h.state.data.current.agency_id, 'ag-alpha-1');
    assert.ok(h.browser.rightmoveTabs().length > 0, 'the tab is preserved for the human');
    assert.equal(h.world.probes.length, 0);
    h.orchestrator.release({ outcome: 'abandon' });
    await h.orchestrator.emergencyStop();
    await run.catch(() => {});
  } finally { await h.close(); }
});

await test('an uncertain signed-in submission is still never retried', async () => {
  const h = await buildHarness(signedInWorld({ submitBehaviour: 'uncertain' }));
  try {
    const run = h.run({ batchSize: 1 });
    await waitFor(() => h.state.data.current.needs_human, 25000);
    assert.equal(h.state.data.current.needs_human.reason, 'uncertain_submission');
    assert.equal(h.state.data.current.submission.attempts, 1);
    assert.equal(h.world.log.filter((e) => e.op === 'enquiry-submitted').length, 1, 'submitted exactly once');
    assert.equal(h.world.probes.length, 0);
    h.orchestrator.release({ outcome: 'abandon' });
    await h.orchestrator.emergencyStop();
    await run.catch(() => {});
  } finally { await h.close(); }
});

await test('a dry run on the signed-in layout still never clicks Send', async () => {
  const h = await buildHarness(signedInWorld(), { liveSubmit: false });
  try {
    await h.run({ batchSize: 1 });
    assert.equal(h.world.log.filter((e) => e.op === 'enquiry-submitted').length, 0, 'Send was never clicked');
    assert.equal(h.world.probes.length, 0, 'a dry run creates no probe');
    assert.ok(h.logs.some((line) => /DRY RUN/.test(line)));
  } finally { await h.close(); }
});

// ── pacing ─────────────────────────────────────────────────────────────────

console.log('\npacing');

await test('major-action pacing is configurable and interruptible', async () => {
  const { loadConfig } = await import('../src/config.mjs');
  const { Orchestrator } = await import('../src/orchestrator.mjs');
  assert.equal(loadConfig({}).actionDelayMs, 750);
  assert.equal(loadConfig({ NOVUS_OPERATOR_ACTION_DELAY_MS: '1200' }).actionDelayMs, 1200);
  assert.equal(loadConfig({ NOVUS_OPERATOR_ACTION_DELAY_MS: '0' }).actionDelayMs, 0);
  const state = { data: { run: { mode: 'running' } } };
  const operator = new Orchestrator({ config: { actionDelayMs: 80 }, state, browser: {}, novus: {} });
  const started = Date.now();
  await operator.pace();
  assert.ok(Date.now() - started >= 70, 'a major-action gap actually waits');
  state.data.run.mode = 'paused';
  const waiting = operator.pace();
  setTimeout(() => { state.data.run.mode = 'running'; }, 100);
  await waiting;
});

await test('the cooldown defaults to the 30-60 second range and is randomised', async () => {
  const { loadConfig, cooldownMs } = await import('../src/config.mjs');
  const config = loadConfig({});
  assert.equal(config.cooldown.minSeconds, 30);
  assert.equal(config.cooldown.maxSeconds, 60);
  assert.equal(cooldownMs(config, () => 0), 30000);
  assert.equal(cooldownMs(config, () => 1), 60000);
  assert.equal(cooldownMs(config, () => 0.5), 45000);
});

await test('the cooldown range is configurable and can be switched off', async () => {
  const { loadConfig, cooldownMs } = await import('../src/config.mjs');
  const tuned = loadConfig({ NOVUS_OPERATOR_COOLDOWN_MIN_SECONDS: '45', NOVUS_OPERATOR_COOLDOWN_MAX_SECONDS: '90' });
  assert.equal(cooldownMs(tuned, () => 0), 45000);
  assert.equal(cooldownMs(tuned, () => 1), 90000);
  const off = loadConfig({ NOVUS_OPERATOR_COOLDOWN_MIN_SECONDS: '0', NOVUS_OPERATOR_COOLDOWN_MAX_SECONDS: '0' });
  assert.equal(cooldownMs(off), 0, 'zero means no wait, for tests and for a deliberate override');
});

await test('the operator waits between consecutive enquiries and reports it', async () => {
  const world = standardWorld();
  world.agencies = world.agencies.filter((a) => ['ag-alpha-1', 'ag-second-7'].includes(a.agency_id));
  const h = await buildHarness(world, { cooldownSeconds: 2 });
  try {
    const started = Date.now();
    const run = h.run({ batchSize: 2 });
    await waitFor(() => h.state.data.run.cooldown_until, 30000);
    // The countdown is visible to the panel while it is happening.
    const remaining = Date.parse(h.state.data.run.cooldown_until) - Date.now();
    assert.ok(remaining > 0 && remaining <= 2500, `cooldown_until is a live countdown (${remaining}ms)`);
    await run;
    assert.equal(h.world.probes.length, 2);
    assert.ok(Date.now() - started >= 2000, 'the second enquiry waited for the cooldown');
    assert.equal(h.state.data.run.cooldown_until, '', 'the countdown is cleared once it has elapsed');
  } finally { await h.close(); }
});

await test('the cooldown does not run after the final enquiry of a batch', async () => {
  const world = standardWorld();
  world.agencies = [world.agencies[0]];
  const h = await buildHarness(world, { cooldownSeconds: 10 });
  try {
    const started = Date.now();
    await h.run({ batchSize: 1 });
    assert.equal(h.world.probes.length, 1);
    assert.ok(Date.now() - started < 9000, 'no pointless wait after the last probe');
  } finally { await h.close(); }
});

await test('an emergency stop interrupts a cooldown instead of waiting it out', async () => {
  const world = standardWorld();
  world.agencies = world.agencies.filter((a) => ['ag-alpha-1', 'ag-second-7'].includes(a.agency_id));
  const h = await buildHarness(world, { cooldownSeconds: 30 });
  try {
    const run = h.run({ batchSize: 2 });
    await waitFor(() => h.state.data.run.cooldown_until, 30000);
    const stoppedAt = Date.now();
    await h.orchestrator.emergencyStop();
    await run.catch(() => {});
    assert.ok(Date.now() - stoppedAt < 5000, 'the stop was honoured during the wait');
    assert.equal(h.world.probes.length, 1, 'the second enquiry never went out');
  } finally { await h.close(); }
});

// ── confirmation after a human CAPTCHA ─────────────────────────────────────

console.log('\nconfirmation after a CAPTCHA');

await test("Rightmove's confirmation wordings are recognised", async () => {
  const sent = (page) => assert.equal(classifySubmissionPage(page).kind, 'sent', JSON.stringify(page));
  sent({ url: 'https://www.rightmove.co.uk/property-for-sale/contactBranchConfirmation.html?propertyId=1', text: '', formStillThere: false });
  sent({ url: 'x', text: 'Your enquiry has been sent to Signature Estates', formStillThere: false });
  sent({ url: 'x', text: 'Thanks for your enquiry', formStillThere: false });
  sent({ url: 'x', text: 'Your enquiry is on its way', formStillThere: false });
  sent({ url: 'x', text: "We've sent your details to the agent", formStillThere: false });
  sent({ url: 'x', text: 'What happens next The agent will be in touch shortly', formStillThere: false });
  // And what must NOT read as a confirmation.
  assert.equal(classifySubmissionPage({ url: 'x', text: 'Contact the agent', formStillThere: true, errors: [] }).kind, 'pending');
  assert.equal(classifySubmissionPage({ url: 'x', text: 'form', formStillThere: true, errors: ['Enter a valid number'] }).kind, 'failed');
  assert.equal(classifySubmissionPage({ url: 'x', text: 'Loading…', formStillThere: false }).kind, 'gone');
});

await test("the live banner \"Thanks, we've got your enquiry.\" is a confirmation", async () => {
  // Verbatim from a real Rightmove submission, plus the renderings that are
  // the same sentence: curly apostrophe, collapsed whitespace, no full stop.
  for (const text of [
    "Thanks, we've got your enquiry.",
    'Thanks, we\u2019ve got your enquiry.',
    'Thanks,   we\u2019ve  got your enquiry',
    "THANKS, WE'VE GOT YOUR ENQUIRY.",
  ]) {
    assert.equal(classifySubmissionPage({ url: 'x', text, formStillThere: false }).kind, 'sent', text);
  }
});

await test('the banner rendering after the form is removed is still a confirmation', async () => {
  const world = standardWorld();
  // The real sequence: the form goes first, the banner appears a beat later.
  world.submitBehaviour = 'delayed_banner';
  const h = await buildHarness(world);
  try {
    await h.run({ batchSize: 1 });
    assert.equal(h.world.probes.length, 1, 'the late banner was recognised, not called uncertain');
    assert.equal(h.world.probes[0].probe_status, 'observing');
    assert.equal(h.world.log.filter((e) => e.op === 'enquiry-submitted').length, 1, 'submitted exactly once');
  } finally { await h.close(); }
});

await test('a confirmation reached after the human clears the CAPTCHA is recognised', async () => {
  const world = standardWorld();
  world.submitBehaviour = 'captcha';
  const h = await buildHarness(world);
  try {
    const run = h.run({ batchSize: 1 });
    await waitFor(() => h.state.data.current.needs_human?.reason === 'captcha', 25000);
    // The human completes the challenge; Rightmove lands on its confirmation.
    const page = h.browser.rightmoveTabs().find((candidate) => /contactBranch/.test(candidate.url()));
    await page.evaluate(() => window.__completeChallenge('<h1>Your enquiry has been sent to Alpha Residential</h1>'));
    h.orchestrator.release({ outcome: 'resume' });
    await run;

    assert.equal(h.world.probes.length, 1, 'the probe was created from the recognised confirmation');
    assert.equal(h.world.probes[0].probe_status, 'observing');
    assert.equal(h.state.data.counters.completed, 1);
    // The decisive assertion: Send was pressed exactly once, in total.
    assert.equal(h.world.log.filter((e) => e.op === 'enquiry-submitted').length, 1,
      'Send was never pressed a second time');
  } finally { await h.close(); }
});

await test('rechecking after release never presses Send again', async () => {
  const world = standardWorld();
  world.submitBehaviour = 'captcha';
  const h = await buildHarness(world);
  try {
    const run = h.run({ batchSize: 1 });
    await waitFor(() => h.state.data.current.needs_human?.reason === 'captcha', 25000);
    const page = h.browser.rightmoveTabs().find((candidate) => /contactBranch/.test(candidate.url()));
    // Released with the challenge still unsolved and no confirmation: the
    // operator must look again, not send again.
    h.orchestrator.release({ outcome: 'resume' });
    await waitFor(() => h.state.data.current.needs_human?.reason === 'uncertain_submission', 25000);
    assert.equal(h.state.data.current.submission.attempts, 1, 'still exactly one attempt');
    assert.equal(h.world.log.filter((e) => e.op === 'enquiry-submitted').length, 1);
    // Now the human clears it and says they saw the confirmation.
    await page.evaluate(() => window.__completeChallenge('<h1>Your enquiry has been sent</h1>'));
    h.orchestrator.release({ outcome: 'confirmed_sent' });
    await run;
    assert.equal(h.world.probes.length, 1);
    assert.equal(h.world.log.filter((e) => e.op === 'enquiry-submitted').length, 1, 'still one enquiry');
  } finally { await h.close(); }
});

await test('"I saw the confirmation" records the probe without sending anything', async () => {
  const world = standardWorld();
  world.submitBehaviour = 'uncertain';
  const h = await buildHarness(world);
  try {
    const run = h.run({ batchSize: 1 });
    await waitFor(() => h.state.data.current.needs_human?.reason === 'uncertain_submission', 25000);
    h.orchestrator.release({ outcome: 'confirmed_sent' });
    await run;
    assert.equal(h.world.probes.length, 1, 'the probe was recorded');
    assert.equal(h.world.probes[0].probe_status, 'observing');
    assert.equal(h.state.data.current.submission.state, 'none', 'the cycle closed cleanly');
    assert.equal(h.world.log.filter((e) => e.op === 'enquiry-submitted').length, 1, 'no second enquiry');
    assert.equal(h.state.data.history[0].outcome, 'completed');
  } finally { await h.close(); }
});

await test('Send can never be pressed twice for one agency', async () => {
  const h = await buildHarness(standardWorld());
  try {
    h.state.beginAgency({ agency_id: 'ag-alpha-1', agency_name: 'Alpha Residential' });
    h.state.markSubmitInFlight();
    assert.throws(() => h.state.markSubmitInFlight(), /will not submit a second enquiry/);
    h.state.settleSubmission('sent', { detail: 'x' });
    assert.throws(() => h.state.markSubmitInFlight(), /will not submit a second enquiry/);
  } finally { await h.close(); }
});

await test('an agency whose Send was pressed is never restarted from step 1', async () => {
  const world = standardWorld();
  world.submitBehaviour = 'uncertain';
  const h = await buildHarness(world);
  try {
    const run = h.run({ batchSize: 1 });
    await waitFor(() => h.state.data.current.needs_human?.reason === 'uncertain_submission', 25000);
    h.orchestrator.release({ outcome: 'abandon' });
    await h.orchestrator.emergencyStop();
    await run.catch(() => {});
    assert.equal(h.world.log.filter((e) => e.op === 'enquiry-submitted').length, 1,
      'the abandoned agency was not worked again');
    assert.equal(h.world.probes.length, 0);
  } finally { await h.close(); }
});

// ── recovering Signature Estates: submitted, never recorded ────────────────

console.log('\nrecovering an enquiry that was sent but never recorded');

await test('a restarted worker recovers a human-confirmed enquiry at Create probe', async () => {
  const world = standardWorld();
  const h = await buildHarness(world);
  try {
    // Exactly the Signature Estates situation: the enquiry went out, the
    // CAPTCHA was cleared by hand, the operator could not confirm it, and the
    // worker was restarted before anything reached NOVUS.
    h.state.beginAgency({
      agency_id: 'ag-alpha-1', agency_name: 'Alpha Residential',
      branch_url: world.agencies[0].rightmove_sales_branch_url,
    });
    h.state.stage('url_captured', { property_url: 'https://www.rightmove.co.uk/properties/900002' });
    h.state.markSubmitInFlight();
    h.state.requireHuman('uncertain_submission', 'confirmation not recognised after the CAPTCHA');

    // The worker refuses to run while that is outstanding.
    const refused = await h.orchestrator.start({ batchSize: 1, dailyLimit: 5, liveSubmit: true });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /uncertain_submission/);

    // "I saw Rightmove's confirmation."
    const released = h.orchestrator.release({ outcome: 'confirmed_sent' });
    assert.equal(released.ok, true);
    assert.equal(h.state.data.current.submission.state, 'sent');
    assert.equal(h.state.data.current.submission.confirmed_by, 'human');
    assert.match(h.state.data.run.stop_reason, /press Start/);

    // Start now resumes at Create probe.
    await h.run({ batchSize: 1 });
    const probes = h.world.probes.filter((p) => p.agency_id === 'ag-alpha-1');
    assert.equal(probes.length, 1, 'exactly one probe for the recovered agency');
    assert.equal(probes[0].probe_status, 'observing');
    assert.match(probes[0].property_url, /900002$/, 'the property URL captured before the CAPTCHA');
    assert.equal(h.world.agencies.find((a) => a.agency_id === 'ag-alpha-1').probe_sent, 'YES');
    assert.equal(h.world.log.filter((e) => e.op === 'enquiry-submitted').length, 0,
      'recovery sends no enquiry at all');
  } finally { await h.close(); }
});

await test('confirmed_sent is refused when no enquiry was ever submitted', async () => {
  const h = await buildHarness(standardWorld());
  try {
    h.state.beginAgency({ agency_id: 'ag-alpha-1', agency_name: 'Alpha Residential' });
    h.state.requireHuman('unexpected_form', 'the form did not match');
    const result = h.orchestrator.release({ outcome: 'confirmed_sent' });
    assert.equal(result.ok, false);
    assert.match(result.error, /no enquiry awaiting confirmation/);
  } finally { await h.close(); }
});

// ── control API (what the Prober panel talks to) ───────────────────────────

console.log('\ncontrol API');

await test('the control API refuses commands without the token and allows status', async () => {
  const { createControlServer } = await import('../src/control-server.mjs');
  const h = await buildHarness(standardWorld());
  try {
    const { server } = createControlServer({ config: h.config, state: h.state, orchestrator: h.orchestrator, browser: h.browser });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    const status = await fetch(`${base}/status`).then((r) => r.json());
    assert.equal(status.worker.status, 'stopped');
    assert.equal(status.current.submission, 'none');

    const unauthorised = await fetch(`${base}/start`, { method: 'POST', body: '{}' });
    assert.equal(unauthorised.status, 401);

    const wrongOrigin = await fetch(`${base}/status`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(wrongOrigin.status, 403, 'a foreign origin is refused outright');

    const paused = await fetch(`${base}/pause`, {
      method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, body: '{}',
    }).then((r) => r.json());
    assert.equal(paused.ok, true);

    await new Promise((resolve) => server.close(resolve));
  } finally { await h.close(); }
});

await test('the control API answers the private-network preflight for the NOVUS origin', async () => {
  const { createControlServer } = await import('../src/control-server.mjs');
  const h = await buildHarness(standardWorld());
  try {
    const { server } = createControlServer({ config: h.config, state: h.state, orchestrator: h.orchestrator, browser: h.browser });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const preflight = await fetch(`${base}/start`, {
      method: 'OPTIONS',
      headers: { Origin: h.config.novusBaseUrl, 'Access-Control-Request-Private-Network': 'true' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');
    assert.equal(preflight.headers.get('access-control-allow-origin'), h.config.novusBaseUrl);
    await new Promise((resolve) => server.close(resolve));
  } finally { await h.close(); }
});

await test('the panel never reads "sent" for an unconfirmed enquiry', async () => {
  const { createControlServer } = await import('../src/control-server.mjs');
  const h = await buildHarness(standardWorld());
  try {
    h.state.beginAgency({ agency_id: 'ag-alpha-1', agency_name: 'Alpha Residential', branch_url: 'x' });
    h.state.markSubmitInFlight();
    const { snapshot } = createControlServer({ config: h.config, state: h.state, orchestrator: h.orchestrator, browser: h.browser });
    const view = snapshot();
    assert.equal(view.current.submission, 'in_flight');
    assert.equal(view.current.marked_sent, false);
    assert.equal(view.current.probe_id, '');
  } finally { await h.close(); }
});

function waitFor(predicate, timeout) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value;
      try { value = predicate(); } catch { value = null; }
      if (value) return resolve(value);
      if (Date.now() > deadline) return reject(new Error('timed out waiting for condition'));
      setTimeout(tick, 200);
    };
    tick();
  });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  for (const failure of failed) console.log(`\n${failure.name}\n${failure.error.stack}`);
  process.exit(1);
}
