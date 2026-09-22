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
